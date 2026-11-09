# WharfMaster — console web Docker (Apache + PHP)
# DocumentRoot = /var/www/html/public (code & var/ hors webroot)
FROM php:8.3-apache-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      gnupg \
      unzip \
      libzip-dev \
      libsqlite3-dev \
      libldap2-dev \
  && docker-php-ext-install pdo_sqlite zip ldap \
  && a2enmod rewrite headers \
  && rm -rf /var/lib/apt/lists/*

# Trivy (image CVE scanner)
RUN set -eux; \
  TRIVY_VERSION=0.76.2; \
  ARCH=$(dpkg --print-architecture); \
  case "$ARCH" in amd64) TARCH=64bit ;; arm64) TARCH=ARM64 ;; *) TARCH=64bit ;; esac; \
  curl -fsSL "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-${TARCH}.tar.gz" \
    -o /tmp/trivy.tgz; \
  tar -xzf /tmp/trivy.tgz -C /usr/local/bin trivy; \
  rm -f /tmp/trivy.tgz; \
  chmod 0755 /usr/local/bin/trivy; \
  /usr/local/bin/trivy --version

# Docker CLI + Compose plugin
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

COPY docker/php-uploads.ini /usr/local/etc/php/conf.d/zz-wharfmaster-uploads.ini
COPY docker/apache-uploads.conf /etc/apache2/conf-available/wharfmaster-uploads.conf
COPY docker/apache-docker.conf /etc/apache2/sites-available/000-default.conf
RUN a2enconf wharfmaster-uploads \
  && printf 'ServerName wharfmaster\n' > /etc/apache2/conf-available/servername.conf \
  && a2enconf servername

WORKDIR /var/www/html

COPY . /var/www/html

RUN mkdir -p /var/www/html/var/compose /var/www/html/var/dockerfiles \
  && chown -R www-data:www-data /var/www/html/var \
  && chmod 700 /var/www/html/var \
  && chmod +x /var/www/html/docker/docker-entrypoint.sh /var/www/html/bin/init.php \
  && chmod +x /var/www/html/agent/install.sh /var/www/html/agent/deploy.sh /var/www/html/agent/entrypoint.sh 2>/dev/null || true

ENV APACHE_DOCUMENT_ROOT=/var/www/html/public \
    DOCKER_SOCKET=/var/run/docker.sock \
    DOCKER_BIN=/usr/bin/docker \
    COMPOSE_BIN=/usr/bin/docker \
    DOCKER_API_VERSION=v1.45 \
    TRIVY_BIN=/usr/local/bin/trivy \
    WHARFMASTER_VAR=/var/www/html/var

EXPOSE 80
VOLUME ["/var/www/html/var"]

ENTRYPOINT ["/var/www/html/docker/docker-entrypoint.sh"]
CMD ["apache2-foreground"]
