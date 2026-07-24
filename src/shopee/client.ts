import { createHash } from 'node:crypto';
import { loadConfig } from '../config';
import { log } from '../logger';
import { withRetry, HttpError } from '../resilience/retry';

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
  const ts = Math.floor(Date.now() / 1000);
  const signature = sign(cfg.SHOPEE_APP_ID, ts, payload, cfg.SHOPEE_APP_SECRET);
  const authorization = `SHA256 Credential=${cfg.SHOPEE_APP_ID}, Timestamp=${ts}, Signature=${signature}`;

  return withRetry(
    async () => {
      const res = await fetch(cfg.SHOPEE_API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authorization },
        body: payload,
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
          // Trata como 429 para o backoff do withRetry cuidar.
          throw new HttpError(429, `Shopee rate limit (10030): ${first.message}`);
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
