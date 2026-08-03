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
const SECOES = ['visao', 'feed', 'ciclos', 'inteligencia', 'grupos', 'filas', 'conexoes', 'config', 'falhas'];
const ROTA = {
  '/': 'visao', '/fila': 'feed', '/feed': 'feed', '/ciclos': 'ciclos',
  '/inteligencia': 'inteligencia', '/grupos': 'grupos', '/filas': 'filas',
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
  if (s === 'feed') {
    if (subAba === 'monitor') guardar(carregarPrecos, 'pm-lista');
    else { guardar(carregarFacetas, 'f-resumo'); guardar(carregarOfertas, 'ofertas'); }
  }
  if (s === 'ciclos') guardar(carregarCiclos, 'ciclos');
  if (s === 'inteligencia') { guardar(carregarInteligencia, 'travessia'); guardar(carregarRede, 'rede'); }
  if (s === 'grupos') { guardar(carregarGrupos, 'lista-grupos'); guardar(carregarIngestUrl, 'ingest-url'); guardar(carregarAddNumeros, 'add-numeros'); guardar(carregarNicho, 'nicho'); }
  if (s === 'filas') guardar(carregarFilas, 'filas');
  if (s === 'conexoes') abrirSubtela(null);
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
  const selecionadas = ultimo.selected || 0;
  /*
   * "Cortadas" é buscadas - aprovadas, NÃO a soma do mapa `cut`.
   *
   * `cut()` conta EVENTOS, não produtos: "erro de API" (shopeeFeed.ts) é por
   * keyword e não incrementa `fetched`; "captura repetida" incide sobre
   * finalistas JÁ contados em `selected`. Então `sum(cut)` = (buscadas -
   * aprovadas) + erros + repetidas, e num ciclo ruim a faixa "cortadas" ficava
   * MAIS LARGA que "buscadas" — um funil que alarga no meio.
   *
   * Isto ficou pior antes de melhorar: a tabela de Ciclos foi corrigida num
   * commit anterior e ESTA faixa não, então as duas telas passaram a mostrar
   * números diferentes para o mesmo ciclo, com as mesmas cores e a mesma
   * gramática. Contradição entre telas é pior que erro nas duas.
   * A quebra por motivo continua na coluna de cortes de Ciclos, que é onde
   * contagem de evento faz sentido.
   */
  const cortadas = Math.max(0, buscadas - selecionadas);
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

  /*
   * O mapa de motivos continua vindo de `cut` — a lista embaixo do funil mostra
   * POR QUE cada corte aconteceu, e aí contagem de evento é o que se quer. O
   * que não pode vir daí é a LARGURA da faixa (ver acima). Um commit anterior
   * removeu a variável ao consertar a largura e deixou esta linha órfã, o que
   * derrubava a Visão Geral inteira com "cortes is not defined".
   */
  const ordenados = Object.entries(ultimo.cut || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
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
    /*
     * A frase fala do que FALTA, não do número. `/api/stats` devolve os CANAIS
     * registrados aqui, não as instâncias da Evolution — então "nenhum número
     * conectado" era falso quando o número estava conectado e só não tinha
     * grupo escolhido. Painel que afirma o contrário do que o dono vê na tela
     * ao lado destrói a confiança em tudo que ele diz.
     */
    : vazio('Nenhum grupo recebendo ofertas',
        'O motor captura e mede preço, mas ainda não tem para onde postar. Se o seu número já está conectado, falta só escolher o grupo de disparo.',
        '<button class="btn" data-ir="conexoes">Escolher grupo de disparo</button>');
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
    const dur = s.ms != null ? (s.ms / 1000).toFixed(1) + 's' : (r.finished_at ? '—' : 'rodando…');
    const topo = Object.entries(s.cut || {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([m, n]) => `${n}× ${m}`).join(' · ') || '—';
    const venc = s.expired ? ` <span class="tag neutro">${s.expired} vencidas</span>` : '';
    const motivo = pulado
      ? `<span class="tag neutro">pulado</span> ${esc(Object.keys(s.cut || {})[0] || 'sem motivo registrado')}`
      : esc(topo);
    /*
     * A relação buscadas -> cortadas -> aprovadas É a história de um ciclo, e
     * estava renderizada como três números soltos em colunas separadas: dava
     * para LER, não para VER. Comparar dez ciclos exigia aritmética mental linha
     * a linha. O painel já tem uma linguagem para isso — o funil da Visão Geral,
     * onde largura = quantidade. Aqui ela aparece em miniatura: uma barra por
     * linha, na mesma escala e nas mesmas cores (corte vermelho, aprovada
     * âmbar), o que deixa um ciclo anômalo saltar sem ninguém precisar ler.
     */
    const buscadas = Number(s.fetched ?? 0);
    const aprovadas = Number(s.selected ?? 0);
    /*
     * A barra é derivada de buscadas e aprovadas SÓ — nunca da soma do mapa de
     * cortes. Motivo: `cut()` conta EVENTOS, não produtos. "erro de API"
     * (shopeeFeed.ts) é por keyword e não incrementa `fetched`; "captura
     * repetida" incide sobre finalistas que JÁ entraram em `stats.selected`
     * (fixado antes). Então `cortadas + aprovadas > buscadas` é normal, e a
     * versão anterior renormalizava em silêncio: a barra passava a mostrar uma
     * proporção que CONTRADIZIA o "10 de 100" impresso ao lado dela.
     * Agora o vermelho é "o que não passou" (buscadas - aprovadas), que fecha
     * por construção. A quebra por motivo continua na coluna de cortes, que é
     * onde contagem de evento faz sentido.
     */
    const naoPassaram = Math.max(0, buscadas - aprovadas);
    const pOk = buscadas > 0 ? (aprovadas / buscadas) * 100 : 0;
    const pCorte = buscadas > 0 ? (naoPassaram / buscadas) * 100 : 0;
    const barra = pulado || buscadas === 0
      ? '<span class="mini-funil vazio"></span>'
      : `<span class="mini-funil" title="${naoPassaram} não passaram · ${aprovadas} aprovadas de ${buscadas} buscadas">
           <i class="corte" style="width:${pCorte.toFixed(1)}%"></i><i class="ok" style="width:${pOk.toFixed(1)}%"></i>
         </span>`;
    const resultado = pulado
      ? '—'
      : `${barra}<span class="mini-funil-num"><b class="alerta">${aprovadas}</b> de ${buscadas}</span>`;

    return `<tr${pulado ? ' class="linha-pulada"' : ''}><td>${esc(dataHora(r.started_at))}</td><td>${esc(r.trigger)}</td><td>${pulado ? '—' : (s.keywords ?? '—')}</td>
      <td class="col-resultado">${resultado}</td><td>${dur}${venc}</td><td>${motivo}</td></tr>`;
  }).join('');
  $('ciclos').innerHTML = `<div class="rolagem"><table>
    <thead><tr><th>quando</th><th>gatilho</th><th>keywords</th><th>aprovadas de buscadas</th>
    <th>duração</th><th>principais cortes</th></tr></thead><tbody>${linhas}</tbody></table></div>`;

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
/*
 * O antigo mapa de rótulos de `kind` saiu junto com o select de 4 opções:
 * promo/nicho/misto viraram redundantes com o ASSUNTO, e o que sobrou —
 * "é meu grupo?" — é binário e não precisa de tabela de tradução.
 */


async function carregarGrupos() {
  const [grupos] = await Promise.all([
    api('/api/intel/groups'),
    carregarEtiquetas(),
    guardar(carregarCobertura, 'cobertura'),
  ]);
  const alvo = $('lista-grupos');
  /*
   * A caixa de adicionar deixou de ser um <details> que abria e fechava sozinho:
   * virou um painel fixo com fluxo de dois passos (escolher número → escolher
   * grupo). Toda a lógica de decidir quando abrir some junto — não havia
   * escolha boa entre "fecha por cima do usuário" e "come a primeira dobra", e
   * a resposta certa era não ter caixa dobrável aqui.
   */
  if (!grupos.length) {
    alvo.innerHTML = vazio('Nenhum grupo observado',
      'Entre num grupo de promoção com o número de escuta, cole o id aqui, e o motor começa a comparar o que eles postam com o que a API ofereceu no mesmo momento.');
    return;
  }
  /*
   * O "tipo" tinha 4 opções (promo/nicho/misto/proprio) e três delas viraram
   * REDUNDANTES quando o assunto passou a existir: "promoção genérica" e "do
   * seu nicho" respondiam mal a pergunta que o assunto responde bem. Sobrou a
   * única que NÃO é redundante: se o grupo é SEU. Ela é load-bearing —
   * `report.ts` exclui kind='proprio' de "o que ELES escolhem" em três
   * consultas, e sem essa marcação os seus próprios posts contaminariam a
   * análise dos concorrentes em silêncio.
   *
   * ⚠️ E o comentário fica AQUI, fora do template literal. Crase dentro de
   * comentário dentro de template FECHA a string — é a terceira vez que essa
   * armadilha morde este projeto (já mordeu report.ts duas vezes).
   */
  alvo.innerHTML = grupos.map((g) => `<article class="linha-item sem-foto compacta">
    <div class="corpo">
      <div class="t-titulo">${esc(g.display_name || g.group_jid)}
        ${g.kind === 'proprio' ? '<span class="tag nos">seu grupo</span>' : ''}
        ${g.etiqueta ? `<span class="tag entrada">${esc(g.etiqueta)}</span>` : ''}
        ${g.is_active ? '' : '<span class="tag neutro">PAUSADO</span>'}</div>
      <div class="meta">
        <span class="mono">${esc(g.group_jid)}</span>
        <span>posts <b>${inteiro(g.posts_count)}</b></span>
        <span>último <b>${g.last_post_at ? dataHora(g.last_post_at) : 'nenhum'}</b></span>
      </div>
    </div>
    <div class="acoes compacta">
      ${campoEtiqueta(g)}
      ${interruptor(g.kind === 'proprio',
        'data-meu-grupo="' + g.id + '"',
        'Meu grupo')}
      <button class="btn fantasma pequeno${g.is_active ? ' perigo' : ''}" data-grupo="${g.id}" data-op="${g.is_active ? 'pausar' : 'ativar'}">${g.is_active ? 'pausar' : 'ativar'}</button>
      <button class="btn perigo pequeno" data-grupo="${g.id}" data-op="remover">remover</button>
    </div></article>`).join('');
}

async function carregarCobertura() {
  const linhas = await api('/api/intel/coverage?dias=' + ($('i-dias')?.value || 14));
  $('cobertura').innerHTML = linhas && linhas.length
    ? `<div class="rolagem"><table>
        <thead><tr><th>grupo</th><th>de quem</th><th>posts</th><th>casados</th><th>taxa</th><th>atraso mediano</th><th>último post</th></tr></thead>
        <tbody>${linhas.map((c) => `<tr>
          <td>${esc(c.nome || '—')}${c.ativo ? '' : ' <span class="tag neutro">pausado</span>'}</td>
          <td>${c.kind === 'proprio' ? 'seu grupo' : 'concorrente'}</td>
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


/*
 * `gruposMarcados()` foi removida junto com a lista de caixas de seleção.
 * Escolher os grupos passou a ser feito grupo a grupo, no interruptor de cada
 * um dentro de "Seus números" — o mesmo lugar onde você vê o que já está
 * ligado. Marcar numa lista e confirmar noutro botão era um passo a mais para
 * a mesma decisão.
 */

async function carregarCanais() {
  const rows = await api('/api/channels');
  const alvo = $('lista-canais');
  if (!rows.length) {
    /*
     * A frase fala de CANAL, que é o que esta lista mostra. Dizer "nenhum
     * número cadastrado" logo abaixo de um número conectado e visível fazia o
     * painel contradizer a tela dele mesmo.
     */
    alvo.innerHTML = vazio('Nenhum grupo de disparo registrado',
      'Seus números aparecem acima. Ligue o interruptor "Disparo" no grupo onde o motor deve postar — enquanto não houver nenhum, ele captura e mede preço, mas não entrega nada.');
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
  /*
   * A URL do webhook é longa, tem segredo dentro e existe para ser COLADA na
   * Evolution. Deixá-la como texto puro obriga a selecionar ~60 caracteres com o
   * mouse sem errar a borda — a única ação da caixa não tinha botão.
   */
  $('ac-webhook').innerHTML = a.webhookUrl
    ? 'webhook do listener (já inclui o token secreto):' +
      '<div class="copiavel"><span class="mono" id="ac-webhook-url">' + esc(a.webhookUrl) + '</span>' +
      '<button class="btn fantasma pequeno" data-copiar="ac-webhook-url">copiar</button></div>'
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

/* ==================== DIÁLOGO DENTRO DA PÁGINA ==================== */

/*
 * Substitui `alert()` e `confirm()` nativos.
 *
 * O nativo tinha três problemas concretos: aparece colado no topo da janela
 * (longe de onde você clicou), estampa "cupom.trakads.cloud diz" — que é o
 * navegador falando, não o app —, e TRAVA a página inteira enquanto está
 * aberto, o que num aviso do tipo "isso leva alguns minutos" é o oposto do que
 * se quer dizer.
 *
 * Aqui: centralizado, com X e OK, e um lugar para explicar se dá ou não para
 * fechar a tela — porque essa é justamente a dúvida que um aviso de processo
 * demorado gera.
 *
 * Devolve Promise<boolean>: `true` = confirmou, `false` = cancelou/fechou.
 */
function dialogo(opcoes) {
  const { titulo, texto, detalhe, ok = 'OK', cancelar = null, tom = 'neutro' } = opcoes;

  return new Promise((resolve) => {
    const fundo = document.createElement('div');
    fundo.className = 'sobreposicao';
    fundo.innerHTML =
      '<div class="dialogo ' + tom + '" role="dialog" aria-modal="true" aria-labelledby="dlg-t">' +
      '<button class="dlg-x" aria-label="Fechar">×</button>' +
      '<h2 class="dlg-titulo" id="dlg-t">' + esc(titulo) + '</h2>' +
      '<p class="dlg-texto">' + esc(texto) + '</p>' +
      (detalhe ? '<p class="dlg-detalhe">' + esc(detalhe) + '</p>' : '') +
      '<div class="dlg-acoes">' +
      (cancelar ? '<button class="btn fantasma" data-dlg="nao">' + esc(cancelar) + '</button>' : '') +
      '<button class="btn" data-dlg="sim">' + esc(ok) + '</button>' +
      '</div></div>';

    const fechar = (valor) => {
      document.removeEventListener('keydown', naTecla);
      fundo.remove();
      resolve(valor);
    };
    /* Esc fecha e Enter confirma: teclado é o caminho mais rápido para quem
       está clicando em sequência, e o diálogo nativo dava isso de graça. */
    const naTecla = (e) => {
      if (e.key === 'Escape') fechar(false);
      if (e.key === 'Enter') fechar(true);
    };

    fundo.addEventListener('click', (e) => {
      if (e.target === fundo || e.target.closest('.dlg-x')) return fechar(false);
      const b = e.target.closest('[data-dlg]');
      if (b) fechar(b.dataset.dlg === 'sim');
    });
    document.addEventListener('keydown', naTecla);
    document.body.appendChild(fundo);
    fundo.querySelector('[data-dlg="sim"]').focus();
  });
}

/** Aviso simples — só OK. */
const avisar = (titulo, texto, detalhe) => dialogo({ titulo, texto, detalhe });

/** Erro — mesmo diálogo, tom diferente, para não parecer sucesso. */
const avisarErro = (texto) =>
  dialogo({ titulo: 'Não deu certo', texto, tom: 'erro', ok: 'Entendi' });

/** Confirmação destrutiva — o botão de confirmar assume o tom de perigo. */
const confirmar = (titulo, texto, detalhe) =>
  dialogo({ titulo, texto, detalhe, ok: 'Sim, continuar', cancelar: 'Cancelar', tom: 'perigo' });

/* ==================== ETIQUETA DE ASSUNTO DO GRUPO ==================== */

/*
 * O `kind` (promo/nicho/misto/proprio) responde o PAPEL do grupo em relação a
 * você. A etiqueta responde o ASSUNTO: Tecnologia, Eletrodomésticos, Maquiagem,
 * Moda. As duas convivem porque são perguntas diferentes — misturá-las era o que
 * tornava "promoção genérica" raso: ele respondia a do papel e era lido como se
 * respondesse a do assunto.
 *
 * O catálogo começa com as 31 categorias de nível 1 da própria Shopee, então já
 * nasce útil, e o dono acrescenta o que faltar.
 */
let etiquetas = [];

async function carregarEtiquetas() {
  try { etiquetas = await api('/api/intel/etiquetas'); } catch { etiquetas = []; }
  return etiquetas;
}

/** Campo de assunto: lista + digitar para filtrar + cadastrar o que não existe. */
function campoEtiqueta(grupo) {
  const atual = grupo.etiqueta_id
    ? etiquetas.find((e) => String(e.id) === String(grupo.etiqueta_id))
    : null;
  const opcoes = etiquetas.map((e) =>
    '<option value="' + esc(e.id) + '"' + (atual && String(atual.id) === String(e.id) ? ' selected' : '') + '>' +
    esc(e.nome) + (e.origem === 'usuario' ? ' *' : '') + '</option>').join('');
  return '<div class="campo-etiqueta">' +
    '<select data-etiq-de="' + esc(grupo.id) + '" aria-label="Assunto do grupo">' +
    '<option value="">— sem assunto —</option>' + opcoes + '</select>' +
    '<button class="btn fantasma pequeno" data-nova-etiq="' + esc(grupo.id) + '">+ nova</button>' +
    '</div>';
}

/**
 * Cadastro de etiqueta nova, no fluxo que o dono pediu: digita, o painel diz
 * que não existe, e só então pergunta se quer mesmo cadastrar — com o nome
 * EDITÁVEL antes de confirmar, porque é no momento da confirmação que se
 * percebe o erro de digitação.
 */
async function novaEtiqueta(grupoId) {
  const digitado = await dialogoTexto({
    titulo: 'Qual assunto?',
    texto: 'Digite o nome do assunto. Se já existir, eu seleciono a que existe em vez de duplicar.',
    rotulo: 'Nome do assunto',
    exemplo: 'ex.: Esportes',
    ok: 'Procurar',
  });
  if (!digitado) return;

  const jaTem = etiquetas.find((e) =>
    normaliza(e.nome) === normaliza(digitado));
  if (jaTem) {
    await avisar('Esse assunto já existe',
      '"' + jaTem.nome + '" já está no catálogo — selecionei para você.');
    return aplicarEtiqueta(grupoId, jaTem.id);
  }

  // Não existe: aí sim pergunta se quer cadastrar, com o nome ainda editável.
  const confirmado = await dialogoTexto({
    titulo: 'Cadastrar "' + digitado + '"?',
    texto: 'Esse assunto ainda não existe no catálogo. Quer cadastrar?',
    detalhe: 'Ele passa a aparecer na lista de todos os grupos. Dá para corrigir o nome aqui embaixo antes de confirmar.',
    rotulo: 'Nome que será cadastrado',
    valor: digitado,
    ok: 'Sim, cadastrar',
    cancelar: 'Não',
    tom: 'perigo',
  });
  if (!confirmado) return;

  try {
    const r = await enviar('/api/intel/etiquetas', 'POST', { nome: confirmado });
    await carregarEtiquetas();
    await aplicarEtiqueta(grupoId, r.id);
    await avisar(r.jaExistia ? 'Esse assunto já existia' : 'Assunto cadastrado',
      '"' + r.nome + '"' + (r.jaExistia ? ' já estava no catálogo e foi selecionado.' : ' agora está no catálogo.'),
      r.jaExistia ? undefined : 'Ele aparece na lista de assunto de todos os grupos daqui em diante.');
  } catch (e) {
    avisarErro(e.message);
  }
}

/*
 * "Meu grupo" grava `kind` — a única distinção do antigo tipo que sobreviveu,
 * porque `report.ts` a usa para tirar os seus posts de "o que ELES escolhem".
 * Ligado = 'proprio'; desligado volta a 'promo', que é o neutro.
 */
async function alternarMeuGrupo(botao) {
  const ligado = botao.getAttribute('aria-checked') === 'true';
  botao.disabled = true;
  try {
    await enviar('/api/intel/groups/' + botao.dataset.meuGrupo, 'PATCH',
      { kind: ligado ? 'promo' : 'proprio' });
    carregarGrupos();
  } catch (e) {
    avisarErro(e.message);
    botao.disabled = false;
  }
}

async function aplicarEtiqueta(grupoId, etiquetaId) {
  try {
    await enviar('/api/intel/groups/' + grupoId, 'PATCH', { etiqueta_id: etiquetaId || null });
    carregarGrupos();
  } catch (e) {
    avisarErro(e.message);
  }
}

/**
 * Diálogo com CAMPO DE TEXTO — a variante que o cadastro precisa.
 *
 * Existe separado de `dialogo()` porque a diferença não é visual: aqui o valor
 * de retorno é o texto, não um sim/não, e o campo precisa vir preenchido e
 * selecionável para corrigir antes de confirmar.
 *
 * Devolve a string digitada, ou null se cancelou.
 */
function dialogoTexto(opcoes) {
  const { titulo, texto, detalhe, rotulo, valor = '', exemplo = '',
          ok = 'OK', cancelar = 'Cancelar', tom = 'neutro' } = opcoes;

  return new Promise((resolve) => {
    const fundo = document.createElement('div');
    fundo.className = 'sobreposicao';
    fundo.innerHTML =
      '<div class="dialogo ' + tom + '" role="dialog" aria-modal="true">' +
      '<button class="dlg-x" aria-label="Fechar">×</button>' +
      '<h2 class="dlg-titulo">' + esc(titulo) + '</h2>' +
      '<p class="dlg-texto">' + esc(texto) + '</p>' +
      '<label for="dlg-campo" style="margin-top:14px">' + esc(rotulo) + '</label>' +
      '<input id="dlg-campo" value="' + esc(valor) + '" placeholder="' + esc(exemplo) +
      '" maxlength="30" autocomplete="off" />' +
      '<div class="dlg-contador"><span id="dlg-conta">0</span>/30</div>' +
      (detalhe ? '<p class="dlg-detalhe" style="margin-top:12px">' + esc(detalhe) + '</p>' : '') +
      '<div class="dlg-acoes">' +
      '<button class="btn fantasma" data-dlg="nao">' + esc(cancelar) + '</button>' +
      '<button class="btn" data-dlg="sim">' + esc(ok) + '</button>' +
      '</div></div>';

    const campo = fundo.querySelector('#dlg-campo');
    /*
     * Contador visível em vez de só `maxlength`. Com o limite silencioso, quem
     * digita um nome longo vê a digitação simplesmente PARAR e não entende por
     * quê — o teto tem que ser dito antes de ser atingido.
     */
    const conta = fundo.querySelector('#dlg-conta');
    const atualizarConta = () => {
      conta.textContent = String(campo.value.length);
      conta.parentElement.classList.toggle('no-limite', campo.value.length >= 30);
    };
    campo.addEventListener('input', atualizarConta);
    const fechar = (v) => {
      document.removeEventListener('keydown', naTecla);
      fundo.remove();
      resolve(v);
    };
    const confirmar2 = () => {
      const t = campo.value.trim();
      if (!t) return campo.focus();
      fechar(t);
    };
    const naTecla = (e) => {
      if (e.key === 'Escape') fechar(null);
      if (e.key === 'Enter') { e.preventDefault(); confirmar2(); }
    };

    fundo.addEventListener('click', (e) => {
      if (e.target === fundo || e.target.closest('.dlg-x')) return fechar(null);
      const b = e.target.closest('[data-dlg]');
      if (!b) return;
      if (b.dataset.dlg === 'sim') return confirmar2();
      fechar(null);
    });
    document.addEventListener('keydown', naTecla);
    document.body.appendChild(fundo);
    atualizarConta();
    campo.focus();
    campo.select();
  });
}

/* ==================== ADICIONAR GRUPO PARA OBSERVAR (2 passos) ==================== */

let addNumeros = [];
let addEscolhido = null;

/*
 * Passo 1 — só números CONECTADOS. Instância desligada não tem grupo para
 * listar (a Evolution espera até estourar o tempo), então oferecê-la seria
 * oferecer um caminho que não leva a lugar nenhum.
 */
async function carregarAddNumeros() {
  const alvo = $('add-numeros');
  if (!alvo) return;
  alvo.innerHTML = '<div class="nota" style="padding:10px">carregando seus números…</div>';
  let r;
  try { r = await api('/api/numeros'); } catch (e) {
    alvo.innerHTML = '<div class="nota err" style="padding:10px">' + esc(e.message) + '</div>';
    return;
  }
  if (r.evolutionConfigurada === false) {
    alvo.innerHTML = vazio('Evolution não configurada',
      'Preencha a URL e a chave em Config para o painel enxergar seus números.',
      '<button class="btn" data-ir="config">Ir para Config</button>');
    return;
  }
  addNumeros = (r.numeros || []).filter((n) => n.conectada);
  if (!addNumeros.length) {
    alvo.innerHTML = vazio('Nenhum número conectado agora',
      'Só dá para listar grupos de um número ligado. Conecte um em Conexões, ou cole o id do grupo à mão aqui embaixo.',
      '<button class="btn" data-ir="conexoes">Ir para Conexões</button>');
    return;
  }
  alvo.innerHTML = addNumeros.map((n, i) =>
    '<button class="cartao-escolha" data-add-num="' + i + '">' +
    '<span class="ce-titulo">' + esc(n.instancia) + '</span>' +
    '<span class="ce-desc">' + (n.numero ? '+' + esc(n.numero) : 'sem número') + ' · ' +
    n.grupos.length + ' grupo(s)</span>' +
    '<span class="ce-ir">ver grupos →</span></button>').join('');
}

/* Passo 2 — lista de grupos daquele número, filtrável. */
function abrirAddGrupos(indice) {
  /*
   * Clicar de novo no número JÁ escolhido volta. Antes só o botão "recomeçar"
   * fazia isso, e o gesto natural — clicar no mesmo cartão — não fazia nada:
   * quem abriu o número errado ficava procurando a saída.
   */
  if (addEscolhido && addNumeros[indice] === addEscolhido) return voltarAddNumero();

  addEscolhido = addNumeros[indice];
  if (!addEscolhido) return;
  // O cartão escolhido CONTINUA visível e marcado — é ele que se clica para
  // voltar, e sumir com ele apagaria a pista de onde você está.
  document.querySelectorAll('[data-add-num]').forEach((c, i) =>
    c.classList.toggle('escolhido', i === indice));
  $('add-passo-grupo').style.display = 'block';
  $('btn-add-recomecar').style.display = '';
  $('add-num-nome').textContent = addEscolhido.instancia;
  $('add-filtro').value = '';
  desenharAddGrupos('');
  $('add-filtro').focus();
}

function desenharAddGrupos(filtro) {
  const f = normaliza(filtro);
  const lista = addEscolhido.grupos.filter((g) => !f || normaliza(g.nome).includes(f));
  $('add-grupos').innerHTML = lista.length
    ? lista.map((g) => {
        /*
         * INTERRUPTOR também aqui, não "nada a fazer". A lista serve para
         * DECIDIR o que observar, e um grupo já ligado é justamente o que se
         * pode querer desligar — dizer "nada a fazer" transformava um estado
         * ajustável em beco sem saída, e obrigava a ir procurar o controle
         * noutra tela.
         */
        const jaObservado = !!(g.observado && g.observado.ativo);
        return '<div class="linha-escolha">' +
          '<div><b>' + esc(g.nome) + '</b>' +
          '<div class="nota mono">' + esc(g.jid) + '</div></div>' +
          interruptor(jaObservado,
            'data-obs-jid="' + esc(g.jid) + '" data-obs-inst="' + esc(addEscolhido.instancia) +
            '" data-obs-nome="' + esc(g.nome) + '" data-obs-tipo="promo" data-na-lista="1"',
            'Observar') +
          '</div>';
      }).join('')
    : '<div class="nota" style="padding:12px">nenhum grupo com esse nome.</div>';
}

/** Sem acento e em minúscula — filtrar por nome tem que funcionar com "promocao". */
function normaliza(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function voltarAddNumero() {
  addEscolhido = null;
  document.querySelectorAll('[data-add-num]').forEach((c) => c.classList.remove('escolhido'));
  $('add-passo-grupo').style.display = 'none';
  $('btn-add-recomecar').style.display = 'none';
}

async function observarDaLista(jid, nome) {
  try {
    const r = await enviar('/api/intel/observar', 'POST', {
      jid, nome,
      instancia: addEscolhido ? addEscolhido.instancia : '',
      kind: 'promo',
    });
    msg('g-msg', (r.passos || ['grupo marcado']).join(' · '), r.webhookOk ? 'ok' : 'alerta');
    if (addEscolhido) {
      const g = addEscolhido.grupos.find((x) => x.jid === jid);
      if (g) g.observado = { kind: 'promo', ativo: true };
      desenharAddGrupos($('add-filtro').value);
    }
    carregarGrupos();
  } catch (e) {
    msg('g-msg', e.message, 'err');
  }
}

/* ==================== CONEXÕES: escolha de tela e passos ==================== */

/*
 * A aba abre num MENU, não numa tela cheia. Conectar um número e administrar os
 * que já existem são tarefas diferentes, feitas em momentos diferentes — juntar
 * as duas no mesmo scroll obrigava a percorrer a tarefa que não interessa para
 * chegar na que interessa.
 */
function abrirSubtela(nome) {
  const menu = $('conexoes-menu');
  const a = $('tela-numeros');
  const b = $('tela-conectar');
  if (!menu || !a || !b) return;
  menu.style.display = nome ? 'none' : '';
  a.style.display = nome === 'numeros' ? 'block' : 'none';
  b.style.display = nome === 'conectar' ? 'block' : 'none';
  if (nome === 'numeros') { guardar(carregarNumeros, 'numeros'); guardar(carregarCanais, 'lista-canais'); }
  if (nome === 'conectar') passoConectar(1);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/*
 * Um passo por vez. O seguinte só abre quando o anterior termina, porque a
 * ordem aqui não é sugestão: sem instância criada não há QR, e sem QR lido não
 * há conexão para verificar. Mostrar os três juntos convidava a clicar no 3
 * primeiro e concluir que estava quebrado.
 */
let passoAtual = 1;
function passoConectar(n) {
  passoAtual = n;
  document.querySelectorAll('#passos-conectar .passo').forEach((li) => {
    const p = Number(li.dataset.passo);
    li.classList.toggle('ativo', p === n);
    li.classList.toggle('feito', p < n);
    li.classList.toggle('travado', p > n);
  });
}

/* ==================== INTERRUPTOR DE OBSERVAÇÃO ==================== */

/*
 * ON/OFF de verdade, não uma mensagem depois do clique. O dono pediu assim e
 * está certo: "observar" é um ESTADO do grupo, e estado se mostra com um
 * controle que reflete o estado — não com uma confirmação que some.
 */
function interruptor(ligado, attrs, rotulo) {
  return '<button class="interruptor' + (ligado ? ' on' : '') + '" role="switch" aria-checked="' +
    (ligado ? 'true' : 'false') + '" ' + attrs + '>' +
    '<span class="i-trilho"><span class="i-bola"></span></span>' +
    '<span class="i-rot">' + rotulo + (ligado ? ' ON' : ' OFF') + '</span></button>';
}

async function alternarObservacao(botao) {
  const jid = botao.dataset.obsJid;
  const ligado = botao.getAttribute('aria-checked') === 'true';
  botao.disabled = true;
  try {
    if (ligado) {
      await enviar('/api/intel/observar/' + encodeURIComponent(jid), 'DELETE');
    } else {
      await enviar('/api/intel/observar', 'POST', {
        jid,
        nome: botao.dataset.obsNome,
        instancia: botao.dataset.obsInst,
        kind: botao.dataset.obsTipo || 'promo',
      });
    }
    await carregarNumeros();
  } catch (e) {
    avisarErro(e.message);
    botao.disabled = false;
  }
}

async function alternarDisparo(botao) {
  const ligado = botao.getAttribute('aria-checked') === 'true';
  botao.disabled = true;
  try {
    if (ligado) {
      await api('/api/channels/' + botao.dataset.canalId, { method: 'DELETE' });
    } else {
      await enviar('/api/channels', 'POST', {
        role: 'poster',
        instance_ref: botao.dataset.dispInst,
        target_ref: botao.dataset.dispJid,
        display_name: botao.dataset.dispNome,
      });
    }
    await carregarNumeros();
    carregarCanais();
  } catch (e) {
    avisarErro(e.message);
    botao.disabled = false;
  }
}

/* ==================== SEUS NÚMEROS (Conexões) ==================== */

/*
 * Painel de STATUS por número, não uma lista de grupos.
 *
 * A versão anterior listava os grupos e mais nada — o dono abria a tela e ela
 * não respondia a pergunta que o trouxe ali: "como está esse número?". Agora
 * cada número diz, de cima para baixo: se está conectado, se foi banido, para
 * quantos grupos dispara, quantos observa, quanto já saiu hoje e quando foi o
 * último envio. Os grupos vêm depois, como detalhe.
 */

/** Estado da conexão em linguagem de dono, não da Evolution. */
function estadoDoNumero(n) {
  if (n.banido) {
    return { rot: 'BANIDO', cls: 'corte', exp: 'Algum canal desse número foi marcado como banido. Ele não vai entregar nada.' };
  }
  if (n.conectada) {
    return { rot: 'CONECTADO', cls: 'feito', exp: 'Sessão ativa no WhatsApp.' };
  }
  return {
    rot: 'DESCONECTADO',
    cls: 'neutro',
    exp: 'A sessão caiu ou nunca foi aberta. Pode ser celular sem internet — releia o QR em "Conectar ou criar" se persistir.',
  };
}

async function carregarNumeros(forcar) {
  const alvo = $('numeros');
  if (!alvo) return;
  const r = await api('/api/numeros' + (forcar ? '?atualizar=1' : ''));

  if (r.evolutionConfigurada === false) {
    alvo.innerHTML = vazio('Evolution ainda não configurada',
      r.aviso || 'Preencha a URL e a chave em Config para o painel enxergar seus números.',
      '<button class="btn" data-ir="config">Ir para Config</button>');
    return;
  }
  if (r.error) { alvo.innerHTML = vazio('Não consegui falar com a Evolution', r.error); return; }
  if (!r.numeros.length) {
    alvo.innerHTML = vazio('Nenhum número na Evolution',
      'Crie uma instância e leia o QR para o motor ter por onde falar.',
      '<button class="btn" data-tela="conectar">Conectar um número</button>');
    return;
  }

  alvo.innerHTML = r.numeros.map((n) => {
    const e = estadoDoNumero(n);

    /*
     * As quatro medidas ficam SEMPRE visíveis, inclusive em zero. "0 grupos de
     * disparo" é justamente o diagnóstico mais importante desta tela — some se
     * a gente só mostrar o que existe.
     */
    const placas =
      '<div class="grade-fila">' +
      '<div class="placa"><span class="rot">dispara para</span><span class="num">' + n.disparo + '</span>' +
      '<span class="rot">' + (n.pausados ? n.pausados + ' pausado(s)' : 'grupo(s)') + '</span></div>' +
      '<div class="placa"><span class="rot">observando</span><span class="num">' + n.observados + '</span>' +
      '<span class="rot">grupo(s)</span></div>' +
      '<div class="placa ' + (n.enviadasHoje ? 'feito' : '') + '"><span class="rot">enviadas hoje</span>' +
      '<span class="num">' + n.enviadasHoje + '</span>' +
      '<span class="rot">' + (n.ultimoEnvio ? 'última ' + esc(dataHora(n.ultimoEnvio)) : 'nunca enviou') + '</span></div>' +
      '<div class="placa"><span class="rot">participa de</span><span class="num">' + n.grupos.length + '</span>' +
      '<span class="rot">grupo(s) no total</span></div>' +
      '</div>';

    const grupos = n.grupos.length
      ? n.grupos.map((g) => {
          const tipo = g.canalId ? 'proprio' : 'promo';
          const bDisparo = interruptor(
            !!(g.canalId && g.canalStatus === 'active'),
            'data-disparo="1" data-canal-id="' + esc(g.canalId || '') + '" data-disp-jid="' + esc(g.jid) +
            '" data-disp-inst="' + esc(n.instancia) + '" data-disp-nome="' + esc(g.nome) + '"',
            'Disparo');
          const bObs = interruptor(
            !!(g.observado && g.observado.ativo),
            'data-obs-jid="' + esc(g.jid) + '" data-obs-inst="' + esc(n.instancia) +
            '" data-obs-nome="' + esc(g.nome) + '" data-obs-tipo="' + tipo + '"',
            'Observar');
          const marca = g.canalStatus === 'banned'
            ? ' <span class="tag corte">banido</span>'
            : (g.canalStatus === 'paused' ? ' <span class="tag neutro">pausado</span>' : '');
          return '<div class="linha-grupo"><div><b>' + esc(g.nome) + '</b>' + marca +
            '<div class="nota mono">' + esc(g.jid) + '</div></div>' +
            '<div class="acoes compacta">' + bDisparo + bObs + '</div></div>';
        }).join('')
      : '<div class="nota" style="padding:10px">' +
        (n.conectada
          ? (n.erroGrupos ? 'erro ao listar grupos: ' + esc(n.erroGrupos) : 'esse número não está em nenhum grupo')
          : 'ligue o número para ver os grupos') + '</div>';

    return '<div class="painel cartao-numero">' +
      '<div class="cabeca-numero">' +
      '<span class="led ' + (n.conectada && !n.banido ? '' : 'off') + '"></span>' +
      '<b class="t-titulo" style="margin:0">' + esc(n.instancia) + '</b>' +
      '<span class="tag ' + e.cls + '">' + e.rot + '</span>' +
      '<span class="nota mono">' + (n.numero ? '+' + esc(n.numero) : 'sem número') + '</span>' +
      (n.perfil ? '<span class="nota">' + esc(n.perfil) + '</span>' : '') +
      (n.doCache ? '<span class="nota" title="lista de grupos vinda do cache">· em cache</span>' : '') +
      '</div>' +
      '<div class="nota">' + e.exp + '</div>' +
      placas +
      '<details class="dobravel" style="margin-top:14px"><summary><span class="t-dado">grupos deste número (' +
      n.grupos.length + ')</span></summary>' +
      '<div class="lista-grupos-num">' + grupos + '</div></details>' +
      '</div>';
  }).join('');
}

/* ==================== FILAS POR GRUPO ==================== */

const seg = (s) => {
  const n = Number(s);
  if (!Number.isFinite(n)) return '—';
  if (n < 60) return n + 's';
  const m = Math.round(n / 60);
  return m < 60 ? m + ' min' : (m / 60).toFixed(1) + 'h';
};

/** "em 12 min" em vez de um horário absoluto — é o que o dono quer saber. */
function daquiA(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const d = Math.round((t - Date.now()) / 1000);
  if (d <= 0) return 'agora';
  return 'em ' + seg(d);
}

async function carregarFilas() {
  const canais = await api('/api/channels');
  const posters = (canais || []).filter((c) => c.role === 'poster');
  const alvo = $('filas');
  if (!posters.length) {
    alvo.innerHTML = vazio('Nenhum grupo recebendo ainda',
      'O motor captura e mede preço, mas sem um grupo de destino nada é entregue. Conecte um número e escolha o grupo.',
      '<button class="btn" data-ir="conexoes">Ir para Conexões</button>');
    return;
  }
  const filas = await Promise.all(posters.map((c) =>
    api('/api/channels/' + c.id + '/fila')
      .catch((e) => ({ erro: e.message, canal: { id: c.id, nome: c.display_name } }))));
  alvo.innerHTML = filas.map(desenharFila).join('');
}

function desenharFila(f) {
  if (f.erro) {
    return '<div class="painel"><h3 class="t-titulo">' + esc(f.canal && f.canal.nome || 'canal') + '</h3>' +
      '<div class="nota err">não consegui ler a fila: ' + esc(f.erro) + '</div></div>';
  }
  const c = f.canal;
  const cad = f.cadencia;
  const pausado = c.status !== 'active';
  /*
   * O MOTIVO vem antes do horário. "próximo em 6h" com 19 ofertas na fila
   * parece defeito; "teto diário atingido (250 de 250)" é a mesma informação
   * dizendo que está funcionando exatamente como foi configurado.
   */
  const quando = pausado
    ? '<span class="tag neutro">pausado</span>'
    : (f.motivoParado
        ? '<span class="tag alerta-tag">' + esc(f.motivoParado) + '</span>'
        : '<span class="tag feito">próximo ' + esc(daquiA(f.proximoEm) || '—') + '</span>');

  const proximas = f.proximas.length
    ? '<div class="poco fila-proximas">' + f.proximas.map((o, i) =>
        '<div class="linha-fila"><span class="pos">' + (i + 1) + '</span>' +
        (o.image_url ? '<img src="' + esc(o.image_url) + '" alt="" loading="lazy" />' : '<span class="sem-img"></span>') +
        '<div class="corpo"><div class="t-dado">' + esc(o.title || '(sem título)') + '</div>' +
        '<div class="meta">' + brl(o.price) +
        (o.commission_brl ? ' · ganho ' + brl(o.commission_brl) : '') +
        (o.is_priority ? ' <span class="tag alerta-tag">fura-fila</span>' : '') +
        '</div></div></div>').join('') + '</div>'
    : '<div class="nota" style="padding:10px">Nada esperando. O motor captura a cada 30 minutos.</div>';

  const campo = (rot, campoId, tipo, valor, min, max) =>
    '<div><label>' + rot + '</label><input type="' + tipo + '" ' +
    (tipo === 'number' ? 'min="' + min + '" max="' + max + '" ' : '') +
    'value="' + esc(String(valor)) + '" data-cad="' + c.id + '" data-campo="' + campoId + '" /></div>';

  return '<details class="painel dobravel fila-canal" open>' +
    '<summary><b>' + esc(c.nome || c.grupo || 'grupo') + '</b> ' + quando +
    ' <span class="nota">' + f.naFila + ' na fila · ' + f.enviadasHoje + ' de ' + cad.tetoDiario + ' hoje</span></summary>' +

    '<div class="grade-fila">' +
      '<div class="placa"><span class="rot">na fila</span><span class="num">' + f.naFila + '</span></div>' +
      '<div class="placa feito"><span class="rot">enviadas hoje</span><span class="num">' + f.enviadasHoje + '</span><span class="rot">de ' + cad.tetoDiario + '</span></div>' +
      '<div class="placa"><span class="rot">intervalo</span><span class="num">' + seg(cad.dripMinSec) + '–' + seg(cad.dripMaxSec) + '</span><span class="rot">+ ' + seg(cad.jitterMinSec) + '–' + seg(cad.jitterMaxSec) + ' de jitter</span></div>' +
      '<div class="placa"><span class="rot">silêncio</span><span class="num">' + esc(String(cad.silencioInicio).slice(0, 5)) + '–' + esc(String(cad.silencioFim).slice(0, 5)) + '</span><span class="rot">' + esc(cad.fuso) + '</span></div>' +
    '</div>' +

    '<div class="nota">grupo <span class="mono">' + esc(c.grupo || '—') + '</span> · número <span class="mono">' + esc(c.instancia) + '</span> ' +
    (f.ultimoEnvio ? '· último envio ' + esc(dataHora(f.ultimoEnvio)) : '· nunca enviou') + '</div>' +

    '<h4 class="secao-titulo">próximas a sair, nesta ordem</h4>' + proximas +

    '<details class="dobravel ajuste"><summary><span class="t-dado">ajustar a cadência deste grupo</span></summary>' +
    '<p class="nota" style="margin-top:0">Vale a partir do próximo disparo — o que já está agendado mantém o intervalo anterior.</p>' +
    '<div class="grade">' +
      campo('Intervalo mínimo (min)', 'dripMin', 'number', Math.round(cad.dripMinSec / 60), 1, 1440) +
      campo('Intervalo máximo (min)', 'dripMax', 'number', Math.round(cad.dripMaxSec / 60), 1, 1440) +
      campo('Jitter mínimo (min)', 'jitMin', 'number', Math.round(cad.jitterMinSec / 60), 0, 60) +
      campo('Jitter máximo (min)', 'jitMax', 'number', Math.round(cad.jitterMaxSec / 60), 0, 60) +
      campo('Teto por dia', 'cap', 'number', cad.tetoDiario, 1, 1000) +
      campo('Silêncio começa', 'qStart', 'time', String(cad.silencioInicio).slice(0, 5)) +
      campo('Silêncio termina', 'qEnd', 'time', String(cad.silencioFim).slice(0, 5)) +
    '</div>' +
    '<div class="acoes" style="display:flex;gap:8px;margin-top:12px">' +
      '<button class="btn" data-salvar-cad="' + c.id + '">Salvar cadência</button>' +
      '<button class="btn fantasma" data-canal="' + c.id + '" data-op="' + (pausado ? 'ativar' : 'pausar') + '">' + (pausado ? 'ativar' : 'pausar') + ' este grupo</button>' +
    '</div>' +
    '<div class="nota" id="cad-msg-' + c.id + '"></div>' +
    '</details></details>';
}

async function salvarCadencia(id) {
  const v = (campoId) => {
    const el = document.querySelector('[data-cad="' + id + '"][data-campo="' + campoId + '"]');
    return el ? el.value : '';
  };
  try {
    const r = await enviar('/api/channels/' + id, 'PATCH', {
      cadencia: {
        dripMinSec: Number(v('dripMin')) * 60,
        dripMaxSec: Number(v('dripMax')) * 60,
        jitterMinSec: Number(v('jitMin')) * 60,
        jitterMaxSec: Number(v('jitMax')) * 60,
        tetoDiario: Number(v('cap')),
        silencioInicio: v('qStart'),
        silencioFim: v('qEnd'),
      },
    });
    msg('cad-msg-' + id, r.aviso || 'cadência salva', 'ok');
    carregarFilas();
  } catch (e) {
    msg('cad-msg-' + id, e.message, 'err');
  }
}

/* ==================== DE QUE CADA GRUPO FALA ==================== */

const PERFIL_ROT = {
  especialista: { rot: 'especialista', exp: 'concentra a maior parte do que posta numa categoria só' },
  misto: { rot: 'misto', exp: 'gira em torno de poucas categorias, mas não é de uma só' },
  generalista: { rot: 'generalista', exp: 'posta de tudo um pouco — sem categoria dominante' },
  amostra_pequena: { rot: 'amostra pequena', exp: 'ainda não dá para dizer: poucos posts classificados' },
};

/*
 * Padrão: SÓ SHOPEE. Os grupos postam de várias lojas — o grupo real que o dono
 * mostrou era 10 Amazon + 7 Mercado Livre e zero Shopee. Misturar tudo responde
 * "de que eles falam", não "de que eles falam NA SHOPEE", que é a única parte
 * com que o motor compete. O outro modo fica no interruptor.
 */
let nichoTodas = false;

async function carregarNicho() {
  const alvo = $('nicho');
  if (!alvo) return;
  const r = await api('/api/intel/nicho?dias=30' + (nichoTodas ? '&todas=1' : ''));

  /*
   * Sem a árvore baixada, NENHUM post tem categoria e todos os grupos sairiam
   * como "amostra pequena" — sintoma que parece falta de dado e é falta de um
   * passo de configuração. Dizer qual é vale mais que mostrar zeros.
   */
  if (!r.arvoreSincronizada) {
    alvo.innerHTML = vazio('Categorias da Shopee ainda não baixadas',
      'A categoria de cada oferta vem carimbada pela Shopee, mas o nome dela está numa árvore pública que precisa ser baixada uma vez.',
      '<button class="btn" data-acao="sync-cat">Baixar categorias agora</button>');
    return;
  }
  if (!r.grupos || !r.grupos.length) {
    alvo.innerHTML = vazio('Nenhum grupo observado ainda',
      'Marque grupos para observar e deixe rodar alguns dias — o perfil sai do que eles postam, não de um rótulo escolhido à mão.');
    return;
  }

  const chave = interruptor(!nichoTodas, 'data-nicho-shopee="1"', 'Só Shopee');
  const cabeca = '<div class="cabeca-painel" style="margin-bottom:12px">' + chave +
    '<span class="nota">' + (nichoTodas
      ? 'mostrando TODAS as lojas — o perfil mistura Shopee, Amazon, Mercado Livre…'
      : 'mostrando só o que eles postam DA SHOPEE — é a fatia com que o motor compete') +
    '</span></div>';

  alvo.innerHTML = cabeca + r.grupos.map((g) => {
    const p = PERFIL_ROT[g.perfil] || PERFIL_ROT.amostra_pequena;
    const barras = g.categorias.length
      ? '<div class="barras-cat">' + g.categorias.map((c) =>
          '<div class="barra-cat"><span class="bc-nome">' + esc(c.nome) + '</span>' +
          '<span class="bc-trilho"><i style="width:' + c.pct + '%"></i></span>' +
          '<span class="bc-n">' + c.pct + '%</span></div>').join('') + '</div>'
      : '<div class="nota">nenhum post classificado ainda</div>';

    /*
     * `postsClassificados` de `postsTotal` fica SEMPRE visível. Só dá para
     * classificar post que casou com uma observação da API — post de Amazon ou
     * Mercado Livre fica de fora. Um perfil calculado sobre 12 de 300 posts não
     * é o perfil do grupo, e esconder o denominador transformaria isso numa
     * afirmação que o dado não sustenta.
     */
    return '<div class="painel">' +
      '<div class="cabeca-painel"><h3 class="t-titulo">' + esc(g.nome) + '</h3>' +
      '<span class="tag ' + (g.perfil === 'amostra_pequena' ? 'neutro' : 'eles') + '">' + p.rot + '</span></div>' +
      '<div class="nota" style="margin-top:0">' + p.exp + '</div>' +
      '<div class="nota">' + g.postsClassificados + ' de ' + g.postsTotal +
      ' posts classificados · ' + g.categoriasDistintas + ' categoria(s)' +
      (g.concentracao != null ? ' · concentração ' + g.concentracao : '') + '</div>' +
      barras + plataformasDe(g) + '</div>';
  }).join('');
}

/*
 * De que LOJAS o grupo posta. Calculado sempre sobre tudo, mesmo com o filtro
 * ligado — é isto que explica "só 12 de 300 classificados": pode ser matcher
 * fraco, ou pode ser que 288 eram de outra loja. As duas leituras levam a
 * decisões opostas, e sem esta linha não dá para distinguir.
 */
function plataformasDe(g) {
  if (!g.plataformas || !g.plataformas.length) return '';
  const fatias = g.plataformas.map((p) =>
    '<span class="fatia-plat' + (p.nome === 'shopee' ? ' shopee' : '') + '">' +
    esc(p.nome) + ' ' + p.pct + '%</span>').join('');
  return '<div class="nota" style="margin-top:10px">de onde vêm os ' + g.postsNaJanela +
    ' posts: <span class="plats">' + fatias + '</span></div>';
}

/* ==================== DE ONDE VEM A OFERTA DELES ==================== */

const VEREDITO_REDE = {
  fonte_via_api: { rot: 'usa a API', cor: 'entrada', exp: 'posta cedo depois de a oferta existir no cardápio, e chega antes dos outros' },
  fonte_propria: { rot: 'fonte própria', cor: 'eles', exp: 'chega antes dos outros, mas o cardápio não explica — tem outra fonte ou escolhe antes' },
  eco: { rot: 'ecoa outro grupo', cor: 'neutro', exp: 'a maioria do que posta já tinha saído em outro grupo que você observa' },
  misto: { rot: 'misto', cor: 'neutro', exp: 'parte própria, parte eco — sem padrão dominante' },
  rede_pequena: { rot: 'faltam grupos', cor: 'neutro', exp: 'com um grupo só não dá para saber quem copia quem' },
  sem_dados: { rot: 'sem posts', cor: 'neutro', exp: 'nada coletado nesta janela' },
};

async function carregarRede() {
  const dias = $('i-dias') ? $('i-dias').value : 14;
  const r = await api('/api/intel/rede?dias=' + encodeURIComponent(dias));
  const alvo = $('rede');

  if (!r.gruposObservados) {
    alvo.innerHTML = vazio('Nenhum grupo sendo observado',
      'Marque grupos para observar em Conexões — o botão "observar" fica ao lado de cada grupo do seu número.',
      '<button class="btn" data-ir="conexoes">Ir para Conexões</button>');
    return;
  }

  /*
   * O AVISO vem antes dos números, não depois. Com um grupo só, "100% primeiro
   * na rede" é verdade trivial e leria como "esse grupo é a fonte" — conclusão
   * confiante e sem base. Melhor dizer que a pergunta ainda não tem resposta.
   */
  const aviso = !r.comparavel
    ? '<div class="nota alerta" style="margin-bottom:14px">Você observa ' + r.gruposObservados +
      ' grupo. "Quem copia quem" só existe comparando grupos — marque pelo menos mais um para esta análise valer.</div>'
    : '<div class="nota" style="margin-bottom:14px">Lido sobre ' + r.gruposObservados +
      ' grupos observados, nos últimos ' + r.dias + ' dias. <b>"Primeiro" significa primeiro entre os grupos que VOCÊ observa</b> — ' +
      'um grupo pode parecer fonte só porque a fonte real não está na sua lista.</div>';

  const cartoes = r.grupos.map((g) => {
    const v = VEREDITO_REDE[g.veredito] || VEREDITO_REDE.misto;
    const pct = (n) => (g.posts ? Math.round((n / g.posts) * 100) : 0);
    const barra = g.posts
      ? '<div class="barra-origem">' +
        '<i class="own" style="width:' + pct(g.primeiroNaRede) + '%" title="' + g.primeiroNaRede + ' primeiro na rede"></i>' +
        '<i class="eco" style="width:' + pct(g.ecoDeOutro) + '%" title="' + g.ecoDeOutro + ' ecoando outro grupo"></i>' +
        '</div>' +
        '<div class="nota">' + pct(g.primeiroNaRede) + '% chegou primeiro · ' + pct(g.ecoDeOutro) + '% veio depois de outro grupo</div>'
      : '';

    const linhaApi = g.casadosComApi
      ? '<div class="nota">' + g.casadosComApi + ' de ' + g.posts + ' casaram com o cardápio da API' +
        (g.atrasoApiMediano != null ? ' · atraso mediano ' + seg(g.atrasoApiMediano) : '') + '</div>'
      : '<div class="nota">nenhum post casou com o cardápio da API nesta janela</div>';

    const linhaEco = g.ecoPrincipal
      ? '<div class="nota corte-txt">ecoa principalmente <b>' + esc(g.ecoPrincipal.nome) + '</b> (' +
        g.ecoPrincipal.vezes + '×' + (g.atrasoEcoMediano != null ? ', ~' + seg(g.atrasoEcoMediano) + ' depois' : '') + ')</div>'
      : '';

    return '<div class="painel cartao-origem">' +
      '<div class="cabeca-painel"><h3 class="t-titulo">' + esc(g.nome) + '</h3>' +
      '<span class="tag ' + v.cor + '">' + v.rot + '</span></div>' +
      '<div class="nota" style="margin-top:0">' + v.exp + '</div>' +
      '<div class="nota mono">' + g.posts + ' post(s) na janela · tipo ' + esc(g.kind) + '</div>' +
      barra + linhaApi + linhaEco + '</div>';
  }).join('');

  const rede = r.arestas.length
    ? '<h2 class="secao-titulo">quem chega depois de quem</h2><div class="poco">' +
      r.arestas.map((a) =>
        '<div class="linha-aresta"><b>' + esc(a.deNome) + '</b>' +
        '<span class="seta">↤</span>' +
        '<b>' + esc(a.paraNome) + '</b>' +
        '<span class="nota">' + a.vezes + '× · ~' + seg(a.atrasoMediano) + ' depois</span></div>').join('') +
      '</div>'
    : '';

  alvo.innerHTML = aviso + '<div class="grade-origem">' + cartoes + '</div>' + rede;
}

/* ==================== SUB-ABAS DO FEED ==================== */

/*
 * O Feed responde "o que o motor capturou". O Monitor responde "quanto isso
 * custava antes". Mesma matéria-prima, perguntas diferentes — e por isso
 * sub-aba, não aba própria: quem está olhando uma oferta quer o histórico dela
 * ali, não a três cliques de distância.
 */
let subAba = 'ofertas';

function trocarSubAba(qual, empurrar = true) {
  subAba = qual === 'monitor' ? 'monitor' : 'ofertas';
  document.querySelectorAll('#feed-subabas .pilula').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.subaba === subAba)));
  $('sub-ofertas').style.display = subAba === 'ofertas' ? '' : 'none';
  $('sub-monitor').style.display = subAba === 'monitor' ? '' : 'none';
  // A sub-aba é rota de verdade: dá para linkar, o voltar do navegador funciona,
  // e a tela existe sem depender de um clique para ser vista.
  if (empurrar) {
    const caminho = subAba === 'monitor' ? '/feed/monitor' : '/feed';
    if (location.pathname !== caminho) history.pushState({ secao: 'feed', subAba }, '', caminho);
  }
  carregarSecao('feed');
}

/** Resolve caminho -> seção, entendendo a sub-aba do Feed. */
function rotaDe(caminho) {
  if (caminho === '/feed/monitor') { subAba = 'monitor'; return 'feed'; }
  if (caminho === '/feed') subAba = 'ofertas';
  return ROTA[caminho] || 'visao';
}

/* ==================== MONITOR DE PREÇOS ==================== */

let pmConfiavel = false;
let pmAberto = null;

async function carregarPrecos() {
  const dias = $('pm-janela').value;
  const r = await api('/api/precos/oportunidades?dias=' + dias +
    '&limite=40' + (pmConfiavel ? '&confiavel=1' : ''));

  /*
   * O RESUMO vem antes da lista de propósito. Um monitor de preço jovem tem
   * pouco a dizer, e o dono precisa saber ANTES de ler qualquer ranking há
   * quantos dias ele está coletando — senão lê "36% abaixo da média" apoiado
   * em três dias e trata como verdade.
   */
  const s = r.resumo || {};
  const desde = s.desde ? new Date(s.desde) : null;
  const diasColetando = desde ? Math.max(1, Math.round((Date.now() - desde.getTime()) / 86400000)) : 0;
  $('pm-resumo').innerHTML = [
    ['produtos no monitor', inteiro(s.produtos)],
    ['com série formada', inteiro(s.com_serie)],
    ['mudanças de preço registradas', inteiro(s.pontos)],
    ['coletando há', diasColetando + (diasColetando === 1 ? ' dia' : ' dias')],
  ].map(([rot, val]) =>
    // .n/.l é o vocabulário de .placar; .num/.rot só existe dentro de .grade-fila.
    // Trocado, os spans ficam sem estilo e número e rótulo colam na mesma linha.
    '<div class="placa"><div class="n">' + esc(val) + '</div><div class="l">' + rot + '</div></div>',
  ).join('');

  /*
   * O AVISO de juventude é a peça mais importante desta tela nas primeiras
   * semanas. O dono disse, com razão, que mostrar correlação de 3 dias é
   * inútil — então a tela diz isso em voz alta em vez de deixar o número
   * parecer maduro.
   */
  $('pm-aviso').innerHTML = diasColetando < 14
    ? '<div class="nota alerta" style="margin:12px 0">O monitor está coletando há ' +
      diasColetando + (diasColetando === 1 ? ' dia' : ' dias') +
      '. Os números abaixo são reais, mas ainda descrevem uma janela curta — ' +
      '"abaixo da média" com poucos dias de base diz mais sobre a coleta que sobre o mercado. ' +
      'Isso melhora sozinho: nada precisa ser feito, só deixar rodar.</div>'
    : '';

  const linhas = r.oportunidades || [];
  if (!linhas.length) {
    $('pm-lista').innerHTML = vazio('Nenhuma oportunidade na janela',
      Number(s.produtos) > 0
        ? 'Há ' + s.produtos + ' produtos no monitor, mas nenhum está abaixo da própria média nesta janela. Tente uma janela maior.'
        : 'O monitor ainda não tem produtos. Ele se alimenta da varredura de inteligência, que roda de 2 em 2 horas — ou importe agora o histórico já observado.');
    return;
  }

  $('pm-lista').innerHTML = linhas.map((o) => {
    const abaixo = Number(o.abaixo_pct);
    const conf = o.confiavel === 'true' || o.confiavel === true;
    return '<article class="linha-item ' + (o.image_url ? '' : 'sem-foto') + '" data-pm-produto="' + esc(o.product_id) + '">' +
      (o.image_url ? '<img src="' + esc(o.image_url) + '" alt="" loading="lazy" />' : '') +
      '<div class="corpo">' +
      '<div class="t-titulo">' + esc(o.title || '(sem título)') + '</div>' +
      '<div class="preco-linha"><b class="preco-agora">' + brl(o.preco_atual) + '</b>' +
      '<span class="queda">▼ ' + (Number.isFinite(abaixo) ? abaixo.toFixed(0) : '?') + '%</span>' +
      '<span class="nota">média ' + o.dias + 'd ' + brl(o.media) +
      ' · mínimo ' + brl(o.preco_min) + '</span></div>' +
      '<div class="meta">' +
      /*
       * A COBERTURA fica ao lado do número, não escondida. É ela que diz se o
       * "36% abaixo" vale — e é justamente o que um comparador de preço
       * costuma omitir.
       */
      '<span>' + (conf
        ? '<span class="tag feito">' + o.dias + ' dias de histórico</span>'
        : '<span class="tag neutro">só ' + o.dias + ' dia(s) — pouca base</span>') + '</span>' +
      (o.cat_raiz ? '<span>' + esc(o.cat_raiz) + '</span>' : '') +
      '<span>' + inteiro(o.mudancas) + ' mudanças</span></div>' +
      '</div></article>';
  }).join('');
}

/**
 * A FICHA: a série em degraus.
 *
 * Degraus e não linha interpolada porque cada ponto é uma MUDANÇA — o preço
 * ficou parado entre um e outro. Uma linha diagonal afirmaria uma transição
 * suave que nunca existiu, e é exatamente o tipo de gráfico bonito que mente.
 */
async function abrirFichaPreco(productId) {
  if (pmAberto === productId) { pmAberto = null; $('pm-ficha').innerHTML = ''; return; }
  pmAberto = productId;
  $('pm-ficha').innerHTML = '<div class="nota" style="padding:14px">carregando o histórico…</div>';
  let f;
  try {
    f = await api('/api/precos/produto/' + encodeURIComponent(productId) + '?dias=' + $('pm-janela').value);
  } catch (e) {
    $('pm-ficha').innerHTML = '<div class="nota err" style="padding:14px">' + esc(e.message) + '</div>';
    return;
  }

  /*
   * A LINHA SAI DO `diario`, NÃO do log de mudanças — e é isso que mantém a
   * faixa de cobertura alinhada com ela: as duas leem o MESMO array, no mesmo
   * eixo de tempo. Desenhar a linha no eixo do log (que começa na primeira
   * mudança dentro da janela) por cima de uma faixa que começa no início da
   * janela alinharia visualmente duas escalas de tempo diferentes, e
   * alinhamento visual afirma simultaneidade.
   *
   * `diario` já É uma função em degraus: cada dia carrega o preço vigente
   * naquele dia, com `visto` dizendo se houve leitura própria.
   */
  const diario = f.diario || [];

  /*
   * `Number(null)` é 0, NÃO NaN — e `Number.isFinite(0)` é true. Dia anterior
   * ao início do histórico vem como `preco: null`, então sem esta guarda cada
   * um deles entrava no gráfico como R$ 0,00: o domínio do eixo passava a
   * começar em zero, a linha inteira era esmagada numa faixa fina no topo e
   * caía num penhasco até o chão. Com janela de 90 dias num monitor de poucos
   * dias, isso é a MAIORIA dos dias de quase todo produto — não um canto.
   */
  const preco = (x) => (x == null || x === '' ? NaN : Number(x));

  const comPreco = diario
    .map((linha, i) => ({
      i,
      dia: linha.dia,
      v: preco(linha.preco),
      visto: linha.visto === 'true' || linha.visto === true,
    }))
    .filter((p) => Number.isFinite(p.v));

  /*
   * O DOMÍNIO do eixo Y inclui o mínimo e o máximo da JANELA — os mesmos
   * números que as placas mostram acima. Duas razões, as duas necessárias:
   * a linha do mínimo tem de CABER dentro do desenho (fora do domínio ela
   * sairia do viewBox e desapareceria), e o eixo passa a ser derivável dos
   * mesmos números que o dono lê logo acima, em vez de ser uma segunda conta
   * capaz de divergir da primeira e contradizê-la na mesma tela.
   */
  const dominio = comPreco.map((p) => p.v)
    .concat([f.minimo, f.maximo].map(preco).filter(Number.isFinite));
  const pisoDado = dominio.length ? Math.min(...dominio) : 0;
  const tetoDado = dominio.length ? Math.max(...dominio) : 1;

  /*
   * FOLGA de 8% além dos extremos, e ela não é estética.
   *
   * Sem folga, o mínimo da janela cai EXATAMENTE no piso do desenho: a linha do
   * menor preço passa a coincidir com a borda inferior da moldura e deixa de
   * ser lida como referência — vira o próprio quadro. O pico do máximo encosta
   * na borda de cima pelo mesmo motivo. Com folga, as duas ficam dentro, e o
   * rótulo pousa exato sobre a linha em vez de ter de ser empurrado para dentro.
   */
  const folga = ((tetoDado - pisoDado) || Math.abs(tetoDado) || 1) * 0.08;
  const yMin = pisoDado - folga;
  const yMax = tetoDado + folga;
  const yFaixa = (yMax - yMin) || 1;

  /*
   * Viewbox largo e baixo, esticado sem preservar proporção (o CSS já conta
   * por quê). A margem de 4 em cima e embaixo existe para o traço do extremo
   * não ser cortado pela borda — sem ela, o preço máximo aparece serrado.
   */
  const W = 1000, H = 100, MARGEM = 4;
  const px = (i) => (diario.length > 1 ? (i / (diario.length - 1)) * W : W / 2);
  const py = (v) => MARGEM + (1 - (v - yMin) / yFaixa) * (H - MARGEM * 2);

  /*
   * DEGRAUS e não linha interpolada: anda na horizontal no preço ANTIGO e só
   * então sobe ou desce. Uma diagonal afirmaria uma transição gradual que
   * nunca existiu — o preço pulou.
   */
  let caminho = '';
  comPreco.forEach((p, k) => {
    const x = px(p.i);
    if (k === 0) { caminho = 'M' + x.toFixed(1) + ',' + py(p.v).toFixed(1); return; }
    caminho += ' L' + x.toFixed(1) + ',' + py(comPreco[k - 1].v).toFixed(1) +
               ' L' + x.toFixed(1) + ',' + py(p.v).toFixed(1);
  });
  // O último preço vigora até hoje: prolonga até a borda em vez de parar no ar.
  if (comPreco.length) {
    caminho += ' L' + W + ',' + py(comPreco[comPreco.length - 1].v).toFixed(1);
  }

  /*
   * Os rótulos nomeiam os extremos REAIS na altura real deles — não o teto e o
   * piso do domínio, que agora têm folga. Rotular a moldura com o valor do dado
   * seria afirmar um preço que nunca existiu.
   */
  const minJanela = Number.isFinite(preco(f.minimo)) ? preco(f.minimo) : pisoDado;
  const maxJanela = Number.isFinite(preco(f.maximo)) ? preco(f.maximo) : tetoDado;
  const yLinhaMin = dominio.length ? py(minJanela) : null;

  /*
   * ALVOS DE HOVER: um retângulo invisível por dia, com `<title>`. É o mesmo
   * recurso que a travessia usa — sem biblioteca e sem estado — e resolve o
   * problema de um gráfico de 90 dias em que não se consegue ler um dia
   * específico. O alvo é a coluna inteira, muito maior que o traço.
   */
  const largDia = diario.length > 1 ? W / (diario.length - 1) : W;
  const alvos = diario.map((linha, i) => {
    const v = preco(linha.preco);
    const visto = linha.visto === 'true' || linha.visto === true;
    const rot = Number.isFinite(v)
      ? linha.dia + ' · ' + brl(v) + (visto ? '' : ' · preço vigente, sem leitura nesse dia')
      : linha.dia + ' · sem dado';
    return '<rect class="alvo-dia" x="' + Math.max(0, px(i) - largDia / 2).toFixed(1) +
      '" y="0" width="' + largDia.toFixed(1) + '" height="' + H + '">' +
      '<title>' + esc(rot) + '</title></rect>';
  }).join('');

  /*
   * A COBERTURA saiu de dentro do gráfico de preço e virou uma faixa própria.
   *
   * Antes ela era a ALTURA de barras cuja base começava no menor preço, não em
   * zero: uma queda de 3% desenhava uma barra com metade da altura da vizinha.
   * Comprimento de barra tem de medir magnitude a partir do zero; posição pode
   * medir valor em qualquer faixa. Por isso o preço virou linha (posição) e a
   * cobertura virou faixa categórica — cada uma na geometria que não mente.
   *
   * Lido / herdado / sem dado se distinguem por TEXTURA e vêm com legenda: o
   * cinza do "herdado" dá 2,88:1 sobre o poço, abaixo do mínimo de 3:1 para
   * elemento gráfico, então cor sozinha não podia carregar a distinção.
   */
  const cobertura = diario.map((linha) => {
    const v = preco(linha.preco);
    const visto = linha.visto === 'true' || linha.visto === true;
    const cls = !Number.isFinite(v) ? 'sem-dado' : (visto ? 'lido' : 'herdado');
    const rot = !Number.isFinite(v)
      ? linha.dia + ' — sem dado'
      : linha.dia + ' · ' + brl(v) + (visto ? ' · leitura nossa nesse dia' : ' · preço vigente, sem leitura');
    return '<span class="cob-dia ' + cls + '" title="' + esc(rot) + '"></span>';
  }).join('');

  const grupos = (f.emGrupos || []).length
    ? '<div class="poco" style="margin-top:10px">' + f.emGrupos.map((g) =>
        '<div class="linha-grupo"><div><b>' + esc(g.grupo) + '</b>' +
        (g.kind === 'proprio' ? ' <span class="tag nos">seu grupo</span>' : '') +
        '<div class="nota">' + esc(dataHora(g.posted_at)) +
        (g.preco_post ? ' · postaram por ' + brl(g.preco_post) : '') +
        /* `duracao` e não `seg`: é o helper da casa ("1 h 30", não "1.5h"), o
           mesmo que a travessia usa. E a checagem é `!= null` porque o lag vem
           como TEXTO do SQL — com `g.lag` puro, um atraso de 0 s some quando
           chega como número e aparece quando chega como "0". */
        (g.lag != null
          ? ' · ' + duracao(Math.abs(Number(g.lag))) +
            (Number(g.lag) >= 0 ? ' depois que a API ofertou' : ' ANTES de a gente ver')
          : '') +
        '</div></div></div>').join('') + '</div>'
    : '<div class="nota" style="padding:10px">Nenhum grupo observado postou este produto na janela.</div>';

  const nossos = (f.nossosEnvios || []).length
    ? '<div class="poco" style="margin-top:10px">' + f.nossosEnvios.map((e) =>
        '<div class="linha-grupo"><div><b>' + esc(e.grupo || 'canal removido') + '</b>' +
        '<div class="nota">' + esc(dataHora(e.sent_at)) +
        (e.preco ? ' · enviado por ' + brl(e.preco) : '') + '</div></div></div>').join('') + '</div>'
    : '';

  /*
   * Rótulo preso à altura do próprio valor, mas travado dentro do desenho: sem
   * o teto, o rótulo do preço máximo (que fica a 4% do topo) sairia metade para
   * fora da moldura.
   */
  const topoPct = (y) => Math.min(93, Math.max(7, (y / H) * 100)).toFixed(1);

  $('pm-ficha').innerHTML =
    '<h2 class="secao-titulo">histórico de ' + esc(f.title || productId) + '</h2>' +
    '<div class="painel">' +
    '<div class="grade-fila">' +
    '<div class="placa"><span class="rot">agora</span><span class="num">' + brl(f.precoAtual) + '</span></div>' +
    '<div class="placa"><span class="rot">média (' + f.janelaDias + 'd)</span><span class="num">' + brl(f.mediaPonderada) + '</span>' +
    '<span class="rot">ponderada por tempo</span></div>' +
    '<div class="placa"><span class="rot">menor</span><span class="num">' + brl(f.minimo) + '</span></div>' +
    '<div class="placa"><span class="rot">maior</span><span class="num">' + brl(f.maximo) + '</span></div>' +
    '</div>' +

    '<h4 class="secao-titulo">preço no tempo</h4>' +
    (comPreco.length
      ? '<div class="grafico-envelope">' +
          '<svg class="grafico-preco" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" ' +
          'role="img" aria-label="Preço em degraus ao longo de ' + diario.length +
          ' dias. Menor preço da janela: ' + brl(f.minimo) + '. Preço atual: ' + brl(f.precoAtual) + '.">' +
          (yLinhaMin != null
            ? '<line class="linha-min" x1="0" y1="' + yLinhaMin.toFixed(1) +
              '" x2="' + W + '" y2="' + yLinhaMin.toFixed(1) + '"/>'
            : '') +
          '<path class="degraus" d="' + caminho + '"/>' +
          alvos +
          '</svg>' +
          '<span class="rot-eixo" style="top:' + topoPct(py(maxJanela)) + '%">' + brl(maxJanela) + '</span>' +
          (yLinhaMin != null
            ? '<span class="rot-eixo menor" style="top:' + topoPct(yLinhaMin) + '%">menor ' +
              brl(minJanela) + '</span>'
            : '') +
        '</div>' +
        '<div class="eixo-preco"><span>' + esc(diario[0].dia) + '</span>' +
        '<span>' + esc(diario[diario.length - 1].dia) + '</span></div>' +

        '<div class="faixa-cobertura" role="img" aria-label="Cobertura por dia: ' +
        f.diasCobertos + ' de ' + diario.length + ' dias com leitura própria">' + cobertura + '</div>' +
        '<div class="legenda-cores blocos">' +
          '<span><i class="lido"></i> leitura nossa</span>' +
          '<span><i class="herdado"></i> preço vigente, sem leitura</span>' +
          '<span><i class="sem-dado"></i> sem dado</span>' +
        '</div>'
      : '<div class="nota" style="padding:10px">Sem histórico ainda.</div>') +

    '<div class="nota" style="margin-top:10px">' +
    (f.confiavel
      ? '<span class="ok">' + f.diasCobertos + ' dias com observação — base suficiente para comparar.</span>'
      : '<span class="alerta">Só ' + f.diasCobertos + ' dia(s) com observação nesta janela. ' +
        'Os números aparecem, mas ainda não sustentam "menor preço do período".</span>') +
    '</div>' +

    '<h4 class="secao-titulo">apareceu em grupo observado</h4>' + grupos +
    (nossos ? '<h4 class="secao-titulo">o motor enviou</h4>' + nossos : '') +
    '</div>';

  $('pm-ficha').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
    avisarErro(e.message);
    b.disabled = false;
    b.textContent = antes;
  }
}

/* Delegação de eventos: o conteúdo é reescrito o tempo todo, então
   ouvir no documento evita religar handler a cada render. */
document.addEventListener('click', async (ev) => {
  /*
   * Copiar-para-área-de-transferência, delegado. Antes era um botão com id
   * fixo para um único endereço; virou padrão porque a tela tem MAIS de um
   * valor longo-com-segredo cuja única ação é colar noutro lugar. O aviso vai
   * no PRÓPRIO botão: a caixa de mensagem original ficava numa seção diferente
   * daquela em que o segundo botão vive.
   */
  const btnCopiar = ev.target.closest('[data-copiar]');
  if (btnCopiar) {
    const alvoTxt = $(btnCopiar.dataset.copiar);
    // O rótulo original vai para um atributo na PRIMEIRA vez. Lendo de
    // `textContent` a cada clique, um segundo clique dentro da janela de 1,8s
    // capturava "copiado" como se fosse o original e o botão ficava travado
    // nesse texto até o próximo render.
    if (!btnCopiar.dataset.rotulo) btnCopiar.dataset.rotulo = btnCopiar.textContent;
    const rotulo = btnCopiar.dataset.rotulo;
    try {
      await navigator.clipboard.writeText(alvoTxt ? alvoTxt.textContent : '');
      btnCopiar.textContent = 'copiado';
    } catch {
      // clipboard exige contexto seguro (https) — em http a promessa rejeita.
      btnCopiar.textContent = 'selecione e copie';
    }
    // Cancela o timer do clique anterior: sem isto, cliques em t=0 e t=1000
    // faziam o primeiro timer apagar o "copiado" do segundo aos 800ms.
    clearTimeout(Number(btnCopiar.dataset.timer) || 0);
    btnCopiar.dataset.timer = String(setTimeout(() => { btnCopiar.textContent = rotulo; }, 1800));
    return;
  }

  // Salvar cadência sai antes: é o único que lê vários campos de uma vez.
  const btnCad = ev.target.closest('[data-salvar-cad]');
  if (btnCad) return salvarCadencia(btnCad.dataset.salvarCad);

  // Interruptores (estado, não ação) e navegação entre as subtelas de Conexões.
  const sw = ev.target.closest('.interruptor');
  if (sw) {
    if (sw.dataset.nichoShopee) { nichoTodas = !nichoTodas; return carregarNicho(); }
    if (sw.dataset.meuGrupo) return alternarMeuGrupo(sw);
    return sw.dataset.disparo ? alternarDisparo(sw) : alternarObservacao(sw);
  }
  const nova = ev.target.closest('[data-nova-etiq]');
  if (nova) return novaEtiqueta(nova.dataset.novaEtiq);

  const addNum = ev.target.closest('[data-add-num]');
  if (addNum) return abrirAddGrupos(Number(addNum.dataset.addNum));
  const addJid = ev.target.closest('[data-add-jid]');
  if (addJid) return observarDaLista(addJid.dataset.addJid, addJid.dataset.addNome);
  if (ev.target.closest('#btn-add-recomecar')) return voltarAddNumero();

  const sub = ev.target.closest('[data-subaba]');
  if (sub) return trocarSubAba(sub.dataset.subaba);

  const prod = ev.target.closest('[data-pm-produto]');
  if (prod) return abrirFichaPreco(prod.dataset.pmProduto);
  if (ev.target.closest('#pm-confiavel')) {
    pmConfiavel = !pmConfiavel;
    $('pm-confiavel').setAttribute('aria-pressed', String(pmConfiavel));
    return carregarPrecos();
  }

  const cartao = ev.target.closest('[data-tela]');
  if (cartao) return abrirSubtela(cartao.dataset.tela);
  if (ev.target.closest('[data-voltar-conexoes]')) return abrirSubtela(null);

  const alvo = ev.target.closest('[data-acao],[data-ir],[data-oferta],[data-canal],[data-grupo],[data-post],[data-fila-de],[data-ligar],[data-observar]');
  if (!alvo) return;

  if (alvo.dataset.ir) return abrir(alvo.dataset.ir, true);

  /*
   * "ver fila" leva para a aba Filas. Ela mostra TODOS os grupos; abrir só um
   * exigiria estado de seleção que ninguém pediu, e a tela já é dobrável.
   */
  if (alvo.dataset.filaDe) return abrir('filas', true);

  // "fazer disparar": registra o grupo como canal direto da lista do número.
  if (alvo.dataset.ligar) {
    try {
      await enviar('/api/channels', 'POST', {
        role: 'poster',
        instance_ref: alvo.dataset.inst,
        target_ref: alvo.dataset.ligar,
        display_name: alvo.dataset.nome,
      });
      await carregarNumeros();
      carregarCanais();
    } catch (e) { avisarErro(e.message); }
    return;
  }

  const acao = alvo.dataset.acao;
  if (acao === 'numeros') return carregarNumeros(true);
  if (acao === 'pm-backfill') {
    try {
      const r = await enviar('/api/precos/backfill', 'POST');
      await avisar('Histórico importado',
        r.inseridas + ' pontos de preço trazidos do que já havia sido observado.',
        'Isso dá ao monitor um passado no dia em que ele nasce. Mas atenção: são poucas horas de janela, não semanas — o histórico de verdade se forma com o tempo.');
      carregarPrecos();
    } catch (e) { avisarErro(e.message); }
    return;
  }
  if (acao === 'sync-cat') {
    try {
      const r = await enviar('/api/shopee/categorias/sync', 'POST');
      await avisar('Categorias baixadas',
        r.nivel1 + ' categorias principais e ' + r.nivel2 + ' subcategorias, direto da árvore oficial da Shopee.',
        'A partir de agora cada oferta capturada recebe a categoria carimbada pela própria Shopee.');
      carregarNicho();
    } catch (e) { avisarErro(e.message); }
    return;
  }
  if (acao === 'recarregar') return recarregar();
  if (acao === 'ciclo') return buscarAgora();
  if (acao === 'limpar-filtros') return limparFiltros();
  if (acao === 'varredura') {
    try {
      await enviar('/api/intel/sweep', 'POST');
      avisar('A varredura foi iniciada',
        'Ela percorre todas as palavras-chave na API da Shopee e leva alguns minutos.',
        'Pode fechar esta tela — o trabalho roda no servidor e continua sozinho. Os números aparecem na aba Inteligência quando terminar.');
    }
    catch (e) { avisarErro(e.message); }
    return;
  }

  try {
    if (alvo.dataset.oferta) {
      await enviar(`/api/offers/${alvo.dataset.oferta}/${alvo.dataset.op}`, 'POST');
      return recarregar();
    }
    if (alvo.dataset.canal) {
      const id = alvo.dataset.canal;
      // A aba Filas rotula o botão em português ("pausar"/"ativar"); a API quer
      // o estado final. Traduz aqui em vez de duplicar o texto do botão.
      if (alvo.dataset.op === 'pausar' || alvo.dataset.op === 'ativar') {
        await enviar('/api/channels/' + id, 'PATCH', {
          status: alvo.dataset.op === 'pausar' ? 'paused' : 'active',
        });
        return carregarFilas();
      }
      if (alvo.dataset.op === 'remover') {
        if (!(await confirmar('Remover este canal de disparo?',
          'O motor para de postar nesse grupo.',
          'O histórico de envios desse canal também é apagado. O grupo em si continua existindo no WhatsApp.'))) return;
        await api('/api/channels/' + id, { method: 'DELETE' });
      } else {
        await enviar('/api/channels/' + id, 'PATCH', { status: alvo.dataset.op });
      }
      return carregarCanais();
    }
    if (alvo.dataset.grupo) {
      const id = alvo.dataset.grupo;
      if (alvo.dataset.op === 'remover') {
        if (!(await confirmar('Remover este grupo observado?',
          'Some o grupo e TODOS os posts já capturados dele.',
          'Isso apaga o histórico usado nas análises de nicho e de quem-copia-quem. Se você só quer parar de coletar, use o interruptor Observar em vez de remover.'))) return;
        await api('/api/intel/groups/' + id, { method: 'DELETE' });
      } else {
        await enviar('/api/intel/groups/' + id, 'PATCH', { is_active: alvo.dataset.op === 'ativar' });
      }
      return carregarGrupos();
    }
    if (alvo.dataset.post) {
      alvo.disabled = true;
      const r = await enviar(`/api/intel/posts/${alvo.dataset.post}/rematch`, 'POST');
      await avisar('Post recorrelacionado',
        'Resultado: ' + r.verdict + (r.confidence != null ? ' (confiança ' + (r.confidence * 100).toFixed(0) + '%)' : ''));
      return carregarCorrelacao($('i-dia').value);
    }
  } catch (e) {
    avisarErro(e.message);
  }
});

document.addEventListener('change', async (ev) => {
  const selEtiq = ev.target.closest('[data-etiq-de]');
  if (selEtiq) return aplicarEtiqueta(selEtiq.dataset.etiqDe, selEtiq.value);

  const sel = ev.target.closest('[data-kind-de]');
  if (!sel) return;
  try {
    await enviar('/api/intel/groups/' + sel.dataset.kindDe, 'PATCH', { kind: sel.value });
    carregarGrupos();
  } catch (e) { avisarErro(e.message); }
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
  window.addEventListener('popstate', () => {
    const secao = rotaDe(location.pathname);
    trocarSubAba(subAba, false);
    abrir(secao, false);
  });

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
    if (!(await confirmar('Limpar o feed?',
      'Apaga as ofertas capturadas que ainda não foram enviadas.',
      'O histórico de preço é PRESERVADO — é ele que mede desconto real, e sem ele o motor volta a acreditar no desconto anunciado.'))) return;
    const r = await enviar('/api/offers/purge', 'POST');
    await avisar('Feed limpo', r.apagadas + ' ofertas apagadas.',
      'O histórico de preço continua intacto. O próximo ciclo roda em até 30 minutos.');
    recarregar();
  });

  // inteligência
  $('i-dia').addEventListener('change', () => guardar(carregarInteligencia, 'travessia'));
  $('i-dias').addEventListener('change', () => guardar(carregarInteligencia, 'travessia'));
  $('btn-varredura').addEventListener('click', async () => {
    try {
      await enviar('/api/intel/sweep', 'POST');
      avisar('A varredura foi iniciada',
        'Ela percorre todas as palavras-chave na API da Shopee e leva alguns minutos.',
        'Pode fechar esta tela — o trabalho roda no servidor e continua sozinho. Os números aparecem na aba Inteligência quando terminar.');
    }
    catch (e) { avisarErro(e.message); }
  });
  $('btn-recorrelacionar').addEventListener('click', async () => {
    if (!(await confirmar('Recorrelacionar todos os posts?',
      'Reavalia cada post dos grupos contra o cardápio da API, usando os limiares atuais.',
      'Pode fechar a tela — roda no servidor. Os vereditos podem mudar; a fotografia congelada de cada casamento é preservada.'))) return;
    try {
      await enviar('/api/intel/rematch', 'POST', { todos: true });
      await avisar('Correlação iniciada', 'Os posts estão sendo reavaliados agora.',
        'Pode fechar esta tela. Os números da aba Inteligência se atualizam conforme termina.');
    }
    catch (e) { avisarErro(e.message); }
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
        // Entra como concorrente; "Meu grupo" é um clique depois, no card.
        kind: 'promo',
      });
      msg('g-msg', 'grupo cadastrado (id ' + r.id + ')', 'ok');
      $('g-jid').value = ''; $('g-nome').value = '';
      carregarGrupos();
    } catch (e) { msg('g-msg', e.message, 'err'); }
  });
  $('btn-girar-token').addEventListener('click', async () => {
    if (!(await confirmar('Gerar um segredo novo?',
      'O endereço de ingestão muda na hora.',
      'Quem estiver mandando dados para o endereço antigo para de funcionar até você atualizar o endereço lá.'))) return;
    await enviar('/api/intel/ingest-url/rotate', 'POST');
    carregarIngestUrl();
  });

  // conexões
  $('c-role').addEventListener('change', () => {
    // Os blocos extra-poster/extra-listener sumiram: o fluxo agora é em passos
    // e o webhook virou ação explícita do passo 3, para os dois papéis.
  });
  $('btn-pular-1').addEventListener('click', () => {
    if (!cNome()) return msg('c-msg', 'digite o nome exato da instância que já existe', 'err');
    passoConectar(3);
  });
  $('pm-janela').addEventListener('change', () => { pmAberto = null; $('pm-ficha').innerHTML = ''; carregarPrecos(); });
  $('add-filtro').addEventListener('input', (e) => {
    if (addEscolhido) desenharAddGrupos(e.target.value);
  });
  $('btn-criar-inst').addEventListener('click', async () => {
    try {
      if (!cNome()) return msg('c-msg', 'informe um nome', 'err');
      const r = await enviar('/api/instances', 'POST', { name: cNome(), role: cFuncao() });
      msg('c-msg', 'provisionado — ' + Object.entries(r.steps || {}).map(([k, v]) => k + ': ' + v).join(' · '), 'ok');
      passoConectar(2); // só agora existe instância para gerar QR
    } catch (e) { msg('c-msg', e.message, 'err'); }
  });
  $('btn-qr').addEventListener('click', async () => {
    try {
      const r = await api('/api/instances/' + encodeURIComponent(cNome()) + '/qr');
      const src = r.base64 ? (r.base64.startsWith('data:') ? r.base64 : 'data:image/png;base64,' + r.base64) : '';
      $('qr').innerHTML = src ? `<img src="${src}" alt="QR code para conectar o WhatsApp"/>` : '';
      msg('c-msg', (r.pairingCode ? 'código: ' + r.pairingCode + ' — ' : '') + 'escaneie o QR no WhatsApp desse número.', 'alerta');
      passoConectar(3); // com o QR na tela, o próximo passo é confirmar
    } catch (e) { msg('c-msg', e.message, 'err'); }
  });
  $('btn-estado').addEventListener('click', async () => {
    try {
      const r = await api('/api/instances/' + encodeURIComponent(cNome()) + '/state');
      const ok = r.state === 'open';
      msg('c-msg', 'estado: ' + r.state + (ok ? ' — conectado' : ' (precisa ficar "open")'), ok ? 'ok' : 'alerta');
      if (ok) {
        $('qr').innerHTML = '';
        // Conectou: o passo 3 fica marcado como concluído (nenhum passo "ativo").
        passoConectar(4);
      }
    } catch (e) { msg('c-msg', e.message, 'err'); }
  });
  $('btn-webhook').addEventListener('click', async () => {
    try {
      const r = await enviar('/api/instances/' + encodeURIComponent(cNome()) + '/webhook', 'POST');
      msg('c-msg', 'webhook configurado: ' + r.url, 'ok');
    } catch (e) { msg('c-msg', e.message, 'err'); }
  });
  $('btn-criar-grupo').addEventListener('click', async () => {
    const b = $('btn-criar-grupo');
    const nome = ($('g-subject').value || '').trim();
    if (!cNome()) return msg('g-criar-msg', 'preencha o nome da instância lá em cima — é o número que vira dono do grupo', 'err');
    if (!nome) return msg('g-criar-msg', 'dê um nome ao grupo', 'err');
    b.disabled = true;
    const antes = b.textContent;
    b.textContent = 'criando…';
    try {
      const r = await enviar(`/api/instances/${encodeURIComponent(cNome())}/groups`, 'POST', {
        subject: nome,
        description: ($('g-desc').value || '').trim(),
        participants: ($('g-participantes').value || '').trim(),
        somenteAdmin: $('g-somente-admin').checked,
        registrar: $('g-registrar').value,
      });
      msg('g-criar-msg', 'grupo criado', 'ok');
      /*
       * O link de convite é a ÚNICA coisa aqui que o dono precisa levar para
       * fora do painel, e some se ele fechar a página — por isso fica num poço
       * com botão de copiar, e não numa mensagem de status que a próxima ação
       * apaga.
       */
      $('g-criado').innerHTML =
        `<div class="nota" style="margin-top:10px">${(r.passos || []).map((p) => '· ' + esc(p)).join('<br>')}</div>` +
        (r.inviteUrl
          ? `<label style="margin-top:10px">link de convite — divulgue este endereço</label>
             <div class="copiavel"><span class="mono" id="g-convite">${esc(r.inviteUrl)}</span>
             <button class="btn fantasma pequeno" data-copiar="g-convite">copiar</button></div>`
          : '<div class="nota alerta" style="margin-top:10px">o grupo foi criado, mas o link de convite não veio — pegue pelo celular, em Dados do grupo → Convidar via link.</div>') +
        `<div class="nota" style="margin-top:8px">id do grupo: <span class="mono">${esc(r.jid)}</span></div>`;
      $('g-subject').value = '';
      $('g-participantes').value = '';
      $('g-desc').value = '';
      carregarCanais();
    } catch (e) {
      msg('g-criar-msg', e.message, 'err');
    } finally {
      b.disabled = false;
      b.textContent = antes;
    }
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
    } catch (e) { avisarErro(e.message); }
  });
  $('btn-salvar-ia').addEventListener('click', async () => {
    try {
      const body = {};
      const k = $('cfg-key').value.trim(); if (k) body.openai_api_key = k;
      const m = $('cfg-model').value.trim(); if (m) body.copy_model = m;
      await enviar('/api/settings', 'PUT', body);
      $('cfg-key').value = '';
      carregarConfig();
    } catch (e) { avisarErro(e.message); }
  });
  $('btn-salvar-acesso').addEventListener('click', async () => {
    try {
      const senha = $('ac-pass').value;
      const usuario = $('ac-user').value.trim();
      if (senha.length < 8) return avisarErro('A senha precisa de pelo menos 8 caracteres.');
      await enviar('/api/access', 'POST', { senha, usuario: usuario || undefined });
      $('ac-pass').value = '';
      await avisar('Acesso atualizado',
        'Usuário e senha do painel foram trocados.',
        'As sessões abertas em outros dispositivos foram encerradas — você vai precisar entrar de novo.');
      location.href = '/login';
    } catch (e) { avisarErro(e.message); }
  });
}

/* ==================== INÍCIO ==================== */
ligar();
// rotaDe() DECIDE a sub-aba a partir do caminho; trocarSubAba() só a aplica.
// Na ordem inversa, /feed/monitor abria em Ofertas.
const secaoInicial = rotaDe(location.pathname);
trocarSubAba(subAba, false);
abrir(secaoInicial, false);
guardar(pulso, 'estado-api');
setInterval(() => {
  guardar(pulso, 'estado-api');
  if (secaoAtual === 'visao') guardar(carregarFunil, 'funil');
}, 20000);
