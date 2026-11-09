#!/bin/sh
# Join WharfMaster puis démarre l’agent via docker compose (build local).
set -eu

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "Fichier .env manquant. Copiez .env.example vers .env et renseignez les valeurs." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a
. ./.env
set +a

: "${WHARFMASTER_URL:?WHARFMASTER_URL manquant dans .env}"
: "${JOIN_TOKEN:?JOIN_TOKEN manquant dans .env}"
: "${ADVERTISE_URL:?ADVERTISE_URL manquant dans .env}"
: "${NODE_NAME:?NODE_NAME manquant dans .env}"

WHARFMASTER_URL=$(echo "$WHARFMASTER_URL" | sed 's:/*$::')
ADVERTISE_URL=$(echo "$ADVERTISE_URL" | sed 's:/*$::')
AGENT_HOST_PORT="${AGENT_HOST_PORT:-9001}"
STACKS_DIR="${STACKS_DIR:-/var/lib/wharfmaster/stacks}"
AGENT_TLS_CN="${AGENT_TLS_CN:-}"
AGENT_TLS_DAYS="${AGENT_TLS_DAYS:-365}"

case "$ADVERTISE_URL" in
  https://*) ;;
  *)
    echo "ADVERTISE_URL doit commencer par https://" >&2
    exit 1
    ;;
esac

if [ -z "$AGENT_TLS_CN" ]; then
  AGENT_TLS_CN=$(echo "$ADVERTISE_URL" | sed -E 's#^https?://##' | sed 's/:.*//' | sed 's|/||g')
  [ -n "$AGENT_TLS_CN" ] || AGENT_TLS_CN="$NODE_NAME"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker est requis" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl est requis" >&2
  exit 1
fi

echo "==> Join $WHARFMASTER_URL as '$NODE_NAME' (advertise $ADVERTISE_URL)…"
JOIN_HTTP=$(mktemp)
JOIN_CODE=$(curl -sS -w '%{http_code}' -o "$JOIN_HTTP" -X POST "$WHARFMASTER_URL/api/nodes/join" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d "{\"token\":\"$JOIN_TOKEN\",\"name\":\"$NODE_NAME\",\"agentUrl\":\"$ADVERTISE_URL\"}") || {
  rm -f "$JOIN_HTTP"
  echo "Échec réseau du join." >&2
  exit 1
}
JOIN_BODY=$(cat "$JOIN_HTTP")
rm -f "$JOIN_HTTP"
case "$JOIN_CODE" in
  200|201) ;;
  *)
    echo "Join échoué (HTTP $JOIN_CODE): $JOIN_BODY" >&2
    exit 1
    ;;
esac

NODE_SECRET=$(echo "$JOIN_BODY" | sed -n 's/.*"NodeSecret"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
NODE_ID=$(echo "$JOIN_BODY" | sed -n 's/.*"NodeId"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')
if [ -z "$NODE_SECRET" ]; then
  echo "Réponse join sans NodeSecret: $JOIN_BODY" >&2
  exit 1
fi
echo "==> Nœud enregistré id=${NODE_ID:-?} — écriture de NODE_SECRET dans .env"

# Upsert NODE_SECRET in .env without printing the secret
if grep -q '^NODE_SECRET=' .env 2>/dev/null; then
  TMP=$(mktemp)
  sed "s|^NODE_SECRET=.*|NODE_SECRET=$NODE_SECRET|" .env > "$TMP"
  mv "$TMP" .env
else
  printf '\nNODE_SECRET=%s\n' "$NODE_SECRET" >> .env
fi

export NODE_SECRET
export AGENT_HOST_PORT
export STACKS_DIR
export AGENT_TLS_CN
export AGENT_TLS_DAYS
export AGENT_IMAGE="${AGENT_IMAGE:-wharfmaster-agent:local}"

mkdir -p "$STACKS_DIR"
docker rm -f wharfmaster-agent >/dev/null 2>&1 || true

echo "==> Build + démarrage (docker compose)…"
if docker compose version >/dev/null 2>&1; then
  docker compose up -d --build
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose up -d --build
else
  echo "docker compose introuvable" >&2
  exit 1
fi

echo "==> OK. Agent HTTPS: $ADVERTISE_URL"
echo "    Stacks hôte: $STACKS_DIR"
echo "    Sur le principal: Nœuds → ping #${NODE_ID:-?}"
