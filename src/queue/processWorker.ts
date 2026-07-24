import { Worker } from 'bullmq';
import { makeRedis } from '../redis';
import { log } from '../logger';
import { QUEUE_PROCESS, type ProcessJobData } from './queues';
import { processOffer } from '../pipeline/process';
import { nudgePriority } from './scheduler';

/** Consome a fila de processamento: cada job vira (talvez) uma oferta em `offers`. */
export function startProcessWorker(): Worker<ProcessJobData> {
  const worker = new Worker<ProcessJobData>(
    QUEUE_PROCESS,
    async (job) => {
      const { offer, rawCaptureId } = job.data;
      const outcome = await processOffer(offer, rawCaptureId);
      // Oferta prioritária recém-aprovada -> antecipa o disparo (fura-fila).
      if (outcome.status === 'created' && outcome.isPriority) {
        await nudgePriority().catch((e) => log.warn('nudge falhou', { err: String(e) }));
      }
      return outcome;
    },
    {
      connection: makeRedis(),
      concurrency: 4,
      // Rate limit defensivo nas chamadas externas (Shopee generateShortLink + IA).
      limiter: { max: 5, duration: 1000 },
    },
  );
  worker.on('failed', (job, err) =>
    log.error('process job falhou', { jobId: job?.id, err: err?.message }),
  );
  worker.on('error', (err) => log.error('process worker error', { err: String(err) }));
  return worker;
}
