/* ============================================================
   MOTOR::AFILIADO — comportamento do painel
   Separado do HTML e do CSS de propósito: eram 700 linhas num
   arquivo só, e mexer numa aba obrigava a rolar o documento
   inteiro. Nenhuma dependência externa.
   ============================================================ */

/* -------------------------- utilitários -------------------------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v) => (v == null || v === '' ? null : Number(v));
const brl = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const inteiro = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR'));

/** Segundos -> "47 min", "2 h 10", "3 d". Negativo vira "antes". */
function duracao(seg) {
  if (seg == null) return '—';
  const s = Math.abs(Number(seg));
  const sinal = Number(seg) < 0 ? '−' : '';
  if (s < 90) return `${sinal}${Math.round(s)} s`;
  if (s < 5400) return `${sinal}${Math.round(s / 60)} min`;
  if (s < 172800) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return `${sinal}${h} h${m ? ' ' + m : ''}`;
  }
  return `${sinal}${(s / 86400).toFixed(1)} d`;
}

const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—');
const dataHora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR') : '—');

/* Fuso: tudo que é "por dia" e "por hora" tem que ser resolvido em
   America/Sao_Paulo, porque a virada do dia em UTC cai às 21h de Brasília e
   jogaria as ofertas da noite para o dia errado — no painel E no banco (o SQL
   usa AT TIME ZONE pelo mesmo motivo).

   Usa Intl em vez de subtrair 3 horas na mão: o Brasil não tem horário de verão
   desde 2019, então o offset fixo acerta hoje, mas é o tipo de premissa que
   quebra em silêncio se a regra mudar. O Intl carrega a base de fusos. */
const TZ_DONO = 'America/Sao_Paulo';
// 'en-CA' porque é o locale que formata data como YYYY-MM-DD.
const fmtDiaTZ = new Intl.DateTimeFormat('en-CA', { timeZone: TZ_DONO });
const fmtHoraTZ = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ_DONO, hour: '2-digit', minute: '2-digit', hour12: false,
});

/* Ambas devolvem null para entrada ausente ou inválida, em vez de lançar ou
   inventar. Medido: `formatToParts` numa data inválida LANÇA, e uma única
   linha ruim derrubaria o gráfico inteiro; `new Date(null)` vira 1970 e
   desenharia a marca no lugar errado, calada. Quem chama pula o null. */
function instante(d) {
  if (d == null || d === '') return null;
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt;
}
/** 'YYYY-MM-DD' do instante, no fuso do dono. */
function diaTZ(d) {
  const dt = instante(d);
  return dt ? fmtDiaTZ.format(dt) : null;
}
/** Minutos desde a meia-noite local do dono (0..1439), ou null. */
function minutosTZ(d) {
  const dt = instante(d);
  if (!dt) return null;
  const p = fmtHoraTZ.formatToParts(dt);
  const h = Number(p.find((x) => x.type === 'hour')?.value ?? 0);
  const m = Number(p.find((x) => x.type === 'minute')?.value ?? 0);
  return (h % 24) * 60 + m;
}
const hojeBR = () => diaTZ(new Date());

async function api(caminho, opcoes) {
  const r = await fetch(caminho, opcoes);
  let j = {};
  try { j = await r.json(); } catch { /* corpo vazio */ }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
async function enviar(caminho, metodo, corpo) {
  return api(caminho, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo ?? {}),
  });
}

/** Estado vazio: mesmo peso do conteúdo, sempre com uma saída. */
function vazio(titulo, texto, acao) {
  return `<div class="vazio"><h3>${esc(titulo)}</h3><p>${texto}</p>${acao || ''}</div>`;
}
/** Falha de carregamento mostra a CAUSA — "não carregou" mudo já custou horas. */
function falhou(alvoId, err) {
  const n = $(alvoId);
  if (!n) return;
  n.innerHTML = `<div class="vazio erro"><h3>Não deu para carregar</h3>
    <code>${esc(err.message || String(err))}</code>
    <button class="btn fantasma" data-acao="recarregar">tentar de novo</button></div>`;
}
const guardar = (fn, alvoId) => Promise.resolve().then(fn).catch((e) => falhou(alvoId, e));

/* -------------------------- navegação -------------------------- */
const SECOES = ['visao', 'feed', 'ciclos', 'inteligencia', 'grupos', 'conexoes', 'config', 'falhas'];
const ROTA = {
  '/': 'visao', '/fila': 'feed', '/feed': 'feed', '/ciclos': 'ciclos',
  '/inteligencia': 'inteligencia', '/grupos': 'grupos',
  '/conexoes': 'conexoes', '/config': 'config', '/falhas': 'falhas',
};
let secaoAtual = 'visao';

function abrir(secao, empurrar) {
  if (!SECOES.includes(secao)) secao = 'visao';
  secaoAtual = secao;
  document.querySelectorAll('.secao').forEach((s) => s.classList.remove('ativa'));
  $('secao-' + secao)?.classList.add('ativa');
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('ativa', a.dataset.secao === secao));
  if (empurrar) {
    const caminho = Object.keys(ROTA).find((k) => ROTA[k] === secao) || '/';
    history.pushState({ secao }, '', caminho);
  }
  carregarSecao(secao);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function carregarSecao(s) {
  if (s === 'visao') { guardar(carregarFunil, 'funil'); guardar(carregarPlacar, 'placar'); }
  if (s === 'feed') { guardar(carregarFacetas, 'f-resumo'); guardar(carregarOfertas, 'ofertas'); }
  if (s === 'ciclos') guardar(carregarCiclos, 'ciclos');
  if (s === 'inteligencia') guardar(carregarInteligencia, 'travessia');
  if (s === 'grupos') { guardar(carregarGrupos, 'lista-grupos'); guardar(carregarIngestUrl, 'ingest-url'); }
  if (s === 'conexoes') guardar(carregarCanais, 'lista-canais');
  if (s === 'config') guardar(carregarConfig, 'cfg-status');
  if (s === 'falhas') guardar(carregarFalhas, 'falhas');
}
function recarregar() { guardar(pulso, 'estado-api'); carregarSecao(secaoAtual); }

/* -------------------------- saúde -------------------------- */
async function pulso() {
  try {
    await api('/health');
    $('led').classList.remove('off');
    $('estado-api').textContent = 'motor no ar';
  } catch {
    $('led').classList.add('off');
    $('estado-api').textContent = 'API fora do ar';
  }
}

/* ==================== VISÃO GERAL: o funil ==================== */
async function carregarFunil() {
  const [stats, runs] = await Promise.all([api('/api/stats'), api('/api/capture/runs')]);
  const ultimo = (runs || []).map((r) => r.stats).find((s) => s && s.fetched != null) || {};
  const buscadas = ultimo.fetched || 0;
  const cortes = ultimo.cut || {};
  const cortadas = Object.values(cortes).reduce((a, b) => a + Number(b), 0);
  const selecionadas = ultimo.selected || 0;
  const o = stats.offers || {};
  const naFila = (o.approved || 0) + (o.pending || 0);
  const enviadasHoje = stats.sentToday || 0;

  const faixas = [
    ['entrada', buscadas, 'buscadas na Shopee'],
    ['corte', cortadas, 'cortadas pelo filtro'],
    ['saida', selecionadas, 'aprovadas no ciclo'],
    ['enviado', enviadasHoje, 'enviadas hoje'],
  ];
  const total = Math.max(1, ...faixas.map((f) => f[1]));
  const trilha = faixas.map(([cls, n, rot]) => {
    const peso = Math.max(0.12, n / total);
    return `<div class="faixa ${cls}" style="flex-grow:${(peso * 100).toFixed(0)}">
      <div class="n">${inteiro(n)}</div><div class="r">${esc(rot)}</div></div>`;
  }).join('');

  const ordenados = Object.entries(cortes).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const motivos = ordenados.length
    ? `<div class="motivos">${ordenados.map(([m, n]) => `<span class="motivo"><b>${n}</b> ${esc(m)}</span>`).join('')}</div>`
    : '';
  const taxa = buscadas ? Math.round((selecionadas / buscadas) * 100) : 0;
  $('funil').innerHTML = `<div class="trilha">${trilha}</div>
    <div class="legenda">último ciclo: ${inteiro(buscadas)} buscadas → ${inteiro(selecionadas)} aprovadas
      (${taxa}% de aproveitamento) · ${inteiro(naFila)} esperando na fila</div>${motivos}`;
}

async function carregarPlacar() {
  const s = await api('/api/stats');
  const o = s.offers || {};
  const placas = [
    ['aprovadas na fila', o.approved || 0, 'nos'],
    ['aguardando revisão', o.pending || 0, ''],
    ['enviadas hoje', s.sentToday || 0, 'feito'],
    ['vencidas', o.expired || 0, ''],
    ['rejeitadas', o.rejected || 0, ''],
  ];
  $('placar').innerHTML = placas.map(([l, n, cls]) =>
    `<div class="placa ${cls}"><div class="n">${inteiro(n)}</div><div class="l">${esc(l)}</div></div>`).join('');

  const cor = { active: 'var(--feito)', warming: 'var(--ink3)', paused: 'var(--ink3)', banned: 'var(--corte)' };
  const canais = s.channels || [];
  $('canais-chips').innerHTML = canais.length
    ? `<div class="chips">${canais.map((c) =>
        `<span class="chip"><span class="ponto-status" style="background:${cor[c.status] || 'var(--ink3)'}"></span>
         ${esc(c.display_name || c.instance_ref)} · ${esc(c.status)} · disjuntor ${esc(c.breaker)}</span>`).join('')}</div>`
    : vazio('Nenhum número conectado',
        'O motor captura ofertas e mede preço, mas não tem para onde postar. Conecte um número do WhatsApp e escolha os grupos de disparo.',
        '<button class="btn" data-ir="conexoes">Conectar um número</button>');
}

/* ==================== FEED ==================== */
let filtros = { status: 'approved' };

function queryFeed() {
  const p = new URLSearchParams();
  p.set('status', filtros.status);
  p.set('order', $('f-ordem').value || 'fila');
  const q = $('f-q').value.trim(); if (q) p.set('q', q);
  const k = $('f-keyword').value; if (k) p.set('keyword', k);
  const mn = $('f-min').value; if (mn) p.set('minPrice', mn);
  const mx = $('f-max').value; if (mx) p.set('maxPrice', mx);
  const cm = $('f-com').value; if (cm) p.set('minCommissionBrl', cm);
  if ($('f-prio').getAttribute('aria-pressed') === 'true') p.set('priority', '1');
  if ($('f-real').getAttribute('aria-pressed') === 'true') p.set('withRealDiscount', '1');
  return p.toString();
}

async function carregarFacetas() {
  const f = await api('/api/feed/facets');
  const sel = $('f-keyword'); const atual = sel.value;
  sel.innerHTML = '<option value="">todas as palavras-chave</option>' +
    (f.keywords || []).map((k) => `<option value="${esc(k.keyword)}">${esc(k.keyword)} (${k.c})</option>`).join('');
  sel.value = atual;
}

/* Preço: o antigo MONITORADO por nós ao lado do atual. Quando não há
   leituras suficientes, diz isso — nunca inventa desconto. */
function blocoPreco(r) {
  const agora = num(r.price);
  const mediana = num(r.mediana) ?? num(r.original_price);
  const obs = num(r.obs) || 0;
  const real = num(r.discount_pct);
  const economia = num(r.savings_brl);
  let html = `<span class="agora">${brl(agora)}</span>`;
  if (mediana != null && agora != null && mediana > agora && obs >= 3) {
    html += `<span class="antes">${brl(mediana)}</span>`;
    if (real != null) html += `<span class="queda">−${Math.round(real)}% de verdade${economia ? ' · ' + brl(economia) : ''}</span>`;
  } else {
    html += `<span class="monitorando">preço antigo: monitorando (${obs} ${obs === 1 ? 'leitura' : 'leituras'}${obs < 3 ? ' de 3' : ''})</span>`;
  }
  const anunciado = num(r.advertised_discount_pct);
  if (anunciado) html += `<span class="monitorando">· anúncio diz −${Math.round(anunciado)}%</span>`;
  return `<div class="precos">${html}</div>`;
}

async function carregarOfertas() {
  const rows = await api('/api/offers?' + queryFeed());
  $('f-resumo').textContent = rows.length + (rows.length === 1 ? ' oferta' : ' ofertas');
  const alvo = $('ofertas');
  if (!rows.length) {
    alvo.innerHTML = vazio('Nenhuma oferta com esses filtros',
      'Afrouxe os filtros, ou rode um ciclo de captura para trazer ofertas novas.',
      '<button class="btn fantasma" data-acao="limpar-filtros">Limpar filtros</button><button class="btn" data-acao="ciclo">Rodar um ciclo</button>');
    return;
  }
  alvo.innerHTML = rows.map((r) => {
    const tags = [
      r.is_priority ? '<span class="tag nos">FURA-FILA</span>' : '',
      r.status === 'sent' ? '<span class="tag feito">ENVIADA</span>' : '',
      r.status === 'rejected' ? '<span class="tag corte">REJEITADA</span>' : '',
      r.status === 'expired' ? '<span class="tag neutro">VENCIDA</span>' : '',
    ].join(' ');
    const pct = r.commission_rate ? (Number(r.commission_rate) * 100).toFixed(0) + '%' : '—';
    const meta = [
      `<span>ganho/venda <b>${brl(num(r.commission_brl))}</b> (${pct})</span>`,
      r.sales != null ? `<span>vendas <b>${inteiro(r.sales)}</b></span>` : '',
      r.rating_star ? `<span>nota <b>${Number(r.rating_star).toFixed(1)}</b></span>` : '',
      r.keyword ? `<span>origem <b>${esc(r.keyword)}</b></span>` : '',
      r.reject_reason ? `<span class="err">motivo: ${esc(r.reject_reason)}</span>` : '',
    ].filter(Boolean).join('');
    const acoes = [];
    if (r.status === 'pending') acoes.push(`<button class="btn pequeno" data-oferta="${r.id}" data-op="approve">aprovar</button>`);
    if (r.status === 'approved' || r.status === 'pending') acoes.push(`<button class="btn perigo pequeno" data-oferta="${r.id}" data-op="reject">rejeitar</button>`);
    return `<article class="linha-item">
      <img src="${esc(r.image_url)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"/>
      <div class="corpo">
        <div class="t-titulo">${esc(r.title)} ${tags}</div>
        ${blocoPreco(r)}
        <div class="meta">${meta}</div>
        ${r.rewritten_copy ? `<div class="copy">${esc(r.rewritten_copy)}</div>` : ''}
        ${r.affiliate_url ? `<div class="meta"><a href="${esc(r.affiliate_url)}" target="_blank" rel="noopener">abrir link de afiliado</a></div>` : ''}
      </div>
      <div class="acoes">${acoes.join('')}</div></article>`;
  }).join('');
}

/* ==================== CICLOS ==================== */
async function carregarCiclos() {
  const runs = await api('/api/capture/runs');
  if (!runs.length) {
    $('ciclos').innerHTML = vazio('Nenhum ciclo ainda',
      'O motor roda sozinho a cada 30 minutos. Para não esperar, dispare um agora.',
      '<button class="btn" data-acao="ciclo">Rodar um ciclo agora</button>');
    $('amostras').innerHTML = '';
    return;
  }
  const linhas = runs.map((r) => {
    const s = r.stats || {};
    /*
     * Ciclo PULADO não é ciclo com corte. A trava de backlog chama o mesmo
     * `cut()` para registrar o porquê, então o mapa vem com uma entrada e a
     * soma dava "1 cortada" para um ciclo em que NADA foi buscado nem cortado —
     * um número inventado numa coluna de contagem. `stats.skipped` já era
     * gravado pelo motor (shopeeFeed.ts) e o painel simplesmente não lia.
     */
    const pulado = !!s.skipped;
    const cortadas = Object.values(s.cut || {}).reduce((a, b) => a + Number(b), 0);
    const dur = s.ms != null ? (s.ms / 1000).toFixed(1) + 's' : (r.finished_at ? '—' : 'rodando…');
    const topo = Object.entries(s.cut || {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([m, n]) => `${n}× ${m}`).join(' · ') || '—';
    const venc = s.expired ? ` <span class="tag neutro">${s.expired} vencidas</span>` : '';
    const motivo = pulado
      ? `<span class="tag neutro">pulado</span> ${esc(Object.keys(s.cut || {})[0] || 'sem motivo registrado')}`
      : esc(topo);
    return `<tr${pulado ? ' class="linha-pulada"' : ''}><td>${esc(dataHora(r.started_at))}</td><td>${esc(r.trigger)}</td><td>${pulado ? '—' : (s.keywords ?? '—')}</td>
      <td>${pulado ? '—' : (s.fetched ?? 0)}</td><td class="${pulado ? '' : 'err'}">${pulado ? '—' : cortadas}</td>
      <td class="${pulado ? '' : 'alerta'}">${pulado ? '—' : (s.selected ?? 0)}</td><td>${dur}${venc}</td><td>${motivo}</td></tr>`;
  }).join('');
  $('ciclos').innerHTML = `<div class="rolagem"><table>
    <thead><tr><th>quando</th><th>gatilho</th><th>keywords</th><th>buscadas</th><th>cortadas</th>
    <th>aprovadas</th><th>duração</th><th>principais cortes</th></tr></thead><tbody>${linhas}</tbody></table></div>`;

  const amostras = (runs.map((r) => r.stats).find((s) => s && s.samples && s.samples.length) || {}).samples || [];
  $('amostras').innerHTML = amostras.length
    ? `<div class="rolagem"><table><thead><tr><th>produto</th><th>preço</th><th>por que foi cortado</th></tr></thead>
       <tbody>${amostras.map((a) => `<tr><td>${esc(a.title)}</td><td>${brl(a.price)}</td><td class="err">${esc(a.reason)}</td></tr>`).join('')}</tbody></table></div>`
    : vazio('Nenhuma amostra guardada', 'O último ciclo não registrou exemplos do corte.');
}

/* ==================== INTELIGÊNCIA ==================== */
let verdictFiltro = '';

async function carregarInteligencia() {
  if (!$('i-dia').value) $('i-dia').value = hojeBR();
  const dia = $('i-dia').value;
  const dias = $('i-dias').value;

  await Promise.all([
    guardar(() => desenharTravessia(dia), 'travessia'),
    guardar(() => carregarIntelPlacar(dias, dia), 'intel-placar'),
    guardar(() => carregarPerfil(dias), 'perfil'),
    guardar(() => carregarRepeticao(dias), 'repeticao'),
    guardar(() => carregarCorrelacao(dia), 'correlacao'),
    guardar(carregarVarreduras, 'varreduras'),
  ]);
}

/* ---- A TRAVESSIA: dois trilhos e o atraso entre eles ---- */
async function desenharTravessia(dia) {
  const [densidade, linhas] = await Promise.all([
    api('/api/intel/day-density?dia=' + encodeURIComponent(dia)),
    api('/api/intel/correlation?dia=' + encodeURIComponent(dia) + '&limit=400'),
  ]);

  const casadas = (linhas || []).filter((l) => l.verdict === 'casado' && l.firstSeenAt);
  const totalObs = (densidade.observacoes || []).reduce((a, b) => a + b.n, 0);
  const totalPosts = (densidade.posts || []).reduce((a, b) => a + b.n, 0);

  if (!totalObs && !totalPosts) {
    $('travessia').innerHTML = vazio('Nada observado em ' + dia.split('-').reverse().join('/'),
      'A varredura registra o que a API oferece e a ingestão registra o que os grupos postam. Sem uma das duas pontas não há o que cruzar.',
      '<button class="btn" data-acao="varredura">Varrer a API agora</button><button class="btn fantasma" data-ir="grupos">Cadastrar um grupo</button>');
    $('travessia-legenda').innerHTML = '';
    return;
  }

  const L = 46, R = 984, TOPO = 58, BASE = 142;

  /* JANELA ADAPTATIVA — olhar o gráfico renderizado é o que revelou isto.
     Com eixo fixo de 00h-24h, quem abre o painel às 10h vê dois terços de nada,
     e a INCLINAÇÃO (que é o dado) fica espremida num canto. Agora o eixo se
     ajusta ao intervalo em que houve movimento, com folga, e nunca menor que
     4h para não exagerar diferenças de minutos. */
  /* A janela sai dos POSTS e das observações que casaram — não da faixa de
     densidade. A densidade é contexto de fundo e cobre o dia inteiro (a
     varredura roda de 2 em 2h), então deixá-la mandar na escala devolvia
     sempre 24h e espremia de novo o que interessa. O que interessa é onde
     eles postaram e de onde veio cada linha. */
  const marcos = [];
  for (const l of linhas || []) {
    const mp = minutosTZ(l.postedAt);
    if (mp != null) marcos.push(mp);
    if (l.firstSeenAt && diaTZ(l.firstSeenAt) === dia) {
      const mo = minutosTZ(l.firstSeenAt);
      if (mo != null) marcos.push(mo);
    }
  }
  let ini = marcos.length ? Math.max(0, Math.min(...marcos) - 30) : 0;
  let fim = marcos.length ? Math.min(1440, Math.max(...marcos) + 30) : 1440;
  if (fim - ini < 240) { const meio = (ini + fim) / 2; ini = Math.max(0, meio - 120); fim = Math.min(1440, meio + 120); }
  const span = Math.max(60, fim - ini);
  const x = (minutos) => L + ((Math.max(ini, Math.min(fim, minutos)) - ini) / span) * (R - L);
  const minutosDe = minutosTZ;
  /* Observação de um dia ANTERIOR é ancorada na borda esquerda do gráfico: a
     linha longa e rasa até o post é justamente o desenho de "eles esperaram
     virar o dia". Sem isso ela sairia do eixo e o par sumiria. */
  const antesDoDia = (iso) => diaTZ(iso) < dia;
  /* Espelho do anterior, e ele existe porque a janela de busca virou simétrica:
     agora a primeira observação PODE ser posterior ao post (eles postaram antes
     de a gente ver — lag negativo, que é informação valiosa). Sem ancorar na
     borda direita, o tick caía no minuto do dia SEGUINTE e o conector desenhava
     uma diagonal longa afirmando ~23h de atraso quando a verdade é −40min.
     Como a INCLINAÇÃO é o elemento-assinatura, era afirmação confiante e
     invertida. */
  const depoisDoDia = (iso) => diaTZ(iso) > dia;

  const partes = [];

  // Grade com passo escolhido pela largura da janela: 6 a 8 marcas, sempre.
  const passo = span <= 300 ? 30 : span <= 720 ? 60 : span <= 1080 ? 120 : 180;
  for (let m = Math.ceil(ini / passo) * passo; m <= fim; m += passo) {
    const px = x(m);
    const hh = String(Math.floor(m / 60) % 24).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    partes.push(`<line class="grade" x1="${px}" y1="34" x2="${px}" y2="166"/>`);
    partes.push(`<text class="hora" x="${px}" y="180" text-anchor="middle">${hh}${passo < 60 ? ':' + mm : 'h'}</text>`);
  }

  // trilhos
  partes.push(`<line class="rail" x1="${L}" y1="${TOPO}" x2="${R}" y2="${TOPO}"/>`);
  partes.push(`<line class="rail" x1="${L}" y1="${BASE}" x2="${R}" y2="${BASE}"/>`);
  partes.push(`<text class="rail-label" x="${L}" y="${TOPO - 14}" fill="var(--nos)">a API ofereceu</text>`);
  partes.push(`<text class="rail-label" x="${L}" y="${BASE + 26}" fill="var(--eles)">eles postaram</text>`);

  // densidade do cardápio (fundo): altura proporcional ao balde mais cheio
  const maxObs = Math.max(1, ...(densidade.observacoes || []).map((b) => b.n));
  for (const b of densidade.observacoes || []) {
    const px = x(b.balde * 15 + 7.5);
    const alt = 4 + (b.n / maxObs) * 18;
    partes.push(`<line class="tick-fundo" x1="${px}" y1="${TOPO - alt}" x2="${px}" y2="${TOPO}"><title>${b.n} ofertas por volta das ${String(Math.floor(b.balde / 4)).padStart(2, '0')}h</title></line>`);
  }
  // densidade dos posts (fundo do trilho de baixo)
  const maxPost = Math.max(1, ...(densidade.posts || []).map((b) => b.n));
  for (const b of densidade.posts || []) {
    const px = x(b.balde * 15 + 7.5);
    const alt = 4 + (b.n / maxPost) * 16;
    partes.push(`<line x1="${px}" y1="${BASE}" x2="${px}" y2="${BASE + alt}" stroke="var(--eles)" stroke-width="1" opacity="0.22"/>`);
  }

  // pares casados: tick em cima, tick embaixo, conector entre eles
  casadas.forEach((l, i) => {
    const mObs = minutosDe(l.firstSeenAt);
    const mPost = minutosDe(l.postedAt);
    if (mObs == null || mPost == null) return; // linha sem hora utilizável: pula
    const xo = antesDoDia(l.firstSeenAt) ? x(ini) : depoisDoDia(l.firstSeenAt) ? x(fim) : x(mObs);
    const xp = x(mPost);
    const rotulo = `${l.titleGuess || l.obsTitle || 'oferta'} · atraso ${duracao(l.lagSeconds)}`;
    partes.push(`<line class="tick-nos" x1="${xo}" y1="${TOPO - 7}" x2="${xo}" y2="${TOPO + 7}"/>`);
    partes.push(`<line class="tick-eles" x1="${xp}" y1="${BASE - 7}" x2="${xp}" y2="${BASE + 7}"/>`);
    // Lag negativo = eles se anteciparam a nós. Traço distinto para não ser
    // lido como "atraso curto", que é o oposto do que aconteceu.
    const antecipou = l.lagSeconds != null && l.lagSeconds < 0;
    partes.push(`<line class="conector${antecipou ? ' antecipou' : ''}${i < 60 ? ' desenha' : ''}" x1="${xo}" y1="${TOPO + 7}" x2="${xp}" y2="${BASE - 7}" style="animation-delay:${Math.min(i * 12, 700)}ms"><title>${esc(rotulo)}</title></line>`);
  });

  /* Os NÃO-casados não são todos a mesma coisa, e juntá-los num tick só
     desfaria o conserto que separou "outra loja" de "não achamos":
       outra_plataforma -> post de Amazon/ML: não havia o que achar
       ambiguo          -> achamos DOIS candidatos bons demais
       sem_casamento    -> não achamos (com ou sem quase-acerto) */
  const ROTULO_TICK = {
    outra_plataforma: 'outra loja — não há o que casar na Shopee',
    ambiguo: 'ambígua — dois candidatos bons demais',
    nao_observado: 'produto existe, mas nossa varredura não viu',
  };
  (linhas || []).filter((l) => l.verdict !== 'casado').forEach((l) => {
    const mPost = minutosDe(l.postedAt);
    if (mPost == null) return;
    const xp = x(mPost);
    const quase = l.titleSim != null ? ` · quase acertou (${(Number(l.titleSim) * 100).toFixed(0)}%)` : '';
    const motivo = ROTULO_TICK[l.verdict] || 'sem casamento na API';
    const classe = l.verdict === 'outra_plataforma' ? 'tick-eles outra-loja' : 'tick-eles solto';
    partes.push(`<line class="${classe}" x1="${xp}" y1="${BASE - 5}" x2="${xp}" y2="${BASE + 5}"><title>${esc(l.titleGuess || 'post')} · ${motivo}${quase}</title></line>`);
  });

  $('travessia').innerHTML = `<svg viewBox="0 0 1000 190" role="img"
      aria-label="Linha do tempo do dia: ofertas observadas na API em cima, posts dos grupos embaixo, ligados pelo atraso">
      ${partes.join('')}</svg>`;

  // Denominador honesto: post de Amazon/ML nunca poderia casar contra a API da
  // Shopee, então contá-lo em "N de M casados" deprime a taxa artificialmente.
  const foraDaPlataforma = (linhas || []).filter((l) => l.verdict === 'outra_plataforma').length;
  const elegiveis = (linhas || []).length - foraDaPlataforma;
  $('travessia-legenda').innerHTML = `
    <span><i style="background:var(--nos)"></i> oferta que a API tinha</span>
    <span><i style="background:var(--eles)"></i> post do grupo</span>
    <span><i style="background:var(--eles);opacity:.5"></i> post sem casamento</span>
    <span><i style="background:var(--eles);opacity:.35"></i> outra loja (Amazon/ML)</span>
    <span>${casadas.length} de ${elegiveis} posts de Shopee casados${foraDaPlataforma ? ` · ${foraDaPlataforma} de outra loja` : ''} · inclinação = atraso</span>`;
}

async function carregarIntelPlacar(dias, dia) {
  const resumo = await api('/api/intel/summary?dias=' + dias);
  const doDia = (resumo || []).find((r) => r.dia === dia) || (resumo || [])[0] || {};
  const placas = [
    ['ofertas no cardápio', inteiro(doDia.observadas ?? 0), 'entrada', 'distintas na API'],
    ['eles postaram', inteiro(doDia.posts ?? 0), 'eles', 'mensagens capturadas'],
    ['casadas', inteiro(doDia.casados ?? 0), 'feito',
      doDia.taxaAproveitamento != null ? doDia.taxaAproveitamento.toFixed(1) + '% do cardápio' : 'sem base'],
    /* O rótulo muda quando há casamento censurado. Sem isso, na primeira semana
       o painel estamparia uma mediana que mede a NOSSA data de início, não a
       cadência deles — e o dono calibraria a cadência do motor em cima disso. */
    ['atraso mediano', duracao(doDia.atrasoMedianoSeg), '',
      doDia.atrasoMedianoSeg == null && doDia.casadosCensurados
        ? `${doDia.casadosCensurados} casamento${doDia.casadosCensurados > 1 ? 's' : ''} sem base ainda`
        : doDia.casadosCensurados
          ? `${duracao(doDia.atrasoP25Seg)} – ${duracao(doDia.atrasoP75Seg)} · ${doDia.casadosCensurados} fora (histórico curto)`
          : doDia.atrasoP25Seg != null
            ? `${duracao(doDia.atrasoP25Seg)} – ${duracao(doDia.atrasoP75Seg)}`
            : 'sem casamento'],
    ['no dia seguinte', inteiro(doDia.postadosNoDiaSeguinte ?? 0), '', 'esperaram virar o dia'],
    ['nosso filtro aprovaria', inteiro(doDia.wouldPassCasados ?? 0), 'nos', 'das que eles postaram'],
  ];
  $('intel-placar').innerHTML = placas.map(([l, v, cls, obs]) =>
    `<div class="placa ${cls}"><div class="n">${v}</div><div class="l">${esc(l)}</div>
     <div class="obs">${esc(obs)}</div></div>`).join('');
}

/* ---- dumbbell: perfil do cardápio x perfil do que eles escolheram ---- */
async function carregarPerfil(dias) {
  const linhas = await api('/api/intel/profile?dias=' + dias);
  if (!linhas || !linhas.length) {
    $('perfil').innerHTML = vazio('Ainda não dá para comparar',
      'O perfil precisa de posts casados com ofertas da API. Cadastre um grupo e deixe rodar por alguns dias.');
    return;
  }
  $('perfil').innerHTML = linhas.map((l) => {
    const a = num(l.medianaCardapio);
    const b = num(l.medianaEscolhida);
    if (a == null && b == null) {
      return `<div class="linha"><div class="metrica">${esc(l.metrica)}</div>
        <div class="pista"><div class="barra"></div></div>
        <div class="valor">—<small>sem dado</small></div></div>`;
    }
    // Eixo próprio por métrica: as escalas são incompatíveis (R$ x nota x
    // vendas) e um eixo comum mentiria sobre a distância entre elas.
    const teto = Math.max(a ?? 0, b ?? 0) * 1.15 || 1;
    const pa = ((a ?? 0) / teto) * 100;
    const pb = ((b ?? 0) / teto) * 100;
    const de = Math.min(pa, pb);
    const ate = Math.max(pa, pb);
    const dif = a && b ? ((b - a) / a) * 100 : null;
    const fmt = (v) => (l.metrica.includes('R$') || /pre|ganho/i.test(l.metrica) ? brl(v) : inteiro(v == null ? null : Number(v).toFixed(2).replace(/\.00$/, '')));
    return `<div class="linha">
      <div class="metrica">${esc(l.metrica)}</div>
      <div class="pista">
        <div class="barra"></div>
        <div class="liga" style="left:${de}%;width:${Math.max(0, ate - de)}%"></div>
        <div class="ponto cardapio" style="left:${pa}%" title="cardápio: ${esc(String(a))}"></div>
        <div class="ponto escolhido" style="left:${pb}%" title="escolhido: ${esc(String(b))}"></div>
      </div>
      <div class="valor">${fmt(b)}<small>${dif == null ? 'cardápio ' + fmt(a) : (dif >= 0 ? '+' : '') + dif.toFixed(0) + '% vs cardápio'}</small></div>
    </div>`;
  }).join('') + `<div class="legenda-cores" style="margin-top:12px">
      <span><i style="background:var(--entrada)"></i> mediana do cardápio inteiro</span>
      <span><i style="background:var(--eles)"></i> mediana do que eles escolheram</span></div>`;
}

async function carregarRepeticao(dias) {
  const linhas = await api('/api/intel/repeats?dias=' + dias + '&minVezes=2');
  if (!linhas || !linhas.length) {
    $('repeticao').innerHTML = vazio('Nenhum produto repetido no período',
      'Se eles nunca repetem, a escolha é fresca — não há lista fixa girando. É uma resposta, não uma falta de dado.');
    return;
  }
  $('repeticao').innerHTML = `<div class="rolagem"><table>
    <thead><tr><th>produto</th><th>vezes</th><th>grupos</th><th>intervalo típico</th><th>primeiro</th><th>último</th></tr></thead>
    <tbody>${linhas.slice(0, 40).map((r) => `<tr>
      <td>${esc(r.titulo || r.productId)}</td>
      <td class="alerta">${inteiro(r.vezes)}</td>
      <td>${inteiro(r.gruposDistintos)}</td>
      <td>${r.intervaloMedianoHoras != null ? duracao(r.intervaloMedianoHoras * 3600) : '—'}</td>
      <td>${esc(dataHora(r.primeiroPost))}</td>
      <td>${esc(dataHora(r.ultimoPost))}</td></tr>`).join('')}</tbody></table></div>`;
}

async function carregarCorrelacao(dia) {
  const url = '/api/intel/correlation?dia=' + encodeURIComponent(dia) +
    (verdictFiltro ? '&verdict=' + verdictFiltro : '') + '&limit=200';
  const linhas = await api(url);
  const alvo = $('correlacao');
  if (!linhas || !linhas.length) {
    alvo.innerHTML = vazio('Nenhum post nesse dia',
      'Ou os grupos não postaram, ou nada foi ingerido. Confira os grupos cadastrados e a entrada do n8n.',
      '<button class="btn fantasma" data-ir="grupos">Ver grupos observados</button>');
    return;
  }
  /* 'pendente' não é veredito do banco — é sintético, para post que ainda não
     passou pelo matcher (matched_at NULL). Precisa de rótulo próprio: sem ele,
     "ainda não analisado" se confunde visualmente com "não achamos", que é
     exatamente a distinção que este painel existe para preservar. */
  const TAG = {
    casado: '<span class="tag feito">CASADA</span>',
    ambiguo: '<span class="tag nos">AMBÍGUA</span>',
    sem_casamento: '<span class="tag neutro">SEM CASAMENTO</span>',
    nao_observado: '<span class="tag entrada">NÃO OBSERVADA</span>',
    pendente: '<span class="tag entrada">AGUARDANDO ANÁLISE</span>',
    /* Post de Amazon/Mercado Livre. Precisa de rótulo PRÓPRIO: sem ele viraria
       "sem casamento", e você leria "a varredura falhou" quando a verdade é
       "esse grupo não posta Shopee" — a ação certa é trocar de grupo, não
       mexer na varredura. */
    outra_plataforma: '<span class="tag eles">OUTRA LOJA</span>',
  };
  alvo.innerHTML = linhas.map((l) => {
    const conf = l.confidence != null ? `confiança ${(Number(l.confidence) * 100).toFixed(0)}%` : '';
    const meta = [
      `<span>${esc(l.groupName || 'grupo')} <span class="tag neutro">${esc(l.groupKind)}</span></span>`,
      `<span>postado <b>${hora(l.postedAt)}</b></span>`,
      l.postPrice != null ? `<span>preço deles <b>${brl(num(l.postPrice))}</b></span>` : '',
      l.lagSeconds != null ? `<span>atraso <b>${duracao(l.lagSeconds)}</b></span>` : '',
      conf ? `<span>${conf}</span>` : '',
    ].filter(Boolean).join('');
    const casou = l.verdict === 'casado' || l.verdict === 'ambiguo';
    const detalheApi = `na API: ${esc(l.obsTitle || '—')}${l.obsPrice != null ? ' · ' + brl(num(l.obsPrice)) : ''}
       ${l.commissionBrl != null ? ' · ganho/venda ' + brl(num(l.commissionBrl)) : ''}
       ${l.sales != null ? ' · ' + inteiro(l.sales) + ' vendas' : ''}
       ${l.wouldPass === true ? ' · <span class="ok">nosso filtro aprovaria</span>' : ''}
       ${l.wouldPass === false ? ' · <span class="err">nosso filtro cortaria: ' + esc(l.rejectReason || '') + '</span>' : ''}`;

    /* QUASE-ACERTO: 'sem_casamento' que ainda traz candidato. Mostrar isto é o
       que separa "seu limiar está apertado demais" de "eles têm outra fonte" —
       duas conclusões opostas que, sem este bloco, viram a mesma linha vazia.
       Medido: um mesmo produto reescrito pelo grupo ficou em 0,328. */
    const quaseAcerto = !casou && l.obsTitle && l.titleSim != null;
    const daApi = casou
      ? `<div class="copy">${detalheApi}</div>`
      : quaseAcerto
        ? `<div class="copy" style="border-left-color:var(--nos)">
             <b>quase acertou</b> (${(Number(l.titleSim) * 100).toFixed(0)}% de similaridade,
             abaixo do limiar) — ${detalheApi}</div>`
        : '';
    return `<article class="linha-item sem-foto">
      <div class="corpo">
        <div class="t-titulo">${esc(l.titleGuess || '(sem título identificado)')} ${TAG[l.verdict] || ''}</div>
        <div class="meta">${meta}</div>
        ${daApi}
      </div>
      <div class="acoes"><button class="btn fantasma pequeno" data-post="${l.postId}">recasar</button></div>
    </article>`;
  }).join('');
}

async function carregarVarreduras() {
  const runs = await api('/api/intel/sweeps');
  if (!runs.length) {
    $('varreduras').innerHTML = vazio('Nenhuma varredura ainda',
      'A varredura registra o cardápio inteiro da Shopee a cada 2 horas. Sem ela não há com o que comparar os grupos.',
      '<button class="btn" data-acao="varredura">Varrer a API agora</button>');
    return;
  }
  /* A coluna "incompleta" não é enfeite: varredura interrompida pelo freio da
     Shopee gravava `observed` parcial com `error` nulo, e ficava
     indistinguível de "a Shopee não tinha nada". Como esse `observed` é o
     denominador da taxa de aproveitamento, um dia truncado inflava a taxa —
     e ninguém tinha como saber. */
  const incompletas = runs.filter((r) => r.stats?.incompleta || r.error).length;
  const aviso = incompletas
    ? `<p class="nota err" style="margin-bottom:10px">${incompletas} varredura(s) interrompidas
       antes de cobrir todas as palavras-chave. Os números desses dias são um corte parcial do
       cardápio, não "a Shopee não tinha nada" — não use para calcular taxa.</p>`
    : '';
  $('varreduras').innerHTML = aviso + `<div class="rolagem"><table>
    <thead><tr><th>quando</th><th>gatilho</th><th>keywords</th><th>observadas</th>
    <th>passaria nos filtros</th><th>repetidas entre keywords</th><th>duração</th></tr></thead>
    <tbody>${runs.map((r) => {
      const s = r.stats || {};
      const truncada = s.incompleta || r.error;
      const marca = truncada
        ? `<span class="tag corte">INCOMPLETA</span>${s.keywordsNaoVarridas ? ` <span class="mono">${s.keywordsNaoVarridas} keywords de fora</span>` : ''}`
        : '';
      return `<tr><td>${esc(dataHora(r.started_at))} ${marca}</td><td>${esc(r.trigger)}</td>
        <td>${r.keywords ?? '—'}</td><td class="alerta">${inteiro(r.observed ?? 0)}</td>
        <td>${inteiro(s.wouldPass ?? 0)}</td>
        <td>${s.repetidosEntreKeywords != null ? inteiro(s.repetidosEntreKeywords) : '—'}</td>
        <td>${s.ms != null ? (s.ms / 1000).toFixed(1) + 's' : (r.finished_at ? '—' : 'rodando…')}</td></tr>
        ${r.error ? `<tr><td colspan="7" class="err mono" style="font-size:11px">${esc(String(r.error).slice(0, 240))}</td></tr>` : ''}`;
    }).join('')}</tbody></table></div>`;
}

/* ==================== GRUPOS OBSERVADOS ==================== */
const KIND_ROTULO = { promo: 'promoção genérica', nicho: 'do seu nicho', misto: 'misto', proprio: 'seu grupo' };

/*
 * UMA COR = UM SIGNIFICADO, e aqui estava INVERTIDO. A etiqueta usava
 * `kind === 'nicho' ? 'nos' : 'eles'`, o que pintava de âmbar ("nosso motor")
 * um grupo que é do CONCORRENTE, e de magenta ("eles") justamente o `proprio`,
 * que é o único grupo nosso. `kind` é taxonomia de conteúdo — promo/nicho/misto
 * se distinguem pelo TEXTO da etiqueta, não por matiz de dado. O âmbar fica
 * reservado para o que de fato é nosso, porque é ele que separa o grupo que
 * PRECISA ficar fora de "o que eles escolhem" (report.ts já o exclui).
 */
const kindClasse = (k) => (k === 'proprio' ? 'nos' : 'eles');

async function carregarGrupos() {
  const [grupos] = await Promise.all([api('/api/intel/groups'), guardar(carregarCobertura, 'cobertura')]);
  const alvo = $('lista-grupos');
  if (!grupos.length) {
    alvo.innerHTML = vazio('Nenhum grupo observado',
      'Entre num grupo de promoção com o número de escuta, cole o id aqui, e o motor começa a comparar o que eles postam com o que a API ofereceu no mesmo momento.');
    return;
  }
  alvo.innerHTML = grupos.map((g) => `<article class="linha-item sem-foto">
    <div class="corpo">
      <div class="t-titulo">${esc(g.display_name || g.group_jid)}
        <span class="tag ${kindClasse(g.kind)}">${esc(KIND_ROTULO[g.kind] || g.kind)}</span>
        ${g.is_active ? '' : '<span class="tag neutro">PAUSADO</span>'}</div>
      <div class="meta">
        <span class="mono">${esc(g.group_jid)}</span>
        <span>posts <b>${inteiro(g.posts_count)}</b></span>
        <span>último <b>${g.last_post_at ? dataHora(g.last_post_at) : 'nenhum'}</b></span>
      </div>
    </div>
    <div class="acoes">
      <select data-kind-de="${g.id}" style="font-size:12px;padding:5px 8px">
        ${Object.entries(KIND_ROTULO).map(([k, v]) => `<option value="${k}"${g.kind === k ? ' selected' : ''}>${v}</option>`).join('')}
      </select>
      <button class="btn fantasma pequeno${g.is_active ? ' perigo' : ''}" data-grupo="${g.id}" data-op="${g.is_active ? 'pausar' : 'ativar'}">${g.is_active ? 'pausar' : 'ativar'}</button>
      <button class="btn perigo pequeno" data-grupo="${g.id}" data-op="remover">remover</button>
    </div></article>`).join('');
}

async function carregarCobertura() {
  const linhas = await api('/api/intel/coverage?dias=' + ($('i-dias')?.value || 14));
  $('cobertura').innerHTML = linhas && linhas.length
    ? `<div class="rolagem"><table>
        <thead><tr><th>grupo</th><th>tipo</th><th>posts</th><th>casados</th><th>taxa</th><th>atraso mediano</th><th>último post</th></tr></thead>
        <tbody>${linhas.map((c) => `<tr>
          <td>${esc(c.nome || '—')}${c.ativo ? '' : ' <span class="tag neutro">pausado</span>'}</td>
          <td>${esc(KIND_ROTULO[c.kind] || c.kind)}</td>
          <td>${inteiro(c.posts)}</td><td>${inteiro(c.casados)}</td>
          <td>${c.taxaCasamento != null ? c.taxaCasamento.toFixed(0) + '%' : '—'}</td>
          <td>${duracao(c.atrasoMedianoSeg)}</td>
          <td>${c.ultimoPost ? dataHora(c.ultimoPost) : '—'}</td></tr>`).join('')}</tbody></table></div>`
    : vazio('Sem cobertura ainda', 'Assim que os grupos começarem a postar, a taxa de casamento aparece aqui.');
}

async function carregarIngestUrl() {
  const r = await api('/api/intel/ingest-url');
  $('ingest-url').textContent = r.url || (r.aviso || 'endereço indisponível');
}

/* ==================== CONEXÕES ==================== */
const cNome = () => $('c-name').value.trim();
const cFuncao = () => $('c-role').value;
const msg = (id, texto, cls) => { const n = $(id); if (n) n.innerHTML = `<span class="${cls || ''}">${esc(texto)}</span>`; };

function gruposMarcados() {
  const marcados = [...document.querySelectorAll('#c-grupos input:checked')]
    .map((i) => ({ id: i.value, subject: i.getAttribute('data-subject') }));
  const manual = $('c-grupo-manual').value.trim();
  if (manual) marcados.push({ id: manual, subject: manual });
  return marcados;
}

async function carregarCanais() {
  const rows = await api('/api/channels');
  const alvo = $('lista-canais');
  if (!rows.length) {
    alvo.innerHTML = vazio('Nenhum número cadastrado',
      'Conecte um número acima e escolha os grupos onde ele vai disparar. Enquanto não houver nenhum, o motor captura e mede preço, mas não entrega nada.');
    return;
  }
  alvo.innerHTML = rows.map((c) => {
    const pausado = c.status !== 'active';
    /* Ação de LINHA usa fantasma, nunca o âmbar do botão primário. Visto
       renderizado: um canal pausado ganhava um "ativar" âmbar dentro da lista,
       ao lado de "remover" fantasma — dois pesos para ações do mesmo nível, e
       um quarto âmbar competindo na mesma tela com o "1. Criar e configurar",
       que é o passo que de fato move você adiante. */
    const alterna = c.role === 'poster'
      ? `<button class="btn fantasma pequeno${pausado ? '' : ' perigo'}" data-canal="${c.id}" data-op="${pausado ? 'active' : 'paused'}">${pausado ? 'ativar' : 'pausar'}</button>`
      : '';
    return `<article class="linha-item sem-foto">
      <div class="corpo">
        <div class="t-titulo">${esc(c.display_name || c.instance_ref)}
          <span class="tag entrada">${esc(c.role)}</span>
          ${pausado ? `<span class="tag neutro">${esc(c.status)}</span>` : ''}</div>
        <div class="meta"><span>número <b>${esc(c.instance_ref)}</b></span>
          <span>grupo <b>${c.target_ref ? esc(c.target_ref) : '—'}</b></span>
          <span>hoje <b>${c.sent_today || 0}</b> de ${c.daily_cap}</span></div>
      </div>
      <div class="acoes">${alterna}<button class="btn perigo pequeno" data-canal="${c.id}" data-op="remover">remover</button></div>
    </article>`;
  }).join('');
}

/* ==================== CONFIG ==================== */
async function carregarConfig() {
  const [a, s] = await Promise.all([api('/api/access'), api('/api/settings')]);
  $('acesso-status').innerHTML = 'usuário atual: <b>' + esc(a.usuario) + '</b>';
  $('ac-user').value = a.usuario || '';
  $('ac-webhook').innerHTML = a.webhookUrl
    ? 'webhook do listener (já inclui o token secreto):<br><span class="mono" style="font-size:11px;word-break:break-all">' + esc(a.webhookUrl) + '</span>'
    : 'defina PUBLIC_APP_URL para o app poder registrar o webhook.';
  $('cfg-status').innerHTML = (s.openai_api_key_set
    ? '<span class="ok">chave da OpenAI definida</span>'
    : '<span class="alerta">sem chave — a copy usa o texto do app</span>') +
    ' · modelo <span class="mono">' + esc(s.copy_model) + '</span>';
  $('cfg-model').value = s.copy_model || '';
  $('evo-status').innerHTML = s.evolution_api_key_set && s.evolution_api_url
    ? '<span class="ok">Evolution configurada</span>'
    : '<span class="alerta">Evolution não configurada — a aba Conexões depende disto</span>';
  $('evo-url').value = s.evolution_api_url || '';
}

/* ==================== FALHAS ==================== */

/*
 * "canal 1" era o id da linha, não um nome — o dono via a falha e não sabia
 * QUAL grupo ficou sem receber. Ordem de preferência: o nome que ele mesmo deu,
 * depois o id do grupo, e só então o id cru (canal já removido, que é
 * exatamente quando a falha mais interessa).
 */
function nomeDoCanal(r) {
  if (r.channel_name) return r.channel_name;
  if (r.channel_target) return r.channel_target;
  return r.channel_id ? `canal ${r.channel_id} (removido)` : 'sem canal';
}

async function carregarFalhas() {
  const rows = await api('/api/dlq');
  $('falhas').innerHTML = rows.length
    ? rows.map((r) => `<article class="linha-item sem-foto"><div class="corpo">
        <div class="t-dado">${esc(r.orig_queue)} · ${esc(nomeDoCanal(r))}</div>
        <div class="meta err">${esc((r.error || '').slice(0, 300))}</div>
        <div class="meta">${esc(dataHora(r.created_at))}</div></div></article>`).join('')
    : vazio('Nenhuma falha pendente', 'Tudo que foi para o ar chegou. Falhas de envio aparecem aqui com o erro cru, e nada é reenviado sozinho.');
}

/* ==================== AÇÕES ==================== */
async function buscarAgora() {
  const b = $('btn-buscar');
  b.disabled = true;
  const antes = b.textContent;
  b.textContent = 'buscando…';
  try {
    await enviar('/api/capture/run', 'POST');
    setTimeout(() => { recarregar(); b.disabled = false; b.textContent = antes; }, 9000);
  } catch (e) {
    alert('não deu: ' + e.message);
    b.disabled = false;
    b.textContent = antes;
  }
}

/* Delegação de eventos: o conteúdo é reescrito o tempo todo, então
   ouvir no documento evita religar handler a cada render. */
document.addEventListener('click', async (ev) => {
  const alvo = ev.target.closest('[data-acao],[data-ir],[data-oferta],[data-canal],[data-grupo],[data-post]');
  if (!alvo) return;

  if (alvo.dataset.ir) return abrir(alvo.dataset.ir, true);

  const acao = alvo.dataset.acao;
  if (acao === 'recarregar') return recarregar();
  if (acao === 'ciclo') return buscarAgora();
  if (acao === 'limpar-filtros') return limparFiltros();
  if (acao === 'varredura') {
    try { await enviar('/api/intel/sweep', 'POST'); alert('varredura iniciada — leva alguns minutos.'); }
    catch (e) { alert('não deu: ' + e.message); }
    return;
  }

  try {
    if (alvo.dataset.oferta) {
      await enviar(`/api/offers/${alvo.dataset.oferta}/${alvo.dataset.op}`, 'POST');
      return recarregar();
    }
    if (alvo.dataset.canal) {
      const id = alvo.dataset.canal;
      if (alvo.dataset.op === 'remover') {
        if (!confirm('Parar de disparar nesse grupo e remover o canal?')) return;
        await api('/api/channels/' + id, { method: 'DELETE' });
      } else {
        await enviar('/api/channels/' + id, 'PATCH', { status: alvo.dataset.op });
      }
      return carregarCanais();
    }
    if (alvo.dataset.grupo) {
      const id = alvo.dataset.grupo;
      if (alvo.dataset.op === 'remover') {
        if (!confirm('Remover o grupo e TODOS os posts capturados dele?')) return;
        await api('/api/intel/groups/' + id, { method: 'DELETE' });
      } else {
        await enviar('/api/intel/groups/' + id, 'PATCH', { is_active: alvo.dataset.op === 'ativar' });
      }
      return carregarGrupos();
    }
    if (alvo.dataset.post) {
      alvo.disabled = true;
      const r = await enviar(`/api/intel/posts/${alvo.dataset.post}/rematch`, 'POST');
      alert('resultado: ' + r.verdict + (r.confidence != null ? ` (confiança ${(r.confidence * 100).toFixed(0)}%)` : ''));
      return carregarCorrelacao($('i-dia').value);
    }
  } catch (e) {
    alert('erro: ' + e.message);
  }
});

document.addEventListener('change', async (ev) => {
  const sel = ev.target.closest('[data-kind-de]');
  if (!sel) return;
  try {
    await enviar('/api/intel/groups/' + sel.dataset.kindDe, 'PATCH', { kind: sel.value });
    carregarGrupos();
  } catch (e) { alert('erro: ' + e.message); }
});

function limparFiltros() {
  ['f-q', 'f-min', 'f-max', 'f-com'].forEach((i) => ($(i).value = ''));
  $('f-keyword').value = '';
  $('f-ordem').value = 'fila';
  $('f-prio').setAttribute('aria-pressed', 'false');
  $('f-real').setAttribute('aria-pressed', 'false');
  guardar(carregarOfertas, 'ofertas');
}

/* ==================== LIGAÇÕES ==================== */
function ligar() {
  document.querySelectorAll('nav a').forEach((a) =>
    a.addEventListener('click', (ev) => { ev.preventDefault(); abrir(a.dataset.secao, true); }));
  window.addEventListener('popstate', () => abrir(ROTA[location.pathname] || 'visao', false));

  $('btn-buscar').addEventListener('click', buscarAgora);
  $('btn-atualizar').addEventListener('click', recarregar);
  $('btn-sair').addEventListener('click', async () => {
    await enviar('/api/logout', 'POST'); location.href = '/login';
  });

  // feed
  $('f-status').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-status]');
    if (!b) return;
    $('f-status').querySelectorAll('.pilula').forEach((p) => p.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    filtros.status = b.dataset.status;
    guardar(carregarOfertas, 'ofertas');
  });
  ['f-prio', 'f-real'].forEach((id) => $(id).addEventListener('click', () => {
    const b = $(id);
    b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
    guardar(carregarOfertas, 'ofertas');
  }));
  $('f-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') guardar(carregarOfertas, 'ofertas'); });
  $('f-ordem').addEventListener('change', () => guardar(carregarOfertas, 'ofertas'));
  $('f-keyword').addEventListener('change', () => guardar(carregarOfertas, 'ofertas'));
  $('btn-aplicar').addEventListener('click', () => guardar(carregarOfertas, 'ofertas'));
  $('btn-limpar-filtros').addEventListener('click', limparFiltros);

  // ciclos
  $('btn-ciclo-agora').addEventListener('click', buscarAgora);
  $('btn-limpar-feed').addEventListener('click', async () => {
    if (!confirm('Apagar as ofertas do feed? O histórico de preço é preservado (é o que mede desconto real).')) return;
    const r = await enviar('/api/offers/purge', 'POST');
    alert(r.apagadas + ' ofertas apagadas.');
    recarregar();
  });

  // inteligência
  $('i-dia').addEventListener('change', () => guardar(carregarInteligencia, 'travessia'));
  $('i-dias').addEventListener('change', () => guardar(carregarInteligencia, 'travessia'));
  $('btn-varredura').addEventListener('click', async () => {
    try { await enviar('/api/intel/sweep', 'POST'); alert('varredura iniciada — leva alguns minutos.'); }
    catch (e) { alert('não deu: ' + e.message); }
  });
  $('btn-recorrelacionar').addEventListener('click', async () => {
    if (!confirm('Recorrelacionar TODOS os posts com os limiares atuais?')) return;
    try { await enviar('/api/intel/rematch', 'POST', { todos: true }); alert('correlação iniciada.'); }
    catch (e) { alert('não deu: ' + e.message); }
  });
  $('i-verdict').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-verdict]');
    if (!b) return;
    $('i-verdict').querySelectorAll('.pilula').forEach((p) => p.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    verdictFiltro = b.dataset.verdict;
    guardar(() => carregarCorrelacao($('i-dia').value), 'correlacao');
  });

  // grupos observados
  $('btn-add-grupo').addEventListener('click', async () => {
    try {
      const r = await enviar('/api/intel/groups', 'POST', {
        group_jid: $('g-jid').value.trim(),
        display_name: $('g-nome').value.trim() || undefined,
        kind: $('g-kind').value,
      });
      msg('g-msg', 'grupo cadastrado (id ' + r.id + ')', 'ok');
      $('g-jid').value = ''; $('g-nome').value = '';
      carregarGrupos();
    } catch (e) { msg('g-msg', e.message, 'err'); }
  });
  $('btn-copiar-url').addEventListener('click', async () => {
    const t = $('ingest-url').textContent;
    try { await navigator.clipboard.writeText(t); msg('g-msg', 'endereço copiado', 'ok'); }
    catch { msg('g-msg', 'não deu para copiar — selecione o texto acima', 'alerta'); }
  });
  $('btn-girar-token').addEventListener('click', async () => {
    if (!confirm('Gerar um segredo novo? O fluxo do n8n para de funcionar até você atualizar o endereço lá.')) return;
    await enviar('/api/intel/ingest-url/rotate', 'POST');
    carregarIngestUrl();
  });

  // conexões
  $('c-role').addEventListener('change', () => {
    $('extra-poster').style.display = cFuncao() === 'poster' ? 'block' : 'none';
    $('extra-listener').style.display = cFuncao() === 'listener' ? 'block' : 'none';
  });
  $('btn-criar-inst').addEventListener('click', async () => {
    try {
      if (!cNome()) return msg('c-msg', 'informe um nome', 'err');
      const r = await enviar('/api/instances', 'POST', { name: cNome(), role: cFuncao() });
      msg('c-msg', 'provisionado — ' + Object.entries(r.steps || {}).map(([k, v]) => k + ': ' + v).join(' · ') + '. Agora mostre o QR.', 'ok');
    } catch (e) { msg('c-msg', e.message, 'err'); }
  });
  $('btn-qr').addEventListener('click', async () => {
    try {
      const r = await api('/api/instances/' + encodeURIComponent(cNome()) + '/qr');
      const src = r.base64 ? (r.base64.startsWith('data:') ? r.base64 : 'data:image/png;base64,' + r.base64) : '';
      $('qr').innerHTML = src ? `<img src="${src}" alt="QR code para conectar o WhatsApp"/>` : '';
      msg('c-msg', (r.pairingCode ? 'código: ' + r.pairingCode + ' — ' : '') + 'escaneie o QR no WhatsApp desse número.', 'alerta');
    } catch (e) { msg('c-msg', e.message, 'err'); }
  });
  $('btn-estado').addEventListener('click', async () => {
    try {
      const r = await api('/api/instances/' + encodeURIComponent(cNome()) + '/state');
      const ok = r.state === 'open';
      msg('c-msg', 'estado: ' + r.state + (ok ? ' — conectado' : ' (precisa ficar "open")'), ok ? 'ok' : 'alerta');
      if (ok) $('qr').innerHTML = '';
    } catch (e) { msg('c-msg', e.message, 'err'); }
  });
  $('btn-listar-grupos').addEventListener('click', async () => {
    try {
      const g = await api('/api/instances/' + encodeURIComponent(cNome()) + '/groups');
      $('c-grupos').innerHTML = g.length
        ? g.map((x) => `<label><input type="checkbox" value="${esc(x.id)}" data-subject="${esc(x.subject || x.id)}"> ${esc(x.subject || x.id)}</label>`).join('')
        : '<div class="nota" style="padding:8px">nenhum grupo encontrado nesse número.</div>';
      msg('c-msg', g.length + ' grupos — marque os que interessam', 'ok');
    } catch (e) { msg('c-msg', e.message, 'err'); }
  });
  $('btn-webhook').addEventListener('click', async () => {
    try {
      const r = await enviar('/api/instances/' + encodeURIComponent(cNome()) + '/webhook', 'POST');
      msg('c-msg', 'webhook configurado: ' + r.url, 'ok');
    } catch (e) { msg('c-msg', e.message, 'err'); }
  });
  $('btn-registrar-canal').addEventListener('click', async () => {
    try {
      if (cFuncao() === 'listener') {
        await enviar('/api/channels', 'POST', { role: 'listener', instance_ref: cNome(), display_name: cNome() });
        msg('c-msg', 'listener "' + cNome() + '" registrado', 'ok');
        return carregarCanais();
      }
      const marcados = gruposMarcados();
      if (!marcados.length) return msg('c-msg', 'marque ao menos um grupo (ou cole um id)', 'err');
      const r = await enviar('/api/channels/bulk', 'POST', { instance_ref: cNome(), groups: marcados });
      msg('c-msg', r.created + ' grupo(s) registrados para disparo', 'ok');
      $('c-grupo-manual').value = '';
      carregarCanais();
    } catch (e) { msg('c-msg', e.message, 'err'); }
  });
  $('btn-registrar-intel').addEventListener('click', async () => {
    try {
      const marcados = gruposMarcados();
      if (!marcados.length) return msg('c-msg', 'marque ao menos um grupo (ou cole um id)', 'err');
      const r = await enviar('/api/intel/groups/bulk', 'POST', { groups: marcados, instance_ref: cNome(), kind: 'promo' });
      msg('c-msg', r.created + ' grupo(s) em observação — ajuste o tipo na aba Grupos observados', 'ok');
      $('c-grupo-manual').value = '';
    } catch (e) { msg('c-msg', e.message, 'err'); }
  });

  // config
  $('btn-salvar-evo').addEventListener('click', async () => {
    try {
      const body = { evolution_api_url: $('evo-url').value.trim() };
      const k = $('evo-key').value.trim();
      if (k) body.evolution_api_key = k;
      await enviar('/api/settings', 'PUT', body);
      $('evo-key').value = '';
      carregarConfig();
    } catch (e) { alert('erro: ' + e.message); }
  });
  $('btn-salvar-ia').addEventListener('click', async () => {
    try {
      const body = {};
      const k = $('cfg-key').value.trim(); if (k) body.openai_api_key = k;
      const m = $('cfg-model').value.trim(); if (m) body.copy_model = m;
      await enviar('/api/settings', 'PUT', body);
      $('cfg-key').value = '';
      carregarConfig();
    } catch (e) { alert('erro: ' + e.message); }
  });
  $('btn-salvar-acesso').addEventListener('click', async () => {
    try {
      const senha = $('ac-pass').value;
      const usuario = $('ac-user').value.trim();
      if (senha.length < 8) return alert('a senha precisa de pelo menos 8 caracteres');
      await enviar('/api/access', 'POST', { senha, usuario: usuario || undefined });
      $('ac-pass').value = '';
      alert('acesso atualizado — você vai precisar entrar de novo');
      location.href = '/login';
    } catch (e) { alert('erro: ' + e.message); }
  });
}

/* ==================== INÍCIO ==================== */
ligar();
abrir(ROTA[location.pathname] || 'visao', false);
guardar(pulso, 'estado-api');
setInterval(() => {
  guardar(pulso, 'estado-api');
  if (secaoAtual === 'visao') guardar(carregarFunil, 'funil');
}, 20000);
