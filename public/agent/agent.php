<?php
declare(strict_types=1);

/**
 * WharfMaster remote agent — Docker Engine proxy + Compose deploy API.
 *
 * Env:
 *   NODE_SECRET        required
 *   DOCKER_SOCKET      default /var/run/docker.sock
 *   AGENT_STACKS_DIR   default /data/stacks
 *   AGENT_PORT         default 9001 (informational)
 */

$secret = getenv('NODE_SECRET') ?: '';
$socket = getenv('DOCKER_SOCKET') ?: '/var/run/docker.sock';
$apiVersion = getenv('DOCKER_API_VERSION') ?: 'v1.45';
$stacksDir = getenv('AGENT_STACKS_DIR') ?: '/data/stacks';

header('X-WharfMaster-Agent: 1');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$uri = $_SERVER['REQUEST_URI'] ?? '/';
$path = parse_url($uri, PHP_URL_PATH) ?: '/';
$query = parse_url($uri, PHP_URL_QUERY);

function agent_json(mixed $data, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($data, JSON_UNESCAPED_SLASHES);
    exit;
}

function agent_require_auth(string $secret): void
{
    $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if ($secret === '' || !hash_equals('Bearer ' . $secret, $auth)) {
        agent_json(['ok' => false, 'message' => 'Unauthorized'], 401);
    }
}

function agent_safe_stack_name(string $name): string
{
    $name = trim($name);
    if ($name === '' || !preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/', $name)) {
        throw new RuntimeException('Nom de stack invalide', 400);
    }
    return $name;
}

function agent_compose_bin(): array
{
    // Prefer docker compose plugin
    $out = [];
    $code = 0;
    exec('docker compose version 2>/dev/null', $out, $code);
    if ($code === 0) {
        return ['docker', 'compose'];
    }
    $out = [];
    exec('docker-compose version 2>/dev/null', $out, $code);
    if ($code === 0) {
        return ['docker-compose'];
    }
    throw new RuntimeException('docker compose non disponible dans l’agent', 503);
}

function agent_compose_available(): bool
{
    try {
        agent_compose_bin();
        return true;
    } catch (Throwable) {
        return false;
    }
}

/**
 * @param list<array{name?:string,value?:string,Name?:string,Value?:string}> $env
 * @param list<string> $args
 */
function agent_run_compose(
    string $socket,
    string $projectPath,
    string $projectName,
    string $composeFile,
    array $args,
    array $env,
    int $maxSeconds = 900,
): string {
    $bin = agent_compose_bin();
    $cmd = [
        ...$bin,
        '--progress', 'plain',
        '-f', $composeFile,
        '-p', $projectName,
        ...$args,
    ];

    $descriptors = [
        0 => ['pipe', 'r'],
        1 => ['pipe', 'w'],
        2 => ['pipe', 'w'],
    ];
    $procEnv = [];
    foreach (array_merge($_SERVER, $_ENV) as $key => $value) {
        if (is_string($key) && (is_string($value) || is_int($value) || is_float($value) || is_bool($value))) {
            $procEnv[$key] = (string) $value;
        }
    }
    $procEnv['DOCKER_HOST'] = 'unix://' . $socket;
    $procEnv['COMPOSE_PROGRESS'] = 'plain';
    $procEnv['DOCKER_CLI_HINTS'] = 'false';
    $procEnv['TERM'] = 'dumb';
    foreach ($env as $pair) {
        if (!is_array($pair)) {
            continue;
        }
        $name = (string) ($pair['name'] ?? $pair['Name'] ?? '');
        $value = (string) ($pair['value'] ?? $pair['Value'] ?? '');
        if ($name !== '') {
            $procEnv[$name] = $value;
        }
    }

    $process = proc_open($cmd, $descriptors, $pipes, $projectPath, $procEnv);
    if (!is_resource($process)) {
        throw new RuntimeException('Échec du démarrage de docker compose');
    }
    fclose($pipes[0]);
    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);
    $stdout = '';
    $stderr = '';
    $start = time();
    $status = ['running' => true, 'exitcode' => -1];
    while (true) {
        $status = proc_get_status($process);
        $stdout .= stream_get_contents($pipes[1]) ?: '';
        $stderr .= stream_get_contents($pipes[2]) ?: '';
        if (!$status['running']) {
            break;
        }
        if ((time() - $start) > $maxSeconds) {
            proc_terminate($process, 9);
            fclose($pipes[1]);
            fclose($pipes[2]);
            proc_close($process);
            throw new RuntimeException('Délai dépassé pendant docker compose (pull trop long ?)');
        }
        usleep(100_000);
    }
    $stdout .= stream_get_contents($pipes[1]) ?: '';
    $stderr .= stream_get_contents($pipes[2]) ?: '';
    fclose($pipes[1]);
    fclose($pipes[2]);
    $code = proc_close($process);
    if ($code === -1 && isset($status['exitcode']) && $status['exitcode'] >= 0) {
        $code = (int) $status['exitcode'];
    }
    if ($code !== 0) {
        $msg = trim($stderr !== '' ? $stderr : $stdout);
        if ($msg === '') {
            $msg = 'docker compose a échoué avec le code ' . $code;
        }
        throw new RuntimeException($msg);
    }
    return $stdout !== '' ? $stdout : $stderr;
}

/**
 * @param list<array{name?:string,value?:string,Name?:string,Value?:string}> $env
 */
function agent_write_env_file(string $projectPath, array $env): void
{
    $lines = [];
    foreach ($env as $pair) {
        if (!is_array($pair)) {
            continue;
        }
        $name = (string) ($pair['name'] ?? $pair['Name'] ?? '');
        if ($name === '' || !preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $name)) {
            continue;
        }
        $value = (string) ($pair['value'] ?? $pair['Value'] ?? '');
        if ($value === '' || preg_match('/[\s#"\'\\\\$]/', $value)) {
            $value = '"' . addcslashes($value, "\\\"$\n\r") . '"';
        }
        $lines[] = $name . '=' . $value;
    }
    $path = rtrim($projectPath, '/') . '/.env';
    if ($lines === []) {
        if (is_file($path)) {
            unlink($path);
        }
        return;
    }
    if (file_put_contents($path, implode("\n", $lines) . "\n") === false) {
        throw new RuntimeException("Impossible d'écrire le fichier .env");
    }
}

function agent_rm_tree(string $dir): void
{
    if (!is_dir($dir)) {
        return;
    }
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST,
    );
    foreach ($it as $file) {
        $p = $file->getPathname();
        if ($file->isDir()) {
            rmdir($p);
        } else {
            unlink($p);
        }
    }
    rmdir($dir);
}

// --- Health ---
if ($path === '/health' || $path === '/health/') {
    agent_require_auth($secret);
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
    agent_json([
        'ok' => $pingOk,
        'docker' => $pingOk,
        'compose' => agent_compose_available(),
        'tls' => true,
        'tlsExpiresAt' => $tlsExpiresAt,
        'tlsExpires' => $tlsExpiresText,
    ]);
}

// --- Image vulnerability scan (Trivy) ---
if ($path === '/scan/image' && $method === 'POST') {
    agent_require_auth($secret);
    $body = json_decode((string) file_get_contents('php://input'), true);
    if (!is_array($body)) {
        agent_json(['ok' => false, 'message' => 'JSON invalide'], 400);
    }
    $image = trim((string) ($body['image'] ?? $body['Image'] ?? ''));
    if ($image === '' || !preg_match('#^[a-zA-Z0-9._/:@-]+$#', $image)) {
        agent_json(['ok' => false, 'message' => 'Image invalide'], 400);
    }
    $trivy = trim((string) shell_exec('command -v trivy 2>/dev/null'));
    if ($trivy === '' || !is_executable($trivy)) {
        agent_json(['ok' => false, 'message' => 'Trivy non installé sur l\'agent'], 503);
    }
    $cmd = escapeshellarg($trivy)
        . ' image --quiet --format json --severity-exit-code 0 --scanners vuln '
        . escapeshellarg($image)
        . ' 2>/tmp/trivy-agent.err';
    $raw = shell_exec($cmd);
    if (!is_string($raw) || $raw === '') {
        $err = is_file('/tmp/trivy-agent.err') ? trim((string) file_get_contents('/tmp/trivy-agent.err')) : '';
        agent_json(['ok' => false, 'message' => $err !== '' ? $err : 'Scan Trivy échoué'], 502);
    }
    agent_json(['ok' => true, 'raw' => $raw, 'status' => 'ok']);
}

// --- Compose API ---
if (str_starts_with($path, '/compose')) {
    agent_require_auth($secret);
    if (!is_dir($stacksDir) && !mkdir($stacksDir, 0755, true) && !is_dir($stacksDir)) {
        agent_json(['ok' => false, 'message' => 'Impossible de créer AGENT_STACKS_DIR'], 500);
    }

    try {
        if ($path === '/compose/up' && $method === 'POST') {
            $body = json_decode((string) file_get_contents('php://input'), true);
            if (!is_array($body)) {
                agent_json(['ok' => false, 'message' => 'JSON invalide'], 400);
            }
            $name = agent_safe_stack_name((string) ($body['name'] ?? $body['Name'] ?? ''));
            $composeFileContent = (string) ($body['composeFile'] ?? $body['ComposeFile'] ?? $body['stackFileContent'] ?? '');
            $entryPoint = (string) ($body['entryPoint'] ?? $body['EntryPoint'] ?? 'docker-compose.yml');
            $entryPoint = preg_replace('/[^a-zA-Z0-9._-]+/', '', $entryPoint) ?: 'docker-compose.yml';
            if (!str_ends_with($entryPoint, '.yml') && !str_ends_with($entryPoint, '.yaml')) {
                $entryPoint = 'docker-compose.yml';
            }
            $env = $body['env'] ?? $body['Env'] ?? [];
            if (!is_array($env)) {
                $env = [];
            }
            $pull = !empty($body['pull']) || !empty($body['Pull']) || !empty($body['pullImages']) || !empty($body['PullImages']);
            if ($composeFileContent === '') {
                agent_json(['ok' => false, 'message' => 'composeFile requis'], 400);
            }
            $projectPath = rtrim($stacksDir, '/') . '/' . $name;
            if (!is_dir($projectPath) && !mkdir($projectPath, 0755, true) && !is_dir($projectPath)) {
                throw new RuntimeException('Impossible de créer le répertoire projet');
            }
            $filePath = $projectPath . '/' . $entryPoint;
            if (file_put_contents($filePath, $composeFileContent) === false) {
                throw new RuntimeException("Impossible d'écrire le fichier Compose");
            }
            agent_write_env_file($projectPath, $env);
            $upArgs = ['up', '-d', '--remove-orphans'];
            if ($pull) {
                $upArgs[] = '--pull';
                $upArgs[] = 'always';
            }
            $out = agent_run_compose($socket, $projectPath, $name, $filePath, $upArgs, $env);
            agent_json(['ok' => true, 'name' => $name, 'output' => $out]);
        }

        if ($path === '/compose/down' && $method === 'POST') {
            $body = json_decode((string) file_get_contents('php://input'), true);
            if (!is_array($body)) {
                agent_json(['ok' => false, 'message' => 'JSON invalide'], 400);
            }
            $name = agent_safe_stack_name((string) ($body['name'] ?? $body['Name'] ?? ''));
            $entryPoint = (string) ($body['entryPoint'] ?? $body['EntryPoint'] ?? 'docker-compose.yml');
            $entryPoint = preg_replace('/[^a-zA-Z0-9._-]+/', '', $entryPoint) ?: 'docker-compose.yml';
            $env = $body['env'] ?? $body['Env'] ?? [];
            if (!is_array($env)) {
                $env = [];
            }
            $projectPath = rtrim($stacksDir, '/') . '/' . $name;
            $filePath = $projectPath . '/' . $entryPoint;
            $out = '';
            if (is_file($filePath)) {
                $out = agent_run_compose(
                    $socket,
                    $projectPath,
                    $name,
                    $filePath,
                    ['down', '--remove-orphans'],
                    $env,
                    300,
                );
            }
            agent_rm_tree($projectPath);
            agent_json(['ok' => true, 'name' => $name, 'output' => $out]);
        }

        if (($path === '/compose/start' || $path === '/compose/stop' || $path === '/compose/restart') && $method === 'POST') {
            $body = json_decode((string) file_get_contents('php://input'), true);
            if (!is_array($body)) {
                agent_json(['ok' => false, 'message' => 'JSON invalide'], 400);
            }
            $name = agent_safe_stack_name((string) ($body['name'] ?? $body['Name'] ?? ''));
            $entryPoint = (string) ($body['entryPoint'] ?? $body['EntryPoint'] ?? 'docker-compose.yml');
            $entryPoint = preg_replace('/[^a-zA-Z0-9._-]+/', '', $entryPoint) ?: 'docker-compose.yml';
            $env = $body['env'] ?? $body['Env'] ?? [];
            if (!is_array($env)) {
                $env = [];
            }
            $action = substr($path, strlen('/compose/'));
            $projectPath = rtrim($stacksDir, '/') . '/' . $name;
            $filePath = $projectPath . '/' . $entryPoint;
            if (!is_file($filePath)) {
                agent_json(['ok' => false, 'message' => 'Projet Compose introuvable sur l’agent'], 404);
            }
            $args = match ($action) {
                'start' => ['start'],
                'stop' => ['stop'],
                default => ['restart'],
            };
            try {
                $out = agent_run_compose($socket, $projectPath, $name, $filePath, $args, $env, 300);
            } catch (Throwable $e) {
                if ($action === 'start' || $action === 'restart') {
                    $out = agent_run_compose(
                        $socket,
                        $projectPath,
                        $name,
                        $filePath,
                        ['up', '-d', '--remove-orphans'],
                        $env,
                        900,
                    );
                } else {
                    throw $e;
                }
            }
            agent_json(['ok' => true, 'name' => $name, 'action' => $action, 'output' => $out]);
        }

        if ($path === '/compose/config' && $method === 'POST') {
            $body = json_decode((string) file_get_contents('php://input'), true);
            if (!is_array($body)) {
                agent_json(['ok' => false, 'message' => 'JSON invalide'], 400);
            }
            $name = agent_safe_stack_name((string) ($body['name'] ?? $body['Name'] ?? 'validate'));
            $composeFileContent = (string) ($body['composeFile'] ?? $body['ComposeFile'] ?? '');
            $entryPoint = (string) ($body['entryPoint'] ?? 'docker-compose.yml');
            $entryPoint = preg_replace('/[^a-zA-Z0-9._-]+/', '', $entryPoint) ?: 'docker-compose.yml';
            $env = $body['env'] ?? $body['Env'] ?? [];
            if (!is_array($env)) {
                $env = [];
            }
            $tmp = sys_get_temp_dir() . '/wm-ccheck-' . bin2hex(random_bytes(6));
            if (!mkdir($tmp, 0700) && !is_dir($tmp)) {
                throw new RuntimeException('tmp mkdir failed');
            }
            try {
                $filePath = $tmp . '/' . $entryPoint;
                file_put_contents($filePath, $composeFileContent);
                agent_write_env_file($tmp, $env);
                $out = agent_run_compose(
                    $socket,
                    $tmp,
                    $name,
                    $filePath,
                    ['config', '--format', 'json'],
                    $env,
                    60,
                );
                agent_json(['ok' => true, 'config' => json_decode($out, true) ?? $out]);
            } finally {
                agent_rm_tree($tmp);
            }
        }

        if (($path === '/compose/file' || $path === '/compose/file/') && $method === 'GET') {
            parse_str((string) $query, $qs);
            $name = agent_safe_stack_name((string) ($qs['name'] ?? ''));
            $entryPoint = (string) ($qs['entryPoint'] ?? 'docker-compose.yml');
            $entryPoint = preg_replace('/[^a-zA-Z0-9._-]+/', '', $entryPoint) ?: 'docker-compose.yml';
            $filePath = rtrim($stacksDir, '/') . '/' . $name . '/' . $entryPoint;
            if (!is_file($filePath)) {
                agent_json(['ok' => false, 'message' => 'Fichier introuvable'], 404);
            }
            agent_json([
                'ok' => true,
                'name' => $name,
                'entryPoint' => $entryPoint,
                'composeFile' => (string) file_get_contents($filePath),
            ]);
        }

        agent_json(['ok' => false, 'message' => 'Not found'], 404);
    } catch (Throwable $e) {
        $code = (int) $e->getCode();
        if ($code < 400 || $code > 599) {
            $code = 500;
        }
        agent_json(['ok' => false, 'message' => $e->getMessage()], $code);
    }
}

if (!str_starts_with($path, '/docker')) {
    agent_json(['message' => 'Not found'], 404);
}

$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
if ($secret === '' || !hash_equals('Bearer ' . $secret, $auth)) {
    agent_json(['message' => 'Unauthorized'], 401);
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
    agent_json(['message' => 'curl init failed'], 500);
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
    agent_json(['message' => 'Docker socket error: ' . $err], 502);
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
