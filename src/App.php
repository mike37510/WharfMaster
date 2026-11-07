<?php
declare(strict_types=1);

namespace App;

use App\Access\DockerScope;
use App\Access\Ownership;
use App\Auth\Jwt;
use App\Docker\Client as DockerClient;
use App\Docker\ImageBuilder;
use App\Docker\VolumeBrowser;
use App\Http\Request;
use App\Http\Response;
use App\Registry\Client as RegistryClient;
use App\Security\ComposePolicy;
use App\Security\PasswordPolicy;
use App\Security\RateLimiter;
use App\Stack\ComposeDeployer;
use App\Storage\Database;
use App\Storage\Repositories;

final class App
{
    private Repositories $repo;
    private Jwt $jwt;
    private DockerClient $docker;
    private ComposeDeployer $compose;
    private ImageBuilder $imageBuilder;
    private VolumeBrowser $volumeBrowser;
    private DockerScope $dockerScope;
    private RateLimiter $rateLimiter;
    /** @var array<string, mixed> */
    private array $config;

    /** @param array<string, mixed> $config */
    public function __construct(array $config)
    {
        $this->config = $config;
        $db = new Database($config['sqlite_path']);
        $db->migrate();
        $this->repo = new Repositories($db->pdo());
        $this->jwt = new Jwt($config['jwt_secret'], (int) $config['jwt_ttl']);
        $this->docker = new DockerClient($config['docker_socket'], $config['docker_api_version']);
        $this->compose = new ComposeDeployer(
            $config['compose_dir'],
            $config['docker_socket'],
            $config['docker_bin'],
            $config['compose_bin'],
        );
        $this->imageBuilder = new ImageBuilder(
            $this->docker,
            (string) $config['dockerfiles_dir'],
        );
        $this->volumeBrowser = new VolumeBrowser($this->docker);
        $this->dockerScope = new DockerScope($this->docker, $this->repo);
        $rateDir = dirname((string) $config['sqlite_path']) . '/rate_limit';
        $this->rateLimiter = new RateLimiter($rateDir, 8, 900);
        $this->repo->ensureLocalEndpoint($config['docker_socket']);
        $this->repo->ensureDefaultHubRegistry();
    }

    public function handle(Request $request): Response
    {
        if ($request->method === 'OPTIONS') {
            return Response::empty(204);
        }

        $path = rtrim($request->path, '/') ?: '/';
        if ($path === '/api') {
            $path = '/api/status';
        }

        try {
            return $this->route($request, $path);
        } catch (\Throwable $e) {
            $status = $e->getCode() >= 400 && $e->getCode() < 600 ? (int) $e->getCode() : 500;
            $message = $status >= 500 ? 'Erreur interne' : $e->getMessage();
            if ($status >= 500) {
                error_log('[WharfMaster] ' . $e->getMessage() . "\n" . $e->getTraceAsString());
            }
            return Response::error($message, $status);
        }
    }

    private function route(Request $request, string $path): Response
    {
        $method = $request->method;

        if (($path === '/api/status' || $path === '/api/system/status') && $method === 'GET') {
            return Response::json([
                'Version' => $this->config['version'],
                'InstanceID' => $this->repo->getSetting('instance_id', $this->ensureInstanceId()),
            ]);
        }

        if ($path === '/api/system/version' && $method === 'GET') {
            return Response::json([
                'Version' => $this->config['version'],
                'Platform' => 'WharfMaster',
                'ServerVersion' => $this->config['version'],
                'DatabaseEdition' => $this->config['edition'],
            ]);
        }

        if ($path === '/api/users/admin/check' && $method === 'GET') {
            return Response::json(['adminInit' => $this->repo->userCount() === 0]);
        }

        if ($path === '/api/users/admin/init' && $method === 'POST') {
            return $this->adminInit($request);
        }

        if ($path === '/api/auth' && $method === 'POST') {
            return $this->authenticate($request);
        }

        $user = $this->authenticateRequest($request);
        if ($user instanceof Response) {
            return $user;
        }

        if ($path === '/api/audit' && $method === 'GET') {
            return $this->listAudit($request, $user);
        }

        if ($path === '/api/users/me' && $method === 'GET') {
            return Response::json($this->publicUser($user));
        }

        if ($path === '/api/system/host' && $method === 'GET') {
            return Response::json($this->hostResources());
        }

        if ($path === '/api/settings' && $method === 'GET') {
            return Response::json($this->formatSettings());
        }

        if ($path === '/api/settings' && $method === 'PUT') {
            return $this->updateSettings($request, $user);
        }

        if ($path === '/api/users' && $method === 'GET') {
            return $this->listUsers($user);
        }

        if ($path === '/api/users' && $method === 'POST') {
            return $this->createUser($request, $user);
        }

        if (preg_match('#^/api/users/(\d+)/passwd$#', $path, $m) && $method === 'PUT') {
            return $this->changeUserPassword((int) $m[1], $request, $user);
        }

        if (preg_match('#^/api/users/(\d+)$#', $path, $m) && $method === 'DELETE') {
            return $this->deleteUser((int) $m[1], $request, $user);
        }

        if (preg_match('#^/api/users/(\d+)/tokens$#', $path, $m) && $method === 'POST') {
            return $this->createToken((int) $m[1], $request, $user);
        }

        if ($path === '/api/endpoints' && $method === 'GET') {
            return Response::json(array_map([$this, 'formatEndpoint'], $this->repo->listEndpoints()));
        }

        if ($path === '/api/endpoints' && $method === 'POST') {
            return Response::error('Seul l\'environnement Docker local est pris en charge', 400);
        }

        if (preg_match('#^/api/endpoints/(\d+)$#', $path, $m) && $method === 'GET') {
            $ep = $this->repo->getEndpoint((int) $m[1]);
            if (!$ep) {
                return Response::error('Environnement introuvable', 404);
            }
            return Response::json($this->formatEndpoint($ep));
        }

        if (preg_match('#^/api/endpoints/(\d+)/docker(/.*)?$#', $path, $m)) {
            return $this->proxyDocker((int) $m[1], $m[2] ?? '/', $request, $user);
        }

        if (preg_match('#^/api/endpoints/(\d+)/containers$#', $path, $m) && $method === 'GET') {
            return $this->proxyDocker((int) $m[1], '/containers/json', $request, $user);
        }

        // Clean logs (demuxed) — handy for UI
        if (preg_match('#^/api/endpoints/(\d+)/containers/([^/]+)/logs$#', $path, $m) && $method === 'GET') {
            return $this->containerLogs((int) $m[1], $m[2], $request, $user);
        }

        // One-shot exec for console UI
        if (preg_match('#^/api/endpoints/(\d+)/containers/([^/]+)/exec$#', $path, $m) && $method === 'POST') {
            return $this->containerExec((int) $m[1], $m[2], $request, $user);
        }

        if ($path === '/api/images/search' && $method === 'GET') {
            return $this->searchImages($request);
        }
        if ($path === '/api/images/tags' && $method === 'GET') {
            return $this->searchImageTags($request);
        }
        if ($path === '/api/images/build' && $method === 'POST') {
            return $this->buildImage($request, $user);
        }
        if ($path === '/api/dockerfiles' && $method === 'GET') {
            return Response::json($this->imageBuilder->listDockerfiles());
        }
        if ($path === '/api/dockerfiles' && $method === 'POST') {
            return $this->saveDockerfile($request);
        }
        if (preg_match('#^/api/dockerfiles/([^/]+)$#', $path, $m) && $method === 'GET') {
            try {
                return Response::json([
                    'Name' => rawurldecode($m[1]),
                    'Content' => $this->imageBuilder->readDockerfile(rawurldecode($m[1])),
                ]);
            } catch (\Throwable $e) {
                $code = (int) $e->getCode();
                return Response::error($e->getMessage(), $code >= 400 ? $code : 404);
            }
        }
        if (preg_match('#^/api/dockerfiles/([^/]+)$#', $path, $m) && $method === 'DELETE') {
            try {
                $this->imageBuilder->deleteDockerfile(rawurldecode($m[1]));
                return Response::empty(204);
            } catch (\Throwable $e) {
                return Response::error($e->getMessage(), 400);
            }
        }

        if (preg_match('#^/api/volumes/([^/]+)/browse$#', $path, $m) && $method === 'GET') {
            return $this->browseVolume(rawurldecode($m[1]), $request, $user);
        }
        if (preg_match('#^/api/volumes/([^/]+)/file$#', $path, $m) && $method === 'GET') {
            return $this->readVolumeFile(rawurldecode($m[1]), $request, $user);
        }
        if (preg_match('#^/api/volumes/([^/]+)/file$#', $path, $m) && $method === 'POST') {
            return $this->writeVolumeFile(rawurldecode($m[1]), $request, $user);
        }
        if (preg_match('#^/api/volumes/([^/]+)/mkdir$#', $path, $m) && $method === 'POST') {
            return $this->mkdirVolumePath(rawurldecode($m[1]), $request, $user);
        }
        if (preg_match('#^/api/volumes/([^/]+)/rename$#', $path, $m) && $method === 'POST') {
            return $this->renameVolumePath(rawurldecode($m[1]), $request, $user);
        }
        if (preg_match('#^/api/volumes/([^/]+)/entry$#', $path, $m) && $method === 'DELETE') {
            return $this->deleteVolumeEntry(rawurldecode($m[1]), $request, $user);
        }
        if (preg_match('#^/api/volumes/([^/]+)/download$#', $path, $m) && $method === 'GET') {
            return $this->downloadVolumeFile(rawurldecode($m[1]), $request, $user);
        }

        if ($path === '/api/registries' && $method === 'GET') {
            $rows = $this->repo->listRegistriesForUser(
                Ownership::userId($user),
                Ownership::isAdmin($user),
            );
            return Response::json(array_map([$this, 'formatRegistry'], $rows));
        }
        if ($path === '/api/registries' && $method === 'POST') {
            return $this->createRegistry($request, $user);
        }
        if (preg_match('#^/api/registries/(\d+)$#', $path, $m)) {
            $id = (int) $m[1];
            if ($method === 'GET') {
                $row = $this->repo->getRegistry($id);
                if (!$row || !$this->canAccessRegistry($row, $user)) {
                    return Response::error('Registre introuvable', 404);
                }
                return Response::json($this->formatRegistry($row));
            }
            if ($method === 'PUT') {
                return $this->updateRegistry($id, $request, $user);
            }
            if ($method === 'DELETE') {
                $row = $this->repo->getRegistry($id);
                if (!$row || !$this->canManageRegistry($row, $user)) {
                    return Response::error('Registre introuvable ou accès refusé', 404);
                }
                $this->repo->deleteRegistry($id);
                return Response::empty(204);
            }
        }
        if (preg_match('#^/api/registries/(\d+)/ping$#', $path, $m) && $method === 'GET') {
            return $this->pingRegistry((int) $m[1], $user);
        }
        if (preg_match('#^/api/registries/(\d+)/repositories$#', $path, $m) && $method === 'GET') {
            return $this->browseRegistryRepos((int) $m[1], $request, $user);
        }
        if (preg_match('#^/api/registries/(\d+)/tags$#', $path, $m) && $method === 'GET') {
            $repo = (string) ($request->query('repo') ?? $request->query('repository') ?? '');
            return $this->browseRegistryTags((int) $m[1], $repo, $user);
        }
        if (preg_match('#^/api/registries/(\d+)/pull$#', $path, $m) && $method === 'POST') {
            return $this->pullFromRegistry((int) $m[1], $request, $user);
        }

        if ($path === '/api/stacks' && $method === 'GET') {
            return $this->listStacks($request, $user);
        }

        if ($path === '/api/stacks/create/standalone/string' && $method === 'POST') {
            return $this->createStack($request, $user);
        }

        if ($path === '/api/stacks' && $method === 'POST') {
            $type = (int) ($request->query('type') ?? 2);
            $methodParam = $request->query('method') ?? 'string';
            if ($type === 2 && $methodParam === 'string') {
                return $this->createStack($request, $user);
            }
            return Response::error('Méthode de création de stack non prise en charge', 400);
        }

        if (preg_match('#^/api/stacks/(\d+)/file$#', $path, $m) && $method === 'GET') {
            return $this->getStackFile((int) $m[1], $user);
        }

        if (preg_match('#^/api/stacks/(\d+)$#', $path, $m)) {
            $id = (int) $m[1];
            if ($method === 'GET') {
                return $this->getStack($id, $user);
            }
            if ($method === 'PUT') {
                return $this->updateStack($id, $request, $user);
            }
            if ($method === 'DELETE') {
                return $this->deleteStack($id, $request, $user);
            }
        }

        return Response::error('Introuvable', 404);
    }

    /** @return array<string, mixed>|Response */
    private function authenticateRequest(Request $request): array|Response
    {
        $apiKey = $request->header('X-API-Key') ?? $request->header('X-Api-Key');
        if ($apiKey) {
            if (!preg_match('/^ptr_[a-f0-9]{48}$/', $apiKey)) {
                return Response::error('Clé API invalide', 401);
            }
            $row = $this->repo->findApiKeyByRaw($apiKey);
            if (!$row) {
                return Response::error('Clé API invalide', 401);
            }
            return [
                'id' => (int) $row['user_id'],
                'username' => (string) $row['username'],
                'role' => (int) $row['role'],
            ];
        }

        $auth = $request->header('Authorization');
        if (!$auth || !preg_match('/^Bearer\s+(\S+)$/i', $auth, $m)) {
            return Response::error('Non autorisé', 401);
        }
        $claims = $this->jwt->decode($m[1]);
        if (!$claims || !isset($claims['id'])) {
            return Response::error('Jeton JWT invalide', 401);
        }
        // Always reload role/username from DB (token alone is not authoritative).
        $dbUser = $this->repo->findUserById((int) $claims['id']);
        if (!$dbUser) {
            return Response::error('Jeton JWT invalide', 401);
        }
        return [
            'id' => (int) $dbUser['id'],
            'username' => (string) $dbUser['username'],
            'role' => (int) $dbUser['role'],
        ];
    }

    private function clientIp(Request $request): string
    {
        $xff = $request->header('X-Forwarded-For');
        if ($xff) {
            $first = trim(explode(',', $xff)[0]);
            if (filter_var($first, FILTER_VALIDATE_IP)) {
                return $first;
            }
        }
        $ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
        return is_string($ip) ? $ip : '0.0.0.0';
    }

    private function adminInit(Request $request): Response
    {
        if ($this->repo->userCount() > 0) {
            return Response::error('L\'administrateur est déjà initialisé', 409);
        }
        $ip = $this->clientIp($request);
        $bucket = 'admin-init:' . $ip;
        if ($this->rateLimiter->tooMany($bucket)) {
            return Response::error('Trop de tentatives, réessayez plus tard', 429);
        }
        $this->rateLimiter->hit($bucket);

        $body = $request->json();
        $username = trim((string) ($body['Username'] ?? $body['username'] ?? ''));
        $password = (string) ($body['Password'] ?? $body['password'] ?? '');
        if ($username === '' || !preg_match('/^[a-zA-Z0-9._-]{3,64}$/', $username)) {
            return Response::error('Nom d\'utilisateur invalide (3–64 caractères alphanumériques)', 400);
        }
        if ($err = PasswordPolicy::validate($password)) {
            return Response::error($err, 400);
        }
        $user = $this->repo->createAdmin($username, $password);
        $this->rateLimiter->clear($bucket);
        $this->audit(
            ['id' => (int) $user['id'], 'username' => (string) $user['username'], 'role' => (int) $user['role']],
            'auth.admin_init',
            'Initialisation de l’administrateur « ' . $username . ' »',
            $request,
        );
        return Response::json($this->publicUser([
            'id' => (int) $user['id'],
            'username' => $user['username'],
            'role' => (int) $user['role'],
        ]), 200);
    }

    private function authenticate(Request $request): Response
    {
        $ip = $this->clientIp($request);
        $bucket = 'auth:' . $ip;
        if ($this->rateLimiter->tooMany($bucket)) {
            $retry = $this->rateLimiter->retryAfter($bucket);
            $this->audit(null, 'auth.login.rate_limited', 'Connexion refusée (trop de tentatives)', $request, [
                'ip' => $ip,
            ]);
            return new Response(
                429,
                json_encode(['message' => 'Trop de tentatives de connexion'], JSON_UNESCAPED_UNICODE) ?: '{}',
                [
                    'Content-Type' => 'application/json',
                    'Retry-After' => (string) max(1, $retry),
                ],
            );
        }

        $body = $request->json();
        $username = (string) ($body['Username'] ?? $body['username'] ?? '');
        $password = (string) ($body['Password'] ?? $body['password'] ?? '');
        $user = $this->repo->findUserByUsername($username);
        if (!$user || !password_verify($password, $user['password_hash'])) {
            $this->rateLimiter->hit($bucket);
            usleep(random_int(80_000, 180_000));
            $this->audit(
                null,
                'auth.login.fail',
                'Échec de connexion' . ($username !== '' ? ' pour « ' . $username . ' »' : ''),
                $request,
                ['username' => $username],
            );
            return Response::error('Identifiants invalides', 422);
        }
        $this->rateLimiter->clear($bucket);
        $token = $this->jwt->encode([
            'id' => (int) $user['id'],
            'username' => $user['username'],
            'role' => (int) $user['role'],
        ]);
        $this->audit(
            ['id' => (int) $user['id'], 'username' => (string) $user['username'], 'role' => (int) $user['role']],
            'auth.login.ok',
            'Connexion de « ' . $user['username'] . ' »',
            $request,
        );
        return Response::json(['jwt' => $token]);
    }

    /** @param array<string, mixed> $user */
    private function createToken(int $userId, Request $request, array $user): Response
    {
        if ((int) $user['id'] !== $userId && (int) $user['role'] !== 1) {
            return Response::error('Accès refusé', 403);
        }
        $body = $request->json();
        $description = (string) ($body['description'] ?? $body['Description'] ?? 'api-key');
        $password = (string) ($body['password'] ?? $body['Password'] ?? '');
        $dbUser = $this->repo->findUserById($userId);
        if (!$dbUser) {
            return Response::error('Utilisateur introuvable', 404);
        }
        if ($password === '' || !password_verify($password, $dbUser['password_hash'])) {
            return Response::error('Mot de passe requis pour créer une clé API', 422);
        }
        $raw = 'ptr_' . bin2hex(random_bytes(24));
        $meta = $this->repo->createApiKey($userId, $description, $raw);
        $this->audit($user, 'api_key.create', 'Création d’une clé API (« ' . $description . ' »)', $request, [
            'targetUserId' => $userId,
            'prefix' => $meta['prefix'],
        ]);
        return Response::json([
            'id' => $meta['id'],
            'description' => $description,
            'prefix' => $meta['prefix'],
            'dateCreated' => $meta['dateCreated'],
            'rawAPIKey' => $raw,
        ]);
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function proxyDocker(int $endpointId, string $dockerPath, Request $request, array $user): Response
    {
        $ep = $this->repo->getEndpoint($endpointId);
        if (!$ep) {
            return Response::error('Environnement introuvable', 404);
        }

        $dockerPath = $dockerPath === '' ? '/' : $dockerPath;
        $forwardHeaders = [];
        $contentType = $request->header('Content-Type');
        if ($contentType) {
            $forwardHeaders['Content-Type'] = $contentType;
        }

        $response = $this->dockerScope->handle(
            $user,
            $request->method,
            $dockerPath,
            $request->rawBody !== '' ? $request->rawBody : null,
            $forwardHeaders,
            $request->query,
        );
        if ($response->status < 400) {
            $this->auditDockerMutation($user, $request->method, $dockerPath, $request);
        }
        return $response;
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function containerLogs(int $endpointId, string $containerId, Request $request, array $user): Response
    {
        if (!$this->repo->getEndpoint($endpointId)) {
            return Response::error('Environnement introuvable', 404);
        }
        if (!$this->dockerScope->canAccessContainer($containerId, $user)) {
            return Response::error('Accès refusé à ce conteneur', 403);
        }

        $tailRaw = (string) ($request->query('tail') ?? '200');
        $tail = strtolower($tailRaw) === 'all' ? 'all' : max(0, min(5000, (int) $tailRaw));
        $timestamps = ($request->query('timestamps') ?? 'true') !== 'false';
        $stdout = ($request->query('stdout') ?? 'true') !== 'false';
        $stderr = ($request->query('stderr') ?? 'true') !== 'false';
        $annotate = ($request->query('annotate') ?? 'true') !== 'false';
        $sinceRaw = $request->query('since');
        $since = ($sinceRaw !== null && $sinceRaw !== '' && (int) $sinceRaw > 0) ? (int) $sinceRaw : null;

        try {
            $exec = new \App\Docker\Exec($this->docker);
            $text = $exec->logs($containerId, [
                'tail' => $tail,
                'timestamps' => $timestamps,
                'stdout' => $stdout,
                'stderr' => $stderr,
                'since' => $since,
                'annotate' => $annotate,
            ]);
        } catch (\Throwable $e) {
            $status = $e->getCode() >= 400 && $e->getCode() < 600 ? (int) $e->getCode() : 500;
            return Response::error($e->getMessage(), $status);
        }
        return Response::text($text, 200, ['Content-Type' => 'text/plain; charset=utf-8']);
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function containerExec(int $endpointId, string $containerId, Request $request, array $user): Response
    {
        if (!$this->dockerScope->canAccessContainer($containerId, $user)) {
            return Response::error('Accès refusé à ce conteneur', 403);
        }

        if (!$this->repo->getEndpoint($endpointId)) {
            return Response::error('Environnement introuvable', 404);
        }
        $body = $request->json();
        $command = trim((string) ($body['command'] ?? $body['Command'] ?? ''));
        $userShell = (string) ($body['shell'] ?? '/bin/sh');
        if ($command === '') {
            return Response::error('La commande est requise', 400);
        }
        if (strlen($command) > 4000) {
            return Response::error('Commande trop longue', 400);
        }
        if (!in_array($userShell, ['/bin/sh', '/bin/bash', '/bin/ash', 'sh', 'bash', 'ash'], true)) {
            return Response::error('Shell non autorisé', 400);
        }
        $cwd = trim((string) ($body['cwd'] ?? ''));
        if ($cwd !== '' && (str_contains($cwd, "\0") || strlen($cwd) > 512)) {
            return Response::error('Répertoire de travail invalide', 400);
        }
        $script = $cwd !== '' ? 'cd ' . escapeshellarg($cwd) . ' && ' . $command : $command;
        $cmd = [$userShell, '-lc', $script];
        try {
            $exec = new \App\Docker\Exec($this->docker);
            $result = $exec->run($containerId, $cmd, false);
        } catch (\Throwable $e) {
            // Retry with /bin/sh if bash missing
            if ($userShell !== '/bin/sh') {
                try {
                    $exec = new \App\Docker\Exec($this->docker);
                    $result = $exec->run($containerId, ['/bin/sh', '-lc', $script], false);
                } catch (\Throwable $e2) {
                    $status = $e2->getCode() >= 400 && $e2->getCode() < 600 ? (int) $e2->getCode() : 500;
                    return Response::error($e2->getMessage(), $status);
                }
            } else {
                $status = $e->getCode() >= 400 && $e->getCode() < 600 ? (int) $e->getCode() : 500;
                return Response::error($e->getMessage(), $status);
            }
        }
        return Response::json($result);
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function listStacks(Request $request, array $user): Response
    {
        $endpointId = $request->query('endpointId');
        $rows = $this->repo->listStacksForUser(
            Ownership::username($user),
            Ownership::isAdmin($user),
            $endpointId !== null ? (int) $endpointId : null,
        );
        return Response::json(array_map([$this, 'formatStack'], $rows));
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function getStack(int $id, array $user): Response
    {
        $stack = $this->repo->getStack($id);
        if (!$stack || !$this->canAccessStack($stack, $user)) {
            return Response::error('Stack introuvable', 404);
        }
        return Response::json($this->formatStack($stack));
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function getStackFile(int $id, array $user): Response
    {
        $stack = $this->repo->getStack($id);
        if (!$stack || !$this->canAccessStack($stack, $user)) {
            return Response::error('Stack introuvable', 404);
        }
        try {
            $content = $this->compose->readComposeFile($stack['project_path'], $stack['entry_point']);
        } catch (\Throwable $e) {
            return Response::error($e->getMessage(), 404);
        }
        return Response::json(['StackFileContent' => $content]);
    }

    /** @param array<string, mixed> $user */
    private function createStack(Request $request, array $user): Response
    {
        $endpointId = (int) ($request->query('endpointId') ?? 1);
        if (!$this->repo->getEndpoint($endpointId)) {
            return Response::error('Environnement introuvable', 404);
        }
        $body = $request->json();
        $name = trim((string) ($body['Name'] ?? $body['name'] ?? ''));
        $content = (string) ($body['StackFileContent'] ?? $body['stackFileContent'] ?? '');
        $env = $body['Env'] ?? $body['env'] ?? [];
        if (!is_array($env)) {
            $env = [];
        }
        if ($name === '' || $content === '') {
            return Response::error('Le nom et le contenu Compose sont requis', 400);
        }
        if (!preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/', $name)) {
            return Response::error('Nom de stack invalide', 400);
        }
        if ($deny = $this->assertComposeSafeForUser($content, $env, $user)) {
            return $deny;
        }

        $entryPoint = 'docker-compose.yml';
        $projectPath = null;
        try {
            foreach ($this->repo->listStacks($endpointId) as $existing) {
                if (strcasecmp((string) $existing['name'], $name) === 0) {
                    return Response::error('Une stack avec ce nom existe déjà', 409);
                }
            }
            $content = Ownership::injectComposeServiceLabels($content, Ownership::labelsFor($user));
            $projectPath = $this->compose->writeComposeFile($name, $content, $entryPoint);
            $this->compose->up($projectPath, $name, $env);
            $row = $this->repo->createStack(
                $name,
                $endpointId,
                $projectPath,
                $entryPoint,
                $env,
                (string) $user['username'],
            );
        } catch (\Throwable $e) {
            if (is_string($projectPath) && $projectPath !== '') {
                $this->compose->down($projectPath, $name, $env);
                $this->compose->removeProjectDir($projectPath);
            }
            return Response::error($e->getMessage(), 500);
        }

        $this->audit($user, 'stack.create', 'Création de la stack « ' . $name . ' »', $request, [
            'stackId' => (int) ($row['id'] ?? 0),
            'name' => $name,
        ]);
        return Response::json($this->formatStack($row), 200);
    }

    /** @param array<string, mixed> $user */
    private function updateStack(int $id, Request $request, array $user): Response
    {
        $stack = $this->repo->getStack($id);
        if (!$stack || !$this->canAccessStack($stack, $user)) {
            return Response::error('Stack introuvable', 404);
        }
        $body = $request->json();
        $content = (string) ($body['StackFileContent'] ?? $body['stackFileContent'] ?? '');
        $env = $body['Env'] ?? $body['env'] ?? json_decode($stack['env_json'], true);
        if (!is_array($env)) {
            $env = [];
        }
        if ($content === '') {
            try {
                $content = $this->compose->readComposeFile($stack['project_path'], $stack['entry_point']);
            } catch (\Throwable $e) {
                return Response::error($e->getMessage(), 400);
            }
        }
        if ($deny = $this->assertComposeSafeForUser($content, $env, $user)) {
            return $deny;
        }

        try {
            $content = Ownership::injectComposeServiceLabels($content, Ownership::labelsFor($user));
            $this->compose->writeComposeFile($stack['name'], $content, $stack['entry_point']);
            $this->compose->up($stack['project_path'], $stack['name'], $env);
            $row = $this->repo->updateStack($id, $env, (string) $user['username']);
        } catch (\Throwable $e) {
            return Response::error($e->getMessage(), 500);
        }

        $this->audit($user, 'stack.update', 'Mise à jour de la stack « ' . $stack['name'] . ' »', $request, [
            'stackId' => $id,
            'name' => $stack['name'],
        ]);
        return Response::json($this->formatStack($row ?? $stack));
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function deleteStack(int $id, Request $request, array $user): Response
    {
        $stack = $this->repo->getStack($id);
        if (!$stack || !$this->canAccessStack($stack, $user)) {
            return Response::error('Stack introuvable', 404);
        }
        $env = json_decode($stack['env_json'], true);
        if (!is_array($env)) {
            $env = [];
        }
        try {
            $this->compose->down($stack['project_path'], $stack['name'], $env);
            $this->compose->removeProjectDir($stack['project_path']);
            $this->repo->deleteStack($id);
        } catch (\Throwable $e) {
            return Response::error($e->getMessage(), 500);
        }
        $this->audit($user, 'stack.delete', 'Suppression de la stack « ' . $stack['name'] . ' »', $request, [
            'stackId' => $id,
            'name' => $stack['name'],
        ]);
        return Response::empty(204);
    }

    /** @param array<string, mixed> $user */
    private function requireAdmin(array $user): ?Response
    {
        if ((int) ($user['role'] ?? 0) !== 1) {
            return Response::error('Accès administrateur requis', 403);
        }
        return null;
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function browseVolume(string $name, Request $request, array $user): Response
    {
        if (!$this->dockerScope->canAccessVolume($name, $user)) {
            return Response::error('Accès refusé à ce volume', 403);
        }
        $rel = (string) ($request->query('path') ?? '/');
        try {
            return Response::json($this->volumeBrowser->list($name, $rel));
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function readVolumeFile(string $name, Request $request, array $user): Response
    {
        if (!$this->dockerScope->canAccessVolume($name, $user)) {
            return Response::error('Accès refusé à ce volume', 403);
        }
        $rel = (string) ($request->query('path') ?? '');
        try {
            return Response::json($this->volumeBrowser->readFile($name, $rel));
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function downloadVolumeFile(string $name, Request $request, array $user): Response
    {
        if (!$this->dockerScope->canAccessVolume($name, $user)) {
            return Response::error('Accès refusé à ce volume', 403);
        }
        $rel = (string) ($request->query('path') ?? '');
        try {
            $file = $this->volumeBrowser->download($name, $rel);
            $safeName = preg_replace('/[^\w.\-]+/', '_', $file['Name']) ?: 'file';
            return new Response(
                200,
                $file['Bytes'],
                [
                    'Content-Type' => 'application/octet-stream',
                    'Content-Disposition' => 'attachment; filename="' . $safeName . '"',
                    'Content-Length' => (string) $file['Size'],
                ],
            );
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function writeVolumeFile(string $name, Request $request, array $user): Response
    {
        if (!$this->dockerScope->canAccessVolume($name, $user)) {
            return Response::error('Accès refusé à ce volume', 403);
        }
        $body = $request->json();
        $rel = (string) ($body['Path'] ?? $body['path'] ?? '');
        try {
            $result = $this->volumeBrowser->writeFile($name, $rel, [
                'Content' => (string) ($body['Content'] ?? $body['content'] ?? ''),
                'Encoding' => (string) ($body['Encoding'] ?? $body['encoding'] ?? 'text'),
                'CreateOnly' => array_key_exists('CreateOnly', $body)
                    ? (bool) $body['CreateOnly']
                    : (array_key_exists('createOnly', $body) ? (bool) $body['createOnly'] : true),
            ]);
            return Response::json($result, 201);
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function mkdirVolumePath(string $name, Request $request, array $user): Response
    {
        if (!$this->dockerScope->canAccessVolume($name, $user)) {
            return Response::error('Accès refusé à ce volume', 403);
        }
        $body = $request->json();
        $rel = (string) ($body['Path'] ?? $body['path'] ?? '');
        try {
            return Response::json($this->volumeBrowser->mkdir($name, $rel), 201);
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function renameVolumePath(string $name, Request $request, array $user): Response
    {
        if (!$this->dockerScope->canAccessVolume($name, $user)) {
            return Response::error('Accès refusé à ce volume', 403);
        }
        $body = $request->json();
        $from = (string) ($body['From'] ?? $body['from'] ?? '');
        $to = (string) ($body['To'] ?? $body['to'] ?? '');
        try {
            return Response::json($this->volumeBrowser->rename($name, $from, $to));
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function deleteVolumeEntry(string $name, Request $request, array $user): Response
    {
        if (!$this->dockerScope->canAccessVolume($name, $user)) {
            return Response::error('Accès refusé à ce volume', 403);
        }
        $body = $request->json();
        $rel = (string) ($body['Path'] ?? $body['path'] ?? $request->query('path') ?? '');
        try {
            $this->volumeBrowser->delete($name, $rel);
            return Response::empty(204);
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function createRegistry(Request $request, array $user): Response
    {
        $body = $request->json();
        $name = trim((string) ($body['Name'] ?? $body['name'] ?? ''));
        $url = trim((string) ($body['URL'] ?? $body['Url'] ?? $body['url'] ?? ''));
        $username = trim((string) ($body['Username'] ?? $body['username'] ?? ''));
        $password = (string) ($body['Password'] ?? $body['password'] ?? '');
        $type = strtolower(trim((string) ($body['Type'] ?? $body['type'] ?? 'v2')));
        $shared = Ownership::isAdmin($user) && !empty($body['Shared']);
        if (!in_array($type, ['hub', 'v2'], true)) {
            $type = 'v2';
        }
        if ($name === '' || $url === '') {
            return Response::error('Le nom et l’URL sont requis', 400);
        }
        if ($type === 'hub') {
            $url = 'https://docker.io';
        } elseif (!preg_match('#^https?://#i', $url)) {
            $url = 'https://' . $url;
        }
        try {
            $client = new RegistryClient([
                'name' => $name,
                'url' => $url,
                'username' => $username,
                'password' => $password,
                'type' => $type,
            ]);
            $client->ping();
        } catch (\Throwable $e) {
            return Response::error('Connexion au registre impossible : ' . $e->getMessage(), 400);
        }
        $row = $this->repo->createRegistry(
            $name,
            $url,
            $username,
            $password,
            $type,
            Ownership::userId($user),
            Ownership::username($user),
            $shared,
        );
        return Response::json($this->formatRegistry($row), 201);
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function updateRegistry(int $id, Request $request, array $user): Response
    {
        $existing = $this->repo->getRegistry($id);
        if (!$existing || !$this->canManageRegistry($existing, $user)) {
            return Response::error('Registre introuvable', 404);
        }
        $body = $request->json();
        $name = trim((string) ($body['Name'] ?? $body['name'] ?? $existing['name']));
        $url = trim((string) ($body['URL'] ?? $body['Url'] ?? $body['url'] ?? $existing['url']));
        $username = trim((string) ($body['Username'] ?? $body['username'] ?? $existing['username']));
        $password = array_key_exists('Password', $body) || array_key_exists('password', $body)
            ? (string) ($body['Password'] ?? $body['password'] ?? '')
            : null;
        $type = strtolower(trim((string) ($body['Type'] ?? $body['type'] ?? $existing['type'])));
        if (!in_array($type, ['hub', 'v2'], true)) {
            $type = 'v2';
        }
        if ($name === '' || $url === '') {
            return Response::error('Le nom et l’URL sont requis', 400);
        }
        if ($type === 'hub') {
            $url = 'https://docker.io';
        } elseif (!preg_match('#^https?://#i', $url)) {
            $url = 'https://' . $url;
        }
        $passForTest = $password !== null ? $password : (string) $existing['password'];
        try {
            $client = new RegistryClient([
                'url' => $url,
                'username' => $username,
                'password' => $passForTest,
                'type' => $type,
            ]);
            $client->ping();
        } catch (\Throwable $e) {
            return Response::error('Connexion au registre impossible : ' . $e->getMessage(), 400);
        }
        $row = $this->repo->updateRegistry($id, $name, $url, $username, $password, $type);
        return Response::json($this->formatRegistry($row ?? $existing));
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function pingRegistry(int $id, array $user): Response
    {
        $row = $this->repo->getRegistry($id);
        if (!$row || !$this->canAccessRegistry($row, $user)) {
            return Response::error('Registre introuvable', 404);
        }
        try {
            $result = (new RegistryClient($row))->ping();
            return Response::json($result);
        } catch (\Throwable $e) {
            return Response::error($e->getMessage(), 502);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function browseRegistryRepos(int $id, Request $request, array $user): Response
    {
        $row = $this->repo->getRegistry($id);
        if (!$row || !$this->canAccessRegistry($row, $user)) {
            return Response::error('Registre introuvable', 404);
        }
        $q = (string) ($request->query('q') ?? $request->query('query') ?? '');
        $n = (int) ($request->query('n') ?? 50);
        try {
            $data = (new RegistryClient($row))->listRepositories($q, max(1, min(200, $n)));
            return Response::json($data);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 502);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function browseRegistryTags(int $id, string $repository, array $user): Response
    {
        $row = $this->repo->getRegistry($id);
        if (!$row || !$this->canAccessRegistry($row, $user)) {
            return Response::error('Registre introuvable', 404);
        }
        try {
            $data = (new RegistryClient($row))->listTags($repository);
            return Response::json($data);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 502);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function pullFromRegistry(int $id, Request $request, array $user): Response
    {
        $row = $this->repo->getRegistry($id);
        if (!$row || !$this->canAccessRegistry($row, $user)) {
            return Response::error('Registre introuvable', 404);
        }
        $body = $request->json();
        $repo = trim((string) ($body['Repository'] ?? $body['repository'] ?? $body['Name'] ?? ''));
        $tag = trim((string) ($body['Tag'] ?? $body['tag'] ?? 'latest'));
        if ($repo === '') {
            return Response::error('Dépôt requis', 400);
        }
        if ($tag === '') {
            $tag = 'latest';
        }
        $type = (string) ($row['type'] ?? 'v2');
        if ($type === 'hub') {
            $fromImage = $repo;
        } else {
            $host = preg_replace('#^https?://#i', '', (string) $row['url']);
            $host = rtrim((string) $host, '/');
            $fromImage = $host . '/' . $repo;
        }
        $headers = [];
        $username = (string) ($row['username'] ?? '');
        $password = (string) ($row['password'] ?? '');
        if ($username !== '' || $password !== '') {
            $auth = [
                'username' => $username,
                'password' => $password,
                'serveraddress' => $type === 'hub' ? 'https://index.docker.io/v1/' : (string) $row['url'],
            ];
            $headers['X-Registry-Auth'] = base64_encode(json_encode($auth, JSON_UNESCAPED_SLASHES) ?: '{}');
        }
        try {
            $res = $this->docker->request(
                'POST',
                '/images/create',
                null,
                $headers,
                ['fromImage' => $fromImage, 'tag' => $tag],
            );
            if ($res['status'] >= 400) {
                $decoded = json_decode($res['body'], true);
                $msg = is_array($decoded) ? (string) ($decoded['message'] ?? $res['body']) : $res['body'];
                return Response::error($msg !== '' ? $msg : 'Échec du pull', $res['status']);
            }
            return Response::json([
                'Image' => $fromImage . ':' . $tag,
                'Log' => $res['body'],
            ]);
        } catch (\Throwable $e) {
            return Response::error($e->getMessage(), 500);
        }
    }

    /** @param array<string, mixed> $row */
    private function formatRegistry(array $row): array
    {
        return [
            'Id' => (int) $row['id'],
            'Name' => (string) $row['name'],
            'URL' => (string) $row['url'],
            'Username' => (string) $row['username'],
            'Authentication' => ((string) ($row['username'] ?? '') !== '' || (string) ($row['password'] ?? '') !== ''),
            'Type' => (string) ($row['type'] ?? 'v2'),
            'CreatedAt' => (int) ($row['created_at'] ?? 0),
            'OwnerId' => isset($row['owner_id']) ? (int) $row['owner_id'] : null,
            'OwnerUsername' => (string) ($row['owner_username'] ?? ''),
            'Shared' => !empty($row['is_shared']),
        ];
    }

    /**
     * Non-admin stacks: resolve via `docker compose config` then apply ComposePolicy.
     * @param list<array{name?:string,value?:string}|array{Name?:string,Value?:string}> $env
     * @param array{id:int,username:string,role:int} $user
     */
    private function assertComposeSafeForUser(string $content, array $env, array $user): ?Response
    {
        if (Ownership::isAdmin($user)) {
            return null;
        }
        try {
            $resolved = $this->compose->resolveConfig($content, $env);
            $violations = ComposePolicy::violations($resolved);
        } catch (\Throwable $e) {
            return Response::error('Compose invalide : ' . $e->getMessage(), 400);
        }
        if ($violations !== []) {
            return Response::error(implode(' · ', $violations), 403);
        }
        return null;
    }

    /** @param array<string, mixed> $stack @param array{id:int,username:string,role:int} $user */
    private function canAccessStack(array $stack, array $user): bool
    {
        if (Ownership::isAdmin($user)) {
            return true;
        }
        return strcasecmp((string) ($stack['created_by'] ?? ''), Ownership::username($user)) === 0;
    }

    /** @param array<string, mixed> $row @param array{id:int,username:string,role:int} $user */
    private function canAccessRegistry(array $row, array $user): bool
    {
        if (Ownership::isAdmin($user)) {
            return true;
        }
        if (!empty($row['is_shared'])) {
            return true;
        }
        return (int) ($row['owner_id'] ?? 0) === Ownership::userId($user);
    }

    /** @param array<string, mixed> $row @param array{id:int,username:string,role:int} $user */
    private function canManageRegistry(array $row, array $user): bool
    {
        if (Ownership::isAdmin($user)) {
            return true;
        }
        // Shared system registries: admin only
        if (!empty($row['is_shared']) && (int) ($row['owner_id'] ?? 0) === 0) {
            return false;
        }
        return (int) ($row['owner_id'] ?? 0) === Ownership::userId($user);
    }

    private function searchImages(Request $request): Response
    {
        $q = trim((string) ($request->query('q') ?? $request->query('query') ?? ''));
        if (strlen($q) < 1) {
            return Response::json(['Local' => [], 'Remote' => [], 'Query' => $q]);
        }
        $qLower = strtolower($q);
        $local = [];
        try {
            $images = $this->docker->json('GET', '/images/json');
            foreach ($images as $img) {
                $tags = $img['RepoTags'] ?? [];
                if (!is_array($tags) || $tags === []) {
                    continue;
                }
                foreach ($tags as $tag) {
                    if (!is_string($tag) || $tag === '<none>:<none>') {
                        continue;
                    }
                    if (!str_contains(strtolower($tag), $qLower)) {
                        continue;
                    }
                    $local[] = [
                        'Name' => $tag,
                        'Id' => (string) ($img['Id'] ?? ''),
                        'Size' => (int) ($img['Size'] ?? 0),
                        'Source' => 'local',
                        'Official' => false,
                        'Description' => 'Image locale',
                        'StarCount' => 0,
                    ];
                }
            }
        } catch (\Throwable) {
            // ignore local failures; still try hub
        }

        $remote = [];
        try {
            $url = 'https://hub.docker.com/v2/search/repositories/?query=' . rawurlencode($q) . '&page_size=20';
            $raw = $this->httpGet($url, 8);
            $data = json_decode($raw, true);
            foreach (($data['results'] ?? []) as $row) {
                $name = (string) ($row['repo_name'] ?? $row['name'] ?? '');
                if ($name === '') {
                    continue;
                }
                $remote[] = [
                    'Name' => $name,
                    'Id' => '',
                    'Size' => 0,
                    'Source' => 'hub',
                    'Official' => !empty($row['is_official']),
                    'Description' => (string) ($row['short_description'] ?? $row['description'] ?? ''),
                    'StarCount' => (int) ($row['star_count'] ?? 0),
                    'PullCount' => (int) ($row['pull_count'] ?? 0),
                ];
            }
        } catch (\Throwable $e) {
            return Response::json([
                'Local' => array_slice($local, 0, 30),
                'Remote' => [],
                'Query' => $q,
                'HubError' => $e->getMessage(),
            ]);
        }

        return Response::json([
            'Local' => array_slice($local, 0, 30),
            'Remote' => $remote,
            'Query' => $q,
        ]);
    }

    private function searchImageTags(Request $request): Response
    {
        $repo = trim((string) ($request->query('repo') ?? $request->query('image') ?? ''));
        if ($repo === '') {
            return Response::error('Le paramètre repo est requis', 400);
        }
        $repo = ltrim($repo, '/');
        // official images live under library/
        $hubRepo = str_contains($repo, '/') ? $repo : ('library/' . $repo);
        try {
            $parts = explode('/', $hubRepo);
            $url = 'https://hub.docker.com/v2/repositories/'
                . implode('/', array_map('rawurlencode', $parts))
                . '/tags?page_size=40&ordering=-last_updated';
            $raw = $this->httpGet($url, 10);
            $data = json_decode($raw, true);
            $tags = [];
            foreach (($data['results'] ?? []) as $row) {
                $name = (string) ($row['name'] ?? '');
                if ($name === '') {
                    continue;
                }
                $tags[] = [
                    'Name' => $name,
                    'Size' => (int) ($row['full_size'] ?? 0),
                    'LastUpdated' => (string) ($row['last_updated'] ?? ''),
                ];
            }
            return Response::json([
                'Repo' => $repo,
                'Tags' => $tags,
            ]);
        } catch (\Throwable $e) {
            return Response::error('Impossible de récupérer les tags : ' . $e->getMessage(), 502);
        }
    }

    private function httpGet(string $url, int $timeout = 10): string
    {
        $ch = curl_init($url);
        if ($ch === false) {
            throw new \RuntimeException('Impossible d\'initialiser curl');
        }
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_HTTPHEADER => [
                'Accept: application/json',
                'User-Agent: WharfMaster/1.0.2',
            ],
        ]);
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($body === false) {
            throw new \RuntimeException($err !== '' ? $err : 'Requête HTTP échouée');
        }
        if ($status >= 400) {
            throw new \RuntimeException('HTTP ' . $status);
        }
        return $body;
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function buildImage(Request $request, array $user): Response
    {
        $body = $request->json();
        $dockerfile = (string) ($body['Dockerfile'] ?? $body['dockerfile'] ?? '');
        $tag = trim((string) ($body['Tag'] ?? $body['tag'] ?? $body['Name'] ?? ''));
        $saveAs = trim((string) ($body['SaveAs'] ?? $body['saveAs'] ?? ''));
        try {
            if ($saveAs !== '') {
                $this->imageBuilder->saveDockerfile($saveAs, $dockerfile);
            }
            $result = $this->imageBuilder->build($dockerfile, $tag, Ownership::labelsFor($user));
            $status = $result['success'] ? 200 : 500;
            return Response::json([
                'Success' => $result['success'],
                'Tag' => $tag,
                'Log' => $result['body'],
                'Error' => $result['error'],
            ], $status);
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            return Response::error($e->getMessage(), 500);
        }
    }

    private function saveDockerfile(Request $request): Response
    {
        $body = $request->json();
        $name = trim((string) ($body['Name'] ?? $body['name'] ?? ''));
        $content = (string) ($body['Content'] ?? $body['Dockerfile'] ?? $body['dockerfile'] ?? '');
        try {
            $this->imageBuilder->saveDockerfile($name, $content);
            return Response::json(['Name' => $name], 201);
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            return Response::error($e->getMessage(), 500);
        }
    }

    private function hostResources(): array
    {
        $path = '/';
        $total = @disk_total_space($path);
        $free = @disk_free_space($path);
        if ($total === false || $free === false || $total <= 0) {
            return [
                'DiskTotal' => 0,
                'DiskFree' => 0,
                'DiskUsed' => 0,
                'DiskUsedPercent' => 0,
                'Path' => $path,
            ];
        }
        $used = max(0, (float) $total - (float) $free);
        return [
            'DiskTotal' => (float) $total,
            'DiskFree' => (float) $free,
            'DiskUsed' => $used,
            'DiskUsedPercent' => round(($used / (float) $total) * 100, 1),
            'Path' => $path,
        ];
    }

    private function formatSettings(): array
    {
        $publicUrl = (string) ($this->repo->getSetting('public_url', '') ?? '');
        $ep = $this->repo->getEndpoint(1);
        if ($publicUrl === '' && $ep && !empty($ep['public_url'])) {
            $publicUrl = (string) $ep['public_url'];
        }
        return [
            'LogoURL' => '',
            'BlackListedLabels' => [],
            'AuthenticationMethod' => 1,
            'InternalAuthSettings' => ['RequiredPasswordLength' => 8],
            'EnableEdgeComputeFeatures' => false,
            'UserSessionTimeout' => '8h',
            'EnableTelemetry' => false,
            'SnapshotInterval' => '5m',
            'PublicURL' => $publicUrl,
            // Alias used by our UI
            'HostURL' => $publicUrl,
        ];
    }

    /** @param array<string, mixed> $user */
    private function updateSettings(Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $body = $request->json();
        $publicUrl = trim((string) ($body['PublicURL'] ?? $body['HostURL'] ?? $body['publicURL'] ?? ''));
        $publicUrl = rtrim($publicUrl, '/');
        if ($publicUrl !== '' && !preg_match('#^https?://#i', $publicUrl)) {
            return Response::error('L\'URL publique doit commencer par http:// ou https://', 400);
        }
        $this->repo->setSetting('public_url', $publicUrl);
        $this->repo->updateEndpointPublicUrl(1, $publicUrl);
        $this->audit($user, 'settings.update', 'Mise à jour des paramètres', $request, [
            'publicUrl' => $publicUrl,
        ]);
        return Response::json($this->formatSettings());
    }

    /** @param array<string, mixed> $user */
    private function listUsers(array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $rows = $this->repo->listUsers();
        return Response::json(array_map(static function (array $row): array {
            return [
                'Id' => (int) $row['id'],
                'Username' => $row['username'],
                'Role' => (int) $row['role'],
                'ThemeSettings' => (object) [],
            ];
        }, $rows));
    }

    /** @param array<string, mixed> $user */
    private function createUser(Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $body = $request->json();
        $username = trim((string) ($body['Username'] ?? $body['username'] ?? ''));
        $password = (string) ($body['Password'] ?? $body['password'] ?? '');
        $role = (int) ($body['Role'] ?? $body['role'] ?? 2);
        if ($username === '' || !preg_match('/^[a-zA-Z0-9._-]{3,64}$/', $username)) {
            return Response::error('Nom d\'utilisateur invalide (3–64 caractères alphanumériques)', 400);
        }
        if ($err = PasswordPolicy::validate($password)) {
            return Response::error($err, 400);
        }
        if (!in_array($role, [1, 2], true)) {
            return Response::error('Rôle invalide', 400);
        }
        if ($this->repo->findUserByUsername($username)) {
            return Response::error('Ce nom d\'utilisateur existe déjà', 409);
        }
        $created = $this->repo->createUser($username, $password, $role);
        $this->audit($user, 'user.create', 'Création de l’utilisateur « ' . $username . ' »', $request, [
            'targetId' => (int) $created['id'],
            'role' => $role,
        ]);
        return Response::json($this->publicUser([
            'id' => (int) $created['id'],
            'username' => $created['username'],
            'role' => (int) $created['role'],
        ]), 200);
    }

    /** @param array<string, mixed> $user */
    private function changeUserPassword(int $id, Request $request, array $user): Response
    {
        $isAdmin = (int) ($user['role'] ?? 0) === 1;
        $isSelf = (int) ($user['id'] ?? 0) === $id;
        if (!$isAdmin && !$isSelf) {
            return Response::error('Accès refusé', 403);
        }
        $target = $this->repo->findUserById($id);
        if (!$target) {
            return Response::error('Utilisateur introuvable', 404);
        }
        $body = $request->json();
        $newPassword = (string) ($body['Password'] ?? $body['password'] ?? $body['NewPassword'] ?? '');
        if ($err = PasswordPolicy::validate($newPassword)) {
            return Response::error($err, 400);
        }
        // Changing own password requires current password. Admin reset of another user does not.
        if ($isSelf) {
            $current = (string) ($body['CurrentPassword'] ?? $body['currentPassword'] ?? '');
            if ($current === '' || !password_verify($current, $target['password_hash'])) {
                return Response::error('Mot de passe actuel invalide', 422);
            }
        }
        $this->repo->updateUserPassword($id, $newPassword);
        $this->audit($user, 'user.password', 'Changement de mot de passe pour « ' . $target['username'] . ' »', $request, [
            'targetId' => $id,
            'self' => $isSelf,
        ]);
        return Response::empty(204);
    }

    /** @param array<string, mixed> $user */
    private function deleteUser(int $id, Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        if ((int) $user['id'] === $id) {
            return Response::error('Vous ne pouvez pas supprimer votre propre compte', 400);
        }
        $target = $this->repo->findUserById($id);
        if (!$target) {
            return Response::error('Utilisateur introuvable', 404);
        }
        // Prevent deleting the last admin
        if ((int) $target['role'] === 1) {
            $admins = array_filter($this->repo->listUsers(), static fn(array $u): bool => (int) $u['role'] === 1);
            if (count($admins) <= 1) {
                return Response::error('Impossible de supprimer le dernier administrateur', 400);
            }
        }
        $this->repo->deleteUser($id);
        $this->audit($user, 'user.delete', 'Suppression de l’utilisateur « ' . $target['username'] . ' »', $request, [
            'targetId' => $id,
        ]);
        return Response::empty(204);
    }

    /** @param array<string, mixed> $user */
    private function publicUser(array $user): array
    {
        $role = (int) $user['role'];
        return [
            'Id' => (int) $user['id'],
            'Username' => $user['username'],
            'Role' => $role,
            'IsAdmin' => $role === 1,
            'ThemeSettings' => (object) [],
        ];
    }

    /** @param array<string, mixed> $ep */
    private function formatEndpoint(array $ep): array
    {
        $status = 1;
        try {
            $status = $this->docker->ping() ? 1 : 2;
        } catch (\Throwable) {
            $status = 2;
        }

        return [
            'Id' => (int) $ep['id'],
            'Name' => $ep['name'],
            'Type' => (int) $ep['type'],
            'URL' => $ep['url'],
            'GroupId' => (int) $ep['group_id'],
            'PublicURL' => $ep['public_url'] !== ''
                ? $ep['public_url']
                : (string) ($this->repo->getSetting('public_url', '') ?? ''),
            'Status' => $status,
            'Snapshots' => json_decode($ep['snapshots'] ?: '[]', true) ?: [],
            'IsEdgeDevice' => false,
            'UserAccessPolicies' => (object) [],
            'TeamAccessPolicies' => (object) [],
            'TagIds' => [],
            'Kubernetes' => (object) [],
        ];
    }

    /** @param array<string, mixed> $stack */
    private function formatStack(array $stack): array
    {
        $env = json_decode($stack['env_json'] ?? '[]', true);
        if (!is_array($env)) {
            $env = [];
        }
        return [
            'Id' => (int) $stack['id'],
            'Name' => $stack['name'],
            'Type' => (int) $stack['type'],
            'EndpointId' => (int) $stack['endpoint_id'],
            'SwarmId' => $stack['swarm_id'],
            'EntryPoint' => $stack['entry_point'],
            'Env' => $env,
            'Status' => (int) $stack['status'],
            'ProjectPath' => $stack['project_path'],
            'CreationDate' => (int) $stack['creation_date'],
            'CreatedBy' => $stack['created_by'],
            'UpdateDate' => (int) $stack['update_date'],
            'UpdatedBy' => $stack['updated_by'],
            'FromAppTemplate' => (bool) $stack['from_app_template'],
            'GitConfig' => null,
            'IsComposeFormat' => true,
        ];
    }

    private function ensureInstanceId(): string
    {
        $id = $this->repo->getSetting('instance_id');
        if ($id) {
            return $id;
        }
        $id = bin2hex(random_bytes(16));
        $this->repo->setSetting('instance_id', $id);
        return $id;
    }

    /**
     * @param array{id?:int,username?:string,role?:int}|null $user
     * @param array<string, mixed> $meta
     */
    private function audit(?array $user, string $action, string $message, ?Request $request = null, array $meta = []): void
    {
        try {
            $ip = $request ? $this->clientIp($request) : '';
            $this->repo->addAuditEvent(
                isset($user['id']) ? (int) $user['id'] : null,
                (string) ($user['username'] ?? ''),
                $action,
                $message,
                $ip,
                $meta,
            );
        } catch (\Throwable $e) {
            error_log('[WharfMaster] audit failed: ' . $e->getMessage());
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function auditDockerMutation(array $user, string $method, string $dockerPath, Request $request): void
    {
        $method = strtoupper($method);
        $path = $dockerPath === '' ? '/' : $dockerPath;
        $action = null;
        $message = null;
        $meta = ['method' => $method, 'path' => $path];

        if ($method === 'POST' && preg_match('#^/containers/([^/]+)/start$#', $path, $m)) {
            $action = 'docker.container.start';
            $message = 'Démarrage du conteneur ' . $m[1];
            $meta['containerId'] = $m[1];
        } elseif ($method === 'POST' && preg_match('#^/containers/([^/]+)/stop#', $path, $m)) {
            $action = 'docker.container.stop';
            $message = 'Arrêt du conteneur ' . $m[1];
            $meta['containerId'] = $m[1];
        } elseif ($method === 'POST' && preg_match('#^/containers/([^/]+)/restart#', $path, $m)) {
            $action = 'docker.container.restart';
            $message = 'Redémarrage du conteneur ' . $m[1];
            $meta['containerId'] = $m[1];
        } elseif ($method === 'POST' && preg_match('#^/containers/create#', $path)) {
            $action = 'docker.container.create';
            $message = 'Création d’un conteneur';
            $name = (string) ($request->query('name') ?? '');
            if ($name !== '') {
                $message .= ' « ' . $name . ' »';
                $meta['name'] = $name;
            }
        } elseif ($method === 'DELETE' && preg_match('#^/containers/([^/]+)#', $path, $m)) {
            $action = 'docker.container.remove';
            $message = 'Suppression du conteneur ' . $m[1];
            $meta['containerId'] = $m[1];
        } elseif ($method === 'POST' && preg_match('#^/images/create#', $path)) {
            $action = 'docker.image.pull';
            $from = (string) ($request->query('fromImage') ?? $request->query('fromSrc') ?? '');
            $message = 'Pull d’image' . ($from !== '' ? ' « ' . $from . ' »' : '');
            $meta['image'] = $from;
        } elseif ($method === 'DELETE' && preg_match('#^/images/(.+)$#', $path, $m)) {
            $action = 'docker.image.remove';
            $message = 'Suppression de l’image ' . rawurldecode($m[1]);
            $meta['image'] = rawurldecode($m[1]);
        } elseif ($method === 'POST' && preg_match('#^/volumes/create#', $path)) {
            $action = 'docker.volume.create';
            $message = 'Création d’un volume';
        } elseif ($method === 'DELETE' && preg_match('#^/volumes/(.+)$#', $path, $m)) {
            $action = 'docker.volume.remove';
            $message = 'Suppression du volume ' . rawurldecode($m[1]);
            $meta['volume'] = rawurldecode($m[1]);
        } elseif ($method === 'POST' && preg_match('#^/networks/create#', $path)) {
            $action = 'docker.network.create';
            $message = 'Création d’un réseau';
        } elseif ($method === 'DELETE' && preg_match('#^/networks/(.+)$#', $path, $m)) {
            $action = 'docker.network.remove';
            $message = 'Suppression du réseau ' . rawurldecode($m[1]);
            $meta['network'] = rawurldecode($m[1]);
        } elseif ($method === 'POST' && preg_match('#^/(containers|images|networks|build)/prune#', $path, $m)) {
            $action = 'docker.prune.' . $m[1];
            $message = 'Nettoyage Docker (' . $m[1] . ')';
        }

        if ($action !== null && $message !== null) {
            $this->audit($user, $action, $message, $request, $meta);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function listAudit(Request $request, array $user): Response
    {
        $isAdmin = (int) ($user['role'] ?? 0) === 1;
        $limit = (int) ($request->query('limit') ?? 100);
        $offset = (int) ($request->query('offset') ?? 0);
        $action = trim((string) ($request->query('action') ?? ''));
        $actionFilter = $action !== '' ? $action : null;
        $userFilter = $isAdmin ? null : (int) $user['id'];

        $rows = $this->repo->listAuditEvents($limit, $offset, $actionFilter, $userFilter);
        $total = $this->repo->countAuditEvents($actionFilter, $userFilter);

        $items = array_map(static function (array $row): array {
            $meta = json_decode((string) ($row['meta_json'] ?? '{}'), true);
            if (!is_array($meta)) {
                $meta = [];
            }
            return [
                'Id' => (int) $row['id'],
                'CreatedAt' => (int) $row['created_at'],
                'UserId' => $row['user_id'] !== null ? (int) $row['user_id'] : null,
                'Username' => (string) ($row['username'] ?? ''),
                'Action' => (string) $row['action'],
                'Message' => (string) $row['message'],
                'Ip' => (string) ($row['ip'] ?? ''),
                'Meta' => $meta,
            ];
        }, $rows);

        return Response::json([
            'Total' => $total,
            'Items' => $items,
        ]);
    }
}
