import { loadConfig } from '../config';
import { log } from '../logger';

/**
 * Limitador de taxa das chamadas à Shopee — ponto ÚNICO por onde toda requisição
 * passa (captura, generateShortLink, comandos CLI).
 *
 * POR QUÊ: um ciclo descontrolado fez ~1.440 consultas + ~650 gerações de link
 * curto em 10 minutos. A conta de afiliado é o único ponto de monetização e o
 * ativo mais frágil do projeto; a Open API tem limite de taxa (erro 10030) e o
 * critério de "uso anormal" do programa não é público. Então o app impõe seu
 * próprio teto, conservador:
 *   - espaçamento mínimo entre requisições (nada de rajada);
 *   - teto por minuto;
 *   - teto por dia — ao bater, ERRA em vez de continuar (freio de mão).
 *
 * Serializado de propósito: as requisições saem uma a uma, em fila, no ritmo
 * configurado. Perde paralelismo e ganha previsibilidade — o que importa aqui.
 */

let cadeia: Promise<void> = Promise.resolve();
let ultimoEnvio = 0;
const janelaMinuto: number[] = [];
let diaAtual = '';
let usadoNoDia = 0;

function hojeUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Uso atual — exposto para o painel/diagnóstico. */
export function shopeeUsage(): { dia: string; usadoNoDia: number; ultimoMinuto: number } {
  const agora = Date.now();
  return {
    dia: diaAtual,
    usadoNoDia,
    ultimoMinuto: janelaMinuto.filter((t) => agora - t < 60_000).length,
  };
}

const dorme = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Reserva uma vaga para UMA requisição. Retorna quando pode enviar.
 * Lança se o teto diário foi atingido.
 */
export async function reservarVaga(): Promise<void> {
  const cfg = loadConfig();
  const anterior = cadeia;
  let liberar!: () => void;
  cadeia = new Promise<void>((r) => (liberar = r));
  await anterior;

  try {
    const dia = hojeUTC();
    if (dia !== diaAtual) {
      diaAtual = dia;
      usadoNoDia = 0;
    }
    if (cfg.SHOPEE_MAX_PER_DAY > 0 && usadoNoDia >= cfg.SHOPEE_MAX_PER_DAY) {
      throw new Error(
        `freio de segurança: teto diário de chamadas à Shopee atingido (${usadoNoDia}/${cfg.SHOPEE_MAX_PER_DAY}). Ajuste SHOPEE_MAX_PER_DAY se for intencional.`,
      );
    }

    // teto por minuto — espera a janela abrir
    if (cfg.SHOPEE_MAX_PER_MIN > 0) {
      for (;;) {
        const agora = Date.now();
        while (janelaMinuto.length && agora - janelaMinuto[0]! >= 60_000) janelaMinuto.shift();
        if (janelaMinuto.length < cfg.SHOPEE_MAX_PER_MIN) break;
        const esperar = 60_000 - (agora - janelaMinuto[0]!) + 50;
        log.warn('teto por minuto da Shopee atingido — aguardando', { ms: esperar });
        await dorme(esperar);
      }
    }

    // espaçamento mínimo entre requisições
    const desdeUltimo = Date.now() - ultimoEnvio;
    if (desdeUltimo < cfg.SHOPEE_MIN_INTERVAL_MS) {
      await dorme(cfg.SHOPEE_MIN_INTERVAL_MS - desdeUltimo);
    }

    ultimoEnvio = Date.now();
    janelaMinuto.push(ultimoEnvio);
    usadoNoDia += 1;
  } finally {
    liberar();
  }
}

/** Só para teste: zera o estado interno. */
export function __resetThrottle(): void {
  cadeia = Promise.resolve();
  ultimoEnvio = 0;
  janelaMinuto.length = 0;
  diaAtual = '';
  usadoNoDia = 0;
}
