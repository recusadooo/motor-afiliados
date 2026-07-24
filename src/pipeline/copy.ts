import type { NormalizedOffer, GeneratedCopy } from '../types';
import type { DiscountAssessment } from './fakeDiscount';
import { chatJson, moderate, AiUnavailableError } from '../ai/openai';
import { log } from '../logger';

/**
 * Copywriter. Arquitetura anti-desconto-alucinado:
 * a IA NUNCA escreve números — ela usa placeholders {{preco}}, {{desconto}},
 * {{economia}}. O app substitui pelos valores REAIS (determinísticos). Um
 * validador rejeita qualquer número monetário/percentual literal fora de
 * placeholder. Sempre sai com disclosure #publicidade.
 */

export function formatBRL(n: number | null): string {
  if (n == null) return '';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const COPY_SCHEMA = {
  type: 'object',
  properties: {
    titulo: { type: 'string' },
    corpo: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
  },
  required: ['titulo', 'corpo', 'hashtags'],
  additionalProperties: false,
};

interface RawCopy {
  titulo: string;
  corpo: string;
  hashtags: string[];
}

/** Detecta número monetário/percentual literal (proibido fora de placeholder). */
export function hasLiteralNumbers(text: string): boolean {
  const withoutPlaceholders = text.replace(/\{\{[^}]+\}\}/g, '');
  return /r\$\s?\d/i.test(withoutPlaceholders) || /\d+\s?%/.test(withoutPlaceholders) || /\d+[.,]\d{2}\b/.test(withoutPlaceholders);
}

export interface CopyResult {
  copy: GeneratedCopy;
  placeholders: Record<string, string>;
}

function buildPlaceholders(offer: NormalizedOffer, disc: DiscountAssessment): Record<string, string> {
  const ph: Record<string, string> = { titulo: offer.title, preco: formatBRL(offer.price) };
  if (disc.confident && disc.realDiscountPct != null && disc.realDiscountPct >= 1) {
    ph.desconto = `${Math.round(disc.realDiscountPct)}%`;
  }
  if (disc.confident && disc.realSavings != null && disc.realSavings > 0) {
    ph.economia = formatBRL(disc.realSavings);
  }
  return ph;
}

function substitute(text: string, ph: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => ph[key] ?? '').replace(/\s{2,}/g, ' ').trim();
}

function fallbackCopy(offer: NormalizedOffer, ph: Record<string, string>): CopyResult {
  const parts = [`🔥 ${offer.title}`, `Por apenas ${ph.preco}`];
  const body = parts.filter(Boolean).join('\n');
  return {
    copy: {
      headline: `🔥 Achado`,
      body: `${body}\n\n#publicidade`,
      hashtags: ['#oferta', '#publicidade'],
      fallback: true,
    },
    placeholders: ph,
  };
}

export async function generateCopy(
  offer: NormalizedOffer,
  disc: DiscountAssessment,
): Promise<CopyResult> {
  const ph = buildPlaceholders(offer, disc);

  const system =
    'Você é um copywriter de ofertas em português do Brasil para um grupo de WhatsApp. ' +
    'Escreva copy curta, empolgante e com emojis. REGRA ABSOLUTA: nunca escreva números, ' +
    'preços ou percentuais — use SOMENTE os placeholders {{preco}}, {{desconto}}, {{economia}}, {{titulo}}. ' +
    'Se um placeholder não fizer sentido, apenas não o use. Sempre soe honesto (sem prometer o que não sabe).';
  const user =
    `Produto: ${offer.title}\n` +
    `Placeholders disponíveis: ${Object.keys(ph).map((k) => `{{${k}}}`).join(', ')}\n` +
    'Gere: titulo (chamada curta), corpo (2-4 linhas com emojis) e hashtags (3-5). ' +
    'Não inclua o link (o app adiciona). Não escreva números literais.';

  try {
    const raw = await chatJson<RawCopy>('offer_copy', COPY_SCHEMA, system, user);
    const rawText = `${raw.titulo}\n${raw.corpo}\n${raw.hashtags.join(' ')}`;
    if (hasLiteralNumbers(rawText)) {
      log.warn('copy IA continha número literal — usando fallback', { productId: offer.productId });
      return fallbackCopy(offer, ph);
    }

    const headline = substitute(raw.titulo, ph);
    let body = substitute(raw.corpo, ph);
    const hashtags = raw.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`));
    if (!hashtags.some((h) => /publicidade/i.test(h))) hashtags.push('#publicidade');

    body = `${body}\n\n${hashtags.join(' ')}`;

    // Moderação da copy final (best-effort).
    const mod = await moderate(`${headline}\n${body}`);
    if (mod?.flagged) {
      log.warn('copy reprovada na moderação — fallback', { productId: offer.productId });
      return fallbackCopy(offer, ph);
    }

    return { copy: { headline, body, hashtags, fallback: false }, placeholders: ph };
  } catch (err) {
    if (err instanceof AiUnavailableError) {
      log.info('IA indisponível — usando copy fallback', { productId: offer.productId });
    } else {
      log.warn('geração de copy falhou — fallback', {
        productId: offer.productId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    return fallbackCopy(offer, ph);
  }
}
