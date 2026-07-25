import { loadConfig } from '../config';
import { log } from '../logger';
import { queryOne } from '../db';
import { productOfferV2 } from '../shopee/queries';
import { normalizeProduct, contentHash, dedupKey } from '../pipeline/normalize';
import { matchesKeyword } from '../pipeline/filters';
import { processOffer } from '../pipeline/process';
import { getProcessQueue } from '../queue/queues';

export interface CaptureStats {
  captured: number;
  enqueued: number;
  /** descartada por comissão abaixo do mínimo */
  skipped: number;
  /** descartada por não casar com a keyword buscada (fora do nicho) */
  offNiche: number;
  processedInline: number;
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
 * Roda um ciclo de captura: busca produtos por palavra-chave, grava capturas
 * cruas novas e enfileira o processamento (ou processa inline no modo CLI).
 */
export async function runCapture(processInline = false): Promise<CaptureStats> {
  const cfg = loadConfig();
  const keywords = cfg.CAPTURE_KEYWORDS.split(',').map((k) => k.trim()).filter(Boolean);
  const sourceId = await ensureShopeeSource();
  const stats: CaptureStats = { captured: 0, enqueued: 0, skipped: 0, offNiche: 0, processedInline: 0 };

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
      continue;
    }

    for (const node of page.nodes) {
      const offer = normalizeProduct(node);
      // Relevância: a busca da Shopee devolve muito produto fora do nicho
      // (ex.: "notebook" -> papel/caderno). Corta antes de encher a fila.
      if (cfg.CAPTURE_REQUIRE_KEYWORD_MATCH && !matchesKeyword(offer.title, keyword)) {
        stats.offNiche += 1;
        continue;
      }
      if (offer.commissionRate != null && offer.commissionRate < cfg.CAPTURE_MIN_COMMISSION) {
        stats.skipped += 1;
        continue;
      }

      const ch = contentHash(offer);
      const inserted = await queryOne<{ id: string }>(
        `INSERT INTO raw_captures (source_id, raw_payload, raw_url, content_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (source_id, content_hash) DO NOTHING
         RETURNING id`,
        [sourceId, JSON.stringify(node), offer.sourceUrl, ch],
      );
      stats.captured += 1;
      if (!inserted) continue; // captura idêntica já vista

      if (processInline) {
        const outcome = await processOffer(offer, inserted.id);
        stats.processedInline += 1;
        log.debug('processado inline', { productId: offer.productId, status: outcome.status });
      } else {
        await getProcessQueue().add(
          'process',
          { offer, rawCaptureId: inserted.id },
          {
            jobId: `proc:${dedupKey(offer)}`,
            removeOnComplete: { age: 3600, count: 1000 },
            removeOnFail: { age: 24 * 3600 },
          },
        );
        stats.enqueued += 1;
      }
    }
  }

  log.info('ciclo de captura concluído', { ...stats, keywords: keywords.length });
  return stats;
}
