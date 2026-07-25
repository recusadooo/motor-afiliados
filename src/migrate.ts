import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPool } from './db';
import { log } from './logger';

/**
 * Aplica o schema do banco (idempotente — CREATE TABLE IF NOT EXISTS), esperando
 * o Postgres ficar pronto. Necessário no Swarm, onde não dá pra usar o bind-mount
 * do initdb (o arquivo não está no nó). O schema.sql é copiado pra imagem.
 */
export async function migrate(): Promise<void> {
  const schemaPath = join(__dirname, '..', 'db', 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf8');
  const maxAttempts = 30;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await getPool().query(sql);
      log.info('schema aplicado');
      return;
    } catch (err) {
      log.warn('aguardando Postgres para migrar', {
        attempt,
        err: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('não foi possível aplicar o schema (Postgres indisponível)');
}

// Permite rodar sozinho (dev local): npm run migrate
if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      log.error('migração falhou', { err: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
}
