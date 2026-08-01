import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { log } from './logger';
import { getSetting, setSetting } from './settings';
import { loadConfig } from './config';

/**
 * Segurança do painel. O domínio é público — quando o Traefik emite o TLS, o
 * host entra nos logs de Certificate Transparency e passa a ser descobrível por
 * qualquer scanner em minutos. Então nada aqui é opcional:
 *
 *  1. LOGIN de sessão (cookie assinado) + Basic auth como alternativa para curl;
 *  2. senha guardada como HASH scrypt (nunca em texto), gerada no 1º boot se não
 *     houver — a senha inicial aparece UMA vez no log do container;
 *  3. freio de tentativas de login por IP (força bruta);
 *  4. teto de requisições por IP nas rotas de API;
 *  5. cabeçalhos de segurança + CSP;
 *  6. token no webhook da Evolution (ele não manda credencial, então o segredo
 *     vai na própria URL que o app configura).
 */

const CHAVE_SENHA = 'dashboard_password_hash';
const CHAVE_USUARIO = 'dashboard_user';
const CHAVE_SESSAO = 'session_secret';
const CHAVE_WEBHOOK = 'webhook_token';
const CHAVE_INGESTAO = 'intel_ingest_token';
export const COOKIE = 'motor_sessao';

// ---------------------------------------------------------------- senha

/** hash = scrypt(senha, sal) — formato "scrypt$<sal hex>$<hash hex>". */
export function hashSenha(senha: string): string {
  const sal = randomBytes(16);
  const dk = scryptSync(senha, sal, 32);
  return `scrypt$${sal.toString('hex')}$${dk.toString('hex')}`;
}

export function senhaCorreta(senha: string, guardado: string): boolean {
  const [algo, salHex, hashHex] = guardado.split('$');
  if (algo !== 'scrypt' || !salHex || !hashHex) return false;
  const dk = scryptSync(senha, Buffer.from(salHex, 'hex'), 32);
  const esperado = Buffer.from(hashHex, 'hex');
  return dk.length === esperado.length && timingSafeEqual(dk, esperado);
}

/** Segredo de assinatura da sessão (gerado e guardado no banco na 1ª vez). */
async function segredoSessao(): Promise<string> {
  let s = await getSetting(CHAVE_SESSAO);
  if (!s) {
    s = randomBytes(32).toString('hex');
    await setSetting(CHAVE_SESSAO, s);
  }
  return s;
}

/** Token do webhook (idem). Vai na URL que o app registra na Evolution. */
export async function tokenWebhook(): Promise<string> {
  let t = await getSetting(CHAVE_WEBHOOK);
  if (!t) {
    t = randomBytes(24).toString('hex');
    await setSetting(CHAVE_WEBHOOK, t);
  }
  return t;
}

/**
 * Token da ingestão de inteligência. É SEPARADO do token do webhook de
 * propósito: quem recebe este é o n8n, um sistema de terceiro que fica com o
 * segredo salvo numa credencial dele. Se um dia esse token vazar, gira só ele —
 * o webhook da Evolution continua valendo, e vice-versa.
 */
export async function tokenIngestao(): Promise<string> {
  let t = await getSetting(CHAVE_INGESTAO);
  if (!t) {
    t = randomBytes(24).toString('hex');
    await setSetting(CHAVE_INGESTAO, t);
  }
  return t;
}

/** Gira o token de ingestão (o fluxo do n8n precisa ser reconfigurado depois). */
export async function girarTokenIngestao(): Promise<string> {
  const t = randomBytes(24).toString('hex');
  await setSetting(CHAVE_INGESTAO, t);
  return t;
}

/**
 * Compara segredo em tempo constante. `a !== b` sai no primeiro byte diferente,
 * o que em tese vaza o prefixo correto por timing. Sobre TLS e com token de 24
 * bytes o ataque é impraticável — mas comparar direito custa uma linha, e a
 * alternativa é depender de "é difícil o bastante".
 */
export function segredoConfere(recebido: string | undefined, esperado: string): boolean {
  if (!recebido) return false;
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  // timingSafeEqual EXIGE mesmo tamanho (lança se diferir), e o próprio
  // tamanho não é segredo aqui.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function usuarioPainel(): Promise<string> {
  const cfg = loadConfig();
  return (await getSetting(CHAVE_USUARIO)) ?? cfg.DASHBOARD_USER ?? 'dono';
}

/**
 * Garante que EXISTE uma senha. Ordem: env DASHBOARD_PASSWORD > hash no banco >
 * gera uma e mostra no log uma única vez (o dono lê no log do container).
 */
export async function garantirSenha(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.DASHBOARD_PASSWORD) return; // senha vem do ambiente
  if (await getSetting(CHAVE_SENHA)) return;
  const gerada = randomBytes(9).toString('base64url'); // ~12 chars
  await setSetting(CHAVE_SENHA, hashSenha(gerada));
  const usuario = await usuarioPainel();
  log.warn(
    '=================== ACESSO AO PAINEL ===================\n' +
      `  usuário: ${usuario}\n` +
      `  senha inicial: ${gerada}\n` +
      '  Troque na aba Config -> Acesso ao painel. Esta senha aparece\n' +
      '  APENAS nesta linha de log, uma única vez.\n' +
      '========================================================',
  );
}

/** Confere usuário+senha contra o ambiente ou o hash do banco. */
export async function autenticar(usuario: string, senha: string): Promise<boolean> {
  const cfg = loadConfig();
  const esperado = await usuarioPainel();
  if (usuario !== esperado) return false;
  if (cfg.DASHBOARD_PASSWORD) {
    const a = Buffer.from(senha);
    const b = Buffer.from(cfg.DASHBOARD_PASSWORD);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  const guardado = await getSetting(CHAVE_SENHA);
  return guardado ? senhaCorreta(senha, guardado) : false;
}

export async function trocarSenha(novaSenha: string, novoUsuario?: string): Promise<void> {
  if (novaSenha.length < 8) throw new Error('a senha precisa de pelo menos 8 caracteres');
  await setSetting(CHAVE_SENHA, hashSenha(novaSenha));
  if (novoUsuario && novoUsuario.trim()) await setSetting(CHAVE_USUARIO, novoUsuario.trim());
  // Invalida sessões antigas: troca o segredo de assinatura.
  await setSetting(CHAVE_SESSAO, randomBytes(32).toString('hex'));
}

// ---------------------------------------------------------------- sessão

export async function criarSessao(usuario: string, dias = 30): Promise<string> {
  const expira = Date.now() + dias * 86400_000;
  const corpo = `${usuario}.${expira}`;
  const assinatura = createHmac('sha256', await segredoSessao()).update(corpo).digest('hex');
  return `${Buffer.from(corpo).toString('base64url')}.${assinatura}`;
}

export async function sessaoValida(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [corpoB64, assinatura] = token.split('.');
  if (!corpoB64 || !assinatura) return false;
  const corpo = Buffer.from(corpoB64, 'base64url').toString('utf8');
  const esperada = createHmac('sha256', await segredoSessao()).update(corpo).digest('hex');
  const a = Buffer.from(assinatura);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const expira = Number(corpo.split('.').pop());
  return Number.isFinite(expira) && expira > Date.now();
}

export function lerCookie(req: Request, nome: string): string | undefined {
  const cru = req.headers.cookie;
  if (!cru) return undefined;
  for (const parte of cru.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nome) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

// ---------------------------------------------------------------- freios por IP

interface Janela {
  hits: number[];
  bloqueadoAte?: number;
}
const tentativasLogin = new Map<string, Janela>();
const requisicoesApi = new Map<string, Janela>();

export function ipDe(req: Request): string {
  const enc = req.headers['x-forwarded-for'];
  if (typeof enc === 'string' && enc) return enc.split(',')[0]!.trim();
  return req.ip ?? req.socket.remoteAddress ?? 'desconhecido';
}

function contar(mapa: Map<string, Janela>, chave: string, janelaMs: number): number {
  const agora = Date.now();
  const j = mapa.get(chave) ?? { hits: [] };
  j.hits = j.hits.filter((t) => agora - t < janelaMs);
  j.hits.push(agora);
  mapa.set(chave, j);
  if (mapa.size > 5000) mapa.clear(); // teto de memória (uso pessoal)
  return j.hits.length;
}

/** Força bruta no login: N tentativas por janela, depois bloqueia o IP. */
export function loginBloqueado(ip: string): number {
  const j = tentativasLogin.get(ip);
  if (j?.bloqueadoAte && j.bloqueadoAte > Date.now()) {
    return Math.ceil((j.bloqueadoAte - Date.now()) / 1000);
  }
  return 0;
}

export function registrarTentativaFalha(ip: string, maximo: number): void {
  const n = contar(tentativasLogin, ip, 15 * 60_000);
  if (n >= maximo) {
    const j = tentativasLogin.get(ip)!;
    j.bloqueadoAte = Date.now() + 15 * 60_000;
    log.warn('login bloqueado por tentativas', { ip, tentativas: n });
  }
}

export function limparTentativas(ip: string): void {
  tentativasLogin.delete(ip);
}

/** Teto de requisições por IP nas rotas de API. */
export function limiteApi(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/health') return next();
  const cfg = loadConfig();
  if (cfg.API_RATE_PER_MIN <= 0) return next();
  const n = contar(requisicoesApi, ipDe(req), 60_000);
  if (n > cfg.API_RATE_PER_MIN) {
    res.set('Retry-After', '60');
    res.status(429).json({ error: 'muitas requisições — espere um minuto' });
    return;
  }
  next();
}

// ---------------------------------------------------------------- cabeçalhos

/**
 * Cabeçalhos de segurança. A CSP libera exatamente o que o painel usa:
 * Google Fonts (css + woff2) e imagem de produto de qualquer https (CDN da
 * Shopee). Nada de terceiros para script.
 */
export function cabecalhosSeguranca(_req: Request, res: Response, next: NextFunction): void {
  res.set({
    'Content-Security-Policy':
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      'font-src https://fonts.gstatic.com; ' +
      "img-src 'self' data: https:; " +
      "connect-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  next();
}
