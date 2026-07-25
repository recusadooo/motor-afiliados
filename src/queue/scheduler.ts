import { Worker, DelayedError, type Job } from 'bullmq';
import type { ChannelRow, OfferRow } from '../types';
import { makeRedis } from '../redis';
import { query, queryOne, tx } from '../db';
import { log } from '../logger';
import { randInt } from '../util';
import { postOfferToGroup } from '../whatsapp/poster';
import { QUEUE_DRIP, getDripQueue, type DripJobData } from './queues';
import { loadConfig } from '../config';

const MAX_SEND_ATTEMPTS = 3;

/* ---------- helpers de tempo (tz-aware, sem libs) ---------- */

function localSecondsSinceMidnight(tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  let h = get('hour');
  if (h === 24) h = 0; // Intl às vezes emite 24 para meia-noite
  return h * 3600 + get('minute') * 60 + get('second');
}

function timeStrToSec(t: string): number {
  const [h = '0', m = '0', s = '0'] = t.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function inQuiet(cur: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

function msUntilSec(tz: string, targetSec: number): number {
  const cur = localSecondsSinceMidnight(tz);
  let d = targetSec - cur;
  if (d <= 0) d += 86400;
  return d * 1000;
}

/* ---------- acesso a dados ---------- */

async function loadChannel(id: string): Promise<ChannelRow | null> {
  return queryOne<ChannelRow>(`SELECT * FROM channels WHERE id = $1`, [id]);
}

async function activePosterChannels(): Promise<ChannelRow[]> {
  return query<ChannelRow>(
    `SELECT * FROM channels WHERE role = 'poster' AND status = 'active'`,
  );
}

async function sentTodayCount(channelId: string, tz: string): Promise<number> {
  const row = await queryOne<{ c: string }>(
    `SELECT count(*)::text AS c FROM send_logs
      WHERE channel_id = $1 AND status = 'sent'
        AND sent_at >= (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2)`,
    [channelId, tz],
  );
  return row ? Number(row.c) : 0;
}

async function setNextRun(channelId: string, ms: number): Promise<void> {
  await query(
    `INSERT INTO schedules (channel_id, next_run_at, last_run_at, state)
     VALUES ($1, now() + ($2 || ' milliseconds')::interval, now(), 'pending')
     ON CONFLICT (channel_id)
     DO UPDATE SET next_run_at = EXCLUDED.next_run_at, last_run_at = now(), updated_at = now()`,
    [channelId, String(Math.round(ms))],
  );
}

/* ---------- envio de uma oferta ---------- */

async function dispatchOne(channel: ChannelRow): Promise<boolean> {
  const claimed = await tx(async (c) => {
    const r = await c.query<OfferRow & { attempt?: number }>(
      `SELECT o.* FROM offers o
        WHERE o.status = 'approved'
          AND NOT EXISTS (
            SELECT 1 FROM send_logs s
             WHERE s.channel_id = $1 AND s.offer_dedup_key = o.dedup_key
               AND (s.status IN ('sent','claimed') OR s.attempt >= $2))
        ORDER BY o.is_priority DESC, o.priority DESC, o.created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [channel.id, MAX_SEND_ATTEMPTS],
    );
    const offer = r.rows[0];
    if (!offer) return null;
    const cl = await c.query<{ attempt: number }>(
      `INSERT INTO send_logs (offer_id, channel_id, offer_dedup_key, status, attempt)
       VALUES ($1, $2, $3, 'claimed', 1)
       ON CONFLICT (channel_id, offer_dedup_key)
       DO UPDATE SET status = 'claimed', attempt = send_logs.attempt + 1, claimed_at = now()
       RETURNING attempt`,
      [offer.id, channel.id, offer.dedup_key],
    );
    // NÃO muda offers.status aqui: a mesma oferta vai para VÁRIOS canais/grupos.
    // O controle "já enviei" é por canal (send_logs). O status global só vira
    // 'sent' quando TODOS os canais ativos receberam (ver após o envio).
    return { offer, attempt: cl.rows[0]?.attempt ?? 1 };
  });

  if (!claimed) return false;
  const { offer, attempt } = claimed;

  try {
    const messageId = await postOfferToGroup(channel, offer);
    await query(
      `UPDATE send_logs SET status='sent', platform_message_id=$1, sent_at=now()
        WHERE channel_id=$2 AND offer_dedup_key=$3`,
      [messageId ?? null, channel.id, offer.dedup_key],
    );
    // Marca a oferta como 'sent' SÓ quando todos os canais poster ATIVOS já a receberam.
    await query(
      `UPDATE offers o SET status='sent'
        WHERE o.id=$1 AND o.status='approved'
          AND NOT EXISTS (
            SELECT 1 FROM channels ch
             WHERE ch.role='poster' AND ch.status='active'
               AND NOT EXISTS (
                 SELECT 1 FROM send_logs s
                  WHERE s.channel_id=ch.id AND s.offer_dedup_key=o.dedup_key AND s.status='sent'))`,
      [offer.id],
    );
    log.info('oferta postada', { channelId: channel.id, offerId: offer.id, messageId });
    return true;
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const permanent = attempt >= MAX_SEND_ATTEMPTS;
    await query(
      `UPDATE send_logs SET status='failed', error_detail=$1 WHERE channel_id=$2 AND offer_dedup_key=$3`,
      [msg, channel.id, offer.dedup_key],
    );
    // Falha é POR CANAL — não mexe no status global da oferta (outros grupos seguem).
    // No máx. de tentativas, manda pra DLQ só o par oferta+canal.
    if (permanent) {
      await query(
        `INSERT INTO dlq (orig_queue, payload, error, channel_id) VALUES ('drip', $1, $2, $3)`,
        [JSON.stringify({ offerId: offer.id, channelId: channel.id }), msg, channel.id],
      );
    }
    log.error('envio falhou', { channelId: channel.id, offerId: offer.id, attempt, err: msg });
    return false;
  }
}

/* ---------- worker de gotejamento (self-rescheduling) ---------- */

async function tick(job: Job<DripJobData>, token: string): Promise<void> {
  const channelId = job.data.channelId;
  const reschedule = async (ms: number): Promise<never> => {
    await setNextRun(channelId, ms);
    await job.moveToDelayed(Date.now() + ms, token);
    throw new DelayedError();
  };

  const channel = await loadChannel(channelId);
  if (!channel || channel.status !== 'active') return reschedule(5 * 60 * 1000);

  const nowSec = localSecondsSinceMidnight(channel.timezone);
  const qStart = timeStrToSec(channel.quiet_start);
  const qEnd = timeStrToSec(channel.quiet_end);
  if (inQuiet(nowSec, qStart, qEnd)) {
    log.debug('janela de silêncio', { channelId });
    return reschedule(msUntilSec(channel.timezone, qEnd) + 1000);
  }

  const sentToday = await sentTodayCount(channelId, channel.timezone);
  if (sentToday >= channel.daily_cap) {
    log.info('teto diário atingido', { channelId, sentToday, cap: channel.daily_cap });
    return reschedule(msUntilSec(channel.timezone, 0) + 60_000); // próxima meia-noite local
  }

  let sent = false;
  try {
    sent = await dispatchOne(channel);
  } catch (err) {
    log.error('erro no dispatch', {
      channelId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (sent) {
    const base = randInt(channel.drip_min_sec, channel.drip_max_sec);
    const jitter = randInt(channel.jitter_min_sec, channel.jitter_max_sec);
    return reschedule((base + jitter) * 1000);
  }
  // nada elegível agora — checa de novo em 60s
  return reschedule(60_000);
}

export function startDripWorker(): Worker<DripJobData> {
  const worker = new Worker<DripJobData>(QUEUE_DRIP, (job, token) => tick(job, token!), {
    connection: makeRedis(),
    concurrency: 4,
  });
  worker.on('error', (err) => log.error('drip worker error', { err: String(err) }));
  return worker;
}

/** Garante exatamente um job de gotejamento por canal poster ativo. */
export async function ensureDripJobs(): Promise<number> {
  const channels = await activePosterChannels();
  const q = getDripQueue();
  for (const ch of channels) {
    await q.add(
      'tick',
      { channelId: ch.id },
      { jobId: `drip-${ch.id}`, removeOnComplete: true, removeOnFail: { age: 24 * 3600 } },
    );
  }
  log.info('drip jobs garantidos', { channels: channels.length });
  return channels.length;
}

/** Remove o job de gotejamento de um canal (ao pausar/remover). */
export async function removeDripJob(channelId: string): Promise<void> {
  const job = await getDripQueue().getJob(`drip-${channelId}`);
  if (job) await job.remove().catch(() => {});
}

/**
 * Fura-fila: quando surge oferta prioritária, antecipa o próximo disparo para
 * `minGap` (respeitando o gap mínimo), sem virar rajada. Usa schedules.next_run_at
 * (nossa fonte de verdade) para só ANTECIPAR, nunca atrasar.
 */
export async function nudgePriority(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.PRIORITY_INTERRUPT_WAIT) return;
  const minGapMs = cfg.PRIORITY_MIN_GAP_SECONDS * 1000;
  const q = getDripQueue();
  for (const ch of await activePosterChannels()) {
    const sched = await queryOne<{ next_run_at: string | null }>(
      `SELECT next_run_at FROM schedules WHERE channel_id = $1`,
      [ch.id],
    );
    if (!sched?.next_run_at) continue;
    const remaining = new Date(sched.next_run_at).getTime() - Date.now();
    if (remaining <= minGapMs) continue; // já vai disparar em breve
    const job = await q.getJob(`drip-${ch.id}`);
    if (!job) continue;
    try {
      if ((await job.getState()) === 'delayed') {
        await job.changeDelay(minGapMs);
        await setNextRun(ch.id, minGapMs);
        log.info('fura-fila: antecipando disparo', { channelId: ch.id, minGapMs });
      }
    } catch (err) {
      log.warn('nudgePriority falhou', { channelId: ch.id, err: String(err) });
    }
  }
}
