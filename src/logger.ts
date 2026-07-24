/**
 * Logger estruturado mínimo (JSON), sem dependência externa.
 * Regra: NUNCA logar segredos (chaves, tokens, senhas). Os módulos que lidam
 * com credenciais passam apenas metadados (ex.: "carregado", nunca o valor).
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN: Level = (process.env.LOG_LEVEL as Level) || 'info';

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[MIN]) return;
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(meta ?? {}),
  };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
  /** Cria um logger com contexto fixo (ex.: correlation_id). */
  child(ctx: Record<string, unknown>) {
    return {
      debug: (m: string, meta?: Record<string, unknown>) => emit('debug', m, { ...ctx, ...meta }),
      info: (m: string, meta?: Record<string, unknown>) => emit('info', m, { ...ctx, ...meta }),
      warn: (m: string, meta?: Record<string, unknown>) => emit('warn', m, { ...ctx, ...meta }),
      error: (m: string, meta?: Record<string, unknown>) => emit('error', m, { ...ctx, ...meta }),
    };
  },
};

export type Logger = typeof log;
