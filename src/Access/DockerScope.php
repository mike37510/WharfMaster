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
        private readonly int $endpointId = 0,
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
        string $endpointRole = EndpointAcl::OPERATE,
    ): Response {
        $dockerPath = $dockerPath === '' ? '/' : $dockerPath;
        $method = strtoupper($method);

        if ($endpointRole === EndpointAcl::READ && !in_array($method, ['GET', 'HEAD'], true)) {
            return Response::error('Accès lecture seule sur ce nœud', 403);
        }

        if ($deny = DockerApiPolicy::denyAlways($method, $dockerPath)) {
            return Response::error($deny, 403);
        }
        if (!Ownership::isAdmin($user) && ($deny = DockerApiPolicy::denyNonAdmin($method, $dockerPath))) {
            return Response::error($deny, 403);
        }

        $ownedStacks = Ownership::isAdmin($user)
            ? []
            : $this->accessibleStackNames($user);
        $sharedKeys = Ownership::isAdmin($user)
            ? ['container' => [], 'volume' => [], 'network' => []]
            : $this->sharedDockerKeys($user);

        // --- List containers ---
        if ($method === 'GET' && ($dockerPath === '/containers/json' || str_starts_with($dockerPath, '/containers/json?'))) {
            return $this->listContainers($user, $query, $ownedStacks, $sharedKeys['container']);
        }

        // --- Create container ---
        if ($method === 'POST' && ($dockerPath === '/containers/create' || str_starts_with($dockerPath, '/containers/create?'))) {
            return $this->createContainer($user, $rawBody, $forwardHeaders, $query);
        }

        // --- Container by id (inspect / start / stop / logs proxy / etc.) ---
        if (preg_match('#^/containers/([^/]+)(/.*)?$#', $dockerPath, $m)) {
            $denied = $this->assertContainerAccess($m[1], $user, $ownedStacks, $sharedKeys['container'], $method);
            if ($denied) {
                return $denied;
            }
        }

        // --- Volumes list ---
        if ($method === 'GET' && ($dockerPath === '/volumes' || $dockerPath === '/volumes/')) {
            return $this->listVolumes($user, $ownedStacks, $sharedKeys['volume']);
        }

        // --- Volume create ---
        if ($method === 'POST' && ($dockerPath === '/volumes/create' || str_starts_with($dockerPath, '/volumes/create?'))) {
            return $this->createVolume($user, $rawBody, $forwardHeaders);
        }

        // --- Volume by name (never treat "create" as a volume name) ---
        if (preg_match('#^/volumes/([^/]+)$#', $dockerPath, $m) && strcasecmp($m[1], 'create') !== 0) {
            $denied = $this->assertVolumeAccess(rawurldecode($m[1]), $user, $ownedStacks, $sharedKeys['volume']);
            if ($denied) {
                return $denied;
            }
        }

        // --- Networks list ---
        if ($method === 'GET' && ($dockerPath === '/networks' || $dockerPath === '/networks/')) {
            return $this->listNetworks($user, $ownedStacks, $sharedKeys['network']);
        }

        // --- Network create ---
        if ($method === 'POST' && $dockerPath === '/networks/create') {
            return $this->createNetwork($user, $rawBody, $forwardHeaders);
        }

        // --- Network by id ---
        if (preg_match('#^/networks/([^/]+)$#', $dockerPath, $m)) {
            $name = rawurldecode($m[1]);
            if (!in_array($name, ['bridge', 'host', 'none'], true)) {
                $denied = $this->assertNetworkAccess($name, $user, $ownedStacks, $sharedKeys['network']);
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

    /**
     * @param array{id:int,username:string,role:int} $user
     * @param list<string> $ownedStacks
     * @param list<string> $sharedKeys
     */
    private function listContainers(array $user, array $query, array $ownedStacks, array $sharedKeys): Response
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
        $filtered = array_values(array_filter($list, function ($c) use ($user, $ownedStacks, $sharedKeys) {
            $labels = is_array($c['Labels'] ?? null) ? $c['Labels'] : [];
            if (Ownership::ownsDockerResource($labels, $user, $ownedStacks)) {
                return true;
            }
            $names = is_array($c['Names'] ?? null) ? $c['Names'] : [];
            $id = (string) ($c['Id'] ?? '');
            return $this->matchesSharedKey($sharedKeys, $id, $names);
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
                    // Empty {} / [] bindings = publish on random host port — drop them.
                    // Internal-only ports must use ExposedPorts without PortBindings.
                    foreach ($hc['PortBindings'] as $port => $bindings) {
                        if (!is_array($bindings)) {
                            unset($hc['PortBindings'][$port]);
                            continue;
                        }
                        $fixed = [];
                        foreach ($bindings as $b) {
                            if (!is_array($b) || $b === [] || !self::isAssocPortBinding($b)) {
                                continue;
                            }
                            // Binding sans HostPort (objet vide) = publication aléatoire implicite → drop
                            // HostPort "0" explicite (saisie 0:80) = dynamique volontaire → garder
                            if (!array_key_exists('HostPort', $b) && !array_key_exists('HostIp', $b)) {
                                continue;
                            }
                            $obj = new \stdClass();
                            foreach ($b as $k => $v) {
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
            // Never publish all image EXPOSE ports by accident
            if (!array_key_exists('PublishAllPorts', $hc)) {
                $hc['PublishAllPorts'] = false;
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

    /**
     * @param array{id:int,username:string,role:int} $user
     * @param list<string> $ownedStacks
     * @param list<string> $sharedKeys
     */
    private function assertContainerAccess(string $id, array $user, array $ownedStacks, array $sharedKeys, string $method): ?Response
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
        if (Ownership::ownsDockerResource($labels, $user, $ownedStacks)) {
            return null;
        }
        $names = [];
        if (!empty($info['Name'])) {
            $names[] = (string) $info['Name'];
        }
        $fullId = (string) ($info['Id'] ?? $id);
        if ($this->matchesSharedKey($sharedKeys, $fullId, $names) || $this->matchesSharedKey($sharedKeys, $id, $names)) {
            return null;
        }
        return Response::error('Accès refusé à ce conteneur', 403);
    }

    /**
     * @param array{id:int,username:string,role:int} $user
     * @param list<string> $ownedStacks
     * @param list<string> $sharedKeys
     */
    private function listVolumes(array $user, array $ownedStacks, array $sharedKeys): Response
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
        // Non-admin : ownership / partage uniquement (pas de découverte auto depuis les Mounts)
        $data['Volumes'] = array_values(array_filter($vols, function ($v) use ($user, $ownedStacks, $sharedKeys) {
            $labels = is_array($v['Labels'] ?? null) ? $v['Labels'] : [];
            if (Ownership::ownsDockerResource($labels, $user, $ownedStacks)) {
                return true;
            }
            $name = (string) ($v['Name'] ?? '');
            return $this->matchesSharedKey($sharedKeys, $name, [$name]);
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

    /**
     * @param array{id:int,username:string,role:int} $user
     * @param list<string> $ownedStacks
     * @param list<string> $sharedKeys
     */
    private function assertVolumeAccess(string $name, array $user, array $ownedStacks, array $sharedKeys): ?Response
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
        if (Ownership::ownsDockerResource($labels, $user, $ownedStacks)) {
            return null;
        }
        if ($this->matchesSharedKey($sharedKeys, $name, [$name])) {
            return null;
        }
        return Response::error('Accès refusé à ce volume', 403);
    }

    /**
     * @param array{id:int,username:string,role:int} $user
     * @param list<string> $ownedStacks
     * @param list<string> $sharedKeys
     */
    private function listNetworks(array $user, array $ownedStacks, array $sharedKeys): Response
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
        $filtered = array_values(array_filter($list, function ($n) use ($user, $ownedStacks, $sharedKeys) {
            $name = (string) ($n['Name'] ?? '');
            // Always show predefined networks (read-only usage)
            if (in_array($name, ['bridge', 'host', 'none'], true)) {
                return true;
            }
            $labels = is_array($n['Labels'] ?? null) ? $n['Labels'] : [];
            if (Ownership::ownsDockerResource($labels, $user, $ownedStacks)) {
                return true;
            }
            $id = (string) ($n['Id'] ?? '');
            return $this->matchesSharedKey($sharedKeys, $id, [$name]);
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

    /**
     * @param array{id:int,username:string,role:int} $user
     * @param list<string> $ownedStacks
     * @param list<string> $sharedKeys
     */
    private function assertNetworkAccess(string $idOrName, array $user, array $ownedStacks, array $sharedKeys): ?Response
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
        if (Ownership::ownsDockerResource($labels, $user, $ownedStacks)) {
            return null;
        }
        $name = (string) ($info['Name'] ?? $idOrName);
        $id = (string) ($info['Id'] ?? $idOrName);
        if ($this->matchesSharedKey($sharedKeys, $id, [$name, $idOrName])) {
            return null;
        }
        return Response::error('Accès refusé à ce réseau', 403);
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
     * Owned + shared stacks (compose project names) for this endpoint.
     *
     * @param array{id:int,username:string,role:int} $user
     * @return list<string>
     */
    private function accessibleStackNames(array $user): array
    {
        $rows = $this->repo->listStacksForUser(
            Ownership::username($user),
            false,
            $this->endpointId > 0 ? $this->endpointId : null,
            Ownership::userId($user),
        );
        $names = [];
        foreach ($rows as $stack) {
            $n = (string) ($stack['name'] ?? '');
            if ($n !== '') {
                $names[] = $n;
            }
        }
        return $names;
    }

    /**
     * @param array{id:int,username:string,role:int} $user
     * @return array{container:list<string>,volume:list<string>,network:list<string>}
     */
    private function sharedDockerKeys(array $user): array
    {
        $uid = Ownership::userId($user);
        $eid = $this->endpointId > 0 ? $this->endpointId : null;
        return [
            'container' => $this->repo->listSharedResourceKeys($uid, 'container', $eid),
            'volume' => $this->repo->listSharedResourceKeys($uid, 'volume', $eid),
            'network' => $this->repo->listSharedResourceKeys($uid, 'network', $eid),
        ];
    }

    /**
     * @param list<string> $sharedKeys
     * @param list<string> $names
     */
    private function matchesSharedKey(array $sharedKeys, string $id, array $names = []): bool
    {
        if ($sharedKeys === []) {
            return false;
        }
        $candidates = [];
        if ($id !== '') {
            $candidates[] = $id;
            if (strlen($id) > 12) {
                $candidates[] = substr($id, 0, 12);
            }
        }
        foreach ($names as $n) {
            $n = ltrim((string) $n, '/');
            if ($n !== '') {
                $candidates[] = $n;
            }
        }
        foreach ($sharedKeys as $key) {
            $key = ltrim((string) $key, '/');
            if ($key === '') {
                continue;
            }
            foreach ($candidates as $c) {
                if (strcasecmp($c, $key) === 0) {
                    return true;
                }
                if (strlen($key) >= 12 && str_starts_with(strtolower($c), strtolower($key))) {
                    return true;
                }
                if (strlen($c) >= 12 && str_starts_with(strtolower($key), strtolower($c))) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Public helper for volume browser / logs / exec routes.
     * @param array{id:int,username:string,role:int} $user
     */
    public function canAccessContainer(string $id, array $user): bool
    {
        $keys = $this->sharedDockerKeys($user)['container'];
        return $this->assertContainerAccess($id, $user, $this->accessibleStackNames($user), $keys, 'GET') === null;
    }

    /**
     * @param array{id:int,username:string,role:int} $user
     */
    public function canAccessVolume(string $name, array $user): bool
    {
        $keys = $this->sharedDockerKeys($user)['volume'];
        return $this->assertVolumeAccess($name, $user, $this->accessibleStackNames($user), $keys) === null;
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
