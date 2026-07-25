import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, toNum } from './util';
import { hasLiteralNumbers, copyWithoutAi } from './pipeline/copy';
import { assessDiscount } from './pipeline/fakeDiscount';
import { matchesKeyword, rejectByKeyword } from './pipeline/filters';
import { DEFAULT_BLOCKED_KEYWORDS, databaseUrl, type Config } from './config';
import { parse as parseConn } from 'pg-connection-string';
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

// ---- Regressões pegas no dry-run ao vivo (2026-07-25) ----

test('matchesKeyword corta produto fora do nicho e aceita plural/derivado', () => {
  // a busca da Shopee por "notebook" devolvia papel/caderno
  assert.equal(matchesKeyword('Papel Fotográfico 180g Glossy A4', 'notebook'), false);
  assert.equal(matchesKeyword('Notebook Lenovo Ideapad 3i', 'notebook'), true);
  // substring de propósito: plural e derivado passam
  assert.equal(matchesKeyword('Fones De Ouvido TWS Bluetooth', 'fone de ouvido'), true);
  assert.equal(matchesKeyword('Cafeteira Elétrica 30 xícaras', 'cafe'), true);
  // keyword com 2 tokens exige os dois -> monitor de pressão não passa
  assert.equal(matchesKeyword('Monitor De Pressão Arterial De Pulso', 'monitor gamer'), false);
  assert.equal(matchesKeyword('Monitor Gamer 24 165Hz', 'monitor gamer'), true);
});

test('blocklist não dá falso-positivo em produto legítimo', () => {
  const cfg = { BLOCKED_KEYWORDS: DEFAULT_BLOCKED_KEYWORDS } as unknown as Config;
  // caso real: termômetro "para bebê e adulto" era bloqueado pela palavra solta "adulto"
  assert.equal(
    rejectByKeyword(offer({ title: 'Termômetro Digital Infravermelho Bebê e Adulto' }), cfg).rejected,
    false,
  );
  assert.equal(rejectByKeyword(offer({ title: 'Porta Comprimido Semanal' }), cfg).rejected, false);
  // e continua bloqueando o que deve
  assert.equal(rejectByKeyword(offer({ title: 'Kit Sex Shop Casal' }), cfg).rejected, true);
  assert.equal(rejectByKeyword(offer({ title: 'Cigarro Eletrônico Vape 5000 puffs' }), cfg).rejected, true);
});

test('copy de fallback usa desconto e economia quando o histórico confirma', () => {
  const o = offer({ title: 'Air Fryer 5L', price: 200 });
  const semHistorico = copyWithoutAi(o, assessDiscount(o, { count: 0, min: null, median: null, max: null }, 95));
  assert.equal(/abaixo do preço/.test(semHistorico.copy.body), false); // não promete o que não mediu

  const comHistorico = copyWithoutAi(o, assessDiscount(o, { count: 8, min: 200, median: 500, max: 520 }, 95));
  assert.match(comHistorico.copy.body, /60% abaixo do preço/);
  assert.match(comHistorico.copy.body, /economiza/);
});

test('databaseUrl escapa senha hostil e respeita DATABASE_URL pronta', () => {
  const base = {
    POSTGRES_HOST: 'postgres',
    POSTGRES_PORT: 5432,
    POSTGRES_USER: 'motor',
    POSTGRES_DB: 'motor',
  };
  // senha com @ : / # $ espaço % — numa URI crua isso quebraria o parse
  const senha = 'a@b:c/d#e$f g%h';
  const url = databaseUrl({ ...base, POSTGRES_PASSWORD: senha } as unknown as Config);
  assert.equal(url, `postgresql://motor:${encodeURIComponent(senha)}@postgres:5432/motor`);
  // e o pg tem que decodificar de volta para a senha original
  assert.equal(parseConn(url).password, senha);
  // DATABASE_URL explícita tem precedência
  assert.equal(
    databaseUrl({ ...base, DATABASE_URL: 'postgresql://x:y@h:1/d' } as unknown as Config),
    'postgresql://x:y@h:1/d',
  );
});
