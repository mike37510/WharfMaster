<?php
declare(strict_types=1);

namespace App\Stack;

use App\Docker\Client as DockerClient;
use App\Registry\ManifestClient;

/**
 * Compare local image digests vs remote registry digests for Compose stacks.
 *
 * Status:
 * - update  → orange (at least one newer remote image)
 * - fresh   → green (all checkable images match remote)
 * - unknown → grey (could not determine)
 * - pinned  → green (digest-pinned refs)
 */
final class ImageUpdateChecker
{
    /** Stack / image update-status cache TTL (seconds). */
    public const STACK_CACHE_TTL = 86400; // 24 h

    /** Short TTL for failed registry probes (do not lock « unknown » for a full day). */
    public const NEGATIVE_CACHE_TTL = 600; // 10 min

    private ManifestClient $manifests;

    public function __construct(
        private readonly ComposeDeployer $compose,
        private readonly string $cacheDir,
    ) {
        $this->manifests = new ManifestClient();
        if (!is_dir($this->cacheDir)) {
            @mkdir($this->cacheDir, 0755, true);
        }
    }

    /**
     * @param array<string, mixed> $stack DB row (password already opened for registries separately)
     * @param list<array<string, mixed>> $registries
     * @return array{
     *   Status: string,
     *   UpdateCount: int,
     *   Checked: int,
     *   Images: list<array{Service:string,Image:string,Status:string,LocalDigest:?string,RemoteDigest:?string,Detail:string}>,
     *   FromCache: bool,
     *   CheckedAt: int,
     *   ExpiresAt: int
     * }
     */
    public function checkStack(array $stack, DockerClient $docker, array $registries, bool $forceRefresh = false): array
    {
        $fp = $this->stackFingerprint($stack);
        $cacheFile = $this->stackCacheFile((int) ($stack['id'] ?? 0));

        if (!$forceRefresh && is_file($cacheFile)) {
            $raw = @file_get_contents($cacheFile);
            $cached = is_string($raw) ? json_decode($raw, true) : null;
            if (
                is_array($cached)
                && ($cached['fingerprint'] ?? '') === $fp
                && isset($cached['t'], $cached['result'])
                && is_array($cached['result'])
            ) {
                $cachedStatus = (string) ($cached['result']['Status'] ?? 'unknown');
                $ttl = $cachedStatus === 'unknown' ? self::NEGATIVE_CACHE_TTL : self::STACK_CACHE_TTL;
                if ((time() - (int) $cached['t']) < $ttl) {
                    $result = $cached['result'];
                    $result['Images'] = $this->refreshImageDetails(is_array($result['Images'] ?? null) ? $result['Images'] : []);
                    $result['FromCache'] = true;
                    $result['CheckedAt'] = (int) $cached['t'];
                    $result['ExpiresAt'] = (int) $cached['t'] + $ttl;
                    return $result;
                }
            }
        }

        $images = $this->stackImages($stack);
        $results = [];
        $updateCount = 0;
        $checked = 0;
        $fresh = 0;

        foreach ($images as $row) {
            $item = $this->checkImage($row['service'], $row['image'], $docker, $registries, $forceRefresh);
            $results[] = $item;
            if (in_array($item['Status'], ['update', 'fresh', 'pinned'], true)) {
                $checked++;
            }
            if ($item['Status'] === 'update') {
                $updateCount++;
            }
            if ($item['Status'] === 'fresh' || $item['Status'] === 'pinned') {
                $fresh++;
            }
        }

        if ($updateCount > 0) {
            $status = 'update';
        } elseif ($checked > 0 && $fresh === $checked) {
            $status = 'fresh';
        } else {
            $status = 'unknown';
        }

        $now = time();
        $ttl = $status === 'unknown' ? self::NEGATIVE_CACHE_TTL : self::STACK_CACHE_TTL;
        $result = [
            'Status' => $status,
            'UpdateCount' => $updateCount,
            'Checked' => $checked,
            'Images' => $results,
            'FromCache' => false,
            'CheckedAt' => $now,
            'ExpiresAt' => $now + $ttl,
        ];
        // Always persist: fresh/update for 24 h, unknown only briefly (retry soon)
        @file_put_contents($cacheFile, json_encode([
            't' => $now,
            'fingerprint' => $fp,
            'result' => [
                'Status' => $result['Status'],
                'UpdateCount' => $result['UpdateCount'],
                'Checked' => $result['Checked'],
                'Images' => $result['Images'],
            ],
        ], JSON_UNESCAPED_SLASHES));

        return $result;
    }

    /** Drop cached status for a stack (e.g. after deploy / pull). */
    public function invalidateStack(int $stackId): void
    {
        $file = $this->stackCacheFile($stackId);
        if (is_file($file)) {
            @unlink($file);
        }
    }

    /** Drop cached container update batch for a node (after image upgrade / recreate). */
    public function invalidateContainers(int $endpointId): void
    {
        $file = $this->containersCacheFile($endpointId);
        if (is_file($file)) {
            @unlink($file);
        }
    }

    /**
     * Check a single image reference (containers, ad-hoc).
     *
     * @param list<array<string, mixed>> $registries
     * @return array{Service:string,Image:string,Status:string,LocalDigest:?string,RemoteDigest:?string,Detail:string}
     */
    public function checkImageRef(
        string $image,
        DockerClient $docker,
        array $registries,
        bool $forceRefresh = false,
        string $label = 'container',
    ): array {
        return $this->checkImage($label, $image, $docker, $registries, $forceRefresh);
    }

    /**
     * Batch-check container image refs (dedupe by image). Result cached 24 h per node.
     *
     * @param list<array{Id?:string,Names?:list<string>|string,Image?:string,Name?:string}> $containers
     * @param list<array<string, mixed>> $registries
     * @return array{
     *   Updates: array<string, array{Status:string,UpdateCount:int,Checked:int,Image:string,Detail:string,LocalDigest:?string,RemoteDigest:?string}>,
     *   FromCache: bool,
     *   CheckedAt: int,
     *   ExpiresAt: int
     * }
     */
    public function checkContainers(
        array $containers,
        DockerClient $docker,
        array $registries,
        bool $forceRefresh = false,
        int $endpointId = 0,
    ): array {
        $fp = $this->containersFingerprint($containers);
        $cacheFile = $endpointId > 0 ? $this->containersCacheFile($endpointId) : '';

        if (!$forceRefresh && $cacheFile !== '' && is_file($cacheFile)) {
            $raw = @file_get_contents($cacheFile);
            $cached = is_string($raw) ? json_decode($raw, true) : null;
            if (
                is_array($cached)
                && ($cached['fingerprint'] ?? '') === $fp
                && isset($cached['t'], $cached['updates'])
                && is_array($cached['updates'])
                && (time() - (int) $cached['t']) < self::STACK_CACHE_TTL
            ) {
                $t = (int) $cached['t'];
                $updates = is_array($cached['updates']) ? $cached['updates'] : [];
                foreach ($updates as $cid => $row) {
                    if (!is_array($row)) {
                        continue;
                    }
                    $updates[$cid]['Detail'] = $this->detailFor(
                        (string) ($row['Status'] ?? 'unknown'),
                        isset($row['LocalDigest']) && is_string($row['LocalDigest']) ? $row['LocalDigest'] : null,
                        isset($row['RemoteDigest']) && is_string($row['RemoteDigest']) ? $row['RemoteDigest'] : null,
                    );
                }
                return [
                    'Updates' => $updates,
                    'FromCache' => true,
                    'CheckedAt' => $t,
                    'ExpiresAt' => $t + self::STACK_CACHE_TTL,
                ];
            }
        }

        $byImage = [];
        $out = [];
        foreach ($containers as $c) {
            if (!is_array($c)) {
                continue;
            }
            $id = (string) ($c['Id'] ?? '');
            if ($id === '') {
                continue;
            }
            $image = trim((string) ($c['Image'] ?? ''));
            $name = '';
            if (!empty($c['Name']) && is_string($c['Name'])) {
                $name = ltrim($c['Name'], '/');
            } elseif (!empty($c['Names']) && is_array($c['Names']) && isset($c['Names'][0])) {
                $name = ltrim((string) $c['Names'][0], '/');
            } elseif (!empty($c['Names']) && is_string($c['Names'])) {
                $name = ltrim($c['Names'], '/');
            }
            if ($image === '' || str_starts_with($image, 'sha256:')) {
                $out[$id] = [
                    'Status' => 'unknown',
                    'UpdateCount' => 0,
                    'Checked' => 0,
                    'Image' => $image,
                    'Detail' => $image === '' ? 'Image absente' : 'Référence par digest local (tag indisponible)',
                    'LocalDigest' => str_starts_with($image, 'sha256:') ? strtolower($image) : null,
                    'RemoteDigest' => null,
                ];
                continue;
            }
            $key = strtolower($image);
            if (!isset($byImage[$key])) {
                $byImage[$key] = $this->checkImage($name !== '' ? $name : 'container', $image, $docker, $registries, $forceRefresh);
            }
            $item = $byImage[$key];
            $status = (string) ($item['Status'] ?? 'unknown');
            $out[$id] = [
                'Status' => $status,
                'UpdateCount' => $status === 'update' ? 1 : 0,
                'Checked' => in_array($status, ['update', 'fresh', 'pinned'], true) ? 1 : 0,
                'Image' => (string) ($item['Image'] ?? $image),
                'Detail' => (string) ($item['Detail'] ?? ''),
                'LocalDigest' => $item['LocalDigest'] ?? null,
                'RemoteDigest' => $item['RemoteDigest'] ?? null,
            ];
        }

        $now = time();
        if ($cacheFile !== '') {
            @file_put_contents($cacheFile, json_encode([
                't' => $now,
                'fingerprint' => $fp,
                'updates' => $out,
            ], JSON_UNESCAPED_SLASHES));
        }

        return [
            'Updates' => $out,
            'FromCache' => false,
            'CheckedAt' => $now,
            'ExpiresAt' => $now + self::STACK_CACHE_TTL,
        ];
    }

    private function containersCacheFile(int $endpointId): string
    {
        return rtrim($this->cacheDir, '/') . '/containers-ep' . max(0, $endpointId) . '.json';
    }

    /**
     * @param list<array{Id?:string,Image?:string}> $containers
     */
    private function containersFingerprint(array $containers): string
    {
        $parts = [];
        foreach ($containers as $c) {
            if (!is_array($c)) {
                continue;
            }
            $id = (string) ($c['Id'] ?? '');
            if ($id === '') {
                continue;
            }
            $parts[] = $id . '|' . strtolower(trim((string) ($c['Image'] ?? '')));
        }
        sort($parts);
        return hash('sha256', implode("\n", $parts));
    }

    /**
     * Registry credentials matching an image ref (for authenticated pulls).
     *
     * @param list<array<string, mixed>> $registries
     * @return array{url?:string,username?:string,password?:string,type?:string}
     */
    public function registryCredsForImage(string $image, array $registries): array
    {
        $parsed = ManifestClient::parse($image);
        if ($parsed === null) {
            return [];
        }
        return $this->matchRegistry($parsed, $registries);
    }

    private function stackCacheFile(int $stackId): string
    {
        return rtrim($this->cacheDir, '/') . '/stack-' . max(0, $stackId) . '.json';
    }

    /** @param array<string, mixed> $stack */
    private function stackFingerprint(array $stack): string
    {
        $path = rtrim((string) ($stack['project_path'] ?? ''), '/');
        $entry = (string) ($stack['entry_point'] ?? 'docker-compose.yml');
        $file = $path !== '' ? $path . '/' . $entry : '';
        $mtime = ($file !== '' && is_file($file)) ? (string) filemtime($file) : '0';
        return hash('sha256', implode('|', [
            (string) ($stack['id'] ?? 0),
            (string) ($stack['endpoint_id'] ?? 0),
            (string) ($stack['update_date'] ?? 0),
            $mtime,
            (string) ($stack['env_json'] ?? ''),
        ]));
    }

    /**
     * @param array<string, mixed> $stack
     * @return list<array{service:string,image:string}>
     */
    private function stackImages(array $stack): array
    {
        $path = (string) ($stack['project_path'] ?? '');
        $entry = (string) ($stack['entry_point'] ?? 'docker-compose.yml');
        $env = json_decode((string) ($stack['env_json'] ?? '[]'), true);
        if (!is_array($env)) {
            $env = [];
        }
        try {
            $content = $this->compose->readComposeFile($path, $entry);
        } catch (\Throwable) {
            return [];
        }

        $services = [];
        try {
            $resolved = $this->compose->resolveConfig($content, $env, $entry);
            $services = is_array($resolved['services'] ?? null) ? $resolved['services'] : [];
        } catch (\Throwable) {
            // Fallback: naive YAML image: lines
            if (preg_match_all('/^\s*image:\s*["\']?([^\s"\'#]+)/mi', $content, $m)) {
                foreach ($m[1] as $i => $img) {
                    $services['svc' . $i] = ['image' => $img];
                }
            }
        }

        $out = [];
        $seen = [];
        foreach ($services as $name => $svc) {
            if (!is_array($svc)) {
                continue;
            }
            $image = trim((string) ($svc['image'] ?? ''));
            if ($image === '') {
                continue;
            }
            // Skip build-only refs that are clearly local compose artifacts without a registry path? keep them.
            $key = strtolower($image);
            if (isset($seen[$key])) {
                continue;
            }
            $seen[$key] = true;
            $out[] = ['service' => (string) $name, 'image' => $image];
        }
        return $out;
    }

    /**
     * @param list<array<string, mixed>> $registries
     * @return array{Service:string,Image:string,Status:string,LocalDigest:?string,RemoteDigest:?string,Detail:string}
     */
    private function checkImage(
        string $service,
        string $image,
        DockerClient $docker,
        array $registries,
        bool $forceRefresh = false,
    ): array {
        $parsed = ManifestClient::parse($image);
        if ($parsed === null) {
            return $this->item($service, $image, 'unknown', null, null, 'Référence image invalide');
        }
        if ($parsed['digest'] !== null) {
            return $this->item($service, $image, 'pinned', $parsed['digest'], $parsed['digest']);
        }

        $local = $this->localDigest($docker, $image, $parsed);
        if ($local === null) {
            return $this->item($service, $image, 'unknown', null, null, 'Image absente localement (pull requis)');
        }

        // Keep previous definitive result (fresh / update) while local digest unchanged
        if (!$forceRefresh) {
            $cachedStatus = $this->readImageStatusCache($image, $local);
            if ($cachedStatus !== null) {
                $cachedStatus['Service'] = $service;
                // Refresh human Detail (actuel → proposé) even from cache
                $cachedStatus['Detail'] = $this->detailFor(
                    (string) $cachedStatus['Status'],
                    $cachedStatus['LocalDigest'] ?? $local,
                    $cachedStatus['RemoteDigest'] ?? null,
                );
                return $cachedStatus;
            }
        }

        $creds = $this->matchRegistry($parsed, $registries);
        $cacheKey = strtolower($parsed['host'] . '/' . $parsed['repository'] . ':' . $parsed['tag']);
        $remote = $this->cachedRemote($cacheKey, function () use ($image, $creds): ?string {
            return $this->manifests->remoteDigest($image, $creds);
        }, $forceRefresh);
        if ($remote === null) {
            return $this->item($service, $image, 'unknown', $local, null, 'Impossible de joindre le registre');
        }

        $status = hash_equals($local, $remote) ? 'fresh' : 'update';
        $item = $this->item($service, $image, $status, $local, $remote);
        $this->writeImageStatusCache($image, $local, $item);
        return $item;
    }

    /**
     * Cached “à jour / mise à jour” for a given image + local digest (containers + stacks).
     *
     * @return array{Service:string,Image:string,Status:string,LocalDigest:?string,RemoteDigest:?string,Detail:string}|null
     */
    private function readImageStatusCache(string $image, string $localDigest): ?array
    {
        $file = $this->imageStatusCacheFile($image, $localDigest);
        if (!is_file($file)) {
            return null;
        }
        $raw = @file_get_contents($file);
        $data = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($data) || !isset($data['t'], $data['item']) || !is_array($data['item'])) {
            return null;
        }
        if ((time() - (int) $data['t']) >= self::STACK_CACHE_TTL) {
            return null;
        }
        $status = (string) ($data['item']['Status'] ?? '');
        if (!in_array($status, ['fresh', 'update', 'pinned'], true)) {
            return null;
        }
        if (strtolower((string) ($data['local'] ?? '')) !== strtolower($localDigest)) {
            return null;
        }
        return [
            'Service' => (string) ($data['item']['Service'] ?? ''),
            'Image' => (string) ($data['item']['Image'] ?? $image),
            'Status' => $status,
            'LocalDigest' => $data['item']['LocalDigest'] ?? $localDigest,
            'RemoteDigest' => $data['item']['RemoteDigest'] ?? null,
            'Detail' => (string) ($data['item']['Detail'] ?? ''),
        ];
    }

    /**
     * @param array{Service:string,Image:string,Status:string,LocalDigest:?string,RemoteDigest:?string,Detail:string} $item
     */
    private function writeImageStatusCache(string $image, string $localDigest, array $item): void
    {
        $status = (string) ($item['Status'] ?? '');
        if (!in_array($status, ['fresh', 'update', 'pinned'], true)) {
            return;
        }
        $file = $this->imageStatusCacheFile($image, $localDigest);
        @file_put_contents($file, json_encode([
            't' => time(),
            'image' => $image,
            'local' => $localDigest,
            'item' => [
                'Service' => $item['Service'],
                'Image' => $item['Image'],
                'Status' => $item['Status'],
                'LocalDigest' => $item['LocalDigest'],
                'RemoteDigest' => $item['RemoteDigest'],
                'Detail' => $item['Detail'],
            ],
        ], JSON_UNESCAPED_SLASHES));
    }

    private function imageStatusCacheFile(string $image, string $localDigest): string
    {
        $key = strtolower(trim($image)) . '|' . strtolower(trim($localDigest));
        return rtrim($this->cacheDir, '/') . '/status-' . hash('sha256', $key) . '.json';
    }

    /**
     * @param array{host:string,port:?int,repository:string,tag:string,digest:?string} $parsed
     */
    private function localDigest(DockerClient $docker, string $image, array $parsed): ?string
    {
        try {
            $info = $docker->json('GET', '/images/' . rawurlencode($image) . '/json');
        } catch (\Throwable) {
            return null;
        }
        $repoDigests = $info['RepoDigests'] ?? [];
        if (is_array($repoDigests)) {
            $wantRepo = $parsed['repository'];
            $hub = ManifestClient::isDockerHub($parsed['host']);
            foreach ($repoDigests as $rd) {
                if (!is_string($rd) || !str_contains($rd, '@')) {
                    continue;
                }
                [$name, $digest] = explode('@', $rd, 2);
                $digest = strtolower($digest);
                if (!str_starts_with($digest, 'sha256:')) {
                    continue;
                }
                // name may be "nginx" or "docker.io/library/nginx"
                $n = strtolower($name);
                if (str_contains($n, $wantRepo)
                    || ($hub && (str_ends_with($n, '/' . $wantRepo) || $n === 'library/' . basename($wantRepo) || basename($n) === basename($wantRepo)))
                ) {
                    return $digest;
                }
            }
            // Any digest is better than nothing when RepoDigests exist
            foreach ($repoDigests as $rd) {
                if (is_string($rd) && preg_match('/@(sha256:[a-f0-9]+)$/i', $rd, $m)) {
                    return strtolower($m[1]);
                }
            }
        }
        $id = strtolower((string) ($info['Id'] ?? ''));
        return str_starts_with($id, 'sha256:') ? $id : null;
    }

    /**
     * @param array{host:string,port:?int,repository:string,tag:string,digest:?string} $parsed
     * @param list<array<string, mixed>> $registries
     * @return array{url?:string,username?:string,password?:string,type?:string}
     */
    private function matchRegistry(array $parsed, array $registries): array
    {
        $host = strtolower($parsed['host']);
        $port = $parsed['port'];
        foreach ($registries as $reg) {
            $url = trim((string) ($reg['url'] ?? ''));
            if ($url === '') {
                continue;
            }
            $parts = parse_url($url);
            if (!is_array($parts)) {
                continue;
            }
            $rh = strtolower((string) ($parts['host'] ?? ''));
            $rp = isset($parts['port']) ? (int) $parts['port'] : null;
            $type = strtolower((string) ($reg['type'] ?? 'v2'));
            $hubReg = $type === 'hub' || ManifestClient::isDockerHub($rh);
            if ($hubReg && ManifestClient::isDockerHub($host)) {
                return [
                    'url' => 'https://registry-1.docker.io',
                    'username' => (string) ($reg['username'] ?? ''),
                    'password' => (string) ($reg['password'] ?? ''),
                    'type' => 'hub',
                ];
            }
            if ($rh === $host && ($port === null || $rp === null || $port === $rp)) {
                return [
                    'url' => $url,
                    'username' => (string) ($reg['username'] ?? ''),
                    'password' => (string) ($reg['password'] ?? ''),
                    'type' => $type,
                ];
            }
        }
        if (ManifestClient::isDockerHub($host)) {
            return ['url' => 'https://registry-1.docker.io', 'type' => 'hub'];
        }
        $scheme = ($port === 80) ? 'http' : 'https';
        return [
            'url' => $scheme . '://' . $host . ($port ? ':' . $port : ''),
            'type' => 'v2',
        ];
    }

    /**
     * @param callable():?string $fetch
     */
    private function cachedRemote(string $key, callable $fetch, bool $forceRefresh = false): ?string
    {
        $file = rtrim($this->cacheDir, '/') . '/digest-' . hash('sha256', $key) . '.json';
        if (!$forceRefresh && is_file($file)) {
            $raw = @file_get_contents($file);
            $data = is_string($raw) ? json_decode($raw, true) : null;
            if (is_array($data) && isset($data['t'])) {
                $d = $data['d'] ?? null;
                $positive = is_string($d) && $d !== '';
                $ttl = $positive ? self::STACK_CACHE_TTL : self::NEGATIVE_CACHE_TTL;
                if ((time() - (int) $data['t']) < $ttl) {
                    return $positive ? $d : null;
                }
            }
        }
        $digest = $fetch();
        // Keep a previous good digest if the registry briefly fails
        if (($digest === null || $digest === '') && !$forceRefresh && is_file($file)) {
            $raw = @file_get_contents($file);
            $prev = is_string($raw) ? json_decode($raw, true) : null;
            $prevD = is_array($prev) ? ($prev['d'] ?? null) : null;
            if (is_string($prevD) && $prevD !== '') {
                return $prevD;
            }
        }
        @file_put_contents($file, json_encode(['t' => time(), 'd' => $digest], JSON_UNESCAPED_SLASHES));
        return is_string($digest) && $digest !== '' ? $digest : null;
    }

    /**
     * @return array{Service:string,Image:string,Status:string,LocalDigest:?string,RemoteDigest:?string,Detail:string}
     */
    private function item(
        string $service,
        string $image,
        string $status,
        ?string $local,
        ?string $remote,
        ?string $detail = null,
    ): array {
        return [
            'Service' => $service,
            'Image' => $image,
            'Status' => $status,
            'LocalDigest' => $local,
            'RemoteDigest' => $remote,
            'Detail' => $detail ?? $this->detailFor($status, $local, $remote),
        ];
    }

    /** Human line: actuel vs proposé (digest court). */
    private function detailFor(string $status, ?string $local, ?string $remote): string
    {
        $cur = $this->shortDigest($local);
        $next = $this->shortDigest($remote);
        return match ($status) {
            'update' => 'Actuel ' . $cur . ' → proposé ' . $next,
            'fresh' => 'À jour (' . $cur . ')',
            'pinned' => 'Épinglée (' . $cur . ')',
            default => $remote === null && $local !== null
                ? 'Contrôle incomplet (local ' . $cur . ')'
                : 'État inconnu',
        };
    }

    /**
     * @param list<array<string, mixed>> $images
     * @return list<array<string, mixed>>
     */
    private function refreshImageDetails(array $images): array
    {
        $out = [];
        foreach ($images as $row) {
            if (!is_array($row)) {
                continue;
            }
            $row['Detail'] = $this->detailFor(
                (string) ($row['Status'] ?? 'unknown'),
                isset($row['LocalDigest']) && is_string($row['LocalDigest']) ? $row['LocalDigest'] : null,
                isset($row['RemoteDigest']) && is_string($row['RemoteDigest']) ? $row['RemoteDigest'] : null,
            );
            $out[] = $row;
        }
        return $out;
    }

    private function shortDigest(?string $digest): string
    {
        if ($digest === null || $digest === '') {
            return '—';
        }
        $d = strtolower($digest);
        if (str_starts_with($d, 'sha256:')) {
            return 'sha256:' . substr($d, 7, 12);
        }
        return strlen($d) > 16 ? substr($d, 0, 12) . '…' : $d;
    }
}
