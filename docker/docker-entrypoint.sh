#!/bin/sh
set -eu

SOCK="${DOCKER_SOCKET:-/var/run/docker.sock}"

if [ ! -S "$SOCK" ] && [ -S /var/run/docker.sock ]; then
  SOCK=/var/run/docker.sock
  export DOCKER_SOCKET="$SOCK"
fi

if [ -S "$SOCK" ]; then
  SOCK_GID="$(stat -c '%g' "$SOCK" 2>/dev/null || stat -f '%g' "$SOCK")"
  if getent group docker >/dev/null 2>&1; then
    groupmod -o -g "$SOCK_GID" docker 2>/dev/null || true
  else
    groupadd -o -g "$SOCK_GID" docker 2>/dev/null || groupadd docker || true
  fi
  usermod -aG docker www-data 2>/dev/null || true
elif [ -e /var/run/docker.so ]; then
  echo "[wharfmaster] WARN: /var/run/docker.so found but ignored — set DOCKER_SOCKET to a real docker.sock" >&2
fi

export WHARFMASTER_VAR="${WHARFMASTER_VAR:-/var/www/html/var}"

php /var/www/html/bin/migrate-legacy.php || true
php /var/www/html/bin/init.php || true
chown -R www-data:www-data /var/www/html/var
chmod 700 /var/www/html/var

if [ ! -x /usr/local/bin/trivy ] && [ ! -x /usr/bin/trivy ]; then
  echo "[wharfmaster] WARN: trivy binary missing — image CVE scans will fail. Rebuild the image." >&2
else
  export PATH="/usr/local/bin:${PATH}"
fi

# Interactive console WebSocket bridge (local docker + agent proxy)
if [ -x /usr/local/bin/console-ws ]; then
  export CONSOLE_WS_MODE="${CONSOLE_WS_MODE:-server}"
  export CONSOLE_WS_LISTEN="${CONSOLE_WS_LISTEN:-127.0.0.1:9100}"
  export JWT_SECRET_FILE="${JWT_SECRET_FILE:-${WHARFMASTER_VAR}/jwt.secret}"
  export SQLITE_PATH="${SQLITE_PATH:-${WHARFMASTER_VAR}/dockermanager.sqlite}"
  export DOCKER_SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"
  export DOCKER_API_VERSION="${DOCKER_API_VERSION:-v1.45}"
  echo "[wharfmaster] starting console-ws on ${CONSOLE_WS_LISTEN}"
  /usr/local/bin/console-ws >>/tmp/console-ws.log 2>&1 &
else
  echo "[wharfmaster] WARN: console-ws binary missing — interactive console disabled" >&2
fi

exec "$@"
