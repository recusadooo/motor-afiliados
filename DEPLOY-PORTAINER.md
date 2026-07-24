# Subir no Portainer (passo a passo completo)

Você já tem Portainer + Docker + um reverse proxy na VPS (Evolution/n8n). O jeito
certo é subir o app como **Stack** apontando pro repositório do GitHub, e ligar o seu
proxy existente no app. Sem `docker compose` na mão.

O compose já vem preparado: **não sobe o Caddy** (seu proxy cuida do HTTPS) e expõe a
API na porta interna `3000`. As variáveis você põe na **interface do Portainer**.

---

## Passo 0 — DNS (faz primeiro, demora pra propagar)
No painel de `trakads.cloud`: registro tipo **A**, nome **`cupom`**, valor = **IP do VPS**.

## Passo 1 — Criar o Stack
Portainer → **Stacks** → **Add stack**:
- **Name:** `motor-afiliados`
- **Build method:** **Repository**
- **Repository URL:** `https://github.com/recusadooo/motor-afiliados`
- **Reference:** `refs/heads/main`
- **Compose path:** `docker-compose.yml`

## Passo 2 — Variáveis de ambiente (na aba do stack)
Em **Environment variables** → *Add an environment variable*, cadastre:

| Nome | Valor |
|---|---|
| `POSTGRES_PASSWORD` | uma senha que você inventa (do banco do app) |
| `SHOPEE_APP_ID` | seu AppId da Shopee |
| `SHOPEE_APP_SECRET` | seu Secret da Shopee |
| `PUBLIC_APP_URL` | `https://cupom.trakads.cloud` |

*(Evolution e OpenAI NÃO vão aqui — você configura depois na aba **Config** do painel.)*

Clique **Deploy the stack**. O Portainer clona o repo, faz o build da imagem e sobe
`postgres`, `redis`, `api`, `worker`.

## Passo 3 — Conferir que subiu
No stack, veja os 4 containers *running*. Pra testar a API, no terminal do VPS:
```bash
curl -s http://127.0.0.1:3000/health      # deve devolver {"ok":true,...}
```
(ou veja os logs do container `api` no Portainer — deve dizer "API ouvindo").

## Passo 4 — Ligar seu reverse proxy no app
O app roda; falta seu proxy mandar `cupom.trakads.cloud` pra ele. O container da API
fica na rede `motor-afiliados_default` (criada pelo stack), com nome tipo
`motor-afiliados-api-1`, porta `3000`.

**Se o proxy é Nginx Proxy Manager (o mais comum):**
1. No Portainer → Containers → seu container do **NPM** → **Join a network** → selecione **`motor-afiliados_default`**. (Isso deixa o NPM enxergar a API pelo nome.)
2. No NPM → **Proxy Hosts** → *Add Proxy Host*:
   - Domain Names: `cupom.trakads.cloud`
   - Forward Hostname/IP: `motor-afiliados-api-1`  · Forward Port: `3000`
   - Ligue **Websockets Support** e **Block Common Exploits**
   - Aba **SSL**: *Request a new SSL Certificate* + *Force SSL* → Save

**Se o proxy é Traefik / Caddy / nginx puro:** aponte `cupom.trakads.cloud` → o
container `motor-afiliados-api-1:3000` (mesma rede) **com WebSocket**. Me diz qual é que
eu te dou o bloco exato.

> Alternativa (proxy fora do Docker): a API também está publicada em `127.0.0.1:3000`
> no host — aponte seu proxy pra lá.

## Passo 5 — Testar e configurar
- Abra `https://cupom.trakads.cloud/health` → `{"ok":true}`.
- Abra `https://cupom.trakads.cloud/` → o painel.
- Aba **Config**: cole URL + key da sua **Evolution** e a chave da **OpenAI**.
- Aba **Conexões**: conecte/cadastre o número e **marque os grupos**.

## Atualizar depois
Toda vez que houver mudança no código: no Portainer → o stack → **Pull and redeploy**
(ou **Update the stack** com *Re-pull image and redeploy*). Ele puxa do GitHub e sobe de novo.
(Se preferir 100% automático, o repo também tem GitHub Actions — ver `DEPLOY.md`.)

## Sem reverse proxy? (caso raro)
Se a VPS NÃO tiver proxy nas portas 80/443, adicione a variável `COMPOSE_PROFILES=edge`
no stack e preencha também `API_DOMAIN=cupom.trakads.cloud` — aí o Caddy do app sobe e
cuida do HTTPS sozinho.
