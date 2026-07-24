import { Queue } from 'bullmq';
import type { NormalizedOffer } from '../types';
import { makeRedis } from '../redis';

export const QUEUE_PROCESS = 'process';
export const QUEUE_DRIP = 'drip';
export const QUEUE_CAPTURE = 'capture';

export interface ProcessJobData {
  offer: NormalizedOffer;
  rawCaptureId: string | null;
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
