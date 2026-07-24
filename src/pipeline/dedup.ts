import { getRedis } from '../redis';

/**
 * Dedup rápido em Redis (camada 1, otimização). A garantia DURÁVEL de
 * "nunca postar 2x" é a constraint UNIQUE(channel_id, offer_dedup_key) em
 * send_logs — esta camada só evita reprocesso redundante.
 */
const TTL_SECONDS = 72 * 3600;

/** Retorna true se é NOVO (setou agora); false se já visto na janela. */
export async function claimFresh(dedupKey: string): Promise<boolean> {
  const res = await getRedis().set(`dedup:${dedupKey}`, '1', 'EX', TTL_SECONDS, 'NX');
  return res === 'OK';
}
