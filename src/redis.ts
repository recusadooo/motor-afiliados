import IORedis, { type Redis } from 'ioredis';
import { loadConfig } from './config';

/**
 * Conexões Redis. BullMQ exige `maxRetriesPerRequest: null`.
 * Reusamos uma conexão "geral" (dedup, locks) e criamos conexões dedicadas
 * para Queue/Worker quando necessário.
 */

let shared: Redis | null = null;

export function makeRedis(): Redis {
  const cfg = loadConfig();
  return new IORedis(cfg.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

export function getRedis(): Redis {
  if (!shared) shared = makeRedis();
  return shared;
}

export async function closeRedis(): Promise<void> {
  if (shared) {
    await shared.quit();
    shared = null;
  }
}
