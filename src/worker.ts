import { Worker } from 'bullmq';
import { makeRedis } from './redis';
import { loadConfig } from './config';
import { log } from './logger';
import { startProcessWorker } from './queue/processWorker';
import { startDripWorker, ensureDripJobs } from './queue/scheduler';
import { getCaptureQueue, getIntelQueue, QUEUE_CAPTURE, QUEUE_INTEL } from './queue/queues';
import { runCaptureExclusivo } from './capture/shopeeFeed';
import { runSweepExclusivo, podarObservacoes } from './intel/observe';
import { matchPendingPosts } from './intel/match';
import { migrate } from './migrate';

/**
 * Processo de background: consome filas (process, drip), roda a captura por cron
 * e mantém o gotejamento. NÃO expõe portas — só a API faz isso.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  log.info('worker iniciando', { env: cfg.NODE_ENV });

  // Aplica o schema (espera o Postgres). Idempotente.
  await migrate();

  startProcessWorker();
  startDripWorker();
  await ensureDripJobs();
  // Recheca canais novos (número recém-conectado ganha seu job de gotejamento).
  setInterval(() => {
    ensureDripJobs().catch((err) => log.warn('ensureDripJobs periódico falhou', { err: String(err) }));
  }, 60_000).unref?.();

  const captureWorker = new Worker(
    QUEUE_CAPTURE,
    async () => runCaptureExclusivo(false, 'cron'),
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

  // ---- Inteligência de mercado: varredura larga + correlação ----
  // Roda em fila PRÓPRIA. A varredura observa o cardápio inteiro da Shopee; a
  // captura escolhe 10 para postar. Objetivos opostos, cronogramas diferentes,
  // e uma não pode atrasar a outra.
  if (cfg.INTEL_ENABLED) {
    const intelWorker = new Worker(
      QUEUE_INTEL,
      async () => {
        const sweep = await runSweepExclusivo('cron');
        /*
         * REAVALIAR, não só casar os novos.
         *
         * O timer de 5 minutos abaixo já esvaziou a fila de pendentes muito
         * antes desta varredura terminar. Um post sobre oferta FRESCA chega,
         * não encontra observação (a varredura só roda de 2 em 2h), e era
         * carimbado `sem_casamento` para sempre — mesmo que 40 minutos depois
         * a varredura observasse exatamente aquele produto.
         *
         * O efeito era pior que perder casamentos: sobreviviam na mediana
         * quase só os posts sobre produto ANTIGO (que já estava no cardápio),
         * então "atraso mediano" media a nossa cadência de varredura em vez do
         * comportamento deles. Agora, toda vez que entra observação nova, os
         * `sem_casamento` recentes são reavaliados contra ela.
         */
        const match = await matchPendingPosts(500, true);
        const podadas = await podarObservacoes();
        return { sweep, match, podadas };
      },
      { connection: makeRedis(), concurrency: 1 },
    );
    intelWorker.on('failed', (_job, err) => log.error('varredura falhou', { err: err?.message }));
    intelWorker.on('completed', (_job, result) => log.info('varredura ok', { result }));

    await getIntelQueue().upsertJobScheduler(
      'intel-sweep',
      { pattern: cfg.INTEL_SWEEP_CRON },
      { name: 'sweep', opts: { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } } },
    );

    // O matcher também roda sozinho, mais miúdo: post de grupo chega o dia
    // inteiro e não faz sentido esperar 2h para correlacionar. É barato — só
    // toca posts com matched_at NULL.
    setInterval(() => {
      matchPendingPosts(100).catch((err) =>
        log.warn('correlação periódica falhou', { err: String(err) }),
      );
    }, 5 * 60_000).unref?.();
  } else {
    log.info('inteligência de mercado desligada (INTEL_ENABLED=false)');
  }

  log.info('worker pronto', {
    captureCron: cfg.CAPTURE_CRON,
    intelCron: cfg.INTEL_ENABLED ? cfg.INTEL_SWEEP_CRON : 'desligada',
  });
}

main().catch((err) => {
  log.error('worker crash', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
