import { loadConfig } from '../config';
import { log } from '../logger';
import { query, queryOne } from '../db';
import { productOfferV2 } from '../shopee/queries';
import { normalizeProduct, contentHash, dedupKey } from '../pipeline/normalize';
import {
  matchesKeyword,
  rejectByKeyword,
  rejectByExcludedWord,
  rejectByPriceFloor,
  rejectByCommissionValue,
  rejectBySocialProof,
  similarityKey,
  offerScore,
} from '../pipeline/filters';
import { processOffer } from '../pipeline/process';
import { getProcessQueue } from '../queue/queues';
import { getSetting, setSetting } from '../settings';
import type { NormalizedOffer } from '../types';

const KEYWORD_OFFSET_KEY = 'capture_keyword_offset';

/**
 * Trava de execução única. `POST /api/capture/run` roda o ciclo no processo da
 * API, fora da fila — sem isso, N cliques no botão do painel = N ciclos
 * completos em paralelo, cada um com suas chamadas externas, e a trava de
 * backlog (checada só no início) não pega nenhum deles.
 */
let cicloEmAndamento: Promise<CaptureStats> | null = null;

export function capturaEmAndamento(): boolean {
  return cicloEmAndamento !== null;
}

/** Ponto de entrada seguro: se já há ciclo rodando, devolve o MESMO. */
export function runCaptureExclusivo(processInline = false, trigger = 'cron'): Promise<CaptureStats> {
  if (cicloEmAndamento) {
    log.warn('ciclo de captura já em andamento — pedido ignorado', { trigger });
    return cicloEmAndamento;
  }
  cicloEmAndamento = runCapture(processInline, trigger).finally(() => {
    cicloEmAndamento = null;
  });
  return cicloEmAndamento;
}

export interface CaptureStats {
  /** ofertas devolvidas pela Shopee (matéria-prima) */
  fetched: number;
  /** aprovadas pelos filtros e ranqueadas -> viraram candidatas */
  selected: number;
  /** gravadas como captura nova (não repetida) */
  captured: number;
  enqueued: number;
  processedInline: number;
  /** cortes, por motivo — é o que explica o feed no painel */
  cut: Record<string, number>;
  /** amostra de reprovados (título/preço/motivo) para o dono conferir o corte */
  samples: Array<{ title: string; price: number | null; reason: string }>;
  keywords: number;
  ms: number;
}

interface Candidate {
  offer: NormalizedOffer;
  keyword: string;
  score: number;
}

/**
 * Rotação de keywords: cada ciclo usa uma janela da lista e avança o ponteiro
 * (guardado em `settings`). Evita gastar 48 chamadas de API por ciclo e faz o
 * feed variar ao longo do dia em vez de ser sempre a mesma categoria.
 */
async function selecionarKeywords(todas: string[], porCiclo: number): Promise<string[]> {
  if (porCiclo <= 0) {
    log.warn('rotação de keywords DESLIGADA (CAPTURE_KEYWORDS_PER_CYCLE=0) — o ciclo vai usar TODAS as keywords', {
      keywords: todas.length,
    });
    return todas;
  }
  if (todas.length <= porCiclo) return todas;
  const atual = Number((await getSetting(KEYWORD_OFFSET_KEY)) ?? '0') || 0;
  const inicio = ((atual % todas.length) + todas.length) % todas.length;
  const janela: string[] = [];
  for (let i = 0; i < porCiclo; i++) janela.push(todas[(inicio + i) % todas.length]!);
  await setSetting(KEYWORD_OFFSET_KEY, String((inicio + porCiclo) % todas.length));
  return janela;
}

/** Fila de aprovadas ainda não enviadas — base da trava de backlog. */
async function backlogAprovado(): Promise<number> {
  const row = await queryOne<{ c: string }>(
    `SELECT count(*)::text AS c FROM offers WHERE status IN ('approved','queued','pending')`,
  );
  return row ? Number(row.c) : 0;
}

async function ensureShopeeSource(): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO sources (kind, external_ref, name, role)
     VALUES ('shopee_api', 'productOfferV2', 'Shopee Open API', 'production')
     ON CONFLICT (kind, external_ref) DO UPDATE SET is_active = true
     RETURNING id`,
  );
  return row!.id;
}

/**
 * Um ciclo de captura CONCISO.
 *
 * Antes: 48 keywords x 30 ofertas = até 1.440 itens por ciclo, cada um gerando
 * link de afiliado e chamada de IA — um ciclo real gerou 650 ofertas e não
 * terminava. Agora o funil é: buscar -> filtrar -> ranquear -> pegar as N
 * melhores POR KEYWORD -> deduplicar quase-iguais -> teto global.
 * Todo corte é contado e gravado em `capture_runs` para o painel explicar
 * por que o feed está do jeito que está.
 */
export async function runCapture(processInline = false, trigger = 'cron'): Promise<CaptureStats> {
  const cfg = loadConfig();
  const t0 = Date.now();
  const todas = cfg.CAPTURE_KEYWORDS.split(',').map((k) => k.trim()).filter(Boolean);
  const keywords = await selecionarKeywords(todas, cfg.CAPTURE_KEYWORDS_PER_CYCLE);
  const stats: CaptureStats = {
    fetched: 0,
    selected: 0,
    captured: 0,
    enqueued: 0,
    processedInline: 0,
    cut: {},
    samples: [],
    keywords: keywords.length,
    ms: 0,
  };
  const MAX_AMOSTRAS = 14;
  const cut = (motivo: string, offer?: NormalizedOffer) => {
    stats.cut[motivo] = (stats.cut[motivo] ?? 0) + 1;
    if (offer && stats.samples.length < MAX_AMOSTRAS) {
      stats.samples.push({ title: offer.title, price: offer.price, reason: motivo });
    }
  };

  const runRow = await queryOne<{ id: string }>(
    `INSERT INTO capture_runs (trigger) VALUES ($1) RETURNING id`,
    [trigger],
  );
  const runId = runRow?.id ?? null;

  // Trava de backlog: com a fila cheia, capturar mais só acumula (o gotejamento
  // posta ~2-3 por hora). Pula o ciclo inteiro e registra o motivo.
  const backlog = await backlogAprovado();
  if (cfg.CAPTURE_BACKLOG_MAX > 0 && backlog >= cfg.CAPTURE_BACKLOG_MAX) {
    stats.ms = Date.now() - t0;
    cut(`fila cheia: ${backlog} na fila (teto ${cfg.CAPTURE_BACKLOG_MAX})`);
    if (runId) {
      await query(`UPDATE capture_runs SET finished_at = now(), stats = $2 WHERE id = $1`, [
        runId,
        JSON.stringify({ ...stats, skipped: true, backlog }),
      ]);
    }
    log.info('ciclo pulado — fila cheia', { backlog, teto: cfg.CAPTURE_BACKLOG_MAX });
    return stats;
  }

  // ---- 1) buscar + filtrar + ranquear por keyword ----
  const candidatos: Candidate[] = [];
  for (const keyword of keywords) {
    let page;
    try {
      page = await productOfferV2({
        keyword,
        sortType: cfg.CAPTURE_SORT_TYPE,
        limit: cfg.CAPTURE_LIMIT,
      });
    } catch (err) {
      log.error('captura falhou para keyword', {
        keyword,
        err: err instanceof Error ? err.message : String(err),
      });
      cut('erro de API');
      continue;
    }

    const daKeyword: Candidate[] = [];
    for (const node of page.nodes) {
      stats.fetched += 1;
      const offer = normalizeProduct(node);

      if (cfg.CAPTURE_REQUIRE_KEYWORD_MATCH && !matchesKeyword(offer.title, keyword)) {
        cut('fora do nicho', offer);
        continue;
      }
      const checks: Array<{ rejected: boolean; reason?: string }> = [
        rejectByPriceFloor(offer, cfg.CAPTURE_MIN_PRICE),
        rejectByCommissionValue(offer, cfg.CAPTURE_MIN_COMMISSION_BRL),
        rejectBySocialProof(offer, cfg.CAPTURE_MIN_SALES, cfg.CAPTURE_MIN_RATING),
        rejectByKeyword(offer, cfg),
        rejectByExcludedWord(offer, cfg),
      ];
      const falhou = checks.find((c) => c.rejected);
      if (falhou) {
        cut(falhou.reason?.replace(/\d+([.,]\d+)?/g, 'N') ?? 'filtro', offer);
        continue;
      }
      if (offer.commissionRate != null && offer.commissionRate < cfg.CAPTURE_MIN_COMMISSION) {
        cut('comissão abaixo do mínimo', offer);
        continue;
      }
      daKeyword.push({ offer, keyword, score: offerScore(offer) });
    }

    // as N melhores DESTA keyword (é o corte que acaba com "30 fones iguais")
    daKeyword.sort((a, b) => b.score - a.score);
    const mantidas = daKeyword.slice(0, cfg.CAPTURE_TOP_PER_KEYWORD);
    for (let i = cfg.CAPTURE_TOP_PER_KEYWORD; i < daKeyword.length; i++)
      cut('excedeu o teto da keyword', daKeyword[i]!.offer);
    candidatos.push(...mantidas);
  }

  // ---- 2) deduplicar quase-iguais entre keywords (mantém a de maior nota) ----
  let finalistas = candidatos;
  if (cfg.CAPTURE_DEDUP_SIMILAR) {
    const porAssinatura = new Map<string, Candidate>();
    for (const c of candidatos.sort((a, b) => b.score - a.score)) {
      const k = similarityKey(c.offer.title) || c.offer.productId;
      if (porAssinatura.has(k)) {
        cut('quase-duplicata', c.offer);
        continue;
      }
      porAssinatura.set(k, c);
    }
    finalistas = [...porAssinatura.values()];
  }

  // ---- 3) teto global do ciclo ----
  finalistas.sort((a, b) => b.score - a.score);
  if (finalistas.length > cfg.CAPTURE_MAX_PER_CYCLE) {
    for (let i = cfg.CAPTURE_MAX_PER_CYCLE; i < finalistas.length; i++)
      cut('excedeu o teto do ciclo', finalistas[i]!.offer);
    finalistas = finalistas.slice(0, cfg.CAPTURE_MAX_PER_CYCLE);
  }
  stats.selected = finalistas.length;

  // ---- 4) gravar / enfileirar ----
  const sourceId = await ensureShopeeSource();
  for (const { offer, keyword } of finalistas) {
    const ch = contentHash(offer);
    const inserted = await queryOne<{ id: string }>(
      `INSERT INTO raw_captures (source_id, raw_payload, raw_url, content_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (source_id, content_hash) DO NOTHING
       RETURNING id`,
      [sourceId, JSON.stringify({ ...offer, keyword }), offer.sourceUrl, ch],
    );
    if (!inserted) {
      cut('captura repetida');
      continue;
    }
    stats.captured += 1;

    if (processInline) {
      const outcome = await processOffer(offer, inserted.id, keyword);
      stats.processedInline += 1;
      log.debug('processado inline', { productId: offer.productId, status: outcome.status });
    } else {
      await getProcessQueue().add(
        'process',
        { offer, rawCaptureId: inserted.id, keyword },
        {
          jobId: `proc-${dedupKey(offer)}`,
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 24 * 3600 },
        },
      );
      stats.enqueued += 1;
    }
  }

  stats.ms = Date.now() - t0;
  if (runId) {
    await query(`UPDATE capture_runs SET finished_at = now(), stats = $2 WHERE id = $1`, [
      runId,
      JSON.stringify(stats),
    ]);
  }
  log.info('ciclo de captura concluído', { ...stats });
  return stats;
}
