import { query, queryOne } from '../db';
import { log } from '../logger';
import { sha256hex, normalizeText } from '../util';

/**
 * Listener READ-ONLY de grupos de WhatsApp (número B) — inteligência de mercado.
 * Grava apenas o CONTEÚDO da oferta (texto + URLs). NUNCA armazena telefone,
 * @ ou lista de membros (LGPD). NÃO republica ao vivo — é só enriquecimento.
 */

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

export function extractUrls(text: string): string[] {
  return [...new Set(text.match(URL_RE) ?? [])];
}

async function ensureEnrichmentSource(groupJid: string): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO sources (kind, external_ref, name, role)
     VALUES ('whatsapp_group', $1, $2, 'enrichment')
     ON CONFLICT (kind, external_ref) DO UPDATE SET is_active = true
     RETURNING id`,
    [groupJid, `Grupo ${groupJid.slice(0, 12)}`],
  );
  return row!.id;
}

interface UpsertMessage {
  event?: string;
  data?: {
    key?: { remoteJid?: string; fromMe?: boolean; id?: string };
    message?: {
      conversation?: string;
      extendedTextMessage?: { text?: string };
      imageMessage?: { caption?: string };
      videoMessage?: { caption?: string };
    };
  };
}

/** Processa um payload de webhook MESSAGES_UPSERT da Evolution. */
export async function handleEvolutionWebhook(payload: unknown): Promise<void> {
  const p = payload as UpsertMessage;
  // Evento entregue vem em dot-notation: 'messages.upsert'.
  if (p?.event !== 'messages.upsert') return;
  const data = p.data;
  if (!data?.key || data.key.fromMe) return; // ignora mensagens próprias
  const jid = data.key.remoteJid;
  if (!jid || !jid.endsWith('@g.us')) return; // só grupos (não DMs)

  const m = data.message ?? {};
  const text =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    '';
  if (!text.trim()) return;

  const urls = extractUrls(text);
  const sourceId = await ensureEnrichmentSource(jid);
  const hash = sha256hex(normalizeText(text));

  // Só conteúdo da oferta — SEM participant/telefone.
  await query(
    `INSERT INTO raw_captures (source_id, raw_payload, raw_url, content_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source_id, content_hash) DO NOTHING`,
    [sourceId, JSON.stringify({ text, urls }), urls[0] ?? null, hash],
  );
  log.debug('enriquecimento capturado', { group: jid.slice(0, 12), urls: urls.length });
}
