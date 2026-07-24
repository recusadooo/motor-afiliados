# Deploy automático (CI/CD) — setup de UMA vez

Depois deste setup, o fluxo vira: **você (ou eu preparo o commit) → `git push` → deploy sozinho no VPS.**
Sem SSH na mão, sem `docker compose` na mão, sem token de mão em mão. Os segredos ficam
no GitHub (criptografados), nunca no chat nem comigo.

## Pré-requisito: o `git push` funcionar (uma vez)
Use o GitHub CLI pra parar de brigar com token/credential manager:
```bash
winget install GitHub.cli        # ou baixe em cli.github.com
gh auth login                    # GitHub.com > HTTPS > login pelo navegador
git -C "D:/grupo-de-ofertas/app" push -u origin main
```

## Passo 1 — Gerar uma chave de deploy (no seu PC)
```bash
ssh-keygen -t ed25519 -f deploy_key -N ""
# gera:  deploy_key (privada)  +  deploy_key.pub (pública)
```

## Passo 2 — Autorizar a chave no VPS
Adicione a **pública** ao VPS (no usuário que vai fazer o deploy — root ou um `deploy`):
```bash
ssh SEU_USUARIO@IP_DO_VPS "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys" < deploy_key.pub
```

## Passo 3 — Preparar a pasta no VPS (uma vez)
```bash
ssh SEU_USUARIO@IP_DO_VPS
  mkdir -p /opt/motor-afiliados && cd /opt/motor-afiliados
  # crie o .env aqui (fica SÓ no servidor; o CI nunca sobrescreve):
  nano .env    # POSTGRES_PASSWORD, API_DOMAIN=cupom.trakads.cloud, PUBLIC_APP_URL, SHOPEE_APP_*
  chmod 600 .env
```
(A Evolution e a OpenAI você configura pela aba **Config** do painel depois — não precisam no `.env`.)

## Passo 4 — Cadastrar os segredos no GitHub
No repositório → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Valor |
|---|---|
| `VPS_HOST` | IP do seu VPS |
| `VPS_USER` | `root` (ou o usuário `deploy`) |
| `VPS_SSH_KEY` | o conteúdo da chave **privada** `deploy_key` (colar inteiro) |
| `VPS_PORT` | *(opcional)* porta do SSH, se não for 22 |
| `PROJECT_DIR` | *(opcional)* `/opt/motor-afiliados` (é o padrão) |

## Passo 5 — Pronto
A partir daqui, todo `git push` na `main` dispara o workflow (`.github/workflows/deploy.yml`),
que envia o código (rsync, preservando o `.env` do servidor) e roda `docker compose up -d --build`.
Acompanhe em **Actions** no GitHub. Redeploy manual, se precisar: `./deploy.sh` no VPS.

> Segurança: a chave de deploy tem escopo só do que você autorizar no VPS. Ideal é criar um
> usuário `deploy` (em vez de root) com acesso só à pasta do projeto e ao docker.
