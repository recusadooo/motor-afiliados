#!/usr/bin/env bash
# Redeploy manual no VPS (o CI faz isso sozinho a cada push; este é pra rodar na mão).
set -euo pipefail
cd "$(dirname "$0")"
docker compose up -d --build
docker compose ps
