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
    /** Stack update-status cache TTL (seconds). */
    public const STACK_CACHE_TTL = 86400; // 24 h

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
                && (time() - (int) $cached['t']) < self::STACK_CACHE_TTL
            ) {
                $result = $cached['result'];
                $result['FromCache'] = true;
                $result['CheckedAt'] = (int) $cached['t'];
                $result['ExpiresAt'] = (int) $cached['t'] + self::STACK_CACHE_TTL;
                return $result;
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
        $result = [
            'Status' => $status,
            'UpdateCount' => $updateCount,
            'Checked' => $checked,
            'Images' => $results,
            'FromCache' => false,
            'CheckedAt' => $now,
            'ExpiresAt' => $now + self::STACK_CACHE_TTL,
        ];
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
            return $this->item($service, $image, 'pinned', $parsed['digest'], $parsed['digest'], 'Image épinglée par digest');
        }

        $local = $this->localDigest($docker, $image, $parsed);
        if ($local === null) {
            return $this->item($service, $image, 'unknown', null, null, 'Image absente localement (pull requis)');
        }

        $creds = $this->matchRegistry($parsed, $registries);
        $cacheKey = strtolower($parsed['host'] . '/' . $parsed['repository'] . ':' . $parsed['tag']);
        $remote = $this->cachedRemote($cacheKey, function () use ($image, $creds): ?string {
            return $this->manifests->remoteDigest($image, $creds);
        }, $forceRefresh);
        if ($remote === null) {
            return $this->item($service, $image, 'unknown', $local, null, 'Impossible de joindre le registre');
        }

        if (hash_equals($local, $remote)) {
            return $this->item($service, $image, 'fresh', $local, $remote, 'À jour');
        }
        return $this->item($service, $image, 'update', $local, $remote, 'Nouvelle image disponible sur le registre');
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
        $ttl = self::STACK_CACHE_TTL;
        if (!$forceRefresh && is_file($file)) {
            $raw = @file_get_contents($file);
            $data = is_string($raw) ? json_decode($raw, true) : null;
            if (is_array($data) && isset($data['t'], $data['d']) && (time() - (int) $data['t']) < $ttl) {
                $d = $data['d'];
                return is_string($d) && $d !== '' ? $d : null;
            }
        }
        $digest = $fetch();
        @file_put_contents($file, json_encode(['t' => time(), 'd' => $digest], JSON_UNESCAPED_SLASHES));
        return $digest;
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
        string $detail,
    ): array {
        return [
            'Service' => $service,
            'Image' => $image,
            'Status' => $status,
            'LocalDigest' => $local,
            'RemoteDigest' => $remote,
            'Detail' => $detail,
        ];
    }
}
