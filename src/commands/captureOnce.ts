/* eslint-disable no-console */
import { runCaptureExclusivo } from '../capture/shopeeFeed';
import { closePool } from '../db';
import { closeRedis } from '../redis';

/**
 * Roda UM ciclo de captura processando inline (sem worker/BullMQ), gravando
 * ofertas no banco. Exige DATABASE_URL e REDIS_URL acessíveis.
 *   npm run capture:once
 */
async function main(): Promise<void> {
  console.log('Rodando um ciclo de captura (inline)...');
  const stats = await runCaptureExclusivo(true, 'manual');
  console.log('Resultado:', stats);
}

main()
  .then(async () => {
    await closePool().catch(() => {});
    await closeRedis().catch(() => {});
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('FALHOU:', err instanceof Error ? err.message : err);
    await closePool().catch(() => {});
    await closeRedis().catch(() => {});
    process.exit(1);
  });
