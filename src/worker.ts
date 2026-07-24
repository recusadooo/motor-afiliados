import { Worker } from 'bullmq';
import { makeRedis } from './redis';
import { loadConfig } from './config';
import { log } from './logger';
import { startProcessWorker } from './queue/processWorker';
import { startDripWorker, ensureDripJobs } from './queue/scheduler';
import { getCaptureQueue, QUEUE_CAPTURE } from './queue/queues';
import { runCapture } from './capture/shopeeFeed';

/**
 * Processo de background: consome filas (process, drip), roda a captura por cron
 * e mantém o gotejamento. NÃO expõe portas — só a API faz isso.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  log.info('worker iniciando', { env: cfg.NODE_ENV });

  startProcessWorker();
  startDripWorker();
  await ensureDripJobs();
  // Recheca canais novos (número recém-conectado ganha seu job de gotejamento).
  setInterval(() => {
    ensureDripJobs().catch((err) => log.warn('ensureDripJobs periódico falhou', { err: String(err) }));
  }, 60_000).unref?.();

  const captureWorker = new Worker(
    QUEUE_CAPTURE,
    async () => runCapture(false),
    { connection: makeRedis(), concurrency: 1 },
  );
  captureWorker.on('failed', (_job, err) => log.error('captura falhou', { err: err?.message }));
  captureWorker.on('completed', (_job, result) => log.info('captura ok', { result }));

  // Agenda a captura (cron) via Job Scheduler da BullMQ v5.
  await getCaptureQueue().upsertJobScheduler(
    'shopee-capture',
    { pattern: cfg.CAPTURE_CRON },
    { name: 'capture', opts: { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } } },
  );

  log.info('worker pronto', { captureCron: cfg.CAPTURE_CRON });
}

main().catch((err) => {
  log.error('worker crash', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
