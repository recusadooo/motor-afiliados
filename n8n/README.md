# Coletor de grupos no n8n

Fluxo importável que lê os grupos de promoção observados e entrega ao motor.

## Antes de importar: você talvez não precise disto

Existem **dois caminhos** para a mesma coisa, e o mais simples não usa n8n:

| | Direto (sem n8n) | Com n8n |
|---|---|---|
| Como | webhook da Evolution aponta para `PUBLIC_APP_URL/webhook/evolution/<token>` | Evolution → n8n → motor |
| Peças | uma | três |
| Você mexe na regra | precisa de deploy | edita no editor visual, na hora |
| Onde configurar | painel → Conexões → "Configurar webhook do listener" | aqui |

O motor já sabe receber direto — `src/whatsapp/listener.ts` traduz o payload da Evolution e
chama a mesma ingestão. **Use o n8n se você quiser ver e ajustar a regra de coleta sem
esperar deploy** (filtrar remetente, ignorar certos formatos, enriquecer antes de entregar).
Se não for mexer, o caminho direto é menos coisa para quebrar.

Os dois caminhos gravam na mesma tabela. Dá para começar num e mudar para o outro depois —
só não aponte o webhook da Evolution para os dois ao mesmo tempo, senão cada mensagem chega
duas vezes (o motor deduplica por hash, então não corrompe nada, mas gera trabalho à toa).

## Importar

1. n8n → **Workflows → Import from File** → `coletor-grupos.json`.
2. **Variável de ambiente `MOTOR_INGEST_URL`** no n8n: copie o endereço em
   **Painel → Grupos observados → entrada do n8n**. O segredo vai na própria URL — trate
   como senha. (Se preferir, cole direto no nó "Entrega ao motor" em vez de usar variável.)
3. Ative o workflow e copie a **URL de produção** do nó de webhook.
4. Na Evolution, na instância do número **que só escuta**, configure essa URL para o evento
   `MESSAGES_UPSERT`.
5. No painel, aba **Grupos observados**, cadastre os grupos e marque o tipo de cada um.

## Por que o motor recusa grupo não cadastrado

De propósito. O número de escuta está em vários grupos — inclusive nos seus. Se o motor
aceitasse tudo que chega, você não teria como ligar e desligar a observação sem mexer no
n8n, e a base encheria de conversa que não interessa. O cadastro no painel é o interruptor.

Recusa devolve **200**, não erro: o n8n não deve marcar a execução como falha nem ficar
tentando de novo. A resposta diz o motivo (`"grupo pausado"`, `"repetido"`).

## O que trafega

Só isto:

```json
{
  "groupJid":  "120363XXXXXXXXXX@g.us",
  "text":      "texto da mensagem",
  "postedAt":  1754000000,
  "hasImage":  true,
  "instanceRef": "Listener"
}
```

`participant` e `pushName` — telefone e nome de quem postou — **existem no payload da
Evolution e são descartados no nó de código**, antes de sair do n8n. O motor limpa de novo
do lado dele. Camada dupla, de propósito: dado pessoal que nunca é gravado não vaza.

## O que NÃO fazer com isto

Republicar. Copiar a copy de outro afiliado é proibido pelos termos da Shopee, e é o tipo de
coisa que custa a conta — que é o único ponto de monetização do projeto. O que se extrai aqui
é **critério** (qual produto, que horas, com que margem), não texto.
