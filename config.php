<?php
declare(strict_types=1);

$socketCandidates = array_filter([
    getenv('DOCKER_SOCKET') ?: null,
    '/var/run/docker.so',
    '/var/run/docker.sock',
]);

$dockerSocket = '/var/run/docker.so';
foreach ($socketCandidates as $candidate) {
    if (is_string($candidate) && file_exists($candidate)) {
        $dockerSocket = $candidate;
        break;
    }
}

$jwtSecretFile = __DIR__ . '/data/jwt.secret';
if (!is_file($jwtSecretFile)) {
    if (!is_dir(dirname($jwtSecretFile))) {
        mkdir(dirname($jwtSecretFile), 0755, true);
    }
    file_put_contents($jwtSecretFile, bin2hex(random_bytes(32)));
    chmod($jwtSecretFile, 0600);
}

return [
    'app_name' => 'WharfMaster',
    'version' => '1.4.3',
    'agent_image' => getenv('WHARFMASTER_AGENT_IMAGE')
        ?: ('ghcr.io/mike37510/wharfmaster-agent:' . (getenv('WHARFMASTER_AGENT_TAG') ?: '1.4.3')),
    'edition' => 'CE',
    'docker_socket' => $dockerSocket,
    'docker_api_version' => getenv('DOCKER_API_VERSION') ?: 'v1.45',
    'sqlite_path' => (static function (): string {
        $dir = __DIR__ . '/data';
        $primary = $dir . '/dockermanager.sqlite';
        $legacy = $dir . '/portainer.sqlite';
        if (!is_file($primary) && is_file($legacy)) {
            @rename($legacy, $primary);
        }
        return $primary;
    })(),
    'jwt_secret' => trim((string) file_get_contents($jwtSecretFile)),
    'jwt_ttl' => 4 * 3600,
    'compose_dir' => __DIR__ . '/data/compose',
    'dockerfiles_dir' => __DIR__ . '/data/dockerfiles',
    'docker_bin' => getenv('DOCKER_BIN') ?: '/usr/local/bin/docker',
    'compose_bin' => getenv('COMPOSE_BIN') ?: '/usr/local/bin/docker-compose',
];
