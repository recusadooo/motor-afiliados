import { query, queryOne } from './db';
import { loadConfig } from './config';

/**
 * Configurações de runtime editáveis pela interface (tabela `settings`).
 * Precedência: valor no banco > variável de ambiente > default.
 * Cache curto para não bater no banco a cada chamada.
 */

const CACHE_MS = 10_000;
let cache: Record<string, string | null> = {};
let cachedAt = 0;

async function refresh(): Promise<void> {
  const rows = await query<{ key: string; value: string | null }>(`SELECT key, value FROM settings`);
  cache = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cachedAt = Date.now();
}

export async function getSetting(key: string): Promise<string | null> {
  if (Date.now() - cachedAt > CACHE_MS) await refresh();
  return cache[key] ?? null;
}

export async function setSetting(key: string, value: string | null): Promise<void> {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
  cachedAt = 0; // invalida cache
}

/** Chaves permitidas na interface (whitelist). */
export const SETTING_KEYS = [
  'openai_api_key',
  'copy_model',
  'moderation_model',
  'evolution_api_url',
  'evolution_api_key',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** Valor efetivo (banco > env > default). */
export async function getOpenAiKey(): Promise<string | null> {
  return (await getSetting('openai_api_key')) || loadConfig().OPENAI_API_KEY || null;
}

export async function getCopyModel(): Promise<string> {
  return (await getSetting('copy_model')) || loadConfig().COPY_MODEL;
}

export async function getModerationModel(): Promise<string> {
  return (await getSetting('moderation_model')) || loadConfig().MODERATION_MODEL;
}

// ---- Evolution API (URL + key) configuráveis pela interface ----
export async function getEvolutionUrl(): Promise<string | null> {
  return (await getSetting('evolution_api_url')) || loadConfig().EVOLUTION_API_URL || null;
}
export async function getEvolutionKey(): Promise<string | null> {
  return (await getSetting('evolution_api_key')) || loadConfig().EVOLUTION_API_KEY || null;
}

/** Estado das settings para a UI — NUNCA devolve o valor de segredos. */
export async function settingsStatus(): Promise<Record<string, unknown>> {
  return {
    openai_api_key_set: !!(await getOpenAiKey()),
    copy_model: await getCopyModel(),
    moderation_model: await getModerationModel(),
    evolution_api_url: (await getEvolutionUrl()) ?? '',
    evolution_api_key_set: !!(await getEvolutionKey()),
  };
}
