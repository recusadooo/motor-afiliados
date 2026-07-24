import { loadConfig } from '../config';
import { log } from '../logger';
import { withRetry, HttpError } from '../resilience/retry';
import { getOpenAiKey, getCopyModel, getModerationModel } from '../settings';

/**
 * Adapter da OpenAI. Structured Outputs (json_schema strict) + Moderation.
 * Shapes verificados em platform.openai.com/docs.
 *
 * NOTA: o id 'gpt-5.4-mini' aparece no host oficial mas não foi 100% confirmado.
 * Por isso: model configurável (COPY_MODEL) + fallback documentado em model_not_found.
 */

export class AiUnavailableError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'AiUnavailableError';
  }
}

// Fallbacks documentados (IDs mais estabelecidos) caso COPY_MODEL não exista.
const MODEL_FALLBACKS = ['gpt-4.1-mini', 'gpt-4o-mini'];

interface OpenAIError {
  error?: { message?: string; code?: string; type?: string };
}

function isModelNotFound(status: number, body: unknown): boolean {
  if (status !== 404 && status !== 400) return false;
  const code = (body as OpenAIError)?.error?.code;
  const msg = (body as OpenAIError)?.error?.message ?? '';
  return code === 'model_not_found' || /model/i.test(msg) && /not (found|exist)/i.test(msg);
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const cfg = loadConfig();
  const apiKey = await getOpenAiKey();
  if (!apiKey) throw new AiUnavailableError('Chave OpenAI ausente (defina na interface ou no .env)');
  const res = await fetch(`${cfg.OPENAI_API_ENDPOINT}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new HttpError(res.status, `OpenAI ${res.status}`, json);
  return json;
}

interface ChatChoice {
  message?: { content?: string };
}
interface ChatResponse {
  choices?: ChatChoice[];
}

/**
 * Chama Chat Completions com Structured Outputs (json_schema strict) e devolve
 * o objeto parseado. Faz fallback de modelo em model_not_found.
 */
export async function chatJson<T>(
  schemaName: string,
  schema: Record<string, unknown>,
  systemPrompt: string,
  userPrompt: string,
): Promise<T> {
  const primaryModel = await getCopyModel();
  const models = [primaryModel, ...MODEL_FALLBACKS];

  let lastErr: unknown;
  for (const model of models) {
    try {
      const json = (await withRetry(
        () =>
          postJson('/chat/completions', {
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: { name: schemaName, strict: true, schema },
            },
          }),
        { label: 'openai-chat', attempts: 3 },
      )) as ChatResponse;
      const content = json.choices?.[0]?.message?.content;
      if (!content) throw new AiUnavailableError('OpenAI: resposta sem content');
      if (model !== primaryModel) {
        log.warn('openai usando modelo fallback', { requested: primaryModel, used: model });
      }
      return JSON.parse(content) as T;
    } catch (err) {
      lastErr = err;
      if (err instanceof HttpError && isModelNotFound(err.status, err.body)) {
        log.warn('openai model_not_found, tentando fallback', { model });
        continue; // tenta o próximo modelo
      }
      throw err; // outros erros não são resolvidos trocando modelo
    }
  }
  throw lastErr instanceof Error ? lastErr : new AiUnavailableError('OpenAI indisponível');
}

interface ModerationResult {
  flagged: boolean;
  categories: Record<string, boolean>;
}
interface ModerationResponse {
  results?: ModerationResult[];
}

/** Moderação (omni-moderation-latest). Retorna null se a IA estiver indisponível. */
export async function moderate(text: string): Promise<ModerationResult | null> {
  const key = await getOpenAiKey();
  if (!key) return null;
  try {
    const model = await getModerationModel();
    const json = (await withRetry(
      () => postJson('/moderations', { model, input: text }),
      { label: 'openai-moderation', attempts: 2 },
    )) as ModerationResponse;
    return json.results?.[0] ?? null;
  } catch (err) {
    log.warn('moderação falhou', { err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
