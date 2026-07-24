# PERGUNTAS / SETUP — o que falta (atualizado com suas respostas)

> A maioria das decisões foi resolvida. O que sobra é **setup operacional**, e agora
> quase tudo é feito **pela interface** (aba Conexões e Config), sem mexer em SQL/código.

## ✅ Já resolvido (não precisa fazer nada)
- **Cadência**: 20–30 min + jitter 3–5 min, pausa 00–07h, teto 250/dia. Confirmado.
- **Aprovação**: 100% automática após os filtros (com fila visível para rejeitar).
- **Bloqueios**: lista atual está boa; ajustamos por observação depois.
- **Modelo de IA**: `gpt-5.4-mini` com fallback automático — e você configura pela interface.
- **Evolution**: já roda na sua VPS; o app aponta para ela (não subo outra).

## 🔴 1. `.env` do servidor — o mínimo (você preenche; eu NUNCA vejo)
Importante: você **não me dá** esses valores. Eles ficam no `.env` no seu servidor e o
app lê em runtime. O mínimo é:
```
POSTGRES_PASSWORD=...            # VOCÊ INVENTA — senha do banco NOVO que este app cria (não é um segredo que você já tem)
API_DOMAIN=api.suamarca.com.br   # seu subdomínio (ver DNS)
PUBLIC_APP_URL=https://api.suamarca.com.br   # p/ o app configurar o webhook do listener
# SHOPEE_APP_ID / SHOPEE_APP_SECRET — já funcionam
```
A **Evolution** (URL + key global) e a **OpenAI** (chave + modelo) você configura pela
aba **Config** do painel — não precisa no `.env`. (Se preferir, `EVOLUTION_API_URL/KEY` e
`OPENAI_API_KEY` no `.env` também funcionam.)

## 🟠 2. DNS — para onde apontar (instruções)
No painel do seu provedor de domínio, crie **um registro do tipo A**:
- **Tipo:** A (Address)
- **Nome/Host:** `api` (para ficar `api.suamarca.com.br`) — ou `@` se for o domínio raiz
- **Valor/Aponta para:** **o IP público do seu VPS** (o mesmo que você usa pra SSH — está no seu `.env`)
- **TTL:** padrão (auto)

Depois coloque esse domínio em `API_DOMAIN` no `.env`. O **Caddy emite o HTTPS sozinho** (Let's Encrypt) quando o app subir. Propagação do DNS pode levar de minutos a algumas horas. Teste com `https://api.suamarca.com.br/health` (deve responder `{"ok":true}`).

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

## 🔵 Fase posterior (quando quiser)
- Dashboard Next.js na Vercel (o painel atual já funciona servido pela API).
- Poster de Telegram (arquitetura já é canal-agnóstica).

## Itens do código a validar ao vivo (baixo risco)
- `generateShortLink`: tipo exato do input GraphQL — o código tenta tipado e cai para inline.
- Evolution v2.1.1: shapes de resposta (id da mensagem, QR) inferidos do código-fonte oficial — confirmar no primeiro uso real.
- Evolution v2.1.1: os settings da instância (`/settings/set`, foco em grupos) e os shapes de resposta foram confirmados no código-fonte oficial (branch main) — validar no primeiro provisionamento real, pois campos podem variar por versão (ex.: `wavoipToken` só em 2.2+).
