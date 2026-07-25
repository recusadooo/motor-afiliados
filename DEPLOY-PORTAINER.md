# Subir no Portainer (Docker Swarm) — passo a passo

Seu ambiente é **Docker Swarm** com **Traefik v3** (rede `TrakAdsNet`, entrypoint
`websecure`, resolver `letsencryptresolver`). O deploy é:

1. GitHub Actions **builda a imagem** e publica no **ghcr.io** (Swarm não faz build).
2. Você cria um **Swarm stack** no Portainer apontando pro compose do repo.
3. O **Traefik** roteia `cupom.trakads.cloud` → a API automaticamente (via `deploy.labels`).

---

## Passo 0 — DNS
Registro **A**: nome `cupom` → **IP do VPS**.

## Passo 1 — Gerar a imagem (uma vez)
Todo push na `main` dispara o workflow `build.yml` (GitHub → aba **Actions**), que
publica `ghcr.io/recusadooo/motor-afiliados:latest`. Depois do 1º build:
- GitHub → seu perfil → **Packages** → `motor-afiliados` → **Package settings** →
  **Change visibility → Public**. (A imagem não tem segredo; público evita ter que
  autenticar o Swarm no registry.)

## Passo 2 — Criar o stack no Portainer
Portainer (ambiente **Swarm**) → **Stacks → Add stack**:
- **Name:** `motor-afiliados`  *(vira o prefixo das redes/serviços)*
- **Build method:** **Repository**
- **Repository URL:** `https://github.com/recusadooo/motor-afiliados`
- **Compose path:** `docker-compose.yml`

## Passo 3 — Variáveis (aba Environment variables)
| Nome | Valor |
|---|---|
| `POSTGRES_PASSWORD` | a senha do banco (pode ser a que já está no seu `.env` — é só esse campo, em nenhum outro lugar). Aceita `@ : / # $ %` e espaço: o app monta a URL de conexão com percent-encoding. |
| `SHOPEE_APP_ID` | seu AppId |
| `SHOPEE_APP_SECRET` | seu Secret |
| `PUBLIC_APP_URL` | `https://cupom.trakads.cloud` |
| `API_DOMAIN` | `cupom.trakads.cloud` |
| `TRAEFIK_ENTRYPOINT` | `websecure` |
| `TRAEFIK_CERTRESOLVER` | `letsencryptresolver` |

*(Evolution e OpenAI vão depois na aba **Config** do painel, não aqui.)*

Clique **Deploy the stack**. O Swarm puxa a imagem do ghcr e sobe os serviços; o
`worker` aplica o schema do banco sozinho no boot.

## Passo 4 — Traefik (já automático)
O serviço `api` já entra na rede `TrakAdsNet` e traz os labels de roteamento em
`deploy.labels`. O Traefik v3 (provider swarm) detecta e emite o cert. **Nada a fazer.**

> Se o Traefik for **< v3.2.2**, troque no compose `traefik.swarm.network` por
> `traefik.docker.network` (confira com `traefik version`). Em 3.2.2+ está certo.

## Passo 5 — Testar e configurar
- `https://cupom.trakads.cloud/health` → `{"ok":true}` (pode levar ~1 min pro cert).
- `https://cupom.trakads.cloud/` → o painel.
- Aba **Config**: URL + key da **Evolution** e a chave da **OpenAI**.
- Aba **Conexões**: conecte/cadastre o número e **marque os grupos**.

## Atualizar depois
`git push` → o `build.yml` publica a imagem nova. Aí, no Portainer, no stack →
**Update / Pull and redeploy** (ou configure um **webhook** no stack e cadastre o secret
`PORTAINER_WEBHOOK` no GitHub pra ficar 100% automático).

## Solução de problemas
- **Serviço reiniciando:** normal nos primeiros segundos (o `worker` espera o Postgres). Veja os logs no Portainer.
- **502 no domínio:** o `api` ainda não subiu, ou o Traefik não achou a rede — confira que `TrakAdsNet` é a rede certa e que a API está *running*.
- **Imagem não baixa:** torne o pacote ghcr **público** (Passo 1) ou configure credencial de registry no Swarm.
