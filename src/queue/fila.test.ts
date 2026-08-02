import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

/**
 * A FILA DE CADA GRUPO — o que o painel mostra tem que ser o que o worker faz.
 *
 * Esta é a razão de o teste existir e não ser "só uma tela": a fila é a MESMA
 * verdade lida de dois lugares. O worker reclama a próxima oferta com uma
 * condição; o painel mostra a fila com outra. Se as duas divergirem — e
 * consultas gêmeas divergem na primeira vez que alguém mexe numa —, o dono
 * passa a confiar num número que não corresponde ao que vai sair.
 *
 * Por isso o teste central aqui não é "a rota responde 200": é que a fila
 * exibida e a oferta efetivamente reclamada pelo `dispatchOne` são a mesma
 * coisa, na mesma ordem, inclusive com fura-fila no meio.
 *
 *   INTEL_TEST_DATABASE_URL=postgres://... npm run test:fila
 */

const DB = process.env.INTEL_TEST_DATABASE_URL;

if (!DB) {
  test('INTEGRAÇÃO PULADA — falta INTEL_TEST_DATABASE_URL', () => {
    console.warn('\n  [!] fila.test.ts NÃO RODOU: defina INTEL_TEST_DATABASE_URL.\n');
    assert.ok(true);
  });
} else {
  process.env.DATABASE_URL = DB;
  process.env.SHOPEE_APP_ID ??= 'teste';
  process.env.SHOPEE_APP_SECRET ??= 'teste';
  /*
   * REDIS DELIBERADAMENTE AUSENTE, apontado para uma porta local que RECUSA na
   * hora. Duas razões:
   *
   * 1. Determinismo. O padrão é o host `redis`, que só existe na rede do
   *    Docker; fora dela vira uma resolução de DNS que falha de formas
   *    diferentes conforme a máquina.
   * 2. É o cenário que interessa. Pausar um canal chama `removeDripJob`, que
   *    fala com o Redis — e a pausa PRECISA funcionar mesmo com o Redis fora
   *    do ar, porque quem pausa de verdade é a coluna `channels.status`. Este
   *    arquivo foi o que revelou que, sem prazo, a rota pendurava para sempre.
   */
  process.env.REDIS_URL = 'redis://127.0.0.1:6399';

  /*
   * O ioredis segue tentando reconectar em segundo plano enquanto o teste roda,
   * e cada tentativa recusada vira uma rejeição. São ESPERADAS aqui — o Redis
   * está fora por escolha. Sem esta guarda, o runner reporta o arquivo inteiro
   * como falho mesmo com todos os testes verdes.
   */
  process.on('unhandledRejection', (e) => {
    const m = e instanceof Error ? e.message : String(e);
    if (/ECONNREFUSED|ENOTFOUND|Connection is closed|Stream isn't writeable/i.test(m)) return;
    throw e;
  });

  const { app } = require('../api') as typeof import('../api');
  const { migrate } = require('../migrate') as typeof import('../migrate');
  const { query, queryOne, closePool } = require('../db') as typeof import('../db');
  const { trocarSenha, usuarioPainel } = require('../security') as typeof import('../security');
  const { tamanhoDaFila, proximasDaFila } = require('./scheduler') as typeof import('./scheduler');
  const { closeQueues } = require('./queues') as typeof import('./queues');

  const INSTANCIA = 'teste-fila';
  const GRUPO = '120363555000000999@g.us';
  const SENHA = 'senha-de-teste-1234';
  let basic = '';
  let server: Server;
  let base = '';
  let canalId = '';

  const criarOferta = async (titulo: string, preco: number, prioridade = false, minutosAtras = 0) => {
    const r = await queryOne<{ id: string }>(
      `INSERT INTO offers (platform, product_id, dedup_key, title, price, status, is_priority, created_at)
       VALUES ('shopee', $1, $1, $2, $3, 'approved', $4, now() - ($5 || ' minutes')::interval)
       RETURNING id`,
      [`fila-${titulo}`, titulo, preco, prioridade, String(minutosAtras)],
    );
    return r!.id;
  };

  before(async () => {
    await migrate();
    /*
     * Limpa na ORDEM DAS DEPENDÊNCIAS. `send_logs` e `schedules` referenciam
     * `channels`, então apagar o canal primeiro estoura a chave estrangeira —
     * e foi o que aconteceu quando uma execução anterior morreu no meio e
     * deixou resíduo: o `before` da seguinte falhava e TODOS os testes ficavam
     * vermelhos por um motivo que nada tinha a ver com eles.
     */
    await query(
      `DELETE FROM send_logs WHERE channel_id IN (SELECT id FROM channels WHERE instance_ref = $1)`,
      [INSTANCIA],
    );
    await query(
      `DELETE FROM schedules WHERE channel_id IN (SELECT id FROM channels WHERE instance_ref = $1)`,
      [INSTANCIA],
    );
    await query(`DELETE FROM channels WHERE instance_ref = $1`, [INSTANCIA]);
    await query(`DELETE FROM send_logs WHERE offer_id IN (SELECT id FROM offers WHERE product_id LIKE 'fila-%')`);
    await query(`DELETE FROM offers WHERE product_id LIKE 'fila-%'`);
    const ch = await queryOne<{ id: string }>(
      `INSERT INTO channels (platform, role, instance_ref, target_ref, display_name, status,
                             drip_min_sec, drip_max_sec, jitter_min_sec, jitter_max_sec, daily_cap)
       VALUES ('whatsapp','poster',$1,$2,'Grupo de teste','active',1200,1800,180,300,250)
       RETURNING id`,
      [INSTANCIA, GRUPO],
    );
    canalId = ch!.id;
    await trocarSenha(SENHA);
    basic = 'Basic ' + Buffer.from(`${await usuarioPainel()}:${SENHA}`).toString('base64');
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const a = server.address();
        base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
        resolve();
      });
    });
  });

  after(async () => {
    try {
      await query(
        `DELETE FROM send_logs WHERE channel_id IN (SELECT id FROM channels WHERE instance_ref = $1)`,
        [INSTANCIA],
      );
      await query(
        `DELETE FROM schedules WHERE channel_id IN (SELECT id FROM channels WHERE instance_ref = $1)`,
        [INSTANCIA],
      );
      await query(`DELETE FROM channels WHERE instance_ref = $1`, [INSTANCIA]);
      await query(`DELETE FROM send_logs WHERE offer_id IN (SELECT id FROM offers WHERE product_id LIKE 'fila-%')`);
      await query(`DELETE FROM offers WHERE product_id LIKE 'fila-%'`);
    } finally {
      // `server` fica indefinido se o `before` falhar; sem esta guarda o erro
      // do teardown MASCARA a causa real e some com o diagnóstico.
      if (server) await new Promise<void>((r) => server.close(() => r()));
      // Sem isto o processo NÃO encerra: o ioredis do BullMQ reconecta para
      // sempre e a suíte verde é relatada como falha por timeout do arquivo.
      await closeQueues();
      await closePool();
    }
  });

  const get = async (caminho: string) => {
    const r = await fetch(base + caminho, { headers: { authorization: basic } });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  const patch = async (caminho: string, body: unknown) => {
    const r = await fetch(base + caminho, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: basic },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };

  /* ==================== a fila mostrada é a fila real ==================== */

  test('a ORDEM mostrada é a ordem em que o worker vai pegar — fura-fila primeiro', async () => {
    /*
     * Semeia fora de ordem de propósito: a mais ANTIGA sem prioridade, depois
     * uma recente COM prioridade. Se o painel ordenasse por chegada (o jeito
     * óbvio de escrever a consulta), a fura-fila apareceria por último — e o
     * dono veria uma ordem que o motor não vai seguir.
     */
    await criarOferta('antiga', 100, false, 60);
    await criarOferta('media', 200, false, 30);
    await criarOferta('furafila', 300, true, 1);

    const r = await get(`/api/channels/${canalId}/fila`);
    assert.equal(r.status, 200);
    assert.equal(r.json.naFila, 3);
    assert.deepEqual(r.json.proximas.map((o: any) => o.title), ['furafila', 'antiga', 'media']);

    // e a MESMA coisa vista pelo lado do worker
    const doWorker = await proximasDaFila(canalId, 8);
    assert.deepEqual(doWorker.map((o: any) => o.title), ['furafila', 'antiga', 'media'],
      'painel e worker precisam ver a mesma fila, na mesma ordem');
    assert.equal(await tamanhoDaFila(canalId), 3);
  });

  test('oferta já enviada PARA ESTE canal sai da fila dele', async () => {
    const antes = await get(`/api/channels/${canalId}/fila`);
    const idAntiga = await queryOne<{ id: string; dedup_key: string }>(
      `SELECT id, dedup_key FROM offers WHERE title = 'antiga'`,
    );
    await query(
      `INSERT INTO send_logs (offer_id, channel_id, offer_dedup_key, status, sent_at)
       VALUES ($1,$2,$3,'sent',now())`,
      [idAntiga!.id, canalId, idAntiga!.dedup_key],
    );
    const depois = await get(`/api/channels/${canalId}/fila`);
    assert.equal(depois.json.naFila, antes.json.naFila - 1);
    assert.ok(!depois.json.proximas.some((o: any) => o.title === 'antiga'));
    assert.equal(depois.json.enviadasHoje, 1, 'o contador do dia tem que subir junto');
  });

  test('a fila é POR CANAL — outro grupo continua com a oferta pendente', async () => {
    /*
     * A regressão que isto trava é real e já aconteceu neste projeto: marcar a
     * oferta como enviada globalmente após o primeiro grupo fazia os outros
     * nunca receberem.
     */
    const outro = await queryOne<{ id: string }>(
      `INSERT INTO channels (platform, role, instance_ref, target_ref, display_name, status)
       VALUES ('whatsapp','poster',$1,'120363555000000888@g.us','Outro grupo','active') RETURNING id`,
      [INSTANCIA],
    );
    try {
      const r = await get(`/api/channels/${outro!.id}/fila`);
      assert.equal(r.json.naFila, 3, 'o outro grupo ainda não recebeu nenhuma');
      assert.ok(r.json.proximas.some((o: any) => o.title === 'antiga'));
    } finally {
      await query(`DELETE FROM channels WHERE id = $1`, [outro!.id]);
    }
  });

  /* ==================== por que não está saindo ==================== */

  test('diz o MOTIVO de estar parado, não só um horário', async () => {
    const r = await get(`/api/channels/${canalId}/fila`);
    assert.equal(r.json.motivoParado, null, 'com fila e sem teto, nada deveria segurar');

    await query(`UPDATE channels SET daily_cap = 1 WHERE id = $1`, [canalId]);
    const comTeto = await get(`/api/channels/${canalId}/fila`);
    assert.match(comTeto.json.motivoParado, /teto diário/i);
    await query(`UPDATE channels SET daily_cap = 250 WHERE id = $1`, [canalId]);

    await query(`UPDATE channels SET status = 'paused' WHERE id = $1`, [canalId]);
    const pausado = await get(`/api/channels/${canalId}/fila`);
    assert.match(pausado.json.motivoParado, /pausado/i);
    await query(`UPDATE channels SET status = 'active' WHERE id = $1`, [canalId]);
  });

  test('fila vazia é dito como tal, e não como defeito', async () => {
    const vazio = await queryOne<{ id: string }>(
      `INSERT INTO channels (platform, role, instance_ref, target_ref, display_name, status)
       VALUES ('whatsapp','poster',$1,'120363555000000777@g.us','Vazio','active') RETURNING id`,
      [INSTANCIA],
    );
    try {
      await query(
        `INSERT INTO send_logs (offer_id, channel_id, offer_dedup_key, status, sent_at)
         SELECT id, $1, dedup_key, 'sent', now() FROM offers WHERE product_id LIKE 'fila-%'`,
        [vazio!.id],
      );
      const r = await get(`/api/channels/${vazio!.id}/fila`);
      assert.equal(r.json.naFila, 0);
      assert.match(r.json.motivoParado, /nada na fila/i);
    } finally {
      await query(`DELETE FROM send_logs WHERE channel_id = $1`, [vazio!.id]);
      await query(`DELETE FROM channels WHERE id = $1`, [vazio!.id]);
    }
  });

  /* ==================== configurar a cadência ==================== */

  test('salva a cadência do grupo e ela volta na leitura', async () => {
    const r = await patch(`/api/channels/${canalId}`, {
      cadencia: {
        dripMinSec: 600, dripMaxSec: 900, jitterMinSec: 60, jitterMaxSec: 120,
        tetoDiario: 80, silencioInicio: '01:00', silencioFim: '06:30',
      },
    });
    assert.equal(r.status, 200);
    assert.match(r.json.aviso, /próximo disparo/i, 'tem que avisar que só vale no próximo');

    const f = await get(`/api/channels/${canalId}/fila`);
    assert.equal(f.json.cadencia.dripMinSec, 600);
    assert.equal(f.json.cadencia.dripMaxSec, 900);
    assert.equal(f.json.cadencia.tetoDiario, 80);
    assert.equal(String(f.json.cadencia.silencioInicio).slice(0, 5), '01:00');
    assert.equal(String(f.json.cadencia.silencioFim).slice(0, 5), '06:30');
  });

  test('RECUSA mínimo maior que máximo — inverter geraria rajada', async () => {
    /*
     * `randInt(min, max)` com min > max devolve valor fora da faixa, e o
     * gotejamento passaria a reagendar em intervalo negativo: rajada, que é
     * exatamente o que a cadência existe para impedir. Corrigir por trás
     * (trocando os valores) seria o painel decidindo sozinho algo que muda o
     * risco de ban — então é 400, com o motivo.
     */
    const r = await patch(`/api/channels/${canalId}`, {
      cadencia: {
        dripMinSec: 1800, dripMaxSec: 600, jitterMinSec: 0, jitterMaxSec: 60,
        tetoDiario: 100, silencioInicio: '00:00', silencioFim: '07:00',
      },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /mínimo não pode ser maior/i);

    const f = await get(`/api/channels/${canalId}/fila`);
    assert.equal(f.json.cadencia.dripMinSec, 600, 'o valor anterior não pode ter sido tocado');
  });

  test('recusa horário inválido e número fora da faixa', async () => {
    const hora = await patch(`/api/channels/${canalId}`, {
      cadencia: {
        dripMinSec: 600, dripMaxSec: 900, jitterMinSec: 0, jitterMaxSec: 60,
        tetoDiario: 100, silencioInicio: '25:00', silencioFim: '07:00',
      },
    });
    assert.equal(hora.status, 400);
    assert.match(hora.json.error, /HH:MM/);

    const zero = await patch(`/api/channels/${canalId}`, {
      cadencia: {
        dripMinSec: 1, dripMaxSec: 900, jitterMinSec: 0, jitterMaxSec: 60,
        tetoDiario: 100, silencioInicio: '00:00', silencioFim: '07:00',
      },
    });
    assert.equal(zero.status, 400);
    assert.match(zero.json.error, /intervalo mínimo/i);
  });

  test('pausar continua funcionando pela mesma rota', async () => {
    assert.equal((await patch(`/api/channels/${canalId}`, { status: 'paused' })).status, 200);
    assert.equal((await get(`/api/channels/${canalId}/fila`)).json.canal.status, 'paused');
    assert.equal((await patch(`/api/channels/${canalId}`, { status: 'active' })).status, 200);
    assert.equal((await get(`/api/channels/${canalId}/fila`)).json.canal.status, 'active');
  });

  test('canal inexistente é 404, não 500', async () => {
    const r = await get('/api/channels/99999999/fila');
    assert.equal(r.status, 404);
  });
}
