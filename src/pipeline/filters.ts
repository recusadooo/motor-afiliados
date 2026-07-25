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

/** Piso de preço (opcional; 0 desliga). */
export function rejectByPriceFloor(offer: NormalizedOffer, minPrice: number): RejectResult {
  if (minPrice > 0 && offer.price != null && offer.price < minPrice) {
    return { rejected: true, reason: `preço abaixo do piso (< R$${minPrice})` };
  }
  return { rejected: false };
}

/**
 * Ganho mínimo por venda (preço x comissão). Filtro principal de qualidade:
 * corta bugiganga de centavos sem excluir oferta barata legítima (condimento,
 * café), que o piso de PREÇO derrubaria junto.
 */
export function rejectByCommissionValue(offer: NormalizedOffer, minBrl: number): RejectResult {
  if (minBrl <= 0) return { rejected: false };
  if (offer.price == null || offer.commissionRate == null) return { rejected: false };
  const ganho = offer.price * offer.commissionRate;
  if (ganho < minBrl) {
    return {
      rejected: true,
      reason: `ganho por venda baixo (R$${ganho.toFixed(2)} < R$${minBrl.toFixed(2)})`,
    };
  }
  return { rejected: false };
}

// Conectivos que não valem como sinal de relevância.
const STOPWORDS = new Set(['de', 'da', 'do', 'com', 'sem', 'para', 'em', 'e', 'a', 'o']);

/** Tokens significativos da palavra-chave buscada. */
export function keywordTokens(keyword: string): string[] {
  return normalizeText(keyword)
    .split(' ')
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Relevância: o título tem que conter TODOS os tokens significativos da keyword.
 * Motivo (visto ao vivo no dry-run): a busca da Shopee por "notebook" devolve
 * papel/caderno e por "monitor" devolve monitor de pressão arterial. Sem esse
 * corte, o grupo recebe produto fora do nicho.
 * Substring de propósito: "fone" casa com "fones", "cafe" com "cafeteira".
 */
export function matchesKeyword(title: string, keyword: string): boolean {
  const tokens = keywordTokens(keyword);
  if (tokens.length === 0) return true;
  const hay = normalizeText(title);
  return tokens.every((t) => hay.includes(t));
}

export function rejectByRelevance(offer: NormalizedOffer, keyword: string): RejectResult {
  if (!matchesKeyword(offer.title, keyword)) {
    return { rejected: true, reason: `fora do nicho: título não casa com "${keyword}"` };
  }
  return { rejected: false };
}

/**
 * Prova social: produto com pouca venda ou nota baixa é aposta, não oferta.
 * Só corta quando a Shopee INFORMA o dado (null = sem informação = não pune).
 */
export function rejectBySocialProof(
  offer: NormalizedOffer,
  minSales: number,
  minRating: number,
): RejectResult {
  if (minSales > 0 && offer.sales != null && offer.sales < minSales) {
    return { rejected: true, reason: `poucas vendas (${offer.sales} < ${minSales})` };
  }
  if (minRating > 0 && offer.ratingStar != null && offer.ratingStar > 0 && offer.ratingStar < minRating) {
    return { rejected: true, reason: `nota baixa (${offer.ratingStar} < ${minRating})` };
  }
  return { rejected: false };
}

/**
 * Assinatura de quase-duplicata: 4 primeiros tokens relevantes do título.
 * "E6S Fones De Ouvido TWS Sem Fio" e "Pro 4 Fones De Ouvido TWS Sem Fio" são
 * produtos diferentes, mas para um grupo de ofertas é a MESMA coisa repetida —
 * a assinatura junta os dois e o ranking escolhe um.
 */
export function similarityKey(title: string): string {
  const tokens = normalizeText(title)
    .split(' ')
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
  return tokens.slice(0, 4).join(' ');
}

/**
 * Nota de qualidade da oferta — decide QUAL sobrevive quando há muitas parecidas.
 * Peso maior no ganho por venda (é o objetivo do negócio), depois prova social.
 */
export function offerScore(offer: NormalizedOffer): number {
  const ganho = (offer.price ?? 0) * (offer.commissionRate ?? 0);
  const nota = offer.ratingStar ?? 0;
  const vendas = offer.sales ?? 0;
  return ganho * 10 + nota * 2 + Math.log10(vendas + 1) * 3;
}

/** Acessório/bugiganga: casa com a keyword mas não é o produto que se quer. */
export function rejectByExcludedWord(offer: NormalizedOffer, cfg: Config): RejectResult {
  const hay = normalizeText(offer.title);
  for (const raw of cfg.EXCLUDED_TITLE_WORDS.split(',')) {
    const w = normalizeText(raw);
    if (!w) continue;
    if (hay.includes(w)) return { rejected: true, reason: `acessório/bugiganga: "${raw.trim()}"` };
  }
  return { rejected: false };
}
