/* eslint-disable no-console */
import { loadConfig } from '../config';
import { productOfferV2, generateShortLink } from '../shopee/queries';
import { normalizeProduct, dedupKey } from '../pipeline/normalize';
import {
  rejectByKeyword,
  rejectByPriceSanity,
  rejectByPriceFloor,
  rejectByCommissionValue,
  rejectByExcludedWord,
  rejectByRelevance,
} from '../pipeline/filters';
import { assessDiscount, type DiscountAssessment } from '../pipeline/fakeDiscount';
import { copyWithoutAi, formatBRL } from '../pipeline/copy';
import type { PriceStats } from '../pipeline/priceHistory';
import type { NormalizedOffer } from '../types';

/**
 * DRY-RUN de validação (READ-ONLY, SEM banco, SEM Redis, SEM WhatsApp).
 * Puxa ofertas REAIS da Shopee e mostra, oferta por oferta, o que o filtro
 * decidiu e qual mensagem iria para o grupo. Serve para conferir o motor antes
 * de subir infra.
 *
 *   npm run dryrun                      # 6 keywords x 5 ofertas
 *   npm run dryrun -- 10 3 notebook,ssd # limite 10, 3 keywords, lista própria
 *
 * Nada é gravado e nada é postado. O único efeito externo possível é o teste
 * opcional de generateShortLink (1 link), que só acontece com o argumento
 * `--link`.
 */

const SEM_HISTORICO: PriceStats = { count: 0, min: null, median: null, max: null };

interface Linha {
  offer: NormalizedOffer;
  disc: DiscountAssessment;
  decisao: 'aprovada' | 'rejeitada' | 'duplicada';
  motivo?: string;
  keyword: string;
}

function pct(n: number | null | undefined): string {
  return n == null ? '—' : `${Math.round(n)}%`;
}

function corta(s: string, n: number): string {
  return s.length <= n ? s.padEnd(n) : `${s.slice(0, n - 1)}…`;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const testarLink = process.argv.includes('--link');
  const porKeyword = Number(args[0] ?? 5);
  const qtdKeywords = Number(args[1] ?? 6);
  const keywords = (args[2] ? args[2].split(',') : cfg.CAPTURE_KEYWORDS.split(','))
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, qtdKeywords);

  console.log('=== DRY-RUN — motor de afiliados (nada é gravado nem postado) ===');
  console.log(`Endpoint: ${cfg.SHOPEE_API_ENDPOINT}`);
  console.log(`AppId: ${cfg.SHOPEE_APP_ID ? '(carregado, valor oculto)' : '(AUSENTE)'}`);
  console.log(`Keywords (${keywords.length}): ${keywords.join(', ')}`);
  console.log(`Ofertas por keyword: ${porKeyword} | sortType: ${cfg.CAPTURE_SORT_TYPE} (2 = mais vendidos)`);
  console.log(
    `Filtros: ganho mínimo/venda R$${cfg.CAPTURE_MIN_COMMISSION_BRL.toFixed(2)} | piso de preço R$${cfg.CAPTURE_MIN_PRICE} | ` +
      `desconto anunciado >= ${cfg.FAKE_DISCOUNT_MAX_PCT}% = suspeito | relevância de título: ${cfg.CAPTURE_REQUIRE_KEYWORD_MATCH ? 'ON' : 'OFF'}`,
  );
  console.log('');

  const vistos = new Set<string>();
  const linhas: Linha[] = [];
  let erros = 0;

  for (const keyword of keywords) {
    try {
      const res = await productOfferV2({ keyword, sortType: cfg.CAPTURE_SORT_TYPE, limit: porKeyword });
      for (const node of res.nodes) {
        const offer = normalizeProduct(node);
        const disc = assessDiscount(offer, SEM_HISTORICO, cfg.FAKE_DISCOUNT_MAX_PCT);

        // Ordem igual à da produção: a captura corta o que está fora do nicho
        // ANTES de registrar a oferta — então esse item não conta como "visto"
        // e ainda pode entrar por outra keyword.
        if (cfg.CAPTURE_REQUIRE_KEYWORD_MATCH) {
          const rel = rejectByRelevance(offer, keyword);
          if (rel.rejected) {
            linhas.push({ offer, disc, decisao: 'rejeitada', motivo: rel.reason, keyword });
            continue;
          }
        }

        const dkey = dedupKey(offer);
        if (vistos.has(dkey)) {
          linhas.push({ offer, disc, decisao: 'duplicada', keyword });
          continue;
        }
        vistos.add(dkey);

        const checks = [
          rejectByPriceSanity(offer),
          rejectByPriceFloor(offer, cfg.CAPTURE_MIN_PRICE),
          rejectByCommissionValue(offer, cfg.CAPTURE_MIN_COMMISSION_BRL),
          rejectByKeyword(offer, cfg),
          rejectByExcludedWord(offer, cfg),
          offer.commissionRate != null && offer.commissionRate < cfg.CAPTURE_MIN_COMMISSION
            ? { rejected: true as const, reason: `comissão abaixo do mínimo (< ${cfg.CAPTURE_MIN_COMMISSION * 100}%)` }
            : { rejected: false as const },
        ];
        const falhou = checks.find((c) => c.rejected);
        const semLink = !offer.offerLink && !offer.sourceUrl;
        const motivo = falhou?.reason ?? (disc.fake ? disc.fakeReason : semLink ? 'sem link monetizável' : undefined);
        linhas.push({
          offer,
          disc,
          decisao: motivo ? 'rejeitada' : 'aprovada',
          motivo,
          keyword,
        });
      }
      console.log(`  ✓ "${keyword}": ${res.nodes.length} ofertas`);
    } catch (err) {
      erros += 1;
      console.log(`  ✗ "${keyword}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- Tabela ----
  console.log('');
  console.log('DEC  PREÇO       DESC.ANUN  COMISSÃO      GANHO/VENDA  TÍTULO');
  console.log('---  ----------  ---------  ------------  -----------  ------------------------------------');
  for (const l of linhas) {
    const o = l.offer;
    const ganho = o.price != null && o.commissionRate != null ? o.price * o.commissionRate : null;
    const dec = l.decisao === 'aprovada' ? ' ok' : l.decisao === 'duplicada' ? 'dup' : ' ✗ ';
    console.log(
      `${dec}  ${corta(formatBRL(o.price) || '—', 10)}  ${corta(pct(o.discountPct), 9)}  ` +
        `${corta(o.commissionRate != null ? `${(o.commissionRate * 100).toFixed(1)}%` : '—', 12)}  ` +
        `${corta(ganho != null ? formatBRL(ganho) : '—', 11)}  ${corta(o.title, 36)}`,
    );
    if (l.motivo) console.log(`     ↳ motivo: ${l.motivo}`);
  }

  // ---- Resumo ----
  const aprovadas = linhas.filter((l) => l.decisao === 'aprovada');
  const rejeitadas = linhas.filter((l) => l.decisao === 'rejeitada');
  const duplicadas = linhas.filter((l) => l.decisao === 'duplicada');
  const comComissao = aprovadas.filter((l) => (l.offer.commissionRate ?? 0) > 0);
  console.log('');
  console.log('=== RESUMO ===');
  console.log(`Coletadas: ${linhas.length} | aprovadas: ${aprovadas.length} | rejeitadas: ${rejeitadas.length} | duplicadas (mesmo produto em 2 keywords): ${duplicadas.length}`);
  console.log(`Keywords com erro de API: ${erros}`);
  if (rejeitadas.length) {
    const porMotivo = new Map<string, number>();
    for (const r of rejeitadas) {
      const k = (r.motivo ?? 'sem motivo').replace(/\d+([.,]\d+)?/g, 'N');
      porMotivo.set(k, (porMotivo.get(k) ?? 0) + 1);
    }
    console.log('Motivos de rejeição:');
    for (const [k, v] of [...porMotivo].sort((a, b) => b[1] - a[1])) console.log(`  ${v}x  ${k}`);
  }
  console.log(`Aprovadas com comissão > 0: ${comComissao.length}/${aprovadas.length}`);
  const ganhoMedio =
    comComissao.length > 0
      ? comComissao.reduce((s, l) => s + (l.offer.price ?? 0) * (l.offer.commissionRate ?? 0), 0) / comComissao.length
      : null;
  console.log(`Comissão média por venda entre as aprovadas: ${ganhoMedio != null ? formatBRL(ganhoMedio) : '—'}`);
  console.log('');
  console.log('NOTA IMPORTANTE (esperado, não é bug): sem price_history no banco, o motor');
  console.log('NÃO afirma "desconto real" — ele só sabe o desconto ANUNCIADO da Shopee, que');
  console.log('é inflado. Por isso nenhuma oferta vira prioritária (fura-fila) no 1º ciclo:');
  console.log('a mediana de preço se forma depois de alguns ciclos de captura.');

  // ---- Mensagens que iriam pro grupo ----
  console.log('');
  console.log('=== MENSAGEM QUE IRIA PRO GRUPO (copy sem IA — é o fallback) ===');
  for (const l of aprovadas.slice(0, 2)) {
    const { copy } = copyWithoutAi(l.offer, l.disc);
    console.log('---------------------------------------------');
    console.log(`${copy.headline}\n${copy.body}`);
    console.log(l.offer.offerLink ?? l.offer.sourceUrl ?? '(sem link)');
  }
  console.log('---------------------------------------------');
  console.log('(Com a chave da OpenAI configurada, a copy é reescrita pela IA — os NÚMEROS');
  console.log(' continuam vindo do app, não da IA: ela só recebe placeholders.)');

  // ---- Simulação de histórico: mostra o caminho "desconto real" + fura-fila ----
  const alvo = aprovadas.find((l) => l.offer.price != null);
  if (alvo) {
    const preco = alvo.offer.price as number;
    const fingido: PriceStats = { count: 5, min: preco, median: preco * 2.5, max: preco * 3 };
    const disc2 = assessDiscount(alvo.offer, fingido, cfg.FAKE_DISCOUNT_MAX_PCT);
    const prioritaria =
      disc2.confident &&
      ((disc2.realDiscountPct ?? 0) >= cfg.PRIORITY_MIN_DISCOUNT_PCT ||
        (disc2.realSavings ?? 0) >= cfg.PRIORITY_MIN_SAVINGS_BRL);
    console.log('');
    console.log('=== SIMULAÇÃO: a MESMA oferta com histórico de preço (mediana fingida = 2,5x) ===');
    console.log(`Produto: ${corta(alvo.offer.title, 50)}`);
    console.log(`Preço agora: ${formatBRL(preco)} | mediana simulada: ${formatBRL(fingido.median)}`);
    console.log(`-> desconto REAL: ${pct(disc2.realDiscountPct)} | economia: ${formatBRL(disc2.realSavings)} | confiável: ${disc2.confident}`);
    console.log(`-> fake? ${disc2.fake}${disc2.fakeReason ? ` (${disc2.fakeReason})` : ''}`);
    console.log(`-> FURA-FILA? ${prioritaria ? 'SIM' : 'não'} (regra: desconto real >= ${cfg.PRIORITY_MIN_DISCOUNT_PCT}% OU economia >= ${formatBRL(cfg.PRIORITY_MIN_SAVINGS_BRL)})`);
    const { copy } = copyWithoutAi(alvo.offer, disc2);
    console.log('Mensagem com desconto real:');
    console.log(`${copy.headline}\n${copy.body}`);
  }

  // ---- Teste opcional do gerador de link (único efeito externo) ----
  if (testarLink) {
    const comOrigem = aprovadas.find((l) => l.offer.sourceUrl);
    if (comOrigem?.offer.sourceUrl) {
      console.log('');
      console.log('=== TESTE generateShortLink (cria 1 link curto na sua conta) ===');
      try {
        const short = await generateShortLink(comOrigem.offer.sourceUrl, [cfg.SUBID_CAMPAIGN, 'dryrun']);
        console.log(`OK: ${short}`);
      } catch (err) {
        console.log(`FALHOU: ${err instanceof Error ? err.message : String(err)}`);
        console.log('(Sem problema: o pipeline cai no offerLink do feed, que já é de afiliado.)');
      }
    }
  } else {
    console.log('');
    console.log('(Para testar também o generateShortLink com subIds, rode com --link)');
  }
}

main().catch((err) => {
  console.error('FALHOU:', err instanceof Error ? err.message : err);
  process.exit(1);
});
