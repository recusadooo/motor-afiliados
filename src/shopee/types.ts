/** Tipos da Shopee Affiliate Open API (campos verificados no explorer oficial). */

export interface ProductOfferNode {
  itemId: number | string;
  shopId: number | string | null;
  productName: string;
  productLink: string; // URL do produto (origem p/ generateShortLink)
  offerLink: string; // link de afiliado já pronto (quando presente)
  imageUrl: string;
  priceMin: string | number; // NÃO existe campo único 'price' — só faixa
  priceMax: string | number;
  priceDiscountRate: string | number | null; // % de desconto (anunciado)
  commissionRate: string | number; // decimal: 0.07 = 7%
  sellerCommissionRate?: string | number;
  shopeeCommissionRate?: string | number;
  commission?: string | number;
  sales?: number | null;
  ratingStar?: string | number | null;
  shopName?: string | null;
  shopType?: unknown;
  periodStartTime?: number | null;
  periodEndTime?: number | null;
}

export interface ShopeeOfferNode {
  commissionRate: string | number;
  imageUrl: string;
  offerLink: string;
  originalLink: string;
  offerName: string;
  offerType?: unknown;
  categoryId?: number | string | null;
  collectionId?: number | string | null;
  periodStartTime?: number | null;
  periodEndTime?: number | null;
}

export interface PageInfo {
  page: number;
  limit: number;
  hasNextPage: boolean;
}

export interface Paginated<T> {
  nodes: T[];
  pageInfo: PageInfo;
}
