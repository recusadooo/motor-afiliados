import { query, queryOne } from '../db';
import { log } from '../logger';
import { sha256hex, normalizeText } from '../util';

/**
 * INGESTÃO — porta de entrada do que os grupos de promoção postaram.
 *
 * Duas fontes chamam aqui: o webhook da Evolution (via `whatsapp/listener.ts`)
 * e o fluxo do n8n (via `POST /api/intel/ingest/:token`). As duas entregam o
 * mesmo formato e passam pela mesma limpeza — não existe caminho privilegiado.
 *
 * Três regras governam este arquivo:
 *
 * 1. LGPD — telefone, e-mail e menção NUNCA entram no banco. Este é o último
 *    ponto antes do INSERT, então a limpeza acontece aqui mesmo que a origem
 *    já tenha limpado (o nó do n8n também limpa; camada dupla de propósito).
 *
 * 2. GRUPO NÃO CADASTRADO É RECUSADO. O número de escuta está em vários grupos,
 *    inclusive nos seus. Se aceitássemos tudo que chega, não haveria como
 *    ligar e desligar a observação sem mexer no n8n, e a base encheria de
 *    conversa que não interessa. O cadastro no painel é o interruptor.
 *
 * 3. NA DÚVIDA SOBRE PREÇO, `null`. O matcher trata preço ausente como "sem
 *    evidência" e casa só por título. Um preço ERRADO é muito pior: empurra o
 *    casamento para o produto errado e a análise inteira passa a mentir.
 */

export interface ParsedPost {
  titleGuess: string | null;
  price: number | null;
  priceOld: number | null;
  discountPct: number | null;
  coupon: string | null;
  urls: string[];
  platformGuess: string | null;
}

// ============================================================
// LIMPEZA DE PII
// ============================================================

const RE_EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
const RE_MENCAO = /@[\p{L}\p{N}][\p{L}\p{N}._-]{2,}/gu;

/**
 * Telefone brasileiro. Cada padrão exige ESTRUTURA — é o que separa telefone
 * de preço. Os dois lookarounds `(?<![\d,.])` / `(?![\d,])` impedem que a
 * regex morda o meio de um número maior (1.299,90 tem dígitos colados a
 * pontuação e por isso nunca vira "telefone").
 */
const PADROES_TELEFONE: RegExp[] = [
  // +55 (92) 99456-7318 — o prefixo internacional torna inequívoco
  /\+\s*55[\s.()-]*\d{2}[\s.()-]*9?\d{4}[\s.-]?\d{4}/g,
  // (92) 99456-7318 — o DDD entre parênteses também é inequívoco
  /\(\s*[1-9]\d\s*\)[\s.-]*9?\d{4}[\s.-]?\d{4}/g,
  // 92 99456-7318 — exige DDD válido E separador entre os grupos
  /(?<![\d,.])[1-9]\d[\s.-]+9?\d{4}[\s.-]\d{4}(?![\d,])/g,
  // 5592994567318 / 92994567318 — corrida crua de 10 a 13 dígitos.
  // Mínimo de 10 dígitos de propósito: preço não chega perto (R$ 99999 tem 5,
  // e o maior preço plausível da Shopee tem 7 com centavos).
  /(?<![\d,.])(?:55)?[1-9]\d{9,10}(?![\d,])/g,
];

/** O trecho vem logo depois de um símbolo de moeda? Então é preço, não telefone. */
function pareceMoeda(texto: string, inicio: number): boolean {
  const antes = texto.slice(Math.max(0, inicio - 6), inicio);
  return /R?\$\s*$/i.test(antes);
}

/**
 * Remove dado pessoal do texto. Exportada para ser testada — a regressão que
 * importa aqui é o FALSO-POSITIVO: se um preço virar `[tel]`, o parser de
 * preço para de funcionar em silêncio e a correlação degrada sem avisar.
 */
export function scrubPII(texto: string): string {
  let t = texto.replace(RE_EMAIL, '[email]');
  for (const re of PADROES_TELEFONE) {
    t = t.replace(re, (achado, ...resto) => {
      const inicio = resto[resto.length - 2] as number;
      const original = resto[resto.length - 1] as string;
      return pareceMoeda(original, inicio) ? achado : '[tel]';
    });
  }
  // Menção por último: o e-mail já saiu, então todo '@' restante é menção.
  return t.replace(RE_MENCAO, '[mencao]');
}

// ============================================================
// PREÇO
// ============================================================

/**
 * Moeda em pt-BR. `toNum` do projeto NÃO serve aqui: ele trata vírgula como
 * separador de MILHAR (é o formato que a Shopee devolve), e "39,90" viraria
 * 3990. Aqui a vírgula é decimal.
 */
export function parseMoedaBR(s: string): number | null {
  if (!s) return null;
  const cru = String(s).replace(/[^\d.,]/g, '');
  if (!cru || !/\d/.test(cru)) return null;

  let normalizado: string;
  if (cru.includes(',')) {
    // Tem vírgula => vírgula é o decimal e todo ponto é milhar. "1.299,90"
    normalizado = cru.replace(/\./g, '').replace(',', '.');
  } else if (/\.\d{2}$/.test(cru)) {
    // Só ponto, com exatamente 2 casas no fim => alguém colou no formato US.
    normalizado = cru;
  } else {
    // Só ponto, sem 2 casas finais => milhar brasileiro. "1.299" = 1299
    normalizado = cru.replace(/\./g, '');
  }
  const n = Number(normalizado);
  return Number.isFinite(n) ? n : null;
}

const RE_VALOR = /R?\$\s*([\d][\d.,]*)|(?<![\d,.])(\d{1,3}(?:\.\d{3})*,\d{2})(?![\d])/g;

/** Todos os valores monetários do texto, na ordem em que aparecem. */
function valoresDoTexto(texto: string): number[] {
  const out: number[] = [];
  for (const m of texto.matchAll(RE_VALOR)) {
    const v = parseMoedaBR(m[1] ?? m[2] ?? '');
    if (v != null && v > 0) out.push(v);
  }
  return out;
}

// ============================================================
// LEITURA DA MENSAGEM
// ============================================================

const RE_URL = /https?:\/\/[^\s<>"']+/gi;

const PLATAFORMAS: Array<[RegExp, string]> = [
  [/(^|\.)shopee\.|shp\.ee|s\.shopee/i, 'shopee'],
  [/(^|\.)amazon\.|amzn\./i, 'amazon'],
  [/mercadolivre|mercadolibre|(^|\.)meli\./i, 'mercadolivre'],
  [/magazineluiza|magalu/i, 'magalu'],
  [/aliexpress|s\.click\.ali/i, 'aliexpress'],
];

function plataformaDe(urls: string[]): string | null {
  for (const u of urls) {
    let host = '';
    try {
      host = new URL(u).hostname;
    } catch {
      host = u; // URL malformada: procura no texto cru mesmo
    }
    for (const [re, nome] of PLATAFORMAS) if (re.test(host)) return nome;
  }
  return null;
}

/** Emoji e símbolos decorativos — usados para descartar linha sem conteúdo. */
const RE_EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}]/gu;

/**
 * Linha INTEIRA em negrito: `*Produto*` ou `**Produto**`.
 * Exige caractere não-branco logo após o marcador — é o que separa
 * `*Kit Braé Stages Nutrition...*` (título) de `* por *R$ 20* no ML*` (linha de
 * preço, que começa com asterisco seguido de espaço).
 */
const RE_LINHA_NEGRITO = /^\s*(\*{1,2}|_{1,2})(\S.*?\S)\1\s*$/;

/** Limpa uma linha para virar candidata a título. */
function limparLinha(bruta: string): string {
  return bruta
    .replace(RE_URL, ' ')
    .replace(RE_EMOJI, ' ')
    // tira o preço de dentro: "Air Fryer 5L R$ 249,90" ainda é um bom título
    .replace(/R?\$\s*[\d][\d.,]*/gi, ' ')
    .replace(/[*_~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '');
}

/**
 * Rodapé padrão do grupo — nunca é o nome do produto.
 *
 * Todas estas frases vieram de mensagem real: eles fecham cada post com cupom,
 * frete, quem vende e selo de confiança. Sem esta lista, `*use o cupom*
 * *CASAPROMO*` (que é linha inteira em negrito) era escolhida como título.
 */
const RE_RODAPE =
  /\b(cupom|cup[óo]n|frete\s+gr[áa]tis|vendido\s+por|site\s+confi[áa]vel|amazon\s+prime|membros?\s+prime|resgate|no\s+pix|em\s+\d+\s*x)\b|\bpor\s*[*~_]*\s*R?\$/i;

/** A linha tem cara de nome de produto? */
function pareceTitulo(limpo: string): boolean {
  if (!limpo || limpo.length > 160) return false;
  const palavras = limpo.split(' ').filter(Boolean);
  const comLetra = palavras.filter((p) => /\p{L}/u.test(p));
  // 3 palavras, ao menos 2 com letra: corta "50 OFF" e "R$ 89,90" sem cortar
  // "Smart TV LG 43 polegadas 4K".
  return palavras.length >= 3 && comLetra.length >= 2;
}

/**
 * CHAMADA DE EFEITO, não produto: linha toda em CAIXA ALTA e sem nenhum dígito.
 *
 * Vem de mensagem real: "KITZÃO PRA CUIDAR DAS MADEIXAS", "É QUASE UMA TV",
 * "TIRA A SUJEIRA COM VONTADE" — todas vêm ANTES do nome do produto, e o
 * parser antigo pegava justamente elas como título. Exigir ausência de dígito
 * é o que protege nome legítimo em caixa alta ("MONITOR LG 24 165HZ" tem
 * números e sobrevive).
 */
function ehChamadaDeEfeito(limpo: string): boolean {
  return /\p{L}/u.test(limpo) && limpo === limpo.toUpperCase() && !/\d/.test(limpo);
}

/**
 * Melhor palpite do nome do produto.
 *
 * Duas passadas, nesta ordem, porque os grupos reais usam dois formatos:
 *  1. linha inteira em negrito → é o nome do produto (formato "chamada + título");
 *  2. senão, a primeira linha aproveitável que não seja chamada de efeito
 *     (formato "título na primeira linha").
 */
function acharTitulo(texto: string): string | null {
  const linhas = texto.split(/\r?\n/);

  for (const bruta of linhas) {
    if (!RE_LINHA_NEGRITO.test(bruta) || RE_RODAPE.test(bruta)) continue;
    const limpo = limparLinha(bruta);
    if (pareceTitulo(limpo) && !ehChamadaDeEfeito(limpo)) return limpo;
  }

  for (const bruta of linhas) {
    if (RE_RODAPE.test(bruta)) continue;
    const limpo = limparLinha(bruta);
    if (pareceTitulo(limpo) && !ehChamadaDeEfeito(limpo)) return limpo;
  }

  // Última tentativa: se TUDO era caixa alta, aceita — melhor um título
  // imperfeito que nenhum (o matcher lida com similaridade baixa).
  for (const bruta of linhas) {
    if (RE_RODAPE.test(bruta)) continue;
    const limpo = limparLinha(bruta);
    if (pareceTitulo(limpo)) return limpo;
  }
  return null;
}

/** Extrai a oferta do texto livre. Pura e testável. */
export function parsePost(texto: string): ParsedPost {
  const urls = [...new Set(texto.match(RE_URL) ?? [])];

  // --- preço ---
  let price: number | null = null;
  let priceOld: number | null = null;

  /*
   * (a) "de X por Y" — a forma mais confiável, porque o próprio texto diz qual
   * é qual. Tem que ser tentada ANTES de qualquer heurística de maior/menor.
   *
   * O `[~*_|·\-—\s]` no meio veio de mensagem real: eles escrevem
   * `~~DE 683~~ | *POR 431,43 em 8x*`, com marcação de negrito/tachado E uma
   * barra separando. E o "R$" costuma NÃO aparecer nesse formato — por isso
   * o cifrão é opcional dos dois lados.
   */
  const dePor = texto.match(
    /\bde[\s~*_]*R?\$?\s*([\d][\d.,]*)[\s~*_|·\-—]*(?:por|apenas|somente|s[óo])[\s~*_]*R?\$?\s*([\d][\d.,]*)/i,
  );
  if (dePor) {
    priceOld = parseMoedaBR(dePor[1] ?? '');
    price = parseMoedaBR(dePor[2] ?? '');
  }

  const valores = valoresDoTexto(texto);

  // (b) "por/apenas/só R$ Y" isolado
  if (price == null) {
    const por = texto.match(/\b(?:por|apenas|somente|s[óo]|agora)\s*R?\$?\s*([\d][\d.,]*)/i);
    if (por) price = parseMoedaBR(por[1] ?? '');
  }

  // (c) vários valores e nenhuma pista textual: o MENOR é o preço atual e o
  // MAIOR é o "de", que é como grupo de promoção escreve. Só assume o "de" se
  // ele for pelo menos 5% maior — senão são dois preços de coisas diferentes
  // (ex.: frete) e inventar um desconto seria pior que não ter nenhum.
  if (price == null && valores.length) {
    price = Math.min(...valores);
    const maior = Math.max(...valores);
    if (maior > price * 1.05) priceOld = maior;
  }
  if (priceOld == null && price != null && valores.length > 1) {
    const maior = Math.max(...valores);
    if (maior > price * 1.05) priceOld = maior;
  }
  if (priceOld != null && price != null && priceOld <= price) priceOld = null;

  // --- desconto ---
  let discountPct: number | null = null;
  const pct = texto.match(/(\d{1,2})\s*%\s*(?:off|de\s*desconto|desconto)?/i);
  if (pct) discountPct = Number(pct[1]);
  else if (price != null && priceOld != null && priceOld > 0) {
    discountPct = Math.round((1 - price / priceOld) * 10000) / 100;
  }

  // --- cupom ---
  let coupon: string | null = null;
  // `[\s:*~_]*` entre a palavra e o token: eles escrevem `*use o cupom*
  // *CASAPROMO*` e `CUPOM: *PIPOCA*` — a marcação de negrito fica no meio.
  const cup = texto.match(
    /(?:cupom|cupon|cup[óo]n|c[óo]digo|code)[\s:*~_]*([A-Za-z0-9][A-Za-z0-9._-]{3,19})/i,
  );
  if (cup?.[1]) {
    const tok = cup[1];
    // Cupom de verdade tem dígito ou é todo maiúsculo. Sem esse teste,
    // "cupom disponivel na loja" devolveria "disponivel" como cupom.
    if (/\d/.test(tok) || tok === tok.toUpperCase()) coupon = tok;
  }

  return {
    titleGuess: acharTitulo(texto),
    price,
    priceOld,
    discountPct,
    coupon,
    urls,
    platformGuess: plataformaDe(urls),
  };
}

// ============================================================
// GRAVAÇÃO
// ============================================================

export interface IngestInput {
  groupJid: string;
  groupName?: string;
  text: string;
  postedAt?: string | number | Date | null;
  hasImage?: boolean;
  instanceRef?: string | null;
  /**
   * Id da mensagem no WhatsApp (`key.id` do payload da Evolution). É a chave de
   * deduplicação CERTA. Sem ele sobra o hash do texto, que só desempata dentro
   * do mesmo dia — e aí a republicação semanal da mesma oferta (o próprio
   * fenômeno que queremos medir) entra como post novo, corretamente.
   */
  waMessageId?: string | null;
}

export interface IngestResult {
  ok: boolean;
  postId?: string;
  groupId?: string;
  reason?: string;
}

interface GrupoRow {
  id: string;
  is_active: boolean;
}

/**
 * Cadastra (ou atualiza) um grupo observado. Usada pelo painel, NÃO pela
 * ingestão — ver regra 2 no topo: mensagem de grupo desconhecido é recusada,
 * não cria grupo sozinha.
 */
export async function ensureGroup(
  jid: string,
  nome?: string,
  instanceRef?: string | null,
): Promise<GrupoRow | null> {
  if (!jid?.endsWith('@g.us')) return null;
  return queryOne<GrupoRow>(
    `INSERT INTO intel_groups (group_jid, display_name, instance_ref)
     VALUES ($1, $2, $3)
     ON CONFLICT (group_jid) DO UPDATE
       SET display_name = COALESCE(EXCLUDED.display_name, intel_groups.display_name),
           instance_ref = COALESCE(EXCLUDED.instance_ref, intel_groups.instance_ref)
     RETURNING id, is_active`,
    [jid, nome ?? null, instanceRef ?? null],
  );
}

/**
 * Normaliza o instante da mensagem. A Evolution manda `messageTimestamp` em
 * SEGUNDOS; o resto do mundo manda milissegundos. Qualquer coisa menor que
 * 1e12 é segundo (1e12 ms = 2001, e nenhuma mensagem de WhatsApp é de antes
 * disso). Data inválida vira "agora" em vez de quebrar a ingestão.
 */
function quandoFoiPostado(v: IngestInput['postedAt']): Date {
  if (v == null || v === '') return new Date();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? new Date() : v;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  }
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

export async function ingestPost(input: IngestInput): Promise<IngestResult> {
  const jid = String(input?.groupJid ?? '').trim();
  if (!jid.endsWith('@g.us')) return { ok: false, reason: 'não é grupo' };

  const textoLimpo = scrubPII(String(input?.text ?? '')).trim();
  if (!textoLimpo) return { ok: false, reason: 'sem texto' };

  // Regra 2: só grava grupo que está cadastrado no painel.
  const grupo = await queryOne<GrupoRow>(
    `SELECT id, is_active FROM intel_groups WHERE group_jid = $1`,
    [jid],
  );
  if (!grupo) return { ok: false, reason: 'grupo não cadastrado' };
  if (!grupo.is_active) return { ok: false, reason: 'grupo pausado' };

  const p = parsePost(textoLimpo);
  const postadoEm = quandoFoiPostado(input.postedAt);
  const hash = sha256hex(normalizeText(textoLimpo));

  // ON CONFLICT sem alvo cobre AS DUAS travas (id do WhatsApp e hash-por-dia)
  // com uma cláusula só; nomear uma delas deixaria a outra estourando erro.
  const linha = await queryOne<{ id: string }>(
    `INSERT INTO intel_posts
       (group_id, posted_at, message_hash, text, title_guess, title_norm,
        price, price_old, discount_pct, coupon, urls, platform_guess, has_image,
        wa_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      grupo.id,
      postadoEm.toISOString(),
      hash,
      textoLimpo,
      p.titleGuess,
      p.titleGuess ? normalizeText(p.titleGuess) : null,
      p.price,
      p.priceOld,
      p.discountPct,
      p.coupon,
      JSON.stringify(p.urls),
      p.platformGuess,
      input.hasImage === true,
      input.waMessageId ? String(input.waMessageId) : null,
    ],
  );

  // Sem id = entrega repetida da MESMA mensagem (mesmo id do WhatsApp, ou mesmo
  // texto no mesmo dia). Não é erro. Republicação em outro dia NÃO cai aqui —
  // ela é post novo de propósito, porque é o dado que revela lista fixa.
  if (!linha) return { ok: true, groupId: grupo.id, reason: 'repetido' };

  await query(
    `UPDATE intel_groups
        SET posts_count  = posts_count + 1,
            last_post_at = GREATEST(COALESCE(last_post_at, to_timestamp(0)), $2::timestamptz)
      WHERE id = $1`,
    [grupo.id, postadoEm.toISOString()],
  );

  log.debug('post de grupo gravado', {
    grupo: jid.slice(0, 14),
    temPreco: p.price != null,
    temTitulo: p.titleGuess != null,
  });
  return { ok: true, postId: linha.id, groupId: grupo.id };
}
