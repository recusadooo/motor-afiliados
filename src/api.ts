import path from 'node:path';
import express, { type Request, type Response } from 'express';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config';
import { log } from './logger';
import { query, queryOne, tx } from './db';
import { handleEvolutionWebhook } from './whatsapp/listener';
import { breakerState } from './resilience/breaker';
import { removeDripJob } from './queue/scheduler';
import { getEvolution, GROUPS_INSTANCE_SETTINGS } from './whatsapp/evolution';
import { settingsStatus, setSetting, SETTING_KEYS } from './settings';

/**
 * API do backend (roda no VPS). Serve:
 *  - webhook da Evolution (listener de enriquecimento)
 *  - endpoints do dashboard (fila, aprovação/rejeição manual, stats, saúde)
 *  - health check
 *  - WebSocket para atualização em tempo real
 * Só a API é exposta (via Caddy). O dashboard (Next.js) é uma app separada.
 */

const app = express();
app.use(express.json({ limit: '2mb' }));

// Painel de controle (Módulo 4) servido estático pela própria API.
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ---- Webhook da Evolution (mensagens de grupos -> enriquecimento) ----
app.post('/webhook/evolution', async (req: Request, res: Response) => {
  res.status(200).json({ ok: true }); // responde rápido; processa depois
  try {
    await handleEvolutionWebhook(req.body);
  } catch (err) {
    log.error('webhook falhou', { err: err instanceof Error ? err.message : String(err) });
  }
});

// ---- Fila de ofertas (dashboard) ----
app.get('/api/offers', async (req: Request, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'approved';
  const rows = await query(
    `SELECT id, title, price, discount_pct, savings_brl, commission_rate, image_url,
            rewritten_copy, affiliate_url, is_priority, status, reject_reason, created_at
       FROM offers WHERE status = $1
       ORDER BY is_priority DESC, priority DESC, created_at DESC LIMIT 100`,
    [status],
  );
  res.json(rows);
});

app.post('/api/offers/:id/reject', async (req: Request, res: Response) => {
  await query(`UPDATE offers SET status='rejected', reject_reason='rejeitado manualmente' WHERE id=$1`, [
    req.params.id,
  ]);
  res.json({ ok: true });
});

app.post('/api/offers/:id/approve', async (req: Request, res: Response) => {
  await query(`UPDATE offers SET status='approved' WHERE id=$1 AND status='pending'`, [req.params.id]);
  res.json({ ok: true });
});

// ---- Estatísticas + saúde ----
app.get('/api/stats', async (_req: Request, res: Response) => {
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
});

app.get('/api/dlq', async (_req: Request, res: Response) => {
  const rows = await query(
    `SELECT id, orig_queue, error, channel_id, status, created_at FROM dlq
      WHERE status='pending_review' ORDER BY created_at DESC LIMIT 100`,
  );
  res.json(rows);
});

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
app.post('/api/instances', async (req: Request, res: Response) => {
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
  const cfg = loadConfig();
  if (cfg.PUBLIC_APP_URL) {
    try {
      await evo.setWebhook(name, `${cfg.PUBLIC_APP_URL.replace(/\/$/, '')}/webhook/evolution`, ['MESSAGES_UPSERT']);
      steps.webhook = 'configurado';
    } catch (err) {
      steps.webhook = 'falhou: ' + (err instanceof Error ? err.message : String(err));
    }
  } else {
    steps.webhook = 'pulado (defina PUBLIC_APP_URL para o listener)';
  }
  res.json({ ok: true, instance: name, role, steps });
});

// QR code para escanear (base64 / pairing code).
app.get('/api/instances/:name/qr', async (req: Request, res: Response) => {
  const evo = await evoOr500(res);
  if (!evo) return;
  try {
    res.json(await evo.connect(req.params.name!));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/instances/:name/state', async (req: Request, res: Response) => {
  const evo = await evoOr500(res);
  if (!evo) return;
  try {
    res.json({ state: await evo.connectionState(req.params.name!) });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/instances/:name/groups', async (req: Request, res: Response) => {
  const evo = await evoOr500(res);
  if (!evo) return;
  try {
    const groups = await evo.fetchAllGroups(req.params.name!);
    res.json(groups.map((g) => ({ id: g.id, subject: g.subject })));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Configura o webhook do listener para apontar para este app.
app.post('/api/instances/:name/webhook', async (req: Request, res: Response) => {
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
});

// Lista canais cadastrados.
app.get('/api/channels', async (_req: Request, res: Response) => {
  res.json(
    await query(
      `SELECT id, role, instance_ref, target_ref, display_name, status, daily_cap, sent_today
         FROM channels ORDER BY created_at`,
    ),
  );
});

// Registra um canal (número + grupo + nome).
app.post('/api/channels', async (req: Request, res: Response) => {
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
});

// Registra VÁRIOS grupos de uma vez para o mesmo número (escolher onde disparar).
app.post('/api/channels/bulk', async (req: Request, res: Response) => {
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
});

// Pausar / reativar um canal (liga/desliga o disparo naquele grupo).
app.patch('/api/channels/:id', async (req: Request, res: Response) => {
  const status = req.body?.status;
  if (!['active', 'paused'].includes(status)) {
    return res.status(400).json({ error: 'status deve ser active ou paused' });
  }
  await query(`UPDATE channels SET status = $1 WHERE id = $2`, [status, req.params.id]);
  if (status !== 'active') await removeDripJob(req.params.id!);
  res.json({ ok: true });
});

// Remover um canal (para de disparar naquele grupo e apaga o histórico dele).
app.delete('/api/channels/:id', async (req: Request, res: Response) => {
  const id = req.params.id!;
  await removeDripJob(id);
  await tx(async (c) => {
    await c.query(`DELETE FROM send_logs WHERE channel_id = $1`, [id]);
    await c.query(`DELETE FROM schedules WHERE channel_id = $1`, [id]);
    await c.query(`DELETE FROM channels WHERE id = $1`, [id]);
  });
  res.json({ ok: true });
});

// ---- Configurações (chave OpenAI / modelo) pela interface ----
app.get('/api/settings', async (_req: Request, res: Response) => {
  res.json(await settingsStatus());
});

app.put('/api/settings', async (req: Request, res: Response) => {
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
});

export function startApi(): void {
  const cfg = loadConfig();
  const server = app.listen(cfg.API_PORT, () => {
    log.info('API ouvindo', { port: cfg.API_PORT });
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
