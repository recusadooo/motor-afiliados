# Motor de Afiliados — `app/`

Subpasta **deployável e limpa** do projeto. É **só daqui** que se faz deploy/upload. A raiz `D:\grupo-de-ofertas` (com `.env` e `credenciais.txt` reais) **nunca** sobe para lugar nenhum.

> Escopo congelado em 2026-07-23. Fonte: `../docs/PLANO.md`, `../docs/INVESTIGACAO-FRAUDE-WHATSAPP.md`, `../CLAUDE.md`.

## O que a máquina faz

Captura ofertas da Shopee → troca pelo link de afiliado do dono → reescreve a copy com IA → posta **num grupo próprio de WhatsApp** em gotejamento, respeitando cadência anti-ban. Uma fila visível permite rejeitar qualquer oferta antes do ar.

## Decisões de escopo (congeladas)

| Tema | Decisão |
|---|---|
| **Fonte de produção** | Shopee Open API (`productOfferV2` / `shopeeOfferV2`) — **testada e funcionando**. |
| **Saída** | **1 grupo de WhatsApp próprio** (opt-in), via Evolution API. Não é disparo individual. |
| **Número de saída** | Um número do dono, dedicado a isto (rotacionável depois). |
| **Enriquecimento** | Listener **read-only** de outros grupos de WhatsApp, em **número separado**, só para inteligência de mercado / entender como tratar os dados da API oficial. Não republica ao vivo. |
| **IA de copy** | GPT-5.4-mini (Structured Outputs strict + moderação). A IA nunca escreve números: usa placeholders e o app substitui pelos valores reais. |
| **Cadência** | Intervalo base **20–30 min** (aleatório) + **jitter 3–5 min** (aleatório, da carga da VPS) entre posts; pausa 00h–07h. `daily_cap` = **250/dia**. |
| **Jitter** | O tempo exato sai da **oscilação de carga da VPS** (entropia real, nunca mecânico). Nota: anti-ban vem da distribuição parecer humana; a fonte da aleatoriedade é indiferente à Meta. |
| **Fura-fila** | Oferta excepcional (desconto **real** validado alto **ou** economia absoluta grande) pula à frente, com gap mínimo para não virar rajada. |
| **Aprovação** | 100% automático após os filtros, **mas** com fila visível e janela de rejeição manual por canal. |
| **Facebook** | **Fora do escopo.** |
| **Telegram** | Adiado (poster opcional numa fase futura). |
| **Hospedagem** | VPS próprio, Docker Compose. Dashboard (fase posterior) na Vercel. |
| **Segredos** | Vivem em `.env` **no servidor** (chmod 600), nunca no repo. `app/` sobe sem segredo. |

## Arquitetura (resumo)

```
Shopee Open API ─┐
                 ├─► ingest ─► process (extrai/valida link, gera afiliado,
WA listener ─────┘             dedup, filtros, desconto-real, copy IA)
(número B, read-only)                     │
                                          ▼
                              fila (BullMQ/Redis) + scheduler
                              cadência 15–30min + fura-fila
                                          │
                                          ▼
                              poster ─► grupo WhatsApp (número A)
                                          │
                                          ▼
                              send_logs (idempotência) + audit
```

Regra de ouro: **quem captura nunca posta.** O listener só grava e enfileira.

## Estrutura de pastas

```
app/
  README.md            ← este arquivo
  PERGUNTAS.md         ← o que depende de você (segredos, número, keywords…)
  .env.example         ← nomes das variáveis (sem valores)
  Dockerfile           ← build multi-stage (TS -> dist)
  docker-compose.yml   ← Swarm stack: postgres, redis, api, worker (Evolution é externa)
  DEPLOY-PORTAINER.md  ← subir no Portainer/Swarm com Traefik v3 (passo a passo)
  db/schema.sql        ← modelo de dados PostgreSQL
  src/
    config.ts          ← env validado (zod)
    logger.ts db.ts redis.ts util.ts types.ts
    resilience/        ← retry (backoff+jitter), circuit breaker
    shopee/            ← client assinado (SHA256) + queries + generateShortLink
    pipeline/          ← normalize, dedup, priceHistory, fakeDiscount, filters,
                          affiliate, copy (IA c/ placeholders), process
    ai/openai.ts       ← Structured Outputs + moderação (com fallback de modelo)
    capture/shopeeFeed ← puxa ofertas -> raw_captures -> fila
    queue/             ← queues, processWorker, scheduler (gotejamento + fura-fila)
    whatsapp/          ← evolution (client), poster, listener (enriquecimento)
    api.ts             ← REST + webhook + WS (entrypoint)
    worker.ts          ← workers + cron de captura (entrypoint)
    commands/          ← shopeeCheck (teste ao vivo), captureOnce
```

## Fluxo dos dados

`worker.ts` roda a **captura** por cron → grava `raw_captures` → enfileira `process`.
O **processWorker** normaliza, registra preço, aplica filtros/desconto-real, gera o
link de afiliado, escreve a copy (IA) e grava em `offers` (status `approved`).
O **scheduler** (drip) puxa a próxima oferta elegível, faz o *claim* idempotente em
`send_logs` e posta no grupo via Evolution, reagendando-se com intervalo aleatório.

## Como rodar

**Local (dev):**
```bash
npm install
npm run typecheck          # valida tudo
npm run shopee:check       # testa a Shopee Open API ao vivo (read-only)
npm run capture:once       # 1 ciclo de captura -> banco (precisa Postgres+Redis)
```

**Produção (VPS — Docker Swarm + Traefik v3, via Portainer):** passo a passo completo em
[`DEPLOY-PORTAINER.md`](DEPLOY-PORTAINER.md). Resumo:
1. Aponte o DNS (registro **A** do subdomínio → IP do VPS).
2. GitHub Actions já publica a imagem em `ghcr.io/recusadooo/motor-afiliados:latest` a cada push.
3. Portainer (ambiente Swarm) → **Stacks → Add stack → Repository** apontando pro `docker-compose.yml` deste repo.
4. Variáveis na aba do stack: `POSTGRES_PASSWORD`, `SHOPEE_APP_ID`, `SHOPEE_APP_SECRET`, `API_DOMAIN`, `PUBLIC_APP_URL`, `TRAEFIK_ENTRYPOINT`, `TRAEFIK_CERTRESOLVER`. O Traefik roteia e emite o TLS pelos `deploy.labels`; o `worker` aplica o schema do banco no boot.
5. Abra o painel em `https://SEU-DOMINIO/` → aba **Config**: cole a URL + key da sua **Evolution** (e a chave da OpenAI).
6. Aba **Conexões**: número novo → **Criar + configurar** (o app cria a instância na Evolution e já a configura pra grupos + webhook) → **QR** → **Listar grupos** → **Registrar canal**. Número que já existe → só registrar (nome da instância + id do grupo). Sem SQL manual.

O `worker` recheca canais novos a cada minuto — assim que você registra um número, o gotejamento começa.

> Detalhes e escolhas em `PERGUNTAS.md`.
