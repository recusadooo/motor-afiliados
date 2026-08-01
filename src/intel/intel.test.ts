import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trigramSimilarity, scoreCandidato } from './match';
import { parsePost, scrubPII, parseMoedaBR } from './ingest';

/**
 * Testes CAIXA-PRETA da inteligência de mercado: exercitam o contrato, não a
 * implementação. Só funções puras — nada aqui toca banco, rede ou relógio.
 *
 * O que estes testes protegem, em uma frase: um matcher ruim não produz
 * silêncio, produz CONCLUSÃO CONFIANTE E ERRADA. "Eles postaram 30 min depois"
 * é uma afirmação sobre o negócio, e ela nasce destas funções.
 */

/* ==================== limpeza de PII (LGPD) ==================== */

test('scrubPII remove telefone, e-mail e menção', () => {
  assert.doesNotMatch(scrubPII('chama no (92) 99456-7318'), /9945|7318/);
  assert.doesNotMatch(scrubPII('whats +55 92 99456-7318 agora'), /99456/);
  assert.doesNotMatch(scrubPII('5592994567318 respondo rápido'), /5592994567318/);
  assert.doesNotMatch(scrubPII('manda pro bruno@exemplo.com'), /bruno@exemplo/);
  assert.doesNotMatch(scrubPII('valeu @559294567318'), /559294567318/);
});

test('scrubPII NÃO destrói preço — é o falso-positivo que arruinaria a base', () => {
  // R$ 99999 tem 5 dígitos: não é telefone. Se a regex for gulosa, todo preço
  // alto vira "[tel]" e o parser de preço para de funcionar em silêncio.
  assert.match(scrubPII('iPhone por R$ 99999'), /99999/);
  assert.match(scrubPII('de R$ 1.299,90 por R$ 899,90'), /899,90/);
  assert.match(scrubPII('Air Fryer 5L por apenas R$ 249,00'), /249,00/);
  // ano e código de produto também precisam sobreviver
  assert.match(scrubPII('Notebook 2024 modelo A1502'), /2024/);
});

/* ==================== moeda em pt-BR ==================== */

test('parseMoedaBR entende os dois formatos que aparecem em grupo', () => {
  assert.equal(parseMoedaBR('R$ 1.299,90'), 1299.9); // milhar com ponto, decimal com vírgula
  assert.equal(parseMoedaBR('39,90'), 39.9);
  assert.equal(parseMoedaBR('R$1299.90'), 1299.9); // alguém colou no formato US
  assert.equal(parseMoedaBR('249'), 249);
  assert.equal(parseMoedaBR('abc'), null);
  assert.equal(parseMoedaBR(''), null);
});

/* ==================== leitura da mensagem do grupo ==================== */

test('parsePost extrai o "de X por Y" na ordem certa', () => {
  const p = parsePost('🔥 Air Fryer Mondial 5L\nDe R$ 499,90 por R$ 249,90\nhttps://s.shopee.com.br/abc123');
  assert.equal(p.price, 249.9);
  assert.equal(p.priceOld, 499.9);
  assert.ok(p.discountPct != null && Math.round(p.discountPct) === 50);
});

test('parsePost acha o preço quando só existe um', () => {
  const p = parsePost('Fone TWS bom demais\napenas R$ 59,90\nhttps://s.shopee.com.br/x');
  assert.equal(p.price, 59.9);
  assert.equal(p.priceOld, null);
});

test('parsePost identifica plataforma pelo link e coleta URLs sem repetir', () => {
  const p = parsePost('oferta https://s.shopee.com.br/abc https://s.shopee.com.br/abc');
  assert.equal(p.urls.length, 1);
  assert.equal(p.platformGuess, 'shopee');
  assert.equal(parsePost('https://amzn.to/xyz').platformGuess, 'amazon');
  assert.equal(parsePost('https://mercadolivre.com/sec/1a2b').platformGuess, 'mercadolivre');
  assert.equal(parsePost('sem link nenhum').platformGuess, null);
});

test('parsePost pega o cupom, mas não a palavra "cupom" sozinha', () => {
  assert.equal(parsePost('use o cupom BLACK50 no carrinho').coupon, 'BLACK50');
  assert.equal(parsePost('tem cupom na página').coupon, null);
});

test('parsePost escolhe uma linha de título plausível', () => {
  const p = parsePost('🔥🔥🔥\nR$ 89,90\nSmart TV LG 43 polegadas 4K\nhttps://s.shopee.com.br/z');
  // linha só de emoji, só de preço e só de URL não servem como título
  assert.ok(p.titleGuess && p.titleGuess.includes('Smart TV'));
  assert.doesNotMatch(p.titleGuess, /^https?:/);
});

test('parsePost devolve título nulo quando não há candidato', () => {
  const p = parsePost('https://s.shopee.com.br/abc');
  assert.equal(p.titleGuess, null);
});

/* ==================== similaridade de título ==================== */

test('trigramSimilarity: idêntico é 1, sem nada em comum é 0', () => {
  assert.equal(trigramSimilarity('air fryer mondial', 'air fryer mondial'), 1);
  assert.equal(trigramSimilarity('air fryer', 'xyzqwk'), 0);
  assert.equal(trigramSimilarity('', 'qualquer coisa'), 0);
  assert.equal(trigramSimilarity('qualquer coisa', ''), 0);
});

test('trigramSimilarity fica no meio quando os títulos se sobrepõem em parte', () => {
  // caso real: o grupo escreve curto, a Shopee escreve enciclopédico
  const s = trigramSimilarity(
    'air fryer mondial 5l',
    'air fryer mondial 5l family inox fritadeira eletrica sem oleo 1500w',
  );
  assert.ok(s > 0.2 && s < 1, `esperava similaridade parcial, veio ${s}`);
  // e produto diferente da mesma categoria tem que ficar claramente abaixo
  const outro = trigramSimilarity('air fryer mondial 5l', 'liquidificador philco 1200w');
  assert.ok(outro < s, `produto diferente (${outro}) deveria pontuar menos que o certo (${s})`);
});

test('trigramSimilarity é simétrico', () => {
  const a = trigramSimilarity('smart tv lg 43', 'smart tv lg 43 polegadas 4k');
  const b = trigramSimilarity('smart tv lg 43 polegadas 4k', 'smart tv lg 43');
  assert.equal(a, b);
});

/* ==================== nota de confiança ==================== */

const TOL = 0.15;

test('scoreCandidato: preço igual bonifica, preço distante penaliza', () => {
  const igual = scoreCandidato({ titleSim: 0.6, postPrice: 100, obsPrice: 100, tolerancia: TOL });
  const longe = scoreCandidato({ titleSim: 0.6, postPrice: 100, obsPrice: 300, tolerancia: TOL });
  assert.ok(igual.confidence > 0.6, `preço igual deveria subir de 0.6, veio ${igual.confidence}`);
  assert.ok(longe.confidence < 0.6, `preço 3x deveria descer de 0.6, veio ${longe.confidence}`);
  assert.ok(igual.confidence > longe.confidence);
});

test('scoreCandidato: sem preço de um lado não bonifica nem pune', () => {
  // ausência de dado não é evidência — nem a favor, nem contra
  const semPost = scoreCandidato({ titleSim: 0.6, postPrice: null, obsPrice: 100, tolerancia: TOL });
  const semObs = scoreCandidato({ titleSim: 0.6, postPrice: 100, obsPrice: null, tolerancia: TOL });
  assert.equal(semPost.priceDeltaPct, null);
  assert.equal(semObs.priceDeltaPct, null);
  assert.equal(semPost.confidence, 0.6);
  assert.equal(semObs.confidence, 0.6);
});

test('scoreCandidato: priceDeltaPct é percentual sobre o preço observado', () => {
  const r = scoreCandidato({ titleSim: 0.5, postPrice: 110, obsPrice: 100, tolerancia: TOL });
  assert.ok(r.priceDeltaPct != null && Math.abs(r.priceDeltaPct - 10) < 0.001);
});

test('scoreCandidato nunca sai de [0,1]', () => {
  const teto = scoreCandidato({ titleSim: 1, postPrice: 100, obsPrice: 100, tolerancia: TOL });
  const piso = scoreCandidato({ titleSim: 0.01, postPrice: 100, obsPrice: 100000, tolerancia: TOL });
  assert.ok(teto.confidence <= 1, `estourou o teto: ${teto.confidence}`);
  assert.ok(piso.confidence >= 0, `furou o piso: ${piso.confidence}`);
});

test('scoreCandidato: dentro da tolerância sempre vale mais que fora dela', () => {
  const dentro = scoreCandidato({ titleSim: 0.5, postPrice: 105, obsPrice: 100, tolerancia: TOL }); // 5%
  const fora = scoreCandidato({ titleSim: 0.5, postPrice: 130, obsPrice: 100, tolerancia: TOL }); // 30%
  assert.ok(dentro.confidence > fora.confidence);
});
