/** Tipos da Shopee Affiliate Open API (campos verificados no explorer oficial). */

export interface ProductOfferNode {
  itemId: number | string;
  shopId: number | string | null;
  productName: string;
  productLink: string; // URL do produto (origem p/ generateShortLink)
  offerLink: string; // link de afiliado já pronto (quando presente)
  imageUrl: string;
  /**
   * IDs de categoria, níveis 1 a 3 (descrição oficial do explorer:
   * "Product category ids, l1-l3"). Vem SÓ o id — o nome não existe em lugar
   * nenhum da API de afiliados; o mapa id→nome sai da árvore pública do site
   * (`shopee/categorias.ts`).
   */
  productCatIds?: Array<number | string> | null;
  /**
   * Preço do item. O comentário anterior deste arquivo dizia "NÃO existe campo
   * único 'price' — só faixa", e isso está ERRADO: o schema oficial declara
   * `price: String!` (garantido) em `ProductOfferV2`. Nós é que não estávamos
   * pedindo.
   *
   * Por que importa mais do que parece: `priceMin` é o piso da FAIXA de
   * variações. Se o vendedor pendura uma capinha de R$ 9 no mesmo anúncio, o
   * `priceMin` despenca e um monitor de preço anuncia recorde histórico de um
   * produto que não baixou. Guardamos os três — `price` é a série, a faixa é o
   * detector de que uma variação nova entrou.
   */
  price?: string | number | null;
  priceMin: string | number;
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
