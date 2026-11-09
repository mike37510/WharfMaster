<?php
declare(strict_types=1);

/**
 * Read-only application configuration.
 * Side effects (mkdir, JWT generation) live in bin/init.php / docker entrypoint.
 * Legacy portainer.sqlite rename: php bin/migrate-legacy.php
 */

$root = dirname(__DIR__);
$varDir = getenv('WHARFMASTER_VAR') ?: ($root . '/var');
if (!is_dir($varDir) && is_dir($root . '/data')) {
    $varDir = $root . '/data';
}

$envSocket = (string) (getenv('DOCKER_SOCKET') ?: ($_SERVER['DOCKER_SOCKET'] ?? ''));
$dockerSocket = '/var/run/docker.sock';
if ($envSocket !== '' && file_exists($envSocket)) {
    $dockerSocket = $envSocket;
} elseif (file_exists('/var/run/docker.sock')) {
    $dockerSocket = '/var/run/docker.sock';
}

$jwtSecretFile = $varDir . '/jwt.secret';
$jwtSecret = '';
if (is_file($jwtSecretFile) && is_readable($jwtSecretFile)) {
    $jwtSecret = trim((string) file_get_contents($jwtSecretFile));
}

return [
    'app_name' => 'WharfMaster',
    'version' => '2.2.1',
    'edition' => 'CE',
    'root' => $root,
    'var_dir' => $varDir,
    'agent_dir' => $root . '/agent',
    'docs_dir' => $root . '/docs',
    'agent_image' => getenv('WHARFMASTER_AGENT_IMAGE')
        ?: ('ghcr.io/mike37510/wharfmaster-agent:' . (getenv('WHARFMASTER_AGENT_TAG') ?: '2.2.1')),
    'docker_socket' => $dockerSocket,
    'docker_api_version' => getenv('DOCKER_API_VERSION') ?: 'v1.45',
    'sqlite_path' => $varDir . '/dockermanager.sqlite',
    'jwt_secret_file' => $jwtSecretFile,
    'jwt_secret' => $jwtSecret,
    'jwt_ttl' => 4 * 3600,
    'compose_dir' => $varDir . '/compose',
    'dockerfiles_dir' => $varDir . '/dockerfiles',
    'docker_bin' => getenv('DOCKER_BIN') ?: '/usr/local/bin/docker',
    'compose_bin' => getenv('COMPOSE_BIN') ?: '/usr/local/bin/docker-compose',
];
