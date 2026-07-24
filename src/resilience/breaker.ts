import { log } from '../logger';

/**
 * Circuit breaker simples por chave. Um por dependência E por conta
 * (ex.: breaker:whatsapp:{instance}) — um número banido não abre o breaker
 * dos saudáveis.
 */

type State = 'closed' | 'open' | 'half';

interface Breaker {
  state: State;
  failures: number;
  openedAt: number;
}

export interface BreakerOpts {
  failureThreshold?: number; // falhas seguidas p/ abrir
  resetTimeoutMs?: number; // tempo aberto antes de half-open
}

const breakers = new Map<string, Breaker>();

export class BreakerOpenError extends Error {
  constructor(key: string) {
    super(`circuit breaker aberto: ${key}`);
    this.name = 'BreakerOpenError';
  }
}

export async function withBreaker<T>(
  key: string,
  fn: () => Promise<T>,
  opts: BreakerOpts = {},
): Promise<T> {
  const threshold = opts.failureThreshold ?? 5;
  const resetMs = opts.resetTimeoutMs ?? 45_000;
  let b = breakers.get(key);
  if (!b) {
    b = { state: 'closed', failures: 0, openedAt: 0 };
    breakers.set(key, b);
  }

  if (b.state === 'open') {
    if (Date.now() - b.openedAt >= resetMs) {
      b.state = 'half';
      log.info('breaker half-open', { key });
    } else {
      throw new BreakerOpenError(key);
    }
  }

  try {
    const result = await fn();
    if (b.state !== 'closed') log.info('breaker fechou', { key });
    b.state = 'closed';
    b.failures = 0;
    return result;
  } catch (err) {
    b.failures += 1;
    if (b.state === 'half' || b.failures >= threshold) {
      b.state = 'open';
      b.openedAt = Date.now();
      log.warn('breaker abriu', { key, failures: b.failures });
    }
    throw err;
  }
}

export function breakerState(key: string): State {
  return breakers.get(key)?.state ?? 'closed';
}
