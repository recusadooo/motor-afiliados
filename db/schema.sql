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

-- ============================================================
-- INTELIGÊNCIA DE MERCADO — engenharia reversa do critério dos concorrentes
--
-- Pergunta que estas tabelas respondem: "de tudo que a Shopee ofereceu hoje,
-- o que os grupos escolheram postar, quanto tempo depois, e o que eles têm em
-- comum?". Isso exige guardar as DUAS pontas no mesmo eixo do tempo:
--   api_observations = o cardápio (tudo que a API devolveu, SEM filtro)
--   intel_posts      = o prato escolhido (o que apareceu nos grupos)
--   intel_matches    = a ligação entre os dois, com nota de confiança
--
-- A captura de PRODUÇÃO (raw_captures/offers) não serve para isso: ela só grava
-- as ~10 finalistas de cada ciclo. Comparar grupos contra as finalistas mede se
-- nós e eles escolhemos igual — não O QUE eles escolheram do mesmo cardápio.
-- ============================================================

-- Similaridade de título (trigrama) — é como um post de grupo encontra a oferta
-- correspondente na API sem resolver o link de afiliado do concorrente.
-- Guardado: se o papel do banco não puder criar extensão, a migração NÃO morre;
-- o casamento cai para similaridade em memória (mais lento, mesmo resultado).
DO $intel$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION
  WHEN insufficient_privilege OR feature_not_supported OR undefined_file THEN
    RAISE NOTICE 'pg_trgm indisponível — casamento por similaridade em memória';
END
$intel$;

-- Uma varredura = uma passada larga pelas keywords, só para OBSERVAR.
CREATE TABLE IF NOT EXISTS intel_sweeps (
  id          BIGSERIAL PRIMARY KEY,
  started_at  TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ,
  trigger     TEXT DEFAULT 'cron',      -- cron | manual
  keywords    INT,
  observed    INT DEFAULT 0,
  stats       JSONB,
  error       TEXT
);

-- O CARDÁPIO: tudo que a API devolveu, sem filtro, com hora.
-- Uma linha por (varredura, produto) — a repetição ao longo do tempo é o dado:
-- é ela que permite dizer "vimos às 14h02, eles postaram às 14h49".
CREATE TABLE IF NOT EXISTS api_observations (
  id            BIGSERIAL PRIMARY KEY,
  sweep_id      BIGINT REFERENCES intel_sweeps(id) ON DELETE CASCADE,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  platform      TEXT NOT NULL DEFAULT 'shopee',
  product_id    TEXT NOT NULL,
  shop_id       TEXT,
  title         TEXT NOT NULL,
  title_norm    TEXT NOT NULL,             -- normalizeText(title): base do trigrama
  price         NUMERIC(12,2),
  commission_rate NUMERIC(6,4),
  commission_brl  NUMERIC(12,2),           -- preço x comissão (ganho por venda)
  advertised_discount_pct NUMERIC(5,2),
  sales         INT,
  rating_star   NUMERIC(3,2),
  keyword       TEXT,
  image_url     TEXT,
  offer_link    TEXT,
  -- Nossos filtros de produção teriam aprovado esta oferta? Sem gravar isso não
  -- dá para responder a pergunta mais útil de todas: "do que eles postaram,
  -- quanto o NOSSO filtro teria deixado passar?".
  would_pass    BOOLEAN,
  reject_reason TEXT,
  UNIQUE (sweep_id, platform, product_id)
);
CREATE INDEX IF NOT EXISTS idx_api_obs_time     ON api_observations (observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_obs_product  ON api_observations (platform, product_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_obs_keyword  ON api_observations (keyword);

-- Grupos de WhatsApp observados. `kind` é a marcação que precisa existir desde
-- o primeiro dia: sem ela não dá para separar depois "critério de grupo
-- generalista" de "critério de grupo de nicho" — e os dois são diferentes.
CREATE TABLE IF NOT EXISTS intel_groups (
  id           BIGSERIAL PRIMARY KEY,
  group_jid    TEXT NOT NULL UNIQUE,       -- 1203...@g.us
  display_name TEXT,
  kind         TEXT NOT NULL DEFAULT 'promo'
               CHECK (kind IN ('promo','nicho','misto','proprio')),
  instance_ref TEXT,                        -- instância da Evolution que escuta
  is_active    BOOLEAN NOT NULL DEFAULT true,
  notes        TEXT,
  posts_count  INT NOT NULL DEFAULT 0,
  last_post_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- O QUE OS GRUPOS POSTARAM. Só conteúdo de oferta.
-- LGPD: nada de telefone, @, nome ou id de participante — nem em coluna, nem
-- dentro de `text`. Quem grava é responsável por já ter removido.
CREATE TABLE IF NOT EXISTS intel_posts (
  id             BIGSERIAL PRIMARY KEY,
  group_id       BIGINT NOT NULL REFERENCES intel_groups(id) ON DELETE CASCADE,
  posted_at      TIMESTAMPTZ NOT NULL,      -- hora da MENSAGEM (não da ingestão)
  ingested_at    TIMESTAMPTZ DEFAULT now(),
  message_hash   TEXT NOT NULL,             -- sha256(texto normalizado) = dedupe
  text           TEXT NOT NULL,
  title_guess    TEXT,                      -- melhor palpite do nome do produto
  title_norm     TEXT,
  price          NUMERIC(12,2),
  price_old      NUMERIC(12,2),
  discount_pct   NUMERIC(5,2),
  coupon         TEXT,
  urls           JSONB NOT NULL DEFAULT '[]',
  platform_guess TEXT,                      -- shopee | amazon | mercadolivre | outro
  has_image      BOOLEAN NOT NULL DEFAULT false,
  matched_at     TIMESTAMPTZ,               -- null = ainda não passou pelo matcher
  wa_message_id  TEXT                       -- id da mensagem no WhatsApp (dedupe correta)
);
ALTER TABLE intel_posts ADD COLUMN IF NOT EXISTS wa_message_id TEXT;

/*
 * DEDUPLICAÇÃO — a versão anterior estava ERRADA de um jeito que invertia uma
 * das respostas do produto.
 *
 * Era `UNIQUE (group_id, message_hash)`, com hash do texto, único no grupo PARA
 * SEMPRE. Grupo de promoção republica a MESMA mensagem toda semana — e detectar
 * exatamente isso ("eles usam lista fixa?") é uma das quatro perguntas que este
 * módulo existe para responder. Com o hash eterno, a 2ª à 4ª republicação eram
 * descartadas, `repeticaoDeProdutos` via `vezes = 1`, e o painel afirmava "eles
 * não repetem produtos" — o inverso exato da verdade.
 *
 * Agora são duas travas, cada uma no seu papel:
 *  1. wa_message_id: o identificador estável do WhatsApp. É a dedupe CERTA —
 *     mesma mensagem entregue duas vezes pelo webhook é a mesma mensagem.
 *  2. hash do texto POR DIA: rede de segurança para quando o id não vier
 *     (payload antigo, outro transporte). Escopado ao dia justamente para não
 *     apagar a republicação de amanhã.
 */
DO $intel$
BEGIN
  ALTER TABLE intel_posts DROP CONSTRAINT IF EXISTS intel_posts_group_id_message_hash_key;
EXCEPTION WHEN undefined_object THEN
  NULL;
END
$intel$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_intel_posts_wamid
  ON intel_posts (group_id, wa_message_id)
  WHERE wa_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_intel_posts_hash_dia
  ON intel_posts (group_id, message_hash, ((posted_at AT TIME ZONE 'America/Sao_Paulo')::date));
CREATE INDEX IF NOT EXISTS idx_intel_posts_time    ON intel_posts (posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_intel_posts_pending ON intel_posts (matched_at) WHERE matched_at IS NULL;
-- O Postgres NÃO cria índice para chave estrangeira sozinho, e a cobertura por
-- grupo agrupa exatamente por esta coluna.
CREATE INDEX IF NOT EXISTS idx_intel_posts_grupo   ON intel_posts (group_id, posted_at DESC);

-- A CORRELAÇÃO. `verdict` existe para impedir a conclusão confiante e errada:
-- "eles não postaram" e "a gente não observou" e "o matcher não achou" parecem
-- a mesma linha vazia no relatório, e só a primeira é interessante.
CREATE TABLE IF NOT EXISTS intel_matches (
  id              BIGSERIAL PRIMARY KEY,
  post_id         BIGINT NOT NULL REFERENCES intel_posts(id) ON DELETE CASCADE,
  observation_id  BIGINT REFERENCES api_observations(id) ON DELETE SET NULL,
  product_id      TEXT,
  method          TEXT NOT NULL CHECK (method IN ('title_price','title','product_id','manual')),
  confidence      NUMERIC(4,3) NOT NULL,     -- 0..1
  title_sim       NUMERIC(4,3),
  price_delta_pct NUMERIC(7,2),
  -- O NÚMERO CENTRAL: segundos entre a nossa 1ª observação do produto e o post
  -- deles. Negativo = eles postaram ANTES de a gente ver (têm outra fonte, ou
  -- nossa varredura é lenta demais).
  lag_seconds     BIGINT,
  first_seen_at   TIMESTAMPTZ,
  verdict         TEXT NOT NULL CHECK (verdict IN
                  ('casado','ambiguo','sem_casamento','nao_observado')),
  confirmed       BOOLEAN,                   -- conferência humana por amostragem
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (post_id)
);
/*
 * FOTOGRAFIA DA OBSERVAÇÃO NO MOMENTO DO CASAMENTO.
 *
 * Sem isto, a poda de 90 dias REESCREVE O PASSADO: `api_observations` é
 * apagada, `intel_matches.observation_id` vira NULL (ON DELETE SET NULL), e a
 * partir daí `wouldPassCasados` cai, o perfil perde a linha e a correlação do
 * dia mostra `casado` com título e preço vazios. Um número que o dono anotou
 * semana passada muda sozinho — que é a pior coisa que um painel pode fazer.
 *
 * Guardar a fotografia aqui torna o match IMUTÁVEL: ele é um fato histórico
 * ("neste instante, este post correspondia a esta oferta, que custava X"), e
 * fato histórico não deve depender de a linha de origem ainda existir.
 */
ALTER TABLE intel_matches ADD COLUMN IF NOT EXISTS obs_title          TEXT;
ALTER TABLE intel_matches ADD COLUMN IF NOT EXISTS obs_price          NUMERIC(12,2);
ALTER TABLE intel_matches ADD COLUMN IF NOT EXISTS obs_commission_brl NUMERIC(12,2);
ALTER TABLE intel_matches ADD COLUMN IF NOT EXISTS obs_sales          INT;
ALTER TABLE intel_matches ADD COLUMN IF NOT EXISTS obs_rating_star    NUMERIC(3,2);
ALTER TABLE intel_matches ADD COLUMN IF NOT EXISTS obs_would_pass     BOOLEAN;
ALTER TABLE intel_matches ADD COLUMN IF NOT EXISTS obs_reject_reason  TEXT;

/*
 * 'outra_plataforma' entrou DEPOIS, a partir de mensagens reais de um grupo
 * concorrente: em 17 posts observados, 10 eram Amazon e 7 Mercado Livre —
 * ZERO Shopee. Post de outra loja não tem como casar contra a API da Shopee, e
 * marcá-lo `sem_casamento` faria o painel dizer "a nossa varredura não achou",
 * quando a verdade é "não havia o que achar aqui". São conclusões opostas: a
 * primeira manda calibrar a varredura, a segunda manda trocar de grupo.
 *
 * DROP + ADD em vez de IF NOT EXISTS porque CHECK não tem forma idempotente
 * nativa; o custo é desprezível e o schema é reaplicado a cada boot.
 */
ALTER TABLE intel_matches DROP CONSTRAINT IF EXISTS intel_matches_verdict_check;
ALTER TABLE intel_matches ADD CONSTRAINT intel_matches_verdict_check
  CHECK (verdict IN ('casado','ambiguo','sem_casamento','nao_observado','outra_plataforma'));

CREATE INDEX IF NOT EXISTS idx_intel_matches_verdict ON intel_matches (verdict, created_at DESC);
-- O perfil de escolha junta matches -> observações; sem isto vira varredura da
-- tabela maior do sistema.
CREATE INDEX IF NOT EXISTS idx_intel_matches_obs     ON intel_matches (observation_id)
  WHERE observation_id IS NOT NULL;
-- Repetição de produto (o teste da hipótese "lista fixa") agrupa por product_id.
CREATE INDEX IF NOT EXISTS idx_intel_matches_produto ON intel_matches (product_id)
  WHERE product_id IS NOT NULL;

-- Índices de trigrama: só se a extensão existir (ver bloco guardado acima).
DO $intel$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS idx_api_obs_title_trgm
      ON api_observations USING gin (title_norm gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS idx_intel_posts_title_trgm
      ON intel_posts USING gin (title_norm gin_trgm_ops);
  END IF;
END
$intel$;
