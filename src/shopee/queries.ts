import { shopeeGraphQL } from './client';
import type { ProductOfferNode, ShopeeOfferNode, Paginated } from './types';

/**
 * Queries/mutations da Shopee. Campos verificados no explorer oficial.
 * (Ver docs/PESQUISA + verificação de API contra fonte oficial.)
 */

const PRODUCT_FIELDS = `
  itemId shopId productName productLink offerLink imageUrl
  priceMin priceMax priceDiscountRate
  commissionRate sellerCommissionRate shopeeCommissionRate commission
  sales ratingStar shopName shopType periodStartTime periodEndTime
`;

export interface ProductOfferParams {
  keyword?: string;
  /** 0=Recomendados, 1=Maior comissão, 2=Top performance. */
  listType?: number;
  /** 1=Relevância, 2=Vendidos, 3=Maior preço, 4=Menor preço, 5=Comissão. */
  sortType?: number;
  page?: number;
  limit?: number;
}

export async function productOfferV2(
  params: ProductOfferParams = {},
): Promise<Paginated<ProductOfferNode>> {
  const args: string[] = [];
  if (params.keyword) args.push(`keyword: ${JSON.stringify(params.keyword)}`);
  if (params.listType != null) args.push(`listType: ${params.listType}`);
  if (params.sortType != null) args.push(`sortType: ${params.sortType}`);
  args.push(`page: ${params.page ?? 1}`);
  args.push(`limit: ${params.limit ?? 50}`);
  const query = `query {
    productOfferV2(${args.join(', ')}) {
      nodes { ${PRODUCT_FIELDS} }
      pageInfo { page limit hasNextPage }
    }
  }`;
  const data = await shopeeGraphQL<{ productOfferV2: Paginated<ProductOfferNode> }>(query);
  return data.productOfferV2;
}

export interface ShopeeOfferParams {
  keyword?: string;
  /** 1=Mais recentes, 2=Maior comissão. */
  sortType?: number;
  page?: number;
  limit?: number;
}

export async function shopeeOfferV2(
  params: ShopeeOfferParams = {},
): Promise<Paginated<ShopeeOfferNode>> {
  const args: string[] = [];
  if (params.keyword) args.push(`keyword: ${JSON.stringify(params.keyword)}`);
  if (params.sortType != null) args.push(`sortType: ${params.sortType}`);
  args.push(`page: ${params.page ?? 1}`);
  args.push(`limit: ${params.limit ?? 20}`);
  const query = `query {
    shopeeOfferV2(${args.join(', ')}) {
      nodes { commissionRate imageUrl offerLink originalLink offerName offerType categoryId collectionId periodStartTime periodEndTime }
      pageInfo { page limit hasNextPage }
    }
  }`;
  const data = await shopeeGraphQL<{ shopeeOfferV2: Paginated<ShopeeOfferNode> }>(query);
  return data.shopeeOfferV2;
}

/**
 * Gera link de afiliado a partir de qualquer URL Shopee.
 * Mutation confirmada: generateShortLink(input: { originUrl, subIds }) { shortLink }.
 * subIds: máximo de 5 (aparecem como utmContent no relatório de conversão).
 */
export async function generateShortLink(originUrl: string, subIds: string[] = []): Promise<string> {
  const query = `mutation GenShort($input: ShopeeGenerateShortLinkInput!) {
    generateShortLink(input: $input) { shortLink }
  }`;
  const variables = { input: { originUrl, subIds: subIds.slice(0, 5) } };
  try {
    const data = await shopeeGraphQL<{ generateShortLink: { shortLink: string } }>(query, variables);
    return data.generateShortLink.shortLink;
  } catch (err) {
    // O nome exato do tipo do input ($ShopeeGenerateShortLinkInput) ainda não foi
    // confirmado por introspection. Fallback: tentar inline sem variável tipada.
    const inlineSubIds = JSON.stringify(subIds.slice(0, 5));
    const inline = `mutation {
      generateShortLink(input: { originUrl: ${JSON.stringify(originUrl)}, subIds: ${inlineSubIds} }) { shortLink }
    }`;
    const data = await shopeeGraphQL<{ generateShortLink: { shortLink: string } }>(inline);
    return data.generateShortLink.shortLink;
  }
}
