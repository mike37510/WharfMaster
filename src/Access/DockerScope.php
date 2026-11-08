<?php
declare(strict_types=1);

namespace App\Access;

use App\Docker\Client as DockerClient;
use App\Http\Response;
use App\Security\ContainerPolicy;
use App\Security\DockerApiPolicy;
use App\Storage\Repositories;

/**
 * Applies per-user scoping on Docker Engine API proxy calls.
 */
final class DockerScope
{
    public function __construct(
        private readonly DockerClient $docker,
        private readonly Repositories $repo,
    ) {
    }

    /**
     * @param array{id:int,username:string,role:int} $user
     * @param array<string, string> $forwardHeaders
     * @param array<string, mixed> $query
     */
    public function handle(
        array $user,
        string $method,
        string $dockerPath,
        ?string $rawBody,
        array $forwardHeaders,
        array $query,
    ): Response {
        $dockerPath = $dockerPath === '' ? '/' : $dockerPath;
        $method = strtoupper($method);

        if ($deny = DockerApiPolicy::denyAlways($method, $dockerPath)) {
            return Response::error($deny, 403);
        }
        if (!Ownership::isAdmin($user) && ($deny = DockerApiPolicy::denyNonAdmin($method, $dockerPath))) {
            return Response::error($deny, 403);
        }

        $ownedStacks = Ownership::isAdmin($user)
            ? []
            : $this->ownedStackNames($user);

        // --- List containers ---
        if ($method === 'GET' && ($dockerPath === '/containers/json' || str_starts_with($dockerPath, '/containers/json?'))) {
            return $this->listContainers($user, $query, $ownedStacks);
        }

        // --- Create container ---
        if ($method === 'POST' && ($dockerPath === '/containers/create' || str_starts_with($dockerPath, '/containers/create?'))) {
            return $this->createContainer($user, $rawBody, $forwardHeaders, $query);
        }

        // --- Container by id (inspect / start / stop / logs proxy / etc.) ---
        if (preg_match('#^/containers/([^/]+)(/.*)?$#', $dockerPath, $m)) {
            $denied = $this->assertContainerAccess($m[1], $user, $ownedStacks, $method);
            if ($denied) {
                return $denied;
            }
        }

        // --- Volumes list ---
        if ($method === 'GET' && ($dockerPath === '/volumes' || $dockerPath === '/volumes/')) {
            return $this->listVolumes($user, $ownedStacks);
        }

        // --- Volume create ---
        if ($method === 'POST' && ($dockerPath === '/volumes/create' || str_starts_with($dockerPath, '/volumes/create?'))) {
            return $this->createVolume($user, $rawBody, $forwardHeaders);
        }

        // --- Volume by name (never treat "create" as a volume name) ---
        if (preg_match('#^/volumes/([^/]+)$#', $dockerPath, $m) && strcasecmp($m[1], 'create') !== 0) {
            $denied = $this->assertVolumeAccess(rawurldecode($m[1]), $user, $ownedStacks);
            if ($denied) {
                return $denied;
            }
        }

        // --- Networks list ---
        if ($method === 'GET' && ($dockerPath === '/networks' || $dockerPath === '/networks/')) {
            return $this->listNetworks($user, $ownedStacks);
        }

        // --- Network create ---
        if ($method === 'POST' && $dockerPath === '/networks/create') {
            return $this->createNetwork($user, $rawBody, $forwardHeaders);
        }

        // --- Network by id ---
        if (preg_match('#^/networks/([^/]+)$#', $dockerPath, $m)) {
            $name = rawurldecode($m[1]);
            if (!in_array($name, ['bridge', 'host', 'none'], true)) {
                $denied = $this->assertNetworkAccess($name, $user, $ownedStacks);
                if ($denied) {
                    return $denied;
                }
            } elseif (!Ownership::isAdmin($user) && in_array($method, ['DELETE', 'POST'], true)) {
                return Response::error('Réseau système protégé', 403);
            }
        }

        // --- Images list: shared read; no filter (usable by all). Delete still checked below. ---
        if (preg_match('#^/images/([^/]+)$#', $dockerPath, $m) && $method === 'DELETE') {
            $denied = $this->assertImageDelete($m[1], $user);
            if ($denied) {
                return $denied;
            }
        }

        // --- Build: stamp owner labels ---
        if ($method === 'POST' && ($dockerPath === '/build' || str_starts_with($dockerPath, '/build?'))) {
            $labels = Ownership::labelsFor($user);
            $query['labels'] = json_encode($labels, JSON_UNESCAPED_SLASHES) ?: '{}';
        }

        // --- Prune: admin only ---
        if (!Ownership::isAdmin($user) && $method === 'POST' && preg_match('#/(containers|images|networks|volumes|build)/prune#', $dockerPath)) {
            return Response::error('Le nettoyage global est réservé aux administrateurs', 403);
        }

        return $this->forward($method, $dockerPath, $rawBody, $forwardHeaders, $query);
    }

    /** @param array{id:int,username:string,role:int} $user @param list<string> $ownedStacks */
    private function listContainers(array $user, array $query, array $ownedStacks): Response
    {
        if (Ownership::isAdmin($user)) {
            return $this->forward('GET', '/containers/json', null, [], $query);
        }
        // Fetch all then filter (compose project OR owner label). Docker label filter alone misses compose stacks.
        $query['all'] = $query['all'] ?? 'true';
        $res = $this->docker->request('GET', '/containers/json', null, [], $query);
        if ($res['status'] >= 400) {
            return new Response($res['status'], $res['body'], ['Content-Type' => 'application/json']);
        }
        $list = json_decode($res['body'], true);
        if (!is_array($list)) {
            return Response::json([]);
        }
        $filtered = array_values(array_filter($list, function ($c) use ($user, $ownedStacks) {
            $labels = is_array($c['Labels'] ?? null) ? $c['Labels'] : [];
            return Ownership::ownsDockerResource($labels, $user, $ownedStacks);
        }));
        return Response::json($filtered);
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function createContainer(array $user, ?string $rawBody, array $headers, array $query): Response
    {
        $body = json_decode((string) $rawBody, true);
        if (!is_array($body)) {
            $body = [];
        }
        [$body] = ContainerPolicy::sanitizeCreate($body, Ownership::isAdmin($user));
        $body['Labels'] = Ownership::mergeLabels(
            isset($body['Labels']) && is_array($body['Labels']) ? $body['Labels'] : [],
            $user,
        );
        $body = self::normalizeDockerCreateMaps($body);
        return $this->forward(
            'POST',
            '/containers/create',
            json_encode($body, JSON_UNESCAPED_SLASHES) ?: '{}',
            array_merge($headers, ['Content-Type' => 'application/json']),
            $query,
        );
    }

    /**
     * json_decode(…, true) turns JSON {} into []. Docker HostConfig.PortBindings
     * and ExposedPorts must be objects (maps), never arrays.
     *
     * @param array<string, mixed> $body
     * @return array<string, mixed>
     */
    private static function normalizeDockerCreateMaps(array $body): array
    {
        if (isset($body['ExposedPorts'])) {
            if (!is_array($body['ExposedPorts']) || $body['ExposedPorts'] === []) {
                unset($body['ExposedPorts']);
            } else {
                foreach ($body['ExposedPorts'] as $port => $spec) {
                    if ($spec === [] || $spec === null || !is_array($spec)) {
                        $body['ExposedPorts'][$port] = new \stdClass();
                    }
                }
            }
        }

        if (isset($body['HostConfig']) && is_array($body['HostConfig'])) {
            $hc = &$body['HostConfig'];
            if (isset($hc['PortBindings'])) {
                if (!is_array($hc['PortBindings']) || $hc['PortBindings'] === [] || array_is_list($hc['PortBindings'])) {
                    unset($hc['PortBindings']);
                } else {
                    // json_decode(true) turns each binding {} into [] → Docker rejects as PortBinding
                    foreach ($hc['PortBindings'] as $port => $bindings) {
                        if (!is_array($bindings)) {
                            unset($hc['PortBindings'][$port]);
                            continue;
                        }
                        $fixed = [];
                        foreach ($bindings as $b) {
                            if ($b === null || $b === [] || (is_array($b) && $b === [])) {
                                $fixed[] = new \stdClass();
                                continue;
                            }
                            if (!is_array($b)) {
                                continue;
                            }
                            // Skip nested empty-array junk ([[]])
                            if (array_is_list($b) && $b !== [] && !self::isAssocPortBinding($b)) {
                                $fixed[] = new \stdClass();
                                continue;
                            }
                            $obj = new \stdClass();
                            foreach ($b as $k => $v) {
                                if (!is_int($k) && !is_string($k)) {
                                    continue;
                                }
                                if (is_string($k)) {
                                    $obj->{$k} = $v;
                                }
                            }
                            $fixed[] = $obj;
                        }
                        if ($fixed === []) {
                            unset($hc['PortBindings'][$port]);
                        } else {
                            $hc['PortBindings'][$port] = $fixed;
                        }
                    }
                    if ($hc['PortBindings'] === []) {
                        unset($hc['PortBindings']);
                    }
                }
            }
            // RestartPolicy Name-only maps are fine; empty Volumes/etc. maps → drop
            foreach (['StorageOpt', 'Sysctls', 'Tmpfs'] as $mapKey) {
                if (isset($hc[$mapKey]) && is_array($hc[$mapKey]) && $hc[$mapKey] === []) {
                    unset($hc[$mapKey]);
                }
            }
            unset($hc);
        }

        return $body;
    }

    /** @param array<mixed> $b */
    private static function isAssocPortBinding(array $b): bool
    {
        foreach (array_keys($b) as $k) {
            if (is_string($k)) {
                return true;
            }
        }
        return false;
    }

    /** @param array{id:int,username:string,role:int} $user @param list<string> $ownedStacks */
    private function assertContainerAccess(string $id, array $user, array $ownedStacks, string $method): ?Response
    {
        if (Ownership::isAdmin($user)) {
            return null;
        }
        try {
            $info = $this->docker->json('GET', '/containers/' . rawurlencode($id) . '/json');
        } catch (\Throwable) {
            return Response::error('Conteneur introuvable', 404);
        }
        $labels = $info['Config']['Labels'] ?? $info['Labels'] ?? [];
        if (!is_array($labels)) {
            $labels = [];
        }
        if (!Ownership::ownsDockerResource($labels, $user, $ownedStacks)) {
            return Response::error('Accès refusé à ce conteneur', 403);
        }
        return null;
    }

    /** @param array{id:int,username:string,role:int} $user @param list<string> $ownedStacks */
    private function listVolumes(array $user, array $ownedStacks): Response
    {
        $res = $this->docker->request('GET', '/volumes');
        if ($res['status'] >= 400) {
            return new Response($res['status'], $res['body'], ['Content-Type' => 'application/json']);
        }
        if (Ownership::isAdmin($user)) {
            return new Response($res['status'], $res['body'], ['Content-Type' => 'application/json']);
        }
        $data = json_decode($res['body'], true);
        if (!is_array($data)) {
            return Response::json(['Volumes' => [], 'Warnings' => null]);
        }
        $vols = $data['Volumes'] ?? [];
        if (!is_array($vols)) {
            $vols = [];
        }
        $data['Volumes'] = array_values(array_filter($vols, function ($v) use ($user, $ownedStacks) {
            $labels = is_array($v['Labels'] ?? null) ? $v['Labels'] : [];
            return Ownership::ownsDockerResource($labels, $user, $ownedStacks);
        }));
        return Response::json($data);
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function createVolume(array $user, ?string $rawBody, array $headers): Response
    {
        $body = json_decode((string) $rawBody, true);
        if (!is_array($body)) {
            $body = [];
        }
        $body['Labels'] = Ownership::mergeLabels(
            isset($body['Labels']) && is_array($body['Labels']) ? $body['Labels'] : [],
            $user,
        );
        return $this->forward(
            'POST',
            '/volumes/create',
            json_encode($body, JSON_UNESCAPED_SLASHES) ?: '{}',
            array_merge($headers, ['Content-Type' => 'application/json']),
            [],
        );
    }

    /** @param array{id:int,username:string,role:int} $user @param list<string> $ownedStacks */
    private function assertVolumeAccess(string $name, array $user, array $ownedStacks): ?Response
    {
        if (Ownership::isAdmin($user)) {
            return null;
        }
        try {
            $info = $this->docker->json('GET', '/volumes/' . rawurlencode($name));
        } catch (\Throwable) {
            return Response::error('Volume introuvable', 404);
        }
        $labels = $info['Labels'] ?? [];
        if (!is_array($labels)) {
            $labels = [];
        }
        if (!Ownership::ownsDockerResource($labels, $user, $ownedStacks)) {
            return Response::error('Accès refusé à ce volume', 403);
        }
        return null;
    }

    /** @param array{id:int,username:string,role:int} $user @param list<string> $ownedStacks */
    private function listNetworks(array $user, array $ownedStacks): Response
    {
        $res = $this->docker->request('GET', '/networks');
        if ($res['status'] >= 400) {
            return new Response($res['status'], $res['body'], ['Content-Type' => 'application/json']);
        }
        if (Ownership::isAdmin($user)) {
            return new Response($res['status'], $res['body'], ['Content-Type' => 'application/json']);
        }
        $list = json_decode($res['body'], true);
        if (!is_array($list)) {
            return Response::json([]);
        }
        $filtered = array_values(array_filter($list, function ($n) use ($user, $ownedStacks) {
            $name = (string) ($n['Name'] ?? '');
            // Always show predefined networks (read-only usage)
            if (in_array($name, ['bridge', 'host', 'none'], true)) {
                return true;
            }
            $labels = is_array($n['Labels'] ?? null) ? $n['Labels'] : [];
            return Ownership::ownsDockerResource($labels, $user, $ownedStacks);
        }));
        return Response::json($filtered);
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function createNetwork(array $user, ?string $rawBody, array $headers): Response
    {
        $body = json_decode((string) $rawBody, true);
        if (!is_array($body)) {
            $body = [];
        }
        $body['Labels'] = Ownership::mergeLabels(
            isset($body['Labels']) && is_array($body['Labels']) ? $body['Labels'] : [],
            $user,
        );
        return $this->forward(
            'POST',
            '/networks/create',
            json_encode($body, JSON_UNESCAPED_SLASHES) ?: '{}',
            array_merge($headers, ['Content-Type' => 'application/json']),
            [],
        );
    }

    /** @param array{id:int,username:string,role:int} $user @param list<string> $ownedStacks */
    private function assertNetworkAccess(string $idOrName, array $user, array $ownedStacks): ?Response
    {
        if (Ownership::isAdmin($user)) {
            return null;
        }
        try {
            $info = $this->docker->json('GET', '/networks/' . rawurlencode($idOrName));
        } catch (\Throwable) {
            return Response::error('Réseau introuvable', 404);
        }
        $labels = $info['Labels'] ?? [];
        if (!is_array($labels)) {
            $labels = [];
        }
        if (!Ownership::ownsDockerResource($labels, $user, $ownedStacks)) {
            return Response::error('Accès refusé à ce réseau', 403);
        }
        return null;
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function assertImageDelete(string $ref, array $user): ?Response
    {
        if (Ownership::isAdmin($user)) {
            return null;
        }
        try {
            $info = $this->docker->json('GET', '/images/' . rawurlencode($ref) . '/json');
        } catch (\Throwable) {
            return Response::error('Image introuvable', 404);
        }
        $labels = $info['Config']['Labels'] ?? $info['Labels'] ?? [];
        if (!is_array($labels)) {
            $labels = [];
        }
        if (!Ownership::ownsLabels($labels, $user)) {
            return Response::error('Vous ne pouvez supprimer que vos propres images (labelisées)', 403);
        }
        return null;
    }

    /**
     * @param array{id:int,username:string,role:int} $user
     * @return list<string>
     */
    private function ownedStackNames(array $user): array
    {
        $names = [];
        foreach ($this->repo->listStacks() as $stack) {
            if (strcasecmp((string) ($stack['created_by'] ?? ''), Ownership::username($user)) === 0) {
                $names[] = (string) $stack['name'];
            }
        }
        return $names;
    }

    /**
     * Public helper for volume browser / logs / exec routes.
     * @param array{id:int,username:string,role:int} $user
     */
    public function canAccessContainer(string $id, array $user): bool
    {
        return $this->assertContainerAccess($id, $user, $this->ownedStackNames($user), 'GET') === null;
    }

    /**
     * @param array{id:int,username:string,role:int} $user
     */
    public function canAccessVolume(string $name, array $user): bool
    {
        return $this->assertVolumeAccess($name, $user, $this->ownedStackNames($user)) === null;
    }

    /**
     * @param array<string, string> $headers
     * @param array<string, mixed> $query
     */
    private function forward(
        string $method,
        string $path,
        ?string $body,
        array $headers,
        array $query,
    ): Response {
        try {
            $result = $this->docker->request($method, $path, $body, $headers, $query);
        } catch (\Throwable $e) {
            return Response::error($e->getMessage(), 502);
        }
        $outHeaders = [];
        foreach (['Content-Type', 'Content-Length', 'Docker-Experimental', 'Ostype', 'Server', 'Api-Version'] as $h) {
            foreach ($result['headers'] as $name => $value) {
                if (strcasecmp($name, $h) === 0) {
                    $outHeaders[$name] = $value;
                }
            }
        }
        if (!isset($outHeaders['Content-Type'])) {
            $outHeaders['Content-Type'] = 'application/json';
        }
        return new Response($result['status'], $result['body'], $outHeaders);
    }
}
