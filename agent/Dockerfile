FROM php:8.3-cli-alpine

RUN apk add --no-cache curl openssl socat \
 && docker-php-ext-enable opcache 2>/dev/null || true

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
    AGENT_TLS_DAYS=365 \
    AGENT_TLS_CN=wharfmaster-agent

VOLUME ["/data/certs"]
EXPOSE 9001

CMD ["/app/entrypoint.sh"]
