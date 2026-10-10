#!/usr/bin/env bash
# agentmesh acceptance demo: runs end to end against the deployed Worker and real Cloudflare Artifacts.
# Needs .env at the repo root with CLOUDFLARE_API_TOKEN (Artifacts edit) and AGENTMESH_API_KEY.
set -euo pipefail
cd "$(dirname "$0")"
command -v pnpm >/dev/null || { echo "pnpm is required" >&2; exit 1; }
[ -d node_modules ] || pnpm install --silent
exec pnpm exec tsx src/run.ts "$@"
