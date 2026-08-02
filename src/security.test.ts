import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import {
  hashSenha, senhaCorreta, segredoConfere, lerCookie, ipDe,
  loginBloqueado, registrarTentativaFalha, limparTentativas,
} from './security';

/**
 * SEGURANÇA DO PAINEL — a última peça do inventário sem teste.
 *
 * Por que importa aqui e não é teatro: o domínio deste app é PÚBLICO. Quando o
 * Traefik emite o TLS, o host entra nos logs de Certificate Transparency e
 * passa a ser descobrível por qualquer scanner em minutos. Não existe
 * "ninguém vai achar" — o painel é achado, e o que separa ele de qualquer um
 * é exatamente o que este arquivo testa.
 */

const req = (headers: Record<string, string | undefined>, ip?: string) =>
  ({ headers, ip, socket: { remoteAddress: undefined } }) as unknown as Request;

/* ==================== senha ==================== */

test('hashSenha nunca guarda a senha, e dois hashes da MESMA senha diferem', () => {
  const h1 = hashSenha('senha-do-dono-123');
  const h2 = hashSenha('senha-do-dono-123');
  // a senha em claro não pode aparecer no que vai para o banco
  assert.doesNotMatch(h1, /senha-do-dono-123/);
  // sal aleatório: hash igual para senha igual seria tabela arco-íris de graça
  assert.notEqual(h1, h2, 'o sal tem que tornar cada hash único');
  assert.match(h1, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
});

test('senhaCorreta aceita a certa e recusa a errada', () => {
  const guardado = hashSenha('correta');
  assert.equal(senhaCorreta('correta', guardado), true);
  assert.equal(senhaCorreta('errada', guardado), false);
  assert.equal(senhaCorreta('', guardado), false);
  // quase certa também é errada
  assert.equal(senhaCorreta('correta ', guardado), false);
  assert.equal(senhaCorreta('Correta', guardado), false);
});

test('senhaCorreta não explode com hash corrompido — devolve false', () => {
  // Se o valor no banco for adulterado ou truncado, o pior resultado possível
  // seria lançar e derrubar a rota de login. O segundo pior seria deixar
  // passar. Tem que ser: false.
  for (const lixo of ['', 'lixo', 'scrypt$', 'scrypt$abc', 'md5$aa$bb', '$$', 'scrypt$zz$zz']) {
    assert.equal(senhaCorreta('qualquer', lixo), false, `hash inválido "${lixo}" deveria dar false`);
  }
});

/* ==================== comparação de segredo ==================== */

test('segredoConfere: igual passa, diferente não, ausente não', () => {
  assert.equal(segredoConfere('abc123', 'abc123'), true);
  assert.equal(segredoConfere('abc124', 'abc123'), false);
  assert.equal(segredoConfere(undefined, 'abc123'), false);
  assert.equal(segredoConfere('', 'abc123'), false);
  // tamanho diferente não pode lançar (timingSafeEqual exige mesmo tamanho)
  assert.equal(segredoConfere('a', 'abc123'), false);
  assert.equal(segredoConfere('abc123longo-demais', 'abc123'), false);
});

/* ==================== cookie ==================== */

test('lerCookie pega o certo entre vários e não confunde prefixo', () => {
  const r = req({ cookie: 'outro=1; motor_sessao=abc.def; mais=2' });
  assert.equal(lerCookie(r, 'motor_sessao'), 'abc.def');
  assert.equal(lerCookie(r, 'outro'), '1');
  assert.equal(lerCookie(r, 'nao_existe'), undefined);
  // "motor" não pode casar com "motor_sessao"
  assert.equal(lerCookie(r, 'motor'), undefined);
  assert.equal(lerCookie(req({}), 'motor_sessao'), undefined);
});

test('lerCookie preserva valor com "=" dentro (base64 termina em =)', () => {
  const r = req({ cookie: 'motor_sessao=YWJj.ZGVm==' });
  assert.equal(lerCookie(r, 'motor_sessao'), 'YWJj.ZGVm==');
});

/* ==================== IP (base dos freios) ==================== */

test('ipDe usa o X-Forwarded-For quando existe, pegando o primeiro', () => {
  assert.equal(ipDe(req({ 'x-forwarded-for': '203.0.113.9' })), '203.0.113.9');
  assert.equal(ipDe(req({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' })), '203.0.113.9');
  assert.equal(ipDe(req({ 'x-forwarded-for': '  203.0.113.9  , 10.0.0.1' })), '203.0.113.9');
});

test('ipDe cai para req.ip quando não há cabeçalho, e nunca devolve vazio', () => {
  assert.equal(ipDe(req({}, '198.51.100.4')), '198.51.100.4');
  assert.equal(ipDe(req({ 'x-forwarded-for': '' }, '198.51.100.4')), '198.51.100.4');
  // sem nada: precisa devolver ALGO, senão a chave do freio vira undefined e
  // todo mundo compartilha o mesmo balde
  assert.equal(typeof ipDe(req({})), 'string');
  assert.ok(ipDe(req({})).length > 0);
});

/* ==================== freio de força bruta ==================== */

const ipNovo = () => `10.0.0.${Math.floor(Math.random() * 250) + 1}-${Math.random().toString(36).slice(2)}`;

test('IP limpo não está bloqueado', () => {
  assert.equal(loginBloqueado(ipNovo()), 0);
});

test('bloqueia depois do limite de tentativas erradas', () => {
  const ip = ipNovo();
  const max = 4;
  for (let i = 0; i < max - 1; i++) registrarTentativaFalha(ip, max);
  assert.equal(loginBloqueado(ip), 0, `com ${max - 1} tentativas ainda não bloqueia`);
  registrarTentativaFalha(ip, max);
  const restam = loginBloqueado(ip);
  assert.ok(restam > 0, 'na tentativa de número máximo tem que bloquear');
  assert.ok(restam <= 15 * 60, `espera deveria ser <= 15 min, veio ${restam}s`);
});

test('acertar a senha limpa o histórico do IP', () => {
  const ip = ipNovo();
  for (let i = 0; i < 5; i++) registrarTentativaFalha(ip, 4);
  assert.ok(loginBloqueado(ip) > 0);
  limparTentativas(ip);
  assert.equal(loginBloqueado(ip), 0, 'depois de entrar certo o IP não pode seguir bloqueado');
});

test('o bloqueio é POR IP — um atacante não tranca o dono para fora', () => {
  const atacante = ipNovo();
  const dono = ipNovo();
  for (let i = 0; i < 5; i++) registrarTentativaFalha(atacante, 4);
  assert.ok(loginBloqueado(atacante) > 0);
  assert.equal(loginBloqueado(dono), 0, 'o IP do dono não pode ser afetado');
});
