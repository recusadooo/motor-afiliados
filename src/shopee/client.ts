import { createHash } from 'node:crypto';
import { loadConfig } from '../config';
import { log } from '../logger';
import { withRetry, HttpError } from '../resilience/retry';
import { reservarVaga } from './throttle';

/**
 * Cliente da Shopee Affiliate Open API (GraphQL).
 *
 * ESQUEMA DE ASSINATURA CONFIRMADO POR TESTE AO VIVO:
 *   signature = SHA256_hex( appId + timestamp(segundos) + payload + secret )
 *   header    = Authorization: SHA256 Credential=<appId>, Timestamp=<ts>, Signature=<sig>
 *
 * REGRA CRÍTICA: o `payload` assinado deve ser BYTE-A-BYTE idêntico ao corpo do
 * POST. Serializamos UMA vez e reusamos a mesma string na assinatura e no body.
 * Timestamp em SEGUNDOS; o relógio do servidor precisa estar em NTP.
 */

// Códigos de erro conhecidos da Open API.
const ERR = {
  INVALID_SIGNATURE: '10020',
  RATE_LIMIT: '10030',
  ACCOUNT_FROZEN: '10033',
  BLACKLISTED: '10034',
  NO_API_ACCESS: '10035',
} as const;

export class ShopeeApiError extends Error {
  constructor(
    message: string,
    public code?: string,
    public graphqlErrors?: unknown,
  ) {
    super(message);
    this.name = 'ShopeeApiError';
  }
}

/**
 * Erro que significa "a conta de afiliado está em risco" (congelada ou em
 * blacklist). É o pior cenário do projeto — a conta é o único ponto de
 * monetização. Tem classe própria para aparecer como alerta, não como falha
 * genérica de API.
 */
export class ShopeeContaEmRiscoError extends ShopeeApiError {
  constructor(message: string, code: string, errors?: unknown) {
    super(message, code, errors);
    this.name = 'ShopeeContaEmRiscoError';
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string | number } }>;
}

function sign(appId: string, ts: number, payload: string, secret: string): string {
  return createHash('sha256').update(appId + ts + payload + secret).digest('hex');
}

export async function shopeeGraphQL<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const cfg = loadConfig();
  // Serializa UMA vez; a MESMA string vai para a assinatura e para o body.
  const payload = JSON.stringify(variables ? { query, variables } : { query });

  return withRetry(
    async () => {
      // Ponto único de controle de taxa: NENHUMA chamada à Shopee sai daqui sem
      // passar pelo freio (inclui as retentativas — de propósito).
      await reservarVaga();

      // ASSINATURA DENTRO da tentativa, DEPOIS de esperar a vaga.
      // Se fosse calculada fora, uma tentativa que esperou no backoff (até 60s)
      // ou na fila do freio apresentaria timestamp velho -> risco de 10020
      // (assinatura inválida). Assinar aqui é o que torna a espera segura.
      const ts = Math.floor(Date.now() / 1000);
      const signature = sign(cfg.SHOPEE_APP_ID, ts, payload, cfg.SHOPEE_APP_SECRET);
      const authorization = `SHA256 Credential=${cfg.SHOPEE_APP_ID}, Timestamp=${ts}, Signature=${signature}`;

      const res = await fetch(cfg.SHOPEE_API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authorization },
        body: payload,
        // Sem timeout, uma conexão pendurada trava o ciclo de captura inteiro.
        signal: AbortSignal.timeout(cfg.HTTP_TIMEOUT_MS),
      });

      const text = await res.text();
      if (!res.ok) {
        throw new HttpError(res.status, `Shopee HTTP ${res.status}: ${text.slice(0, 300)}`);
      }

      let json: GraphQLResponse<T>;
      try {
        json = JSON.parse(text) as GraphQLResponse<T>;
      } catch {
        throw new ShopeeApiError(`Resposta não-JSON da Shopee: ${text.slice(0, 200)}`);
      }

      if (json.errors && json.errors.length > 0) {
        const first = json.errors[0]!;
        const code = first.extensions?.code != null ? String(first.extensions.code) : undefined;
        if (code === ERR.RATE_LIMIT) {
          // NÃO retentar: com freio de taxa próprio, insistir num rate limit é
          // exatamente o que transforma um aviso em bloqueio. Erra alto para o
          // ciclo parar e o motivo aparecer no painel.
          throw new ShopeeApiError(
            `Shopee 10030: rate limit atingido — o ciclo foi interrompido de propósito. ${first.message}`,
            code,
            json.errors,
          );
        }
        if (code === ERR.ACCOUNT_FROZEN || code === ERR.BLACKLISTED) {
          const oque =
            code === ERR.ACCOUNT_FROZEN ? 'CONTA CONGELADA' : 'AFILIADO EM BLACKLIST';
          log.error(`SHOPEE: ${oque} — PARE E VERIFIQUE A CONTA`, { code, msg: first.message });
          throw new ShopeeContaEmRiscoError(
            `Shopee ${code}: ${oque}. O motor parou de propósito — entre na conta de afiliado e verifique antes de continuar. (${first.message})`,
            code,
            json.errors,
          );
        }
        if (code === ERR.NO_API_ACCESS) {
          throw new ShopeeApiError(
            'Shopee 10035: conta sem acesso à Open API (precisa aprovação).',
            code,
            json.errors,
          );
        }
        if (code === ERR.INVALID_SIGNATURE) {
          throw new ShopeeApiError(
            'Shopee 10020: assinatura inválida (payload/timestamp/clock).',
            code,
            json.errors,
          );
        }
        throw new ShopeeApiError(`Shopee GraphQL: ${first.message}`, code, json.errors);
      }

      if (!json.data) throw new ShopeeApiError('Shopee: resposta sem "data".');
      return json.data;
    },
    { label: 'shopee', attempts: 4 },
  ).catch((err) => {
    log.error('shopee falhou', { err: err instanceof Error ? err.message : String(err) });
    throw err;
  });
}

export { ERR as SHOPEE_ERROR_CODES };
