import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Server } from 'node:http';

/**
 * CRIAR GRUPO PELO PAINEL — provado sem WhatsApp real.
 *
 * O que precisa ser verdade para este recurso funcionar não é "o WhatsApp criou
 * o grupo" (isso é do lado deles). É que a REQUISIÇÃO que o app monta seja
 * exatamente a que a Evolution aceita — e é justamente onde dá errado, porque
 * o `createGroupSchema` oficial recusa:
 *   - `participants` ausente ou vazio (minItems: 1)
 *   - participante que não seja string SÓ de dígitos com 10+ caracteres
 * Um telefone digitado como "(11) 99999-9999" bate nessa segunda regra e volta
 * 400 com mensagem que não ajuda ninguém.
 *
 * Então a Evolution aqui é um servidor HTTP falso que GRAVA o que recebeu, e o
 * teste afirma sobre o corpo — mesma técnica que provou o disparo. O que não dá
 * para simular é o WhatsApp aceitar o IQ de criação; o contrato com a Evolution,
 * dá.
 *
 *   INTEL_TEST_DATABASE_URL=postgres://... npm run test:grupo
 */

const DB = process.env.INTEL_TEST_DATABASE_URL;

if (!DB) {
  test('INTEGRAÇÃO PULADA — falta INTEL_TEST_DATABASE_URL', () => {
    console.warn(
      '\n  [!] grupo.test.ts NÃO RODOU: defina INTEL_TEST_DATABASE_URL apontando\n' +
        '      para um Postgres descartável. Sem isso a criação de grupo pelo painel\n' +
        '      fica SEM cobertura.\n',
    );
    assert.ok(true);
  });
} else {
  process.env.DATABASE_URL = DB;
  process.env.SHOPEE_APP_ID ??= 'teste';
  process.env.SHOPEE_APP_SECRET ??= 'teste';
  /*
   * Redis ausente de propósito, em porta que RECUSA na hora. A rota de criar
   * grupo invalida o cache da lista de grupos, e sem isso o teste tentaria
   * resolver o host `redis` (que só existe na rede do Docker) de formas
   * diferentes conforme a máquina.
   */
  process.env.REDIS_URL = 'redis://127.0.0.1:6399';
  process.on('unhandledRejection', (e) => {
    const m = e instanceof Error ? e.message : String(e);
    if (/ECONNREFUSED|ENOTFOUND|Connection is closed|Stream isn't writeable/i.test(m)) return;
    throw e;
  });

  const { app } = require('../api') as typeof import('../api');
  const { closeQueues } = require('../queue/queues') as typeof import('../queue/queues');
  const { migrate } = require('../migrate') as typeof import('../migrate');
  const { query, closePool } = require('../db') as typeof import('../db');
  const { setSetting } = require('../settings') as typeof import('../settings');
  const { trocarSenha, usuarioPainel } = require('../security') as typeof import('../security');

  /*
   * Estas rotas ficam ATRÁS do porteiro do painel — diferente do webhook, que é
   * livre por ter segredo próprio na URL. O teste então autentica de verdade,
   * por Basic auth (o mesmo caminho que o porteiro abre para curl). Isso é de
   * propósito: se alguém tornar /api/instances público sem querer, este teste
   * não avisaria — mas a rota nova NÃO pode ser pública, então o teste
   * passar por autenticação é parte do contrato que ele verifica.
   */
  const SENHA_TESTE = 'senha-de-teste-1234';
  let basic = '';

  const INSTANCIA = 'teste-grupo';
  const JID_CRIADO = '120363111222333444@g.us';

  interface Recebido { metodo: string; caminho: string; corpo: Record<string, unknown>; apikey?: string }
  let recebidas: Recebido[] = [];
  let falharEm: string | null = null;

  let evoFake: Server;
  let appServer: Server;
  let base = '';

  const achar = (fragmento: string) => recebidas.find((r) => r.caminho.includes(fragmento));

  before(async () => {
    await migrate();

    /* ---- Evolution falsa ---- */
    await new Promise<void>((resolve) => {
      evoFake = http.createServer((req, res) => {
        let cru = '';
        req.on('data', (c) => (cru += c));
        req.on('end', () => {
          let corpo: Record<string, unknown> = {};
          try { corpo = cru ? JSON.parse(cru) : {}; } catch { corpo = { raw: cru }; }
          recebidas.push({
            metodo: req.method ?? '',
            caminho: req.url ?? '',
            corpo,
            apikey: req.headers.apikey as string | undefined,
          });

          const responder = (code: number, body: unknown) => {
            res.writeHead(code, { 'content-type': 'application/json' });
            res.end(JSON.stringify(body));
          };
          if (falharEm && (req.url ?? '').includes(falharEm)) return responder(500, { error: 'falha simulada' });

          if ((req.url ?? '').includes('/group/create/')) {
            // Resposta no formato REAL: groupMetadata cru do Baileys, JID em `id`.
            const parts = (corpo.participants as string[] | undefined) ?? [];
            return responder(201, {
              id: JID_CRIADO,
              subject: corpo.subject,
              owner: '5511000000000@s.whatsapp.net',
              participants: [{ id: 'dono' }, ...parts.map((p) => ({ id: `${p}@s.whatsapp.net` }))],
            });
          }
          if ((req.url ?? '').includes('/group/updateSetting/')) return responder(200, { updateSetting: 'success' });
          if ((req.url ?? '').includes('/group/inviteCode/')) {
            return responder(200, { inviteUrl: 'https://chat.whatsapp.com/ABC123fake', inviteCode: 'ABC123fake' });
          }
          return responder(200, {});
        });
      });
      evoFake.listen(0, '127.0.0.1', () => resolve());
    });
    await trocarSenha(SENHA_TESTE);
    basic = 'Basic ' + Buffer.from(`${await usuarioPainel()}:${SENHA_TESTE}`).toString('base64');

    const ea = evoFake.address();
    const evoUrl = `http://127.0.0.1:${typeof ea === 'object' && ea ? ea.port : 0}`;
    await setSetting('evolution_api_url', evoUrl);
    await setSetting('evolution_api_key', 'chave-de-teste');

    /* ---- app ---- */
    await new Promise<void>((resolve) => {
      appServer = app.listen(0, '127.0.0.1', () => {
        const a = appServer.address();
        base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
        resolve();
      });
    });
  });

  after(async () => {
    try {
      await query('DELETE FROM channels WHERE instance_ref = $1', [INSTANCIA]);
      await query('DELETE FROM intel_groups WHERE group_jid = $1', [JID_CRIADO]);
      await setSetting('evolution_api_url', null);
      await setSetting('evolution_api_key', null);
    } finally {
      await new Promise<void>((r) => appServer.close(() => r()));
      await new Promise<void>((r) => evoFake.close(() => r()));
      // O ioredis reconecta para sempre: sem derrubar, o processo não encerra e
      // a suíte VERDE é relatada como falha por timeout do arquivo.
      await closeQueues();
      await closePool();
    }
  });

  const criar = async (body: unknown) => {
    recebidas = [];
    const r = await fetch(`${base}/api/instances/${INSTANCIA}/groups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: basic },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };

  /* ==================== o que a Evolution recebe ==================== */

  test('monta a requisição EXATAMENTE como o schema da Evolution exige', async () => {
    const r = await criar({
      subject: 'Ofertas do Dia',
      description: 'Só o admin posta',
      participants: '(11) 99999-9999',
      somenteAdmin: false,
      registrar: 'nao',
    });
    assert.equal(r.status, 200);

    const criacao = achar('/group/create/');
    assert.ok(criacao, 'não chamou o endpoint de criação');
    assert.equal(criacao.metodo, 'POST');
    assert.ok(criacao.caminho.endsWith(`/group/create/${INSTANCIA}`), `caminho errado: ${criacao.caminho}`);
    assert.equal(criacao.apikey, 'chave-de-teste', 'a Evolution exige o header apikey');
    assert.equal(criacao.corpo.subject, 'Ofertas do Dia');
    assert.equal(criacao.corpo.description, 'Só o admin posta');

    // O ponto do teste: "(11) 99999-9999" tem que virar dígito puro com país,
    // senão `pattern: '\\d+'` + `minLength: 10` reprovam com 400.
    assert.deepEqual(criacao.corpo.participants, ['5511999999999']);
    assert.ok(
      (criacao.corpo.participants as string[]).every((p) => /^\d{10,}$/.test(p)),
      'participante tem que ser string só de dígitos, 10+',
    );
  });

  test('separa por vírgula/ponto-e-vírgula/linha — mas NUNCA por espaço', async () => {
    /*
     * Espaço NÃO separa, e isso é o contrário do que eu tinha escrito: no
     * Brasil ele faz parte da formatação de UM número ("(11) 99999-9999").
     * Separar por espaço quebrava o número em "(11)" e "99999-9999", os dois
     * inválidos, e a forma mais natural de digitar virava erro. Foi este teste
     * que pegou.
     */
    await criar({
      subject: 'G2',
      participants: '(11) 99999-9999, 21 98888-7777; +55 31 97777-6666',
      somenteAdmin: false,
      registrar: 'nao',
    });
    assert.deepEqual(achar('/group/create/')!.corpo.participants, [
      '5511999999999', '5521988887777', '5531977776666',
    ]);
  });

  test('aceita também um array de números, não só a linha digitada', async () => {
    await criar({
      subject: 'G3',
      participants: ['11999999999', '(21) 98888-7777'],
      somenteAdmin: false,
      registrar: 'nao',
    });
    assert.deepEqual(achar('/group/create/')!.corpo.participants, ['5511999999999', '5521988887777']);
  });

  /* ==================== o que a Evolution NÃO pode receber ==================== */

  test('recusa ANTES de chamar a Evolution quando não há participante', async () => {
    // `minItems: 1` no schema oficial: sem participante a Evolution devolve 400
    // de validação. Melhor recusar aqui, com uma mensagem que diz o que fazer.
    const r = await criar({ subject: 'Sem ninguém', participants: '', registrar: 'nao' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /pelo menos 1 participante/i);
    assert.equal(achar('/group/create/'), undefined, 'não pode ter chamado a Evolution');
  });

  test('recusa número torto em vez de deixar a Evolution devolver 400 obscuro', async () => {
    const r = await criar({ subject: 'G', participants: '999', registrar: 'nao' });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /999/, 'a mensagem tem que dizer QUAL número está errado');
    assert.equal(achar('/group/create/'), undefined);
  });

  test('recusa grupo sem nome', async () => {
    const r = await criar({ subject: '   ', participants: '11999999999', registrar: 'nao' });
    assert.equal(r.status, 400);
    assert.equal(achar('/group/create/'), undefined);
  });

  /* ==================== o resto do fluxo ==================== */

  test('"só admin posta" vira action=announcement (e não locked, que é outra coisa)', async () => {
    await criar({ subject: 'Mural', participants: '11999999999', somenteAdmin: true, registrar: 'nao' });
    const s = achar('/group/updateSetting/');
    assert.ok(s, 'não travou o grupo');
    assert.equal(s.corpo.action, 'announcement');
    assert.equal(s.corpo.groupJid, JID_CRIADO);
  });

  test('somenteAdmin=false NÃO trava o grupo', async () => {
    await criar({ subject: 'Aberto', participants: '11999999999', somenteAdmin: false, registrar: 'nao' });
    assert.equal(achar('/group/updateSetting/'), undefined);
  });

  test('devolve o link de convite — é a única coisa que o dono leva daqui', async () => {
    const r = await criar({ subject: 'Com link', participants: '11999999999', registrar: 'nao' });
    assert.equal(r.json.inviteUrl, 'https://chat.whatsapp.com/ABC123fake');
    assert.equal(r.json.jid, JID_CRIADO);
    const c = achar('/group/inviteCode/');
    assert.ok(c, 'não pediu o link');
    assert.equal(c.metodo, 'GET');
    assert.match(c.caminho, /groupJid=/, 'o groupJid vai na query string neste endpoint');
  });

  test('registra como canal de disparo, pronto para o gotejamento', async () => {
    await query('DELETE FROM channels WHERE instance_ref = $1', [INSTANCIA]);
    const r = await criar({ subject: 'Vai postar', participants: '11999999999', registrar: 'poster' });
    assert.equal(r.status, 200);
    const linha = await query<{ role: string; target_ref: string; status: string; display_name: string }>(
      'SELECT role, target_ref, status, display_name FROM channels WHERE instance_ref = $1',
      [INSTANCIA],
    );
    assert.equal(linha.length, 1);
    assert.equal(linha[0]!.role, 'poster');
    assert.equal(linha[0]!.target_ref, JID_CRIADO);
    assert.equal(linha[0]!.status, 'active');
    assert.equal(linha[0]!.display_name, 'Vai postar');
  });

  test("registrar='intel' marca como PRÓPRIO — senão contamina 'o que eles escolhem'", async () => {
    await query('DELETE FROM intel_groups WHERE group_jid = $1', [JID_CRIADO]);
    await criar({ subject: 'Meu mural', participants: '11999999999', registrar: 'intel' });
    const g = await query<{ kind: string; is_active: boolean }>(
      'SELECT kind, is_active FROM intel_groups WHERE group_jid = $1', [JID_CRIADO],
    );
    assert.equal(g.length, 1);
    assert.equal(g[0]!.kind, 'proprio', 'o grupo do dono NÃO pode entrar como concorrente');
    assert.equal(g[0]!.is_active, true);
  });

  /* ==================== quando algo falha no meio ==================== */

  test('se o link de convite falhar, o grupo NÃO vira erro — ele existe', async () => {
    /*
     * Este é o caso que mais importa depois do caminho feliz. O grupo já foi
     * criado no WhatsApp; devolver 502 faria o painel dizer "erro", o dono
     * clicaria de novo, e ele acabaria com um grupo órfão por tentativa.
     */
    falharEm = '/group/inviteCode/';
    try {
      const r = await criar({ subject: 'Sem link', participants: '11999999999', registrar: 'nao' });
      assert.equal(r.status, 200, 'grupo criado não pode virar erro');
      assert.equal(r.json.jid, JID_CRIADO);
      assert.equal(r.json.inviteUrl, undefined);
      assert.ok(
        (r.json.passos as string[]).some((p) => /link de convite/i.test(p)),
        'os passos têm que dizer que o link falhou',
      );
    } finally {
      falharEm = null;
    }
  });

  test('se a criação falhar, aí sim é erro — e nada é registrado', async () => {
    falharEm = '/group/create/';
    try {
      await query('DELETE FROM channels WHERE instance_ref = $1', [INSTANCIA]);
      const r = await criar({ subject: 'Não vai', participants: '11999999999', registrar: 'poster' });
      assert.equal(r.status, 502);
      const linha = await query('SELECT 1 FROM channels WHERE instance_ref = $1', [INSTANCIA]);
      assert.equal(linha.length, 0, 'canal não pode ser registrado se o grupo não nasceu');
    } finally {
      falharEm = null;
    }
  });
}
