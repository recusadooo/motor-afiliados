import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O FREIO DA SHOPEE — a peça que protege o único ponto de monetização do
 * projeto, e que nunca tinha sido testada.
 *
 * O que está em jogo: a conta de afiliado é o ativo mais frágil do sistema e o
 * critério de "uso anormal" da Shopee NÃO é público. Os tetos aqui são
 * conservadores por escolha, não por exigência documentada — o único caso
 * público de erro 10030 foi causado por PARALELISMO (Promise.all), não por
 * volume. Por isso a garantia mais importante deste arquivo não é "respeita o
 * teto": é SERIALIZA.
 *
 * A config é injetada por variável de ambiente ANTES do import, porque
 * `loadConfig` cacheia na primeira chamada.
 */

process.env.SHOPEE_APP_ID ??= 'teste';
process.env.SHOPEE_APP_SECRET ??= 'teste';
process.env.POSTGRES_PASSWORD ??= 'teste';
/*
 * Tetos por MINUTO e por HORA desligados (0) de propósito. Eles fazem a chamada
 * ESPERAR até abrir vaga — testá-los de verdade exigiria esperar um minuto ou
 * uma hora reais. (Primeira versão deste arquivo pôs o teto diário ACIMA do
 * horário; bater o diário passou a exigir furar o horário, e a suíte ficou
 * pendurada esperando uma hora. Fica registrado.)
 *
 * O teto DIÁRIO é diferente: ele LANÇA em vez de esperar, então é testável em
 * milissegundos — e é o mais importante dos três, porque é o freio de mão.
 */
process.env.SHOPEE_MIN_INTERVAL_MS = '20';
process.env.SHOPEE_MAX_PER_MIN = '0';
process.env.SHOPEE_MAX_PER_HOUR = '0';
process.env.SHOPEE_MAX_PER_DAY = '4';

// Import normal (não `await import`): o projeto compila para CommonJS e não
// aceita await de topo. Funciona porque `loadConfig()` é chamado DENTRO de
// `reservarVaga`, não na carga do módulo — então as variáveis acima já estão
// no ambiente quando a config é lida pela primeira vez.
import { reservarVaga, shopeeUsage, __resetThrottle } from './throttle';

beforeEach(() => __resetThrottle());

test('serializa: duas reservas nunca acontecem ao mesmo tempo', async () => {
  // É a garantia central. O único 10030 público veio de paralelismo, não de
  // volume — então o freio existe antes de tudo para impedir concorrência.
  let emVoo = 0;
  let maxSimultaneo = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      await reservarVaga();
      emVoo += 1;
      maxSimultaneo = Math.max(maxSimultaneo, emVoo);
      await new Promise((r) => setTimeout(r, 5));
      emVoo -= 1;
    }),
  );
  assert.equal(maxSimultaneo, 1, 'duas chamadas à Shopee não podem estar em voo juntas');
});

test('respeita o espaçamento mínimo entre chamadas', async () => {
  const t0 = Date.now();
  await reservarVaga();
  await reservarVaga();
  await reservarVaga();
  const decorrido = Date.now() - t0;
  // 3 chamadas com intervalo mínimo de 20ms => pelo menos 2 esperas.
  assert.ok(decorrido >= 35, `esperava >= 35ms de espaçamento, veio ${decorrido}ms`);
});

test('conta o uso do dia e das janelas', async () => {
  await reservarVaga();
  await reservarVaga();
  const u = shopeeUsage();
  assert.equal(u.usadoNoDia, 2);
  assert.equal(u.ultimoMinuto, 2);
  assert.equal(u.ultimaHora, 2);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(u.dia), `dia deveria ser YYYY-MM-DD, veio ${u.dia}`);
});

test('o teto DIÁRIO lança em vez de esperar — é freio de mão, não fila', async () => {
  // Os tetos por minuto/hora fazem ESPERAR (a chamada acontece depois). O
  // diário não: se ele bateu, algo está errado no uso, e continuar tentando é
  // exatamente o comportamento que se quer evitar numa conta que pode ser
  // bloqueada sem aviso. Melhor parar e gritar.
  for (let i = 0; i < 4; i++) await reservarVaga();
  assert.equal(shopeeUsage().usadoNoDia, 4);
  await assert.rejects(reservarVaga(), /teto diário|SHOPEE_MAX_PER_DAY/i);
  // e continua recusando: não é um soluço, é um freio.
  await assert.rejects(reservarVaga(), /teto diário|SHOPEE_MAX_PER_DAY/i);
  assert.equal(shopeeUsage().usadoNoDia, 4, 'reserva recusada NÃO pode contar como uso');
});

test('__resetThrottle limpa tudo (senão um teste contamina o outro)', async () => {
  await reservarVaga();
  assert.equal(shopeeUsage().usadoNoDia, 1);
  __resetThrottle();
  const u = shopeeUsage();
  assert.equal(u.usadoNoDia, 0);
  assert.equal(u.ultimoMinuto, 0);
  assert.equal(u.ultimaHora, 0);
});
