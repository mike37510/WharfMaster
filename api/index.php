<?php
declare(strict_types=1);

$config = require dirname(__DIR__) . '/src/bootstrap.php';

use App\App;
use App\Http\Request;

$request = Request::fromGlobals();
$app = new App($config);
$origin = $request->header('Origin');
$response = $app->handle($request)
    ->withSecurityHeaders()
    ->withCors($origin);
$response->send();
