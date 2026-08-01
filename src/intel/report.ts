import { query } from '../db';
import { toNum } from '../util';

/**
 * Agregações de inteligência de mercado — alimentam o dashboard de correlação.
 * As três tabelas de base (ver `db/schema.sql`, seção "INTELIGÊNCIA DE
 * MERCADO"):
 *   api_observations = o CARDÁPIO (tudo que a Shopee ofereceu, sem filtro)
 *   intel_posts      = o PRATO ESCOLHIDO (o que os grupos concorrentes postaram)
 *   intel_matches    = a LIGAÇÃO entre os dois, com veredito e atraso (lag)
 *
 * A pergunta que este arquivo responde (do dono, ver PERGUNTAS/CLAUDE.md):
 * "ontem, comparando tudo que a API ofereceu com o que eles postaram, qual foi
 * o atraso? eles postam no mesmo dia ou no dia seguinte? repetem os mesmos
 * produtos (lista fixa) ou escolhem fresco?" — cada função abaixo cobre um
 * pedaço dessa pergunta.
 *
 * REGRA CRÍTICA (pg): colunas NUMERIC e BIGINT voltam como STRING do driver.
 * Nenhuma função aqui devolve isso cru — tudo passa por `toNum` antes do
 * `return`, para o front nunca precisar saber que o Postgres fez isso.
 */

/**
 * Fuso do dono (Brasil, sem horário de verão desde 2019 — não há ambiguidade
 * de "hora que se repete"). Toda agregação por DIA ou por HORA usa isto: sem
 * isso, a virada do dia em UTC acontece às 21h de Brasília e "ontem" no
 * dashboard ficaria sistematicamente errado por até 3h. É uma constante
 * interna do sistema (nunca vem de fora), por isso entra direto no texto do
 * SQL — não há valor de usuário para escapar aqui, ao contrário de `dia`,
 * `verdict`, `groupId` etc., que são SEMPRE parametrizados com $n abaixo.
 */
const TZ = 'America/Sao_Paulo';

// ---------------------------------------------------------------------------
// Helpers de mapeamento (linha do pg -> objeto que o front consome)
// ---------------------------------------------------------------------------

/** timestamptz/timestamp do pg vira `Date` nativo (sem parser customizado
 * configurado em `db.ts`) — nunca deixamos um `Date` vazar no retorno, já que
 * todo campo de data das interfaces públicas é `string` (ISO-8601). */
function iso(v: Date): string {
  return v.toISOString();
}
function isoOrNull(v: Date | null): string | null {
  return v === null ? null : iso(v);
}

/** `toNum` devolve `number | null`; para contagens (que nunca são negativas
 * nem ausentes de verdade — um dia sem posts é 0 posts, não "sem dado") o
 * `null` viraria ruído no front. Aqui o 0 é sempre honesto (COALESCE já
 * garante isso na consulta). */
function toNumOrZero(v: unknown): number {
  return toNum(v) ?? 0;
}

/** Percentual arredondado a 1 casa; `null` (não `NaN`/`Infinity`) quando não
 * dá para dividir — evita o front ter que blindar contra número inválido. */
function percentual(numerador: number, denominador: number): number | null {
  if (denominador <= 0) return null;
  return Math.round((numerador / denominador) * 1000) / 10;
}

/** Clampa parâmetro numérico opcional vindo do chamador (rota HTTP ou
 * chamada direta) — mesmas faixas usadas em `api.ts` para os mesmos
 * parâmetros, para uma chamada direta a esta função (fora da rota) se
 * comportar igual a uma chamada vinda do dashboard. */
function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  const n = v === undefined ? def : Math.trunc(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

// ---------------------------------------------------------------------------
// 1) resumoDiario
// ---------------------------------------------------------------------------

export interface ResumoDia {
  dia: string; // 'YYYY-MM-DD'
  observadas: number; // ofertas distintas observadas na API naquele dia
  posts: number; // posts capturados dos grupos naquele dia
  casados: number;
  ambiguos: number;
  semCasamento: number;
  taxaAproveitamento: number | null; // casados / observadas, em % (0..100)
  atrasoMedianoSeg: number | null; // mediana de lag_seconds dos casados
  atrasoP25Seg: number | null;
  atrasoP75Seg: number | null;
  postadosNoDiaSeguinte: number; // casados cujo post caiu em dia posterior ao first_seen
  wouldPassCasados: number; // dos casados, quantos NOSSO filtro teria aprovado
}

interface ResumoDiaRow {
  dia: string;
  observadas: string;
  posts: string;
  casados: string;
  ambiguos: string;
  sem_casamento: string;
  atraso_mediano: string | null;
  atraso_p25: string | null;
  atraso_p75: string | null;
  postados_dia_seguinte: string;
  would_pass_casados: string;
}

/**
 * Um dia = uma linha, sempre — mesmo sem nenhum movimento (0 posts é
 * informação: mostra que o concorrente não postou nada, não que faltou dado).
 * Por isso a série de dias vem de `generate_series` e as tabelas de fato
 * entram via LEFT JOIN, nunca o contrário.
 *
 * DESVIO DELIBERADO do padrão `now() - ($1 || ' days')::interval` usado nas
 * outras funções deste arquivo: aqui os limites vêm de datas de calendário
 * (`hoje`, `hoje - (dias-1)`) calculadas UMA vez em `bounds`, não de um
 * instante corrido. Motivo: `now() - N dias` é um instante (ex.: "18/jul
 * 15:00"), e truncar isso pro dia daria ora N, ora N+1 dias de calendário
 * dependendo da hora em que a consulta roda — o contrato "default 14" deixaria
 * de ser exato. Com `bounds`, o resultado é SEMPRE exatamente `dias` linhas,
 * e o filtro de cada CTE usa a MESMA data de corte da série (nunca sobra
 * linha fora da série nem falta linha dentro dela).
 */
export async function resumoDiario(dias?: number): Promise<ResumoDia[]> {
  const d = clampInt(dias, 14, 1, 365);

  const rows = await query<ResumoDiaRow>(
    `WITH bounds AS (
       SELECT (now() AT TIME ZONE '${TZ}')::date AS hoje,
              (now() AT TIME ZONE '${TZ}')::date - ($1::int - 1) AS inicio
     ),
     dias_serie AS (
       SELECT generate_series(b.inicio, b.hoje, interval '1 day')::date AS dia
         FROM bounds b
     ),
     -- observadas = DISTINCT product_id: o mesmo produto aparece em várias
     -- varreduras do dia (a cada ~2h); contar sem DISTINCT infla o cardápio.
     obs_por_dia AS (
       SELECT (ao.observed_at AT TIME ZONE '${TZ}')::date AS dia,
              count(DISTINCT ao.product_id) AS observadas
         FROM api_observations ao
         CROSS JOIN bounds b
        WHERE (ao.observed_at AT TIME ZONE '${TZ}')::date >= b.inicio
        GROUP BY dia
     ),
     posts_por_dia AS (
       SELECT (ip.posted_at AT TIME ZONE '${TZ}')::date AS dia,
              count(*) AS posts
         FROM intel_posts ip
         CROSS JOIN bounds b
        WHERE (ip.posted_at AT TIME ZONE '${TZ}')::date >= b.inicio
        GROUP BY dia
     ),
     -- Agrupado pelo dia do POST (não da observação/match) — é o eixo que o
     -- dono pensa quando pergunta "o que eles postaram aquele dia".
     matches_por_dia AS (
       SELECT (ip.posted_at AT TIME ZONE '${TZ}')::date AS dia,
              count(*) FILTER (WHERE m.verdict = 'casado')        AS casados,
              count(*) FILTER (WHERE m.verdict = 'ambiguo')       AS ambiguos,
              count(*) FILTER (WHERE m.verdict = 'sem_casamento') AS sem_casamento,
              (percentile_cont(0.5) WITHIN GROUP (ORDER BY m.lag_seconds)
                FILTER (WHERE m.verdict = 'casado' AND m.lag_seconds IS NOT NULL))::text AS atraso_mediano,
              (percentile_cont(0.25) WITHIN GROUP (ORDER BY m.lag_seconds)
                FILTER (WHERE m.verdict = 'casado' AND m.lag_seconds IS NOT NULL))::text AS atraso_p25,
              (percentile_cont(0.75) WITHIN GROUP (ORDER BY m.lag_seconds)
                FILTER (WHERE m.verdict = 'casado' AND m.lag_seconds IS NOT NULL))::text AS atraso_p75,
              -- dia do post (fuso do dono) veio DEPOIS do dia da 1ª observação (fuso do dono)
              count(*) FILTER (
                WHERE m.verdict = 'casado'
                  AND m.first_seen_at IS NOT NULL
                  AND (ip.posted_at AT TIME ZONE '${TZ}')::date >
                      (m.first_seen_at AT TIME ZONE '${TZ}')::date
              ) AS postados_dia_seguinte,
              count(*) FILTER (WHERE m.verdict = 'casado' AND ao.would_pass = true) AS would_pass_casados
         FROM intel_matches m
         JOIN intel_posts ip ON ip.id = m.post_id
         LEFT JOIN api_observations ao ON ao.id = m.observation_id
         CROSS JOIN bounds b
        WHERE (ip.posted_at AT TIME ZONE '${TZ}')::date >= b.inicio
        GROUP BY dia
     )
     SELECT d.dia::text AS dia,
            coalesce(ob.observadas, 0)             AS observadas,
            coalesce(mp.posts, 0)                  AS posts,
            coalesce(mt.casados, 0)                AS casados,
            coalesce(mt.ambiguos, 0)               AS ambiguos,
            coalesce(mt.sem_casamento, 0)          AS sem_casamento,
            mt.atraso_mediano,
            mt.atraso_p25,
            mt.atraso_p75,
            coalesce(mt.postados_dia_seguinte, 0)  AS postados_dia_seguinte,
            coalesce(mt.would_pass_casados, 0)     AS would_pass_casados
       FROM dias_serie d
       LEFT JOIN obs_por_dia     ob ON ob.dia = d.dia
       LEFT JOIN posts_por_dia   mp ON mp.dia = d.dia
       LEFT JOIN matches_por_dia mt ON mt.dia = d.dia
      ORDER BY d.dia DESC`,
    [String(d)],
  );

  return rows.map((row) => {
    const observadas = toNumOrZero(row.observadas);
    const casados = toNumOrZero(row.casados);
    return {
      dia: row.dia,
      observadas,
      posts: toNumOrZero(row.posts),
      casados,
      ambiguos: toNumOrZero(row.ambiguos),
      semCasamento: toNumOrZero(row.sem_casamento),
      taxaAproveitamento: percentual(casados, observadas),
      atrasoMedianoSeg: toNum(row.atraso_mediano),
      atrasoP25Seg: toNum(row.atraso_p25),
      atrasoP75Seg: toNum(row.atraso_p75),
      postadosNoDiaSeguinte: toNumOrZero(row.postados_dia_seguinte),
      wouldPassCasados: toNumOrZero(row.would_pass_casados),
    };
  });
}

// ---------------------------------------------------------------------------
// 2) correlacaoDoDia
// ---------------------------------------------------------------------------

export interface LinhaCorrelacao {
  postId: string;
  groupName: string | null;
  groupKind: string;
  postedAt: string;
  titleGuess: string | null;
  postPrice: number | null;
  verdict: string;
  confidence: number | null;
  titleSim: number | null;
  productId: string | null;
  obsTitle: string | null;
  obsPrice: number | null;
  firstSeenAt: string | null;
  lagSeconds: number | null;
  wouldPass: boolean | null;
  rejectReason: string | null;
  commissionBrl: number | null;
  sales: number | null;
  ratingStar: number | null;
}

interface LinhaCorrelacaoRow {
  post_id: string;
  group_name: string | null;
  group_kind: string;
  posted_at: Date;
  title_guess: string | null;
  post_price: string | null;
  verdict: string;
  confidence: string | null;
  title_sim: string | null;
  product_id: string | null;
  obs_title: string | null;
  obs_price: string | null;
  first_seen_at: Date | null;
  lag_seconds: string | null;
  would_pass: boolean | null;
  reject_reason: string | null;
  commission_brl: string | null;
  sales: number | null;
  rating_star: string | null;
}

const DIA_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Linha a linha do dia: o que eles postaram e o que a API tinha.
 *
 * `verdict` na saída pode ser 'pendente' — um valor SINTÉTICO que não existe
 * no CHECK de `intel_matches.verdict` (que só tem casado/ambiguo/
 * sem_casamento/nao_observado). Ele cobre o post que ainda não passou pelo
 * matcher (`intel_posts.matched_at IS NULL`, logo sem linha em
 * `intel_matches`) — sem isso essa linha teria `verdict` nulo, e a interface
 * pública promete `string`. Não confundir com 'nao_observado', que é um
 * veredito REAL: o matcher rodou e concluiu que a API nunca ofereceu aquilo.
 */
export async function correlacaoDoDia(
  dia: string,
  filtros?: { verdict?: string; groupId?: string; limit?: number },
): Promise<LinhaCorrelacao[]> {
  if (!DIA_RE.test(dia)) {
    throw new Error(`correlacaoDoDia: "dia" precisa estar em 'YYYY-MM-DD' (recebi "${dia}")`);
  }
  const limit = clampInt(filtros?.limit, 500, 1, 2000);

  const rows = await query<LinhaCorrelacaoRow>(
    `SELECT ip.id::text                     AS post_id,
            ig.display_name                 AS group_name,
            ig.kind                         AS group_kind,
            ip.posted_at                    AS posted_at,
            ip.title_guess                  AS title_guess,
            ip.price                        AS post_price,
            coalesce(m.verdict, 'pendente') AS verdict,
            m.confidence                    AS confidence,
            m.title_sim                     AS title_sim,
            m.product_id                    AS product_id,
            ao.title                        AS obs_title,
            ao.price                        AS obs_price,
            m.first_seen_at                 AS first_seen_at,
            m.lag_seconds                   AS lag_seconds,
            ao.would_pass                   AS would_pass,
            ao.reject_reason                AS reject_reason,
            ao.commission_brl               AS commission_brl,
            ao.sales                        AS sales,
            ao.rating_star                  AS rating_star
       FROM intel_posts ip
       -- INNER JOIN é seguro: group_id é NOT NULL + FK, nunca há post órfão.
       JOIN intel_groups ig ON ig.id = ip.group_id
       LEFT JOIN intel_matches m ON m.post_id = ip.id
       LEFT JOIN api_observations ao ON ao.id = m.observation_id
      WHERE (ip.posted_at AT TIME ZONE '${TZ}')::date = $1::date
        AND ($2::text IS NULL OR coalesce(m.verdict, 'pendente') = $2)
        AND ($3::text IS NULL OR ip.group_id::text = $3)
      ORDER BY ip.posted_at DESC
      LIMIT $4::int`,
    [dia, filtros?.verdict ?? null, filtros?.groupId ?? null, String(limit)],
  );

  return rows.map((row) => ({
    postId: row.post_id,
    groupName: row.group_name,
    groupKind: row.group_kind,
    postedAt: iso(row.posted_at),
    titleGuess: row.title_guess,
    postPrice: toNum(row.post_price),
    verdict: row.verdict,
    confidence: toNum(row.confidence),
    titleSim: toNum(row.title_sim),
    productId: row.product_id,
    obsTitle: row.obs_title,
    obsPrice: toNum(row.obs_price),
    firstSeenAt: isoOrNull(row.first_seen_at),
    lagSeconds: toNum(row.lag_seconds),
    wouldPass: row.would_pass,
    rejectReason: row.reject_reason,
    commissionBrl: toNum(row.commission_brl),
    sales: toNum(row.sales),
    ratingStar: toNum(row.rating_star),
  }));
}

// ---------------------------------------------------------------------------
// 3) repeticaoDeProdutos
// ---------------------------------------------------------------------------

export interface ProdutoRepetido {
  productId: string;
  titulo: string | null;
  vezes: number;
  gruposDistintos: number;
  primeiroPost: string;
  ultimoPost: string;
  intervaloMedianoHoras: number | null;
}

interface ProdutoRepetidoRow {
  product_id: string;
  titulo: string | null;
  vezes: string;
  grupos_distintos: string;
  primeiro_post: Date;
  ultimo_post: Date;
  intervalo_mediano_horas: string | null;
}

/**
 * Repetição = o teste da hipótese "eles usam lista predefinida". Só conta
 * casamentos verdict='casado' com product_id resolvido — post não-casado não
 * tem identidade de produto confiável pra agrupar.
 * `minVezes` tem piso 2 por definição: "repetiu" não existe com 1 ocorrência.
 */
export async function repeticaoDeProdutos(dias?: number, minVezes?: number): Promise<ProdutoRepetido[]> {
  const d = clampInt(dias, 30, 1, 365);
  const min = clampInt(minVezes, 2, 2, 1000);

  const rows = await query<ProdutoRepetidoRow>(
    `WITH casados AS (
       SELECT m.product_id AS product_id,
              ip.posted_at AS posted_at,
              ip.group_id  AS group_id,
              -- melhor palpite de título: o mais RECENTE não-nulo do produto.
              -- "(title_guess IS NULL)" ordena falso (tem título) antes de
              -- verdadeiro (sem título), então first_value pega o não-nulo
              -- mais novo — e só cai pra NULL se NENHUM post tiver título.
              first_value(ip.title_guess) OVER (
                PARTITION BY m.product_id
                ORDER BY (ip.title_guess IS NULL), ip.posted_at DESC
              ) AS titulo_recente
         FROM intel_matches m
         JOIN intel_posts ip ON ip.id = m.post_id
        WHERE m.verdict = 'casado'
          AND m.product_id IS NOT NULL
          AND ip.posted_at >= now() - ($1 || ' days')::interval
     ),
     -- gap = intervalo até o post ANTERIOR do mesmo produto, dentro da janela
     -- (o 1º post de cada produto na janela não tem anterior -> gap NULL,
     -- corretamente excluído da mediana pelo FILTER abaixo).
     com_gap AS (
       SELECT product_id, posted_at, group_id, titulo_recente,
              posted_at - lag(posted_at) OVER (PARTITION BY product_id ORDER BY posted_at) AS gap
         FROM casados
     )
     SELECT product_id,
            max(titulo_recente)       AS titulo,
            count(*)                  AS vezes,
            count(DISTINCT group_id)  AS grupos_distintos,
            min(posted_at)            AS primeiro_post,
            max(posted_at)            AS ultimo_post,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM gap) / 3600.0)
              FILTER (WHERE gap IS NOT NULL))::text AS intervalo_mediano_horas
       FROM com_gap
      GROUP BY product_id
     HAVING count(*) >= $2::int
      ORDER BY vezes DESC, ultimo_post DESC
      LIMIT 200`,
    [String(d), String(min)],
  );

  return rows.map((row) => ({
    productId: row.product_id,
    titulo: row.titulo,
    vezes: toNumOrZero(row.vezes),
    gruposDistintos: toNumOrZero(row.grupos_distintos),
    primeiroPost: iso(row.primeiro_post),
    ultimoPost: iso(row.ultimo_post),
    intervaloMedianoHoras: toNum(row.intervalo_mediano_horas),
  }));
}

// ---------------------------------------------------------------------------
// 4) distribuicaoPorHora
// ---------------------------------------------------------------------------

export interface FaixaHora {
  hora: number;
  posts: number;
  observacoes: number;
}

interface FaixaHoraRow {
  hora: number;
  posts: string;
  observacoes: string;
}

/**
 * Distribuição por hora do dia (0-23), somada por todos os dias da janela —
 * revela a janela em que eles operam.
 * `observacoes` usa DISTINCT product_id, mesma lógica de `resumoDiario`.
 *
 * ARMADILHA DE LEITURA (importante): a nossa varredura roda de 2 em 2 horas
 * (INTEL_SWEEP_CRON), então "observações" cai a zero nas horas em que ela não
 * roda. Isso é a NOSSA cadência de amostragem, não ausência de oferta na
 * Shopee. A linha de posts, essa sim, é observação limpa: chega quando eles
 * postam. Nunca compare as duas alturas diretamente.
 *
 * (Nota de sintaxe: a expressão cron não pode ser escrita literalmente aqui —
 * ela contém a sequência que fecha comentário de bloco em JS. Já quebrou o
 * arquivo uma vez.)
 */
export async function distribuicaoPorHora(dias?: number): Promise<FaixaHora[]> {
  const d = clampInt(dias, 14, 1, 365);

  const rows = await query<FaixaHoraRow>(
    `WITH horas AS (
       SELECT generate_series(0, 23) AS hora
     ),
     posts_por_hora AS (
       SELECT extract(hour FROM posted_at AT TIME ZONE '${TZ}')::int AS hora,
              count(*) AS posts
         FROM intel_posts
        WHERE posted_at >= now() - ($1 || ' days')::interval
        GROUP BY hora
     ),
     obs_por_hora AS (
       SELECT extract(hour FROM observed_at AT TIME ZONE '${TZ}')::int AS hora,
              count(DISTINCT product_id) AS observacoes
         FROM api_observations
        WHERE observed_at >= now() - ($1 || ' days')::interval
        GROUP BY hora
     )
     SELECT h.hora AS hora,
            coalesce(p.posts, 0)       AS posts,
            coalesce(o.observacoes, 0) AS observacoes
       FROM horas h
       LEFT JOIN posts_por_hora p ON p.hora = h.hora
       LEFT JOIN obs_por_hora   o ON o.hora = h.hora
      ORDER BY h.hora`,
    [String(d)],
  );

  return rows.map((row) => ({
    hora: row.hora,
    posts: toNumOrZero(row.posts),
    observacoes: toNumOrZero(row.observacoes),
  }));
}

// ---------------------------------------------------------------------------
// 5) coberturaPorGrupo
// ---------------------------------------------------------------------------

export interface CoberturaGrupo {
  groupId: string;
  nome: string | null;
  kind: string;
  ativo: boolean;
  posts: number;
  casados: number;
  taxaCasamento: number | null;
  atrasoMedianoSeg: number | null;
  ultimoPost: string | null;
}

interface CoberturaGrupoRow {
  group_id: string;
  nome: string | null;
  kind: string;
  ativo: boolean;
  posts: string;
  casados: string;
  atraso_mediano: string | null;
  ultimo_post: Date | null;
}

/**
 * Uma linha por grupo (ativo ou não — o front decide o que mostrar/filtrar).
 * `ultimoPost` vem de `intel_groups.last_post_at` (mantida pela ingestão),
 * portanto é o último post de SEMPRE, não limitado por `dias` — "esse grupo
 * está mudo?" é uma pergunta que não deveria depender da janela do relatório.
 * As demais métricas (posts/casados/atraso) SÃO limitadas por `dias`.
 */
export async function coberturaPorGrupo(dias?: number): Promise<CoberturaGrupo[]> {
  const d = clampInt(dias, 14, 1, 365);

  const rows = await query<CoberturaGrupoRow>(
    `SELECT ig.id::text     AS group_id,
            ig.display_name AS nome,
            ig.kind         AS kind,
            ig.is_active    AS ativo,
            coalesce(p.posts, 0)   AS posts,
            coalesce(p.casados, 0) AS casados,
            p.atraso_mediano       AS atraso_mediano,
            ig.last_post_at        AS ultimo_post
       FROM intel_groups ig
       LEFT JOIN (
         SELECT ip.group_id AS group_id,
                count(*) AS posts,
                count(*) FILTER (WHERE m.verdict = 'casado') AS casados,
                (percentile_cont(0.5) WITHIN GROUP (ORDER BY m.lag_seconds)
                  FILTER (WHERE m.verdict = 'casado' AND m.lag_seconds IS NOT NULL))::text AS atraso_mediano
           FROM intel_posts ip
           -- post_id é UNIQUE em intel_matches -> 1 post casa com no máximo 1
           -- linha aqui; sem risco de duplicar posts nesta junção.
           LEFT JOIN intel_matches m ON m.post_id = ip.id
          WHERE ip.posted_at >= now() - ($1 || ' days')::interval
          GROUP BY ip.group_id
       ) p ON p.group_id = ig.id
      ORDER BY coalesce(p.posts, 0) DESC, ig.display_name NULLS LAST`,
    [String(d)],
  );

  return rows.map((row) => {
    const posts = toNumOrZero(row.posts);
    const casados = toNumOrZero(row.casados);
    return {
      groupId: row.group_id,
      nome: row.nome,
      kind: row.kind,
      ativo: row.ativo,
      posts,
      casados,
      taxaCasamento: percentual(casados, posts),
      atrasoMedianoSeg: toNum(row.atraso_mediano),
      ultimoPost: isoOrNull(row.ultimo_post),
    };
  });
}

// ---------------------------------------------------------------------------
// 6) perfilDeEscolha
// ---------------------------------------------------------------------------

export interface PerfilEscolhido {
  metrica: string; // 'preço' | 'ganho por venda' | 'vendas' | 'nota' | 'desconto anunciado'
  medianaEscolhida: number | null; // mediana entre as ofertas que ELES postaram
  medianaCardapio: number | null; // mediana entre TUDO que a API ofereceu no período
  amostraEscolhida: number;
  amostraCardapio: number;
}

interface PerfilEscolhidoRow {
  metrica: string;
  mediana_escolhida: string | null;
  mediana_cardapio: string | null;
  amostra_escolhida: string;
  amostra_cardapio: string;
}

/**
 * O coração da engenharia reversa: compara o PERFIL das ofertas que eles
 * escolheram com o perfil do cardápio inteiro. Se a mediana de "ganho por
 * venda" das escolhidas for muito maior que a do cardápio, comissão é
 * critério deles.
 *
 * `amostraEscolhida`/`amostraCardapio` usam `count(coluna)`, não `count(*)`:
 * isso exclui NULL automaticamente, então a amostra reportada é sempre o N
 * de verdade por trás da mediana daquela métrica (e não o total de
 * observações, que inflaria a amostra em métricas com muito NULL como
 * `sales`/`rating_star`).
 */
export async function perfilDeEscolha(dias?: number): Promise<PerfilEscolhido[]> {
  const d = clampInt(dias, 14, 1, 365);

  const rows = await query<PerfilEscolhidoRow>(
    `WITH escolhidas AS (
       /*
        * Por PRODUTO, não por observação. O mesmo produto casado por dois
        * grupos (ou por duas linhas de observação diferentes) é UM produto
        * escolhido, não dois — deduplicar por observation_id não resolvia
        * isso, porque cada post casa com a linha de observação mais próxima
        * DELE, e duas linhas distintas passavam pelo DISTINCT.
        *
        * Exclui o grupo do PRÓPRIO dono: se ele cadastrar o próprio grupo
        * para comparar, "o que ELES escolhem" passaria a incluir as NOSSAS
        * ofertas — que por construção têm comissão alta (CAPTURE_MIN_COMMISSION_BRL
        * + offerScore). O gráfico então "confirmaria" que eles escolhem
        * comissão alta porque NÓS escolhemos. Circular e invisível.
        */
       SELECT DISTINCT m.product_id
         FROM intel_matches m
         JOIN intel_posts   ip ON ip.id = m.post_id
         JOIN intel_groups  ig ON ig.id = ip.group_id
        WHERE m.verdict = 'casado'
          AND m.product_id IS NOT NULL
          AND ig.kind <> 'proprio'
     ),
     base AS (
       /*
        * UMA linha por PRODUTO — este é o conserto principal desta consulta.
        *
        * Antes era uma linha por (varredura, produto): em 14 dias, ~12
        * varreduras/dia x ~960 linhas = ~161.000 linhas para ~1.000 produtos
        * distintos. Duas consequências, as duas graves:
        *
        *  1. amostraCardapio reportava ~161.000 quando o N real era ~1.000,
        *     e o painel mostra esse número ao lado da mediana — dava a
        *     impressão de solidez estatística que não existia;
        *  2. a mediana do "cardápio" saía PONDERADA POR PERSISTÊNCIA: produto
        *     que ficou os 14 dias no top-20 pesava 168x mais que um que
        *     apareceu uma vez. Não era a mediana do cardápio, era a mediana
        *     do tempo de permanência.
        *
        * E é exatamente esta consulta que sustenta a afirmação "eles escolhem
        * comissão alta". O lado "escolhidas" já era por match (dezenas), então
        * os dois lados eram unidades diferentes comparadas no mesmo gráfico.
        *
        * A observação mais RECENTE representa o produto: é o estado em que a
        * oferta está agora, que é o que interessa para comparar perfil.
        */
       SELECT DISTINCT ON (ao.product_id)
              ao.price, ao.commission_brl, ao.sales, ao.rating_star,
              ao.advertised_discount_pct,
              (e.product_id IS NOT NULL) AS escolhida
         FROM api_observations ao
         LEFT JOIN escolhidas e ON e.product_id = ao.product_id
        WHERE ao.observed_at >= now() - ($1 || ' days')::interval
        ORDER BY ao.product_id, ao.observed_at DESC
     )
     SELECT 'preço' AS metrica, 1 AS ordem,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY price) FILTER (WHERE escolhida))::text AS mediana_escolhida,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY price))::text AS mediana_cardapio,
            count(price) FILTER (WHERE escolhida) AS amostra_escolhida,
            count(price) AS amostra_cardapio
       FROM base
     UNION ALL
     SELECT 'ganho por venda', 2,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY commission_brl) FILTER (WHERE escolhida))::text,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY commission_brl))::text,
            count(commission_brl) FILTER (WHERE escolhida),
            count(commission_brl)
       FROM base
     UNION ALL
     SELECT 'vendas', 3,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY sales) FILTER (WHERE escolhida))::text,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY sales))::text,
            count(sales) FILTER (WHERE escolhida),
            count(sales)
       FROM base
     UNION ALL
     SELECT 'nota', 4,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY rating_star) FILTER (WHERE escolhida))::text,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY rating_star))::text,
            count(rating_star) FILTER (WHERE escolhida),
            count(rating_star)
       FROM base
     UNION ALL
     SELECT 'desconto anunciado', 5,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY advertised_discount_pct) FILTER (WHERE escolhida))::text,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY advertised_discount_pct))::text,
            count(advertised_discount_pct) FILTER (WHERE escolhida),
            count(advertised_discount_pct)
       FROM base
      ORDER BY ordem`,
    [String(d)],
  );

  return rows.map((row) => ({
    metrica: row.metrica,
    medianaEscolhida: toNum(row.mediana_escolhida),
    medianaCardapio: toNum(row.mediana_cardapio),
    amostraEscolhida: toNumOrZero(row.amostra_escolhida),
    amostraCardapio: toNumOrZero(row.amostra_cardapio),
  }));
}
