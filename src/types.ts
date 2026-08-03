/** Tipos de domínio — espelham db/schema.sql. */

export type OfferStatus =
  | 'pending'
  | 'approved'
  | 'queued'
  | 'sent'
  | 'rejected'
  | 'expired';

export type ChannelRole = 'poster' | 'listener';

/** Oferta já normalizada, antes de virar linha em `offers`. */
export interface NormalizedOffer {
  platform: string; // 'shopee'
  productId: string;
  shopId: string | null;
  title: string;
  price: number | null;
  originalPrice: number | null;
  discountPct: number | null;
  /**
   * A FAIXA de variações do anúncio. Guardada junto com `price` porque é o
   * único jeito de detectar que uma variação nova entrou — e variação nova
   * derrubando o piso é o falso "recorde histórico" mais provável.
   */
  priceMin?: number | null;
  priceMax?: number | null;
  /** IDs de categoria oficiais da Shopee (l1-l3). Só ids; o nome vem da árvore. */
  catIds?: number[] | null;
  savingsBrl: number | null;
  commissionRate: number | null; // decimal (0.07 = 7%)
  category: string | null;
  imageUrl: string | null;
  /** URL Shopee de origem (produto) usada para gerar o link de afiliado. */
  sourceUrl: string | null;
  /** Link de afiliado já pronto vindo do feed (offerLink), se houver. */
  offerLink: string | null;
  sales: number | null;
  ratingStar: number | null;
}

/** Linha de `offers` (subset usado no código). */
export interface OfferRow {
  id: string;
  raw_capture_id: string | null;
  platform: string;
  product_id: string;
  shop_id: string | null;
  title: string | null;
  price: string | null; // NUMERIC vem como string no pg
  original_price: string | null;
  discount_pct: string | null;
  savings_brl: string | null;
  commission_rate: string | null;
  category: string | null;
  affiliate_url: string | null;
  image_url: string | null;
  rewritten_copy: string | null;
  copy_placeholders: Record<string, unknown> | null;
  ai_fallback: boolean;
  quality_score: string | null;
  priority: number;
  is_priority: boolean;
  dedup_key: string;
  status: OfferStatus;
  reject_reason: string | null;
  valid_until: string | null;
  created_at: string;
}

export interface ChannelRow {
  id: string;
  platform: string;
  role: ChannelRole;
  instance_ref: string;
  target_ref: string | null;
  display_name: string | null;
  status: 'active' | 'warming' | 'paused' | 'banned';
  drip_min_sec: number;
  drip_max_sec: number;
  jitter_min_sec: number;
  jitter_max_sec: number;
  quiet_start: string; // 'HH:MM:SS'
  quiet_end: string;
  timezone: string;
  daily_cap: number;
  sent_today: number;
}

/** Resultado da avaliação de filtros. */
export interface RejectResult {
  rejected: boolean;
  reason?: string;
}

/** Copy gerada pela IA (com placeholders, nunca números literais). */
export interface GeneratedCopy {
  headline: string;
  body: string;
  hashtags: string[];
  /** true se veio do fallback (IA indisponível/reprovada). */
  fallback: boolean;
}
