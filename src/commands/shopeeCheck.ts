/* eslint-disable no-console */
import { loadConfig } from '../config';
import { productOfferV2, shopeeOfferV2 } from '../shopee/queries';
import { toNum } from '../util';

/**
 * Teste ao vivo (READ-ONLY) da Shopee Open API. Lê a chave do .env em runtime,
 * NUNCA imprime o valor. Diz se a API responde, se a assinatura funciona e se
 * o acesso está liberado (10035 = precisa aprovação; 10020 = assinatura).
 *   npm run shopee:check
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log('AppId carregado:', cfg.SHOPEE_APP_ID ? '(sim, valor oculto)' : '(AUSENTE)');
  console.log('Endpoint:', cfg.SHOPEE_API_ENDPOINT);
  console.log('---');

  const prod = await productOfferV2({ keyword: 'fone', sortType: 2, limit: 5 });
  console.log(`productOfferV2: ${prod.nodes.length} ofertas`);
  for (const n of prod.nodes.slice(0, 5)) {
    const comm = toNum(n.commissionRate);
    console.log(
      ` - [${n.itemId}] ${String(n.productName).slice(0, 40)} | R$${n.priceMin} | comissão ${comm != null ? (comm * 100).toFixed(1) : '?'}%`,
    );
  }

  const camp = await shopeeOfferV2({ sortType: 2, limit: 3 });
  console.log(`shopeeOfferV2: ${camp.nodes.length} campanhas`);

  console.log('---\nOK — Shopee Open API funcionando e acesso liberado.');
}

main().catch((err) => {
  console.error('FALHOU:', err instanceof Error ? err.message : err);
  process.exit(1);
});
