import { query, queryOne } from '../db';
import { toNum } from '../util';

/**
 * Histórico de preço PRÓPRIO — base para detectar desconto falso e desconto REAL.
 * O "de/por" do anúncio (priceDiscountRate) é potencialmente inflado, então a
 * verdade vem daqui: preços que NÓS observamos ao longo do tempo.
 */

export async function recordPrice(
  productId: string,
  shopId: string | null,
  price: number | null,
): Promise<void> {
  if (price == null) return;
  await query(
    `INSERT INTO price_history (product_id, shop_id, price) VALUES ($1, $2, $3)`,
    [productId, shopId, price],
  );
}

export interface PriceStats {
  count: number;
  min: number | null;
  median: number | null;
  max: number | null;
}

export async function getPriceStats(
  productId: string,
  shopId: string | null,
  days = 60,
): Promise<PriceStats> {
  const row = await queryOne<{
    count: string;
    min: string | null;
    median: string | null;
    max: string | null;
  }>(
    `SELECT count(*)::text AS count,
            min(price)::text AS min,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY price)::text AS median,
            max(price)::text AS max
       FROM price_history
      WHERE product_id = $1
        AND (shop_id = $2 OR ($2 IS NULL AND shop_id IS NULL))
        AND captured_at > now() - ($3 || ' days')::interval`,
    [productId, shopId, String(days)],
  );
  return {
    count: row ? Number(row.count) : 0,
    min: toNum(row?.min),
    median: toNum(row?.median),
    max: toNum(row?.max),
  };
}
