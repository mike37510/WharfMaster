<?php
declare(strict_types=1);

/**
 * Unique front controller (DocumentRoot = public/).
 * Routes: /api, /app, /agent/*, /docs/*, /z/*, static /assets/*
 */

use App\App;
use App\Http\Request;

$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$path = rawurldecode($uri);
$path = $path === '' ? '/' : $path;

// --- Short unlisted links ---
if (preg_match('#^/z/([a-f0-9]+)(?:\.png)?/?$#', $path, $m)) {
    $file = __DIR__ . '/_x/' . $m[1] . '.png';
    if (is_file($file)) {
        header('Content-Type: image/png');
        header('Cache-Control: public, max-age=86400');
        readfile($file);
        exit;
    }
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Not found\n";
    exit;
}

// --- Agent sources (single copy under ../agent) ---
if (preg_match('#^/agent/([A-Za-z0-9._-]+)$#', $path, $m)) {
    $allowed = [
        'install.sh' => 'text/x-shellscript; charset=utf-8',
        'deploy.sh' => 'text/x-shellscript; charset=utf-8',
        'entrypoint.sh' => 'text/x-shellscript; charset=utf-8',
        'agent.php' => 'text/plain; charset=utf-8',
        'router.php' => 'text/plain; charset=utf-8',
        'Dockerfile' => 'text/plain; charset=utf-8',
        'docker-compose.yml' => 'text/yaml; charset=utf-8',
        'README.md' => 'text/markdown; charset=utf-8',
        '.env.example' => 'text/plain; charset=utf-8',
    ];
    $name = $m[1];
    if (!isset($allowed[$name])) {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo "Unknown agent file\n";
        exit;
    }
    $file = dirname(__DIR__) . '/agent/' . $name;
    if (!is_file($file)) {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo "Missing agent file\n";
        exit;
    }
    header('Content-Type: ' . $allowed[$name]);
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    readfile($file);
    exit;
}

// --- Documentation (single copy under ../docs) ---
if ($path === '/docs/DOCUMENTATION.md') {
    $file = dirname(__DIR__) . '/docs/DOCUMENTATION.md';
    if (!is_file($file)) {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo "Documentation missing\n";
        exit;
    }
    header('Content-Type: text/markdown; charset=utf-8');
    header('Cache-Control: no-store');
    readfile($file);
    exit;
}

// --- Site vitrine (sources in ../site, hors DocumentRoot) ---
if ($path === '/' || $path === '/index.html') {
    $landing = dirname(__DIR__) . '/site/index.html';
    if (!is_file($landing)) {
        header('Location: /app', true, 302);
        exit;
    }
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    readfile($landing);
    exit;
}
if (preg_match('#^/site/(site\.(css|js)|shots/[A-Za-z0-9._-]+\.(png|jpe?g|webp|gif))$#', $path, $m)) {
    $file = dirname(__DIR__) . '/site/' . $m[1];
    if (!is_file($file)) {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo "Not found\n";
        exit;
    }
    $types = [
        'css' => 'text/css; charset=utf-8',
        'js' => 'text/javascript; charset=utf-8',
        'png' => 'image/png',
        'jpg' => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'webp' => 'image/webp',
        'gif' => 'image/gif',
    ];
    $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
    header('Content-Type: ' . ($types[$ext] ?? 'application/octet-stream'));
    header('Cache-Control: public, max-age=86400');
    readfile($file);
    exit;
}

// --- Console SPA ---
if ($path === '/app' || str_starts_with($path, '/app/')) {
    $spa = __DIR__ . '/app.html';
    if (!is_file($spa)) {
        http_response_code(500);
        header('Content-Type: text/plain; charset=utf-8');
        echo "WharfMaster UI manquante (public/app.html).\n";
        exit;
    }
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    readfile($spa);
    exit;
}

// --- API ---
if ($path === '/api' || str_starts_with($path, '/api/')) {
    $config = require dirname(__DIR__) . '/src/bootstrap.php';
    $request = Request::fromGlobals();
    $app = new App($config);
    $origin = $request->header('Origin');
    $response = $app->handle($request)
        ->withSecurityHeaders()
        ->withCors($origin);
    $response->send();
    exit;
}

http_response_code(404);
header('Content-Type: text/plain; charset=utf-8');
echo "Not found\n";
