import { Queue } from 'bullmq';
import type { NormalizedOffer } from '../types';
import { makeRedis, derrubarRedis } from '../redis';

export const QUEUE_PROCESS = 'process';
export const QUEUE_DRIP = 'drip';
export const QUEUE_CAPTURE = 'capture';
/**
 * Fila da INTELIGÊNCIA — separada da captura de propósito. As duas puxam da
 * mesma API mas têm objetivos opostos: a captura é estreita (escolher 10 para
 * postar) e a observação é larga (registrar o cardápio inteiro). Misturar as
 * duas na mesma fila faria uma atrasar a outra e embaralharia os cronogramas.
 */
export const QUEUE_INTEL = 'intel';

export interface ProcessJobData {
  offer: NormalizedOffer;
  rawCaptureId: string | null;
  /** keyword que trouxe a oferta — vai para `offers.keyword` (filtro do painel) */
  keyword?: string | null;
}

export interface DripJobData {
  channelId: string;
}

let processQueue: Queue<ProcessJobData> | null = null;
export function getProcessQueue(): Queue<ProcessJobData> {
  if (!processQueue) {
    processQueue = new Queue<ProcessJobData>(QUEUE_PROCESS, { connection: makeRedis() });
  }
  return processQueue;
}

let dripQueue: Queue<DripJobData> | null = null;
export function getDripQueue(): Queue<DripJobData> {
  if (!dripQueue) {
    dripQueue = new Queue<DripJobData>(QUEUE_DRIP, { connection: makeRedis() });
  }
  return dripQueue;
}

let captureQueue: Queue | null = null;
export function getCaptureQueue(): Queue {
  if (!captureQueue) {
    captureQueue = new Queue(QUEUE_CAPTURE, { connection: makeRedis() });
  }
  return captureQueue;
}

let intelQueue: Queue | null = null;
export function getIntelQueue(): Queue {
  if (!intelQueue) {
    intelQueue = new Queue(QUEUE_INTEL, { connection: makeRedis() });
  }
  return intelQueue;
}

/**
 * Fecha as conexões de fila que foram abertas.
 *
 * Existe porque o ioredis reconecta INDEFINIDAMENTE: um processo que tocou
 * qualquer fila nunca termina sozinho, mesmo com todo o trabalho concluído.
 * Em produção isso é irrelevante (os serviços são de vida longa), mas qualquer
 * comando ou teste que importe este módulo fica pendurado até o timeout — o
 * que faz uma suíte VERDE ser relatada como falha do arquivo.
 */
export async function closeQueues(): Promise<void> {
  const filas = [processQueue, dripQueue, captureQueue, intelQueue].filter(Boolean);
  processQueue = dripQueue = captureQueue = intelQueue = null;
  // `close()` limpo primeiro, com prazo — ele ESPERA o Redis responder, e com o
  // Redis fora do ar esperaria para sempre.
  await Promise.race([
    Promise.allSettled(filas.map((q) => q!.close())),
    new Promise((r) => setTimeout(r, 2000)),
  ]);
  derrubarRedis(); // o que sobrou cai na marra
}
