import { log } from '../logger';

export interface RetryOpts {
  attempts?: number;
  baseMs?: number;
  capMs?: number;
  /** Retorna true se o erro deve ser retentado. Padrão: rede/5xx/429. */
  retryOn?: (err: unknown) => boolean;
  label?: string;
}

/** Erro HTTP com status, para classificar retryable vs permanente. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function defaultRetryable(err: unknown): boolean {
  if (err instanceof HttpError) {
    return err.status === 429 || err.status >= 500;
  }
  // Erros de rede do fetch/undici não têm status.
  const code = (err as { code?: string })?.code;
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return true;
  }
  return err instanceof TypeError; // fetch lança TypeError em falha de rede
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry com backoff exponencial + full jitter. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const baseMs = opts.baseMs ?? 1000;
  const capMs = opts.capMs ?? 60_000;
  const retryOn = opts.retryOn ?? defaultRetryable;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !retryOn(err)) throw err;
      const exp = Math.min(capMs, baseMs * 2 ** (attempt - 1));
      const delay = Math.floor(Math.random() * exp); // full jitter
      log.warn('retry', {
        label: opts.label,
        attempt,
        attempts,
        delayMs: delay,
        err: err instanceof Error ? err.message : String(err),
      });
      await sleep(delay);
    }
  }
  throw lastErr;
}
