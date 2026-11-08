#!/bin/sh
# WharfMaster agent installer — HTTPS (self-signed) on port 9001 by default.
set -eu

URL=""
TOKEN=""
ADVERTISE=""
NAME=""
PORT="9001"
# Prefer versioned tag (principal injects --image); latest only as last resort
IMAGE="${WHARFMASTER_AGENT_IMAGE:-ghcr.io/mike37510/wharfmaster-agent:2.0.0}"
CONTAINER_NAME="wharfmaster-agent"
TLS_CN=""
TLS_DAYS="365"
STACKS_DIR="/var/lib/wharfmaster/stacks"

usage() {
  cat <<EOF
Usage: sh install.sh --url <principal> --token <wmj_...> --advertise <https://host:9001> --name <node-name>

Les échanges agent ↔ principal sont en HTTPS (certificat autosigné, renouvelé auto ~30j avant expiry).

Options:
  --url URL          WharfMaster principal base URL (https://...)
  --token TOKEN      Join token (wmj_...)
  --advertise URL    URL publique HTTPS de cet agent (ex: https://192.168.1.5:9001)
  --name NAME        Nom du nœud
  --port PORT        Port publié (défaut 9001)
  --tls-cn CN        CN du certificat autosigné (défaut = hostname / name)
  --tls-days N       Durée du certificat en jours (défaut 365)
  --stacks-dir DIR   Répertoire hôte des stacks Compose (défaut $STACKS_DIR)
  --image IMAGE      Image agent (défaut $IMAGE)
  --help             Aide
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --advertise) ADVERTISE="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --tls-cn) TLS_CN="${2:-}"; shift 2 ;;
    --tls-days) TLS_DAYS="${2:-}"; shift 2 ;;
    --stacks-dir) STACKS_DIR="${2:-}"; shift 2 ;;
    --image) IMAGE="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

if [ -z "$URL" ] || [ -z "$TOKEN" ] || [ -z "$ADVERTISE" ] || [ -z "$NAME" ]; then
  echo "Missing required arguments." >&2
  usage
  exit 1
fi

URL=$(echo "$URL" | sed 's:/*$::')
ADVERTISE=$(echo "$ADVERTISE" | sed 's:/*$::')

case "$ADVERTISE" in
  https://*) ;;
  http://*)
    echo "ERROR: --advertise must use https:// (TLS required between principal and agents)." >&2
    echo "Example: --advertise https://192.168.1.5:9001" >&2
    exit 1
    ;;
  *)
    echo "ERROR: --advertise must start with https://" >&2
    exit 1
    ;;
esac

if [ -z "$TLS_CN" ]; then
  TLS_CN=$(echo "$ADVERTISE" | sed -E 's#^https?://##' | sed 's/:.*//' | sed 's|/||g')
  [ -n "$TLS_CN" ] || TLS_CN="$NAME"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required on this host" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required on this host" >&2
  exit 1
fi

SOCK=""
for c in /var/run/docker.sock /var/run/docker.so; do
  if [ -S "$c" ] || [ -e "$c" ]; then
    SOCK="$c"
    break
  fi
done
if [ -z "$SOCK" ]; then
  echo "Docker socket not found" >&2
  exit 1
fi

echo "==> Joining WharfMaster at $URL as '$NAME'..."
JOIN_HTTP=$(mktemp)
JOIN_JSON=$(curl -sS -w '%{http_code}' -o "$JOIN_HTTP" -X POST "$URL/api/nodes/join" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d "{\"token\":\"$TOKEN\",\"name\":\"$NAME\",\"agentUrl\":\"$ADVERTISE\"}") || {
  rm -f "$JOIN_HTTP"
  echo "Join failed. Check token, URL, and network." >&2
  exit 1
}
JOIN_BODY=$(cat "$JOIN_HTTP")
rm -f "$JOIN_HTTP"
# 200 = rejoin (idempotent), 201 = first join
case "$JOIN_JSON" in
  200|201) ;;
  *)
    echo "Join failed (HTTP $JOIN_JSON): $JOIN_BODY" >&2
    exit 1
    ;;
esac
JOIN_JSON="$JOIN_BODY"

NODE_SECRET=$(echo "$JOIN_JSON" | sed -n 's/.*"NodeSecret"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
NODE_ID=$(echo "$JOIN_JSON" | sed -n 's/.*"NodeId"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')
REJOINED=$(echo "$JOIN_JSON" | sed -n 's/.*"Rejoined"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p')

if [ -z "$NODE_SECRET" ]; then
  echo "Join response missing NodeSecret: $JOIN_JSON" >&2
  exit 1
fi

if [ "$REJOINED" = "true" ]; then
  echo "==> Rejoined existing node id=$NODE_ID (secret renewed)"
else
  echo "==> Registered node id=$NODE_ID"
fi
echo "==> Starting HTTPS agent on port $PORT (CN=$TLS_CN, ${TLS_DAYS}d)..."

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker volume create wharfmaster-agent-certs >/dev/null 2>&1 || true
mkdir -p "$STACKS_DIR"

run_agent() {
  docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    -e "NODE_SECRET=$NODE_SECRET" \
    -e "DOCKER_SOCKET=/var/run/docker.sock" \
    -e "AGENT_PORT=9001" \
    -e "AGENT_TLS_CN=$TLS_CN" \
    -e "AGENT_TLS_DAYS=$TLS_DAYS" \
    -e "AGENT_CERT_DIR=/data/certs" \
    -e "AGENT_STACKS_DIR=/data/stacks" \
    -v "$SOCK:/var/run/docker.sock" \
    -v wharfmaster-agent-certs:/data/certs \
    -v "${STACKS_DIR}:/data/stacks" \
    -p "${PORT}:9001" \
    "$@"
}

image_has_compose() {
  docker run --rm --entrypoint sh "$1" -c \
    'docker compose version >/dev/null 2>&1 || docker-compose version >/dev/null 2>&1'
}

build_local_agent() {
  echo "==> Building local agent image from principal files (docker compose inclus)"
  BUILD=$(mktemp -d)
  fetch() {
    # Prefer static source download; fail clearly on HTML/JSON error pages
    curl -fsS -H 'Accept: text/plain,*/*' "$1" -o "$2"
    if ! head -c 20 "$2" | grep -q .; then
      echo "Empty download: $1" >&2
      exit 1
    fi
    if head -c 1 "$2" | grep -q '{'; then
      echo "Got JSON instead of source from $1 — principal must serve agent files as static." >&2
      exit 1
    fi
  }
  fetch "$URL/public/agent/agent.php" "$BUILD/agent.php"
  fetch "$URL/public/agent/router.php" "$BUILD/router.php"
  fetch "$URL/public/agent/entrypoint.sh" "$BUILD/entrypoint.sh"
  curl -fsS "$URL/public/agent/Dockerfile" -o "$BUILD/Dockerfile" 2>/dev/null || cat > "$BUILD/Dockerfile" <<'DF'
FROM php:8.3-cli-alpine
RUN apk add --no-cache curl openssl socat docker-cli docker-cli-compose
WORKDIR /app
COPY agent.php router.php entrypoint.sh /app/
RUN chmod +x /app/entrypoint.sh
ENV AGENT_PORT=9001 AGENT_CERT_DIR=/data/certs AGENT_STACKS_DIR=/data/stacks AGENT_TLS_DAYS=365
VOLUME ["/data/certs", "/data/stacks"]
EXPOSE 9001
CMD ["/app/entrypoint.sh"]
DF
  chmod +x "$BUILD/entrypoint.sh"
  # Sanity: agent.php must be PHP source, not an executed API response
  if ! grep -q 'WharfMaster remote agent' "$BUILD/agent.php"; then
    echo "Downloaded agent.php does not look like source code." >&2
    exit 1
  fi
  docker build -t wharfmaster-agent:local "$BUILD"
  rm -rf "$BUILD"
}

AGENT_IMAGE=""
if docker pull "$IMAGE" >/dev/null 2>&1; then
  if image_has_compose "$IMAGE"; then
    AGENT_IMAGE="$IMAGE"
  else
    echo "==> Image tirée sans docker compose — rebuild local requis"
    build_local_agent
    AGENT_IMAGE="wharfmaster-agent:local"
  fi
else
  echo "Image pull failed — building local agent image from principal files"
  build_local_agent
  AGENT_IMAGE="wharfmaster-agent:local"
fi

run_agent "$AGENT_IMAGE"

sleep 2
echo "==> Done. Agent HTTPS: $ADVERTISE"
echo "    Certificat autosigné (renouvellement auto si < 30 jours restants)."
echo "    Stacks Compose sur l’hôte: $STACKS_DIR"
echo "    Image agent: $AGENT_IMAGE"
echo "    Sur le principal: Nœuds → ping #$NODE_ID"
