import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { loadConfig, databaseUrl } from './config';
import { log } from './logger';

/**
 * Camada de acesso ao PostgreSQL. Pool único por processo.
 * `query` é tipado; `tx` roda uma função dentro de uma transação.
 */

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const cfg = loadConfig();
  pool = new Pool({ connectionString: databaseUrl(cfg), max: 10 });
  pool.on('error', (err) => log.error('pg pool error', { err: String(err) }));
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const res = await getPool().query<T>(text, params as never);
  return res.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
