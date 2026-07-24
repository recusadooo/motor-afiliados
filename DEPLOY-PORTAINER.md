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
| `API_DOMAIN` | `cupom.trakads.cloud` |
| `TRAEFIK_ENTRYPOINT` | o entrypoint HTTPS do seu Traefik (ex.: `websecure` ou `https`) |
| `TRAEFIK_CERTRESOLVER` | o resolver ACME do seu Traefik (ex.: `letsencrypt`) |
| `TRAEFIK_NETWORK` | a rede Docker do seu Traefik (ver Passo 4) |

*(Evolution e OpenAI NÃO vão aqui — você configura depois na aba **Config** do painel.)*
*(Não sabe os 3 valores do Traefik? **Copie dos labels de um serviço que você já expõe pelo Traefik** — Evolution/n8n — no Portainer, na aba Labels daquele container. Ou me mande um desses labels que eu te digo os valores exatos.)*

Clique **Deploy the stack**. O Portainer clona o repo, faz o build da imagem e sobe
`postgres`, `redis`, `api`, `worker`.

## Passo 3 — Conferir que subiu
No stack, veja os 4 containers *running*. Pra testar a API, no terminal do VPS:
```bash
curl -s http://127.0.0.1:3000/health      # deve devolver {"ok":true,...}
```
(ou veja os logs do container `api` no Portainer — deve dizer "API ouvindo").

## Passo 4 — Ligar o Traefik no app
Com Traefik é por **labels** (o compose já traz, controlados pelas variáveis do Passo 2).
Falta só o Traefik **enxergar** o container da API na rede Docker.

**4.1 — Descobrir a rede do seu Traefik:** no Portainer → Containers → o container do
**Traefik** → aba **Network** (ou Inspect). É a rede por onde ele fala com Evolution/n8n
(nome comum: `traefik`, `proxy`, ou similar). Ponha esse nome em **`TRAEFIK_NETWORK`** (Passo 2).

**4.2 — Colocar a API na mesma rede do Traefik.** Duas formas:
- **Simples (Portainer):** Containers → `motor-afiliados-api-1` → **Join a network** → selecione a rede do Traefik. (E confira que `TRAEFIK_NETWORK` tem esse nome.)
- Ou o Traefik entra na rede do stack: Containers → container do Traefik → **Join a network** → `motor-afiliados_default`, e ponha `TRAEFIK_NETWORK=motor-afiliados_default`.

**4.3 — Entrypoint e certresolver:** os labels usam `TRAEFIK_ENTRYPOINT` (o entrypoint
`:443`, ex. `websecure`) e `TRAEFIK_CERTRESOLVER` (o ACME, ex. `letsencrypt`). **Copie os
valores exatos** de um serviço que você já expõe pelo Traefik (olhe os labels da Evolution/n8n):
```
traefik.http.routers.<algo>.entrypoints=SEU_ENTRYPOINT
traefik.http.routers.<algo>.tls.certresolver=SEU_RESOLVER
```
Se não usar `certresolver` por label (ex.: TLS definido no traefik.yml), deixe
`TRAEFIK_CERTRESOLVER` como está — se der erro de cert, a gente ajusta.

Pronto: ao dar deploy/redeploy do stack, o Traefik já roteia `cupom.trakads.cloud` → a API
(porta 3000) com TLS.

> Dica: me mande **os labels do Traefik de um serviço seu que já funciona** (Evolution ou
> n8n) que eu te devolvo os 3 valores (`TRAEFIK_ENTRYPOINT`, `TRAEFIK_CERTRESOLVER`,
> `TRAEFIK_NETWORK`) já certinhos pra colar.

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
