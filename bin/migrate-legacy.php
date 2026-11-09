#!/usr/bin/env php
<?php
declare(strict_types=1);

/**
 * One-shot explicit legacy migration (idempotent).
 *
 * - Renames portainer.sqlite → dockermanager.sqlite when needed
 * - Warns if only /var/run/docker.so exists (no auto-fallback anymore)
 *
 * Run once before/after upgrading:
 *   php bin/migrate-legacy.php
 */

$root = dirname(__DIR__);
$varDir = getenv('WHARFMASTER_VAR') ?: ($root . '/var');
$dirs = array_values(array_unique(array_filter([
    $varDir,
    $root . '/data',
])));

$renamed = 0;
foreach ($dirs as $dir) {
    if (!is_dir($dir)) {
        continue;
    }
    $legacy = $dir . '/portainer.sqlite';
    $primary = $dir . '/dockermanager.sqlite';
    if (is_file($legacy) && !is_file($primary)) {
        if (!@rename($legacy, $primary)) {
            fwrite(STDERR, "FAILED rename {$legacy} → {$primary}\n");
            exit(1);
        }
        fwrite(STDOUT, "Renamed {$legacy} → {$primary}\n");
        $renamed++;
    } elseif (is_file($legacy) && is_file($primary)) {
        fwrite(STDOUT, "Keep {$primary} (left {$legacy} untouched — remove manually if obsolete)\n");
    }
}

if ($renamed === 0) {
    fwrite(STDOUT, "No portainer.sqlite rename needed.\n");
}

$envSock = getenv('DOCKER_SOCKET') ?: '';
$sock = $envSock !== '' ? $envSock : '/var/run/docker.sock';
$soOnly = !file_exists($sock)
    && ($envSock === '' || !file_exists($envSock))
    && file_exists('/var/run/docker.so');

if ($soOnly) {
    fwrite(STDERR, "WARN: only /var/run/docker.so found. WharfMaster no longer falls back to it.\n");
    fwrite(STDERR, "      Set DOCKER_SOCKET to a real docker.sock path, or fix the host mount.\n");
    exit(2);
}

fwrite(STDOUT, "Legacy migration OK.\n");
exit(0);
