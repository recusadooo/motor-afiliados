import { query, queryOne } from '../db';
import { log } from '../logger';

/**
 * ÁRVORE DE CATEGORIAS OFICIAL DA SHOPEE BR.
 *
 * Por que existe: o `productOfferV2` devolve `productCatIds` (níveis 1 a 3),
 * mas SÓ os ids — não há nenhuma query na API de afiliados que traduza id em
 * nome (verificado no explorer oficial: 9 operações, nenhuma de categoria). O
 * único mapa id→nome acessível com as credenciais deste projeto é a árvore
 * pública que alimenta o site da Shopee.
 *
 * É isso que substitui o rótulo raso "promoção genérica": em vez de o dono
 * chutar um tipo para o grupo, a categoria vem carimbada pela própria Shopee,
 * na captura, sem custo de inferência.
 *
 * LIMITE conhecido e medido: o endpoint público expõe apenas os níveis 1 e 2
 * (31 e 253 categorias). Ids de nível 3 que vierem em `productCatIds` não terão
 * nome — por isso a resolução cai para o nível mais específico QUE TEM nome, em
 * vez de devolver vazio.
 */

const URL_ARVORE = 'https://shopee.com.br/api/v4/pages/get_category_tree';

interface NoCategoria {
  catid: number;
  parent_catid: number;
  display_name: string;
  level: number;
  children?: NoCategoria[] | null;
}

/** Guarda a árvore no banco: a captura não pode depender de uma chamada externa. */
export async function sincronizarCategorias(): Promise<{ nivel1: number; nivel2: number }> {
  const r = await fetch(URL_ARVORE, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`árvore de categorias respondeu HTTP ${r.status}`);
  const j = (await r.json()) as { error?: number; data?: { category_list?: NoCategoria[] } };
  if (j.error) throw new Error(`árvore de categorias devolveu error=${j.error}`);
  const lista = j.data?.category_list ?? [];
  if (!lista.length) throw new Error('árvore de categorias veio vazia');

  const linhas: Array<[number, number, string, number]> = [];
  for (const c of lista) {
    linhas.push([c.catid, 0, c.display_name, 1]);
    for (const f of c.children ?? []) linhas.push([f.catid, c.catid, f.display_name, 2]);
  }

  const vals = linhas.map((_, i) => `($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4})`).join(',');
  await query(
    `INSERT INTO shopee_categories (cat_id, parent_id, nome, nivel) VALUES ${vals}
     ON CONFLICT (cat_id) DO UPDATE SET nome = EXCLUDED.nome,
       parent_id = EXCLUDED.parent_id, nivel = EXCLUDED.nivel, atualizado_em = now()`,
    linhas.flat(),
  );
  const n1 = linhas.filter((l) => l[3] === 1).length;
  log.info('categorias da Shopee sincronizadas', { nivel1: n1, nivel2: linhas.length - n1 });
  return { nivel1: n1, nivel2: linhas.length - n1 };
}

/** Quantas categorias já estão guardadas (0 = nunca sincronizou). */
export async function categoriasGuardadas(): Promise<number> {
  const r = await queryOne<{ n: string }>(`SELECT count(*) AS n FROM shopee_categories`);
  return Number(r?.n ?? 0);
}

/**
 * Resolve `productCatIds` para a categoria mais específica QUE TEM NOME.
 *
 * A lista vem do mais geral para o mais específico (l1→l3). Percorrer de trás
 * para frente e parar no primeiro que existe dá a melhor granularidade
 * disponível sem devolver vazio quando o nível 3 não está no mapa público.
 */
export async function resolverCategoria(
  catIds: Array<number | string> | null | undefined,
): Promise<{ catId: number; nome: string; nivel: number; raizNome: string | null } | null> {
  const ids = (catIds ?? []).map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return null;
  const linhas = await query<{ cat_id: string; nome: string; nivel: number; parent_id: string }>(
    `SELECT cat_id::text, nome, nivel, parent_id::text FROM shopee_categories WHERE cat_id = ANY($1::bigint[])`,
    [ids],
  );
  if (!linhas.length) return null;
  const porId = new Map(linhas.map((l) => [Number(l.cat_id), l]));
  for (let i = ids.length - 1; i >= 0; i--) {
    const achou = porId.get(ids[i]!);
    if (!achou) continue;
    const raiz = achou.nivel === 1 ? achou : porId.get(Number(achou.parent_id)) ?? null;
    return {
      catId: Number(achou.cat_id),
      nome: achou.nome,
      nivel: achou.nivel,
      raizNome: raiz ? raiz.nome : null,
    };
  }
  return null;
}

/**
 * Resolve VÁRIAS listas de ids numa consulta só.
 *
 * A varredura larga passa de 900 itens por rodada; uma consulta por produto
 * seria 900 idas ao banco para um mapa de 284 linhas que quase não muda. Aqui
 * carrega o mapa inteiro uma vez e resolve em memória.
 *
 * A chave do retorno é `JSON.stringify(catIds)` — a lista inteira, não o id
 * final: produtos diferentes com o mesmo l3 mas l1 diferente existem, e usar só
 * o último id perderia a raiz correta.
 */
export async function resolverCategoriasEmLote(
  listas: Array<Array<number | string> | null | undefined>,
): Promise<Map<string, { catId: number; nome: string; nivel: number; raizNome: string | null }>> {
  const saida = new Map<string, { catId: number; nome: string; nivel: number; raizNome: string | null }>();
  const usados = new Set<number>();
  for (const l of listas) for (const v of l ?? []) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) usados.add(n);
  }
  if (!usados.size) return saida;

  const linhas = await query<{ cat_id: string; nome: string; nivel: number; parent_id: string }>(
    `SELECT cat_id::text, nome, nivel, parent_id::text FROM shopee_categories WHERE cat_id = ANY($1::bigint[])`,
    [[...usados]],
  );
  if (!linhas.length) return saida;
  const porId = new Map(linhas.map((l) => [Number(l.cat_id), l]));

  for (const lista of listas) {
    const ids = (lista ?? []).map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
    const chave = JSON.stringify(ids);
    if (!ids.length || saida.has(chave)) continue;
    // do mais específico para o mais geral: para no primeiro que TEM nome
    for (let i = ids.length - 1; i >= 0; i--) {
      const achou = porId.get(ids[i]!);
      if (!achou) continue;
      const raiz = achou.nivel === 1 ? achou : porId.get(Number(achou.parent_id)) ?? null;
      saida.set(chave, {
        catId: Number(achou.cat_id),
        nome: achou.nome,
        nivel: achou.nivel,
        raizNome: raiz ? raiz.nome : null,
      });
      break;
    }
  }
  return saida;
}
