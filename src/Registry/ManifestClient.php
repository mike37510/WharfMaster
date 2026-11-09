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
        $parsed = self::parse($imageRef);
        if ($parsed === null || $parsed['digest'] !== null) {
            return $parsed['digest'] ?? null;
        }

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
        // Docker Hub always uses registry-1.docker.io over HTTPS
        if (self::isDockerHub($host)) {
            $base = 'https://registry-1.docker.io';
            $host = 'registry-1.docker.io';
        }

        $repo = $parsed['repository'];
        $tag = $parsed['tag'];
        $user = trim((string) ($registryCreds['username'] ?? ''));
        $pass = (string) ($registryCreds['password'] ?? '');

        $manifestUrl = $base . '/v2/' . $repo . '/manifests/' . rawurlencode($tag);
        $headers = [
            'Accept: ' . self::ACCEPT,
            'User-Agent: WharfMaster/2.3.0',
        ];
        if ($user !== '' || $pass !== '') {
            $headers[] = 'Authorization: Basic ' . base64_encode($user . ':' . $pass);
        }

        $res = $this->httpHeadOrGet($manifestUrl, $headers, 8);
        if ($res['status'] === 401) {
            $token = $this->fetchBearer($res['headers'], $base, $user, $pass, $repo);
            if ($token !== null) {
                $headers = [
                    'Accept: ' . self::ACCEPT,
                    'User-Agent: WharfMaster/2.3.0',
                    'Authorization: Bearer ' . $token,
                ];
                $res = $this->httpHeadOrGet($manifestUrl, $headers, 8);
            }
        }
        if ($res['status'] < 200 || $res['status'] >= 300) {
            return null;
        }
        $digest = $res['headers']['docker-content-digest'] ?? $res['headers']['Docker-Content-Digest'] ?? '';
        if ($digest === '') {
            // Some registries only return digest on GET body config — try GET once
            $res = $this->http('GET', $manifestUrl, $headers, 8);
            $digest = $res['headers']['docker-content-digest'] ?? '';
        }
        $digest = strtolower(trim($digest));
        return str_starts_with($digest, 'sha256:') ? $digest : null;
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
        $headers = ['Accept: application/json', 'User-Agent: WharfMaster/2.3.0'];
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
