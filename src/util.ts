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

/**
 * Normaliza um telefone brasileiro para o formato que a Evolution exige ao
 * criar grupo: SÓ DÍGITOS, com código do país, mínimo 10 caracteres
 * (`createGroupSchema` valida `pattern: '\d+'` e `minLength: 10`).
 *
 * Sem isto, o dono digita "(11) 99999-9999" — a forma natural — e a Evolution
 * devolve 400 de validação, com uma mensagem que não diz o que fazer.
 *
 * A regra do comprimento resolve uma ambiguidade real: DDD 55 EXISTE (Santa
 * Maria/RS), então "5599999999" tanto pode ser "55 + 99999999" quanto o país 55
 * já na frente. O desempate é pelo tamanho, que é determinístico no Brasil:
 *   10 = DDD + 8 dígitos        11 = DDD + 9 dígitos
 *   12 = 55 + DDD + 8 dígitos   13 = 55 + DDD + 9 dígitos
 * Fora dessas faixas devolve null: é melhor recusar do que mandar um número
 * torto para a API e receber um 400 obscuro — ou pior, criar o grupo com a
 * pessoa errada dentro.
 */
export function normalizarTelefoneBR(entrada: string): string | null {
  const d = String(entrada ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return d;
  // Número internacional já com país (ex.: +1 555 123 4567 = 11 dígitos) cai na
  // faixa 10-11 e ganharia um "55" indevido. Não há como distinguir sem pedir o
  // país ao usuário; a UI é explícita que o campo é para número brasileiro.
  return null;
}
