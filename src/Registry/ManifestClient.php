<?php
declare(strict_types=1);

namespace App\Registry;

/**
 * Resolve a remote image digest (Docker-Content-Digest) for update checks.
 */
final class ManifestClient
{
    private const ACCEPT = 'application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json';

    /**
     * @param array{url?:string,username?:string,password?:string,type?:string} $registryCreds optional matched registry
     */
    public function remoteDigest(string $imageRef, array $registryCreds = []): ?string
    {
        $meta = $this->remoteMeta($imageRef, $registryCreds, false);
        return $meta['digest'] ?? null;
    }

    /**
     * Remote digest + human version (OCI / label-schema) when available.
     *
     * @param array{url?:string,username?:string,password?:string,type?:string} $registryCreds
     * @return array{digest:?string,version:string,tag:string}
     */
    public function remoteMeta(string $imageRef, array $registryCreds = [], bool $withVersion = true): array
    {
        $empty = ['digest' => null, 'version' => '', 'tag' => ''];
        $parsed = self::parse($imageRef);
        if ($parsed === null) {
            return $empty;
        }
        if ($parsed['digest'] !== null) {
            return [
                'digest' => $parsed['digest'],
                'version' => '',
                'tag' => (string) $parsed['tag'],
            ];
        }

        $ctx = $this->registryContext($parsed, $registryCreds);
        if ($ctx === null) {
            return $empty + ['tag' => (string) $parsed['tag']];
        }
        ['base' => $base, 'repo' => $repo, 'tag' => $tag, 'headers' => $headers] = $ctx;

        $manifestUrl = $base . '/v2/' . $repo . '/manifests/' . rawurlencode($tag);
        $res = $this->httpHeadOrGet($manifestUrl, $headers, 8);
        if ($res['status'] === 401) {
            $token = $this->fetchBearer(
                $res['headers'],
                $base,
                trim((string) ($registryCreds['username'] ?? '')),
                (string) ($registryCreds['password'] ?? ''),
                $repo,
            );
            if ($token !== null) {
                $headers = [
                    'Accept: ' . self::ACCEPT,
                    'User-Agent: WharfMaster/2.3.4',
                    'Authorization: Bearer ' . $token,
                ];
                $res = $this->httpHeadOrGet($manifestUrl, $headers, 8);
            }
        }
        if ($res['status'] < 200 || $res['status'] >= 300) {
            return $empty + ['tag' => $tag];
        }
        $digest = strtolower(trim((string) ($res['headers']['docker-content-digest'] ?? '')));
        $manifestBody = $res['body'];
        if ($digest === '' || ($withVersion && $manifestBody === '')) {
            $res = $this->http('GET', $manifestUrl, $headers, 10);
            if ($res['status'] < 200 || $res['status'] >= 300) {
                return $empty + ['tag' => $tag];
            }
            if ($digest === '') {
                $digest = strtolower(trim((string) ($res['headers']['docker-content-digest'] ?? '')));
            }
            $manifestBody = $res['body'];
        }
        if (!str_starts_with($digest, 'sha256:')) {
            $digest = null;
        }

        $version = '';
        if ($withVersion && $manifestBody !== '') {
            $version = $this->versionFromManifestBody($base, $repo, $headers, $manifestBody, $tag);
        }
        if ($version === '' && $tag !== '' && strtolower($tag) !== 'latest') {
            $version = $tag;
        }

        return ['digest' => $digest, 'version' => $version, 'tag' => $tag];
    }

    /**
     * Prefer OCI / label-schema version labels; else non-latest tag.
     *
     * @param array<string, mixed>|null $labels
     */
    public static function versionFromLabels(?array $labels, string $tagFallback = ''): string
    {
        if (is_array($labels)) {
            foreach ([
                'org.opencontainers.image.version',
                'org.label-schema.version',
                'version',
                'VERSION',
                'image.version',
                'app.version',
            ] as $key) {
                $v = trim((string) ($labels[$key] ?? ''));
                if ($v !== '' && strtolower($v) !== 'latest') {
                    return $v;
                }
            }
        }
        $tag = trim($tagFallback);
        if ($tag !== '' && strtolower($tag) !== 'latest') {
            return $tag;
        }
        return '';
    }

    /**
     * @param array{host:string,port:?int,repository:string,tag:string,digest:?string} $parsed
     * @param array{url?:string,username?:string,password?:string,type?:string} $registryCreds
     * @return array{base:string,repo:string,tag:string,headers:list<string>}|null
     */
    private function registryContext(array $parsed, array $registryCreds): ?array
    {
        $scheme = (string) ($registryCreds['scheme'] ?? 'https');
        if (!empty($registryCreds['url'])) {
            $u = parse_url((string) $registryCreds['url']);
            if (is_array($u) && !empty($u['scheme'])) {
                $scheme = (string) $u['scheme'];
            }
        }
        $host = $parsed['host'];
        $port = $parsed['port'];
        $base = $scheme . '://' . $host . ($port ? ':' . $port : '');
        if (self::isDockerHub($host)) {
            $base = 'https://registry-1.docker.io';
        }
        $repo = $parsed['repository'];
        $tag = $parsed['tag'];
        $user = trim((string) ($registryCreds['username'] ?? ''));
        $pass = (string) ($registryCreds['password'] ?? '');
        $headers = [
            'Accept: ' . self::ACCEPT,
            'User-Agent: WharfMaster/2.3.4',
        ];
        if ($user !== '' || $pass !== '') {
            $headers[] = 'Authorization: Basic ' . base64_encode($user . ':' . $pass);
        }
        return ['base' => $base, 'repo' => $repo, 'tag' => $tag, 'headers' => $headers];
    }

    /**
     * @param list<string> $headers
     */
    private function versionFromManifestBody(
        string $base,
        string $repo,
        array $headers,
        string $manifestBody,
        string $tag,
    ): string {
        $manifest = json_decode($manifestBody, true);
        if (!is_array($manifest)) {
            return '';
        }
        // Manifest list / index → pick first amd64/arm64 or first manifest
        if (($manifest['mediaType'] ?? '') === 'application/vnd.docker.distribution.manifest.list.v2+json'
            || ($manifest['mediaType'] ?? '') === 'application/vnd.oci.image.index.v1+json'
            || isset($manifest['manifests'])
        ) {
            $list = is_array($manifest['manifests'] ?? null) ? $manifest['manifests'] : [];
            $pick = null;
            foreach ($list as $m) {
                if (!is_array($m)) {
                    continue;
                }
                $arch = strtolower((string) (($m['platform']['architecture'] ?? '') ?: ''));
                if ($arch === 'amd64' || $arch === 'arm64') {
                    $pick = $m;
                    if ($arch === 'amd64') {
                        break;
                    }
                }
                $pick ??= $m;
            }
            $childDigest = is_array($pick) ? (string) ($pick['digest'] ?? '') : '';
            if ($childDigest === '') {
                return '';
            }
            $childUrl = $base . '/v2/' . $repo . '/manifests/' . rawurlencode($childDigest);
            $child = $this->http('GET', $childUrl, $headers, 10);
            if ($child['status'] < 200 || $child['status'] >= 300) {
                return '';
            }
            $manifest = json_decode($child['body'], true);
            if (!is_array($manifest)) {
                return '';
            }
        }

        $configDigest = (string) ($manifest['config']['digest'] ?? '');
        if ($configDigest === '' || !str_starts_with(strtolower($configDigest), 'sha256:')) {
            return '';
        }
        $blobUrl = $base . '/v2/' . $repo . '/blobs/' . rawurlencode($configDigest);
        $blobHeaders = ['Accept: application/vnd.docker.container.image.v1+json,application/vnd.oci.image.config.v1+json,application/json'];
        foreach ($headers as $h) {
            if (str_starts_with(strtolower($h), 'authorization:') || str_starts_with(strtolower($h), 'user-agent:')) {
                $blobHeaders[] = $h;
            }
        }
        $blob = $this->http('GET', $blobUrl, $blobHeaders, 10);
        if ($blob['status'] < 200 || $blob['status'] >= 300) {
            return '';
        }
        $config = json_decode($blob['body'], true);
        if (!is_array($config)) {
            return '';
        }
        $labels = $config['config']['Labels'] ?? $config['container_config']['Labels'] ?? null;
        if (!is_array($labels)) {
            $labels = null;
        }
        return self::versionFromLabels($labels, $tag);
    }

    /**
     * @return array{host:string,port:?int,repository:string,tag:string,digest:?string}|null
     */
    public static function parse(string $ref): ?array
    {
        $ref = trim($ref);
        if ($ref === '' || str_starts_with($ref, '.') || str_contains($ref, '://')) {
            return null;
        }
        // digest-pinned
        if (preg_match('#^(.+?)@(sha256:[a-f0-9]+)$#i', $ref, $m)) {
            $base = $m[1];
            $digest = strtolower($m[2]);
            $parsed = self::parse($base . ':latest');
            if ($parsed === null) {
                return null;
            }
            $parsed['digest'] = $digest;
            return $parsed;
        }

        $tag = 'latest';
        $name = $ref;
        // tag after last colon if not a port (host:5000/repo)
        if (preg_match('#^(.+):([^:/]+)$#', $ref, $m)) {
            $name = $m[1];
            $tag = $m[2];
        }

        $parts = explode('/', $name);
        $host = 'docker.io';
        $port = null;
        $repoParts = $parts;

        $first = $parts[0] ?? '';
        $looksHost = str_contains($first, '.') || str_contains($first, ':') || $first === 'localhost';
        if ($looksHost && count($parts) >= 2) {
            if (str_contains($first, ':')) {
                [$host, $portStr] = explode(':', $first, 2);
                $port = ctype_digit($portStr) ? (int) $portStr : null;
            } else {
                $host = $first;
            }
            $repoParts = array_slice($parts, 1);
        }

        $repository = implode('/', $repoParts);
        if ($repository === '') {
            return null;
        }
        if (self::isDockerHub($host) && !str_contains($repository, '/')) {
            $repository = 'library/' . $repository;
        }

        return [
            'host' => self::isDockerHub($host) ? 'docker.io' : strtolower($host),
            'port' => $port,
            'repository' => $repository,
            'tag' => $tag,
            'digest' => null,
        ];
    }

    public static function isDockerHub(string $host): bool
    {
        $h = strtolower($host);
        return in_array($h, ['docker.io', 'index.docker.io', 'registry-1.docker.io', 'hub.docker.com'], true);
    }

    /**
     * @param list<string> $headers
     * @return array{status:int, headers:array<string,string>, body:string}
     */
    private function httpHeadOrGet(string $url, array $headers, int $timeout): array
    {
        $res = $this->http('HEAD', $url, $headers, $timeout);
        // Some registries disallow HEAD
        if ($res['status'] === 405 || $res['status'] === 501) {
            return $this->http('GET', $url, $headers, $timeout);
        }
        return $res;
    }

    /**
     * @param list<string> $headers
     * @return array{status:int, headers:array<string,string>, body:string}
     */
    private function http(string $method, string $url, array $headers, int $timeout): array
    {
        $ch = curl_init($url);
        if ($ch === false) {
            return ['status' => 0, 'headers' => [], 'body' => ''];
        }
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HEADER => true,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_HTTPHEADER => $headers,
            // private / self-signed registries (lab)
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_SSL_VERIFYHOST => 0,
            CURLOPT_NOBODY => strtoupper($method) === 'HEAD',
        ]);
        $raw = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $hs = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        curl_close($ch);
        if ($raw === false) {
            return ['status' => 0, 'headers' => [], 'body' => ''];
        }
        $headerBlob = substr($raw, 0, $hs);
        $body = substr($raw, $hs);
        $parsed = [];
        foreach (explode("\r\n", $headerBlob) as $line) {
            if (!str_contains($line, ':')) {
                continue;
            }
            [$n, $v] = explode(':', $line, 2);
            $parsed[strtolower(trim($n))] = trim($v);
        }
        return ['status' => $status, 'headers' => $parsed, 'body' => is_string($body) ? $body : ''];
    }

    /** @param array<string, string> $responseHeaders */
    private function fetchBearer(
        array $responseHeaders,
        string $registryBase,
        string $user,
        string $pass,
        string $repository,
    ): ?string {
        $auth = $responseHeaders['www-authenticate'] ?? '';
        if ($auth === '' || !preg_match('/Bearer\s+(.+)/i', $auth, $m)) {
            return null;
        }
        $params = [];
        foreach (preg_split('/\s*,\s*/', trim($m[1])) ?: [] as $part) {
            if (preg_match('/^(\w+)="([^"]*)"$/', $part, $pm)) {
                $params[$pm[1]] = $pm[2];
            }
        }
        $realm = (string) ($params['realm'] ?? '');
        if ($realm === '') {
            return null;
        }
        // Remap private realm host → public registry host (Gitness)
        $realm = $this->rewriteRealm($realm, $registryBase);
        $service = (string) ($params['service'] ?? '');
        $query = [];
        if ($service !== '') {
            $query['service'] = $service;
        }
        // Gitness breaks when scope is passed; Hub needs it
        $omitScope = $service !== '' && str_contains(strtolower($service), 'gitness');
        if (!$omitScope) {
            $query['scope'] = $params['scope'] ?? ('repository:' . $repository . ':pull');
        }
        $url = $realm . (str_contains($realm, '?') ? '&' : '?') . http_build_query($query);
        $headers = ['Accept: application/json', 'User-Agent: WharfMaster/2.3.4'];
        if ($user !== '' || $pass !== '') {
            $headers[] = 'Authorization: Basic ' . base64_encode($user . ':' . $pass);
        }
        $res = $this->http('GET', $url, $headers, 8);
        if ($res['status'] >= 400 && !$omitScope) {
            // retry without scope
            $q2 = $service !== '' ? ['service' => $service] : [];
            $url2 = $realm . (str_contains($realm, '?') ? '&' : '?') . http_build_query($q2);
            $res = $this->http('GET', $url2, $headers, 8);
        }
        if ($res['status'] >= 400) {
            return null;
        }
        $data = json_decode($res['body'], true);
        if (!is_array($data)) {
            return null;
        }
        $token = (string) ($data['token'] ?? $data['access_token'] ?? '');
        return $token !== '' ? $token : null;
    }

    private function rewriteRealm(string $realm, string $registryBase): string
    {
        $reg = parse_url($registryBase);
        $rlm = parse_url($realm);
        if (!is_array($reg) || !is_array($rlm)) {
            return $realm;
        }
        $regHost = strtolower((string) ($reg['host'] ?? ''));
        $rlmHost = strtolower((string) ($rlm['host'] ?? ''));
        if ($regHost === '' || $rlmHost === '' || $regHost === $rlmHost) {
            return $realm;
        }
        $private = filter_var($rlmHost, FILTER_VALIDATE_IP)
            && !filter_var($rlmHost, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE);
        if (!$private) {
            return $realm;
        }
        $scheme = (string) ($reg['scheme'] ?? 'https');
        $port = isset($reg['port']) ? ':' . $reg['port'] : '';
        $path = (string) ($rlm['path'] ?? '/v2/token');
        return $scheme . '://' . $regHost . $port . ($path !== '' ? $path : '/v2/token');
    }
}
