#!/bin/sh
set -eu

PORT="${AGENT_PORT:-9001}"
INTERNAL_PORT="${AGENT_INTERNAL_PORT:-9002}"
CERT_DIR="${AGENT_CERT_DIR:-/data/certs}"
DAYS="${AGENT_TLS_DAYS:-365}"
CN="${AGENT_TLS_CN:-wharfmaster-agent}"

STACKS_DIR="${AGENT_STACKS_DIR:-/data/stacks}"
mkdir -p "$CERT_DIR" "$STACKS_DIR"
CERT="$CERT_DIR/cert.pem"
KEY="$CERT_DIR/key.pem"

need_new=0
if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  need_new=1
elif ! openssl x509 -checkend $((30 * 86400)) -noout -in "$CERT" >/dev/null 2>&1; then
  echo "==> TLS certificate expires within 30 days — renewing"
  need_new=1
fi

if [ "$need_new" = 1 ]; then
  echo "==> Generating self-signed TLS certificate (CN=$CN, ${DAYS}d)"
  openssl req -x509 -newkey rsa:2048 \
    -keyout "$KEY" -out "$CERT" \
    -days "$DAYS" -nodes \
    -subj "/CN=${CN}/O=WharfMaster Agent/C=FR" \
    2>/dev/null
  chmod 600 "$KEY"
  chmod 644 "$CERT"
fi

EXP_TEXT=$(openssl x509 -enddate -noout -in "$CERT" 2>/dev/null | sed 's/^notAfter=//')
echo "$EXP_TEXT" > "$CERT_DIR/expires.txt"
# GNU date may be missing on Alpine — parse with openssl -checkend only; epoch via python/php
php -r '$c=@file_get_contents($argv[1]); $x=@openssl_x509_parse($c); echo (int)($x["validTo_time_t"]??0);' "$CERT" > "$CERT_DIR/expires.epoch" || echo 0 > "$CERT_DIR/expires.epoch"
echo "==> TLS cert valid until: ${EXP_TEXT:-unknown}"

php -S "127.0.0.1:${INTERNAL_PORT}" /app/router.php >/tmp/agent-php.log 2>&1 &
sleep 0.5

echo "==> Agent HTTPS on 0.0.0.0:${PORT} (self-signed TLS)"
exec socat \
  "OPENSSL-LISTEN:${PORT},cert=${CERT},key=${KEY},verify=0,reuseaddr,fork" \
  "TCP:127.0.0.1:${INTERNAL_PORT}"
