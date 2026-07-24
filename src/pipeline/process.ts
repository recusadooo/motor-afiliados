import { randomUUID } from 'node:crypto';
import type { NormalizedOffer } from '../types';
import { loadConfig } from '../config';
import { log } from '../logger';
import { query, queryOne } from '../db';
import { dedupKey } from './normalize';
import { claimFresh } from './dedup';
import { recordPrice, getPriceStats } from './priceHistory';
import { assessDiscount } from './fakeDiscount';
import { rejectByKeyword, rejectByPriceSanity } from './filters';
import { makeAffiliateLink } from './affiliate';
import { generateCopy } from './copy';

export type ProcessOutcome =
  | { status: 'created'; offerId: string; isPriority: boolean }
  | { status: 'rejected'; reason: string }
  | { status: 'duplicate' }
  | { status: 'no_link'; reason: string };

/**
 * Processa UMA oferta normalizada: histórico de preço -> filtros -> desconto real
 * -> link de afiliado -> copy IA -> grava em `offers`.
 * Idempotente por dedup_key (nunca cria a mesma oferta 2x).
 */
export async function processOffer(
  offer: NormalizedOffer,
  rawCaptureId: string | null,
): Promise<ProcessOutcome> {
  const cfg = loadConfig();
  const correlationId = randomUUID();
  const dkey = dedupKey(offer);
  const l = log.child({ correlationId, productId: offer.productId });

  // Camada 1 de dedup (rápida). A durável é a UNIQUE(dedup_key) no INSERT.
  const fresh = await claimFresh(dkey);
  if (!fresh) {
    const exists = await queryOne(`SELECT id FROM offers WHERE dedup_key = $1`, [dkey]);
    if (exists) return { status: 'duplicate' };
  }

  // Histórico de preço (alimenta a detecção de desconto real/falso).
  await recordPrice(offer.productId, offer.shopId, offer.price);
  const stats = await getPriceStats(offer.productId, offer.shopId);
  const disc = assessDiscount(offer, stats, cfg.FAKE_DISCOUNT_MAX_PCT);

  // Filtros (curto-circuito no 1º fail).
  const checks = [rejectByPriceSanity(offer), rejectByKeyword(offer, cfg)];
  const failed = checks.find((c) => c.rejected);
  const reason = failed?.reason ?? (disc.fake ? disc.fakeReason : undefined);
  if (failed || disc.fake) {
    await insertOffer(offer, {
      rawCaptureId,
      dkey,
      affiliateUrl: null,
      copy: null,
      placeholders: null,
      aiFallback: false,
      isPriority: false,
      status: 'rejected',
      rejectReason: reason ?? 'rejeitada',
      disc,
    });
    l.info('oferta rejeitada', { reason });
    return { status: 'rejected', reason: reason ?? 'rejeitada' };
  }

  // Link de afiliado — se não houver caminho monetizável, NÃO posta.
  const affiliateUrl = await makeAffiliateLink(offer, [offer.productId]);
  if (!affiliateUrl) {
    l.warn('sem link de afiliado — enviado para revisão');
    return { status: 'no_link', reason: 'sem link de afiliado' };
  }

  // Copy IA (com fallback).
  const { copy, placeholders } = await generateCopy(offer, disc);

  const isPriority =
    disc.confident &&
    ((disc.realDiscountPct ?? 0) >= cfg.PRIORITY_MIN_DISCOUNT_PCT ||
      (disc.realSavings ?? 0) >= cfg.PRIORITY_MIN_SAVINGS_BRL);

  const status = cfg.AUTO_APPROVE ? 'approved' : 'pending';
  const offerId = await insertOffer(offer, {
    rawCaptureId,
    dkey,
    affiliateUrl,
    copy: `${copy.headline}\n\n${copy.body}`,
    placeholders,
    aiFallback: copy.fallback,
    isPriority,
    status,
    rejectReason: null,
    disc,
  });

  if (!offerId) return { status: 'duplicate' };
  l.info('oferta criada', { offerId, isPriority, status, aiFallback: copy.fallback });
  return { status: 'created', offerId, isPriority };
}

interface InsertParams {
  rawCaptureId: string | null;
  dkey: string;
  affiliateUrl: string | null;
  copy: string | null;
  placeholders: Record<string, string> | null;
  aiFallback: boolean;
  isPriority: boolean;
  status: string;
  rejectReason: string | null;
  disc: { reference: number | null; realSavings: number | null; realDiscountPct: number | null };
}

async function insertOffer(offer: NormalizedOffer, p: InsertParams): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO offers
       (raw_capture_id, platform, product_id, shop_id, title, price, original_price,
        discount_pct, savings_brl, commission_rate, category, affiliate_url, image_url,
        rewritten_copy, copy_placeholders, ai_fallback, is_priority, priority, dedup_key,
        status, reject_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING id`,
    [
      p.rawCaptureId,
      offer.platform,
      offer.productId,
      offer.shopId,
      offer.title,
      offer.price,
      p.disc.reference,
      p.disc.realDiscountPct,
      p.disc.realSavings,
      offer.commissionRate,
      offer.category,
      p.affiliateUrl,
      offer.imageUrl,
      p.copy,
      p.placeholders ? JSON.stringify(p.placeholders) : null,
      p.aiFallback,
      p.isPriority,
      p.isPriority ? 200 : 100,
      p.dkey,
      p.status,
      p.rejectReason,
    ],
  );
  return row?.id ?? null;
}
