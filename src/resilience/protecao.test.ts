import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withBreaker, breakerState, BreakerOpenError } from './breaker';
import { withRetry, defaultRetryable, HttpError } from './retry';

/**
 * As três peças de PROTEÇÃO do motor nunca tinham sido testadas — e são
 * justamente as que existem para proteger o ativo mais frágil do projeto: a
 * conta de afiliado da Shopee, que é o único ponto de monetização e cujo
 * critério de bloqueio não é público.
 *
 * O que se protege aqui não é "o código roda". É:
 *  - retentar o que ADIANTA retentar, e só isso (retentar um 400 gasta cota à
 *    toa; retentar um 429 é o comportamento certo);
 *  - parar de bater quando o serviço está fora (disjuntor), em vez de insistir
 *    e transformar indisponibilidade em volume anormal;
 *  - e nunca deixar a exceção sumir.
 */

/* ==================== o que vale retentar ==================== */

test('defaultRetryable: retenta 429 e 5xx, NÃO retenta 4xx de cliente', () => {
  // 429 é a Shopee pedindo para esperar — retentar é o certo.
  assert.equal(defaultRetryable(new HttpError(429, 'rate limit')), true);
  assert.equal(defaultRetryable(new HttpError(500, 'erro interno')), true);
  assert.equal(defaultRetryable(new HttpError(503, 'indisponível')), true);
  // 4xx de cliente NÃO melhora com insistência: retentar só queima cota da
  // conta de afiliado repetindo um pedido que vai falhar igual.
  assert.equal(defaultRetryable(new HttpError(400, 'pedido inválido')), false);
  assert.equal(defaultRetryable(new HttpError(401, 'sem credencial')), false);
  assert.equal(defaultRetryable(new HttpError(404, 'não existe')), false);
});

test('defaultRetryable: falha de rede é retentável, erro de lógica não', () => {
  assert.equal(defaultRetryable(Object.assign(new Error('x'), { code: 'ECONNRESET' })), true);
  assert.equal(defaultRetryable(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), true);
  // fetch lança TypeError quando a conexão falha
  assert.equal(defaultRetryable(new TypeError('fetch failed')), true);
  // erro de programação não deve ser mascarado por retentativa
  assert.equal(defaultRetryable(new RangeError('índice inválido')), false);
  assert.equal(defaultRetryable(new Error('qualquer outra coisa')), false);
});

test('withRetry devolve no primeiro acerto, sem chamar de novo', async () => {
  let chamadas = 0;
  const r = await withRetry(async () => { chamadas += 1; return 'ok'; }, { attempts: 3, baseMs: 1 });
  assert.equal(r, 'ok');
  assert.equal(chamadas, 1);
});

test('withRetry insiste no que é retentável e para no acerto', async () => {
  let chamadas = 0;
  const r = await withRetry(
    async () => {
      chamadas += 1;
      if (chamadas < 3) throw new HttpError(503, 'fora do ar');
      return 'chegou';
    },
    { attempts: 5, baseMs: 1 },
  );
  assert.equal(r, 'chegou');
  assert.equal(chamadas, 3);
});

test('withRetry NÃO insiste no que não adianta — e é isso que poupa a conta', async () => {
  let chamadas = 0;
  await assert.rejects(
    withRetry(async () => { chamadas += 1; throw new HttpError(400, 'pedido inválido'); },
      { attempts: 5, baseMs: 1 }),
    /400|inválido/,
  );
  // Uma chamada, não cinco: insistir num 400 é gastar cota repetindo um erro
  // que não muda.
  assert.equal(chamadas, 1);
});

test('withRetry desiste depois do teto e propaga o erro (não engole)', async () => {
  let chamadas = 0;
  await assert.rejects(
    withRetry(async () => { chamadas += 1; throw new HttpError(503, 'fora'); },
      { attempts: 3, baseMs: 1 }),
    /503|fora/,
  );
  assert.equal(chamadas, 3);
});

/* ==================== disjuntor ==================== */

const chave = () => `teste-${Math.random().toString(36).slice(2)}`;

test('disjuntor começa fechado e deixa passar', async () => {
  const k = chave();
  assert.equal(breakerState(k), 'closed');
  assert.equal(await withBreaker(k, async () => 42), 42);
  assert.equal(breakerState(k), 'closed');
});

test('disjuntor ABRE depois do limiar e para de bater no serviço', async () => {
  const k = chave();
  const limiar = 3;
  for (let i = 0; i < limiar; i++) {
    await assert.rejects(withBreaker(k, async () => { throw new Error('fora do ar'); },
      { failureThreshold: limiar, resetTimeoutMs: 60_000 }));
  }
  assert.equal(breakerState(k), 'open');

  // Aberto, a função nem é chamada — é este o ponto: parar de transformar
  // indisponibilidade em volume anormal de requisição.
  let chamou = false;
  await assert.rejects(
    withBreaker(k, async () => { chamou = true; return 1; },
      { failureThreshold: limiar, resetTimeoutMs: 60_000 }),
    (e: unknown) => e instanceof BreakerOpenError,
  );
  assert.equal(chamou, false, 'com o disjuntor aberto a chamada NÃO pode acontecer');
});

test('disjuntor volta a testar depois do tempo de espera, e fecha no acerto', async () => {
  const k = chave();
  for (let i = 0; i < 2; i++) {
    await assert.rejects(withBreaker(k, async () => { throw new Error('fora'); },
      { failureThreshold: 2, resetTimeoutMs: 5 }));
  }
  assert.equal(breakerState(k), 'open');

  await new Promise((r) => setTimeout(r, 12)); // passou o tempo de espera
  const r = await withBreaker(k, async () => 'voltou', { failureThreshold: 2, resetTimeoutMs: 5 });
  assert.equal(r, 'voltou');
  assert.equal(breakerState(k), 'closed', 'um acerto depois da espera tem que FECHAR o disjuntor');
});

test('disjuntor é por CHAVE — um número fora do ar não derruba os outros', async () => {
  const a = chave();
  const b = chave();
  for (let i = 0; i < 2; i++) {
    await assert.rejects(withBreaker(a, async () => { throw new Error('fora'); },
      { failureThreshold: 2, resetTimeoutMs: 60_000 }));
  }
  assert.equal(breakerState(a), 'open');
  assert.equal(breakerState(b), 'closed');
  assert.equal(await withBreaker(b, async () => 'ok'), 'ok');
});

test('acerto no meio do caminho zera a contagem de falhas', async () => {
  const k = chave();
  const opts = { failureThreshold: 3, resetTimeoutMs: 60_000 };
  await assert.rejects(withBreaker(k, async () => { throw new Error('1'); }, opts));
  await assert.rejects(withBreaker(k, async () => { throw new Error('2'); }, opts));
  await withBreaker(k, async () => 'ok', opts); // zera
  await assert.rejects(withBreaker(k, async () => { throw new Error('3'); }, opts));
  // 1 falha depois do acerto, não 3 — o disjuntor segue fechado.
  assert.equal(breakerState(k), 'closed');
});
