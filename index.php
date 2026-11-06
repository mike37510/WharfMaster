<?php
declare(strict_types=1);

$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

// Marketing landing
if ($uri === '/' || $uri === '' || $uri === '/site' || $uri === '/site/') {
    $path = __DIR__ . '/public/site/index.html';
    if (is_file($path)) {
        header('Content-Type: text/html; charset=utf-8');
        readfile($path);
        exit;
    }
}

// Console SPA
$path = __DIR__ . '/public/index.html';
if (is_file($path)) {
    header('Content-Type: text/html; charset=utf-8');
    readfile($path);
    exit;
}

http_response_code(500);
header('Content-Type: text/plain; charset=utf-8');
echo "UI not installed\n";
