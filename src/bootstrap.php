<?php
declare(strict_types=1);

ini_set('display_errors', '0');
ini_set('log_errors', '1');
ini_set('expose_php', '0');
header_remove('X-Powered-By');
error_reporting(E_ALL);

spl_autoload_register(static function (string $class): void {
    $prefix = 'App\\';
    if (!str_starts_with($class, $prefix)) {
        return;
    }
    $relative = str_replace('\\', '/', substr($class, strlen($prefix)));
    $file = __DIR__ . '/' . $relative . '.php';
    if (is_file($file)) {
        require $file;
    }
});

$root = dirname(__DIR__);
\App\Support\RuntimeInit::ensure($root);

$config = require $root . '/config/app.php';

if (($config['jwt_secret'] ?? '') === '') {
    http_response_code(503);
    header('Content-Type: application/json');
    echo json_encode(['message' => 'WharfMaster non initialisé — exécutez bin/init.php']);
    exit;
}

foreach (['compose_dir', 'dockerfiles_dir'] as $key) {
    $dir = (string) ($config[$key] ?? '');
    if ($dir !== '' && !is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
}

$db = new App\Storage\Database($config['sqlite_path']);
$db->migrate();

return $config;
