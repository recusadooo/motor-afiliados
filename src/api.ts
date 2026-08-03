import path from 'node:path';
import express, { type Request, type Response, type NextFunction } from 'express';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config';
import { log } from './logger';
import { query, queryOne, tx } from './db';
import { handleEvolutionWebhook } from './whatsapp/listener';
import { breakerState } from './resilience/breaker';
import { removeDripJob, tamanhoDaFila, proximasDaFila } from './queue/scheduler';
import { HttpError } from './resilience/retry';
import { getEvolution, GROUPS_INSTANCE_SETTINGS } from './whatsapp/evolution';
import { normalizarTelefoneBR } from './util';
import { settingsStatus, setSetting, SETTING_KEYS } from './settings';
import { runCaptureExclusivo, capturaEmAndamento } from './capture/shopeeFeed';
import {
  COOKIE, cabecalhosSeguranca, limiteApi, autenticar, criarSessao, sessaoValida, lerCookie,
  garantirSenha, trocarSenha, usuarioPainel, tokenWebhook, ipDe, loginBloqueado,
  registrarTentativaFalha, limparTentativas, tokenIngestao, girarTokenIngestao,
  segredoConfere,
} from './security';
import { paginaLogin } from './loginPage';
import { ingestPost, type IngestInput } from './intel/ingest';
import { runSweepExclusivo, varreduraEmAndamento } from './intel/observe';
import { matchPendingPosts, matchOnePost } from './intel/match';
import {
  resumoDiario, correlacaoDoDia, repeticaoDeProdutos,
  distribuicaoPorHora, coberturaPorGrupo, perfilDeEscolha,
} from './intel/report';
import { redeDeGrupos, nichoDosGrupos } from './intel/rede';
import { sincronizarCategorias, categoriasGuardadas, semearEtiquetas, normalizarEtiqueta } from './shopee/categorias';
import { comCache, limparCache, TTL_GRUPOS } from './cache';
import {
  melhoresOportunidades, estatisticas, resumoMonitor, backfill, JANELAS,
  ondeApareceu, historicoDiario,
} from './monitor/precos';

/**
 * API do backend (roda no VPS). Serve:
 *  - webhook da Evolution (listener de enriquecimento)
 *  - endpoints do dashboard (fila, aprovação/rejeição manual, stats, saúde)
 *  - health check
 *  - WebSocket para atualização em tempo real
 * Só a API é exposta (via Traefik, no domínio API_DOMAIN).
 */

/*
 * `app` é exportado para que o caminho de ENTRADA possa ser exercitado de
 * verdade (ver `intel/entrada.test.ts`): subir em porta efêmera e mandar um POST
 * real no webhook, em vez de chamar as funções por dentro. Importar este módulo
 * não abre porta nem toca o banco — quem escuta é `startApi()`.
 *
 * Isto existe pelo mesmo motivo que `dispatchOne` foi exportado: a perna de
 * entrada era a única do pipeline sem cobertura ponta a ponta, e o motivo alegado
 * ("precisa de um WhatsApp real") era falso — o webhook é um POST HTTP.
 */
export const app = express();
app.use(express.json({ limit: '2mb' }));

/**
 * Proteção OPCIONAL do painel (HTTP Basic) — decisão do dono: fica ABERTO por
 * padrão (uso pessoal). Se DASHBOARD_USER e DASHBOARD_PASSWORD forem definidos,
 * a senha passa a ser exigida sem mexer no código. Livres de senha sempre:
 * /health (monitoramento) e /webhook/* (a Evolution chama sem credencial).
 * Lembrete honesto: o domínio é público (aparece nos logs de Certificate
 * Transparency ao emitir o TLS), então "aberto" = qualquer um que ache a URL.
 */
/*
 * Atrás do Traefik. `true` confiava na cadeia INTEIRA de X-Forwarded-For, que é
 * cabeçalho controlado pelo cliente: bastava rotacioná-lo para ter uma "chave"
 * nova a cada requisição e anular tanto o freio de força bruta do login quanto
 * o teto por IP — inclusive na rota de ingestão, cujo único freio contra
 * tentativa de adivinhar o token é esse. `1` = confia em exatamente um salto (o
 * Traefik) e resolve o IP real como o último hop confiável.
 */
app.set('trust proxy', 1);
app.use(cabecalhosSeguranca);

/** Rotas que NÃO exigem sessão. O webhook tem o próprio segredo (na URL). */
function livre(caminho: string): boolean {
  return (
    caminho === '/health' ||
    caminho === '/login' ||
    caminho === '/api/login' ||
    caminho === '/api/logout' ||
    caminho.startsWith('/webhook/') ||
    // Ingestão de inteligência: quem chama é o n8n, que não tem sessão. O
    // segredo vai na URL, igual ao webhook da Evolution e pelo mesmo motivo.
    caminho.startsWith('/api/intel/ingest/')
  );
}

/**
 * Porteiro do painel. Aceita sessão (cookie assinado) OU Basic auth (para curl).
 * Navegador sem sessão é levado ao /login; chamada de API recebe 401 em JSON.
 */
async function porteiro(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (livre(req.path)) return next();

  if (await sessaoValida(lerCookie(req, COOKIE))) return next();

  const hdr = req.headers.authorization ?? '';
  if (hdr.startsWith('Basic ')) {
    const decodificado = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
    const sep = decodificado.indexOf(':');
    const u = sep === -1 ? decodificado : decodificado.slice(0, sep);
    const p = sep === -1 ? '' : decodificado.slice(sep + 1);
    if (await autenticar(u, p)) return next();
    log.warn('basic auth recusado', { ip: ipDe(req), path: req.path });
  }

  const querHtml = (req.headers.accept ?? '').includes('text/html');
  if (querHtml) {
    res.redirect(302, '/login');
    return;
  }
  res.status(401).json({ error: 'não autenticado — faça login em /login' });
}

app.use(wrap(porteiro));
app.use('/api', limiteApi);

// ---- login ----
app.get('/login', (_req: Request, res: Response) => {
  res.type('html').send(paginaLogin());
});

app.post('/api/login', wrap(async (req: Request, res: Response) => {
  const ip = ipDe(req);
  const bloqueio = loginBloqueado(ip);
  if (bloqueio > 0) {
    res.status(429).json({ error: `muitas tentativas — tente de novo em ${Math.ceil(bloqueio / 60)} min` });
    return;
  }
  const usuario = String(req.body?.usuario ?? '').trim();
  const senha = String(req.body?.senha ?? '');
  if (!(await autenticar(usuario, senha))) {
    registrarTentativaFalha(ip, loadConfig().LOGIN_MAX_ATTEMPTS);
    log.warn('login falhou', { ip, usuario });
    res.status(401).json({ error: 'usuário ou senha incorretos' });
    return;
  }
  limparTentativas(ip);
  const token = await criarSessao(usuario);
  res.cookie?.(COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 30 * 86400_000,
    path: '/',
  });
  log.info('login ok', { ip, usuario });
  res.json({ ok: true });
}));

app.post('/api/logout', (_req: Request, res: Response) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

// Trocar usuário/senha do painel (invalida as sessões antigas).
app.post('/api/access', wrap(async (req: Request, res: Response) => {
  const senha = String(req.body?.senha ?? '');
  const usuario = req.body?.usuario ? String(req.body.usuario) : undefined;
  await trocarSenha(senha, usuario);
  log.warn('senha do painel alterada', { ip: ipDe(req) });
  res.json({ ok: true, usuario: await usuarioPainel() });
}));

app.get('/api/access', wrap(async (_req: Request, res: Response) => {
  res.json({ usuario: await usuarioPainel(), webhookUrl: await urlWebhook() });
}));

// Painel de controle (Módulo 4) servido estático pela própria API.
app.use(express.static(path.join(__dirname, '..', 'public')));

/**
 * Envelope obrigatório para handler async no Express 4.
 * MOTIVO (bug real em produção, 2026-07-25): o Express 4 não captura rejeição de
 * função async — a rejeição sobe como unhandledRejection e o Node MATA o
 * processo. Um erro de banco em UMA rota derrubava a API inteira, o Swarm
 * reiniciava e o painel ficava eternamente em "carregando…" (502/timeout).
 * `function` (não arrow const) de propósito: é hoisted, e as rotas abaixo usam
 * isso no momento em que o módulo é avaliado.
 */
function wrap(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

/** URL do webhook COM o token (é o que se registra na Evolution). */
async function urlWebhook(): Promise<string | null> {
  const cfg = loadConfig();
  if (!cfg.PUBLIC_APP_URL) return null;
  return `${cfg.PUBLIC_APP_URL.replace(/\/$/, '')}/webhook/evolution/${await tokenWebhook()}`;
}

/**
 * Webhook da Evolution. Ela não manda credencial, então o segredo vai NA URL —
 * sem isso, qualquer um na internet poderia injetar mensagens falsas de grupo.
 * O app registra a URL com token automaticamente ao provisionar a instância.
 */
app.post('/webhook/evolution/:token', wrap(async (req: Request, res: Response) => {
  if (!segredoConfere(req.params.token, await tokenWebhook())) {
    log.warn('webhook com token inválido', { ip: ipDe(req) });
    res.status(401).json({ error: 'token inválido' });
    return;
  }
  res.status(200).json({ ok: true });
  try {
    await handleEvolutionWebhook(req.body);
  } catch (err) {
    log.error('webhook falhou', { err: err instanceof Error ? err.message : String(err) });
  }
}));

// Compat: caminho antigo sem token — recusa e diz o que fazer.
app.post('/webhook/evolution', wrap(async (_req: Request, res: Response) => {
  log.warn('webhook chamado sem token — reconfigure a instância na aba Conexões');
  res.status(401).json({ error: 'webhook exige token na URL — reconfigure em Conexões' });
}));

// ---- Feed de ofertas (dashboard) ----
// Filtros combináveis + preço ANTIGO monitorado (mediana do price_history) ao
// lado do preço atual, que é o que o dono quer ver.
app.get('/api/offers', wrap(async (req: Request, res: Response) => {
  const q = req.query as Record<string, string | undefined>;
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };

  if (q.status && q.status !== 'all') add('o.status = ?', q.status);
  if (q.q) add('o.title ILIKE ?', `%${q.q}%`);
  if (q.keyword) add('o.keyword = ?', q.keyword);
  if (q.minPrice) add('o.price >= ?', Number(q.minPrice));
  if (q.maxPrice) add('o.price <= ?', Number(q.maxPrice));
  if (q.minCommissionBrl) add('o.commission_brl >= ?', Number(q.minCommissionBrl));
  if (q.minCommissionPct) add('o.commission_rate >= ?', Number(q.minCommissionPct) / 100);
  if (q.priority === '1') where.push('o.is_priority = true');
  if (q.withRealDiscount === '1') where.push('o.discount_pct IS NOT NULL');

  const ORDENS: Record<string, string> = {
    recentes: 'o.created_at DESC',
    ganho: 'o.commission_brl DESC NULLS LAST',
    desconto: 'o.discount_pct DESC NULLS LAST',
    preco_asc: 'o.price ASC NULLS LAST',
    preco_desc: 'o.price DESC NULLS LAST',
    fila: 'o.is_priority DESC, o.priority DESC, o.created_at DESC',
  };
  const order = ORDENS[q.order ?? 'fila'] ?? ORDENS.fila;
  const limit = Math.min(Math.max(Number(q.limit ?? 60), 1), 200);

  const rows = await query(
    `SELECT o.id, o.title, o.price, o.original_price, o.discount_pct, o.advertised_discount_pct,
            o.savings_brl, o.commission_rate, o.commission_brl, o.image_url, o.rewritten_copy,
            o.affiliate_url, o.is_priority, o.status, o.reject_reason, o.keyword, o.sales,
            o.rating_star, o.created_at,
            ph.obs, ph.menor, ph.mediana, ph.maior
       FROM offers o
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS obs,
                min(price) AS menor,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY price) AS mediana,
                max(price) AS maior
           FROM price_history p
          WHERE p.product_id = o.product_id
            AND (p.shop_id = o.shop_id OR (p.shop_id IS NULL AND o.shop_id IS NULL))
       ) ph ON true
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${order} LIMIT ${limit}`,
    params,
  );
  res.json(rows);
}));

// Opções para os filtros do painel (keywords que realmente aparecem no feed).
app.get('/api/feed/facets', wrap(async (_req: Request, res: Response) => {
  const keywords = await query<{ keyword: string | null; c: string }>(
    `SELECT keyword, count(*)::text AS c FROM offers
      WHERE keyword IS NOT NULL GROUP BY keyword ORDER BY count(*) DESC LIMIT 60`,
  );
  const faixa = await queryOne<{ min: string | null; max: string | null }>(
    `SELECT min(price)::text AS min, max(price)::text AS max FROM offers WHERE price IS NOT NULL`,
  );
  const motivos = await query<{ reject_reason: string | null; c: string }>(
    `SELECT reject_reason, count(*)::text AS c FROM offers
      WHERE status='rejected' GROUP BY reject_reason ORDER BY count(*) DESC LIMIT 20`,
  );
  res.json({ keywords, faixa, motivos });
}));

// Últimos ciclos de captura — explica POR QUE o feed está assim.
app.get('/api/capture/runs', wrap(async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT id, started_at, finished_at, trigger, stats, error FROM capture_runs
      ORDER BY started_at DESC LIMIT 12`,
  );
  res.json(rows);
}));

// Dispara um ciclo AGORA (não espera o cron). Responde na hora; roda ao fundo.
app.post('/api/capture/run', wrap(async (_req: Request, res: Response) => {
  if (capturaEmAndamento()) {
    res.status(409).json({ error: 'já existe um ciclo rodando — espere ele terminar' });
    return;
  }
  res.status(202).json({ ok: true, msg: 'ciclo iniciado — acompanhe em Ciclos' });
  runCaptureExclusivo(true, 'manual').catch((err) =>
    log.error('captura manual falhou', { err: err instanceof Error ? err.message : String(err) }),
  );
}));

// Limpa o feed (não mexe no price_history: o histórico de preço é o ativo).
app.post('/api/offers/purge', wrap(async (req: Request, res: Response) => {
  const status = typeof req.body?.status === 'string' ? req.body.status : null;
  const apagadas = await tx(async (client) => {
    const cond = status ? `WHERE status = $1` : `WHERE status <> 'sent'`;
    const args = status ? [status] : [];
    await client.query(`DELETE FROM send_logs WHERE offer_id IN (SELECT id FROM offers ${cond})`, args);
    const r = await client.query(`DELETE FROM offers ${cond}`, args);
    await client.query(`DELETE FROM raw_captures WHERE id NOT IN (SELECT raw_capture_id FROM offers WHERE raw_capture_id IS NOT NULL)`);
    return r.rowCount ?? 0;
  });
  log.info('feed limpo', { status, apagadas });
  res.json({ ok: true, apagadas });
}));

app.post('/api/offers/:id/reject', wrap(async (req: Request, res: Response) => {
  await query(`UPDATE offers SET status='rejected', reject_reason='rejeitado manualmente' WHERE id=$1`, [
    req.params.id,
  ]);
  res.json({ ok: true });
}));

app.post('/api/offers/:id/approve', wrap(async (req: Request, res: Response) => {
  await query(`UPDATE offers SET status='approved' WHERE id=$1 AND status='pending'`, [req.params.id]);
  res.json({ ok: true });
}));

// ---- Estatísticas + saúde ----
app.get('/api/stats', wrap(async (_req: Request, res: Response) => {
  const counts = await query<{ status: string; c: string }>(
    `SELECT status, count(*)::text AS c FROM offers GROUP BY status`,
  );
  const sentToday = await queryOne<{ c: string }>(
    `SELECT count(*)::text AS c FROM send_logs WHERE status='sent' AND sent_at::date = now()::date`,
  );
  const channels = await query<{ id: string; display_name: string | null; status: string; instance_ref: string }>(
    `SELECT id, display_name, status, instance_ref FROM channels`,
  );
  res.json({
    offers: Object.fromEntries(counts.map((r) => [r.status, Number(r.c)])),
    sentToday: sentToday ? Number(sentToday.c) : 0,
    channels: channels.map((c) => ({
      ...c,
      breaker: breakerState(`whatsapp:${c.instance_ref}`),
    })),
  });
}));

app.get('/api/dlq', wrap(async (_req: Request, res: Response) => {
  const rows = await query(
    /*
     * O LEFT JOIN existe porque a tela mostrava "canal 1" — o id cru da linha,
     * que não diz ao dono QUAL grupo ficou sem receber. LEFT (e não INNER)
     * porque canal removido não pode sumir com a falha: o histórico do erro
     * vale justamente quando a causa foi mexer no canal.
     */
    `SELECT d.id, d.orig_queue, d.error, d.channel_id, d.status, d.created_at,
            c.display_name AS channel_name, c.target_ref AS channel_target
       FROM dlq d
       LEFT JOIN channels c ON c.id = d.channel_id
      WHERE d.status='pending_review' ORDER BY d.created_at DESC LIMIT 100`,
  );
  res.json(rows);
}));

// ---- Conexão de números (QR) e canais ----
async function evoOr500(res: Response) {
  const evo = await getEvolution();
  if (!evo) {
    res.status(500).json({ error: 'Evolution não configurada — configure a URL/chave na aba Config' });
    return null;
  }
  return evo;
}

// Provisiona uma instância (número): cria + configura pra grupos + webhook.
app.post('/api/instances', wrap(async (req: Request, res: Response) => {
  const evo = await evoOr500(res);
  if (!evo) return;
  const name = String(req.body?.name ?? '').trim();
  const role = req.body?.role === 'listener' ? 'listener' : 'poster';
  if (!name) return res.status(400).json({ error: 'informe um nome' });

  const steps: Record<string, string> = {};
  try {
    await evo.createInstance(name);
    steps.instancia = 'criada';
  } catch (err) {
    return res.status(502).json({ error: 'criar instância: ' + (err instanceof Error ? err.message : String(err)) });
  }
  // Configura a instância pra focar em grupos (best-effort — não quebra a criação).
  try {
    await evo.setInstanceSettings(name, GROUPS_INSTANCE_SETTINGS);
    steps.settings = 'aplicadas (foco em grupos: recebe grupos, rejeita chamadas, sem sync de histórico)';
  } catch (err) {
    steps.settings = 'falhou: ' + (err instanceof Error ? err.message : String(err));
  }
  // Webhook para o app (essencial p/ listener, inofensivo p/ poster).
  const url = await urlWebhook();
  if (url) {
    try {
      await evo.setWebhook(name, url, ['MESSAGES_UPSERT']);
      steps.webhook = 'configurado (com token)';
    } catch (err) {
      steps.webhook = 'falhou: ' + (err instanceof Error ? err.message : String(err));
    }
  } else {
    steps.webhook = 'pulado (defina PUBLIC_APP_URL para o listener)';
  }
  res.json({ ok: true, instance: name, role, steps });
}));

// QR code para escanear (base64 / pairing code).
app.get('/api/instances/:name/qr', wrap(async (req: Request, res: Response) => {
  const evo = await evoOr500(res);
  if (!evo) return;
  try {
    res.json(await evo.connect(req.params.name!));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

app.get('/api/instances/:name/state', wrap(async (req: Request, res: Response) => {
  const evo = await evoOr500(res);
  if (!evo) return;
  try {
    res.json({ state: await evo.connectionState(req.params.name!) });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

app.get('/api/instances/:name/groups', wrap(async (req: Request, res: Response) => {
  const evo = await evoOr500(res);
  if (!evo) return;
  try {
    const groups = await evo.fetchAllGroups(req.params.name!);
    res.json(groups.map((g) => ({ id: g.id, subject: g.subject })));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

/**
 * Cria um grupo de WhatsApp e o deixa PRONTO PARA USO num passo só: cria,
 * opcionalmente tranca para "só admin posta", pega o link de convite e já
 * registra como canal de disparo.
 *
 * Cada etapa depois da criação é best-effort e vai reportada em `passos` — se
 * o grupo nasceu, a operação não pode ser considerada falha só porque o link
 * de convite não veio. O grupo existiria no WhatsApp e o painel diria "erro",
 * e o dono acabaria com grupos órfãos criados a cada tentativa.
 */
app.post('/api/instances/:name/groups', wrap(async (req: Request, res: Response) => {
  const evo = await evoOr500(res);
  if (!evo) return;
  const instancia = req.params.name!;
  const subject = String(req.body?.subject ?? '').trim();
  const description = String(req.body?.description ?? '').trim();
  const somenteAdmin = req.body?.somenteAdmin !== false; // padrão: grupo de avisos
  const registrar = String(req.body?.registrar ?? 'poster'); // poster | intel | nao

  if (!subject) return res.status(400).json({ error: 'dê um nome ao grupo' });

  /*
   * A Evolution exige participants com minItems:1 (verificado no
   * createGroupSchema oficial) — não existe "criar grupo só meu" pela API.
   * Normalizamos aqui para o dono poder digitar "(11) 99999-9999"; sem isso a
   * Evolution devolve 400 de validação com mensagem que não ajuda.
   */
  /*
   * Separadores: vírgula, ponto-e-vírgula e quebra de linha — NÃO espaço.
   * O espaço faz parte da formatação de um único número no Brasil
   * ("(11) 99999-9999", "11 99999-9999"); separar por ele quebrava o número
   * em "(11)" e "99999-9999", os dois inválidos, e o dono levava um "número
   * inválido" para a forma mais natural de digitar. Achado pelo teste.
   */
  const crus: string[] = Array.isArray(req.body?.participants)
    ? req.body.participants
    : String(req.body?.participants ?? '').split(/[,;\n]+/);
  const invalidos: string[] = [];
  const numeros: string[] = [];
  for (const c of crus) {
    const t = String(c ?? '').trim();
    if (!t) continue;
    const n = normalizarTelefoneBR(t);
    if (n) numeros.push(n);
    else invalidos.push(t);
  }
  if (invalidos.length) {
    return res.status(400).json({
      error: `número inválido: ${invalidos.join(', ')} — use DDD + número (ex.: 11 99999-9999)`,
    });
  }
  if (!numeros.length) {
    return res.status(400).json({
      error: 'a Evolution exige pelo menos 1 participante para criar o grupo (pode ser o seu outro número)',
    });
  }

  const passos: string[] = [];
  let jid = '';
  let inviteUrl: string | undefined;
  try {
    const g = await evo.createGroup(instancia, subject, numeros, description || undefined);
    jid = g.id;
    passos.push(`grupo criado: ${subject}`);
    /*
     * A Evolution descarta em SILÊNCIO participante que não existe no WhatsApp
     * (filter(p => p.exists) antes do groupCreate). Sem este aviso, o dono
     * digita um número errado e fica achando que convidou alguém.
     */
    const entraram = Array.isArray(g.participants) ? g.participants.length : null;
    if (entraram != null && entraram < numeros.length + 1) {
      passos.push(
        `atenção: ${numeros.length} número(s) pedido(s), mas nem todos entraram — a Evolution ignora número que não existe no WhatsApp`,
      );
    }
  } catch (err) {
    return res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }

  if (somenteAdmin) {
    try {
      await evo.updateGroupSetting(instancia, jid, 'announcement');
      passos.push('travado: só admin manda mensagem');
    } catch (err) {
      passos.push(`não consegui travar p/ só admin (${err instanceof Error ? err.message : 'erro'}) — dá para fazer pelo celular`);
    }
  }

  try {
    const c = await evo.groupInviteCode(instancia, jid);
    inviteUrl = c.inviteUrl ?? (c.inviteCode ? `https://chat.whatsapp.com/${c.inviteCode}` : undefined);
    if (inviteUrl) passos.push('link de convite gerado');
  } catch (err) {
    passos.push(`não consegui pegar o link de convite (${err instanceof Error ? err.message : 'erro'})`);
  }

  if (registrar === 'poster' || registrar === 'intel') {
    try {
      if (registrar === 'poster') {
        await query(
          `INSERT INTO channels (platform, role, instance_ref, target_ref, display_name, status)
           VALUES ('whatsapp','poster',$1,$2,$3,'active')`,
          [instancia, jid, subject],
        );
        passos.push('registrado como canal de disparo — o gotejamento começa no próximo ciclo');
      } else {
        await query(
          `INSERT INTO intel_groups (group_jid, display_name, kind, is_active)
           VALUES ($1,$2,'proprio',true)
           ON CONFLICT (group_jid) DO UPDATE SET display_name = EXCLUDED.display_name, is_active = true`,
          [jid, subject],
        );
        passos.push("registrado como grupo observado (tipo 'próprio', fica fora de \"o que eles escolhem\")");
      }
    } catch (err) {
      passos.push(`grupo criado, mas não consegui registrar o canal (${err instanceof Error ? err.message : 'erro'}) — dá para registrar na mão abaixo`);
    }
  }

  // O grupo acabou de nascer: sem invalidar, ele sumiria da lista por 5 min.
  await limparCache(`grupos:${instancia}`);
  res.json({ jid, subject, inviteUrl, passos });
}));

// Configura o webhook do listener para apontar para este app.
app.post('/api/instances/:name/webhook', wrap(async (req: Request, res: Response) => {
  const evo = await evoOr500(res);
  if (!evo) return;
  const cfg = loadConfig();
  const url =
    String(req.body?.url ?? '') ||
    (cfg.PUBLIC_APP_URL ? `${cfg.PUBLIC_APP_URL.replace(/\/$/, '')}/webhook/evolution` : '');
  if (!url) return res.status(400).json({ error: 'defina PUBLIC_APP_URL ou passe url' });
  try {
    await evo.setWebhook(req.params.name!, url, ['MESSAGES_UPSERT']);
    res.json({ ok: true, url });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

/**
 * SEUS NÚMEROS — cada instância da Evolution, o estado da conexão, e os grupos
 * de que ela participa, já cruzados com o que está registrado aqui.
 *
 * Junta as duas metades que antes só existiam separadas: a Evolution sabe quais
 * grupos o número participa, e o app sabe em quais ele dispara/observa. Sem o
 * cruzamento, descobrir "esse grupo já está ligado?" exigia comparar jid na mão
 * entre duas telas.
 */
app.get('/api/numeros', wrap(async (req: Request, res: Response) => {
  /*
   * `?atualizar=1` pula o cache — é o botão "atualizar" da tela. Sem essa
   * saída, o usuário que acabou de entrar num grupo ficaria olhando uma lista
   * velha por 5 minutos sem entender por quê.
   */
  const forcar = String(req.query.atualizar ?? '') === '1';
  const evo = await getEvolution();
  const canais = await query<{
    id: string; role: string; instance_ref: string; target_ref: string | null;
    display_name: string | null; status: string;
  }>(`SELECT id, role, instance_ref, target_ref, display_name, status FROM channels`);
  const observados = await query<{ group_jid: string; display_name: string | null; kind: string; is_active: boolean }>(
    `SELECT group_jid, display_name, kind, is_active FROM intel_groups`,
  );
  const porJid = new Map(canais.filter((c) => c.target_ref).map((c) => [c.target_ref!, c]));
  const obsPorJid = new Map(observados.map((o) => [o.group_jid, o]));

  if (!evo) {
    return res.json({
      evolutionConfigurada: false,
      aviso: 'configure a Evolution em Config para ver seus números e grupos',
      numeros: [],
      canaisSemInstancia: canais,
    });
  }

  let instancias: Array<Record<string, unknown>> = [];
  try {
    instancias = await evo.fetchInstances();
  } catch (err) {
    return res.status(502).json({
      evolutionConfigurada: true,
      error: err instanceof Error ? err.message : String(err),
      numeros: [],
    });
  }

  /*
   * Resumo por INSTÂNCIA, para a tela poder responder "como está esse número?"
   * sem o dono ter que cruzar três seções. Vem do banco, não da Evolution:
   * disparo, pausa, banimento e último envio são fatos NOSSOS.
   */
  const resumo = await query<{
    instance_ref: string; disparo: string; pausados: string; banidos: string;
    escuta: string; enviadas_hoje: string; ultimo_envio: string | null;
  }>(
    `SELECT c.instance_ref,
            count(*) FILTER (WHERE c.role='poster'   AND c.status='active')::text  AS disparo,
            count(*) FILTER (WHERE c.role='poster'   AND c.status='paused')::text  AS pausados,
            count(*) FILTER (WHERE c.status='banned')::text                        AS banidos,
            count(*) FILTER (WHERE c.role='listener' AND c.status='active')::text  AS escuta,
            (SELECT count(*)::text FROM send_logs s
              JOIN channels c2 ON c2.id = s.channel_id
             WHERE c2.instance_ref = c.instance_ref AND s.status='sent'
               AND s.sent_at >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo')
                                AT TIME ZONE 'America/Sao_Paulo')                  AS enviadas_hoje,
            (SELECT max(s.sent_at)::text FROM send_logs s
              JOIN channels c3 ON c3.id = s.channel_id
             WHERE c3.instance_ref = c.instance_ref AND s.status='sent')           AS ultimo_envio
       FROM channels c GROUP BY c.instance_ref`,
  );
  const porInstancia = new Map(resumo.map((r) => [r.instance_ref, r]));

  const numeros = [];
  for (const inst of instancias) {
    const nome = String(inst.name ?? inst.instanceName ?? '');
    const conectada = String(inst.connectionStatus ?? inst.state ?? '') === 'open';
    /*
     * Só busca grupos de instância CONECTADA. Pedir os grupos de uma instância
     * desligada faz a Evolution demorar até estourar o tempo e devolver erro —
     * com 4 instâncias e 3 desligadas, a tela levaria minutos para carregar por
     * causa de dados que não existem.
     */
    let grupos: Array<{ id: string; subject: string }> = [];
    let erroGrupos: string | undefined;
    let doCache = false;
    if (conectada) {
      try {
        /*
         * CACHE: `fetchAllGroups` percorre a lista inteira no WhatsApp e leva
         * segundos com muitos grupos — a tela ficava parada em "carregando"
         * toda vez que era aberta, para responder algo que quase não muda.
         * Só o resultado BOM é guardado (ver `cache.ts`): erro cacheado ficaria
         * congelado pelo TTL inteiro.
         */
        const r = await comCache(
          `grupos:${nome}`, TTL_GRUPOS, () => evo.fetchAllGroups(nome), forcar,
        );
        grupos = r.valor;
        doCache = r.doCache;
      } catch (err) {
        erroGrupos = err instanceof Error ? err.message : String(err);
      }
    }
    const r = porInstancia.get(nome);
    // Nome próprio: `observados` já existe no escopo de fora (a lista crua).
    const qtdObservados = grupos.filter((g) => obsPorJid.get(g.id)?.is_active).length;
    numeros.push({
      instancia: nome,
      conectada,
      estado: inst.connectionStatus ?? inst.state ?? 'desconhecido',
      /*
       * `banido` vem do NOSSO registro (`channels.status='banned'`), não da
       * Evolution: ela só sabe dizer que a sessão caiu, e sessão caída pode ser
       * celular sem bateria. Banimento é conclusão nossa, e confundir os dois
       * faria o painel gritar "banido" a cada queda de conexão.
       */
      banido: Number(r?.banidos ?? 0) > 0,
      disparo: Number(r?.disparo ?? 0),
      pausados: Number(r?.pausados ?? 0),
      escuta: Number(r?.escuta ?? 0),
      observados: qtdObservados,
      enviadasHoje: Number(r?.enviadas_hoje ?? 0),
      ultimoEnvio: r?.ultimo_envio ?? null,
      numero: String(inst.ownerJid ?? inst.owner ?? '').replace(/\D/g, '') || null,
      perfil: inst.profileName ?? null,
      erroGrupos,
      doCache,
      grupos: grupos.map((g) => {
        const canal = porJid.get(g.id);
        const obs = obsPorJid.get(g.id);
        return {
          jid: g.id,
          nome: g.subject,
          canalId: canal?.id ?? null,
          papel: canal?.role ?? null,
          canalStatus: canal?.status ?? null,
          observado: obs ? { kind: obs.kind, ativo: obs.is_active } : null,
        };
      }),
    });
  }
  res.json({ evolutionConfigurada: true, numeros });
}));

/**
 * DE ONDE VEM A OFERTA DE CADA GRUPO — API, fonte própria, ou eco de outro
 * grupo observado. Ver `intel/rede.ts` para o que cada veredito significa.
 */
app.get('/api/intel/rede', wrap(async (req: Request, res: Response) => {
  res.json(await redeDeGrupos(Number(req.query.dias)));
}));

/**
 * DE QUE CADA GRUPO FALA — o perfil de categoria, medido em vez de rotulado.
 *
 * Substitui o `kind` escolhido na mão ("promoção genérica"), que dizia o que o
 * dono ACHAVA. A categoria vem carimbada pela Shopee em `productCatIds`, então
 * "generalista" passa a ser uma conclusão do dado, não um palpite.
 */
app.get('/api/intel/nicho', wrap(async (req: Request, res: Response) => {
  // Padrão SÓ SHOPEE: é a única fatia com que o motor compete. `todas=1` liga a
  // comparação com o resto, que continua disponível — desligada, não removida.
  const somenteShopee = String(req.query.todas ?? '') !== '1';
  const [dados, catsNoBanco] = await Promise.all([
    nichoDosGrupos(Number(req.query.dias), somenteShopee),
    categoriasGuardadas(),
  ]);
  /*
   * Sem a árvore sincronizada NADA tem categoria, e o painel mostraria todos
   * os grupos com "amostra pequena" — sintoma que parece falta de dado e é, na
   * verdade, falta de um passo de configuração. Melhor dizer qual é.
   */
  res.json({ ...dados, arvoreSincronizada: catsNoBanco > 0, categoriasConhecidas: catsNoBanco });
}));

/* ==================== ETIQUETAS DE ASSUNTO ==================== */

/** Catálogo de etiquetas: o que veio da Shopee e o que o dono cadastrou. */
app.get('/api/intel/etiquetas', wrap(async (_req: Request, res: Response) => {
  res.json(await query(
    `SELECT e.id::text, e.nome, e.origem,
            (SELECT count(*) FROM intel_groups g WHERE g.etiqueta_id = e.id)::int AS grupos
       FROM etiquetas_grupo e ORDER BY e.origem DESC, e.nome`,
  ));
}));

/**
 * Cadastra uma etiqueta nova.
 *
 * Devolve `jaExistia` em vez de erro quando o nome bate com uma existente: o
 * dono digitou "esportes" e já havia "Esportes" — isso não é falha dele, e
 * tratar como erro faria parecer que o cadastro não funciona. Devolvemos a que
 * já existe para a tela poder simplesmente selecioná-la.
 */
app.post('/api/intel/etiquetas', wrap(async (req: Request, res: Response) => {
  const nome = String(req.body?.nome ?? '').trim();
  if (nome.length < 2) return res.status(400).json({ error: 'dê um nome com pelo menos 2 letras' });
  /*
   * 30 é o teto porque é o que a interface consegue mostrar INTEIRO sem cortar
   * nem quebrar linha. Aceitar 40 e exibir 30 seria pior que recusar: o dono
   * cadastraria um nome que nunca conseguiria ler de volta.
   */
  if (nome.length > 30) return res.status(400).json({ error: 'nome muito longo (máx. 30 caracteres)' });
  const norm = normalizarEtiqueta(nome);

  const existente = await queryOne<{ id: string; nome: string }>(
    `SELECT id::text, nome FROM etiquetas_grupo WHERE nome_norm = $1`, [norm],
  );
  if (existente) return res.json({ ...existente, jaExistia: true });

  const nova = await queryOne<{ id: string; nome: string }>(
    `INSERT INTO etiquetas_grupo (nome, nome_norm, origem) VALUES ($1,$2,'usuario')
     RETURNING id::text, nome`,
    [nome, norm],
  );
  log.info('etiqueta de assunto cadastrada', { nome });
  res.json({ ...nova!, jaExistia: false });
}));

/** Remove uma etiqueta do catálogo (os grupos que a usavam ficam sem etiqueta). */
app.delete('/api/intel/etiquetas/:id', wrap(async (req: Request, res: Response) => {
  const r = await query(
    `DELETE FROM etiquetas_grupo WHERE id = $1 AND origem = 'usuario' RETURNING id`,
    [req.params.id],
  );
  if (!r.length) {
    return res.status(400).json({ error: 'etiqueta não encontrada, ou é uma das que vieram da Shopee' });
  }
  res.json({ ok: true });
}));

/* ==================== MONITOR DE PREÇOS ==================== */

/**
 * MELHORES OPORTUNIDADES — cada item comparado com o PRÓPRIO passado.
 *
 * ⚠️ Este número NÃO entra no critério de disparo hoje. Decisão do dono: o
 * monitor amadurece observando, e com poucos dias de histórico qualquer
 * afirmação seria ruído com cara de informação. A rota é de leitura.
 */
app.get('/api/precos/oportunidades', wrap(async (req: Request, res: Response) => {
  const [linhas, resumo] = await Promise.all([
    melhoresOportunidades({
      dias: Number(req.query.dias) || 90,
      limite: Number(req.query.limite) || 40,
      soConfiavel: String(req.query.confiavel ?? '') === '1',
      categoria: req.query.categoria ? String(req.query.categoria) : undefined,
    }),
    resumoMonitor(),
  ]);
  res.json({ janelas: JANELAS, resumo, oportunidades: linhas });
}));

/** A ficha de um produto: série + estatística na janela pedida. */
app.get('/api/precos/produto/:id', wrap(async (req: Request, res: Response) => {
  const dias = Math.max(7, Math.min(365, Number(req.query.dias) || 90));
  /*
   * O log de mudanças (`serie()`) NÃO vai na resposta: a ficha desenha a linha
   * a partir do `diario`, que já é uma função em degraus no MESMO eixo de tempo
   * da faixa de cobertura. Mandar as duas séries fazia a tela buscar uma e
   * descartar — e desenhar as duas em eixos diferentes, empilhadas, afirmaria
   * um alinhamento temporal que não existe.
   */
  const [est, diario, onde] = await Promise.all([
    estatisticas(req.params.id!, dias),
    historicoDiario(req.params.id!, dias),
    ondeApareceu(req.params.id!, dias),
  ]);
  if (!est) return res.status(404).json({ error: 'produto não está no monitor' });
  res.json({ ...est, diario, ...onde });
}));

/** Traz para o histórico o que já foi observado antes de o monitor existir. */
app.post('/api/precos/backfill', wrap(async (_req: Request, res: Response) => {
  res.json(await backfill());
}));

/** Baixa a árvore oficial de categorias da Shopee (público, sem credencial). */
app.post('/api/shopee/categorias/sync', wrap(async (_req: Request, res: Response) => {
  try {
    const r = await sincronizarCategorias();
    // Semeia o catálogo de etiquetas junto: sem isso a lista de assunto nasce
    // vazia mesmo com as 31 categorias já baixadas.
    const etiquetas = await semearEtiquetas();
    res.json({ ok: true, ...r, etiquetas });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

/**
 * Passa a OBSERVAR um grupo, direto da lista de grupos do número.
 *
 * Garante o webhook no mesmo passo, de propósito: cadastrar o grupo sem o
 * webhook apontado para cá é um NADA silencioso — o painel mostraria o grupo
 * como observado e nenhuma mensagem chegaria nunca. Era o erro mais fácil de
 * cometer neste fluxo.
 */
app.post('/api/intel/observar', wrap(async (req: Request, res: Response) => {
  const jid = String(req.body?.jid ?? '').trim();
  const nome = String(req.body?.nome ?? '').trim();
  const kind = String(req.body?.kind ?? 'promo');
  const instancia = String(req.body?.instancia ?? '').trim();
  if (!jid.endsWith('@g.us')) return res.status(400).json({ error: 'id de grupo inválido (precisa terminar em @g.us)' });
  if (!['promo', 'nicho', 'misto', 'proprio'].includes(kind)) {
    return res.status(400).json({ error: 'tipo inválido' });
  }

  const passos: string[] = [];
  await query(
    `INSERT INTO intel_groups (group_jid, display_name, kind, is_active)
     VALUES ($1,$2,$3,true)
     ON CONFLICT (group_jid) DO UPDATE
        SET display_name = EXCLUDED.display_name, kind = EXCLUDED.kind, is_active = true`,
    [jid, nome || jid, kind],
  );
  passos.push('grupo marcado para observação');

  // Webhook: sem ele nada chega, e o silêncio pareceria "eles não postam".
  let webhookOk = false;
  const url = await urlWebhook();
  if (!url) {
    passos.push('ATENÇÃO: defina PUBLIC_APP_URL — sem ela não dá para apontar o webhook, e nada será coletado');
  } else if (!instancia) {
    passos.push('ATENÇÃO: sem instância informada não dá para conferir o webhook');
  } else {
    const evo = await getEvolution();
    if (!evo) {
      passos.push('ATENÇÃO: Evolution não configurada — o webhook não foi verificado');
    } else {
      try {
        await evo.setWebhook(instancia, url, ['MESSAGES_UPSERT']);
        webhookOk = true;
        passos.push(`webhook do número "${instancia}" apontado para cá`);
      } catch (err) {
        passos.push(`não consegui configurar o webhook (${err instanceof Error ? err.message : 'erro'}) — sem ele nada é coletado`);
      }
    }
  }
  res.json({ ok: true, jid, webhookOk, passos });
}));

/**
 * DESLIGA a observação de um grupo (o outro lado do interruptor).
 *
 * `is_active = false` em vez de DELETE: os posts já coletados continuam valendo
 * para o histórico e para a análise de rede. Apagar o grupo levaria junto tudo
 * que ele ensinou (`ON DELETE CASCADE` em `intel_posts`), e desligar um
 * interruptor não deve destruir dado.
 */
app.delete('/api/intel/observar/:jid', wrap(async (req: Request, res: Response) => {
  const jid = String(req.params.jid ?? '');
  const r = await query('UPDATE intel_groups SET is_active = false WHERE group_jid = $1 RETURNING id', [jid]);
  if (!r.length) return res.status(404).json({ error: 'grupo não estava sendo observado' });
  res.json({ ok: true, jid, aviso: 'observação desligada — os posts já coletados continuam no histórico' });
}));

/**
 * A FILA DESTE GRUPO — por que a próxima oferta ainda não saiu, e quando sai.
 *
 * A cadência é POR CANAL (colunas da tabela `channels`), então "a fila" só faz
 * sentido por grupo. Um número em vários grupos dispara mais no total, e sem
 * esta tela não havia como perceber isso.
 */
app.get('/api/channels/:id/fila', wrap(async (req: Request, res: Response) => {
  const id = req.params.id!;
  const ch = await queryOne<{
    id: string; display_name: string | null; target_ref: string | null; instance_ref: string;
    role: string; status: string; timezone: string; daily_cap: number;
    drip_min_sec: number; drip_max_sec: number; jitter_min_sec: number; jitter_max_sec: number;
    quiet_start: string; quiet_end: string;
  }>(`SELECT * FROM channels WHERE id = $1`, [id]);
  if (!ch) return res.status(404).json({ error: 'canal não encontrado' });

  const [naFila, proximas, agenda, hoje, ultimo] = await Promise.all([
    tamanhoDaFila(id),
    proximasDaFila(id, 8),
    queryOne<{ next_run_at: string | null; last_run_at: string | null; state: string }>(
      `SELECT next_run_at, last_run_at, state FROM schedules WHERE channel_id = $1`, [id],
    ),
    queryOne<{ n: string }>(
      `SELECT count(*) AS n FROM send_logs
        WHERE channel_id = $1 AND status = 'sent'
          AND sent_at >= (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)`,
      [id, ch.timezone],
    ),
    queryOne<{ sent_at: string | null; title: string | null }>(
      `SELECT s.sent_at, o.title FROM send_logs s
         LEFT JOIN offers o ON o.id = s.offer_id
        WHERE s.channel_id = $1 AND s.status = 'sent'
        ORDER BY s.sent_at DESC LIMIT 1`, [id],
    ),
  ]);

  const enviadasHoje = Number(hoje?.n ?? 0);
  /*
   * Diz POR QUE não vai sair agora, em vez de só mostrar um horário. Sem isto,
   * "próximo às 03:40" com a fila cheia parece defeito — e pode ser janela de
   * silêncio funcionando exatamente como configurada.
   */
  let motivoParado: string | null = null;
  if (ch.status !== 'active') motivoParado = 'canal pausado';
  else if (enviadasHoje >= ch.daily_cap) motivoParado = `teto diário atingido (${enviadasHoje} de ${ch.daily_cap})`;
  else if (naFila === 0) motivoParado = 'nada na fila — o motor captura a cada 30 min';

  res.json({
    canal: {
      id: ch.id, nome: ch.display_name, grupo: ch.target_ref,
      instancia: ch.instance_ref, papel: ch.role, status: ch.status,
    },
    cadencia: {
      dripMinSec: ch.drip_min_sec, dripMaxSec: ch.drip_max_sec,
      jitterMinSec: ch.jitter_min_sec, jitterMaxSec: ch.jitter_max_sec,
      silencioInicio: ch.quiet_start, silencioFim: ch.quiet_end,
      tetoDiario: ch.daily_cap, fuso: ch.timezone,
    },
    naFila, enviadasHoje, motivoParado,
    proximoEm: agenda?.next_run_at ?? null,
    ultimaRodada: agenda?.last_run_at ?? null,
    ultimoEnvio: ultimo?.sent_at ?? null,
    ultimoTitulo: ultimo?.title ?? null,
    proximas,
  });
}));

// Lista canais cadastrados.
app.get('/api/channels', wrap(async (_req: Request, res: Response) => {
  res.json(
    await query(
      `SELECT id, role, instance_ref, target_ref, display_name, status, daily_cap, sent_today
         FROM channels ORDER BY created_at`,
    ),
  );
}));

// Registra um canal (número + grupo + nome).
app.post('/api/channels', wrap(async (req: Request, res: Response) => {
  const { role, instance_ref, target_ref, display_name } = req.body ?? {};
  if (role !== 'poster' && role !== 'listener') {
    return res.status(400).json({ error: 'role deve ser poster ou listener' });
  }
  if (!instance_ref) return res.status(400).json({ error: 'instance_ref obrigatório' });
  if (role === 'poster' && !target_ref) {
    return res.status(400).json({ error: 'poster precisa do id do grupo (target_ref)' });
  }
  const row = await queryOne<{ id: string }>(
    `INSERT INTO channels (role, instance_ref, target_ref, display_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (platform, instance_ref, target_ref)
     DO UPDATE SET display_name = EXCLUDED.display_name, status = 'active'
     RETURNING id`,
    [role, instance_ref, target_ref ?? null, display_name ?? instance_ref],
  );
  res.json({ ok: true, id: row?.id });
}));

// Registra VÁRIOS grupos de uma vez para o mesmo número (escolher onde disparar).
app.post('/api/channels/bulk', wrap(async (req: Request, res: Response) => {
  const { instance_ref, groups } = req.body ?? {};
  if (!instance_ref) return res.status(400).json({ error: 'instance_ref obrigatório' });
  if (!Array.isArray(groups) || groups.length === 0) {
    return res.status(400).json({ error: 'informe os grupos' });
  }
  let created = 0;
  for (const g of groups as Array<{ id: string; subject?: string }>) {
    if (!g?.id) continue;
    await query(
      `INSERT INTO channels (role, instance_ref, target_ref, display_name)
       VALUES ('poster', $1, $2, $3)
       ON CONFLICT (platform, instance_ref, target_ref)
       DO UPDATE SET display_name = EXCLUDED.display_name, status = 'active'`,
      [instance_ref, g.id, g.subject || g.id],
    );
    created += 1;
  }
  res.json({ ok: true, created });
}));

// Pausar / reativar um canal (liga/desliga o disparo naquele grupo).
app.patch('/api/channels/:id', wrap(async (req: Request, res: Response) => {
  const id = req.params.id!;
  const b = req.body ?? {};

  // ---- pausar / ativar ----
  if (b.status !== undefined) {
    if (!['active', 'paused'].includes(b.status)) {
      return res.status(400).json({ error: 'status deve ser active ou paused' });
    }
    await query(`UPDATE channels SET status = $1 WHERE id = $2`, [b.status, id]);
    if (b.status !== 'active') await removeDripJob(id);
    if (b.cadencia === undefined) return res.json({ ok: true });
  }

  // ---- cadência do canal ----
  const c = b.cadencia;
  if (c === undefined) return res.status(400).json({ error: 'nada para atualizar' });

  const num = (v: unknown, min: number, max: number, nome: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new HttpError(400, `${nome} deve ser um número entre ${min} e ${max}`);
    }
    return Math.round(n);
  };
  const hora = (v: unknown, nome: string): string => {
    const s = String(v ?? '');
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(s)) {
      throw new HttpError(400, `${nome} deve estar no formato HH:MM`);
    }
    return `${s}:00`;
  };

  try {
    const dripMin = num(c.dripMinSec, 30, 86400, 'intervalo mínimo');
    const dripMax = num(c.dripMaxSec, 30, 86400, 'intervalo máximo');
    const jitMin = num(c.jitterMinSec, 0, 3600, 'jitter mínimo');
    const jitMax = num(c.jitterMaxSec, 0, 3600, 'jitter máximo');
    const cap = num(c.tetoDiario, 1, 1000, 'teto diário');
    /*
     * min > max faria `randInt(min, max)` devolver lixo e o gotejamento passaria
     * a agendar em intervalo negativo — ou seja, rajada. É exatamente o
     * comportamento que a cadência existe para impedir, então é 400, não um
     * ajuste silencioso: trocar os valores por trás seria o painel decidindo
     * sozinho algo que muda o risco de ban.
     */
    if (dripMin > dripMax) throw new HttpError(400, 'o intervalo mínimo não pode ser maior que o máximo');
    if (jitMin > jitMax) throw new HttpError(400, 'o jitter mínimo não pode ser maior que o máximo');

    await query(
      `UPDATE channels SET drip_min_sec=$1, drip_max_sec=$2, jitter_min_sec=$3,
              jitter_max_sec=$4, daily_cap=$5, quiet_start=$6, quiet_end=$7
        WHERE id=$8`,
      [dripMin, dripMax, jitMin, jitMax, cap,
       hora(c.silencioInicio, 'início do silêncio'), hora(c.silencioFim, 'fim do silêncio'), id],
    );
    /*
     * O job em voo já está agendado com o intervalo ANTIGO — ele só lê as
     * colunas na próxima rodada. Sem avisar, o dono muda de 30min para 5min,
     * não vê nada acontecer por meia hora e conclui que a tela não funciona.
     */
    res.json({ ok: true, aviso: 'vale a partir do próximo disparo; o que já está agendado mantém o intervalo anterior' });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
}));

// Remover um canal (para de disparar naquele grupo e apaga o histórico dele).
app.delete('/api/channels/:id', wrap(async (req: Request, res: Response) => {
  const id = req.params.id!;
  await removeDripJob(id);
  await tx(async (c) => {
    await c.query(`DELETE FROM send_logs WHERE channel_id = $1`, [id]);
    await c.query(`DELETE FROM schedules WHERE channel_id = $1`, [id]);
    await c.query(`DELETE FROM channels WHERE id = $1`, [id]);
  });
  res.json({ ok: true });
}));

// ---- Configurações (chave OpenAI / modelo) pela interface ----
app.get('/api/settings', wrap(async (_req: Request, res: Response) => {
  res.json(await settingsStatus());
}));

app.put('/api/settings', wrap(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, string>;
  const applied: string[] = [];
  for (const key of SETTING_KEYS) {
    if (key in body) {
      const v = String(body[key] ?? '').trim();
      await setSetting(key, v === '' ? null : v);
      applied.push(key);
    }
  }
  res.json({ ok: true, applied, settings: await settingsStatus() });
}));

// ============================================================
// INTELIGÊNCIA DE MERCADO
// Engenharia reversa do critério dos concorrentes: cruza o que a API da Shopee
// ofereceu com o que os grupos postaram, no mesmo eixo do tempo.
// ============================================================

// ---- Grupos observados (o painel liga/desliga; o fluxo do n8n lê daqui) ----
app.get('/api/intel/groups', wrap(async (_req: Request, res: Response) => {
  res.json(
    await query(
      `SELECT g.id, g.group_jid, g.display_name, g.kind, g.instance_ref, g.is_active, g.notes,
              g.posts_count, g.last_post_at, g.created_at,
              g.etiqueta_id::text AS etiqueta_id, e.nome AS etiqueta
         FROM intel_groups g
         LEFT JOIN etiquetas_grupo e ON e.id = g.etiqueta_id
        ORDER BY g.is_active DESC, g.posts_count DESC, g.created_at`,
    ),
  );
}));

const TIPOS_GRUPO = ['promo', 'nicho', 'misto', 'proprio'];

app.post('/api/intel/groups', wrap(async (req: Request, res: Response) => {
  const jid = String(req.body?.group_jid ?? '').trim();
  if (!jid.endsWith('@g.us')) {
    return res.status(400).json({ error: 'group_jid deve terminar em @g.us' });
  }
  const kind = TIPOS_GRUPO.includes(req.body?.kind) ? req.body.kind : 'promo';
  const row = await queryOne<{ id: string }>(
    `INSERT INTO intel_groups (group_jid, display_name, kind, instance_ref, notes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (group_jid) DO UPDATE
       SET display_name = COALESCE(EXCLUDED.display_name, intel_groups.display_name),
           kind         = EXCLUDED.kind,
           instance_ref = COALESCE(EXCLUDED.instance_ref, intel_groups.instance_ref),
           notes        = COALESCE(EXCLUDED.notes, intel_groups.notes),
           is_active    = true
     RETURNING id`,
    [
      jid,
      req.body?.display_name ? String(req.body.display_name) : null,
      kind,
      req.body?.instance_ref ? String(req.body.instance_ref) : null,
      req.body?.notes ? String(req.body.notes) : null,
    ],
  );
  res.json({ ok: true, id: row?.id });
}));

// Registra VÁRIOS grupos de uma vez (marcados na lista da Evolution).
app.post('/api/intel/groups/bulk', wrap(async (req: Request, res: Response) => {
  const { groups, kind, instance_ref } = req.body ?? {};
  if (!Array.isArray(groups) || groups.length === 0) {
    return res.status(400).json({ error: 'informe os grupos' });
  }
  const tipo = TIPOS_GRUPO.includes(kind) ? kind : 'promo';
  let created = 0;
  for (const g of groups as Array<{ id: string; subject?: string }>) {
    if (!g?.id || !String(g.id).endsWith('@g.us')) continue;
    await query(
      `INSERT INTO intel_groups (group_jid, display_name, kind, instance_ref)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (group_jid) DO UPDATE
         SET display_name = COALESCE(EXCLUDED.display_name, intel_groups.display_name),
             kind = EXCLUDED.kind, is_active = true`,
      [g.id, g.subject || g.id, tipo, instance_ref ? String(instance_ref) : null],
    );
    created += 1;
  }
  res.json({ ok: true, created });
}));

app.patch('/api/intel/groups/:id', wrap(async (req: Request, res: Response) => {
  const campos: string[] = [];
  const params: unknown[] = [];
  if (typeof req.body?.is_active === 'boolean') {
    params.push(req.body.is_active);
    campos.push(`is_active = $${params.length}`);
  }
  if (TIPOS_GRUPO.includes(req.body?.kind)) {
    params.push(req.body.kind);
    campos.push(`kind = $${params.length}`);
  }
  /*
   * `etiqueta_id` aceita null de propósito — "sem assunto definido" é um estado
   * legítimo, e sem essa saída o dono não conseguiria desfazer uma marcação
   * errada.
   */
  if ('etiqueta_id' in (req.body ?? {})) {
    const v = req.body.etiqueta_id;
    params.push(v === null || v === '' ? null : String(v));
    campos.push(`etiqueta_id = $${params.length}`);
  }
  if (typeof req.body?.display_name === 'string') {
    params.push(req.body.display_name);
    campos.push(`display_name = $${params.length}`);
  }
  if (typeof req.body?.notes === 'string') {
    params.push(req.body.notes);
    campos.push(`notes = $${params.length}`);
  }
  if (!campos.length) return res.status(400).json({ error: 'nada para atualizar' });
  params.push(req.params.id);
  await query(`UPDATE intel_groups SET ${campos.join(', ')} WHERE id = $${params.length}`, params);
  res.json({ ok: true });
}));

// Remove o grupo E os posts dele (ON DELETE CASCADE cuida de posts/matches).
app.delete('/api/intel/groups/:id', wrap(async (req: Request, res: Response) => {
  await query(`DELETE FROM intel_groups WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

/**
 * INGESTÃO — é aqui que o fluxo do n8n entrega o que leu nos grupos.
 * Sem sessão (o n8n não tem), com o segredo na URL. Aceita um objeto ou um
 * array, porque no n8n é natural mandar um lote de itens de uma vez.
 * Responde 200 mesmo para item recusado (repetido, grupo pausado): recusa não é
 * erro de integração, e devolver 4xx faria o n8n marcar a execução como falha e
 * tentar de novo para sempre.
 */
app.post('/api/intel/ingest/:token', wrap(async (req: Request, res: Response) => {
  if (!segredoConfere(req.params.token, await tokenIngestao())) {
    log.warn('ingestão com token inválido', { ip: ipDe(req) });
    res.status(401).json({ error: 'token inválido' });
    return;
  }
  const corpo = req.body;
  const itens: unknown[] = Array.isArray(corpo) ? corpo : [corpo];
  if (itens.length > 500) {
    res.status(413).json({ error: 'lote grande demais (máx. 500 por chamada)' });
    return;
  }
  const resultados = [];
  for (const item of itens) {
    try {
      resultados.push(await ingestPost(item as IngestInput));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('ingestão falhou num item', { err: msg });
      resultados.push({ ok: false, reason: msg });
    }
  }
  res.json({
    ok: true,
    recebidos: itens.length,
    gravados: resultados.filter((r) => r.ok && r.postId).length,
    resultados,
  });
}));

// A URL completa da ingestão (com token) para colar no n8n + como girar o token.
app.get('/api/intel/ingest-url', wrap(async (_req: Request, res: Response) => {
  const cfg = loadConfig();
  const base = cfg.PUBLIC_APP_URL?.replace(/\/$/, '');
  res.json({
    url: base ? `${base}/api/intel/ingest/${await tokenIngestao()}` : null,
    aviso: base ? null : 'defina PUBLIC_APP_URL para o app saber a própria URL',
  });
}));

app.post('/api/intel/ingest-url/rotate', wrap(async (_req: Request, res: Response) => {
  const token = await girarTokenIngestao();
  const cfg = loadConfig();
  const base = cfg.PUBLIC_APP_URL?.replace(/\/$/, '');
  log.warn('token de ingestão girado — reconfigure o fluxo do n8n');
  res.json({ ok: true, url: base ? `${base}/api/intel/ingest/${token}` : null });
}));

// ---- Varredura (observação larga da API) ----
app.get('/api/intel/sweeps', wrap(async (_req: Request, res: Response) => {
  res.json(
    await query(
      `SELECT id, started_at, finished_at, trigger, keywords, observed, stats, error
         FROM intel_sweeps ORDER BY started_at DESC LIMIT 12`,
    ),
  );
}));

app.post('/api/intel/sweep', wrap(async (_req: Request, res: Response) => {
  if (varreduraEmAndamento()) {
    res.status(409).json({ error: 'já existe uma varredura rodando' });
    return;
  }
  res.status(202).json({ ok: true, msg: 'varredura iniciada' });
  runSweepExclusivo('manual').catch((err) =>
    log.error('varredura manual falhou', { err: err instanceof Error ? err.message : String(err) }),
  );
}));

// Recorrelaciona posts pendentes sob demanda (depois de mexer nos limiares).
app.post('/api/intel/rematch', wrap(async (req: Request, res: Response) => {
  const todos = req.body?.todos === true;
  if (todos) {
    // Zera matched_at para reprocessar tudo com os limiares novos.
    await query(`UPDATE intel_posts SET matched_at = NULL`);
  }
  const limite = Math.min(Math.max(Number(req.body?.limit ?? 500), 1), 5000);
  res.status(202).json({ ok: true, msg: 'correlação iniciada' });
  matchPendingPosts(limite).catch((err) =>
    log.error('recorrelação falhou', { err: err instanceof Error ? err.message : String(err) }),
  );
}));

app.post('/api/intel/posts/:id/rematch', wrap(async (req: Request, res: Response) => {
  res.json(await matchOnePost(req.params.id!));
}));

// ---- Relatórios (é o dashboard de correlação) ----
const dias = (v: unknown, def: number) => Math.min(Math.max(Number(v ?? def) || def, 1), 365);

/**
 * "Hoje" no fuso do dono, não em UTC. A virada do dia em UTC acontece às 21h de
 * Brasília — sem isto, entre 21h e meia-noite o painel abriria já mostrando o
 * dia seguinte, vazio, e pareceria que o motor parou.
 *
 * Via Intl e não subtraindo 3 horas: o Brasil não tem horário de verão desde
 * 2019, então o offset fixo acerta hoje, mas é premissa que quebra calada.
 * ('en-CA' é o locale que formata como YYYY-MM-DD.)
 */
const fmtDiaSP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });
const hojeNoFusoDoDono = () => fmtDiaSP.format(new Date());

app.get('/api/intel/summary', wrap(async (req: Request, res: Response) => {
  res.json(await resumoDiario(dias(req.query.dias, 14)));
}));

app.get('/api/intel/correlation', wrap(async (req: Request, res: Response) => {
  const q = req.query as Record<string, string | undefined>;
  res.json(
    await correlacaoDoDia(q.dia && /^\d{4}-\d{2}-\d{2}$/.test(q.dia) ? q.dia : hojeNoFusoDoDono(), {
      verdict: q.verdict || undefined,
      groupId: q.groupId || undefined,
      limit: q.limit ? Math.min(Number(q.limit), 500) : undefined,
    }),
  );
}));

/**
 * Densidade do dia em baldes de 15 min — é o FUNDO do gráfico da travessia.
 * Devolve contagem por balde em vez das linhas cruas porque um dia tem ~11 mil
 * observações e o navegador não precisa de nenhuma delas para desenhar a faixa
 * de densidade: precisa de 96 números.
 */
app.get('/api/intel/day-density', wrap(async (req: Request, res: Response) => {
  const q = req.query as Record<string, string | undefined>;
  const dia = q.dia && /^\d{4}-\d{2}-\d{2}$/.test(q.dia) ? q.dia : hojeNoFusoDoDono();

  // Fuso do dono: a virada do dia em UTC cai às 21h de Brasília e jogaria as
  // ofertas da noite para o dia seguinte.
  const balde = (tabela: string, coluna: string) => `
    SELECT floor(
             (EXTRACT(HOUR FROM ${coluna} AT TIME ZONE 'America/Sao_Paulo') * 60
            + EXTRACT(MINUTE FROM ${coluna} AT TIME ZONE 'America/Sao_Paulo')) / 15
           )::int AS balde,
           count(*)::int AS n
      FROM ${tabela}
     WHERE (${coluna} AT TIME ZONE 'America/Sao_Paulo')::date = $1::date
     GROUP BY 1 ORDER BY 1`;

  const [observacoes, posts] = await Promise.all([
    query<{ balde: number; n: number }>(balde('api_observations', 'observed_at'), [dia]),
    query<{ balde: number; n: number }>(balde('intel_posts', 'posted_at'), [dia]),
  ]);
  res.json({ dia, observacoes, posts });
}));

app.get('/api/intel/repeats', wrap(async (req: Request, res: Response) => {
  const min = Math.max(Number(req.query.minVezes ?? 2) || 2, 2);
  res.json(await repeticaoDeProdutos(dias(req.query.dias, 30), min));
}));

app.get('/api/intel/hours', wrap(async (req: Request, res: Response) => {
  res.json(await distribuicaoPorHora(dias(req.query.dias, 14)));
}));

app.get('/api/intel/coverage', wrap(async (req: Request, res: Response) => {
  res.json(await coberturaPorGrupo(dias(req.query.dias, 14)));
}));

app.get('/api/intel/profile', wrap(async (req: Request, res: Response) => {
  res.json(await perfilDeEscolha(dias(req.query.dias, 14)));
}));

/**
 * Painel de página única: as abas são caminhos de verdade (/fila, /conexoes,
 * /config, /falhas). Sem este fallback, abrir a URL da aba direto no navegador
 * dava 404 (reclamação real do dono). /api, /health, /webhook e /ws seguem
 * intactos — só o que NÃO é rota de API cai no index.html.
 */
const ABAS = [
  '/', '/fila', '/feed', '/feed/monitor', '/conexoes', '/config', '/falhas',
  '/ciclos', '/inteligencia', '/grupos',
];
app.get(ABAS, (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

/**
 * Tratador de erro (tem que vir DEPOIS de todas as rotas, e com 4 argumentos —
 * é assim que o Express identifica um error handler). Devolve 500 com mensagem
 * em vez de deixar o processo morrer.
 */
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const msg = err instanceof Error ? err.message : String(err);
  log.error('erro na rota', { path: req.path, method: req.method, err: msg });
  if (res.headersSent) return;
  res.status(500).json({ error: msg });
});

export function startApi(): void {
  const cfg = loadConfig();

  // Rede de segurança: nada de crash loop silencioso por promessa solta.
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection (processo mantido vivo)', {
      err: reason instanceof Error ? reason.message : String(reason),
    });
  });
  process.on('uncaughtException', (err) => {
    // Estado desconhecido: registra e sai para o Swarm recriar limpo.
    log.error('uncaughtException — reiniciando', { err: err.message });
    process.exit(1);
  });
  // Garante que existe senha ANTES de servir qualquer coisa (gera na 1ª vez e
  // mostra no log uma única vez).
  garantirSenha().catch((err) =>
    log.error('não conseguiu preparar a senha do painel', {
      err: err instanceof Error ? err.message : String(err),
    }),
  );
  const protegido = true;
  const server = app.listen(cfg.API_PORT, () => {
    log.info('API ouvindo', { port: cfg.API_PORT, painelProtegido: protegido });
  });

  // WebSocket para o dashboard (broadcast simples de heartbeat/eventos).
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
  });
  const beat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    }
  }, 30_000);
  beat.unref?.();
}

if (require.main === module) {
  startApi();
}
