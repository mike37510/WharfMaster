#!/bin/sh
set -eu

SOCK="${DOCKER_SOCKET:-/var/run/docker.sock}"

# Compat : certains hôtes exposent docker.so
if [ ! -S "$SOCK" ] && [ -S /var/run/docker.so ]; then
  SOCK=/var/run/docker.so
  export DOCKER_SOCKET="$SOCK"
fi
if [ ! -S "$SOCK" ] && [ -S /var/run/docker.sock ]; then
  SOCK=/var/run/docker.sock
  export DOCKER_SOCKET="$SOCK"
fi

# Aligner le groupe « docker » sur le GID du socket (Apache reprend les groupes de www-data)
if [ -S "$SOCK" ]; then
  SOCK_GID="$(stat -c '%g' "$SOCK" 2>/dev/null || stat -f '%g' "$SOCK")"
  if getent group docker >/dev/null 2>&1; then
    groupmod -o -g "$SOCK_GID" docker 2>/dev/null || true
  else
    groupadd -o -g "$SOCK_GID" docker 2>/dev/null || groupadd docker || true
  fi
  usermod -aG docker www-data 2>/dev/null || true
fi

mkdir -p /var/www/html/data/compose /var/www/html/data/dockerfiles /var/www/html/data/rate_limit
chown -R www-data:www-data /var/www/html/data
chmod 700 /var/www/html/data

# Ensure Trivy is on PATH for CVE scans (baked into image; warn if missing)
if [ ! -x /usr/local/bin/trivy ] && [ ! -x /usr/bin/trivy ]; then
  echo "[wharfmaster] WARN: trivy binary missing — image CVE scans will fail. Rebuild the image." >&2
else
  export PATH="/usr/local/bin:${PATH}"
fi

# Démarrer Apache en root (bind :80) — il droppera vers www-data + groupes secondaires
exec "$@"
