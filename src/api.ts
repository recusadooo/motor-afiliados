import path from 'node:path';
import express, { type Request, type Response, type NextFunction } from 'express';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config';
import { log } from './logger';
import { query, queryOne, tx } from './db';
import { handleEvolutionWebhook } from './whatsapp/listener';
import { breakerState } from './resilience/breaker';
import { removeDripJob } from './queue/scheduler';
import { getEvolution, GROUPS_INSTANCE_SETTINGS } from './whatsapp/evolution';
import { settingsStatus, setSetting, SETTING_KEYS } from './settings';
import { runCaptureExclusivo, capturaEmAndamento } from './capture/shopeeFeed';
import {
  COOKIE, cabecalhosSeguranca, limiteApi, autenticar, criarSessao, sessaoValida, lerCookie,
  garantirSenha, trocarSenha, usuarioPainel, tokenWebhook, ipDe, loginBloqueado,
  registrarTentativaFalha, limparTentativas,
} from './security';
import { paginaLogin } from './loginPage';

/**
 * API do backend (roda no VPS). Serve:
 *  - webhook da Evolution (listener de enriquecimento)
 *  - endpoints do dashboard (fila, aprovação/rejeição manual, stats, saúde)
 *  - health check
 *  - WebSocket para atualização em tempo real
 * Só a API é exposta (via Traefik, no domínio API_DOMAIN).
 */

const app = express();
app.use(express.json({ limit: '2mb' }));

/**
 * Proteção OPCIONAL do painel (HTTP Basic) — decisão do dono: fica ABERTO por
 * padrão (uso pessoal). Se DASHBOARD_USER e DASHBOARD_PASSWORD forem definidos,
 * a senha passa a ser exigida sem mexer no código. Livres de senha sempre:
 * /health (monitoramento) e /webhook/* (a Evolution chama sem credencial).
 * Lembrete honesto: o domínio é público (aparece nos logs de Certificate
 * Transparency ao emitir o TLS), então "aberto" = qualquer um que ache a URL.
 */
// Atrás do Traefik: o IP real vem no X-Forwarded-For.
app.set('trust proxy', true);
app.use(cabecalhosSeguranca);

/** Rotas que NÃO exigem sessão. O webhook tem o próprio segredo (na URL). */
function livre(caminho: string): boolean {
  return (
    caminho === '/health' ||
    caminho === '/login' ||
    caminho === '/api/login' ||
    caminho === '/api/logout' ||
    caminho.startsWith('/webhook/')
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
  if (req.params.token !== (await tokenWebhook())) {
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
    `SELECT id, orig_queue, error, channel_id, status, created_at FROM dlq
      WHERE status='pending_review' ORDER BY created_at DESC LIMIT 100`,
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
  const status = req.body?.status;
  if (!['active', 'paused'].includes(status)) {
    return res.status(400).json({ error: 'status deve ser active ou paused' });
  }
  await query(`UPDATE channels SET status = $1 WHERE id = $2`, [status, req.params.id]);
  if (status !== 'active') await removeDripJob(req.params.id!);
  res.json({ ok: true });
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

/**
 * Painel de página única: as abas são caminhos de verdade (/fila, /conexoes,
 * /config, /falhas). Sem este fallback, abrir a URL da aba direto no navegador
 * dava 404 (reclamação real do dono). /api, /health, /webhook e /ws seguem
 * intactos — só o que NÃO é rota de API cai no index.html.
 */
const ABAS = ['/', '/fila', '/feed', '/conexoes', '/config', '/falhas', '/ciclos'];
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
