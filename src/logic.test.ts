import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, toNum } from './util';
import { hasLiteralNumbers } from './pipeline/copy';
import { assessDiscount } from './pipeline/fakeDiscount';
import type { NormalizedOffer } from './types';

test('normalizeText remove emoji/pontuação/acentos e colapsa espaços', () => {
  assert.equal(normalizeText('  Fóne   Bluetooth 🔥!!!  '), 'fone bluetooth');
  // a MESMA oferta com texto variado gera o mesmo hash de conteúdo
  assert.equal(normalizeText('Fone!! 🔥'), normalizeText('fone'));
});

test('toNum lida com decimal US, separador de milhar e nulos', () => {
  assert.equal(toNum('0.07'), 0.07); // commissionRate
  assert.equal(toNum('12.51'), 12.51); // priceMin
  assert.equal(toNum('R$ 1,234.56'), 1234.56); // milhar US + símbolo
  assert.equal(toNum(''), null);
  assert.equal(toNum(null), null);
  assert.equal(toNum(65), 65); // priceDiscountRate (inteiro %)
  assert.equal(toNum('abc'), null);
});

test('hasLiteralNumbers barra números literais mas aceita placeholders', () => {
  assert.equal(hasLiteralNumbers('Só R$ 99 hoje'), true);
  assert.equal(hasLiteralNumbers('50% de desconto'), true);
  assert.equal(hasLiteralNumbers('por 12,51'), true);
  assert.equal(hasLiteralNumbers('Aproveite {{preco}} com {{desconto}} OFF'), false);
  assert.equal(hasLiteralNumbers('Correria! Achado de ouro 🔥'), false);
});

function offer(partial: Partial<NormalizedOffer>): NormalizedOffer {
  return {
    platform: 'shopee', productId: 'p', shopId: 's', title: 't',
    price: 50, originalPrice: null, discountPct: null, savingsBrl: null,
    commissionRate: 0.07, category: null, imageUrl: null, sourceUrl: null,
    offerLink: null, sales: null, ratingStar: null, ...partial,
  };
}

test('assessDiscount: desconto anunciado absurdo é marcado como falso', () => {
  const a = assessDiscount(offer({ discountPct: 97 }), { count: 10, min: 40, median: 50, max: 60 }, 95);
  assert.equal(a.fake, true);
});

test('assessDiscount: sem histórico suficiente não afirma desconto real', () => {
  const a = assessDiscount(offer({ price: 30 }), { count: 1, min: 30, median: 30, max: 30 }, 95);
  assert.equal(a.confident, false);
  assert.equal(a.realSavings, null);
});

test('assessDiscount: desconto real vem do histórico (não do anúncio)', () => {
  const a = assessDiscount(offer({ price: 30, discountPct: 20 }), { count: 8, min: 30, median: 100, max: 120 }, 95);
  assert.equal(a.confident, true);
  assert.equal(a.realSavings, 70);
  assert.equal(Math.round(a.realDiscountPct!), 70);
});

test('assessDiscount: "de/por" inflado acima da mediana real vira fake', () => {
  // preço 50, anúncio diz 80% off => "original" ~250, mas mediana real é 60
  const a = assessDiscount(offer({ price: 50, discountPct: 80 }), { count: 8, min: 50, median: 60, max: 70 }, 95);
  assert.equal(a.fake, true);
});
