import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

/**
 * ETIQUETA DE ASSUNTO — o cadastro que o dono pediu.
 *
 * O que precisa ser verdade não é "a rota grava": é que digitar o mesmo assunto
 * escrito de outro jeito NÃO crie uma etiqueta nova. Sem isso o catálogo enche
 * de "Esportes", "esportes" e "ESPORTES" apontando para a mesma coisa, e o
 * agrupamento por assunto — que é a razão de a etiqueta existir — para de
 * agrupar.
 *
 *   INTEL_TEST_DATABASE_URL=postgres://... npm run test:etiquetas
 */

const DB = process.env.INTEL_TEST_DATABASE_URL;

if (!DB) {
  test('INTEGRAÇÃO PULADA — falta INTEL_TEST_DATABASE_URL', () => {
    console.warn('\n  [!] etiquetas.test.ts NÃO RODOU: defina INTEL_TEST_DATABASE_URL.\n');
    assert.ok(true);
  });
} else {
  process.env.DATABASE_URL = DB;
  process.env.SHOPEE_APP_ID ??= 'teste';
  process.env.SHOPEE_APP_SECRET ??= 'teste';
  process.env.REDIS_URL = 'redis://127.0.0.1:6399'; // ausente de propósito
  process.on('unhandledRejection', (e) => {
    const m = e instanceof Error ? e.message : String(e);
    if (/ECONNREFUSED|ENOTFOUND|Connection is closed|Stream isn't writeable/i.test(m)) return;
    throw e;
  });

  const { app } = require('../api') as typeof import('../api');
  const { migrate } = require('../migrate') as typeof import('../migrate');
  const { query, queryOne, closePool } = require('../db') as typeof import('../db');
  const { trocarSenha, usuarioPainel } = require('../security') as typeof import('../security');
  const { closeQueues } = require('../queue/queues') as typeof import('../queue/queues');
  const { semearEtiquetas } = require('../shopee/categorias') as typeof import('../shopee/categorias');

  const SENHA = 'senha-de-teste-1234';
  const GRUPO = '120363777000000111@g.us';
  let basic = '';
  let server: Server;
  let base = '';
  let grupoId = '';

  const limpar = async () => {
    await query(`UPDATE intel_groups SET etiqueta_id = NULL WHERE group_jid = $1`, [GRUPO]);
    await query(`DELETE FROM intel_groups WHERE group_jid = $1`, [GRUPO]);
    /*
     * Apaga o catálogo INTEIRO, não só o que o dono cadastraria. A primeira
     * versão poupava as de origem 'shopee', e aí a segunda execução encontrava
     * a semeadura da primeira já feita: `ON CONFLICT DO NOTHING` devolvia 0 e o
     * teste da semeadura falhava por resíduo, não por defeito. Banco de teste é
     * descartável — limpar pela metade é o que cria falso vermelho.
     */
    await query(`UPDATE intel_groups SET etiqueta_id = NULL`);
    await query(`DELETE FROM etiquetas_grupo`);
    await query(`DELETE FROM shopee_categories WHERE cat_id < 100`);
  };

  before(async () => {
    await migrate();
    await limpar();
    const g = await queryOne<{ id: string }>(
      `INSERT INTO intel_groups (group_jid, display_name, kind, is_active)
       VALUES ($1,'Grupo de teste','promo',true) RETURNING id::text AS id`,
      [GRUPO],
    );
    grupoId = g!.id;
    await trocarSenha(SENHA);
    basic = 'Basic ' + Buffer.from(`${await usuarioPainel()}:${SENHA}`).toString('base64');
    await new Promise<void>((r) => {
      server = app.listen(0, '127.0.0.1', () => {
        const a = server.address();
        base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
        r();
      });
    });
  });

  after(async () => {
    try { await limpar(); } finally {
      if (server) await new Promise<void>((r) => server.close(() => r()));
      await closeQueues();
      await closePool();
    }
  });

  const req = async (caminho: string, metodo = 'GET', corpo?: unknown) => {
    const r = await fetch(base + caminho, {
      method: metodo,
      headers: { 'content-type': 'application/json', authorization: basic },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, json: (await r.json()) as any };
  };

  /* ==================== o cadastro ==================== */

  test('cadastra um assunto novo', async () => {
    const r = await req('/api/intel/etiquetas', 'POST', { nome: 'Esportes' });
    assert.equal(r.status, 200);
    assert.equal(r.json.nome, 'Esportes');
    assert.equal(r.json.jaExistia, false);
    assert.ok(r.json.id);
  });

  test('MESMO assunto escrito de outro jeito NÃO duplica', async () => {
    /*
     * É o teste central. "esportes", "ESPORTES" e "  Esportes  " são a mesma
     * coisa para quem digita; se virassem três linhas, o agrupamento por
     * assunto pararia de agrupar e o dono cadastraria de novo achando que
     * falhou.
     */
    for (const variante of ['esportes', 'ESPORTES', '  Esportes  ', 'Esportès']) {
      const r = await req('/api/intel/etiquetas', 'POST', { nome: variante });
      assert.equal(r.status, 200, `variante "${variante}" deveria dar 200`);
      assert.equal(r.json.jaExistia, true, `"${variante}" deveria bater com a existente`);
      assert.equal(r.json.nome, 'Esportes', 'tem que devolver a que JÁ existe, com o nome original');
    }
    const n = await queryOne<{ n: string }>(
      `SELECT count(*) AS n FROM etiquetas_grupo WHERE origem = 'usuario'`,
    );
    assert.equal(Number(n?.n), 1, 'só pode existir UMA linha para todas as variantes');
  });

  test('recusa nome curto demais e longo demais', async () => {
    assert.equal((await req('/api/intel/etiquetas', 'POST', { nome: 'a' })).status, 400);
    assert.equal((await req('/api/intel/etiquetas', 'POST', { nome: '  ' })).status, 400);
    assert.equal((await req('/api/intel/etiquetas', 'POST', { nome: 'x'.repeat(31) })).status, 400,
      'acima de 30 tem que recusar — é o que a interface consegue mostrar inteiro');
    assert.equal((await req('/api/intel/etiquetas', 'POST', { nome: 'x'.repeat(30) })).status, 200,
      'exatamente 30 tem que passar');
  });

  /* ==================== ligar ao grupo ==================== */

  test('aplica o assunto ao grupo e ele volta na listagem', async () => {
    const et = await req('/api/intel/etiquetas', 'POST', { nome: 'Tecnologia (PC)' });
    const p = await req('/api/intel/groups/' + grupoId, 'PATCH', { etiqueta_id: et.json.id });
    assert.equal(p.status, 200);

    const lista = await req('/api/intel/groups');
    const g = lista.json.find((x: any) => x.group_jid === GRUPO);
    assert.ok(g, 'grupo sumiu da listagem');
    assert.equal(g.etiqueta, 'Tecnologia (PC)', 'o nome do assunto tem que vir junto');
    assert.equal(String(g.etiqueta_id), String(et.json.id));
  });

  test('dá para TIRAR o assunto — "sem assunto" é estado legítimo', async () => {
    /*
     * Sem essa saída, uma marcação errada seria permanente: o dono escolheria
     * "Moda" por engano e não teria como voltar a "não sei ainda".
     */
    const p = await req('/api/intel/groups/' + grupoId, 'PATCH', { etiqueta_id: null });
    assert.equal(p.status, 200);
    const lista = await req('/api/intel/groups');
    const g = lista.json.find((x: any) => x.group_jid === GRUPO);
    assert.equal(g.etiqueta, null);
    assert.equal(g.etiqueta_id, null);
  });

  test('o PAPEL (kind) e o ASSUNTO são independentes', async () => {
    /*
     * São duas perguntas diferentes — misturá-las foi o que tornou "promoção
     * genérica" raso. Mexer numa não pode mexer na outra.
     */
    const et = await req('/api/intel/etiquetas', 'POST', { nome: 'Maquiagem' });
    await req('/api/intel/groups/' + grupoId, 'PATCH', { etiqueta_id: et.json.id });
    await req('/api/intel/groups/' + grupoId, 'PATCH', { kind: 'nicho' });

    const lista = await req('/api/intel/groups');
    const g = lista.json.find((x: any) => x.group_jid === GRUPO);
    assert.equal(g.kind, 'nicho', 'o papel mudou');
    assert.equal(g.etiqueta, 'Maquiagem', 'e o assunto continuou');
  });

  /* ==================== catálogo semeado ==================== */

  test('o catálogo nasce das categorias oficiais da Shopee', async () => {
    await query(
      `INSERT INTO shopee_categories (cat_id, parent_id, nome, nivel) VALUES
        (1,0,'Eletrodomésticos',1), (2,0,'Beleza',1), (3,0,'Computadores e Acessórios',1)
       ON CONFLICT (cat_id) DO NOTHING`,
    );
    const n = await semearEtiquetas();
    assert.ok(n >= 3, `deveria semear ao menos 3, semeou ${n}`);

    const lista = await req('/api/intel/etiquetas');
    const nomes = lista.json.map((e: any) => e.nome);
    for (const esperado of ['Eletrodomésticos', 'Beleza', 'Computadores e Acessórios']) {
      assert.ok(nomes.includes(esperado), `faltou "${esperado}" no catálogo`);
    }
    const daShopee = lista.json.filter((e: any) => e.origem === 'shopee');
    assert.ok(daShopee.length >= 3, 'as semeadas têm que ficar marcadas como origem shopee');
  });

  test('semear DE NOVO não duplica', async () => {
    const antes = (await req('/api/intel/etiquetas')).json.length;
    await semearEtiquetas();
    assert.equal((await req('/api/intel/etiquetas')).json.length, antes);
  });

  test('não deixa apagar etiqueta que veio da Shopee', async () => {
    /*
     * Apagar uma da Shopee criaria uma divergência silenciosa: a próxima
     * semeadura a traria de volta, e o dono acharia que "não apaga".
     */
    const lista = await req('/api/intel/etiquetas');
    const daShopee = lista.json.find((e: any) => e.origem === 'shopee');
    const r = await req('/api/intel/etiquetas/' + daShopee.id, 'DELETE');
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Shopee/i);
  });

  test('deixa apagar as que o dono cadastrou', async () => {
    const nova = await req('/api/intel/etiquetas', 'POST', { nome: 'Descartável' });
    assert.equal((await req('/api/intel/etiquetas/' + nova.json.id, 'DELETE')).status, 200);
    const lista = await req('/api/intel/etiquetas');
    assert.ok(!lista.json.some((e: any) => e.nome === 'Descartável'));
  });
}
