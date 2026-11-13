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
                        (string) ($row['ImageName'] ?? $row['Image'] ?? ''),
                        (string) ($row['LocalVersion'] ?? ''),
                        (string) ($row['RemoteVersion'] ?? ''),
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
                    'ImageName' => $image,
                    'Detail' => $image === '' ? 'Image absente' : 'Référence par digest local (tag indisponible)',
                    'LocalDigest' => str_starts_with($image, 'sha256:') ? strtolower($image) : null,
                    'RemoteDigest' => null,
                    'LocalVersion' => '',
                    'RemoteVersion' => '',
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
                'ImageName' => (string) ($item['ImageName'] ?? $image),
                'Detail' => (string) ($item['Detail'] ?? ''),
                'LocalDigest' => $item['LocalDigest'] ?? null,
                'RemoteDigest' => $item['RemoteDigest'] ?? null,
                'LocalVersion' => (string) ($item['LocalVersion'] ?? ''),
                'RemoteVersion' => (string) ($item['RemoteVersion'] ?? ''),
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
     * @return array{
     *   Service:string,Image:string,Status:string,LocalDigest:?string,RemoteDigest:?string,
     *   LocalVersion:string,RemoteVersion:string,ImageName:string,Detail:string
     * }
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
            return $this->item($service, $image, 'unknown', null, null, '', '', 'Référence image invalide');
        }
        $imageName = $this->imageDisplayName($parsed);
        if ($parsed['digest'] !== null) {
            return $this->item(
                $service,
                $image,
                'pinned',
                $parsed['digest'],
                $parsed['digest'],
                $parsed['tag'] !== 'latest' ? $parsed['tag'] : '',
                $parsed['tag'] !== 'latest' ? $parsed['tag'] : '',
            );
        }

        $localInfo = $this->localImageInfo($docker, $image, $parsed);
        $local = $localInfo['digest'];
        $localVersionRaw = $localInfo['version'];
        $localCreated = $localInfo['created'];
        if ($local === null) {
            $localVersion = ManifestClient::versionWithDate($localVersionRaw, $localCreated);
            return $this->item($service, $image, 'unknown', null, null, $localVersion, '', 'Image absente localement (pull requis)');
        }

        // Keep previous definitive result (fresh / update) while local digest unchanged
        if (!$forceRefresh) {
            $cachedStatus = $this->readImageStatusCache($image, $local);
            if ($cachedStatus !== null) {
                $cachedStatus['Service'] = $service;
                $cachedStatus['Detail'] = $this->detailFor(
                    (string) $cachedStatus['Status'],
                    (string) ($cachedStatus['ImageName'] ?? $imageName),
                    (string) ($cachedStatus['LocalVersion'] ?? ''),
                    (string) ($cachedStatus['RemoteVersion'] ?? ''),
                );
                return $cachedStatus;
            }
        }

        $creds = $this->matchRegistry($parsed, $registries);
        $cacheKey = strtolower($parsed['host'] . '/' . $parsed['repository'] . ':' . $parsed['tag']);
        $remoteMeta = $this->cachedRemoteMeta($cacheKey, function () use ($image, $creds): array {
            return $this->manifests->remoteMeta($image, $creds, true);
        }, $forceRefresh);
        $remote = $remoteMeta['digest'] ?? null;
        $remoteVersionRaw = (string) ($remoteMeta['version'] ?? '');
        $remoteCreated = (string) ($remoteMeta['created'] ?? '');
        if ($remoteVersionRaw === '' && ($parsed['tag'] ?? '') !== '' && strtolower((string) $parsed['tag']) !== 'latest') {
            $remoteVersionRaw = (string) $parsed['tag'];
        }
        $localVersion = ManifestClient::versionWithDate($localVersionRaw, $localCreated);
        $remoteVersion = ManifestClient::versionWithDate($remoteVersionRaw, $remoteCreated);
        if ($remote === null) {
            return $this->item($service, $image, 'unknown', $local, null, $localVersion, '', 'Impossible de joindre le registre');
        }

        $status = hash_equals($local, $remote) ? 'fresh' : 'update';
        // Floating tag (same label both sides) → ensure proposed still shows a distinct build date
        if ($status === 'update') {
            if ($remoteVersion === '' && $localVersion !== '') {
                $remoteVersion = 'nouveau build';
            } elseif ($remoteVersion !== '' && $remoteVersion === $localVersion) {
                $remoteVersion = ManifestClient::versionWithDate(
                    $remoteVersionRaw !== '' ? $remoteVersionRaw : (string) ($parsed['tag'] ?? 'latest'),
                    $remoteCreated !== '' ? $remoteCreated : null,
                );
                if ($remoteVersion === $localVersion || $remoteCreated === '') {
                    $remoteVersion = ($remoteVersionRaw !== '' ? $remoteVersionRaw : 'build') . ' (nouveau)';
                }
            }
        }
        $item = $this->item($service, $image, $status, $local, $remote, $localVersion, $remoteVersion);
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
        $item = is_array($data['item']) ? $data['item'] : [];
        $imageName = (string) ($item['ImageName'] ?? '');
        if ($imageName === '') {
            $p = ManifestClient::parse((string) ($item['Image'] ?? $image));
            $imageName = $p ? $this->imageDisplayName($p) : (string) ($item['Image'] ?? $image);
        }
        return [
            'Service' => (string) ($item['Service'] ?? ''),
            'Image' => (string) ($item['Image'] ?? $image),
            'ImageName' => $imageName,
            'Status' => $status,
            'LocalDigest' => $item['LocalDigest'] ?? $localDigest,
            'RemoteDigest' => $item['RemoteDigest'] ?? null,
            'LocalVersion' => (string) ($item['LocalVersion'] ?? ''),
            'RemoteVersion' => (string) ($item['RemoteVersion'] ?? ''),
            'Detail' => (string) ($item['Detail'] ?? ''),
        ];
    }

    /**
     * @param array<string, mixed> $item
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
                'Service' => $item['Service'] ?? '',
                'Image' => $item['Image'] ?? $image,
                'ImageName' => $item['ImageName'] ?? '',
                'Status' => $item['Status'] ?? '',
                'LocalDigest' => $item['LocalDigest'] ?? null,
                'RemoteDigest' => $item['RemoteDigest'] ?? null,
                'LocalVersion' => $item['LocalVersion'] ?? '',
                'RemoteVersion' => $item['RemoteVersion'] ?? '',
                'Detail' => $item['Detail'] ?? '',
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
     * @return array{digest:?string,version:string,created:string}
     */
    private function localImageInfo(DockerClient $docker, string $image, array $parsed): array
    {
        try {
            $info = $docker->json('GET', '/images/' . rawurlencode($image) . '/json');
        } catch (\Throwable) {
            return ['digest' => null, 'version' => '', 'created' => ''];
        }
        $labels = $info['Config']['Labels'] ?? $info['ContainerConfig']['Labels'] ?? null;
        if (!is_array($labels)) {
            $labels = null;
        }
        $version = ManifestClient::versionFromLabels($labels, (string) ($parsed['tag'] ?? ''));
        $created = trim((string) ($info['Created'] ?? ''));
        $digest = null;
        $repoDigests = $info['RepoDigests'] ?? [];
        if (is_array($repoDigests)) {
            $wantRepo = $parsed['repository'];
            $hub = ManifestClient::isDockerHub($parsed['host']);
            foreach ($repoDigests as $rd) {
                if (!is_string($rd) || !str_contains($rd, '@')) {
                    continue;
                }
                [$name, $dig] = explode('@', $rd, 2);
                $dig = strtolower($dig);
                if (!str_starts_with($dig, 'sha256:')) {
                    continue;
                }
                $n = strtolower($name);
                if (str_contains($n, $wantRepo)
                    || ($hub && (str_ends_with($n, '/' . $wantRepo) || $n === 'library/' . basename($wantRepo) || basename($n) === basename($wantRepo)))
                ) {
                    $digest = $dig;
                    break;
                }
            }
            if ($digest === null) {
                foreach ($repoDigests as $rd) {
                    if (is_string($rd) && preg_match('/@(sha256:[a-f0-9]+)$/i', $rd, $m)) {
                        $digest = strtolower($m[1]);
                        break;
                    }
                }
            }
        }
        if ($digest === null) {
            $id = strtolower((string) ($info['Id'] ?? ''));
            $digest = str_starts_with($id, 'sha256:') ? $id : null;
        }
        return ['digest' => $digest, 'version' => $version, 'created' => $created];
    }

    /** @param array{host:string,port:?int,repository:string,tag:string,digest:?string} $parsed */
    private function imageDisplayName(array $parsed): string
    {
        $repo = (string) ($parsed['repository'] ?? '');
        $host = (string) ($parsed['host'] ?? 'docker.io');
        if (ManifestClient::isDockerHub($host)) {
            return str_starts_with($repo, 'library/') ? substr($repo, strlen('library/')) : $repo;
        }
        $port = $parsed['port'] ?? null;
        return $host . ($port ? ':' . $port : '') . '/' . $repo;
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
    /**
     * @param callable():array{digest:?string,version?:string,tag?:string,created?:string} $fetch
     * @return array{digest:?string,version:string,created:string}
     */
    private function cachedRemoteMeta(string $key, callable $fetch, bool $forceRefresh = false): array
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
                    return [
                        'digest' => $positive ? $d : null,
                        'version' => (string) ($data['v'] ?? ''),
                        'created' => (string) ($data['c'] ?? ''),
                    ];
                }
            }
        }
        $meta = $fetch();
        $digest = is_array($meta) ? ($meta['digest'] ?? null) : null;
        $version = is_array($meta) ? (string) ($meta['version'] ?? '') : '';
        $created = is_array($meta) ? (string) ($meta['created'] ?? '') : '';
        if (($digest === null || $digest === '') && !$forceRefresh && is_file($file)) {
            $raw = @file_get_contents($file);
            $prev = is_string($raw) ? json_decode($raw, true) : null;
            $prevD = is_array($prev) ? ($prev['d'] ?? null) : null;
            if (is_string($prevD) && $prevD !== '') {
                return [
                    'digest' => $prevD,
                    'version' => (string) ($prev['v'] ?? $version),
                    'created' => (string) ($prev['c'] ?? $created),
                ];
            }
        }
        @file_put_contents($file, json_encode([
            't' => time(),
            'd' => $digest,
            'v' => $version,
            'c' => $created,
        ], JSON_UNESCAPED_SLASHES));
        return [
            'digest' => is_string($digest) && $digest !== '' ? $digest : null,
            'version' => $version,
            'created' => $created,
        ];
    }

    /**
     * @return array{
     *   Service:string,Image:string,ImageName:string,Status:string,
     *   LocalDigest:?string,RemoteDigest:?string,LocalVersion:string,RemoteVersion:string,Detail:string
     * }
     */
    private function item(
        string $service,
        string $image,
        string $status,
        ?string $local,
        ?string $remote,
        string $localVersion = '',
        string $remoteVersion = '',
        ?string $detail = null,
    ): array {
        $parsed = ManifestClient::parse($image);
        $imageName = $parsed ? $this->imageDisplayName($parsed) : $image;
        return [
            'Service' => $service,
            'Image' => $image,
            'ImageName' => $imageName,
            'Status' => $status,
            'LocalDigest' => $local,
            'RemoteDigest' => $remote,
            'LocalVersion' => $localVersion,
            'RemoteVersion' => $remoteVersion,
            'Detail' => $detail ?? $this->detailFor($status, $imageName, $localVersion, $remoteVersion),
        ];
    }

    /** Human line: nom + versions (pas les digests). */
    private function detailFor(string $status, string $imageName, string $localVersion, string $remoteVersion): string
    {
        $name = trim($imageName) !== '' ? trim($imageName) : 'image';
        $cur = trim($localVersion) !== '' ? trim($localVersion) : '—';
        $next = trim($remoteVersion) !== '' ? trim($remoteVersion) : '—';
        return match ($status) {
            'update' => $name . ' : ' . $cur . ' → ' . $next,
            'fresh' => $name . ' : à jour (' . $cur . ')',
            'pinned' => $name . ' : épinglée (' . $cur . ')',
            default => $name . ' : contrôle incomplet',
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
                (string) ($row['ImageName'] ?? $row['Image'] ?? ''),
                (string) ($row['LocalVersion'] ?? ''),
                (string) ($row['RemoteVersion'] ?? ''),
            );
            $out[] = $row;
        }
        return $out;
    }
}
