import { loadConfig, type Config } from '../config';
import { log } from '../logger';
import { query, queryOne, tx } from '../db';
import { toNum } from '../util';

/**
 * Casamento POST-DE-GRUPO <-> OFERTA-VISTA-NA-API.
 *
 * A pergunta que este módulo responde: "este post de um grupo concorrente
 * corresponde a esta oferta que a gente viu na API às 14h02?" — e dela sai o
 * número central do projeto de inteligência de mercado: quanto tempo depois
 * de a oferta aparecer na API o concorrente postou (`lag_seconds`).
 *
 * O casamento é por SIMILARIDADE DE TÍTULO + PROXIMIDADE DE PREÇO. De
 * propósito NÃO resolvemos o link curto do concorrente para confirmar o
 * product_id: abrir esse link é um clique real no link de afiliado dele,
 * centenas de vezes por dia — não é o nosso negócio fazer isso.
 *
 * O veredito separa três respostas que num relatório parecem a mesma linha
 * vazia, e só uma é interessante: 'casado' (achamos a correspondência),
 * 'ambiguo' (candidatos demais, bons demais para desempatar sozinho) e
 * 'sem_casamento' (nada plausível). 'nao_observado' é reservado para outra
 * rotina (investigação sob demanda) — este arquivo nunca grava esse valor.
 */

// ---- similaridade de título (trigrama) ------------------------------------

const TAMANHO_TRIGRAMA = 3;

/**
 * Trigramas de UMA palavra, com o MESMO padding que o pg_trgm usa: dois
 * espaços antes, um depois — ex. "cat" -> "  cat " -> {"  c", " ca", "cat",
 * "at "}. É essa marcação de início/fim de palavra que dá peso a
 * prefixo/sufixo (é o que faz "notebook" parecer mais com "notebook lenovo"
 * do que com um texto qualquer que só por acaso compartilha um miolo).
 */
function trigramasDaPalavra(palavra: string): string[] {
  const padded = `  ${palavra} `;
  const grams: string[] = [];
  for (let i = 0; i <= padded.length - TAMANHO_TRIGRAMA; i++) {
    grams.push(padded.slice(i, i + TAMANHO_TRIGRAMA));
  }
  return grams;
}

/** Conjunto de trigramas de uma string inteira — palavra por palavra (o
 * padding é POR PALAVRA, não da frase toda; ver `trigramasDaPalavra`). */
function conjuntoDeTrigramas(s: string): Set<string> {
  const set = new Set<string>();
  for (const palavra of s.split(/\s+/).filter(Boolean)) {
    for (const g of trigramasDaPalavra(palavra)) set.add(g);
  }
  return set;
}

/**
 * Similaridade de trigrama entre duas strings JÁ NORMALIZADAS (minúsculas,
 * sem pontuação/acento — é o que `title_norm` guarda; ver `normalizeText` em
 * `util.ts`). Pura e testável: 0..1, Jaccard sobre o conjunto de trigramas.
 *
 * Implementação em memória para quando a extensão `pg_trgm` não existir no
 * Postgres (a migração tenta `CREATE EXTENSION`, mas tolera falta de
 * privilégio — ver `db/schema.sql`). Espelha a própria definição do pg_trgm
 * (padding por palavra + Jaccard) para o resultado degradado ficar o mais
 * parecido possível do que `similarity()` devolveria no SQL. Simplificação
 * assumida: não reproduz detalhes internos de i18n/collation do pg_trgm, só
 * a definição matemática documentada.
 */
export function trigramSimilarity(a: string, b: string): number {
  const setA = conjuntoDeTrigramas(a);
  const setB = conjuntoDeTrigramas(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersecao = 0;
  for (const g of setA) if (setB.has(g)) intersecao += 1;
  const uniao = setA.size + setB.size - intersecao;
  return uniao === 0 ? 0 : intersecao / uniao;
}

// ---- nota combinada (título + preço) --------------------------------------

function arredondar(v: number, casas: number): number {
  const f = 10 ** casas;
  return Math.round(v * f) / f;
}

// Bônus/penalidade máximos de preço. Números fixos, documentados aqui para
// quem for ajustar: a curva é CONTÍNUA na fronteira da tolerância (o bônus
// chega a 0 exatamente onde a penalidade começa a subir de 0) — não há
// degrau ali. A penalidade satura em 2x a tolerância (100% de estouro).
const BONUS_PRECO_MAX = 0.25;
const PENALIDADE_PRECO_MAX = 0.3;

/**
 * Nota combinada de UM candidato a casamento. Pura e testável.
 *
 * - Base = `titleSim`.
 * - Preço DENTRO da tolerância BONIFICA, proporcional à proximidade (quanto
 *   mais perto, maior o bônus, até +0.25) — preço batendo é confirmação
 *   forte de que é o mesmo produto.
 * - Preço FORA da tolerância PENALIZA (até -0.30) — preço muito diferente é
 *   forte indício de produto DIFERENTE (ex.: post é do kit com 3 unidades,
 *   observação é da unidade avulsa).
 * - Falta preço de UM dos lados -> não bonifica nem penaliza (`priceDeltaPct`
 *   fica `null`): ausência de dado não é evidência de nada.
 */
export function scoreCandidato(params: {
  titleSim: number;
  postPrice: number | null;
  obsPrice: number | null;
  tolerancia: number;
}): { confidence: number; priceDeltaPct: number | null } {
  const { titleSim, postPrice, obsPrice, tolerancia } = params;
  let confidence = titleSim;
  let priceDeltaPct: number | null = null;

  if (postPrice != null && obsPrice != null && obsPrice > 0) {
    const deltaRel = Math.abs(postPrice - obsPrice) / obsPrice;
    priceDeltaPct = arredondar(deltaRel * 100, 2);

    if (tolerancia > 0) {
      if (deltaRel <= tolerancia) {
        // 1 no delta zero, 0 no limite da tolerância: taper linear.
        confidence += BONUS_PRECO_MAX * (1 - deltaRel / tolerancia);
      } else {
        // cresce a partir de 0 na fronteira da tolerância, satura em 2x.
        const excesso = (deltaRel - tolerancia) / tolerancia;
        confidence -= Math.min(PENALIDADE_PRECO_MAX, PENALIDADE_PRECO_MAX * excesso);
      }
    } else {
      // tolerância zero/negativa (config incomum): só preço EXATO bonifica.
      confidence += deltaRel === 0 ? BONUS_PRECO_MAX : -PENALIDADE_PRECO_MAX;
    }
  }

  confidence = arredondar(Math.max(0, Math.min(1, confidence)), 3);
  return { confidence, priceDeltaPct };
}

// ---- disponibilidade da extensão pg_trgm ----------------------------------

// Cacheado em memória: a resposta não muda em runtime (a extensão só é
// criada — ou não — na migração, no boot do processo) e checar de novo a
// cada post custaria uma query extra por item em `matchPendingPosts`.
let cacheTrgmDisponivel: boolean | null = null;

/** A extensão pg_trgm existe neste banco? (a migração tenta criar, mas
 * tolera falta de privilégio — ver `db/schema.sql`). */
export async function pgTrgmDisponivel(): Promise<boolean> {
  if (cacheTrgmDisponivel !== null) return cacheTrgmDisponivel;
  const row = await queryOne<{ disponivel: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS disponivel`,
  );
  cacheTrgmDisponivel = row?.disponivel ?? false;
  return cacheTrgmDisponivel;
}

// ---- tipos públicos ---------------------------------------------------------

export type Verdict =
  | 'casado'
  | 'ambiguo'
  | 'sem_casamento'
  | 'nao_observado'
  /** post de outra loja (Amazon, Mercado Livre): não há o que casar na Shopee */
  | 'outra_plataforma';

export interface MatchResult {
  postId: string;
  verdict: Verdict;
  observationId: string | null;
  productId: string | null;
  confidence: number;
  titleSim: number | null;
  priceDeltaPct: number | null;
  lagSeconds: number | null;
  firstSeenAt: string | null;
}

// ---- casamento de um post ----------------------------------------------------

/** Método gravado em `intel_matches.method` — este arquivo só produz estes
 * dois (os outros dois valores do CHECK, 'product_id'/'manual', são de
 * outros fluxos, não deste matcher). */
type MetodoCasamento = 'title_price' | 'title';

interface PostRow {
  id: string;
  // O driver `pg` devolve TIMESTAMPTZ como objeto Date; tipamos como string
  // aqui só para bater com a convenção do resto do projeto (ChannelRow /
  // OfferRow em types.ts) — `new Date(...)` aceita os dois, então isso não
  // muda nada em runtime, só o tipo declarado.
  posted_at: string;
  title_norm: string | null;
  price: string | null; // NUMERIC -> string no driver
  /** 'shopee' | 'amazon' | 'mercadolivre' | … | null (post sem link) */
  platform_guess: string | null;
}

interface CandidatoAvaliado {
  observationId: string;
  productId: string;
  titleSim: number;
  price: number | null;
  confidence: number;
  priceDeltaPct: number | null;
}

// Quantos candidatos entram na pontuação combinada no caminho COM pg_trgm —
// número do enunciado, não configurável.
const LIMITE_CANDIDATOS_TRGM = 25;
// Teto do caminho degradado (sem pg_trgm): sem índice de trigrama não dá
// para filtrar por similaridade no SQL, então trazemos um lote da janela por
// recência e filtramos/pontuamos em memória (ver buscarCandidatos). 500 é
// amostra, não universo, numa janela com bastante observação — é o melhor
// possível sem a extensão.
const LIMITE_CANDIDATOS_DEGRADADO = 500;

/**
 * Busca observações candidatas na janela [posted_at - INTEL_MATCH_WINDOW_HOURS,
 * posted_at] e já devolve cada uma com a nota combinada (`scoreCandidato`),
 * ordenadas por confiança desc. Só observações ANTERIORES OU IGUAIS ao post:
 * a pergunta é "eles postaram depois de a oferta existir?" — uma observação
 * POSTERIOR ao post não responde isso (não pode ter causado o post).
 *
 * Os dois caminhos abaixo (com/sem pg_trgm) são DELIBERADAMENTE equivalentes:
 * os dois só avaliam candidato com `titleSim >= INTEL_MATCH_MIN_SIM` — título
 * é o sinal primário, preço é confirmação, não resgate. Sem essa simetria, o
 * MESMO post poderia dar veredito diferente só por acaso de o banco ter (ou
 * não) a extensão instalada — exatamente o tipo de inconsistência que só
 * aparece quando uma conclusão do relatório já saiu errada.
 *
 * Plataforma fixada em 'shopee': é a única que `api_observations` recebe
 * hoje (a varredura de inteligência só cobre a Shopee — ver INTEL_SWEEP_CRON
 * em config.ts) e nem `intel_matches` nem `MatchResult` têm coluna de
 * plataforma para carregar adiante. Se um dia existir 2ª plataforma na
 * varredura, isto precisa virar parâmetro.
 */
async function buscarCandidatos(post: PostRow, cfg: Config): Promise<CandidatoAvaliado[]> {
  const janelaHoras = String(cfg.INTEL_MATCH_WINDOW_HOURS);
  const tolerancia = cfg.INTEL_MATCH_PRICE_TOLERANCE;
  const minSim = cfg.INTEL_MATCH_MIN_SIM;
  const postPrice = toNum(post.price);
  const titleNorm = post.title_norm ?? ''; // já validado não-vazio pelo chamador

  const pontuar = (titleSim: number, obsPrice: number | null) =>
    scoreCandidato({ titleSim, postPrice, obsPrice, tolerancia });

  if (await pgTrgmDisponivel()) {
    // similarity() é a MESMA função do pg_trgm — não precisamos de
    // `SET LOCAL pg_trgm.similarity_threshold` porque não usamos o operador
    // `%` (que É o que lê aquele GUC), e sim a função diretamente no WHERE.
    // Contrapartida honesta: nesta forma a consulta não necessariamente usa
    // o índice GIN para o filtro de similaridade (o índice acelera sobretudo
    // o operador `%`); quem faz o corte grosso aqui são os índices de
    // tempo/produto no WHERE (idx_api_obs_time/idx_api_obs_product) — troca
    // aceitável no volume atual (a varredura gera algumas centenas de
    // observações por dia, ver comentário de INTEL_SWEEP_CRON em config.ts).
    const rows = await query<{ id: string; product_id: string; price: string | null; sim: number }>(
      `SELECT id, product_id, price, sim
         FROM (
           SELECT DISTINCT ON (product_id)
                  id, product_id, price, similarity(title_norm, $1) AS sim
             FROM api_observations
            WHERE platform = 'shopee'
              AND observed_at >= $2::timestamptz - ($3 || ' hours')::interval
              AND observed_at <= $2::timestamptz + ($3 || ' hours')::interval
              AND similarity(title_norm, $1) >= $4
            ORDER BY product_id,
                     (observed_at <= $2::timestamptz) DESC,
                     observed_at DESC
         ) d
        ORDER BY sim DESC
        LIMIT ${LIMITE_CANDIDATOS_TRGM}`,
      [titleNorm, post.posted_at, janelaHoras, minSim],
    );
    return rows
      .map((r) => {
        const titleSim = arredondar(toNum(r.sim) ?? 0, 3);
        const obsPrice = toNum(r.price);
        return {
          observationId: r.id,
          productId: r.product_id,
          titleSim,
          price: obsPrice,
          ...pontuar(titleSim, obsPrice),
        };
      })
      .sort((x, y) => y.confidence - x.confidence);
  }

  // Caminho degradado: sem índice de trigrama não dá para filtrar por
  // similaridade no SQL, então trazemos o lote inteiro da janela por
  // recência e filtramos por título EM MEMÓRIA logo abaixo, com o MESMO
  // `minSim` que o WHERE usa no caminho com pg_trgm (ver docstring acima:
  // os dois caminhos são de propósito equivalentes).
  const rows = await query<{ id: string; product_id: string; title_norm: string; price: string | null }>(
    `SELECT DISTINCT ON (product_id) id, product_id, title_norm, price
       FROM api_observations
      WHERE platform = 'shopee'
        AND observed_at >= $1::timestamptz - ($2 || ' hours')::interval
        AND observed_at <= $1::timestamptz + ($2 || ' hours')::interval
      ORDER BY product_id,
               (observed_at <= $1::timestamptz) DESC,
               observed_at DESC
      LIMIT ${LIMITE_CANDIDATOS_DEGRADADO}`,
    [post.posted_at, janelaHoras],
  );
  const candidatos: CandidatoAvaliado[] = [];
  for (const r of rows) {
    const titleSim = arredondar(trigramSimilarity(titleNorm, r.title_norm), 3);
    // Mesmo corte do WHERE `similarity(...) >= $4` do caminho com pg_trgm:
    // título abaixo do limiar nem chega a ser pontuado com preço — preço não
    // resgata título fraco em NENHUM dos dois caminhos.
    if (titleSim < minSim) continue;
    const obsPrice = toNum(r.price);
    candidatos.push({
      observationId: r.id,
      productId: r.product_id,
      titleSim,
      price: obsPrice,
      ...pontuar(titleSim, obsPrice),
    });
  }
  return candidatos.sort((x, y) => y.confidence - x.confidence);
}

/**
 * Primeira observação DAQUELE product_id (não a que casou) e a defasagem até
 * o post. SEM limite de janela aqui de propósito: é a 1ª vez que já vimos o
 * produto, mesmo que tenha sido antes da janela de busca de candidatos.
 * Negativo é informação válida (eles postaram ANTES da nossa 1ª observação
 * do produto) — nunca truncar para zero.
 */
async function primeiraObservacaoEDefasagem(
  productId: string,
  postedAt: string,
): Promise<{ firstSeenAt: string | null; lagSeconds: number | null }> {
  const row = await queryOne<{ first_seen_at: string | null; lag_seconds: string | null }>(
    `SELECT min(observed_at) AS first_seen_at,
            EXTRACT(EPOCH FROM ($1::timestamptz - min(observed_at)))::bigint AS lag_seconds
       FROM api_observations
      WHERE platform = 'shopee' AND product_id = $2`,
    [postedAt, productId],
  );
  const firstSeenAt = row?.first_seen_at ?? null;
  return {
    firstSeenAt: firstSeenAt ? new Date(firstSeenAt).toISOString() : null,
    lagSeconds: toNum(row?.lag_seconds),
  };
}

interface GravarParams {
  postId: string;
  observationId: string | null;
  productId: string | null;
  method: MetodoCasamento;
  confidence: number;
  titleSim: number | null;
  priceDeltaPct: number | null;
  lagSeconds: number | null;
  firstSeenAt: string | null;
  verdict: Verdict;
}

/**
 * Grava/atualiza `intel_matches` (idempotente por post_id — rematchar um
 * post é o caso NORMAL, não a exceção: limiares mudam, o dono clica
 * "recorrelacionar") e marca o post como processado. As duas escritas viajam
 * juntas numa transação: sem isso, uma queda do processo entre elas deixaria
 * o match gravado mas o post ainda elegível em `matched_at IS NULL`, e o
 * próximo lote regravaria o mesmo match de novo — inofensivo, mas a
 * transação evita até esse desperdício.
 *
 * `confirmed` (conferência humana) é zerado quando o `observation_id` muda
 * (ver CASE no UPDATE) — a confirmação vale para o PAR post+observação, não
 * para o post isolado. Se o par mudou, ninguém conferiu o par novo, e um
 * "confirmado" errado é pior que um não confirmado: ninguém volta a olhar.
 */
async function gravarMatch(p: GravarParams): Promise<void> {
  await tx(async (c) => {
    await c.query(
      `INSERT INTO intel_matches
         (post_id, observation_id, product_id, method, confidence, title_sim,
          price_delta_pct, lag_seconds, first_seen_at, verdict)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (post_id) DO UPDATE SET
         observation_id  = EXCLUDED.observation_id,
         product_id      = EXCLUDED.product_id,
         method          = EXCLUDED.method,
         confidence      = EXCLUDED.confidence,
         title_sim       = EXCLUDED.title_sim,
         price_delta_pct = EXCLUDED.price_delta_pct,
         lag_seconds     = EXCLUDED.lag_seconds,
         first_seen_at   = EXCLUDED.first_seen_at,
         verdict         = EXCLUDED.verdict,
         -- IS DISTINCT FROM (não <>) de propósito: <> com um lado NULL
         -- devolve NULL, e o CASE trata condição NULL como "não bateu" —
         -- cairia no ELSE bem quando o par se perde (observação antiga ->
         -- NULL, ou NULL -> observação nova), que é justo quando MAIS
         -- precisamos zerar. IS DISTINCT FROM compara NULL como valor e não
         -- erra nesse caso.
         confirmed       = CASE
                              WHEN intel_matches.observation_id
                                   IS DISTINCT FROM EXCLUDED.observation_id
                                THEN NULL
                              ELSE intel_matches.confirmed
                            END`,
      [
        p.postId, p.observationId, p.productId, p.method, p.confidence, p.titleSim,
        p.priceDeltaPct, p.lagSeconds, p.firstSeenAt, p.verdict,
      ],
    );
    await c.query(`UPDATE intel_posts SET matched_at = now() WHERE id = $1`, [p.postId]);
  });
}

function paraMatchResult(p: GravarParams): MatchResult {
  return {
    postId: p.postId,
    verdict: p.verdict,
    observationId: p.observationId,
    productId: p.productId,
    confidence: p.confidence,
    titleSim: p.titleSim,
    priceDeltaPct: p.priceDeltaPct,
    lagSeconds: p.lagSeconds,
    firstSeenAt: p.firstSeenAt,
  };
}

// Piso de ruído para preservar um "quase acerto" em sem_casamento (ver
// semCasamento). Medido ao vivo contra Postgres real: comparando a
// referência "Air Fryer Mondial 5L Family Inox" contra "Air Fryer Philips
// Walita 4L Digital" — mesma categoria, MARCA DIFERENTE, o falso-positivo
// mais perigoso que existe nesse domínio — a similaridade de título saiu
// 0.196. Abaixo disso não é "quase bateu", é coincidência de palavras
// comuns ("air fryer" aparece nos dois títulos por acaso de categoria, não
// porque é o mesmo produto).
const PISO_QUASE_ACERTO = 0.2;

/**
 * sem_casamento tem duas formas:
 * - SEM candidato nenhum (sem título, ou nenhuma observação plausível na
 *   janela): tudo nulo, confidence=0 — não há nada para mostrar.
 * - COM um candidato que chegou perto mas não bateu `INTEL_MATCH_MIN_SIM`:
 *   preserva observation_id/product_id/title_sim/confidence DELE. Isso é DE
 *   PROPÓSITO: sem isso, "quase bateu a 0.28" e "não existe nada parecido"
 *   viram a MESMA linha vazia no relatório — e são conclusões opostas (a
 *   1ª diz "o limiar pode estar apertado demais"; a 2ª diz "eles têm outra
 *   fonte"). Calibrar às cegas, sem ver o quase-acerto, é pior do que
 *   calibrar vendo a evidência.
 *
 * ATENÇÃO pra quem consome: `observation_id` presente aqui NÃO é casamento
 * — o veredito continua 'sem_casamento'. Olhe SEMPRE o veredito, nunca só a
 * presença do id.
 *
 * Só preserva se o candidato passar de `PISO_QUASE_ACERTO` — abaixo disso é
 * ruído (título parecido só por coincidência de palavras comuns), não
 * "quase lá", e preservar traria lixo. O piso é sobre `titleSim` (a mesma
 * medida usada para calibrar o número), não sobre `confidence`: preço pode
 * inflar confidence por coincidência (mesmo preço, produto diferente), e
 * título é o sinal primário deste matcher — não é o preço que decide se um
 * quase-acerto é digno de nota.
 */
async function semCasamento(postId: string, candidato?: CandidatoAvaliado): Promise<MatchResult> {
  const quaseAcerto =
    candidato && candidato.titleSim >= PISO_QUASE_ACERTO ? candidato : undefined;
  const p: GravarParams = {
    postId,
    observationId: quaseAcerto?.observationId ?? null,
    productId: quaseAcerto?.productId ?? null,
    method: 'title',
    confidence: quaseAcerto?.confidence ?? 0,
    titleSim: quaseAcerto?.titleSim ?? null,
    priceDeltaPct: null,
    lagSeconds: null,
    firstSeenAt: null,
    verdict: 'sem_casamento',
  };
  await gravarMatch(p);
  return paraMatchResult(p);
}

/** Post de outra loja: veredito próprio, sem consultar candidato nenhum. */
async function foraDaPlataforma(postId: string): Promise<MatchResult> {
  const p: GravarParams = {
    postId,
    observationId: null,
    productId: null,
    method: 'title',
    confidence: 0,
    titleSim: null,
    priceDeltaPct: null,
    lagSeconds: null,
    firstSeenAt: null,
    verdict: 'outra_plataforma',
  };
  await gravarMatch(p);
  return paraMatchResult(p);
}

/**
 * Casa UM post com a oferta correspondente vista na API (se houver).
 * Idempotente: chamar de novo (limiares mudaram, por exemplo) ATUALIZA a
 * linha em `intel_matches` em vez de falhar.
 */
export async function matchOnePost(postId: string): Promise<MatchResult> {
  const cfg = loadConfig();
  const post = await queryOne<PostRow>(
    `SELECT id, posted_at, title_norm, price, platform_guess FROM intel_posts WHERE id = $1`,
    [postId],
  );
  if (!post) throw new Error(`intel_posts: post ${postId} não encontrado`);

  /*
   * CURTO-CIRCUITO POR PLATAFORMA — antes de qualquer busca.
   *
   * Nosso cardápio (`api_observations`) é 100% Shopee. Um post de Amazon ou
   * Mercado Livre não tem correspondente possível ali, e gastar a consulta de
   * trigrama nele é desperdício. Pior que o desperdício: marcá-lo
   * `sem_casamento` faz o painel afirmar "a varredura não achou", quando a
   * verdade é "não havia o que achar". Medido em grupo real: 10 de 17 posts
   * eram Amazon e 7 Mercado Livre — o veredito errado teria sido 100% dos posts.
   *
   * `platform_guess` nulo (post sem link) segue o fluxo normal: sem evidência
   * de que é de outra loja, tentamos casar.
   */
  if (post.platform_guess && post.platform_guess !== 'shopee') {
    return foraDaPlataforma(post.id);
  }

  // Sem título não dá para comparar nada — nem tenta buscar candidato.
  if (!post.title_norm || !post.title_norm.trim()) {
    return semCasamento(post.id);
  }

  const avaliados = await buscarCandidatos(post, cfg);
  const melhor = avaliados[0];
  if (!melhor || melhor.confidence < cfg.INTEL_MATCH_MIN_SIM) {
    // `melhor` pode não existir (nenhuma observação plausível na janela) ou
    // existir mas não bater o limiar — semCasamento decide sozinho se o
    // quase-acerto passa do piso de ruído e vale preservar.
    return semCasamento(post.id, melhor);
  }

  // Explicitamente o melhor de OUTRO produto. Depois do DISTINCT ON isso já
  // seria `avaliados[1]`, mas deixar implícito é o tipo de acoplamento que
  // volta a quebrar quando alguém mexer na consulta.
  const segundo = avaliados.find((c) => c.productId !== melhor.productId);
  // Ambíguo só quando o 2º melhor é de OUTRO produto: dois candidatos bons
  // do MESMO product_id (a mesma oferta vista em duas varreduras) não é
  // ambiguidade nenhuma, é o mesmo produto observado duas vezes.
  const ambiguo =
    segundo != null &&
    segundo.productId !== melhor.productId &&
    melhor.confidence - segundo.confidence < cfg.INTEL_MATCH_AMBIGUITY_MARGIN;

  const postPrice = toNum(post.price);
  const { firstSeenAt, lagSeconds } = await primeiraObservacaoEDefasagem(
    melhor.productId,
    post.posted_at,
  );

  const p: GravarParams = {
    postId: post.id,
    observationId: melhor.observationId,
    productId: melhor.productId,
    method: postPrice != null && melhor.price != null ? 'title_price' : 'title',
    confidence: melhor.confidence,
    titleSim: melhor.titleSim,
    priceDeltaPct: melhor.priceDeltaPct,
    lagSeconds,
    firstSeenAt,
    // "grave o melhor como observation_id mesmo assim, para o humano poder
    // conferir" — ambíguo e casado gravam os MESMOS campos; só o veredito muda.
    verdict: ambiguo ? 'ambiguo' : 'casado',
  };
  await gravarMatch(p);
  return paraMatchResult(p);
}

/**
 * Casa em lote os posts ainda não processados (`matched_at IS NULL`).
 * Sequencial DE PROPÓSITO: cada `matchOnePost` é uma consulta pesada de
 * trigrama (no caminho degradado, chega a varrer 500 linhas por post);
 * `Promise.all` aqui multiplicaria a carga no Postgres em vez de espalhar no
 * tempo. Erro em UM post não derruba o lote inteiro (try/catch por item).
 */
export async function matchPendingPosts(
  limit = 200,
  incluirSemCasamento = false,
): Promise<{
  processed: number;
  casado: number;
  ambiguo: number;
  sem_casamento: number;
}> {
  const cfg = loadConfig();
  /*
   * `incluirSemCasamento` conserta um viés que distorcia o número principal do
   * produto.
   *
   * O matcher roda a cada 5 minutos; a varredura da API, a cada 2 horas. Um
   * post sobre oferta FRESCA chegava, não encontrava observação nenhuma (ela
   * ainda não tinha sido varrida), era carimbado `sem_casamento` e NUNCA mais
   * reavaliado — mesmo que 40 minutos depois a varredura observasse exatamente
   * aquele produto.
   *
   * O efeito não era só perder casamentos: sobreviviam na mediana quase só os
   * posts sobre produto ANTIGO, que já estava no cardápio. Ou seja, "atraso
   * mediano" media a NOSSA cadência de varredura, não o comportamento deles.
   *
   * Com a flag ligada (o worker liga logo após cada varredura, quando existe
   * evidência nova), os `sem_casamento` ainda dentro da janela de correlação
   * voltam para a fila. Fora da janela não adianta reavaliar: nenhuma
   * observação nova pode mais alcançá-los.
   */
  const pendentes = incluirSemCasamento
    ? await query<{ id: string }>(
        `SELECT p.id
           FROM intel_posts p
           LEFT JOIN intel_matches m ON m.post_id = p.id
          WHERE p.matched_at IS NULL
             OR (m.verdict = 'sem_casamento'
                 AND p.posted_at > now() - ($2 || ' hours')::interval)
          ORDER BY p.posted_at ASC
          LIMIT $1`,
        [limit, String(cfg.INTEL_MATCH_WINDOW_HOURS)],
      )
    : await query<{ id: string }>(
        `SELECT id FROM intel_posts WHERE matched_at IS NULL ORDER BY posted_at ASC LIMIT $1`,
        [limit],
      );

  const resultado = { processed: 0, casado: 0, ambiguo: 0, sem_casamento: 0 };
  for (const { id } of pendentes) {
    try {
      const r = await matchOnePost(id);
      resultado.processed += 1;
      switch (r.verdict) {
        case 'casado':
          resultado.casado += 1;
          break;
        case 'ambiguo':
          resultado.ambiguo += 1;
          break;
        case 'sem_casamento':
          resultado.sem_casamento += 1;
          break;
        case 'outra_plataforma':
          // Post de outra loja: não entra em nenhum dos contadores de
          // casamento, porque não houve tentativa de casar.
          break;
        case 'nao_observado':
          // matchOnePost nunca produz este veredito (é preenchido por outra
          // rotina, sob demanda). Se aparecer aqui é bug em outro lugar;
          // conta como sem_casamento para não sumir com o post da soma.
          resultado.sem_casamento += 1;
          break;
      }
    } catch (err) {
      log.error('correlação falhou para um post — seguindo para o próximo', {
        postId: id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('correlação em lote concluída', { ...resultado, pendentes: pendentes.length, limit });
  return resultado;
}
