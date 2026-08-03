import { query, queryOne } from '../db';
import { log } from '../logger';

/**
 * MONITOR DE PREÇOS.
 *
 * O que ele é: um histórico longo do preço de cada produto, para responder
 * "está barato em relação a ele mesmo?" — a pergunta que um comparador de
 * preços responde e que regra fixa (comissão mínima, vendas, nota) não responde.
 *
 * ⚠️ O que ele NÃO é, POR ENQUANTO: critério de disparo. Decisão explícita do
 * dono — o monitor amadurece observando, e com poucos dias de histórico
 * qualquer afirmação seria ruído com cara de informação. Nada aqui é chamado
 * por `fakeDiscount.ts` nem pelos filtros de captura. Quando for a hora, o
 * ponto de entrada é `estatisticas()`.
 *
 * TRÊS DECISÕES QUE GOVERNAM ESTE ARQUIVO:
 *
 * 1. GRAVA MUDANÇA, NÃO AMOSTRA. Uma linha nova só quando o preço muda além do
 *    epsilon, mais um batimento diário. 27 MB/ano em vez de 2 GB — e por isso
 *    o histórico nunca precisa ser podado.
 *
 * 2. CUSTA ZERO CHAMADAS À SHOPEE. A fonte é a varredura de inteligência, que
 *    já roda 12x/dia sobre 49 keywords e já traz o preço. O dado entrava e era
 *    descartado.
 *
 * 3. COBERTURA É PARTE DO DADO. Sem saber em quantos dias distintos houve
 *    observação, "menor preço em 42 dias" é uma frase, não uma medida.
 */

/** Abaixo disto é ruído de arredondamento, não mudança de preço. */
const EPSILON_PCT = 0.5;

/** Janelas oferecidas. Redondas de propósito: nada de "menor preço em 2 dias". */
export const JANELAS = [7, 14, 30, 42, 60, 90, 180, 365] as const;

export interface LeituraPreco {
  productId: string;
  shopId: string | null;
  price: number | null;
  priceMin?: number | null;
  priceMax?: number | null;
  title?: string | null;
  imageUrl?: string | null;
  catRaiz?: string | null;
  observedAt?: Date | string;
  fonte?: 'varredura' | 'captura' | 'backfill' | 'manual';
}

/**
 * Registra um lote de leituras, gravando só o que MUDOU.
 *
 * Em lote e não uma a uma porque a varredura entrega ~2.450 leituras de uma
 * vez; 2.450 idas ao banco por rodada seria trocar um gargalo de API por um de
 * banco.
 *
 * Devolve quantas viraram linha — que é o número que importa: se ~2.400
 * leituras viram ~200 linhas, o log de mudança está fazendo o trabalho dele.
 */
export async function registrarLeituras(
  leituras: LeituraPreco[],
  fonte: LeituraPreco['fonte'] = 'varredura',
): Promise<{ recebidas: number; gravadas: number }> {
  const validas = leituras.filter((l) => l.price != null && l.price > 0 && l.productId);
  if (!validas.length) return { recebidas: leituras.length, gravadas: 0 };

  const ids = [...new Set(validas.map((l) => l.productId))];
  const estados = await query<{ product_id: string; preco_atual: string | null }>(
    `SELECT product_id, preco_atual::text FROM price_state
      WHERE platform = 'shopee' AND product_id = ANY($1::text[])`,
    [ids],
  );
  const atual = new Map(estados.map((e) => [e.product_id, Number(e.preco_atual)]));

  /*
   * Batimento diário: mesmo sem mudança, grava uma linha por dia por produto.
   * É o que separa "o preço não mudou" de "paramos de olhar" — sem isso, um
   * coletor parado produz um gráfico plano idêntico ao de um preço estável, e
   * o selo mentiria por omissão.
   */
  const jaHojeRows = await query<{ product_id: string }>(
    `SELECT DISTINCT product_id FROM price_points
      WHERE platform = 'shopee' AND product_id = ANY($1::text[])
        AND observed_at >= date_trunc('day', now())`,
    [ids],
  );
  const jaHoje = new Set(jaHojeRows.map((r) => r.product_id));

  const gravar = validas.filter((l) => {
    const anterior = atual.get(l.productId);
    if (anterior == null || !Number.isFinite(anterior)) return true;   // primeira leitura
    if (!jaHoje.has(l.productId)) return true;                          // batimento do dia
    const variacao = Math.abs(l.price! - anterior) / anterior * 100;
    return variacao > EPSILON_PCT;
  });

  // Dedup dentro do próprio lote: o mesmo produto vem de várias keywords.
  const porProduto = new Map<string, LeituraPreco>();
  for (const l of gravar) if (!porProduto.has(l.productId)) porProduto.set(l.productId, l);
  const linhas = [...porProduto.values()];
  if (!linhas.length) return { recebidas: leituras.length, gravadas: 0 };

  const vals: string[] = [];
  const params: unknown[] = [];
  for (const l of linhas) {
    const base = params.length;
    vals.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`);
    params.push(
      l.productId, l.shopId ?? null, l.price, l.priceMin ?? null, l.priceMax ?? null,
      l.fonte ?? fonte, l.observedAt ?? new Date(),
    );
  }
  const inseridas = await query<{ id: string }>(
    `INSERT INTO price_points (product_id, shop_id, price, price_min, price_max, fonte, observed_at)
     VALUES ${vals.join(',')}
     ON CONFLICT (platform, product_id, observed_at) DO NOTHING
     RETURNING id`,
    params,
  );

  await atualizarEstado(linhas);
  return { recebidas: leituras.length, gravadas: inseridas.length };
}

/**
 * Recalcula `price_state` para os produtos tocados.
 *
 * A máscara de dias é deslocada pela diferença de dias desde a última
 * atualização ANTES de marcar o bit de hoje — sem isso, um produto não visto
 * por uma semana voltaria com a cobertura antiga intacta e alegaria uma
 * continuidade que não houve.
 */
async function atualizarEstado(linhas: LeituraPreco[]): Promise<void> {
  for (const l of linhas) {
    await query(
      `INSERT INTO price_state (platform, product_id, shop_id, title, image_url, cat_raiz,
                                preco_atual, preco_min, preco_max, primeiro_em, ultimo_em,
                                mudancas, dias_mask, dias_mask_em)
       VALUES ('shopee',$1,$2,$3,$4,$5,$6,$6,$6,now(),now(),1,1,current_date)
       ON CONFLICT (platform, product_id) DO UPDATE SET
         shop_id     = COALESCE(EXCLUDED.shop_id, price_state.shop_id),
         title       = COALESCE(EXCLUDED.title, price_state.title),
         image_url   = COALESCE(EXCLUDED.image_url, price_state.image_url),
         cat_raiz    = COALESCE(EXCLUDED.cat_raiz, price_state.cat_raiz),
         preco_atual = EXCLUDED.preco_atual,
         preco_min   = LEAST(price_state.preco_min, EXCLUDED.preco_atual),
         preco_max   = GREATEST(price_state.preco_max, EXCLUDED.preco_atual),
         ultimo_em   = now(),
         mudancas    = price_state.mudancas + 1,
         -- Desloca a máscara pelos dias passados, depois acende o bit de hoje.
         -- 62 bits, nao 63: (1::bigint << 63) estoura o signed int8 e o -1
         -- derrubava a query inteira com "bigint out of range" — dentro da
         -- varredura, que é o caminho mais quente do sistema.
         dias_mask   = CASE
             WHEN current_date - price_state.dias_mask_em >= 62 THEN 1
             ELSE ((price_state.dias_mask <<
                     GREATEST(0, current_date - price_state.dias_mask_em)::int)
                   & 4611686018427387903) | 1   -- (1<<62)-1
           END,
         dias_mask_em = current_date`,
      [l.productId, l.shopId ?? null, l.title ?? null, l.imageUrl ?? null, l.catRaiz ?? null, l.price],
    );
  }
}

export interface EstatisticaPreco {
  productId: string;
  title: string | null;
  imageUrl: string | null;
  precoAtual: number | null;
  /** Média PONDERADA PELO TEMPO em que cada preço vigorou, na janela. */
  mediaPonderada: number | null;
  minimo: number | null;
  maximo: number | null;
  /** Quantos dias distintos tiveram observação, dentro da janela. */
  diasCobertos: number;
  janelaDias: number;
  /** % abaixo da média ponderada. Positivo = mais barato que o normal. */
  abaixoDaMediaPct: number | null;
  /** Só verdadeiro com cobertura suficiente — ver `COBERTURA_MINIMA`. */
  confiavel: boolean;
  mudancas: number;
}

/**
 * Fração da janela que precisa ter observação para o número ser afirmável.
 *
 * 60% é conservador de propósito. O dono disse: com 3 dias de histórico,
 * mostrar correlação é inútil. Concordo, e a defesa fica no dado: abaixo disto
 * o painel mostra a série mas NÃO afirma "menor preço em N dias".
 */
/** popcount. Em JS não há `bit_count`, e a máscara passa por aqui a cada ficha. */
function contarBits(n: bigint): number {
  let c = 0;
  for (let v = n; v > 0n; v >>= 1n) if (v & 1n) c += 1;
  return c;
}

const COBERTURA_MINIMA = 0.6;
const DIAS_MINIMOS = 5;

/**
 * Estatística de um produto numa janela.
 *
 * A média é ponderada pelo TEMPO de vigência de cada preço, não pela contagem
 * de leituras: com log de mudança, um preço que durou 30 dias tem uma linha e
 * um que durou 2 horas também — contar linhas daria o mesmo peso aos dois.
 *
 * `vigente_no_inicio` existe porque, no log de mudança, um produto estável há
 * meses não tem NENHUMA linha dentro da janela. Sem trazer o preço que já
 * vigorava, a janela pareceria vazia justamente para o caso mais simples.
 */
export async function estatisticas(
  productId: string,
  janelaDias = 90,
): Promise<EstatisticaPreco | null> {
  const est = await queryOne<{
    title: string | null; image_url: string | null; preco_atual: string | null;
    mudancas: number; dias_mask: string;
  }>(
    /*
     * Se a linha de estado não existir (backfill parcial, produto importado a
     * mão), o produto NÃO some: a identidade é derivada do próprio log. Devolver
     * null com histórico gravado faria a ficha dar 404 para um produto que tem
     * dado — o pior tipo de resposta, porque parece ausência de dado.
     */
    `SELECT s.title, s.image_url, s.preco_atual::text, s.mudancas,
            -- a máscara guardada está defasada dos dias em que ninguém a tocou
            (CASE WHEN current_date - s.dias_mask_em >= 62 THEN 0
                  ELSE (s.dias_mask << GREATEST(0, current_date - s.dias_mask_em)::int)
                       & 4611686018427387903 END)::text AS dias_mask
       FROM price_state s WHERE s.platform='shopee' AND s.product_id=$1`,
    [productId],
  );
  const estado = est ?? await queryOne<{
    title: string | null; image_url: string | null; preco_atual: string | null;
    mudancas: number; dias_mask: string;
  }>(
    `SELECT NULL::text AS title, NULL::text AS image_url,
            (SELECT price::text FROM price_points
              WHERE platform='shopee' AND product_id=$1
              ORDER BY observed_at DESC LIMIT 1) AS preco_atual,
            count(*)::int AS mudancas, '0'::text AS dias_mask
       FROM price_points WHERE platform='shopee' AND product_id=$1
      HAVING count(*) > 0`,
    [productId],
  );
  if (!estado) return null;

  const r = await queryOne<{
    media: string | null; minimo: string | null; maximo: string | null; dias_com_mudanca: string;
  }>(
    `WITH janela AS (
       SELECT price, observed_at,
              LEAD(observed_at, 1, now()) OVER (ORDER BY observed_at) AS ate
         FROM price_points
        WHERE platform='shopee' AND product_id=$1
          AND observed_at >= now() - ($2 || ' days')::interval
     ),
     vigente AS (
       SELECT price, now() - ($2 || ' days')::interval AS observed_at,
              COALESCE((SELECT min(observed_at) FROM janela), now()) AS ate
         FROM price_points
        WHERE platform='shopee' AND product_id=$1
          AND observed_at < now() - ($2 || ' days')::interval
        ORDER BY observed_at DESC LIMIT 1
     ),
     tudo AS (SELECT * FROM janela UNION ALL SELECT * FROM vigente)
     SELECT
       (sum(price * EXTRACT(EPOCH FROM (ate - observed_at))) /
        NULLIF(sum(EXTRACT(EPOCH FROM (ate - observed_at))), 0))::text AS media,
       min(price)::text AS minimo,
       max(price)::text AS maximo,
       count(DISTINCT date_trunc('day', observed_at))::text AS dias_com_mudanca
     FROM tudo`,
    [productId, String(janelaDias)],
  );

  /*
   * COBERTURA VEM DA MÁSCARA, não da contagem de linhas.
   *
   * O log é de MUDANÇA: um produto olhado todo dia e estável há um mês tem UMA
   * linha. Contar dias distintos no log daria cobertura 1/30 e o marcaria como
   * "sem base" — exatamente ao contrário da verdade, e justamente para o caso
   * mais bem observado que existe. A máscara guarda "olhamos neste dia", que é
   * a pergunta que a cobertura faz.
   */
  const janelaBits = Math.min(janelaDias, 62);
  const mascaraJanela = (1n << BigInt(janelaBits)) - 1n;
  const bitsVistos = contarBits(BigInt(estado.dias_mask || '0') & mascaraJanela);
  const diasComMudanca = Number(r?.dias_com_mudanca ?? 0);
  // Sem máscara (produto só backfillado), o log é o melhor que existe.
  const diasCobertos = bitsVistos || diasComMudanca;
  const media = r?.media != null ? Number(r.media) : null;
  const atual = estado.preco_atual != null ? Number(estado.preco_atual) : null;
  const cobertura = diasCobertos / janelaBits;

  return {
    productId,
    title: estado.title,
    imageUrl: estado.image_url,
    precoAtual: atual,
    mediaPonderada: media,
    minimo: r?.minimo != null ? Number(r.minimo) : null,
    maximo: r?.maximo != null ? Number(r.maximo) : null,
    diasCobertos,
    janelaDias,
    abaixoDaMediaPct: media && atual ? Number((((media - atual) / media) * 100).toFixed(1)) : null,
    confiavel: diasCobertos >= DIAS_MINIMOS && cobertura >= COBERTURA_MINIMA,
    mudancas: estado.mudancas,
  };
}

/** A série, em degraus. Cada linha é uma MUDANÇA — não interpole entre elas. */
export async function serie(productId: string, dias = 90) {
  return query<{ price: string; observed_at: string; price_min: string | null; price_max: string | null }>(
    `SELECT price::text, observed_at::text, price_min::text, price_max::text
       FROM price_points
      WHERE platform='shopee' AND product_id=$1
        AND observed_at >= now() - ($2 || ' days')::interval
      ORDER BY observed_at`,
    [productId, String(dias)],
  );
}

/**
 * MELHORES OPORTUNIDADES AGORA — cada item comparado com o PRÓPRIO passado.
 *
 * Feito em SQL de uma vez, e não chamando `estatisticas()` por produto, porque
 * o catálogo passa de mil itens e mil consultas por abertura de tela seria
 * transformar uma boa ideia num painel lento.
 *
 * Sem cobertura suficiente o produto NÃO some da lista — ele aparece com
 * `confiavel: false`. É o dono que decide se olha; esconder seria decidir por
 * ele, e mostrar como se fosse certo seria mentir.
 */
export async function melhoresOportunidades(opcoes: {
  dias?: number; limite?: number; soConfiavel?: boolean; categoria?: string;
} = {}) {
  const dias = Math.max(7, Math.min(365, Math.round(opcoes.dias ?? 90)));
  const limite = Math.max(1, Math.min(200, Math.round(opcoes.limite ?? 40)));

  return query<Record<string, string | null>>(
    `WITH base AS (
       SELECT s.product_id, s.title, s.image_url, s.cat_raiz, s.shop_id,
              s.preco_atual, s.preco_min, s.mudancas, s.ultimo_em,
              (SELECT count(DISTINCT date_trunc('day', p.observed_at))
                 FROM price_points p
                WHERE p.platform='shopee' AND p.product_id = s.product_id
                  AND p.observed_at >= now() - ($1 || ' days')::interval) AS dias,
              (SELECT sum(p.price * EXTRACT(EPOCH FROM (p.ate - p.observed_at)))
                    / NULLIF(sum(EXTRACT(EPOCH FROM (p.ate - p.observed_at))), 0)
                 FROM (SELECT price, observed_at,
                              LEAD(observed_at, 1, now()) OVER (ORDER BY observed_at) AS ate
                         FROM price_points
                        WHERE platform='shopee' AND product_id = s.product_id
                          AND observed_at >= now() - ($1 || ' days')::interval) p) AS media
         FROM price_state s
        WHERE s.preco_atual IS NOT NULL
          AND s.ultimo_em >= now() - interval '3 days'
          AND ($3::text IS NULL OR s.cat_raiz = $3)
     )
     SELECT product_id, title, image_url, cat_raiz, shop_id,
            preco_atual::text, preco_min::text, media::text, dias::text,
            mudancas::text, ultimo_em::text,
            (((media - preco_atual) / NULLIF(media,0)) * 100)::numeric(6,1)::text AS abaixo_pct,
            (dias >= ${DIAS_MINIMOS} AND dias::numeric / LEAST($1::numeric, 63) >= ${COBERTURA_MINIMA})::text AS confiavel
       FROM base
      WHERE media IS NOT NULL AND media > preco_atual
        ${opcoes.soConfiavel ? `AND dias >= ${DIAS_MINIMOS} AND dias::numeric / LEAST($1::numeric, 63) >= ${COBERTURA_MINIMA}` : ''}
      ORDER BY ((media - preco_atual) / NULLIF(media,0)) DESC
      LIMIT $2`,
    [String(dias), limite, opcoes.categoria ?? null],
  );
}

/** Números da aba: tamanho do catálogo, cobertura, quanto já foi acumulado. */
export async function resumoMonitor() {
  const r = await queryOne<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM price_state)::text                                   AS produtos,
       (SELECT count(*) FROM price_points)::text                                  AS pontos,
       (SELECT count(*) FROM price_state WHERE ultimo_em >= now() - interval '2 days')::text AS vivos,
       (SELECT min(observed_at)::text FROM price_points)                          AS desde,
       (SELECT count(*) FROM price_points
         WHERE observed_at >= date_trunc('day', now()))::text                     AS pontos_hoje,
       (SELECT count(*) FROM price_state WHERE mudancas >= 5)::text               AS com_serie`,
  );
  return r ?? {};
}

/**
 * Traz para o histórico o que já foi observado antes de o monitor existir.
 *
 * Fonte: `api_observations` — mesma API, mesmo normalizador, preço real. É o
 * que dá ao monitor um passado no dia em que ele nasce, em vez de começar do
 * zero. Idempotente pelo UNIQUE, então rodar duas vezes não duplica.
 *
 * ⚠️ O backfill entrega CONTAGEM, não COBERTURA: 2.651 observações ≈ 3
 * varreduras ≈ 6 horas de janela. Por isso o portão do que é afirmável conta
 * DIAS DISTINTOS, não leituras — senão, no dia seguinte ao backfill, centenas
 * de produtos alegariam "menor preço" com base em meio dia de observação.
 */
export async function backfill(): Promise<{ inseridas: number }> {
  const r = await query<{ id: string }>(
    `INSERT INTO price_points (platform, product_id, shop_id, price, fonte, observed_at)
     SELECT DISTINCT ON (ao.product_id, date_trunc('hour', ao.observed_at))
            'shopee', ao.product_id, ao.shop_id, ao.price, 'backfill', ao.observed_at
       FROM api_observations ao
      WHERE ao.price IS NOT NULL AND ao.price > 0
      ORDER BY ao.product_id, date_trunc('hour', ao.observed_at), ao.observed_at
     ON CONFLICT (platform, product_id, observed_at) DO NOTHING
     RETURNING id`,
  );
  // Reconstrói o estado a partir do log — uma vez, e o incremental cuida do resto.
  await query(
    `INSERT INTO price_state (platform, product_id, shop_id, title, preco_atual, preco_min,
                              preco_max, primeiro_em, ultimo_em, mudancas, dias_mask_em)
     SELECT 'shopee', p.product_id, max(p.shop_id),
            (SELECT ao.title FROM api_observations ao
              WHERE ao.product_id = p.product_id ORDER BY ao.observed_at DESC LIMIT 1),
            (SELECT price FROM price_points x
              WHERE x.product_id = p.product_id ORDER BY observed_at DESC LIMIT 1),
            min(p.price), max(p.price), min(p.observed_at), max(p.observed_at),
            count(*), current_date
       FROM price_points p GROUP BY p.product_id
     ON CONFLICT (platform, product_id) DO UPDATE SET
       preco_min  = LEAST(price_state.preco_min, EXCLUDED.preco_min),
       preco_max  = GREATEST(price_state.preco_max, EXCLUDED.preco_max),
       primeiro_em = LEAST(price_state.primeiro_em, EXCLUDED.primeiro_em),
       title      = COALESCE(price_state.title, EXCLUDED.title)`,
  );
  log.info('backfill do monitor de preços', { inseridas: r.length });
  return { inseridas: r.length };
}

/**
 * ONDE ESTE PRODUTO APARECEU — nos grupos observados e no nosso disparo.
 *
 * É a pergunta que fecha o ciclo do painel: o monitor sabe quanto o produto
 * custava, a inteligência sabe quem postou, e até agora as duas coisas viviam
 * em telas separadas. Aqui elas se encontram na ficha do item.
 *
 * A ligação vem de `intel_matches.product_id`, que o casador já grava — não é
 * casamento novo por título, é leitura do que já foi decidido. Isso importa:
 * refazer o casamento aqui poderia dar uma resposta DIFERENTE da que a aba
 * Inteligência mostra para o mesmo produto.
 */
export async function ondeApareceu(productId: string, dias = 90) {
  const [emGrupos, nossosEnvios] = await Promise.all([
    query<{
      grupo: string; kind: string; posted_at: string; preco_post: string | null;
      verdict: string; lag: string | null;
    }>(
      `SELECT coalesce(g.display_name, g.group_jid) AS grupo, g.kind,
              p.posted_at::text, p.price::text AS preco_post,
              m.verdict, m.lag_seconds::text AS lag
         FROM intel_matches m
         JOIN intel_posts  p ON p.id = m.post_id
         JOIN intel_groups g ON g.id = p.group_id
        WHERE m.product_id = $1
          AND p.posted_at >= now() - ($2 || ' days')::interval
        ORDER BY p.posted_at DESC
        LIMIT 40`,
      [productId, String(dias)],
    ),
    query<{ grupo: string | null; sent_at: string; preco: string | null }>(
      `SELECT c.display_name AS grupo, s.sent_at::text, o.price::text AS preco
         FROM send_logs s
         JOIN offers   o ON o.id = s.offer_id
         LEFT JOIN channels c ON c.id = s.channel_id
        WHERE o.product_id = $1 AND s.status = 'sent'
        ORDER BY s.sent_at DESC LIMIT 20`,
      [productId],
    ),
  ]);
  return { emGrupos, nossosEnvios };
}

/**
 * HISTÓRICO POR DIA — um valor por dia, para a ficha.
 *
 * O log guarda mudanças; a ficha quer dias. `generate_series` preenche os dias
 * SEM mudança com o preço que vigorava — sem isso, um produto estável há duas
 * semanas apareceria como duas semanas de buraco, que é o oposto da verdade.
 *
 * `visto` distingue as duas coisas que um gráfico costuma confundir: "o preço
 * não mudou" e "ninguém olhou". Só a primeira é informação sobre o mercado.
 */
export async function historicoDiario(productId: string, dias = 90) {
  return query<{ dia: string; preco: string | null; visto: string }>(
    `WITH dias AS (
       SELECT generate_series(
         (now() - ($2 || ' days')::interval)::date, current_date, '1 day'
       )::date AS dia
     )
     SELECT d.dia::text,
            (SELECT p.price::text FROM price_points p
              WHERE p.platform='shopee' AND p.product_id=$1
                AND p.observed_at::date <= d.dia
              ORDER BY p.observed_at DESC LIMIT 1) AS preco,
            (EXISTS (SELECT 1 FROM price_points p2
                      WHERE p2.platform='shopee' AND p2.product_id=$1
                        AND p2.observed_at::date = d.dia))::text AS visto
       FROM dias d ORDER BY d.dia`,
    [productId, String(dias)],
  );
}
