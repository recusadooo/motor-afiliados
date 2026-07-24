import { z } from 'zod';

/**
 * Config central. Lê do ambiente (.env no servidor, chmod 600) e valida.
 * Segredos NUNCA são logados. Campos de integração são opcionais para permitir
 * rodar o pipeline de captura sem WhatsApp/IA conectados (modo de validação).
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(v)));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int());

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number());

const schema = z.object({
  NODE_ENV: z.string().default('production'),
  API_PORT: int(3000),
  API_DOMAIN: z.string().optional(),

  // ---- Shopee Affiliate Open API (obrigatório: é a fonte de produção) ----
  SHOPEE_APP_ID: z.string().min(1, 'SHOPEE_APP_ID ausente'),
  SHOPEE_APP_SECRET: z.string().min(1, 'SHOPEE_APP_SECRET ausente'),
  SHOPEE_API_ENDPOINT: z
    .string()
    .url()
    .default('https://open-api.affiliate.shopee.com.br/graphql'),

  // ---- Infra ----
  DATABASE_URL: z.string().min(1, 'DATABASE_URL ausente'),
  REDIS_URL: z.string().default('redis://redis:6379'),

  // ---- Evolution API (WhatsApp) — já existe na VPS; aponte para ela ----
  EVOLUTION_API_URL: z.string().url().optional(),
  EVOLUTION_API_KEY: z.string().optional(),
  WA_POSTER_INSTANCE: z.string().default('poster'),
  WA_LISTENER_INSTANCE: z.string().default('listener'),

  // URL pública do PRÓPRIO app (para configurar o webhook do listener). Ex.: https://api.SEU-DOMINIO
  PUBLIC_APP_URL: z.string().url().optional(),

  // ---- IA (copy) — opcional; sem chave, cai no fallback de copy original ----
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_API_ENDPOINT: z.string().url().default('https://api.openai.com/v1'),
  // ATENÇÃO: o id 'gpt-5.4-mini' foi a escolha do usuário mas ainda NÃO foi
  // confirmado em doc oficial — mantido configurável de propósito (ver PERGUNTAS.md).
  COPY_MODEL: z.string().default('gpt-5.4-mini'),
  MODERATION_MODEL: z.string().default('omni-moderation-latest'),

  // ---- SubIds de rastreio nos links de afiliado (até 5; a origem entra dinâmica) ----
  SUBID_CAMPAIGN: z.string().default('motor'),

  // ---- Captura (produção) ----
  // productOfferV2 sem keyword+listType:1 voltou vazio no teste; busca por keyword
  // funciona. Lista editável (ver PERGUNTAS.md).
  CAPTURE_KEYWORDS: z
    .string()
    .default(
      // Tecnologia / PC
      'notebook,monitor,teclado,mouse gamer,headset,fone de ouvido,ssd,memoria ram,placa de video,processador,webcam,roteador,cadeira gamer,celular,carregador,power bank,cabo usb,smartwatch,tablet,caixa de som,pendrive,cartao de memoria,impressora,' +
      // Casa / eletrodomésticos
      'geladeira,fogao,microondas,liquidificador,batedeira,cafeteira,air fryer,aspirador de po,ventilador,panela,ferro de passar,chaleira eletrica,purificador de agua,robo aspirador,' +
      // Comida / condimentos
      'maionese,ketchup,mostarda,azeite,cafe,achocolatado,chocolate,macarrao,tempero,oleo de cozinha,leite condensado',
    ),
  CAPTURE_SORT_TYPE: int(2), // 2 = mais vendidos
  CAPTURE_LIMIT: int(30),
  CAPTURE_MIN_COMMISSION: num(0), // decimal (0.05 = 5%); 0 = sem mínimo
  CAPTURE_CRON: z.string().default('*/30 * * * *'), // a cada 30 min

  // ---- Filtros ----
  // Desconto >= este valor é tratado como provável erro/golpe e vai p/ revisão.
  FAKE_DISCOUNT_MAX_PCT: num(95),
  // Categorias/palavras bloqueadas por padrão (lista editável; ver PERGUNTAS.md).
  BLOCKED_KEYWORDS: z
    .string()
    .default(
      'aposta,bet,cassino,cigarro,tabaco,vape,arma,munição,pistola,adulto,sexual,erótico,medicamento,remédio,tarja,anabolizante,emagrecedor,cripto,bitcoin,consórcio,empréstimo,agiota',
    ),

  // ---- Fura-fila (defaults; também por-canal no banco) ----
  PRIORITY_MIN_DISCOUNT_PCT: num(60),
  PRIORITY_MIN_SAVINGS_BRL: num(500),
  PRIORITY_INTERRUPT_WAIT: bool(true),
  PRIORITY_MIN_GAP_SECONDS: int(180),

  // ---- Aprovação: 100% automático (true) ou fila manual (false) ----
  AUTO_APPROVE: bool(true),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  // Carrega .env do diretório atual se existir (dev/CLI). Em produção o Docker
  // injeta via env_file; então a ausência do arquivo é esperada e ignorada.
  try {
    (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.();
  } catch {
    /* .env ausente — ok */
  }
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuração inválida (verifique o .env):\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Lista de palavras bloqueadas normalizadas (minúsculas, sem espaços). */
export function blockedKeywords(cfg: Config): string[] {
  return cfg.BLOCKED_KEYWORDS.split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

export const config = { load: loadConfig };
