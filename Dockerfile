# WharfMaster — console web Docker (Apache + PHP)
FROM php:8.3-apache-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      gnupg \
      unzip \
      libzip-dev \
      libsqlite3-dev \
  && docker-php-ext-install pdo_sqlite zip \
  && a2enmod rewrite headers \
  && rm -rf /var/lib/apt/lists/*

# Docker CLI + Compose plugin (dépôt officiel Docker)
RUN set -eux; \
  install -m 0755 -d /etc/apt/keyrings; \
  curl -fsSL https://download.docker.com/linux/debian/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg; \
  chmod a+r /etc/apt/keyrings/docker.gpg; \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" \
    > /etc/apt/sources.list.d/docker.list; \
  apt-get update; \
  apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin; \
  rm -rf /var/lib/apt/lists/*; \
  docker --version; \
  docker compose version; \
  ln -sf /usr/libexec/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose 2>/dev/null \
    || ln -sf /usr/lib/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose 2>/dev/null \
    || true

# Uploads volumes (jusqu’à ~300 Mo)
COPY deploy/php-uploads.ini /usr/local/etc/php/conf.d/zz-wharfmaster-uploads.ini
COPY deploy/apache-uploads.conf /etc/apache2/conf-available/wharfmaster-uploads.conf
RUN a2enconf wharfmaster-uploads \
  && sed -ri 's/AllowOverride None/AllowOverride All/g' /etc/apache2/apache2.conf \
  && printf 'ServerName wharfmaster\n' > /etc/apache2/conf-available/servername.conf \
  && a2enconf servername

WORKDIR /var/www/html

COPY . /var/www/html

RUN mkdir -p /var/www/html/data/compose /var/www/html/data/dockerfiles \
  && chown -R www-data:www-data /var/www/html \
  && chmod 700 /var/www/html/data \
  && chmod +x /var/www/html/deploy/docker-entrypoint.sh

ENV DOCKER_SOCKET=/var/run/docker.sock \
    DOCKER_BIN=/usr/bin/docker \
    COMPOSE_BIN=/usr/bin/docker \
    DOCKER_API_VERSION=v1.45

EXPOSE 80
VOLUME ["/var/www/html/data"]

ENTRYPOINT ["/var/www/html/deploy/docker-entrypoint.sh"]
CMD ["apache2-foreground"]
