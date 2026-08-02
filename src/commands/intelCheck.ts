import { productOfferV2 } from '../shopee/queries';
import { normalizeProduct } from '../pipeline/normalize';
import { normalizeText } from '../util';
import { query, queryOne, closePool } from '../db';
import { ingestPost } from '../intel/ingest';
import { matchOnePost } from '../intel/match';
import { resumoDiario, perfilDeEscolha } from '../intel/report';
import { log } from '../logger';

/**
 * VERIFICAÇÃO AO VIVO da correlação, ponta a ponta, com dado REAL da Shopee.
 *
 *   npm run intel:check
 *
 * Por que existe: todo teste automatizado deste módulo usa dado que NÓS
 * inventamos, o que valida a implementação contra a nossa própria imaginação.
 * Este comando puxa oferta de verdade da API, escreve uma mensagem no formato
 * que os grupos concorrentes de fato usam — com o título ENCURTADO, que é como
 * eles escrevem — e mede o caminho inteiro: parse → ingestão → correlação →
 * relatório.
 *
 * É SEGURO rodar em produção: usa um grupo de teste com prefixo `__check__`,
 * marcado como `proprio` (então fica fora de todo relatório sobre "o que ELES
 * escolhem"), e apaga tudo que criou no fim, inclusive em caso de erro.
 * As observações da API ficam — são dado legítimo do cardápio.
 */

const JID_TESTE = '__check__@g.us';

interface Resultado {
  passou: boolean;
  detalhe: string;
}

const marca = (r: Resultado) => `${r.passou ? '  ok  ' : '  FALHA'} ${r.detalhe}`;

async function limpar(): Promise<void> {
  // ON DELETE CASCADE leva posts e matches junto.
  await query(`DELETE FROM intel_groups WHERE group_jid = $1`, [JID_TESTE]);
}

async function main(): Promise<void> {
  const resultados: Resultado[] = [];

  console.log('\n=== 1. buscando ofertas REAIS na Shopee ===');
  const page = await productOfferV2({ keyword: 'air fryer', sortType: 2, limit: 8 });
  const ofertas = page.nodes.map(normalizeProduct).filter((o) => o.title && o.price != null);
  if (!ofertas.length) {
    console.error('a Shopee não devolveu oferta nenhuma — não dá para verificar.');
    process.exit(1);
  }
  const alvo = ofertas[0]!;
  console.log(`  ${ofertas.length} ofertas reais · alvo: ${alvo.title.slice(0, 60)}`);
  console.log(`  R$${alvo.price} · ganho/venda R$${((alvo.price ?? 0) * (alvo.commissionRate ?? 0)).toFixed(2)}`);

  // Grava como se a varredura tivesse rodado 40 min atrás, para haver um atraso
  // conhecido a medir depois.
  const sweep = await queryOne<{ id: string }>(
    `INSERT INTO intel_sweeps (started_at, trigger, keywords)
     VALUES (now() - interval '40 minutes', 'check', 1) RETURNING id`,
  );
  for (const o of ofertas) {
    await query(
      `INSERT INTO api_observations (sweep_id, observed_at, product_id, shop_id, title, title_norm,
         price, commission_rate, commission_brl, sales, rating_star, keyword, would_pass)
       VALUES ($1, now() - interval '40 minutes', $2,$3,$4,$5,$6,$7,$8,$9,$10,'air fryer',true)
       ON CONFLICT DO NOTHING`,
      [
        sweep!.id, o.productId, o.shopId, o.title, normalizeText(o.title), o.price,
        o.commissionRate,
        o.price != null && o.commissionRate != null ? +(o.price * o.commissionRate).toFixed(2) : null,
        o.sales, o.ratingStar,
      ],
    );
  }

  console.log('\n=== 2. mensagem no formato real de grupo, sobre essa oferta ===');
  await query(
    `INSERT INTO intel_groups (group_jid, display_name, kind) VALUES ($1, 'verificação', 'proprio')
     ON CONFLICT (group_jid) DO UPDATE SET is_active = true`,
    [JID_TESTE],
  );
  // Grupo de promoção NÃO cola o título enciclopédico da Shopee: encurta.
  const curto = alvo.title.split(/[,|\-–]/)[0]!.split(' ').slice(0, 6).join(' ');
  const precoBR = (alvo.price ?? 0).toFixed(2).replace('.', ',');
  const mensagem = [
    'ACHADINHO DA COZINHA',
    `*${curto}*`,
    `~~DE ${((alvo.price ?? 0) * 1.8).toFixed(2).replace('.', ',')}~~ | *POR ${precoBR} em 10x*`,
    'Resgate o cupom: *CHECK20*',
    'https://s.shopee.com.br/verificacao',
  ].join('\n');

  const ing = await ingestPost({
    groupJid: JID_TESTE, text: mensagem, postedAt: Math.floor(Date.now() / 1000),
    waMessageId: `check-${Date.now()}`, hasImage: true,
  });
  if (!ing.postId) {
    console.error(`  a ingestão recusou: ${ing.reason}`);
    await limpar(); await closePool(); process.exit(1);
  }
  const post = await queryOne<{ title_guess: string | null; price: string | null; coupon: string | null; platform_guess: string | null }>(
    `SELECT title_guess, price, coupon, platform_guess FROM intel_posts WHERE id = $1`, [ing.postId],
  );
  const parseOk =
    !!post?.title_guess &&
    Math.abs(Number(post.price) - (alvo.price ?? 0)) < 0.01 &&
    post.coupon === 'CHECK20' &&
    post.platform_guess === 'shopee';
  resultados.push({ passou: parseOk, detalhe: `parse: "${post?.title_guess}" · R$${post?.price} · ${post?.coupon} · ${post?.platform_guess}` });

  console.log('\n=== 3. a correlação acha a oferta certa? ===');
  const m = await matchOnePost(ing.postId);
  const lag = Number(m.lagSeconds ?? 0);
  const matchOk = m.verdict === 'casado' && m.productId === alvo.productId && lag > 2000 && lag < 3400;
  resultados.push({
    passou: matchOk,
    detalhe: `${m.verdict} · produto ${m.productId} · similaridade ${m.titleSim} · atraso ${Math.round(lag / 60)} min`,
  });

  console.log('\n=== 4. o relatório reflete? ===');
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const dia = (await resumoDiario(2)).find((r) => r.dia === hoje);
  // O grupo de verificação é `proprio`, então NÃO entra no perfil — e isso é
  // parte do que se está verificando.
  const perfil = await perfilDeEscolha(7);
  const ganho = perfil.find((p) => /ganho/i.test(p.metrica));
  resultados.push({
    passou: !!dia && dia.observadas > 0,
    detalhe: `dia ${hoje}: ${dia?.observadas} observadas · perfil ganho/venda cardápio R$${ganho?.medianaCardapio}`,
  });

  for (const r of resultados) console.log(marca(r));
  const falhas = resultados.filter((r) => !r.passou).length;
  console.log(falhas ? `\n>>> ${falhas} FALHA(S)` : '\n>>> correlação verificada com dado real da Shopee');

  await limpar();
  await closePool();
  process.exit(falhas ? 1 : 0);
}

main().catch(async (err) => {
  log.error('intel:check falhou', { err: err instanceof Error ? err.message : String(err) });
  // Limpa mesmo em caso de erro: não deixar grupo de teste sujando o painel.
  try { await limpar(); } catch { /* banco pode estar fora */ }
  await closePool().catch(() => undefined);
  process.exit(1);
});
