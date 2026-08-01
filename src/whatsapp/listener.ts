import { log } from '../logger';
import { ingestPost } from '../intel/ingest';

/**
 * Listener READ-ONLY de grupos de WhatsApp (número B) — inteligência de mercado.
 *
 * O que ele faz é traduzir o payload da Evolution e entregar para a ingestão de
 * inteligência (`intel/ingest`), que é quem limpa PII, extrai preço/título/links
 * e grava em `intel_posts`.
 *
 * POR QUE mudou (antes gravava direto em `raw_captures`): aquela gravação era
 * armazenamento morto — nada no sistema lia `raw_captures` de grupo, o texto ia
 * sem limpeza de PII, e o "limpar feed" do painel apagava tudo junto (o DELETE
 * remove raw_captures sem oferta associada). Agora o mesmo evento alimenta a
 * tabela que o dashboard de correlação realmente consulta.
 *
 * LGPD: `participant` e `pushName` (telefone e nome de quem postou) existem no
 * payload e são DELIBERADAMENTE ignorados aqui — não são lidos, não são
 * passados adiante. Só o conteúdo da oferta interessa.
 */

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

/** Mantida exportada: é usada em teste e por quem precisa só das URLs. */
export function extractUrls(text: string): string[] {
  return [...new Set(text.match(URL_RE) ?? [])];
}

/** O conteúdo pode vir aninhado; ver `desembrulhar`. */
interface Conteudo {
  conversation?: string;
  extendedTextMessage?: { text?: string };
  imageMessage?: { caption?: string };
  videoMessage?: { caption?: string };
  documentWithCaptionMessage?: { message?: Conteudo };
  ephemeralMessage?: { message?: Conteudo };
  viewOnceMessage?: { message?: Conteudo };
  viewOnceMessageV2?: { message?: Conteudo };
}

interface UpsertMessage {
  event?: string;
  instance?: string;
  data?: {
    key?: { remoteJid?: string; fromMe?: boolean; id?: string };
    messageTimestamp?: number | string;
    message?: Conteudo;
  };
}

/**
 * Desembrulha os envelopes do WhatsApp até chegar no conteúdo de verdade.
 *
 * POR QUE isto importa: grupo com **mensagens temporárias** ligadas (comum em
 * grupo de promoção) envelopa TODAS as mensagens em `ephemeralMessage`. Sem
 * desembrulhar, o texto sai vazio, o listener descarta em silêncio, e o grupo
 * inteiro aparece com 0 posts no painel — levando à conclusão "esse grupo está
 * mudo" quando ele posta o dia todo. Mesma coisa para "ver uma vez" e para
 * documento com legenda.
 */
function desembrulhar(m: Conteudo | undefined, nivel = 0): Conteudo | undefined {
  if (!m || nivel > 4) return m; // trava de profundidade: payload é externo
  const dentro =
    m.ephemeralMessage?.message ??
    m.viewOnceMessage?.message ??
    m.viewOnceMessageV2?.message ??
    m.documentWithCaptionMessage?.message;
  return dentro ? desembrulhar(dentro, nivel + 1) : m;
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

  const m = desembrulhar(data.message) ?? {};
  const text =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    '';
  if (!text.trim()) {
    // Logado, não engolido: sem isto, um formato não suportado faz um grupo
    // inteiro parecer silencioso e ninguém descobre por quê.
    log.debug('mensagem de grupo sem texto aproveitável', {
      grupo: jid.slice(0, 14),
      tipos: Object.keys(m).slice(0, 4),
    });
    return;
  }

  const resultado = await ingestPost({
    groupJid: jid,
    text,
    // A Evolution manda em SEGUNDOS; a ingestão normaliza.
    postedAt: data.messageTimestamp,
    hasImage: m.imageMessage != null,
    instanceRef: p.instance,
    // O id da mensagem é a chave de dedupe correta. Antes ele era declarado na
    // interface e jogado fora, e sobrava o hash do texto — que descartava a
    // republicação semanal da mesma oferta, justamente o sinal de "lista fixa"
    // que este módulo existe para medir.
    waMessageId: data.key.id,
  });

  if (!resultado.ok) {
    log.debug('post de grupo não gravado', { motivo: resultado.reason });
  }
}
