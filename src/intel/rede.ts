import { query } from '../db';
import { loadConfig } from '../config';

/**
 * DE ONDE VEM A OFERTA DELES — a pergunta que a correlação com a API sozinha
 * não responde.
 *
 * A camada de correlação existente compara o que um grupo postou com o que a
 * API da Shopee ofereceu, e responde "eles pegaram do cardápio, com que
 * atraso". Isso pressupõe que a fonte deles É a API. Se não for, a resposta sai
 * confiante e errada.
 *
 * As três hipóteses que este módulo separa:
 *
 *  1. USAM A API (ou algo equivalente). O post aparece pouco depois de a oferta
 *     existir no cardápio, e ELES são os primeiros da rede observada a postar.
 *  2. ESCOLHEM ANTES / têm outra fonte. Postam produtos que o cardápio não tinha
 *     naquele momento, e ainda assim são os primeiros.
 *  3. ASSISTEM OUTROS GRUPOS E COMPILAM. O mesmo produto aparece primeiro em
 *     OUTRO grupo observado, e eles republicam com atraso curto e consistente.
 *
 * A terceira é a que muda a estratégia: se um grupo é só eco, o critério de
 * seleção dele não é dele — copiá-lo é copiar cópia.
 *
 * ⚠️ LIMITE HONESTO, e ele é estrutural: "primeiro" aqui significa PRIMEIRO
 * ENTRE OS GRUPOS QUE VOCÊ OBSERVA. Um grupo pode parecer fonte só porque a
 * fonte de verdade não está na sua lista. O relatório devolve
 * `gruposObservados` justamente para a tela poder dizer isso — com 1 grupo, a
 * pergunta "quem copia quem" não tem resposta possível, e mostrar zeros seria
 * fingir que tem.
 */

export interface OrigemGrupo {
  groupId: string;
  nome: string;
  kind: string;
  posts: number;
  /** Foi o primeiro da rede observada a postar aquele produto. */
  primeiroNaRede: number;
  /** Outro grupo observado postou o mesmo produto ANTES. */
  ecoDeOutro: number;
  /** Casou com o cardápio da API. */
  casadosComApi: number;
  /** Mediana do atraso em relação à API (segundos). */
  atrasoApiMediano: number | null;
  /** Mediana do atraso em relação ao grupo que postou antes (segundos). */
  atrasoEcoMediano: number | null;
  /** De quem ele mais ecoa, quando ecoa. */
  ecoPrincipal: { groupId: string; nome: string; vezes: number } | null;
  veredito: 'sem_dados' | 'rede_pequena' | 'fonte_via_api' | 'fonte_propria' | 'eco' | 'misto';
}

export interface RedeDeGrupos {
  dias: number;
  gruposObservados: number;
  /** Sem pelo menos 2 grupos não existe "quem copia quem". */
  comparavel: boolean;
  grupos: OrigemGrupo[];
  /** Pares (quem ecoa → de quem), para desenhar a rede. */
  arestas: Array<{ de: string; deNome: string; para: string; paraNome: string; vezes: number; atrasoMediano: number }>;
}

/**
 * Janela em que um post é candidato a ser eco de outro. 48h é generoso de
 * propósito: uma oferta boa circula por dias, e cortar curto demais faria eco
 * lento parecer fonte.
 */
const JANELA_ECO_HORAS = 48;

export async function redeDeGrupos(dias?: number): Promise<RedeDeGrupos> {
  const d = Math.max(1, Math.min(365, Math.round(Number(dias) || 14)));
  const cfg = loadConfig();
  const minSim = cfg.INTEL_MATCH_MIN_SIM;

  const grupos = await query<{ id: string; display_name: string | null; kind: string }>(
    `SELECT id::text AS id, display_name, kind FROM intel_groups WHERE is_active = true ORDER BY id`,
  );
  const nomes = new Map(grupos.map((g) => [g.id, g.display_name || g.id]));

  if (grupos.length === 0) {
    return { dias: d, gruposObservados: 0, comparavel: false, grupos: [], arestas: [] };
  }

  /*
   * Para cada post, o post MAIS PRÓXIMO ANTERIOR de OUTRO grupo com título
   * parecido. `DISTINCT ON (a.id)` mantém só o mais próximo — sem isso, um
   * produto que circulou por cinco grupos geraria dez pares e a contagem de
   * "eco" ficaria inflada pela popularidade da oferta, não pelo comportamento
   * do grupo.
   *
   * O corte de tamanho do título evita casar lixo: título de 3 caracteres tem
   * similaridade alta com qualquer coisa.
   */
  const ecos = await query<{
    post_id: string; group_id: string; fonte_group: string; lag: string;
  }>(
    `WITH janela AS (
       SELECT p.id, p.group_id::text AS group_id, p.posted_at, p.title_norm
         FROM intel_posts p
         JOIN intel_groups g ON g.id = p.group_id AND g.is_active = true
        WHERE p.posted_at >= now() - ($1 || ' days')::interval
          AND p.title_norm IS NOT NULL AND length(p.title_norm) >= 12
     )
     SELECT DISTINCT ON (a.id)
            a.id::text        AS post_id,
            a.group_id        AS group_id,
            b.group_id        AS fonte_group,
            EXTRACT(EPOCH FROM (a.posted_at - b.posted_at))::text AS lag
       FROM janela a
       JOIN janela b
         ON b.group_id <> a.group_id
        AND b.posted_at < a.posted_at
        AND b.posted_at >= a.posted_at - ($2 || ' hours')::interval
        AND similarity(a.title_norm, b.title_norm) >= $3
      ORDER BY a.id, (a.posted_at - b.posted_at) ASC`,
    [String(d), String(JANELA_ECO_HORAS), minSim],
  );

  const ecoPorPost = new Map(ecos.map((e) => [e.post_id, e]));

  /*
   * Lado da API: usa `intel_matches.lag_seconds`, que o matcher já calcula e
   * GRAVA no momento do casamento. Recalcular a partir de `api_observations`
   * seria pior: a observação some depois de 90 dias de poda, e o atraso — que
   * é justamente o número que se quer preservar — voltaria nulo para posts
   * antigos, mudando um relatório sobre o passado.
   */
  const daApi = await query<{ post_id: string; group_id: string; lag: string }>(
    `SELECT p.id::text AS post_id, p.group_id::text AS group_id, m.lag_seconds::text AS lag
       FROM intel_posts p
       JOIN intel_groups g ON g.id = p.group_id AND g.is_active = true
       JOIN intel_matches m ON m.post_id = p.id AND m.verdict = 'casado'
      WHERE p.posted_at >= now() - ($1 || ' days')::interval
        AND m.lag_seconds IS NOT NULL`,
    [String(d)],
  );
  const apiPorPost = new Map(daApi.map((a) => [a.post_id, Number(a.lag)]));

  const totais = await query<{ group_id: string; n: string }>(
    `SELECT p.group_id::text AS group_id, count(*)::text AS n
       FROM intel_posts p
       JOIN intel_groups g ON g.id = p.group_id AND g.is_active = true
      WHERE p.posted_at >= now() - ($1 || ' days')::interval
      GROUP BY p.group_id`,
    [String(d)],
  );
  const totalPorGrupo = new Map(totais.map((t) => [t.group_id, Number(t.n)]));

  const mediana = (v: number[]): number | null => {
    if (!v.length) return null;
    const s = [...v].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
  };

  const porGrupo = new Map<string, {
    eco: number; primeiro: number; lagsEco: number[]; lagsApi: number[];
    fontes: Map<string, number>;
  }>();
  for (const g of grupos) {
    porGrupo.set(g.id, { eco: 0, primeiro: 0, lagsEco: [], lagsApi: [], fontes: new Map() });
  }

  const postsNaJanela = await query<{ id: string; group_id: string }>(
    `SELECT p.id::text AS id, p.group_id::text AS group_id
       FROM intel_posts p
       JOIN intel_groups g ON g.id = p.group_id AND g.is_active = true
      WHERE p.posted_at >= now() - ($1 || ' days')::interval`,
    [String(d)],
  );

  const arestas = new Map<string, { vezes: number; lags: number[] }>();

  for (const p of postsNaJanela) {
    const acc = porGrupo.get(p.group_id);
    if (!acc) continue;
    const eco = ecoPorPost.get(p.id);
    if (eco) {
      acc.eco += 1;
      acc.lagsEco.push(Number(eco.lag));
      acc.fontes.set(eco.fonte_group, (acc.fontes.get(eco.fonte_group) ?? 0) + 1);
      const chave = `${p.group_id}>${eco.fonte_group}`;
      const a = arestas.get(chave) ?? { vezes: 0, lags: [] };
      a.vezes += 1;
      a.lags.push(Number(eco.lag));
      arestas.set(chave, a);
    } else {
      acc.primeiro += 1;
    }
    const lagApi = apiPorPost.get(p.id);
    if (lagApi != null) acc.lagsApi.push(lagApi);
  }

  const comparavel = grupos.length >= 2;

  const saida: OrigemGrupo[] = grupos.map((g) => {
    const acc = porGrupo.get(g.id)!;
    const posts = totalPorGrupo.get(g.id) ?? 0;
    let ecoPrincipal: OrigemGrupo['ecoPrincipal'] = null;
    let maior = 0;
    for (const [gid, n] of acc.fontes) {
      if (n > maior) { maior = n; ecoPrincipal = { groupId: gid, nome: nomes.get(gid) ?? gid, vezes: n }; }
    }

    /*
     * O VEREDITO é conservador de propósito. Cada rótulo aqui vira uma decisão
     * de estratégia do dono ("esse grupo é só eco, não vale copiar"), e um
     * rótulo errado custa mais que um "misto" honesto.
     */
    let veredito: OrigemGrupo['veredito'] = 'misto';
    if (posts === 0) veredito = 'sem_dados';
    else if (!comparavel) veredito = 'rede_pequena';
    else {
      const fracEco = acc.eco / posts;
      const fracApi = acc.lagsApi.length / posts;
      if (fracEco >= 0.6) veredito = 'eco';
      else if (fracEco <= 0.25 && fracApi >= 0.5) veredito = 'fonte_via_api';
      else if (fracEco <= 0.25 && fracApi < 0.25) veredito = 'fonte_propria';
    }

    return {
      groupId: g.id,
      nome: g.display_name || g.id,
      kind: g.kind,
      posts,
      primeiroNaRede: acc.primeiro,
      ecoDeOutro: acc.eco,
      casadosComApi: acc.lagsApi.length,
      atrasoApiMediano: mediana(acc.lagsApi),
      atrasoEcoMediano: mediana(acc.lagsEco),
      ecoPrincipal,
      veredito,
    };
  });

  return {
    dias: d,
    gruposObservados: grupos.length,
    comparavel,
    grupos: saida,
    arestas: [...arestas.entries()].map(([chave, a]) => {
      const [de, para] = chave.split('>');
      return {
        de: de!, deNome: nomes.get(de!) ?? de!,
        para: para!, paraNome: nomes.get(para!) ?? para!,
        vezes: a.vezes, atrasoMediano: mediana(a.lags) ?? 0,
      };
    }).sort((x, y) => y.vezes - x.vezes),
  };
}

/* ============================================================
   PERFIL DE NICHO DE CADA GRUPO
   ============================================================ */

export interface NichoGrupo {
  groupId: string;
  nome: string;
  postsClassificados: number;
  postsTotal: number;
  /** Categorias em que ele posta, da mais frequente para a menos. */
  categorias: Array<{ nome: string; n: number; pct: number }>;
  /** 0..1 — quanto a atividade se concentra em poucas categorias. */
  concentracao: number | null;
  categoriasDistintas: number;
  /** Rótulo derivado: especialista, misto, generalista — ou "amostra pequena". */
  perfil: 'amostra_pequena' | 'especialista' | 'misto' | 'generalista';
  principal: string | null;
  /** De que lojas o grupo posta — calculado SEMPRE sobre tudo, sem filtro. */
  plataformas: Array<{ nome: string; n: number; pct: number }>;
  /** Quanto do que ele posta é Shopee — é a fatia com que o motor compete. */
  pctShopee: number;
  postsNaJanela: number;
}

/**
 * Mínimo de posts classificados para arriscar um rótulo.
 *
 * Com 5 posts, um grupo que por acaso postou 4 eletrônicos vira "especialista
 * em eletrônicos" — e o dono decide estratégia com base num acaso. 20 é
 * conservador de propósito: abaixo disso o painel diz "amostra pequena" em vez
 * de inventar um perfil.
 */
const MIN_PARA_ROTULAR = 20;

/**
 * Perfil de categoria de cada grupo observado.
 *
 * A categoria NÃO é inferida por palavra-chave nossa: vem carimbada pela
 * própria Shopee (`productCatIds`) na observação com que o post casou. Isso é o
 * que substitui o rótulo raso "promoção genérica" que o dono escolhia na mão —
 * agora o perfil é MEDIDO, e "generalista" vira uma conclusão, não um chute.
 *
 * CONSEQUÊNCIA HONESTA: só dá para classificar post que CASOU com uma
 * observação da API. Post de outra plataforma (Amazon, Mercado Livre) e post
 * que o matcher não achou ficam de fora — por isso o retorno traz
 * `postsClassificados` E `postsTotal` lado a lado. Um perfil calculado sobre
 * 12 de 300 posts não é o perfil do grupo, e a tela precisa poder dizer isso.
 */
export async function nichoDosGrupos(
  dias?: number,
  somenteShopee = true,
): Promise<{ dias: number; somenteShopee: boolean; grupos: NichoGrupo[] }> {
  const d = Math.max(1, Math.min(365, Math.round(Number(dias) || 30)));

  /*
   * FILTRO DE PLATAFORMA. Os grupos postam de várias lojas — o grupo real que o
   * dono mostrou era 10 Amazon + 7 Mercado Livre e ZERO Shopee. Misturar tudo
   * num só perfil responde "de que eles falam", mas não "de que eles falam NA
   * SHOPEE", que é a única parte com que o motor compete. Por isso o padrão é
   * só Shopee, e o outro modo continua disponível — ligado por interruptor, não
   * apagado do código.
   */
  const filtroPlataforma = somenteShopee ? `AND p.platform_guess = 'shopee'` : '';

  const linhas = await query<{ group_id: string; nome: string; cat: string | null; n: string }>(
    `SELECT p.group_id::text AS group_id,
            coalesce(g.display_name, g.group_jid) AS nome,
            coalesce(m.obs_cat_raiz, ao.cat_raiz)  AS cat,
            count(*)::text AS n
       FROM intel_posts p
       JOIN intel_groups g  ON g.id = p.group_id AND g.is_active = true
       LEFT JOIN intel_matches m ON m.post_id = p.id AND m.verdict = 'casado'
       LEFT JOIN api_observations ao ON ao.id = m.observation_id
      WHERE p.posted_at >= now() - ($1 || ' days')::interval
        ${filtroPlataforma}
      GROUP BY 1, 2, 3`,
    [String(d)],
  );

  /*
   * A distribuição por PLATAFORMA é calculada SEMPRE sobre tudo, mesmo quando o
   * filtro está ligado. É ela que explica por que um grupo tem poucos posts
   * classificados — "só 12 de 300" pode significar matcher fraco OU que 288
   * eram de outra loja, e essas duas leituras levam a decisões opostas.
   */
  const plats = await query<{ group_id: string; plat: string | null; n: string }>(
    `SELECT p.group_id::text AS group_id, coalesce(p.platform_guess,'desconhecida') AS plat,
            count(*)::text AS n
       FROM intel_posts p
       JOIN intel_groups g ON g.id = p.group_id AND g.is_active = true
      WHERE p.posted_at >= now() - ($1 || ' days')::interval
      GROUP BY 1, 2`,
    [String(d)],
  );
  const platPorGrupo = new Map<string, Array<{ nome: string; n: number }>>();
  for (const l of plats) {
    const arr = platPorGrupo.get(l.group_id) ?? [];
    arr.push({ nome: l.plat ?? 'desconhecida', n: Number(l.n) });
    platPorGrupo.set(l.group_id, arr);
  }

  const porGrupo = new Map<string, { nome: string; cats: Map<string, number>; total: number }>();
  for (const l of linhas) {
    const g = porGrupo.get(l.group_id) ?? { nome: l.nome, cats: new Map(), total: 0 };
    const n = Number(l.n);
    g.total += n;
    if (l.cat) g.cats.set(l.cat, (g.cats.get(l.cat) ?? 0) + n);
    porGrupo.set(l.group_id, g);
  }

  const grupos: NichoGrupo[] = [...porGrupo.entries()].map(([groupId, g]) => {
    const classificados = [...g.cats.values()].reduce((a, b) => a + b, 0);
    const cats = [...g.cats.entries()]
      .map(([nome, n]) => ({ nome, n, pct: classificados ? Math.round((n / classificados) * 100) : 0 }))
      .sort((a, b) => b.n - a.n);

    /*
     * Concentração = soma dos quadrados das frações (Herfindahl). Escolhido em
     * vez de "só a fatia da maior" porque distingue dois casos que a maior
     * fatia confunde: 40/30/30 e 40/2/2/2... têm a mesma líder e comportamentos
     * opostos. Vai de ~0 (espalhado) a 1 (tudo numa categoria só).
     */
    const concentracao = classificados
      ? Number(cats.reduce((acc, c) => acc + (c.n / classificados) ** 2, 0).toFixed(3))
      : null;

    let perfil: NichoGrupo['perfil'] = 'amostra_pequena';
    if (classificados >= MIN_PARA_ROTULAR && concentracao != null) {
      if (concentracao >= 0.5) perfil = 'especialista';
      else if (concentracao >= 0.22) perfil = 'misto';
      else perfil = 'generalista';
    }

    const plataformas = (platPorGrupo.get(groupId) ?? []).sort((a, b) => b.n - a.n);
    const totalPlat = plataformas.reduce((a, b) => a + b.n, 0);
    const daShopee = plataformas.find((p) => p.nome === 'shopee')?.n ?? 0;

    return {
      groupId,
      nome: g.nome,
      postsClassificados: classificados,
      postsTotal: g.total,
      categorias: cats.slice(0, 8),
      concentracao,
      categoriasDistintas: cats.length,
      perfil,
      principal: cats[0]?.nome ?? null,
      plataformas: plataformas.map((p) => ({
        nome: p.nome, n: p.n, pct: totalPlat ? Math.round((p.n / totalPlat) * 100) : 0,
      })),
      pctShopee: totalPlat ? Math.round((daShopee / totalPlat) * 100) : 0,
      postsNaJanela: totalPlat,
    };
  });

  grupos.sort((a, b) => b.postsClassificados - a.postsClassificados);
  return { dias: d, somenteShopee, grupos };
}
