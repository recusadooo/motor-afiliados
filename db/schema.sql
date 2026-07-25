-- ============================================================
-- Motor de Afiliados (Shopee-first / WhatsApp-first) — PostgreSQL
-- Segredos NUNCA ficam em tabela. Timestamps em TIMESTAMPTZ.
-- ============================================================

-- Fontes: API oficial (produção) e grupos de WhatsApp (enriquecimento/read-only)
CREATE TABLE IF NOT EXISTS sources (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('shopee_api','whatsapp_group','manual')),
  external_ref TEXT NOT NULL,
  name         TEXT,
  role         TEXT NOT NULL DEFAULT 'production' CHECK (role IN ('production','enrichment')),
  is_active    BOOLEAN DEFAULT true,
  config       JSONB DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE (kind, external_ref)
);

-- Captura crua imutável. content_hash NORMALIZADO (sem timestamp/emoji/whitespace).
CREATE TABLE IF NOT EXISTS raw_captures (
  id           BIGSERIAL PRIMARY KEY,
  source_id    BIGINT REFERENCES sources(id),
  captured_at  TIMESTAMPTZ DEFAULT now(),
  raw_payload  JSONB NOT NULL,
  raw_url      TEXT,
  content_hash TEXT NOT NULL,
  status       TEXT DEFAULT 'new' CHECK (status IN ('new','parsed','rejected','duplicate')),
  UNIQUE (source_id, content_hash)
);

-- Histórico de preço PRÓPRIO — base p/ detectar desconto falso.
CREATE TABLE IF NOT EXISTS price_history (
  id          BIGSERIAL PRIMARY KEY,
  product_id  TEXT NOT NULL,
  shop_id     TEXT,
  price       NUMERIC(12,2) NOT NULL,
  captured_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_price_hist ON price_history (product_id, shop_id, captured_at DESC);

-- Oferta processada (link afiliado + copy) = unidade de negócio.
CREATE TABLE IF NOT EXISTS offers (
  id                BIGSERIAL PRIMARY KEY,
  raw_capture_id    BIGINT REFERENCES raw_captures(id),
  platform          TEXT DEFAULT 'shopee',
  product_id        TEXT NOT NULL,
  shop_id           TEXT,
  title             TEXT,
  price             NUMERIC(12,2),
  original_price    NUMERIC(12,2),
  discount_pct      NUMERIC(5,2),
  savings_brl       NUMERIC(12,2),
  commission_rate   NUMERIC(6,4),              -- decimal: 0.07 = 7%
  category          TEXT,
  affiliate_url     TEXT,
  image_url         TEXT,
  rewritten_copy    TEXT,
  copy_placeholders JSONB,
  ai_fallback       BOOLEAN DEFAULT false,
  quality_score     NUMERIC,
  priority          INT DEFAULT 100,           -- maior = mais prioridade
  is_priority       BOOLEAN DEFAULT false,     -- fura-fila
  dedup_key         TEXT NOT NULL,             -- sha256(platform:shop_id:product_id)
  status            TEXT DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','queued','sent','rejected','expired')),
  reject_reason     TEXT,
  valid_until       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE (dedup_key)
);
-- fura-fila primeiro (is_priority DESC), depois prioridade, depois FIFO.
CREATE INDEX IF NOT EXISTS idx_offers_dispatch
  ON offers (status, is_priority DESC, priority DESC, created_at)
  WHERE status IN ('approved','queued');

-- Canais WhatsApp (poster = número A; listener = número B, read-only).
CREATE TABLE IF NOT EXISTS channels (
  id           BIGSERIAL PRIMARY KEY,
  platform     TEXT NOT NULL DEFAULT 'whatsapp' CHECK (platform IN ('whatsapp','telegram')),
  role         TEXT NOT NULL CHECK (role IN ('poster','listener')),
  instance_ref TEXT NOT NULL,                  -- instância na Evolution
  target_ref   TEXT,                           -- id do grupo de destino (poster)
  display_name TEXT,
  status       TEXT DEFAULT 'active' CHECK (status IN ('active','warming','paused','banned')),
  drip_min_sec   INT DEFAULT 1200,             -- 20 min (base aleatório)
  drip_max_sec   INT DEFAULT 1800,             -- 30 min (base aleatório)
  jitter_min_sec INT DEFAULT 180,              -- +3 min (jitter aleatório)
  jitter_max_sec INT DEFAULT 300,              -- +5 min (jitter aleatório)
  quiet_start  TIME DEFAULT '00:00',
  quiet_end    TIME DEFAULT '07:00',
  timezone     TEXT DEFAULT 'America/Sao_Paulo',
  daily_cap    INT DEFAULT 250,
  sent_today   INT DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE (platform, instance_ref, target_ref)
);

-- Estado do agendador por canal (cadência + próximo disparo + lock).
CREATE TABLE IF NOT EXISTS schedules (
  id          BIGSERIAL PRIMARY KEY,
  channel_id  BIGINT UNIQUE REFERENCES channels(id),
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  state       TEXT DEFAULT 'idle' CHECK (state IN ('idle','pending','paused')),
  lock_token  UUID,
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- LOG DE ENVIO = âncora de idempotência ("nunca 2x mesmo produto/canal").
CREATE TABLE IF NOT EXISTS send_logs (
  id                  BIGSERIAL PRIMARY KEY,
  offer_id            BIGINT REFERENCES offers(id),
  channel_id          BIGINT REFERENCES channels(id),
  offer_dedup_key     TEXT NOT NULL,
  job_id              TEXT,
  status              TEXT NOT NULL CHECK (status IN ('claimed','sent','failed','skipped')),
  platform_message_id TEXT,
  attempt             INT DEFAULT 1,
  error_code          TEXT,
  error_detail        TEXT,
  claimed_at          TIMESTAMPTZ DEFAULT now(),
  sent_at             TIMESTAMPTZ,
  UNIQUE (channel_id, offer_dedup_key)          -- garantia durável
);

-- Filtros de rejeição/boost (globais ou por fonte).
CREATE TABLE IF NOT EXISTS filters (
  id          BIGSERIAL PRIMARY KEY,
  source_id   BIGINT REFERENCES sources(id),
  type        TEXT NOT NULL CHECK (type IN
              ('keyword_block','min_discount','min_price','max_price',
               'category_allow','category_block','regex')),
  expression  TEXT NOT NULL,
  action      TEXT DEFAULT 'reject' CHECK (action IN ('reject','flag','boost_priority')),
  priority    INT DEFAULT 100,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Dead-letter (revisão manual) + auditoria ponta a ponta.
CREATE TABLE IF NOT EXISTS dlq (
  id             BIGSERIAL PRIMARY KEY,
  orig_queue     TEXT,
  payload        JSONB,
  error          TEXT,
  stack          TEXT,
  channel_id     BIGINT,
  correlation_id UUID,
  status         TEXT DEFAULT 'pending_review' CHECK (status IN ('pending_review','replayed','discarded')),
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id             BIGSERIAL PRIMARY KEY,
  correlation_id UUID,
  offer_id       BIGINT,
  stage          TEXT,
  actor          TEXT,
  detail         JSONB,
  ts             TIMESTAMPTZ DEFAULT now()
);

-- Configurações de runtime editáveis pela interface (ferramenta de uso pessoal).
-- Ex.: openai_api_key, copy_model. Fica no VPS, nunca sai daqui.
-- Obs.: guardar chave aqui é uma concessão consciente por ser uso exclusivo do dono
-- e por pedido dele (config pela interface). Nunca é exposta na API (só "definida?").
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- Evoluções (idempotentes — o migrate reaplica este arquivo a cada boot).
-- CREATE TABLE IF NOT EXISTS não adiciona coluna em tabela que já existe,
-- por isso as colunas novas entram como ALTER ... IF NOT EXISTS.
-- ============================================================

-- Contexto da oferta para o painel poder filtrar e para o dono entender o feed.
ALTER TABLE offers ADD COLUMN IF NOT EXISTS sales INT;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS rating_star NUMERIC(3,2);
-- desconto ANUNCIADO pela Shopee (inflado); discount_pct guarda o REAL (medido)
ALTER TABLE offers ADD COLUMN IF NOT EXISTS advertised_discount_pct NUMERIC(5,2);
-- palavra-chave que trouxe a oferta (permite filtrar o feed por nicho)
ALTER TABLE offers ADD COLUMN IF NOT EXISTS keyword TEXT;
-- ganho estimado por venda (preço x comissão) — evita recalcular no front
ALTER TABLE offers ADD COLUMN IF NOT EXISTS commission_brl NUMERIC(12,2);

CREATE INDEX IF NOT EXISTS idx_offers_status_created ON offers (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_offers_keyword ON offers (keyword);
CREATE INDEX IF NOT EXISTS idx_price_history_prod ON price_history (product_id, shop_id, captured_at DESC);

-- Histórico de cada ciclo de captura: quantas vieram, quantas foram cortadas e
-- por quê. É o que responde "por que o feed está assim" no painel.
CREATE TABLE IF NOT EXISTS capture_runs (
  id          BIGSERIAL PRIMARY KEY,
  started_at  TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ,
  trigger     TEXT DEFAULT 'cron',   -- cron | manual
  stats       JSONB,
  error       TEXT
);
