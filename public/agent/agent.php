<?php
declare(strict_types=1);

/**
 * WharfMaster remote agent — proxies Docker Engine API over HTTP with Bearer auth.
 *
 * Env:
 *   NODE_SECRET   required
 *   DOCKER_SOCKET default /var/run/docker.sock
 *   AGENT_PORT    default 9001 (informational)
 */

$secret = getenv('NODE_SECRET') ?: '';
$socket = getenv('DOCKER_SOCKET') ?: '/var/run/docker.sock';
$apiVersion = getenv('DOCKER_API_VERSION') ?: 'v1.45';

header('X-WharfMaster-Agent: 1');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$uri = $_SERVER['REQUEST_URI'] ?? '/';
$path = parse_url($uri, PHP_URL_PATH) ?: '/';
$query = parse_url($uri, PHP_URL_QUERY);

if ($path === '/health' || $path === '/health/') {
    $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if ($secret === '' || !hash_equals('Bearer ' . $secret, $auth)) {
        http_response_code(401);
        header('Content-Type: application/json');
        echo json_encode(['ok' => false, 'message' => 'Unauthorized']);
        exit;
    }
    $pingOk = false;
    if (file_exists($socket)) {
        $ch = curl_init('http://localhost/_ping');
        if ($ch) {
            curl_setopt_array($ch, [
                CURLOPT_UNIX_SOCKET_PATH => $socket,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT => 3,
            ]);
            $body = curl_exec($ch);
            $pingOk = $body !== false && trim((string) $body) === 'OK';
            curl_close($ch);
        }
    }
    $tlsExpiresAt = null;
    $tlsExpiresText = null;
    $certDir = getenv('AGENT_CERT_DIR') ?: '/data/certs';
    $epochFile = $certDir . '/expires.epoch';
    $textFile = $certDir . '/expires.txt';
    if (is_file($epochFile)) {
        $tlsExpiresAt = (int) trim((string) file_get_contents($epochFile));
        if ($tlsExpiresAt <= 0) {
            $tlsExpiresAt = null;
        }
    }
    if (is_file($textFile)) {
        $tlsExpiresText = trim((string) file_get_contents($textFile));
    }
    header('Content-Type: application/json');
    echo json_encode([
        'ok' => $pingOk,
        'docker' => $pingOk,
        'tls' => true,
        'tlsExpiresAt' => $tlsExpiresAt,
        'tlsExpires' => $tlsExpiresText,
    ], JSON_UNESCAPED_SLASHES);
    exit;
}

if (!str_starts_with($path, '/docker')) {
    http_response_code(404);
    header('Content-Type: application/json');
    echo json_encode(['message' => 'Not found']);
    exit;
}

$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
if ($secret === '' || !hash_equals('Bearer ' . $secret, $auth)) {
    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode(['message' => 'Unauthorized']);
    exit;
}

$dockerPath = substr($path, strlen('/docker')) ?: '/';
if ($dockerPath === '/_ping' || str_starts_with($dockerPath, '/v1.')) {
    $enginePath = $dockerPath;
} else {
    $enginePath = '/' . $apiVersion . $dockerPath;
}
if ($query) {
    $enginePath .= (str_contains($enginePath, '?') ? '&' : '?') . $query;
}

$body = file_get_contents('php://input');
if ($body === false) {
    $body = '';
}

$headers = [];
$contentType = $_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? '';
if ($contentType !== '') {
    $headers[] = 'Content-Type: ' . $contentType;
}

$ch = curl_init('http://localhost' . $enginePath);
if ($ch === false) {
    http_response_code(500);
    echo json_encode(['message' => 'curl init failed']);
    exit;
}

curl_setopt_array($ch, [
    CURLOPT_CUSTOMREQUEST => strtoupper($method),
    CURLOPT_UNIX_SOCKET_PATH => $socket,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HEADER => true,
    CURLOPT_TIMEOUT => 300,
    CURLOPT_HTTPHEADER => $headers,
]);

if ($body !== '' && !in_array(strtoupper($method), ['GET', 'HEAD'], true)) {
    curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
}

$raw = curl_exec($ch);
if ($raw === false) {
    $err = curl_error($ch);
    curl_close($ch);
    http_response_code(502);
    header('Content-Type: application/json');
    echo json_encode(['message' => 'Docker socket error: ' . $err]);
    exit;
}

$status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
$headerSize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
curl_close($ch);

$rawHeaders = substr($raw, 0, $headerSize);
$responseBody = substr($raw, $headerSize);
http_response_code($status > 0 ? $status : 502);

foreach (explode("\r\n", (string) $rawHeaders) as $line) {
    if ($line === '' || !str_contains($line, ':')) {
        continue;
    }
    [$name, $value] = explode(':', $line, 2);
    $name = trim($name);
    if ($name === '' || strcasecmp($name, 'Transfer-Encoding') === 0 || strcasecmp($name, 'Content-Length') === 0) {
        continue;
    }
    header($name . ': ' . trim($value), false);
}

echo $responseBody === false ? '' : $responseBody;
