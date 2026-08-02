import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

/**
 * O CAMINHO DE ENTRADA — a última perna do pipeline sem cobertura.
 *
 * Os 31 testes de inteligência que já existem chamam FUNÇÕES PURAS
 * (`parsePost`, `scoreCandidato`, `scrubPII`). Nenhum deles exercita o caminho
 * pelo qual o dado realmente chega: a Evolution faz um POST no webhook, a rota
 * confere o token, o listener desembrulha o payload e a ingestão grava.
 *
 * Eu vinha registrando essa perna como "só dá para testar com um WhatsApp real".
 * Era FALSO — é o mesmo erro que eu já tinha cometido com o DISPARO, provado
 * depois com uma Evolution falsa. O webhook é um POST HTTP: para exercitá-lo
 * basta mandar um. O que não dá para simular é o celular do dono ENTRAR no
 * grupo; o transporte, não.
 *
 * Por que ponta a ponta e não em pedaços: os defeitos que sobram aqui são todos
 * de JUNÇÃO — token que não confere, envelope que o listener não desembrulha,
 * grupo não cadastrado que a ingestão recusa, dedupe que depende de um campo que
 * o listener precisa repassar. Testar cada peça isolada é exatamente o que já
 * está feito, e é justamente o que não pega esses.
 *
 * Precisa de um Postgres DESCARTÁVEL (o teste cria e apaga dados):
 *   INTEL_TEST_DATABASE_URL=postgres://... npm run test:entrada
 * Sem a variável o arquivo NÃO passa em silêncio — ele grita o que falta.
 */

const DB = process.env.INTEL_TEST_DATABASE_URL;

if (!DB) {
  test('INTEGRAÇÃO PULADA — falta INTEL_TEST_DATABASE_URL', () => {
    // Deliberadamente NÃO é um `skip` silencioso. Um teste de integração que
    // some sem avisar é pior que não existir: a suíte fica verde e ninguém
    // percebe que a perna de entrada deixou de ser verificada.
    console.warn(
      '\n  [!] entrada.test.ts NÃO RODOU: defina INTEL_TEST_DATABASE_URL apontando\n' +
        '      para um Postgres descartável. Sem isso o caminho webhook -> listener\n' +
        '      -> ingestão -> intel_posts fica SEM cobertura ponta a ponta.\n',
    );
    assert.ok(true);
  });
} else {
  process.env.DATABASE_URL = DB;
  process.env.SHOPEE_APP_ID ??= 'teste';
  process.env.SHOPEE_APP_SECRET ??= 'teste';

  /* eslint-disable @typescript-eslint/no-var-requires */
  const { app } = require('../api') as typeof import('../api');
  const { migrate } = require('../migrate') as typeof import('../migrate');
  const { query, queryOne, closePool } = require('../db') as typeof import('../db');
  const { tokenWebhook } = require('../security') as typeof import('../security');
  const { matchPendingPosts } = require('./match') as typeof import('./match');
  const { resumoDiario, correlacaoDoDia } = require('./report') as typeof import('./report');
  const { normalizeText } = require('../util') as typeof import('../util');

  /*
   * O título na API vem MAIS LONGO que o do grupo — eles encurtam ao republicar.
   * Usar o título idêntico dos dois lados tornaria o casamento trivial e o teste
   * não provaria nada sobre o trigrama.
   */
  const TITULO_CORRENTE = 'Air Fryer Philco PFR15P 5,5L Gourmet Black 1700W';
  const TITULO_API = 'Air Fryer Philco PFR15P 5,5L Gourmet Black 1700W Cesto Antiaderente 127V';

  const GRUPO = '120363999000000777@g.us';
  const INSTANCIA = 'teste-entrada';

  let server: Server;
  let base = '';
  let token = '';

  /**
   * Mensagem no formato REAL do grupo concorrente (padrão B), com o número do
   * admin no rodapé — como eles escrevem de verdade.
   *
   * O título é parâmetro por um motivo que custou uma rodada: `intel_posts` tem
   * índice único em (grupo, hash do texto, DIA). Todos os casos usando o MESMO
   * texto no mesmo grupo e no mesmo dia faziam o segundo em diante ser
   * deduplicado — o produto funcionando exatamente como projetado, e o teste
   * lendo isso como falha. Cada caso precisa do seu próprio texto; a deduplicação
   * ganha teste PRÓPRIO, explícito, mais abaixo.
   */
  const msgReal = (titulo: string, preco = '249,90') => [
    'AIR FRYER PRA CASA TODA 🔥',
    `*${titulo}*`,
    `~~DE 399~~ | *POR ${preco} em 10x*`,
    'Resgate o cupom: *SHOPEE20*',
    'https://shopee.com.br/product/366017406/20199206047',
    'Dúvidas chama +55 16 98206-2623',
  ].join('\n');

  const TITULO_POST = 'Air Fryer Britânia 4,2L Dura Mais 1500W BFR38';
  const MSG_REAL = msgReal(TITULO_POST);

  /**
   * Payload no formato que a Evolution entrega de verdade.
   *
   * ARMADILHA que este helper já causou: a primeira versão terminava com
   * `...over` DEPOIS de montar `key`, então passar `{key:{id:'X'}}` substituía o
   * key inteiro e derrubava `remoteJid`. O listener saía cedo ("não é grupo") e
   * NADA era gravado — o que fez três testes ("fromMe é ignorada", "DM é
   * ignorada", "grupo não cadastrado é recusado") passarem VAZIOS: eles
   * verificavam que nada foi gravado, e de fato nada era, mas pelo motivo
   * errado. Passe verde provando nada é pior que falha. `key` agora é mesclado
   * à parte, e o resto sobrescreve depois.
   */
  const upsert = (over: Record<string, unknown> = {}) => {
    const { key: keyOver, ...resto } = over as { key?: object };
    return {
      event: 'messages.upsert',
      instance: INSTANCIA,
      data: {
        key: { remoteJid: GRUPO, fromMe: false, id: 'WAMID-BASE', ...keyOver },
        pushName: 'Admin do Grupo',              // PII: tem que ser IGNORADO
        participant: '5516982062623@s.whatsapp.net', // PII: tem que ser IGNORADO
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: MSG_REAL },
        ...resto,
      },
    };
  };

  const postWebhook = async (tk: string, body: unknown) => {
    const r = await fetch(`${base}/webhook/evolution/${tk}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  /**
   * A rota responde 200 ANTES de processar (a Evolution não pode ficar
   * esperando o parse). Então o corpo chegar não prova que gravou — é preciso
   * esperar a gravação. Espera pela CONDIÇÃO, não por tempo fixo.
   */
  const ateGravar = async (sql: string, params: unknown[] = [], tentativas = 60) => {
    for (let i = 0; i < tentativas; i++) {
      const r = await queryOne<{ n: string }>(sql, params);
      if (Number(r?.n ?? 0) > 0) return true;
      await new Promise((res) => setTimeout(res, 50));
    }
    return false;
  };

  const contarPosts = async () => {
    const r = await queryOne<{ n: string }>(
      'SELECT count(*) AS n FROM intel_posts p JOIN intel_groups g ON g.id = p.group_id WHERE g.group_jid = $1',
      [GRUPO],
    );
    return Number(r?.n ?? 0);
  };

  before(async () => {
    await migrate();
    await query('DELETE FROM intel_groups WHERE group_jid = $1', [GRUPO]);
    await query(
      `INSERT INTO intel_groups (group_jid, display_name, kind, is_active) VALUES ($1,$2,'promo',true)`,
      [GRUPO, 'Grupo de teste de entrada'],
    );
    token = await tokenWebhook();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const a = server.address();
        base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
        resolve();
      });
    });
  });

  after(async () => {
    await query('DELETE FROM intel_groups WHERE group_jid = $1', [GRUPO]);
    // As observações semeadas na corrente completa não somem por CASCADE do
    // grupo — sem isto, rodadas repetidas acumulam lixo no banco reutilizado.
    await query('DELETE FROM api_observations WHERE product_id = $1', ['20199206047']);
    await query(`DELETE FROM intel_sweeps WHERE stats = '{}'::jsonb`);
    await new Promise<void>((r) => server.close(() => r()));
    await closePool();
  });

  /* ============ a fronteira de segurança ============ */

  test('token errado: 401 E nada é gravado', async () => {
    const antes = await contarPosts();
    const r = await postWebhook('token-invalido-abc123', upsert());
    assert.equal(r.status, 401);
    // O que importa não é só o 401: é que o corpo não foi processado. Sem esta
    // asserção, um `res.status(401)` seguido de processamento passaria.
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(await contarPosts(), antes, 'payload com token inválido NÃO pode ser ingerido');
  });

  test('caminho antigo sem token é recusado', async () => {
    const r = await fetch(`${base}/webhook/evolution`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(upsert()),
    });
    assert.equal(r.status, 401);
  });

  /* ============ o caminho feliz, com a mensagem real ============ */

  test('POST real no webhook grava o post com título, preço, cupom e SEM PII', async () => {
    const r = await postWebhook(token, upsert({ key: { id: 'WAMID-REAL-1' } }));
    assert.equal(r.status, 200);

    const ok = await ateGravar(
      'SELECT count(*) AS n FROM intel_posts WHERE wa_message_id = $1',
      ['WAMID-REAL-1'],
    );
    assert.ok(ok, 'a mensagem deveria ter virado linha em intel_posts');

    const p = await queryOne<{
      title_guess: string; price: string; price_old: string; coupon: string;
      platform_guess: string; text: string; wa_message_id: string; urls: string[];
    }>(`SELECT title_guess, price, price_old, coupon, platform_guess, text, wa_message_id, urls
          FROM intel_posts WHERE wa_message_id = $1`, ['WAMID-REAL-1']);

    assert.ok(p, 'linha não encontrada');
    assert.equal(p.title_guess, 'Air Fryer Britânia 4,2L Dura Mais 1500W BFR38');
    assert.equal(Number(p.price), 249.9);
    assert.equal(Number(p.price_old), 399, 'o "DE 399" tem que virar preço antigo');
    assert.equal(p.coupon, 'SHOPEE20');
    assert.equal(p.platform_guess, 'shopee');
    assert.equal(p.wa_message_id, 'WAMID-REAL-1');
    assert.ok(Array.isArray(p.urls) && p.urls.length >= 1, 'o link do produto tem que ser guardado');

    // LGPD: o telefone do admin estava no TEXTO e o participant/pushName no
    // payload. Nada disso pode ter sobrevivido.
    assert.doesNotMatch(p.text, /98206.?2623/, 'telefone do admin sobreviveu no texto');
    assert.doesNotMatch(p.text, /5516982062623/, 'jid do participante vazou');
    assert.doesNotMatch(p.text, /Admin do Grupo/, 'pushName vazou');
  });

  /* ============ o que o listener tem que ignorar ============ */

  test('mensagem própria (fromMe) é ignorada', async () => {
    /*
     * TEXTO PRÓPRIO, e não o padrão do helper. Com o texto padrão este teste
     * não podia falhar: o caminho feliz já tinha gravado aquele mesmo texto, no
     * mesmo grupo, no mesmo dia, e `ingestPost` insere com ON CONFLICT DO
     * NOTHING contra `uq_intel_posts_hash_dia`. Tirar a guarda de `fromMe` do
     * listener deixaria a mensagem passar, o INSERT bateria no índice, nada
     * novo seria gravado — e o teste seguiria VERDE com o defeito presente.
     * Segunda vez que este arquivo cai em passe vazio; por isso a verificação
     * agora é por `wa_message_id`, que é específico deste caso.
     */
    await postWebhook(token, upsert({
      key: { id: 'WAMID-EU', fromMe: true },
      message: { conversation: msgReal('Ventilador de Coluna Mallory Turbo 40cm') },
    }));
    await new Promise((res) => setTimeout(res, 400));
    const n = await queryOne<{ n: string }>(
      'SELECT count(*) AS n FROM intel_posts WHERE wa_message_id = $1', ['WAMID-EU'],
    );
    assert.equal(Number(n?.n ?? 0), 0, 'o que o próprio número manda não é inteligência');
  });

  test('conversa privada (não @g.us) é ignorada, MESMO se o jid for cadastrado', async () => {
    /*
     * Duas correções neste caso, ambas medidas por mutação:
     *
     * 1. Contar por `wa_message_id`, não por grupo. `contarPosts()` filtra por
     *    `g.group_jid = GRUPO` e uma DM jamais se ligaria a esse grupo — a
     *    asserção era `0 === 0` mesmo com todas as guardas removidas.
     *
     * 2. CADASTRAR o jid da DM como grupo observado. Sem isso o teste continuava
     *    incapaz de falhar: removi as guardas de `@g.us` do listener E da
     *    ingestão e ele seguiu verde, porque a terceira trava ("grupo não
     *    cadastrado") segurava sozinha. Cadastrando, a única coisa entre a DM e
     *    o banco passa a ser a checagem de `@g.us` — que é o que este teste diz
     *    verificar.
     *
     * E o cenário é REAL, não artificial: o campo "adicionar grupo" do painel
     * aceita um jid colado. Colar o de uma conversa privada é erro de dedo
     * plausível, e a consequência seria começar a gravar DM — que é justamente
     * onde mora PII de verdade.
     *
     * LIMITE HONESTO, medido por mutação: `@g.us` é checado em DOIS lugares
     * (listener.ts e ingest.ts). Removi um de cada vez e o teste seguiu verde;
     * só com os DOIS fora é que ficou vermelho. Ou seja, este é um teste de
     * DESFECHO ("DM não vira post"), protegido por defesa em profundidade — ele
     * não detecta a perda de UMA das duas guardas isoladamente. Fica assim de
     * propósito: o desfecho é o que importa, e as duas guardas são redundância
     * deliberada. Mas está escrito aqui para ninguém ler "verde" como "a guarda
     * do listener está viva".
     */
    const jidDM = '5511999999999@s.whatsapp.net';
    await query(
      `INSERT INTO intel_groups (group_jid, display_name, kind, is_active) VALUES ($1,$2,'promo',true)
         ON CONFLICT (group_jid) DO UPDATE SET is_active = true`,
      [jidDM, 'jid de DM colado por engano'],
    );
    try {
      await postWebhook(token, upsert({
        key: { id: 'WAMID-DM', remoteJid: jidDM },
        message: { conversation: msgReal('Aspirador de Po Vertical Electrolux ERG20') },
      }));
      await new Promise((res) => setTimeout(res, 400));
      const n = await queryOne<{ n: string }>(
        'SELECT count(*) AS n FROM intel_posts WHERE wa_message_id = $1', ['WAMID-DM'],
      );
      assert.equal(Number(n?.n ?? 0), 0, 'DM não é grupo — e é onde mora PII de verdade');
    } finally {
      await query('DELETE FROM intel_groups WHERE group_jid = $1', [jidDM]);
    }
  });

  test('grupo NÃO cadastrado é recusado (o painel é o liga/desliga)', async () => {
    const outro = '120363000000000042@g.us';
    await postWebhook(token, {
      event: 'messages.upsert',
      instance: INSTANCIA,
      data: {
        key: { remoteJid: outro, fromMe: false, id: 'WAMID-DESCONHECIDO' },
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: MSG_REAL },
      },
    });
    await new Promise((res) => setTimeout(res, 300));
    const n = await queryOne<{ n: string }>(
      'SELECT count(*) AS n FROM intel_posts WHERE wa_message_id = $1', ['WAMID-DESCONHECIDO'],
    );
    assert.equal(Number(n?.n ?? 0), 0, 'entrar num grupo não pode começar a coletar sozinho');
  });

  /* ============ o envelope que fazia um grupo inteiro parecer mudo ============ */

  test('mensagem TEMPORÁRIA (ephemeralMessage) é desembrulhada', async () => {
    // Grupo de promoção com mensagens temporárias ligadas envelopa TUDO. Sem
    // desembrulhar, o texto sai vazio e o grupo aparece com 0 posts no painel —
    // "esse grupo está mudo" quando ele posta o dia todo. O conserto existia;
    // por este caminho ele nunca tinha sido exercitado.
    const r = await postWebhook(token, upsert({
      key: { id: 'WAMID-EFEMERA' },
      message: { ephemeralMessage: { message: { extendedTextMessage: { text: msgReal('Panela de Pressao Eletrica Mondial 5L PE-40') } } } },
    }));
    assert.equal(r.status, 200);
    const ok = await ateGravar('SELECT count(*) AS n FROM intel_posts WHERE wa_message_id = $1', ['WAMID-EFEMERA']);
    assert.ok(ok, 'mensagem temporária tem que ser ingerida como qualquer outra');
  });

  test('legenda de IMAGEM também é ingerida, e marca has_image', async () => {
    await postWebhook(token, upsert({
      key: { id: 'WAMID-FOTO' },
      message: { imageMessage: { caption: msgReal('Cafeteira Expresso Arno Dolce Gusto Piccolo XS') } },
    }));
    const ok = await ateGravar('SELECT count(*) AS n FROM intel_posts WHERE wa_message_id = $1', ['WAMID-FOTO']);
    assert.ok(ok, 'eles postam foto + legenda o tempo todo');
    const p = await queryOne<{ has_image: boolean }>(
      'SELECT has_image FROM intel_posts WHERE wa_message_id = $1', ['WAMID-FOTO'],
    );
    assert.equal(p?.has_image, true);
  });

  /* ============ dedupe pelo caminho de verdade ============ */

  test('a MESMA mensagem entregue duas vezes vira UMA linha', async () => {
    // A Evolution reentrega em reconexão. Sem o `key.id` chegando até a
    // ingestão, o mesmo post viraria duas linhas e inflaria a contagem do grupo.
    const txt = msgReal('Liquidificador Philco PH900 Preto 1200W');
    const corpo = upsert({ key: { id: 'WAMID-REPETIDA' }, message: { conversation: txt } });
    await postWebhook(token, corpo);
    assert.ok(await ateGravar('SELECT count(*) AS n FROM intel_posts WHERE wa_message_id = $1', ['WAMID-REPETIDA']));
    await postWebhook(token, corpo);
    await new Promise((res) => setTimeout(res, 400));
    const n = await queryOne<{ n: string }>(
      'SELECT count(*) AS n FROM intel_posts WHERE wa_message_id = $1', ['WAMID-REPETIDA'],
    );
    assert.equal(Number(n?.n ?? 0), 1, 'reentrega da Evolution não pode virar post novo');
  });

  test('mesmo TEXTO com id diferente, no mesmo dia, vira UMA linha', async () => {
    /*
     * Este é o outro lado da deduplicação e o que sustenta a detecção de LISTA
     * FIXA: dentro do mesmo dia, o mesmo texto é o mesmo post (a Evolution
     * reentrega com id novo em reconexão). Entre DIAS diferentes ele conta de
     * novo — é assim que "eles republicam a mesma oferta toda semana" aparece.
     *
     * Descobri este comportamento por acidente: metade dos casos deste arquivo
     * usava o mesmo texto e era silenciosamente deduplicada. O que era ruído no
     * teste é, na verdade, a garantia central — então vira asserção.
     */
    const txt = msgReal('Batedeira Planetaria Oster OBAT500 4,5L');
    await postWebhook(token, upsert({ key: { id: 'WAMID-HASH-A' }, message: { conversation: txt } }));
    assert.ok(await ateGravar('SELECT count(*) AS n FROM intel_posts WHERE wa_message_id = $1', ['WAMID-HASH-A']));
    await postWebhook(token, upsert({ key: { id: 'WAMID-HASH-B' }, message: { conversation: txt } }));
    await new Promise((res) => setTimeout(res, 500));

    const n = await queryOne<{ n: string }>(
      `SELECT count(*) AS n FROM intel_posts p JOIN intel_groups g ON g.id = p.group_id
        WHERE g.group_jid = $1 AND p.title_guess = $2`,
      [GRUPO, 'Batedeira Planetaria Oster OBAT500 4,5L'],
    );
    assert.equal(Number(n?.n ?? 0), 1, 'mesmo texto no mesmo dia é o mesmo post');
  });

  /* ============ a corrente inteira, até o número do painel ============ */

  test('CORRENTE COMPLETA: webhook -> ingestão -> casamento -> relatório', async () => {
    // Semeia no cardápio a MESMA oferta, 40 min ANTES do post — o cenário que o
    // dashboard existe para responder ("eles viram e postaram X min depois").
    const sweep = await queryOne<{ id: string }>(
      `INSERT INTO intel_sweeps (started_at, finished_at, stats)
       VALUES (now() - interval '2 hours', now() - interval '2 hours', '{}'::jsonb) RETURNING id`,
    );
    const agora = new Date();
    const observadoEm = new Date(agora.getTime() - 40 * 60_000);
    await query(
      `INSERT INTO api_observations
         (sweep_id, product_id, shop_id, title, title_norm, price, commission_brl, sales,
          rating_star, keyword, would_pass, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11)`,
      [sweep!.id, '20199206047', '366017406', TITULO_API, normalizeText(TITULO_API),
       249.9, 7.5, 320, 4.8, 'air fryer', observadoEm.toISOString()],
    );

    const r = await postWebhook(token, {
      event: 'messages.upsert',
      instance: INSTANCIA,
      data: {
        key: { remoteJid: GRUPO, fromMe: false, id: 'WAMID-CORRENTE' },
        messageTimestamp: Math.floor(agora.getTime() / 1000),
        message: { conversation: msgReal(TITULO_CORRENTE) },
      },
    });
    assert.equal(r.status, 200);
    assert.ok(await ateGravar('SELECT count(*) AS n FROM intel_posts WHERE wa_message_id = $1', ['WAMID-CORRENTE']));

    const r2 = await matchPendingPosts(50, false);
    assert.ok(r2.processed >= 1, `o casador deveria ter processado >=1 post, processou ${r2.processed}`);
    assert.ok(r2.casado >= 1, `esperava >=1 casado, veio ${JSON.stringify(r2)}`);

    const post = await queryOne<{ id: string }>(
      'SELECT id FROM intel_posts WHERE wa_message_id = $1', ['WAMID-CORRENTE'],
    );
    const m = await queryOne<{ verdict: string; lag_seconds: string; confidence: string; product_id: string }>(
      'SELECT verdict, lag_seconds, confidence, product_id FROM intel_matches WHERE post_id = $1', [post!.id],
    );
    assert.ok(m, 'o post deveria ter uma linha de casamento');
    assert.equal(m.verdict, 'casado');
    assert.equal(m.product_id, '20199206047', 'casou com o produto errado');

    // O atraso é a resposta que o dashboard dá: ~40 min entre a API oferecer e
    // eles postarem. Tolerância larga porque o relógio corre durante o teste.
    const lag = Number(m.lag_seconds);
    assert.ok(lag > 2000 && lag < 2800, `atraso deveria ficar perto de 2400s, veio ${lag}s`);

    // resumoDiario recebe QUANTOS DIAS (não uma data) e devolve uma série.
    const serie = await resumoDiario(2);
    const total = serie.reduce((a, d) => a + Number(d.posts || 0), 0);
    const totalCasados = serie.reduce((a, d) => a + Number(d.casados || 0), 0);
    assert.ok(total >= 1, `o placar tem que contar o post, veio ${JSON.stringify(serie)}`);
    assert.ok(totalCasados >= 1, 'e contar o casamento');

    /*
     * O DIA tem que ser calculado no MESMO fuso que o relatório usa. Este
     * `toISOString().slice(0,10)` devolvia o dia em UTC enquanto
     * `correlacaoDoDia` delimita em America/Sao_Paulo (report.ts) — então das
     * 21h às 23h59 de Brasília o teste consultaria o dia SEGUINTE, não acharia
     * o post e ficaria vermelho sem nada estar quebrado. Este arquivo passou
     * por MINUTOS: rodei logo depois da meia-noite de SP. É exatamente a classe
     * de bug já corrigida no painel (fuso via Intl, não offset chumbado),
     * reintroduzida no teste.
     */
    const hoje = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const corr = await correlacaoDoDia(hoje);
    const linha = corr.find((c) => String(c.postId) === String(post!.id));
    assert.ok(linha, `o post tem que aparecer na travessia do dia (${corr.length} linhas no dia)`);
    assert.equal(linha.verdict, 'casado');
    assert.equal(linha.productId, '20199206047');
    assert.ok(Number(linha.lagSeconds) > 2000, 'a travessia mostra o atraso medido');
  });
}
