import { log } from '../logger';
import { withRetry, HttpError } from '../resilience/retry';
import { withBreaker } from '../resilience/breaker';
import { getEvolutionUrl, getEvolutionKey } from '../settings';

/**
 * Cliente da Evolution API v2 (WhatsApp).
 * Endpoints/campos verificados no código-fonte oficial (EvolutionAPI/evolution-api):
 *  - auth: header `apikey: <KEY>`
 *  - POST /message/sendText/{instance}   body { number, text }
 *  - POST /message/sendMedia/{instance}  body { number, mediatype, media, caption }
 *  - GET  /group/fetchAllGroups/{instance}?getParticipants=false
 *  - GET  /instance/connectionState/{instance}
 *  - POST /webhook/set/{instance}        body { webhook: {...} }
 * Para GRUPO, o campo `number` recebe o JID `...@g.us`.
 */

export class EvolutionClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  private async req(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        apikey: this.apiKey,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) throw new HttpError(res.status, `Evolution ${method} ${path} -> ${res.status}`, json);
    return json;
  }

  /** Envia texto. Retorna o id da mensagem, se disponível. */
  async sendText(instance: string, jid: string, text: string): Promise<string | undefined> {
    return withBreaker(`whatsapp:${instance}`, () =>
      withRetry(
        async () => {
          const r = (await this.req('POST', `/message/sendText/${instance}`, {
            number: jid,
            text,
          })) as { key?: { id?: string } };
          return r.key?.id;
        },
        { label: 'evo-sendText', attempts: 3 },
      ),
    );
  }

  /** Envia imagem com legenda. `media` = URL pública ou base64. */
  async sendMedia(
    instance: string,
    jid: string,
    media: string,
    caption: string,
  ): Promise<string | undefined> {
    return withBreaker(`whatsapp:${instance}`, () =>
      withRetry(
        async () => {
          const r = (await this.req('POST', `/message/sendMedia/${instance}`, {
            number: jid,
            mediatype: 'image',
            media,
            caption,
          })) as { key?: { id?: string } };
          return r.key?.id;
        },
        { label: 'evo-sendMedia', attempts: 3 },
      ),
    );
  }

  /** Cria uma instância (número) na Evolution. qrcode=true já prepara o QR. */
  async createInstance(instance: string): Promise<unknown> {
    return this.req('POST', '/instance/create', {
      instanceName: instance,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
    });
  }

  /** Conecta e retorna o QR (base64) / pairing code para escanear no celular. */
  async connect(instance: string): Promise<{ base64?: string; code?: string; pairingCode?: string }> {
    const r = (await this.req('GET', `/instance/connect/${instance}`)) as {
      base64?: string;
      code?: string;
      pairingCode?: string;
    };
    return { base64: r.base64, code: r.code, pairingCode: r.pairingCode };
  }

  /** Aplica as settings de comportamento da instância (POST /settings/set/{instance}). */
  async setInstanceSettings(instance: string, settings: Record<string, unknown>): Promise<void> {
    await this.req('POST', `/settings/set/${instance}`, settings);
  }

  async connectionState(instance: string): Promise<string> {
    const r = (await this.req('GET', `/instance/connectionState/${instance}`)) as {
      instance?: { state?: string };
    };
    return r.instance?.state ?? 'unknown';
  }

  /**
   * Todas as instâncias da Evolution, com estado da conexão e número do dono.
   * `GET /instance/fetchInstances` devolve um array cru; o formato dos campos
   * varia entre versões, então quem chama lê com tolerância (name/instanceName,
   * connectionStatus/state, ownerJid/owner).
   */
  async fetchInstances(): Promise<Array<Record<string, unknown>>> {
    const r = (await this.req('GET', '/instance/fetchInstances')) as
      | Array<Record<string, unknown>>
      | { instances?: Array<Record<string, unknown>> };
    if (Array.isArray(r)) return r;
    return r.instances ?? [];
  }

  async fetchAllGroups(instance: string): Promise<Array<{ id: string; subject: string }>> {
    const r = (await this.req(
      'GET',
      `/group/fetchAllGroups/${instance}?getParticipants=false`,
    )) as Array<{ id: string; subject: string }> | { groups?: Array<{ id: string; subject: string }> };
    if (Array.isArray(r)) return r;
    return r.groups ?? [];
  }

  async setWebhook(instance: string, url: string, events: string[]): Promise<void> {
    await this.req('POST', `/webhook/set/${instance}`, {
      webhook: { enabled: true, url, byEvents: false, base64: false, events },
    });
  }

  /* ==================== GRUPOS ====================
   * Endpoints e formatos verificados contra o código-fonte oficial
   * (evolution-foundation/evolution-api, main = 2.3.7; `group.router.ts`,
   * `group.dto.ts`, `group.schema.ts`). Diff de 2.2.0 até 2.3.7 é ZERO nesses
   * três arquivos, então o contrato é estável na faixa que interessa.
   */

  /**
   * Cria um grupo. Devolve o JID em `id` (a resposta é o `groupMetadata` cru
   * do Baileys, não filtrado).
   *
   * `participants` é OBRIGATÓRIO com no mínimo 1 item — `createGroupSchema` tem
   * `minItems: 1`, então lista vazia é recusada com 400 ANTES de chegar no
   * controller. Não existe "criar grupo só meu" pela API; é preciso semear com
   * ao menos um número. Formato exigido: strings só de dígitos, mínimo 10
   * (`pattern: '\\d+'`), sem sufixo `@s.whatsapp.net`.
   *
   * Armadilha do lado do servidor: antes de criar, a Evolution filtra os
   * participantes por existência real no WhatsApp (`whatsappNumber()` →
   * `filter(p => p.exists)`). Número que não existe é descartado em SILÊNCIO, e
   * a criação segue com a lista reduzida — possivelmente vazia. Por isso a rota
   * que chama isto compara quantos participantes voltaram com quantos foram
   * pedidos e avisa a diferença.
   */
  async createGroup(
    instance: string,
    subject: string,
    participants: string[],
    description?: string,
  ): Promise<{ id: string; subject?: string; participants?: unknown[] }> {
    const r = (await this.req('POST', `/group/create/${instance}`, {
      subject,
      participants,
      ...(description ? { description } : {}),
    })) as { id?: string; subject?: string; participants?: unknown[]; groupJid?: string };
    const id = r.id ?? r.groupJid;
    if (!id) throw new Error('Evolution criou o grupo mas não devolveu o id');
    return { id, subject: r.subject, participants: r.participants };
  }

  /**
   * Link de convite. A Evolution já monta a URL completa a partir do código
   * cru do Baileys, e devolve os dois (`inviteUrl` e `inviteCode`).
   */
  async groupInviteCode(
    instance: string,
    groupJid: string,
  ): Promise<{ inviteUrl?: string; inviteCode?: string }> {
    return (await this.req(
      'GET',
      `/group/inviteCode/${instance}?groupJid=${encodeURIComponent(groupJid)}`,
    )) as { inviteUrl?: string; inviteCode?: string };
  }

  /**
   * `announcement` = só ADMIN manda mensagem (o modo certo para um grupo de
   * ofertas). `locked` é outra coisa: só admin edita nome/foto/descrição — os
   * dois são independentes e fáceis de confundir.
   */
  async updateGroupSetting(
    instance: string,
    groupJid: string,
    action: 'announcement' | 'not_announcement' | 'locked' | 'unlocked',
  ): Promise<void> {
    await this.req('POST', `/group/updateSetting/${instance}`, { groupJid, action });
  }

  async updateGroupDescription(instance: string, groupJid: string, description: string): Promise<void> {
    await this.req('POST', `/group/updateGroupDescription/${instance}`, { groupJid, description });
  }
}

/**
 * Config padrão de uma instância "focada em grupos": rejeita chamadas, não
 * sincroniza histórico, não fica marcando leitura/online. `groupsIgnore=false`
 * = NÃO ignora grupos (é onde queremos atuar). (Campos a confirmar por versão.)
 */
export const GROUPS_INSTANCE_SETTINGS: Record<string, unknown> = {
  rejectCall: true, // rejeita chamadas (número de bot)
  msgCall: '',
  groupsIgnore: false, // false = RECEBE grupos (confirmado no código-fonte)
  alwaysOnline: true, // mantém o número reachable p/ postar
  readMessages: false,
  readStatus: false,
  syncFullHistory: false, // não sincroniza histórico (mais leve/discreto)
};

let client: EvolutionClient | null = null;
let clientKey = '';

/**
 * Retorna o cliente Evolution (URL+key vindos da interface/settings, com fallback
 * pro .env) ou null se não configurado. Reconstrói se as credenciais mudarem.
 */
export async function getEvolution(): Promise<EvolutionClient | null> {
  const url = await getEvolutionUrl();
  const key = await getEvolutionKey();
  if (!url || !key) return null;
  const cacheKey = `${url}|${key}`;
  if (!client || clientKey !== cacheKey) {
    client = new EvolutionClient(url.replace(/\/$/, ''), key);
    clientKey = cacheKey;
    log.info('Evolution client (re)inicializado');
  }
  return client;
}
