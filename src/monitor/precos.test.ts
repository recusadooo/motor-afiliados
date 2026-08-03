import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

/**
 * MONITOR DE PREÇOS — o que precisa ser verdade.
 *
 * Não é "a tabela grava". É que o número que o painel mostra signifique o que
 * diz: se a média for a média das VEZES QUE OLHAMOS em vez da média ponderada
 * pelo tempo, o "36% abaixo" vira uma medida do nosso coletor, não do mercado —
 * e o dono decide com base nele.
 *
 *   INTEL_TEST_DATABASE_URL=postgres://... npm run test:precos
 */

const DB = process.env.INTEL_TEST_DATABASE_URL;

if (!DB) {
  test('INTEGRAÇÃO PULADA — falta INTEL_TEST_DATABASE_URL', () => {
    console.warn('\n  [!] precos.test.ts NÃO RODOU: defina INTEL_TEST_DATABASE_URL.\n');
    assert.ok(true);
  });
} else {
  process.env.DATABASE_URL = DB;
  process.env.SHOPEE_APP_ID ??= 'teste';
  process.env.SHOPEE_APP_SECRET ??= 'teste';
  process.env.REDIS_URL = 'redis://127.0.0.1:6399';
  process.on('unhandledRejection', (e) => {
    const m = e instanceof Error ? e.message : String(e);
    if (/ECONNREFUSED|ENOTFOUND|Connection is closed|Stream isn't writeable/i.test(m)) return;
    throw e;
  });

  const { migrate } = require('../migrate') as typeof import('../migrate');
  const { query, queryOne, closePool } = require('../db') as typeof import('../db');
  const { closeQueues } = require('../queue/queues') as typeof import('../queue/queues');
  const m = require('./precos') as typeof import('./precos');

  const P = '__teste_monitor__';

  const limpar = async () => {
    await query(`DELETE FROM price_points WHERE product_id LIKE $1`, [`${P}%`]);
    await query(`DELETE FROM price_state  WHERE product_id LIKE $1`, [`${P}%`]);
  };

  /** Semeia o log direto, para controlar o eixo do tempo com precisão. */
  const ponto = (produto: string, preco: number, diasAtras: number) =>
    query(
      `INSERT INTO price_points (product_id, price, fonte, observed_at)
       VALUES ($1,$2,'manual', now() - ($3 || ' days')::interval)
       ON CONFLICT DO NOTHING`,
      [produto, preco, String(diasAtras)],
    );

  before(async () => { await migrate(); await limpar(); });
  after(async () => {
    try { await limpar(); } finally { await closeQueues(); await closePool(); }
  });

  /* ==================== grava mudança, não amostra ==================== */

  test('leitura repetida com o MESMO preço não vira linha nova', async () => {
    /*
     * É a razão de o histórico caber em 27 MB/ano em vez de 2 GB. Se cada
     * leitura virasse linha, a varredura sozinha geraria ~29 mil linhas/dia.
     */
    const id = P + 'estavel';
    const r1 = await m.registrarLeituras([{ productId: id, shopId: null, price: 100 }]);
    assert.equal(r1.gravadas, 1, 'a primeira leitura sempre grava');

    const r2 = await m.registrarLeituras([{ productId: id, shopId: null, price: 100 }]);
    assert.equal(r2.gravadas, 0, 'preço igual no mesmo dia não pode gerar linha');

    const r3 = await m.registrarLeituras([{ productId: id, shopId: null, price: 100.3 }]);
    assert.equal(r3.gravadas, 0, 'variação de 0,3% é ruído de arredondamento, não mudança');

    const r4 = await m.registrarLeituras([{ productId: id, shopId: null, price: 92 }]);
    assert.equal(r4.gravadas, 1, 'queda de 8% É mudança e tem que ser registrada');
  });

  test('o mesmo produto vindo de várias keywords vira UMA linha', async () => {
    // A varredura traz o mesmo item por "fone de ouvido" e "headset gamer".
    const id = P + 'duplicado';
    const r = await m.registrarLeituras([
      { productId: id, shopId: null, price: 50 },
      { productId: id, shopId: null, price: 50 },
      { productId: id, shopId: null, price: 50 },
    ]);
    assert.equal(r.recebidas, 3);
    assert.equal(r.gravadas, 1, 'três leituras do mesmo produto = uma linha');
  });

  /* ==================== a média é ponderada por TEMPO ==================== */

  test('a média pondera pelo TEMPO de vigência, não pela contagem de leituras', async () => {
    /*
     * O CASO QUE SEPARA AS DUAS CONTAS.
     * Preço 100 durante 27 dias, depois 40 durante 3 dias.
     * - média das LINHAS (2 linhas) ............ 70,00  ← errada
     * - média ponderada pelo tempo ............. ~94,00 ← certa
     * A diferença não é acadêmica: com a conta errada, o produto a 40 pareceria
     * 43% abaixo do normal; com a certa, 57%. E se fosse ao contrário — muitas
     * leituras num preço que durou pouco — o motor anunciaria promoção onde não
     * há.
     */
    const id = P + 'ponderada';
    await ponto(id, 100, 30);
    await ponto(id, 40, 3);

    const est = await m.estatisticas(id, 90);
    assert.ok(est, 'estatística não veio');
    const media = est.mediaPonderada!;
    assert.ok(media > 85 && media < 100,
      `média ponderada deveria ficar perto de 94 (o preço 100 vigorou 27 dos 30 dias), veio ${media}`);
    assert.ok(media > 75, 'se viesse ~70 seria a média simples das linhas — a conta errada');
    assert.equal(est.minimo, 40);
    assert.equal(est.maximo, 100);
  });

  test('produto estável há meses ainda tem média na janela', async () => {
    /*
     * No log de mudança, um produto que não mexe no preço há 6 meses NÃO tem
     * nenhuma linha dentro de uma janela de 30 dias. Sem trazer o preço que já
     * vigorava, a janela pareceria vazia justamente no caso mais simples — e o
     * produto sumiria do monitor por ser estável demais.
     */
    const id = P + 'antigo';
    await ponto(id, 250, 200);

    const est = await m.estatisticas(id, 30);
    assert.ok(est, 'produto sem linha na janela sumiu da estatística');
    assert.equal(Math.round(est.mediaPonderada!), 250,
      'o preço vigente antes da janela tem que ser considerado');
  });

  /* ==================== cobertura é parte do dado ==================== */

  test('poucos dias de observação NÃO viram afirmação confiável', async () => {
    /*
     * O pedido do dono, literal: mostrar correlação de 3 dias é inútil. Aqui
     * isso é uma trava, não um comentário.
     */
    const id = P + 'novato';
    await ponto(id, 100, 2);
    await ponto(id, 90, 1);

    const est = await m.estatisticas(id, 90);
    assert.equal(est!.confiavel, false, '2 dias de histórico não podem ser "confiável"');
    assert.ok(est!.mediaPonderada != null, 'mas o número ainda aparece — não é censura, é rótulo');
  });

  test('histórico longo E cobertura boa viram confiável', async () => {
    const id = P + 'maduro';
    for (let d = 40; d >= 0; d -= 1) await ponto(id, 100 + (d % 7), d);

    const est = await m.estatisticas(id, 42);
    assert.ok(est!.diasCobertos >= 30, `esperava >=30 dias cobertos, veio ${est!.diasCobertos}`);
    assert.equal(est!.confiavel, true);
  });

  /* ==================== o ranking ==================== */

  test('as melhores oportunidades são as mais abaixo do PRÓPRIO histórico', async () => {
    await limpar();
    // caro: sempre 1000. barato: era 1000, caiu para 500.
    const caro = P + 'caro', pechincha = P + 'pechincha';
    for (let d = 40; d >= 0; d -= 2) await ponto(caro, 1000, d);
    for (let d = 40; d >= 2; d -= 2) await ponto(pechincha, 1000, d);
    await ponto(pechincha, 500, 0);
    await m.registrarLeituras([
      { productId: caro, shopId: null, price: 1000, title: 'Caro' },
      { productId: pechincha, shopId: null, price: 500, title: 'Pechincha' },
    ]);

    const lista = await m.melhoresOportunidades({ dias: 42, limite: 10 });
    const ids = lista.map((l) => l.product_id);
    assert.ok(ids.includes(pechincha), 'o que caiu tem que aparecer');
    assert.ok(!ids.includes(caro), 'o que não caiu NÃO pode aparecer como oportunidade');
    const p = lista.find((l) => l.product_id === pechincha)!;
    assert.ok(Number(p.abaixo_pct) > 30, `esperava queda >30%, veio ${p.abaixo_pct}`);
  });

  /* ==================== histórico dia a dia ==================== */

  test('o dia a dia distingue "não mudou" de "ninguém olhou"', async () => {
    /*
     * A distinção que um gráfico contínuo apaga — e que num monitor jovem é a
     * informação mais importante da tela.
     */
    const id = P + 'diario';
    await ponto(id, 80, 5);

    const dias = await m.historicoDiario(id, 7);
    assert.ok(dias.length >= 7, 'a série diária tem que cobrir a janela inteira');

    const comLeitura = dias.filter((d) => d.visto === 'true');
    const herdados = dias.filter((d) => d.visto === 'false' && d.preco != null);
    assert.equal(comLeitura.length, 1, 'só um dia teve leitura de verdade');
    assert.ok(herdados.length >= 4, 'os dias seguintes herdam o preço vigente, marcados como não-vistos');
    assert.equal(Number(herdados[0]!.preco), 80, 'o preço herdado é o que vigorava');
  });

  test('produto ESTÁVEL e bem observado é confiável — a máscara existe para isto', async () => {
    /*
     * O CASO QUE A MÁSCARA EXISTE PARA RESOLVER, e que o teste anterior NÃO
     * exercita (ele muda de preço todo dia, então o log de mudança sozinho já
     * bastaria).
     *
     * Aqui o preço NUNCA muda. No log há UMA linha. Contar dias distintos no
     * log daria cobertura 1/42 → "sem base" — para o produto mais bem
     * observado possível. A máscara guarda "olhamos neste dia", que é a
     * pergunta que a cobertura faz de verdade.
     */
    const id = P + 'estavel_observado';
    await query(`DELETE FROM price_points WHERE product_id=$1`, [id]);
    await query(`DELETE FROM price_state  WHERE product_id=$1`, [id]);

    await m.registrarLeituras([{ productId: id, shopId: null, price: 199.9, title: 'Estável' }]);
    // 40 dias de observação, preço sempre igual: uma linha só no log.
    await query(
      `UPDATE price_state SET dias_mask = (1::bigint << 40) - 1, dias_mask_em = current_date
        WHERE product_id = $1`, [id]);

    const linhas = await query<{ n: string }>(
      `SELECT count(*) AS n FROM price_points WHERE product_id=$1`, [id]);
    assert.equal(Number(linhas[0]!.n), 1, 'o log de mudança tem UMA linha — é essa a premissa');

    const est = await m.estatisticas(id, 42);
    assert.equal(est!.diasCobertos, 40,
      'a cobertura tem que vir da máscara (40), não da contagem de linhas (1)');
    assert.equal(est!.confiavel, true,
      'produto olhado 40 de 42 dias É confiável, mesmo sem nunca ter mudado de preço');
    assert.equal(est!.mediaPonderada, 199.9);
  });

  test('máscara defasada NÃO conta dias em que ninguém olhou', async () => {
    /*
     * Se o produto sumiu da varredura por 10 dias, a máscara guardada continua
     * com os bits antigos acesos. Sem deslocar na LEITURA, ele alegaria uma
     * continuidade que não houve.
     */
    const id = P + 'defasado';
    await query(`DELETE FROM price_points WHERE product_id=$1`, [id]);
    await query(`DELETE FROM price_state  WHERE product_id=$1`, [id]);
    await m.registrarLeituras([{ productId: id, shopId: null, price: 10 }]);
    await query(
      `UPDATE price_state SET dias_mask = (1::bigint << 20) - 1,
                              dias_mask_em = current_date - 10
        WHERE product_id = $1`, [id]);

    const est = await m.estatisticas(id, 42);
    assert.equal(est!.diasCobertos, 20,
      'os 20 dias observados continuam contando — eles aconteceram');
    // Mas deslocados: o bit mais novo agora está 10 dias atrás, não hoje.
    const st = await queryOne<{ mask: string }>(
      `SELECT dias_mask::text AS mask FROM price_state WHERE product_id=$1`, [id]);
    assert.equal(st!.mask, String((1n << 20n) - 1n), 'a leitura NÃO pode reescrever o estado');
  });

  test('lacuna de 62+ dias zera a cobertura em vez de estourar o bigint', async () => {
    /*
     * REGRESSÃO. O deslocamento era `(1::bigint << 63) - 1`, que estoura o
     * signed int8 — e derrubava a query INTEIRA com "bigint out of range",
     * dentro da varredura, que é o caminho mais quente do sistema.
     */
    const id = P + 'lacuna';
    await query(`DELETE FROM price_points WHERE product_id=$1`, [id]);
    await query(`DELETE FROM price_state  WHERE product_id=$1`, [id]);
    await m.registrarLeituras([{ productId: id, shopId: null, price: 10 }]);
    await query(
      `UPDATE price_state SET dias_mask = 9223372036854775807 >> 1,
                              dias_mask_em = current_date - 400
        WHERE product_id = $1`, [id]);

    // Não pode lançar.
    const r = await m.registrarLeituras([{ productId: id, shopId: null, price: 99 }]);
    assert.equal(r.gravadas, 1);
    const st = await queryOne<{ mask: string }>(
      `SELECT dias_mask::text AS mask FROM price_state WHERE product_id=$1`, [id]);
    assert.equal(st!.mask, '1', 'após 400 dias sumido, a cobertura recomeça: só o bit de hoje');
  });

  test('backfill é idempotente — rodar duas vezes não duplica', async () => {
    const antes = await queryOne<{ n: string }>(`SELECT count(*) AS n FROM price_points`);
    await m.backfill();
    const meio = await queryOne<{ n: string }>(`SELECT count(*) AS n FROM price_points`);
    await m.backfill();
    const depois = await queryOne<{ n: string }>(`SELECT count(*) AS n FROM price_points`);
    assert.equal(meio!.n, depois!.n, 'a segunda passada não pode inserir nada');
    assert.ok(Number(depois!.n) >= Number(antes!.n));
  });
}
