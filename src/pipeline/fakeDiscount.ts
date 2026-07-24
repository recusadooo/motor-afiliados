import type { NormalizedOffer } from '../types';
import type { PriceStats } from './priceHistory';

/**
 * Avaliação de desconto REAL e detecção de desconto falso.
 *
 * Princípio (confirmado ao vivo): o priceDiscountRate da Shopee é o "de/por" do
 * anúncio e pode ser inflado. A verdade vem do NOSSO price_history.
 */

export interface DiscountAssessment {
  /** Preço "normal" de referência (mediana histórica). */
  reference: number | null;
  /** Economia real vs. referência (>= 0). */
  realSavings: number | null;
  /** Desconto real em % vs. referência. */
  realDiscountPct: number | null;
  /** true quando há histórico suficiente para confiar no cálculo. */
  confident: boolean;
  /** true = provável desconto falso / erro de preço -> rejeitar ou revisar. */
  fake: boolean;
  fakeReason?: string;
}

const MIN_HISTORY = 3;

export function assessDiscount(
  offer: NormalizedOffer,
  stats: PriceStats,
  fakeDiscountMaxPct: number,
): DiscountAssessment {
  const price = offer.price;

  // Desconto anunciado absurdo (>= limite) = provável erro/golpe.
  if (offer.discountPct != null && offer.discountPct >= fakeDiscountMaxPct) {
    return {
      reference: stats.median,
      realSavings: null,
      realDiscountPct: null,
      confident: false,
      fake: true,
      fakeReason: `desconto anunciado ${offer.discountPct}% >= ${fakeDiscountMaxPct}% (provável erro/golpe)`,
    };
  }

  if (price == null || stats.median == null || stats.count < MIN_HISTORY) {
    // Sem histórico suficiente: não dá para afirmar desconto real nem falsidade.
    return {
      reference: stats.median,
      realSavings: null,
      realDiscountPct: null,
      confident: false,
      fake: false,
    };
  }

  const reference = stats.median;
  const realSavings = Math.max(0, reference - price);
  const realDiscountPct = reference > 0 ? (realSavings / reference) * 100 : 0;

  // "de/por" inflado: o original anunciado seria muito acima da mediana real.
  let fake = false;
  let fakeReason: string | undefined;
  if (offer.discountPct != null && offer.discountPct > 0 && offer.discountPct < 100 && price > 0) {
    const advertisedOriginal = price / (1 - offer.discountPct / 100);
    if (advertisedOriginal > reference * 1.3) {
      fake = true;
      fakeReason = `"de" anunciado (~${advertisedOriginal.toFixed(2)}) muito acima da mediana real (${reference.toFixed(2)})`;
    }
  }

  return { reference, realSavings, realDiscountPct, confident: true, fake, fakeReason };
}
