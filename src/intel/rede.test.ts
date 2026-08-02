import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

/**
 * QUEM COPIA QUEM — a análise que separa três hipóteses que a correlação com a
 * API sozinha confunde.
 *
 * O cenário montado aqui é o que o dono suspeita: um grupo posta primeiro, o
 * outro republica os MESMOS produtos pouco depois, com títulos reescritos (é
 * assim que acontece — ninguém copia e cola idêntico). Se o motor não separar
 * os dois, o painel diria que ambos "escolhem bem" e o dono copiaria o critério
 * de quem não tem critério nenhum.
 *
 *   INTEL_TEST_DATABASE_URL=postgres://... npm run test:rede
 */

const DB = process.env.INTEL_TEST_DATABASE_URL;

if (!DB) {
  test('INTEGRAÇÃO PULADA — falta INTEL_TEST_DATABASE_URL', () => {
    console.warn('\n  [!] rede.test.ts NÃO RODOU: defina INTEL_TEST_DATABASE_URL.\n');
    assert.ok(true);
  });
} else {
  process.env.DATABASE_URL = DB;
  process.env.SHOPEE_APP_ID ??= 'teste';
  process.env.SHOPEE_APP_SECRET ??= 'teste';

  const { migrate } = require('../migrate') as typeof import('../migrate');
  const { query, queryOne, closePool } = require('../db') as typeof import('../db');
  const { redeDeGrupos } = require('./rede') as typeof import('./rede');
  const { normalizeText } = require('../util') as typeof import('../util');

  const PREFIXO = '__rede_teste__';
  const ids: Record<string, string> = {};

  const criarGrupo = async (nome: string, kind = 'promo') => {
    const r = await queryOne<{ id: string }>(
      `INSERT INTO intel_groups (group_jid, display_name, kind, is_active)
       VALUES ($1,$2,$3,true)
       ON CONFLICT (group_jid) DO UPDATE SET display_name = EXCLUDED.display_name, is_active = true
       RETURNING id::text AS id`,
      [`${PREFIXO}${nome}@g.us`, nome, kind],
    );
    ids[nome] = r!.id;
    return r!.id;
  };

  /** `minutosAtras` posiciona o post no tempo — é o eixo da análise inteira. */
  const postar = async (grupo: string, titulo: string, minutosAtras: number, preco = 249.9) => {
    const r = await queryOne<{ id: string }>(
      `INSERT INTO intel_posts (group_id, posted_at, message_hash, text, title_guess, title_norm, price, platform_guess)
       VALUES ($1, now() - ($2 || ' minutes')::interval, $3, $4, $4, $5, $6, 'shopee')
       RETURNING id::text AS id`,
      [ids[grupo], String(minutosAtras), `${PREFIXO}${grupo}-${titulo}-${minutosAtras}`, titulo, normalizeText(titulo), preco],
    );
    return r!.id;
  };

  const limpar = async () => {
    await query(
      `DELETE FROM intel_matches WHERE post_id IN (
         SELECT p.id FROM intel_posts p JOIN intel_groups g ON g.id = p.group_id
          WHERE g.group_jid LIKE $1)`,
      [`${PREFIXO}%`],
    );
    await query(`DELETE FROM intel_groups WHERE group_jid LIKE $1`, [`${PREFIXO}%`]);
  };

  before(async () => {
    await migrate();
    await limpar();
  });

  after(async () => {
    try { await limpar(); } finally { await closePool(); }
  });

  /* ==================== a rede pequena não finge ter resposta ==================== */

  test('com UM grupo só, não afirma quem copia quem', async () => {
    await criarGrupo('Sozinho');
    await postar('Sozinho', 'Air Fryer Britania 4,2L Dura Mais 1500W', 100);
    await postar('Sozinho', 'Monitor Gamer AOC 24 165Hz Full HD', 60);

    const r = await redeDeGrupos(14);
    assert.equal(r.comparavel, false, 'um grupo não permite comparação');
    assert.equal(r.grupos[0]!.veredito, 'rede_pequena');
    /*
     * O ponto: sem esta guarda o grupo apareceria com 100% "primeiro na rede" —
     * verdade trivial que leria como "esta é a fonte". Conclusão confiante sem
     * base é pior que dizer que faltam dados.
     */
    assert.equal(r.arestas.length, 0);
    await limpar();
  });

  /* ==================== o cenário que o dono suspeita ==================== */

  test('separa a FONTE de quem só ECOA — com títulos reescritos', async () => {
    await criarGrupo('Fonte');
    await criarGrupo('Copiador');

    /*
     * Títulos REESCRITOS de propósito. Copiar e colar idêntico tornaria o
     * casamento trivial e o teste não provaria nada sobre o trigrama — e não é
     * assim que grupo de promoção republica.
     */
    const pares: Array<[string, string]> = [
      ['Air Fryer Britania 4,2L Dura Mais 1500W Preta', 'Air Fryer Britania 4,2 litros Dura Mais 1500W'],
      ['Monitor Gamer AOC 24 polegadas 165Hz Full HD', 'Monitor Gamer AOC 24 165Hz Full HD IPS'],
      ['Cafeteira Expresso Oster PrimaLatte 19 bar', 'Cafeteira Oster PrimaLatte Expresso 19 bar'],
      ['Headset Gamer HyperX Cloud Stinger 2 Preto', 'Headset HyperX Cloud Stinger 2 Gamer'],
      ['Smart TV Samsung 50 polegadas 4K Crystal UHD', 'Smart TV Samsung 50 4K Crystal UHD'],
    ];
    // A fonte posta primeiro; o copiador republica ~40 min depois, sempre.
    let t = 600;
    for (const [orig, copia] of pares) {
      await postar('Fonte', orig, t);
      await postar('Copiador', copia, t - 40);
      t -= 90;
    }

    const r = await redeDeGrupos(14);
    assert.equal(r.comparavel, true);

    const fonte = r.grupos.find((g) => g.nome === 'Fonte')!;
    const copia = r.grupos.find((g) => g.nome === 'Copiador')!;

    assert.equal(fonte.posts, 5);
    assert.equal(copia.posts, 5);

    // A fonte chega primeiro em tudo; o copiador, em nada.
    assert.equal(fonte.primeiroNaRede, 5, 'a fonte tem que ser primeira em todos');
    assert.equal(fonte.ecoDeOutro, 0, 'a fonte não pode ecoar ninguém');
    assert.ok(copia.ecoDeOutro >= 4, `o copiador deveria ecoar >=4, veio ${copia.ecoDeOutro}`);

    assert.equal(copia.veredito, 'eco');
    assert.notEqual(fonte.veredito, 'eco');

    // De QUEM ele ecoa, e com que atraso — é o que torna a acusação verificável.
    assert.equal(copia.ecoPrincipal?.nome, 'Fonte');
    assert.ok(
      copia.atrasoEcoMediano != null && Math.abs(copia.atrasoEcoMediano - 2400) < 300,
      `atraso mediano deveria ficar perto de 40 min (2400s), veio ${copia.atrasoEcoMediano}`,
    );

    // A aresta aponta na direção certa: copiador ← fonte.
    const a = r.arestas.find((x) => x.deNome === 'Copiador');
    assert.ok(a, 'faltou a aresta do copiador');
    assert.equal(a.paraNome, 'Fonte');
    assert.ok(a.vezes >= 4);

    await limpar();
  });

  test('produto DIFERENTE não vira eco só por ser do mesmo tipo', async () => {
    /*
     * O falso-positivo que estragaria a análise: "Air Fryer Mondial 5L" e
     * "Air Fryer Britânia 4,2L" são produtos distintos de categoria igual. Se
     * o limiar os casasse, todo grupo de promoção pareceria eco de todo outro.
     */
    await criarGrupo('A');
    await criarGrupo('B');
    await postar('A', 'Air Fryer Mondial 5L Family Inox AFN-5000', 120);
    await postar('B', 'Geladeira Brastemp Frost Free 400 litros Inox', 60);
    await postar('B', 'Liquidificador Philco PH900 15 velocidades', 30);

    const r = await redeDeGrupos(14);
    const b = r.grupos.find((g) => g.nome === 'B')!;
    assert.equal(b.ecoDeOutro, 0, 'produtos diferentes não podem contar como eco');
    await limpar();
  });

  test('eco só conta para trás: quem postou ANTES nunca ecoa quem postou depois', async () => {
    await criarGrupo('Cedo');
    await criarGrupo('Tarde');
    const titulo = 'Notebook Dell Inspiron 15 i5 8GB 512GB SSD';
    await postar('Cedo', titulo, 300);
    await postar('Tarde', titulo + ' Windows 11', 200);

    const r = await redeDeGrupos(14);
    const cedo = r.grupos.find((g) => g.nome === 'Cedo')!;
    const tarde = r.grupos.find((g) => g.nome === 'Tarde')!;
    assert.equal(cedo.ecoDeOutro, 0, 'quem postou antes não pode ecoar quem veio depois');
    assert.equal(tarde.ecoDeOutro, 1);
    assert.ok(tarde.atrasoEcoMediano! > 0, 'o atraso do eco é sempre positivo');
    await limpar();
  });

  test('post repetido no MESMO grupo não conta como eco de si mesmo', async () => {
    /*
     * Grupo que republica a própria oferta é lista fixa, não eco — e são coisas
     * opostas: uma diz que ele TEM critério próprio, a outra que ele não tem.
     */
    await criarGrupo('Repetidor');
    await criarGrupo('Outro');
    const t = 'Fone Bluetooth JBL Tune 510BT Sem Fio';
    await postar('Repetidor', t, 300);
    await postar('Repetidor', t + ' Preto', 100);
    await postar('Outro', 'Panela de Pressao Eletrica Mondial 5L', 200);

    const r = await redeDeGrupos(14);
    const rep = r.grupos.find((g) => g.nome === 'Repetidor')!;
    assert.equal(rep.ecoDeOutro, 0, 'repetir o próprio produto não é ecoar outro grupo');
    assert.equal(rep.primeiroNaRede, 2);
    await limpar();
  });

  test('janela de dias corta o que é velho demais', async () => {
    await criarGrupo('X');
    await criarGrupo('Y');
    await postar('X', 'Aspirador Robo Xiaomi Mi Robot Vacuum S10', 60 * 24 * 20); // 20 dias
    await postar('Y', 'Aspirador Robo Xiaomi Mi Robot Vacuum S10 Plus', 60 * 24 * 20 - 30);

    const curta = await redeDeGrupos(7);
    assert.equal(curta.grupos.find((g) => g.nome === 'Y')!.posts, 0, 'fora da janela não conta');

    const longa = await redeDeGrupos(30);
    assert.equal(longa.grupos.find((g) => g.nome === 'Y')!.ecoDeOutro, 1, 'dentro da janela conta');
    await limpar();
  });
}
