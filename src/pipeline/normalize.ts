import type { ProductOfferNode, ShopeeOfferNode } from '../shopee/types';
import type { NormalizedOffer } from '../types';
import { toNum, normalizeText, sha256hex } from '../util';

/**
 * Converte um nó da Shopee em NormalizedOffer.
 * Formatos CONFIRMADOS ao vivo (docs/SHOPEE-API-CAMPOS.md):
 *  - itemId/shopId: inteiros -> String()
 *  - priceMin/priceMax: STRING decimal ("12.51")
 *  - priceDiscountRate: INTEIRO percentual (65 = 65%) — é o "de/por" do anúncio,
 *    NÃO reconcilia com o preço; NÃO usar como verdade (só sinal secundário).
 *  - commissionRate: STRING decimal ("0.07" = 7%)
 *  - offerLink: JÁ é o link de afiliado curto (usável direto)
 */
export function normalizeProduct(node: ProductOfferNode): NormalizedOffer {
  /*
   * `price` primeiro, `priceMin` só como reserva. Ver a nota em
   * `shopee/types.ts`: monitorar `priceMin` é monitorar a variação mais barata
   * do anúncio, não o produto — e é a origem mais provável de falso recorde
   * num histórico longo.
   */
  const priceMin = toNum(node.priceMin);
  const priceMax = toNum(node.priceMax);
  const price = toNum(node.price) ?? priceMin;
  const advertisedDiscount = toNum(node.priceDiscountRate); // % anunciado (inflado)

  return {
    platform: 'shopee',
    productId: String(node.itemId),
    shopId: node.shopId != null ? String(node.shopId) : null,
    title: node.productName,
    price,
    // original/savings REAIS são calculados no process a partir do price_history.
    originalPrice: null,
    discountPct: advertisedDiscount, // anunciado (referência de exibição)
    savingsBrl: null,
    commissionRate: toNum(node.commissionRate), // decimal 0.07
    category: null,
    // Ids crus: quem traduz é `shopee/categorias.ts`, que tem o mapa oficial.
    priceMin,
    priceMax,
    catIds: Array.isArray(node.productCatIds)
      ? node.productCatIds.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0)
      : null,
    imageUrl: node.imageUrl ?? null,
    sourceUrl: node.productLink ?? null,
    offerLink: node.offerLink ?? null,
    sales: node.sales ?? null,
    ratingStar: toNum(node.ratingStar),
  };
}

export function normalizeShopeeOffer(node: ShopeeOfferNode): NormalizedOffer {
  return {
    platform: 'shopee',
    productId: node.collectionId != null ? `col:${node.collectionId}` : `offer:${sha256hex(node.offerLink).slice(0, 16)}`,
    shopId: null,
    title: node.offerName,
    price: null,
    originalPrice: null,
    discountPct: null,
    savingsBrl: null,
    commissionRate: toNum(node.commissionRate),
    category: node.categoryId != null ? String(node.categoryId) : null,
    imageUrl: node.imageUrl ?? null,
    sourceUrl: node.originalLink ?? null,
    offerLink: node.offerLink ?? null,
    sales: null,
    ratingStar: null,
  };
}

/** content_hash normalizado — barra reentrada da MESMA oferta com texto variado. */
export function contentHash(o: NormalizedOffer): string {
  return sha256hex(normalizeText(`${o.platform}|${o.productId}|${o.title}|${o.price ?? ''}`));
}

/** dedup_key durável = sha256(platform:shopId:productId). */
export function dedupKey(o: NormalizedOffer): string {
  return sha256hex(`${o.platform}:${o.shopId ?? ''}:${o.productId}`);
}
