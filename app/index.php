<?php
declare(strict_types=1);

/**
 * Point d’entrée physique pour /app — fonctionne même si
 * RewriteRule du .htaccess racine n’est pas pris en compte.
 */
$path = dirname(__DIR__) . '/public/index.html';
if (!is_file($path)) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    echo "WharfMaster UI manquante (public/index.html).\n";
    exit;
}
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
readfile($path);
