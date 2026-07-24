import { createHash } from 'node:crypto';

/**
 * Converte string|number|null vindo da API/pg para number|null seguro.
 * A Shopee e o pg usam decimal US ("12.51", "0.07"); vírgulas (separador de
 * milhar) e símbolos são removidos, o ponto é o separador decimal.
 */
export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[^\d.-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Normaliza texto para content_hash: minúsculas, sem emoji, sem pontuação,
 * espaços colapsados. Assim a MESMA oferta não reentra como "nova" a cada
 * variação de texto do concorrente.
 */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // acentos
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, '') // emoji/símbolos
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // pontuação -> espaço
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sorteia inteiro em [min, max]. */
export function randInt(min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** "HH:MM:SS" ou "HH:MM" -> minutos desde meia-noite. */
export function timeToMinutes(t: string): number {
  const parts = t.split(':');
  const h = Number(parts[0] ?? 0);
  const m = Number(parts[1] ?? 0);
  return h * 60 + m;
}
