import { loadConfig, type Config } from '../config';
import { log } from '../logger';
import { query, queryOne } from '../db';
import { productOfferV2 } from '../shopee/queries';
import { normalizeProduct } from '../pipeline/normalize';
import { normalizeText } from '../util';
import type { NormalizedOffer, RejectResult } from '../types';
import {
  matchesKeyword,
  rejectByPriceFloor,
  rejectByCommissionValue,
  rejectBySocialProof,
  rejectByKeyword,
  rejectByExcludedWord,
} from '../pipeline/filters';

/**
 * Varredura LARGA de inteligência de mercado — o oposto da captura de
 * produção (`src/capture/shopeeFeed.ts`), que é estreita de propósito (16 das
 * 48 keywords por ciclo, filtra tudo, guarda só ~10 finalistas). Aqui a ideia
 * é registrar o CARDÁPIO inteiro que a Shopee ofereceu, sem descartar nada:
 * passa pelas 48 keywords e grava cada item em `api_observations`. Os
 * filtros de produção ainda rodam por item, mas só para ROTULAR a linha
 * (`would_pass`/`reject_reason`) — nunca para decidir o que gravar. É a
 * matéria-prima para, depois, comparar com o que os concorrentes escolheram
 * postar do mesmo cardápio (fora deste arquivo: `intel_posts`/`intel_matches`).
 */

export interface SweepStats {
  keywords: number; // quantas keywords foram varridas
  fetched: number; // itens que a API devolveu (bruto, com repetição entre keywords)
  observed: number; // linhas realmente gravadas (após ON CONFLICT DO NOTHING)
  wouldPass: number; // quantas teriam passado nos filtros de produção
  errors: number; // keywords que falharam
  ms: number;
}

/** Uma linha pronta para `api_observations`, já com o veredito dos filtros. */
interface LinhaObservacao {
  platform: string;
  productId: string;
  shopId: string | null;
  title: string;
  titleNorm: string;
  price: number | null;
  commissionRate: number | null;
  commissionBrl: number | null;
  advertisedDiscountPct: number | null;
  sales: number | null;
  ratingStar: number | null;
  keyword: string;
  imageUrl: string | null;
  offerLink: string | null;
  wouldPass: boolean;
  rejectReason: string | null;
}

/**
 * Trava de execução única — mesmo padrão de `cicloEmAndamento` em
 * `shopeeFeed.ts`. Nome distinto do getter exportado logo abaixo
 * (`varreduraAtual` vs. `varreduraEmAndamento`) de propósito: os dois não
 * podem se chamar igual no mesmo módulo. Sem a trava, um clique duplo no
 * painel — ou um cron sobrepondo o anterior, já que 48 keywords sequenciais
 * podem passar de um minuto — dispararia duas varreduras em paralelo contra
 * a Shopee.
 */
let varreduraAtual: Promise<SweepStats> | null = null;

export function varreduraEmAndamento(): boolean {
  return varreduraAtual !== null;
}

/** Ponto de entrada seguro: se já há varredura rodando, devolve a MESMA promessa. */
export function runSweepExclusivo(trigger = 'cron'): Promise<SweepStats> {
  if (varreduraAtual) {
    log.warn('varredura de inteligência já em andamento — pedido ignorado', { trigger });
    return varreduraAtual;
  }
  varreduraAtual = runSweep(trigger).finally(() => {
    varreduraAtual = null;
  });
  return varreduraAtual;
}

/**
 * Roda os MESMOS filtros da captura de produção, na MESMA ordem — mas aqui o
 * veredito nunca descarta a linha, só a rotula. É o que permite perguntar
 * depois "quantas ofertas que os concorrentes postam o nosso filtro atual
 * teria reprovado?". Motivo de "fora do nicho" é FIXO (não o texto dinâmico de
 * `rejectByRelevance`, que embutiria a keyword no texto e fragmentaria o
 * agregado por palavra-chave em vez de por motivo).
 */
function avaliarFiltrosProducao(
  offer: NormalizedOffer,
  keyword: string,
  cfg: Config,
): { wouldPass: boolean; reason: string | null } {
  if (cfg.CAPTURE_REQUIRE_KEYWORD_MATCH && !matchesKeyword(offer.title, keyword)) {
    return { wouldPass: false, reason: 'fora do nicho' };
  }
  const checks: RejectResult[] = [
    rejectByPriceFloor(offer, cfg.CAPTURE_MIN_PRICE),
    rejectByCommissionValue(offer, cfg.CAPTURE_MIN_COMMISSION_BRL),
    rejectBySocialProof(offer, cfg.CAPTURE_MIN_SALES, cfg.CAPTURE_MIN_RATING),
    rejectByKeyword(offer, cfg),
    rejectByExcludedWord(offer, cfg),
  ];
  const falhou = checks.find((c) => c.rejected);
  if (falhou) {
    // Números -> 'N' para o motivo ser AGREGÁVEL (senão "R$0,32 < R$0,50" e
    // "R$0,41 < R$0,50" viram dois motivos diferentes no agregado do painel).
    return { wouldPass: false, reason: falhou.reason?.replace(/\d+([.,]\d+)?/g, 'N') ?? 'filtro' };
  }
  return { wouldPass: true, reason: null };
}

/** Ordem fixa das colunas do INSERT em lote — precisa bater com `valores` em `inserirLote`. */
const COLUNAS = [
  'sweep_id',
  'platform',
  'product_id',
  'shop_id',
  'title',
  'title_norm',
  'price',
  'commission_rate',
  'commission_brl',
  'advertised_discount_pct',
  'sales',
  'rating_star',
  'keyword',
  'image_url',
  'offer_link',
  'would_pass',
  'reject_reason',
] as const;

// 17 colunas x 100 linhas = 1.700 parâmetros por INSERT — bem abaixo do teto
// de 65535 do Postgres. O bloco existe para nunca DEPENDER desse teto, mesmo
// se INTEL_SWEEP_LIMIT crescer no futuro.
const LOTE_MAX = 100;

/**
 * Grava em blocos de até `LOTE_MAX` linhas (1 INSERT multi-VALUES por bloco,
 * não 1 query por item — uma varredura de 48 keywords x `INTEL_SWEEP_LIMIT`
 * já soma centenas de itens). `ON CONFLICT ... DO NOTHING` porque o MESMO
 * produto pode aparecer em duas keywords da mesma varredura (ex.: "fone de
 * ouvido" e "headset gamer"); a primeira grava, a segunda é ignorada — e o
 * Postgres aceita isso mesmo quando as duas linhas conflitantes estão no
 * MESMO INSERT (só a primeira sobrevive; sem erro, ao contrário de DO UPDATE).
 * Conta só o que foi REALMENTE inserido via RETURNING, senão `observed`
 * incluiria também os ignorados pelo conflito.
 */
async function inserirLote(sweepId: string, linhas: LinhaObservacao[]): Promise<number> {
  let inseridas = 0;
  for (let offset = 0; offset < linhas.length; offset += LOTE_MAX) {
    const bloco = linhas.slice(offset, offset + LOTE_MAX);
    const params: unknown[] = [];
    const grupos: string[] = [];
    for (const linha of bloco) {
      const valores: unknown[] = [
        sweepId,
        linha.platform,
        linha.productId,
        linha.shopId,
        linha.title,
        linha.titleNorm,
        linha.price,
        linha.commissionRate,
        linha.commissionBrl,
        linha.advertisedDiscountPct,
        linha.sales,
        linha.ratingStar,
        linha.keyword,
        linha.imageUrl,
        linha.offerLink,
        linha.wouldPass,
        linha.rejectReason,
      ];
      const marcadores = valores.map((_, i) => `$${params.length + i + 1}`);
      grupos.push(`(${marcadores.join(', ')})`);
      params.push(...valores);
    }
    const inseridasBloco = await query<{ id: string }>(
      `INSERT INTO api_observations (${COLUNAS.join(', ')})
       VALUES ${grupos.join(', ')}
       ON CONFLICT (sweep_id, platform, product_id) DO NOTHING
       RETURNING id`,
      params,
    );
    inseridas += inseridasBloco.length;
  }
  return inseridas;
}

/**
 * Uma varredura completa: TODAS as keywords de `CAPTURE_KEYWORDS` (não a
 * rotação de 16/ciclo da produção — aqui o objetivo é o cardápio inteiro),
 * uma de cada vez. Sequencial por escolha: `productOfferV2` já serializa
 * dentro do freio de taxa (`src/shopee/throttle.ts`), mas paralelizar AQUI
 * com Promise.all voltaria a empilhar rajadas na frente do freio — a mesma
 * causa raiz do erro 10030 já visto neste projeto.
 */
export async function runSweep(trigger = 'cron'): Promise<SweepStats> {
  const cfg = loadConfig();
  const t0 = Date.now();

  if (!cfg.INTEL_ENABLED) {
    log.info('varredura de inteligência desligada (INTEL_ENABLED=false) — nada feito', { trigger });
    return { keywords: 0, fetched: 0, observed: 0, wouldPass: 0, errors: 0, ms: Date.now() - t0 };
  }

  const keywords = cfg.CAPTURE_KEYWORDS.split(',').map((k) => k.trim()).filter(Boolean);
  const stats: SweepStats = {
    keywords: keywords.length,
    fetched: 0,
    observed: 0,
    wouldPass: 0,
    errors: 0,
    ms: 0,
  };
  // Cortes agregados por motivo — só entra no JSON gravado em
  // `intel_sweeps.stats` (para o painel explicar o corte); não faz parte do
  // contrato de retorno (`SweepStats`) porque o chamador não precisa disso.
  const cut: Record<string, number> = {};

  // Fora do try: se nem essa INSERT funcionar (banco fora do ar), não existe
  // linha nenhuma para gravar o erro depois — deixa propagar puro.
  const sweepRow = await queryOne<{ id: string }>(
    `INSERT INTO intel_sweeps (trigger, keywords) VALUES ($1, $2) RETURNING id`,
    [trigger, keywords.length],
  );
  const sweepId = sweepRow?.id ?? null;

  try {
    for (const keyword of keywords) {
      try {
        const page = await productOfferV2({
          keyword,
          sortType: cfg.CAPTURE_SORT_TYPE,
          limit: cfg.INTEL_SWEEP_LIMIT,
        });
        stats.fetched += page.nodes.length;

        const linhas: LinhaObservacao[] = page.nodes.map((node) => {
          const offer = normalizeProduct(node);
          const veredito = avaliarFiltrosProducao(offer, keyword, cfg);
          if (veredito.wouldPass) stats.wouldPass += 1;
          if (veredito.reason) cut[veredito.reason] = (cut[veredito.reason] ?? 0) + 1;
          const commissionBrl =
            offer.price != null && offer.commissionRate != null
              ? offer.price * offer.commissionRate
              : null;
          return {
            platform: offer.platform,
            productId: offer.productId,
            shopId: offer.shopId,
            title: offer.title,
            titleNorm: normalizeText(offer.title),
            price: offer.price,
            commissionRate: offer.commissionRate,
            commissionBrl,
            advertisedDiscountPct: offer.discountPct,
            sales: offer.sales,
            ratingStar: offer.ratingStar,
            keyword,
            imageUrl: offer.imageUrl,
            offerLink: offer.offerLink,
            wouldPass: veredito.wouldPass,
            rejectReason: veredito.reason,
          };
        });

        if (sweepId && linhas.length > 0) {
          stats.observed += await inserirLote(sweepId, linhas);
        }
      } catch (err) {
        // Uma keyword ruim (erro de API, timeout) não pode derrubar a
        // varredura inteira — ela existe justamente para cobrir TODAS as 48.
        stats.errors += 1;
        log.error('varredura falhou para keyword', {
          keyword,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    stats.ms = Date.now() - t0;
    if (sweepId) {
      await query(
        `UPDATE intel_sweeps SET finished_at = now(), observed = $2, keywords = $3, stats = $4 WHERE id = $1`,
        [sweepId, stats.observed, stats.keywords, JSON.stringify({ ...stats, cut })],
      );
    }
    log.info('varredura de inteligência concluída', { ...stats, cut });
    return stats;
  } catch (err) {
    // Só chega aqui algo SISTÊMICO (ex.: banco caiu no meio do loop) — erro de
    // keyword já foi contido no catch de dentro. Grava o erro na própria
    // varredura e re-lança para o chamador (cron/rota) saber que algo sério
    // aconteceu, em vez de engolir silenciosamente.
    stats.ms = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    if (sweepId) {
      await query(
        `UPDATE intel_sweeps SET finished_at = now(), observed = $2, stats = $3, error = $4 WHERE id = $1`,
        [sweepId, stats.observed, JSON.stringify({ ...stats, cut }), msg],
      );
    }
    log.error('varredura de inteligência falhou', { trigger, err: msg });
    throw err;
  }
}

/**
 * Poda `api_observations` além da retenção configurada — sem isso a tabela
 * cresce sem limite (uma varredura de 48 keywords já grava centenas de linhas
 * a cada ~2h). `INTEL_RETENTION_DAYS <= 0` desliga a poda (não apaga nada,
 * devolve 0) — mesmo padrão de "0 desliga a trava" usado no resto do config
 * (ex.: `CAPTURE_BACKLOG_MAX`).
 */
export async function podarObservacoes(): Promise<number> {
  const cfg = loadConfig();
  if (cfg.INTEL_RETENTION_DAYS <= 0) {
    log.info('poda de observações desligada (INTEL_RETENTION_DAYS <= 0)');
    return 0;
  }
  const dias = String(cfg.INTEL_RETENTION_DAYS);
  const apagadas = await query<{ id: string }>(
    `DELETE FROM api_observations
      WHERE observed_at < now() - ($1 || ' days')::interval
      RETURNING id`,
    [dias],
  );
  // Varreduras que ficaram sem NENHUMA observação viva — todas podadas acima
  // (por isso esta consulta roda DEPOIS: pega tanto as recém-esvaziadas
  // agora quanto as que já eram órfãs antes) ou porque a varredura falhou sem
  // gravar nenhuma linha — e já são velhas o bastante. Sem isso `intel_sweeps`
  // cresce para sempre em paralelo, mesmo com `api_observations` sob controle.
  const sweepsApagadas = await query<{ id: string }>(
    `DELETE FROM intel_sweeps s
      WHERE s.started_at < now() - ($1 || ' days')::interval
        AND NOT EXISTS (SELECT 1 FROM api_observations o WHERE o.sweep_id = s.id)
      RETURNING id`,
    [dias],
  );
  log.info('poda de observações concluída', {
    observacoesApagadas: apagadas.length,
    varredurasApagadas: sweepsApagadas.length,
    retentionDays: cfg.INTEL_RETENTION_DAYS,
  });
  return apagadas.length;
}
