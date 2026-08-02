import { getRedis } from './redis';
import { log } from './logger';

/**
 * CACHE DE LEITURA LENTA, no Redis.
 *
 * Existe por um problema medido: listar os grupos de um número chama
 * `GET /group/fetchAllGroups` na Evolution, que percorre a lista inteira no
 * WhatsApp. Com 23 grupos num número isso leva vários segundos, e a tela
 * "Adicionar um grupo para observar" ficava parada em "carregando seus
 * números…" TODA vez que era aberta — para responder uma pergunta cuja resposta
 * praticamente não muda entre uma abertura e outra.
 *
 * Regras que este módulo segue de propósito:
 *
 * 1. **Falhar em silêncio, nunca derrubar.** Se o Redis estiver fora, `ler`
 *    devolve null e a chamada segue direto para a origem. Cache é otimização;
 *    transformar a ausência dele em erro trocaria "lento" por "quebrado".
 * 2. **Nunca guardar erro.** Só entra no cache o que veio bem — senão uma falha
 *    momentânea da Evolution ficaria congelada pelo TTL inteiro.
 * 3. **Sempre dá para forçar.** Toda tela que usa cache tem um "atualizar" que
 *    passa por cima; sem isso o usuário fica preso a um dado velho sem saída.
 */

/** Prazo curto: a lista de grupos muda quando o dono entra/sai de um grupo. */
export const TTL_GRUPOS = 300; // 5 min

/**
 * Teto para QUALQUER operação de cache.
 *
 * Sem isto, cache vira ponto único de falha em vez de otimização: o ioredis
 * reconecta indefinidamente, então com o Redis fora do ar uma leitura de cache
 * NUNCA resolve e a requisição inteira pendura — o oposto de "cache deixa mais
 * rápido". Descoberto no teste de criar grupo, que roda sem Redis de propósito:
 * a rota respondia em milissegundos e passou a nunca responder.
 *
 * 800ms é folgado para um Redis na mesma rede e curto o bastante para que
 * cair de volta na origem seja imperceptível.
 */
const PRAZO_MS = 800;

/** Devolve o padrão se a operação não responder a tempo — nunca pendura. */
async function comPrazo<T>(tarefa: Promise<T>, padrao: T, oque: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise<T>((r) => { timer = setTimeout(() => r(padrao), PRAZO_MS); });
  try {
    return await Promise.race([tarefa, prazo]);
  } catch (err) {
    log.debug('cache falhou', { oque, err: String(err) });
    return padrao;
  } finally {
    if (timer) clearTimeout(timer);
    // A promessa perdedora não pode virar unhandledRejection e derrubar o processo.
    tarefa.catch(() => {});
  }
}

export async function lerCache<T>(chave: string): Promise<T | null> {
  const bruto = await comPrazo(getRedis().get(`cache:${chave}`), null, `ler ${chave}`);
  if (!bruto) return null;
  try {
    return JSON.parse(bruto) as T;
  } catch {
    return null; // valor corrompido é o mesmo que ausente
  }
}

export async function gravarCache(chave: string, valor: unknown, ttlSeg: number): Promise<void> {
  await comPrazo(
    getRedis().set(`cache:${chave}`, JSON.stringify(valor), 'EX', ttlSeg),
    null,
    `gravar ${chave}`,
  );
}

export async function limparCache(prefixo: string): Promise<number> {
  return comPrazo(varrerEApagar(prefixo), 0, `limpar ${prefixo}`);
}

async function varrerEApagar(prefixo: string): Promise<number> {
  try {
    /*
     * SCAN, não KEYS: `KEYS` percorre o banco inteiro bloqueando o Redis, e
     * este Redis também é a fila do gotejamento — travar ele para limpar cache
     * seria trocar um problema de interface por um de entrega.
     */
    const redis = getRedis();
    let cursor = '0';
    let apagadas = 0;
    do {
      const [prox, chaves] = await redis.scan(cursor, 'MATCH', `cache:${prefixo}*`, 'COUNT', 200);
      cursor = prox;
      if (chaves.length) apagadas += await redis.del(...chaves);
    } while (cursor !== '0');
    return apagadas;
  } catch (err) {
    log.debug('cache indisponível na limpeza', { prefixo, err: String(err) });
    return 0;
  }
}

/**
 * Lê do cache ou busca na origem e guarda.
 *
 * `forcar` existe para o botão "atualizar": ele pula a leitura mas AINDA grava
 * o resultado, para o próximo acesso já vir rápido.
 */
export async function comCache<T>(
  chave: string,
  ttlSeg: number,
  buscar: () => Promise<T>,
  forcar = false,
): Promise<{ valor: T; doCache: boolean }> {
  if (!forcar) {
    const guardado = await lerCache<T>(chave);
    if (guardado !== null) return { valor: guardado, doCache: true };
  }
  const valor = await buscar();
  await gravarCache(chave, valor, ttlSeg);
  return { valor, doCache: false };
}
