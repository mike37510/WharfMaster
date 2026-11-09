#!/usr/bin/env php
<?php
declare(strict_types=1);

/**
 * Cron entrypoint: execute due stack schedules via internal API.
 * Reads API key from var/scheduler.api_key (written by App bootstrap).
 */

$root = dirname(__DIR__);
$varDir = getenv('WHARFMASTER_VAR') ?: ($root . '/var');
if (!is_dir($varDir) && is_dir($root . '/data')) {
    $varDir = $root . '/data';
}
$keyFile = $varDir . '/scheduler.api_key';
$base = getenv('WHARFMASTER_INTERNAL_URL') ?: 'http://127.0.0.1';

if (!is_file($keyFile)) {
    fwrite(STDERR, "scheduler.api_key missing — start WharfMaster once to provision it\n");
    exit(1);
}
$key = trim((string) file_get_contents($keyFile));
if ($key === '' || !str_starts_with($key, 'ptr_')) {
    fwrite(STDERR, "invalid scheduler API key\n");
    exit(1);
}

$url = rtrim($base, '/') . '/api/schedules/run-due';
$ch = curl_init($url);
if (!$ch) {
    fwrite(STDERR, "curl init failed\n");
    exit(1);
}
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => '{}',
    CURLOPT_HTTPHEADER => [
        'Content-Type: application/json',
        'Accept: application/json',
        'X-API-Key: ' . $key,
    ],
    CURLOPT_TIMEOUT => 120,
]);
$body = curl_exec($ch);
$code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
$err = curl_error($ch);
curl_close($ch);

if ($body === false || $code >= 400) {
    fwrite(STDERR, 'run-due failed HTTP ' . $code . ' ' . ($err ?: (string) $body) . "\n");
    exit(1);
}
fwrite(STDOUT, (string) $body . "\n");
exit(0);
