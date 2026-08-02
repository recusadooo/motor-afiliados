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
  /*
   * INLINE, não variável tipada — e isto foi MEDIDO, não escolhido.
   *
   * A versão anterior tentava primeiro `mutation($input: ShopeeGenerateShortLinkInput!)`
   * e só caía para inline quando o schema reclamava. O schema reclama SEMPRE:
   * esse nome de tipo não existe. Verificado ao processar oferta real —
   * "Unknown type ShopeeGenerateShortLinkInput" saía no log a cada oferta.
   *
   * O custo não era só o log: eram DUAS chamadas à API por link (a tipada que
   * falha + a inline que funciona), na conta de afiliado, que é o ativo mais
   * frágil do projeto. E um erro que aparece em toda oferta treina qualquer um
   * a ignorar o log — mascarando o erro seguinte, que pode ser de verdade.
   *
   * Injeção não é preocupação aqui: `JSON.stringify` escapa a URL e os subIds,
   * e os dois são gerados por nós, não vêm de entrada externa.
   */
  const inline = `mutation {
    generateShortLink(input: { originUrl: ${JSON.stringify(originUrl)}, subIds: ${JSON.stringify(subIds.slice(0, 5))} }) { shortLink }
  }`;
  const data = await shopeeGraphQL<{ generateShortLink: { shortLink: string } }>(inline);
  return data.generateShortLink.shortLink;
}

