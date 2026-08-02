# PERGUNTAS / SETUP — o que falta (atualizado com suas respostas)

> A maioria das decisões foi resolvida. O que sobra é **setup operacional**, e agora
> quase tudo é feito **pela interface** (aba Conexões e Config), sem mexer em SQL/código.

## 🎯 ESTADO AGORA (02/08/2026) — leia isto primeiro

O motor **está no ar e trabalhando sozinho**. O que ele já faz sem você:

| | |
|---|---|
| captura da Shopee | a cada 30 min · o impasse que o deixou 7 dias parado foi corrigido |
| histórico de preço | medindo (é o que separa desconto real de desconto de anúncio) |
| varredura do cardápio | a cada 2h · **1.770 observações** já gravadas |
| painel | `https://cupom.trakads.cloud` · login ativo |

**O que só você pode fazer — e é o que separa isto de gerar receita:**

1. **Conectar um número de WhatsApp** (painel → Config → Evolution → Conexões → QR).
   Sem canal, o motor captura e mede preço mas **não entrega nada**. Já há dezenas de
   ofertas aprovadas esperando na fila. O log grita isso a cada ciclo.
2. **Entrar em grupos que postem SHOPEE** (painel → Grupos observados).
   Ver o aviso logo abaixo — não serve qualquer grupo.

## ⚠️ O grupo que você me mostrou NÃO serve para a correlação

Das 17 mensagens que você colou: **10 links Amazon, 7 Mercado Livre, ZERO Shopee.**

A correlação cruza contra a API da **Shopee**. Para aquele grupo, todo post recebe o
veredito `outra_plataforma` (etiqueta **OUTRA LOJA** no painel) — o que está **certo**, não
é falha. Foi construído assim de propósito: sem esse veredito, o painel diria "a varredura
não achou" quando a verdade é "não havia o que achar". As duas leituras levam a ações
opostas: uma manda mexer na varredura, a outra manda trocar de grupo.

Aquele grupo continua útil para o resto — cadência, categorias, uso de cupom, profundidade
de desconto. Só não alimenta a correlação.

**Dado medido dele, que contradiz o escopo:** 17 posts em 60 minutos ≈ **1 a cada 3,5 min**.
O motor está em 20–30 min. Eles disparam 6 a 8× mais rápido. Não é recomendação de copiar
(o risco de ban é seu, e o modelo deles não é grupo próprio de opt-in), mas é decisão sua,
não um default meu.

## 📉 A primeira semana de dados é um PISO, não a verdade

O atraso que o painel mostrar nos primeiros dias é **censurado à esquerda**: `first_seen_at`
é a nossa primeira observação do produto, e a varredura começou agora. Um produto que já
estava na Shopee há meses aparece como "visto hoje", então o "atraso" mede quando NÓS
começamos a olhar, não quando eles decidiram postar.

Isso não tem conserto por código (verifiquei: o `periodStartTime` da API é a janela do
programa de afiliados, idêntica para todo produto — não serve). O que foi feito é o que dava:
esses casamentos são **marcados e excluídos da mediana**, e o painel mostra quantos ficaram
de fora. Quando aparecer *"N casamentos sem base ainda"*, é isto.

## 🔍 Comando para conferir na hora

```bash
npm run intel:check
```
Puxa uma oferta real da Shopee, escreve uma mensagem no formato que os grupos usam de
verdade, e mede parse → ingestão → correlação → relatório. Seguro em produção: usa um grupo
de teste marcado como `proprio` (fica fora de todo relatório sobre "o que ELES escolhem") e
apaga tudo que criou no fim, inclusive se falhar.

## ✅ Já resolvido (não precisa fazer nada)
- **Cadência**: 20–30 min + jitter 3–5 min, pausa 00–07h, teto 250/dia. Confirmado.
- **Aprovação**: 100% automática após os filtros (com fila visível para rejeitar).
- **Bloqueios**: lista atual está boa; ajustamos por observação depois.
- **Modelo de IA**: `gpt-5.4-mini` com fallback automático — e você configura pela interface.
- **Evolution**: já roda na sua VPS; o app aponta para ela (não subo outra).

## 🔴 1. Variáveis do stack — o mínimo (você preenche; eu NUNCA vejo)
Deploy é **Docker Swarm via Portainer** (ver `DEPLOY-PORTAINER.md`), então esses valores
vão na aba **Environment variables** do stack no Portainer — não num `.env` de arquivo.
Você **não me dá** esses valores. O mínimo é:
```
POSTGRES_PASSWORD=...            # VOCÊ INVENTA — senha do banco NOVO que este app cria (não é um segredo que você já tem)
SHOPEE_APP_ID / SHOPEE_APP_SECRET  # já funcionam (testados ao vivo)
API_DOMAIN=cupom.trakads.cloud             # seu subdomínio (ver DNS)
PUBLIC_APP_URL=https://cupom.trakads.cloud # p/ o app configurar o webhook do listener
TRAEFIK_ENTRYPOINT=websecure
TRAEFIK_CERTRESOLVER=letsencryptresolver
```
A **Evolution** (URL + key global) e a **OpenAI** (chave + modelo) você configura pela
aba **Config** do painel — não precisa aqui. (Se preferir, `EVOLUTION_API_URL/KEY` e
`OPENAI_API_KEY` como variáveis também funcionam.)

**Senha do painel (opcional, decisão sua = sem senha):** o painel fica **aberto** para
quem souber a URL. Se um dia quiser trancar, basta definir `DASHBOARD_USER` e
`DASHBOARD_PASSWORD` no stack — o navegador passa a pedir login. Sem essas duas
variáveis, segue aberto (o log do `api` avisa no boot).

## 🟠 2. DNS — para onde apontar (instruções)
No painel do seu provedor de domínio (`trakads.cloud`), crie **um registro do tipo A**:
- **Tipo:** A (Address)
- **Nome/Host:** `cupom` (para ficar `cupom.trakads.cloud`) — ou `@` se for o domínio raiz
- **Valor/Aponta para:** **o IP público do seu VPS** (o mesmo que você usa pra SSH)
- **TTL:** padrão (auto)
- **Proxy (se for Cloudflare):** **DNS only** (nuvem cinza) — com o proxy ligado, o
  Let's Encrypt do seu Traefik pode não validar por HTTP-01.

Depois coloque esse domínio em `API_DOMAIN`. O **Traefik emite o HTTPS sozinho**
(resolver `letsencryptresolver`) quando o stack subir. Propagação do DNS pode levar de
minutos a algumas horas. Teste com `https://cupom.trakads.cloud/health` (deve responder
`{"ok":true}`).

## 🟡 3. Conectar/cadastrar o número (aba **Conexões**)
Depois de configurar a Evolution na aba Config, é tudo pelo painel:

**Número NOVO (o app provisiona tudo na Evolution):**
1. Digite um nome + função (poster). Clique **1. Criar + configurar** — o app cria a instância na Evolution **e já a configura pra grupos** (recebe grupos, rejeita chamadas, sem sync de histórico) e aponta o webhook pro app.
2. **2. Mostrar QR** → escaneia no celular → **3. Verificar conexão** (tem que dar `open`).
3. **Listar grupos** → **marque TODOS os grupos** em que esse número vai disparar → **Registrar canal**. (Pode marcar quantos quiser; cada grupo vira um destino.) Gotejamento começa em ~1 min.

**Número que JÁ existe na sua Evolution:** pule 1–3, clique **Listar grupos**, marque os grupos e **Registrar canal**. (Ou cole o id de um grupo no campo manual.)

**Gerenciar depois:** a lista "números cadastrados" mostra cada grupo com botões **pausar/ativar** e **remover** — é aí que você liga/desliga o disparo por grupo.

> ⚠️ A cadência (20–30 min) é **por grupo**. Um número em muitos grupos dispara mais no total — pra grupo de opt-in de baixo volume, tranquilo; se botar muitos grupos num número só, fique de olho no volume total dele.

### ⚠️ Sobre o proxy (sua pergunta: "como vou gerar isso")
Você **não gera** — você **assina** um serviço de proxy residencial/móvel BR e recebe
`host:porta:usuário:senha`. Passo a passo:
1. Contrate um provedor de **proxy residencial ou móvel do Brasil** (ex.: IPRoyal, Proxy-Cheap, Soax, Decodo/Smartproxy). Escolha IP do Brasil, de preferência **móvel (4G)** para número que posta.
2. O provedor te dá host, porta, usuário e senha.
3. Configure esse proxy **na instância da Evolution do número** (a Evolution v2 tem campos de proxy na criação da instância) **antes** de ler o QR — assim o WhatsApp desse número sai pelo IP residencial, não pelo IP do VPS (datacenter).

**Right-size honesto:** seu modelo é grupo próprio de opt-in, volume baixo (250/dia) e um número que você já usa. Nesse cenário o risco é MUITO menor que disparo frio em massa. Dá para **começar sem proxy** e adicionar só se vir sinais de bloqueio — mas, se esse número é importante pra você, um proxy móvel BR desde o início é o mais seguro. Sua escolha.

## 🟢 4. Tudo pela interface (aba **Config**)
Você não precisa editar `.env` pra isso — dá pra fazer no painel:
- **Evolution API**: cole a URL da sua Evolution (a da VPS) + a API key global → **Salvar Evolution**. Isso habilita a aba **Conexões**.
- **IA**: cole a chave da OpenAI + modelo.

No `.env` fica só o essencial de infra: `POSTGRES_PASSWORD` (você inventa), `API_DOMAIN`, `PUBLIC_APP_URL` e a Shopee.

## ✅ 5. Seu nicho — palavras-chave (APLICADO)
Configurei `CAPTURE_KEYWORDS` com o seu nicho: **tecnologia/PC** (notebook, monitor,
memória RAM, placa de vídeo, celular, SSD, headset…), **casa/eletrodomésticos**
(geladeira, fogão, air fryer, liquidificador, aspirador…) e **comida/condimentos**
(maionese, ketchup, mostarda, azeite, café, chocolate…). ~48 palavras. Edite no `.env`
quando quiser afinar (mais palavras = mais ofertas e mais chamadas à API).

## 🟣 6. Inteligência de mercado — o que depende de você

O motor agora observa o **cardápio inteiro** da Shopee (varredura larga a cada 2h, sem
filtro) e cruza com o que os grupos de promoção postam, para descobrir o critério de escolha
dos concorrentes. Duas pontas: uma já funciona sozinha, a outra precisa de você.

**Funciona sozinha (nada a fazer):** a varredura da API. Ela começa no próximo boot e passa
a registrar tudo que a Shopee oferece. Quanto mais cedo começar, mais histórico você terá
quando for analisar — **isso não é recuperável depois**, então não adianta adiar.

**Precisa de você:** entrar nos grupos de promoção com o número que só escuta e cadastrar
cada um no painel (aba **Grupos observados**). Sem grupo cadastrado não há a segunda ponta,
e sem as duas não existe correlação.

Passo a passo:

1. Use um número **separado** do que posta. Se o número de escuta for banido, você não perde
   o de disparo junto. (Entrar em grupo e só ler é risco baixo, mas não é zero.)
2. Entre nos grupos pelo celular, normalmente.
3. Painel → **Conexões** → conecte esse número → **Listar grupos** → marque os grupos →
   **Registrar para observação** (o botão ao lado do "Registrar para disparo").
4. Painel → **Grupos observados** → ajuste o **tipo** de cada grupo.

**O tipo importa mais do que parece.** Se você monitorar só grupos generalistas, vai
aprender o critério de quem vende qualquer coisa — achadinho de R$9,90, o que tem volume — e
isso não transfere para o seu nicho. Se monitorar só do nicho, a amostra demora mais a
encher. Marque os dois desde o começo: depois não dá para separar o que não foi marcado.

**Quando olhar o resultado:** dê uns 7 dias. Antes disso a amostra é pequena demais para
qualquer conclusão, e o painel vai mostrar poucos casamentos — o que parece defeito e não é.

**Se quiser usar o n8n** em vez do webhook direto (para poder ajustar a regra de coleta sem
deploy), o fluxo importável está em `n8n/coletor-grupos.json` — ver `n8n/README.md`. Não é
obrigatório: o motor recebe direto da Evolution.

## ⚠️ Correção importante nesta rodada — o motor estava parado

Achado ao verificar a produção: o motor ficou **7 dias sem capturar nada**, com o container
de pé e o `/health` respondendo 200. Não era bug de código, era impasse:

```
sem canal de WhatsApp → nada esvazia a fila → fila trava em 34 (teto 30)
      → a trava de backlog pula o ciclo → captura nunca mais roda
```

Cada peça fazia o que devia; juntas, travaram. **Corrigido:** oferta na fila agora vence por
idade (`OFFER_MAX_AGE_HOURS`, padrão 48h). Isso destrava a fila e resolve um segundo
problema que ninguém tinha notado — as 34 ofertas presas tinham preço de uma semana atrás, e
teriam ido ao ar como se fossem de hoje. O log do ciclo agora também avisa em voz alta
quando não há canal poster ativo.

## 🔵 Fase posterior (quando quiser)
- Dashboard Next.js na Vercel (o painel atual já funciona servido pela API).
- Poster de Telegram (arquitetura já é canal-agnóstica).

## Itens do código a validar ao vivo (baixo risco)
- `generateShortLink`: tipo exato do input GraphQL — o código tenta tipado e cai para inline.
- Evolution v2.1.1: shapes de resposta (id da mensagem, QR) inferidos do código-fonte oficial — confirmar no primeiro uso real.
- Evolution v2.1.1: os settings da instância (`/settings/set`, foco em grupos) e os shapes de resposta foram confirmados no código-fonte oficial (branch main) — validar no primeiro provisionamento real, pois campos podem variar por versão (ex.: `wavoipToken` só em 2.2+).
