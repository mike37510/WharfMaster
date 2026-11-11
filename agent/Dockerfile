FROM php:8.3-cli-alpine

RUN apk add --no-cache curl openssl socat docker-cli docker-cli-compose \
 && docker-php-ext-enable opcache 2>/dev/null || true \
 && (docker compose version >/dev/null 2>&1 || docker-compose version >/dev/null 2>&1) \
 && printf '%s\n' \
      'memory_limit=1024M' \
      'post_max_size=350M' \
      'upload_max_filesize=350M' \
      'max_execution_time=900' \
      'max_input_time=900' \
      > /usr/local/etc/php/conf.d/zz-wharfmaster-uploads.ini

# Trivy for remote image CVE scans (default)
RUN set -eux; \
  TRIVY_VERSION=0.76.2; \
  ARCH=$(uname -m); \
  case "$ARCH" in x86_64) TARCH=64bit ;; aarch64) TARCH=ARM64 ;; *) TARCH=64bit ;; esac; \
  curl -fsSL "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-${TARCH}.tar.gz" \
    -o /tmp/trivy.tgz; \
  tar -xzf /tmp/trivy.tgz -C /usr/local/bin trivy; \
  rm -f /tmp/trivy.tgz; \
  chmod 0755 /usr/local/bin/trivy; \
  /usr/local/bin/trivy --version

WORKDIR /app
COPY agent.php /app/agent.php
COPY router.php /app/router.php
COPY entrypoint.sh /app/entrypoint.sh
# Prebuilt console-ws (interactive TTY) — fetched by install.sh into build context
COPY console-ws /usr/local/bin/console-ws
RUN chmod +x /app/entrypoint.sh /usr/local/bin/console-ws

ENV NODE_SECRET= \
    DOCKER_SOCKET=/var/run/docker.sock \
    DOCKER_API_VERSION=v1.45 \
    AGENT_PORT=9001 \
    AGENT_INTERNAL_PORT=9002 \
    AGENT_WS_PORT=9003 \
    AGENT_CERT_DIR=/data/certs \
    AGENT_STACKS_DIR=/data/stacks \
    AGENT_TLS_DAYS=365 \
    AGENT_TLS_CN=wharfmaster-agent

VOLUME ["/data/certs", "/data/stacks"]
EXPOSE 9001

CMD ["/app/entrypoint.sh"]
