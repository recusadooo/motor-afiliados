import { z } from 'zod';

/**
 * Config central. Lê do ambiente (.env no servidor, chmod 600) e valida.
 * Segredos NUNCA são logados. Campos de integração são opcionais para permitir
 * rodar o pipeline de captura sem WhatsApp/IA conectados (modo de validação).
 */

/**
 * IMPORTANTE: variável AUSENTE e variável VAZIA são tratadas igual (= default).
 * O compose do Swarm injeta `${VAR:-}`, que chega como string vazia quando você
 * não preenche no Portainer — sem isso, um campo em branco atropelaria o default
 * (ex.: AUTO_APPROVE='' travaria tudo em 'pending' sem erro visível).
 */
const empty = (v: string | undefined) => v === undefined || v.trim() === '';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (empty(v) ? def : /^(1|true|yes|on)$/i.test(v as string)));

/** String com default: vazio cai no default. */
const str = (def: string) =>
  z
    .string()
    .optional()
    .transform((v) => (empty(v) ? def : (v as string).trim()));

/** String opcional: vazio vira undefined (não quebra validação de URL). */
const optStr = () =>
  z
    .string()
    .optional()
    .transform((v) => (empty(v) ? undefined : (v as string).trim()));

/** URL opcional: vazio vira undefined; preenchido é validado. */
const optUrl = () => optStr().pipe(z.string().url().optional());

/** URL com default: vazio cai no default; o resultado é sempre validado. */
const url = (def: string) => str(def).pipe(z.string().url());

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (empty(v) ? def : Number(v)))
    .pipe(z.number().int());

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (empty(v) ? def : Number(v)))
    .pipe(z.number());

/**
 * Lista padrão de bloqueio. Exportada para os testes travarem os
 * falso-positivos encontrados ao vivo (palavra solta "adulto" bloqueava
 * termômetro "para bebê e adulto") — termos ambíguos viraram FRASES.
 */
export const DEFAULT_BLOCKED_KEYWORDS =
  'aposta,bet,cassino,cigarro,tabaco,vape,narguile,arma de fogo,munição,pistola,airsoft,' +
  'conteúdo adulto,sex shop,sexual,erótico,vibrador,plug anal,' +
  'medicamento,tarja preta,tarja vermelha,anabolizante,emagrecedor,suplemento emagrecedor,' +
  'cripto,bitcoin,consórcio,empréstimo,agiota';

const schema = z.object({
  NODE_ENV: str('production'),
  API_PORT: int(3000),
  API_DOMAIN: optStr(),

  // ---- Shopee Affiliate Open API (obrigatório: é a fonte de produção) ----
  SHOPEE_APP_ID: z.string().min(1, 'SHOPEE_APP_ID ausente'),
  SHOPEE_APP_SECRET: z.string().min(1, 'SHOPEE_APP_SECRET ausente'),
  SHOPEE_API_ENDPOINT: url('https://open-api.affiliate.shopee.com.br/graphql'),
  // ---- Freio de taxa da Shopee (ver src/shopee/throttle.ts) ----
  // A conta de afiliado é o ativo mais frágil do projeto e o critério de "uso
  // anormal" não é público -> tetos conservadores, por escolha, não por
  // exigência documentada. 0 desliga cada trava.
  SHOPEE_MIN_INTERVAL_MS: int(1200), // ~50 req/min no máximo teórico
  SHOPEE_MAX_PER_MIN: int(20),
  SHOPEE_MAX_PER_DAY: int(1500),
  // Timeout de toda chamada HTTP externa (Shopee/OpenAI). Sem isso, uma conexão
  // pendurada trava o ciclo de captura e os jobs acumulam para disparar juntos.
  HTTP_TIMEOUT_MS: int(20000),

  // ---- Infra ----
  // Dois caminhos: DATABASE_URL pronta OU as partes soltas (recomendado).
  // Partes soltas existem porque senha com @ : / # ? % $ ou espaço QUEBRA a URI
  // (postgresql://user:s@nha@host/db não parseia). Montando no código, a senha
  // é percent-encoded e qualquer senha funciona.
  DATABASE_URL: optStr(),
  POSTGRES_HOST: str('postgres'),
  POSTGRES_PORT: int(5432),
  POSTGRES_USER: str('motor'),
  POSTGRES_PASSWORD: optStr(),
  POSTGRES_DB: str('motor'),
  REDIS_URL: str('redis://redis:6379'),

  // ---- Evolution API (WhatsApp) — já existe na VPS; aponte para ela ----
  EVOLUTION_API_URL: optUrl(),
  EVOLUTION_API_KEY: optStr(),
  WA_POSTER_INSTANCE: str('poster'),
  WA_LISTENER_INSTANCE: str('listener'),

  // URL pública do PRÓPRIO app (para configurar o webhook do listener). Ex.: https://cupom.SEU-DOMINIO
  PUBLIC_APP_URL: optUrl(),

  // ---- IA (copy) — opcional; sem chave, cai no fallback de copy original ----
  OPENAI_API_KEY: optStr(),
  OPENAI_API_ENDPOINT: url('https://api.openai.com/v1'),
  // ATENÇÃO: o id 'gpt-5.4-mini' foi a escolha do usuário mas ainda NÃO foi
  // confirmado em doc oficial — mantido configurável de propósito (ver PERGUNTAS.md).
  COPY_MODEL: str('gpt-5.4-mini'),
  MODERATION_MODEL: str('omni-moderation-latest'),

  // ---- SubIds de rastreio nos links de afiliado (até 5; a origem entra dinâmica) ----
  SUBID_CAMPAIGN: str('motor'),

  // ---- Captura (produção) ----
  // productOfferV2 sem keyword+listType:1 voltou vazio no teste; busca por keyword
  // funciona. Lista editável (ver PERGUNTAS.md).
  CAPTURE_KEYWORDS: str(
    // Tecnologia / PC
    'notebook,monitor gamer,monitor led,teclado,mouse gamer,headset gamer,fone de ouvido,ssd,memoria ram,placa de video,processador,webcam,roteador,cadeira gamer,celular,carregador,power bank,cabo usb,smartwatch,tablet,caixa de som,pendrive,cartao de memoria,impressora,' +
      // Casa / eletrodomésticos
      'geladeira,fogao,microondas,liquidificador,batedeira,cafeteira,air fryer,aspirador de po,ventilador,panela,ferro de passar,chaleira eletrica,purificador de agua,robo aspirador,' +
      // Comida / condimentos
      'maionese,ketchup,mostarda,azeite,cafe,achocolatado,chocolate,macarrao,tempero,oleo de cozinha,leite condensado',
  ),
  CAPTURE_SORT_TYPE: int(2), // 2 = mais vendidos
  // Quantas a Shopee devolve por keyword (matéria-prima do ranking).
  CAPTURE_LIMIT: int(12),
  // Quantas SOBREVIVEM por keyword depois de filtrar e ranquear. 1 = nunca
  // "30 fones iguais"; a diversidade vem de rodar keywords diferentes por ciclo.
  CAPTURE_TOP_PER_KEYWORD: int(1),
  // Teto global por ciclo. Alvo do dono: 9-10 por ciclo de ~30-45min.
  CAPTURE_MAX_PER_CYCLE: int(10),
  // Rotação: usa só um pedaço da lista de keywords por ciclo e avança na próxima.
  // 16 de 48 => cobre a lista toda em 3 ciclos (~1h30), com 16 chamadas de API
  // por ciclo em vez de 48. Funil largo (o dono quer ver "100 -> 9 aprovadas"),
  // mas sem estourar o teto diário de chamadas do freio da Shopee.
  CAPTURE_KEYWORDS_PER_CYCLE: int(16),
  // Trava de segurança: se a fila de aprovadas ainda não enviadas já passou
  // disso, o ciclo é PULADO. É o que garante que a fila nunca explode, qualquer
  // que seja a cadência (o gotejamento posta ~2-3/h; capturar mais é acumular).
  CAPTURE_BACKLOG_MAX: int(30),
  // Prova social mínima (quando a Shopee informa): produto sem venda/nota é aposta.
  CAPTURE_MIN_SALES: int(20),
  CAPTURE_MIN_RATING: num(4),
  // Quase-duplicata: mesma assinatura de título = mesmo produto com outro nome.
  // Mantém só a melhor de cada assinatura dentro do ciclo.
  CAPTURE_DEDUP_SIMILAR: bool(true),
  CAPTURE_MIN_COMMISSION: num(0), // decimal (0.05 = 5%); 0 = sem mínimo
  CAPTURE_CRON: str('*/30 * * * *'), // a cada 30 min
  // Piso de preço: desligado por padrão (0) — o nicho inclui comida/condimento,
  // que custa pouco e ainda assim é oferta boa. Use se quiser só ticket alto.
  CAPTURE_MIN_PRICE: num(0),
  // Ganho mínimo por venda (preço x comissão), em R$. É o filtro que realmente
  // separa oferta de bugiganga: no dry-run cortou bloco de notas de R$3,95
  // (R$0,32 de comissão) sem derrubar maionese de R$8 (R$0,80).
  CAPTURE_MIN_COMMISSION_BRL: num(0.5),
  // Exige que o título contenha os tokens da keyword buscada (corta "papel" em
  // busca de "notebook" e "monitor de pressão" em busca de "monitor").
  CAPTURE_REQUIRE_KEYWORD_MATCH: bool(true),
  // Acessório/bugiganga que casa com a keyword mas não é a oferta desejada
  // (ex.: "capa para notebook" quando o alvo é o notebook). Vazio desliga.
  EXCLUDED_TITLE_WORDS: str(
    'capa,pelicula,película,adesivo,chaveiro,miniatura,replica,réplica,brinde,protetor de tela',
  ),

  // ---- Filtros ----
  // Desconto >= este valor é tratado como provável erro/golpe e vai p/ revisão.
  FAKE_DISCOUNT_MAX_PCT: num(95),
  // Categorias/palavras bloqueadas (lista editável; ver PERGUNTAS.md).
  // CUIDADO com palavra solta: no dry-run "adulto" bloqueou um termômetro
  // ("para bebê e adulto") e "remédio" pegaria "porta-remédio". Por isso os
  // termos ambíguos viraram FRASES.
  BLOCKED_KEYWORDS: str(DEFAULT_BLOCKED_KEYWORDS),

  // ---- Fura-fila (defaults; também por-canal no banco) ----
  PRIORITY_MIN_DISCOUNT_PCT: num(60),
  PRIORITY_MIN_SAVINGS_BRL: num(500),
  PRIORITY_INTERRUPT_WAIT: bool(true),
  PRIORITY_MIN_GAP_SECONDS: int(180),

  // ---- Aprovação: 100% automático (true) ou fila manual (false) ----
  AUTO_APPROVE: bool(true),

  // ---- Senha do painel (OPCIONAL) ----
  // Vazio = painel aberto (escolha do dono, uso pessoal). Preencher os DOIS
  // liga HTTP Basic no painel e nas rotas /api sem mexer em código.
  DASHBOARD_USER: optStr(),
  DASHBOARD_PASSWORD: optStr(),
});

export type Config = z.infer<typeof schema>;

/**
 * URL de conexão do Postgres. Prefere DATABASE_URL; se ausente, monta a partir
 * das partes com a senha PERCENT-ENCODED — é o que permite senha com @ : / # $
 * (a senha do dono tem), que numa URI crua faria o parse falhar.
 */
export function databaseUrl(cfg: Config): string {
  if (cfg.DATABASE_URL) return cfg.DATABASE_URL;
  const user = encodeURIComponent(cfg.POSTGRES_USER);
  const pass = encodeURIComponent(cfg.POSTGRES_PASSWORD ?? '');
  return `postgresql://${user}:${pass}@${cfg.POSTGRES_HOST}:${cfg.POSTGRES_PORT}/${cfg.POSTGRES_DB}`;
}

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
  if (!parsed.data.DATABASE_URL && !parsed.data.POSTGRES_PASSWORD) {
    throw new Error(
      'Configuração inválida: defina POSTGRES_PASSWORD (recomendado) ou DATABASE_URL completa.',
    );
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
