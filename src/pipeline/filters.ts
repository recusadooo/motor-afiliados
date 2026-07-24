import type { NormalizedOffer, RejectResult } from '../types';
import { blockedKeywords, type Config } from '../config';
import { normalizeText } from '../util';

/**
 * Filtro de rejeição por regra de negócio (roda ANTES da IA).
 * Categorias/palavras proibidas: apostas, adulto, remédio, cripto, armas, etc.
 * A lista é editável via BLOCKED_KEYWORDS no .env (ver PERGUNTAS.md).
 */
export function rejectByKeyword(offer: NormalizedOffer, cfg: Config): RejectResult {
  const haystack = normalizeText(`${offer.title} ${offer.category ?? ''}`);
  for (const word of blockedKeywords(cfg)) {
    const w = normalizeText(word);
    if (!w) continue;
    // limite de palavra para evitar falso-positivo em substring
    const re = new RegExp(`(^|\\s)${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
    if (re.test(haystack)) {
      return { rejected: true, reason: `palavra bloqueada: "${word}"` };
    }
  }
  return { rejected: false };
}

/** Sanidade básica de preço. */
export function rejectByPriceSanity(offer: NormalizedOffer): RejectResult {
  if (offer.price != null && offer.price <= 0) {
    return { rejected: true, reason: 'preço <= 0' };
  }
  return { rejected: false };
}
