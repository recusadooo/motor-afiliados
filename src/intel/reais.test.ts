import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePost, scrubPII } from './ingest';

/**
 * TESTES COM MENSAGENS REAIS de um grupo de promoção concorrente
 * (coletadas pelo dono em 01/08/2026, ~1h de operação).
 *
 * Por que este arquivo existe separado: os testes de `intel.test.ts` foram
 * escritos contra o formato que EU IMAGINEI. Estes são contra o formato que
 * existe. Toda vez que os dois discordarem, estes ganham.
 *
 * Dois padrões aparecem, e o parser precisa dar conta dos DOIS:
 *
 *   A) "🔥 <título>\n* por R$ <valor> no <loja>*\n<link>\n*use o cupom* <CUPOM>"
 *   B) "<CHAMADA EM CAIXA ALTA>\n**<título>**\n~~DE <v1>~~ | **POR <v2>**\nCUPOM: <X>"
 *
 * O padrão B foi o que quebrou as suposições: o "de/por" vem separado por `|`
 * e cercado de marcação (`~~`, `**`), o valor às vezes vem SEM "R$", e a
 * primeira linha é uma chamada de efeito — não o nome do produto.
 */

const A_MERCADOLIVRE = `🛒 Cobertor Microfibra Life Tex II Casal 200cm x 180cm
* por *R$ 20* no Mercado Livre*
https://meli.la/2QBYajS
*use o cupom* *CASAPROMO*
** Vendido por:** Stylo Casa Enxovais
* Frete grátis algumas regiões*`;

const A_AMAZON = `🧴 Truss Óleo Capilar Nutri Infusion Nutrição Profunda e Controle de Frizz 60ml
* por *R$ 91* na Amazon*
https://www.amazon.com.br/dp/B0F1WDN2PC?tag=mypromoredes-20
* Frete grátis | *Amazon Prime**
** Site Confiável:** Amazon`;

const B_COM_DE_POR = `KITZÃO PRA CUIDAR DAS MADEIXAS
*Kit Braé Stages Nutrition: Shampoo 250ml + Condicionador 250ml + Máscara 200g -Essential 60ml*
~~DE 149,99~~ | *POR 128,13*
CUPOM: *PIPOCA*
https://meli.la/1sSzcR9`;

const B_SEM_RS_E_PARCELA = `TIRA A SUJEIRA COM VONTADE
*WAP Extratora Portátil SPOT CLEANER POWER BRUSH 3 em 1 sem Fio*
~~DE 683~~ | *POR 431,43 em 8x*
Resgate o cupom: *BOMSABADO*
https://www.amazon.com.br/dp/B0G5PYYLXZ?tag=mypromoredes-20`;

const B_MILHAR = `É QUASE UMA TV
*Monitor Gamer Samsung Odyssey G5 32" 165hz 1ms*
~~DE 1.599~~ | *POR 1.016 em 10x*
Resgate o cupom: *BOMSABADO*
https://www.amazon.com.br/dp/B0DWQNS8TN?tag=mypromoredes-20`;

const A_COM_CUPOM_E_PIX = `👕 Jaqueta Esportiva com Capuz, Dry Fit
* por *R$ 28* no pix | Mercado Livre*
https://meli.la/2GERHWf
*use o cupom* *FASHIONML*
** Vendido por:** Strong Life`;

/* ==================== plataforma ==================== */

test('real: identifica Mercado Livre pelo encurtador meli.la', () => {
  assert.equal(parsePost(A_MERCADOLIVRE).platformGuess, 'mercadolivre');
  assert.equal(parsePost(B_COM_DE_POR).platformGuess, 'mercadolivre');
});

test('real: identifica Amazon (inclusive com a tag de afiliado do concorrente)', () => {
  assert.equal(parsePost(A_AMAZON).platformGuess, 'amazon');
  assert.equal(parsePost(B_SEM_RS_E_PARCELA).platformGuess, 'amazon');
});

/* ==================== preço ==================== */

test('real padrão A: "por R$ 20" é o preço, sem inventar preço antigo', () => {
  const p = parsePost(A_MERCADOLIVRE);
  assert.equal(p.price, 20);
  assert.equal(p.priceOld, null);
});

test('real padrão A: preço no pix não confunde com número de parcela', () => {
  const p = parsePost(A_COM_CUPOM_E_PIX);
  assert.equal(p.price, 28);
});

test('real padrão B: "DE 149,99 | POR 128,13" com marcação no meio', () => {
  const p = parsePost(B_COM_DE_POR);
  assert.equal(p.priceOld, 149.99);
  assert.equal(p.price, 128.13);
});

test('real padrão B: valor SEM "R$" e com parcelamento depois', () => {
  // "~~DE 683~~ | *POR 431,43 em 8x*" — o 8 de "8x" não pode virar preço
  const p = parsePost(B_SEM_RS_E_PARCELA);
  assert.equal(p.priceOld, 683);
  assert.equal(p.price, 431.43);
});

test('real padrão B: milhar com ponto ("1.599" = mil e quinhentos, não 1,599)', () => {
  const p = parsePost(B_MILHAR);
  assert.equal(p.priceOld, 1599);
  assert.equal(p.price, 1016);
  // e o desconto derivado tem que bater com a realidade (~36%)
  assert.ok(p.discountPct != null && Math.round(p.discountPct) === 36);
});

/* ==================== cupom ==================== */

test('real: pega o cupom nos três jeitos que eles escrevem', () => {
  assert.equal(parsePost(A_MERCADOLIVRE).coupon, 'CASAPROMO');       // *use o cupom* X
  assert.equal(parsePost(B_COM_DE_POR).coupon, 'PIPOCA');            // CUPOM: X
  assert.equal(parsePost(B_SEM_RS_E_PARCELA).coupon, 'BOMSABADO');   // Resgate o cupom: X
  assert.equal(parsePost(A_COM_CUPOM_E_PIX).coupon, 'FASHIONML');
});

test('real: cupom com dígitos no meio do nome', () => {
  const p = parsePost('Batedeira\n* por *R$ 220**\n*use o cupom* *TUDOPRACASA0108*\nhttps://meli.la/2m1jm8a');
  assert.equal(p.coupon, 'TUDOPRACASA0108');
});

/* ==================== título ==================== */

test('real padrão A: o título é a primeira linha', () => {
  assert.match(parsePost(A_MERCADOLIVRE).titleGuess ?? '', /Cobertor Microfibra Life Tex II/);
  assert.match(parsePost(A_AMAZON).titleGuess ?? '', /Truss Óleo Capilar/);
});

test('real padrão B: a chamada de efeito NÃO é o título', () => {
  // "KITZÃO PRA CUIDAR DAS MADEIXAS" é chamada; o produto é a linha seguinte.
  const p = parsePost(B_COM_DE_POR);
  assert.doesNotMatch(p.titleGuess ?? '', /KITZÃO|MADEIXAS/);
  assert.match(p.titleGuess ?? '', /Kit Braé Stages Nutrition/);
});

test('real padrão B: chamada de efeito curta também é ignorada', () => {
  const p = parsePost(B_MILHAR);
  assert.doesNotMatch(p.titleGuess ?? '', /QUASE UMA TV/);
  assert.match(p.titleGuess ?? '', /Monitor Gamer Samsung Odyssey/);
});

/* ==================== PII ==================== */

test('real: o número do admin sai de qualquer formato usado no grupo', () => {
  const comAdmin = 'Adm +55 16 98206-2623 postou\n' + A_MERCADOLIVRE;
  const limpo = scrubPII(comAdmin);
  assert.doesNotMatch(limpo, /98206|2623/);
  // e o preço da oferta continua lá
  assert.match(limpo, /R\$ 20/);
});

test('real: código de produto da Amazon NÃO é confundido com telefone', () => {
  // B0F1WDN2PC, B09XJL4B9H — alfanuméricos, e o ASIN nunca deve ser mascarado
  const limpo = scrubPII(A_AMAZON);
  assert.match(limpo, /B0F1WDN2PC/);
  assert.doesNotMatch(limpo, /\[tel\]/);
});

/* ==================== URL vs TELEFONE ==================== */

test('real: o id do produto DENTRO da URL sobrevive à limpeza de PII', () => {
  /*
   * Achado de auditoria, medido: o id de produto da Shopee tem 11 dígitos
   * ("20199206047") e casava com o padrão de corrida crua de 10-13 dígitos, o
   * que gravava `.../366017406/[tel]`. O link deixava de identificar o produto
   * — a única coisa pela qual ele é guardado.
   */
  const t = scrubPII('Air Fryer\nhttps://shopee.com.br/product/366017406/20199206047');
  assert.match(t, /20199206047/, 'o id do produto não pode ser confundido com telefone');
  assert.match(t, /366017406/, 'o id da loja também não');
});

test('real: mas telefone DENTRO de link de WhatsApp continua saindo', () => {
  // A exceção que a proteção de URL não pode abrir: em wa.me o dígito longo É
  // telefone, e guardar isso seria justamente o que a limpeza existe p/ impedir.
  for (const link of [
    'fala comigo https://wa.me/5516982062623',
    'https://api.whatsapp.com/send?phone=5516982062623&text=oi',
  ]) {
    const t = scrubPII(link);
    assert.doesNotMatch(t, /5516982062623/, `telefone vazou em: ${link}`);
  }
});

test('real: link de afiliado do concorrente sobrevive inteiro', () => {
  // Amazon e Mercado Livre: são estes que aparecem no grupo real que o dono
  // colou, e é por eles que o veredito `outra_plataforma` é decidido.
  const t = scrubPII('https://amazon.com.br/dp/B0ABC12345?tag=mypromoredes-20 e https://meli.la/aBcD3fG');
  assert.match(t, /B0ABC12345\?tag=mypromoredes-20/);
  assert.match(t, /meli\.la\/aBcD3fG/);
});
