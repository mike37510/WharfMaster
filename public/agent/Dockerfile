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

WORKDIR /app
COPY agent.php /app/agent.php
COPY router.php /app/router.php
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV NODE_SECRET= \
    DOCKER_SOCKET=/var/run/docker.sock \
    DOCKER_API_VERSION=v1.45 \
    AGENT_PORT=9001 \
    AGENT_INTERNAL_PORT=9002 \
    AGENT_CERT_DIR=/data/certs \
    AGENT_STACKS_DIR=/data/stacks \
    AGENT_TLS_DAYS=365 \
    AGENT_TLS_CN=wharfmaster-agent

VOLUME ["/data/certs", "/data/stacks"]
EXPOSE 9001

CMD ["/app/entrypoint.sh"]
