import type { NormalizedOffer } from '../types';
import { generateShortLink } from '../shopee/queries';
import { loadConfig } from '../config';
import { log } from '../logger';

/**
 * Resolve o link de afiliado da oferta.
 * - offerLink do feed JÁ é um link de afiliado monetizável (conta do dono).
 * - generateShortLink adiciona subIds (rastreio por canal/campanha).
 * Estratégia: tentar generateShortLink (com subIds) a partir da URL de origem;
 * se falhar, cair no offerLink já pronto. Só retorna null se não houver NENHUM
 * caminho monetizável (aí o process manda para revisão — nunca posta sem comissão).
 */
export async function makeAffiliateLink(
  offer: NormalizedOffer,
  extraSubIds: string[] = [],
): Promise<string | null> {
  const cfg = loadConfig();
  const subIds = [cfg.SUBID_CAMPAIGN, ...extraSubIds].filter(Boolean).slice(0, 5);
  const origin = offer.sourceUrl;

  if (origin) {
    try {
      const short = await generateShortLink(origin, subIds);
      if (short) return short;
    } catch (err) {
      log.warn('generateShortLink falhou; usando offerLink', {
        productId: offer.productId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Fallback: link de afiliado já pronto do feed.
  return offer.offerLink ?? null;
}
