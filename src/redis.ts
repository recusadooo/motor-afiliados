import IORedis, { type Redis } from 'ioredis';
import { loadConfig } from './config';

/**
 * Conexões Redis. BullMQ exige `maxRetriesPerRequest: null`.
 * Reusamos uma conexão "geral" (dedup, locks) e criamos conexões dedicadas
 * para Queue/Worker quando necessário.
 */

let shared: Redis | null = null;

/*
 * Toda conexão criada fica registrada para poder ser DERRUBADA à força.
 *
 * Motivo: o ioredis reconecta indefinidamente e `quit()`/`close()` ESPERAM a
 * conexão responder. Com o Redis fora do ar, um processo que tocou qualquer
 * fila nunca termina — nem com todo o trabalho concluído. Em produção isso é
 * inofensivo (os serviços são de vida longa), mas trava qualquer comando de
 * linha e faz uma suíte de testes VERDE ser relatada como falha por timeout.
 * `disconnect()` destrói o socket na hora, sem esperar resposta.
 */
const abertas = new Set<Redis>();

export function makeRedis(): Redis {
  const cfg = loadConfig();
  const c = new IORedis(cfg.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  abertas.add(c);
  c.on('end', () => abertas.delete(c));
  // Sem um listener de 'error', uma falha de conexão vira exceção não tratada.
  c.on('error', () => {});
  return c;
}

/** Derruba TODAS as conexões na marra. Para encerrar processo, não para uso normal. */
export function derrubarRedis(): void {
  for (const c of abertas) {
    try { c.disconnect(false); } catch { /* já caiu */ }
  }
  abertas.clear();
  shared = null;
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
