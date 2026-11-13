<?php
declare(strict_types=1);

namespace App\Registry;

final class Client
{
    /** @param array{url?:string,username?:string,password?:string,type?:string} $registry */
    public function __construct(private readonly array $registry)
    {
    }

    public function isHub(): bool
    {
        $type = strtolower((string) ($this->registry['type'] ?? 'v2'));
        if ($type === 'hub') {
            return true;
        }
        $host = strtolower(parse_url($this->baseUrl(), PHP_URL_HOST) ?: '');
        return in_array($host, ['docker.io', 'index.docker.io', 'registry-1.docker.io', 'hub.docker.com'], true);
    }

    /**
     * @return array{Repositories: list<array{Name:string,Description:string,StarCount:int,PullCount:int,Official:bool}>, Next?:string, Query:string}
     */
    public function listRepositories(string $query = '', int $limit = 50): array
    {
        if ($this->isHub()) {
            return $this->hubSearch($query, $limit);
        }
        return $this->v2Catalog($query, $limit);
    }

    /**
     * @return array{Name:string,Tags:list<array{Name:string,Size:int,LastUpdated:string}>}
     */
    public function listTags(string $repository): array
    {
        $repository = trim($repository, '/');
        if ($repository === '') {
            throw new \InvalidArgumentException('Dépôt requis');
        }
        if ($this->isHub()) {
            return $this->hubTags($repository);
        }
        return $this->v2Tags($repository);
    }

    public function ping(): array
    {
        if ($this->isHub()) {
            // Lightweight authenticated or anonymous probe
            $this->httpJson(
                'https://hub.docker.com/v2/search/repositories/?query=library&page_size=1',
                $this->hubAuthHeaders(),
                8
            );
            return ['Ok' => true, 'Type' => 'hub'];
        }
        $base = $this->baseUrl();
        $this->registryRequest('GET', $base . '/v2/');
        return ['Ok' => true, 'Type' => 'v2', 'Url' => $base];
    }

    /** @return array{Repositories: list<array{Name:string,Description:string,StarCount:int,PullCount:int,Official:bool}>, Query:string} */
    private function hubSearch(string $query, int $limit): array
    {
        $q = trim($query);
        $repos = [];
        if ($q === '') {
            // Browse authenticated user's repos when possible
            $user = trim((string) ($this->registry['username'] ?? ''));
            if ($user !== '') {
                $page = 1;
                while (count($repos) < $limit && $page <= 5) {
                    $url = 'https://hub.docker.com/v2/repositories/' . rawurlencode($user)
                        . '/?page_size=' . min(25, $limit) . '&page=' . $page;
                    try {
                        $data = $this->httpJson($url, $this->hubAuthHeaders(), 12);
                    } catch (\Throwable) {
                        break;
                    }
                    foreach (($data['results'] ?? []) as $row) {
                        $ns = (string) ($row['namespace'] ?? $user);
                        $name = (string) ($row['name'] ?? '');
                        if ($name === '') {
                            continue;
                        }
                        $full = $ns . '/' . $name;
                        $repos[] = [
                            'Name' => $full,
                            'Description' => (string) ($row['description'] ?? ''),
                            'StarCount' => (int) ($row['star_count'] ?? 0),
                            'PullCount' => (int) ($row['pull_count'] ?? 0),
                            'Official' => false,
                        ];
                        if (count($repos) >= $limit) {
                            break;
                        }
                    }
                    if (empty($data['next'])) {
                        break;
                    }
                    $page++;
                }
            }
            return ['Repositories' => $repos, 'Query' => $q];
        }

        $url = 'https://hub.docker.com/v2/search/repositories/?query=' . rawurlencode($q)
            . '&page_size=' . min(100, max(1, $limit));
        $data = $this->httpJson($url, $this->hubAuthHeaders(), 12);
        foreach (($data['results'] ?? []) as $row) {
            $name = (string) ($row['repo_name'] ?? $row['name'] ?? '');
            if ($name === '') {
                continue;
            }
            $repos[] = [
                'Name' => $name,
                'Description' => (string) ($row['short_description'] ?? $row['description'] ?? ''),
                'StarCount' => (int) ($row['star_count'] ?? 0),
                'PullCount' => (int) ($row['pull_count'] ?? 0),
                'Official' => !empty($row['is_official']),
            ];
        }
        return ['Repositories' => $repos, 'Query' => $q];
    }

    /** @return array{Name:string,Tags:list<array{Name:string,Size:int,LastUpdated:string}>} */
    private function hubTags(string $repository): array
    {
        $hubRepo = str_contains($repository, '/') ? $repository : ('library/' . $repository);
        $parts = explode('/', $hubRepo);
        $url = 'https://hub.docker.com/v2/repositories/'
            . implode('/', array_map('rawurlencode', $parts))
            . '/tags?page_size=100&ordering=-last_updated';
        $data = $this->httpJson($url, $this->hubAuthHeaders(), 15);
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
        return ['Name' => $repository, 'Tags' => $tags];
    }

    /** @return array{Repositories: list<array{Name:string,Description:string,StarCount:int,PullCount:int,Official:bool}>, Query:string} */
    private function v2Catalog(string $query, int $limit): array
    {
        // Harness/Gitness: /v2/_catalog is not implemented — use their REST API.
        if ($this->supportsGitnessApi()) {
            return $this->gitnessListRepositories($query, $limit);
        }
        $base = $this->baseUrl();
        $n = min(1000, max(1, $limit));
        $data = $this->registryRequest('GET', $base . '/v2/_catalog?n=' . $n);
        $all = [];
        foreach (($data['repositories'] ?? []) as $name) {
            if (!is_string($name) || $name === '') {
                continue;
            }
            $all[] = $name;
        }
        $q = strtolower(trim($query));
        if ($q !== '') {
            $all = array_values(array_filter($all, static fn(string $n): bool => str_contains(strtolower($n), $q)));
        }
        sort($all);
        $all = array_slice($all, 0, $limit);
        $repos = array_map(static fn(string $n): array => [
            'Name' => $n,
            'Description' => '',
            'StarCount' => 0,
            'PullCount' => 0,
            'Official' => false,
        ], $all);
        return ['Repositories' => $repos, 'Query' => $query];
    }

    /** @return list<string> */
    private function basicAuthHeaders(): array
    {
        $user = trim((string) ($this->registry['username'] ?? ''));
        $pass = (string) ($this->registry['password'] ?? '');
        if ($user === '' && $pass === '') {
            return [];
        }
        return ['Authorization: Basic ' . base64_encode($user . ':' . $pass)];
    }

    private function supportsGitnessApi(): bool
    {
        $headers = $this->basicAuthHeaders();
        if ($headers === []) {
            return false;
        }
        try {
            $data = $this->httpJson($this->baseUrl() . '/api/v1/user', $headers, 8);
            return isset($data['id']) || isset($data['uid']) || isset($data['email']);
        } catch (\Throwable) {
            return false;
        }
    }

    /**
     * @return array{Repositories: list<array{Name:string,Description:string,StarCount:int,PullCount:int,Official:bool}>, Query:string}
     */
    private function gitnessListRepositories(string $query, int $limit): array
    {
        $base = $this->baseUrl();
        $headers = $this->basicAuthHeaders();
        try {
            $memberships = $this->httpJson($base . '/api/v1/user/memberships', $headers, 12);
        } catch (\Throwable $e) {
            throw new \RuntimeException('API Gitness (memberships) : ' . $e->getMessage(), 502);
        }
        if (!is_array($memberships)) {
            $memberships = [];
        }
        $repos = [];
        $seen = [];
        foreach ($memberships as $membership) {
            if (!is_array($membership)) {
                continue;
            }
            $space = (string) ($membership['space']['path'] ?? $membership['space']['identifier'] ?? '');
            if ($space === '') {
                continue;
            }
            $page = 1;
            while (count($repos) < $limit && $page <= 20) {
                $url = $base . '/api/v1/spaces/' . rawurlencode($space)
                    . '/artifacts?page=' . $page . '&limit=' . min(50, max($limit, 10));
                try {
                    $data = $this->httpJson($url, $headers, 15);
                } catch (\Throwable) {
                    break;
                }
                $arts = $data['data']['artifacts'] ?? [];
                if (!is_array($arts) || $arts === []) {
                    break;
                }
                foreach ($arts as $art) {
                    if (!is_array($art)) {
                        continue;
                    }
                    $pkg = strtoupper((string) ($art['packageType'] ?? 'DOCKER'));
                    if ($pkg !== 'DOCKER' && $pkg !== 'HELM') {
                        continue;
                    }
                    $name = $this->gitnessArtifactRepoName($art, $space);
                    if ($name === '' || isset($seen[$name])) {
                        continue;
                    }
                    $seen[$name] = true;
                    $repos[] = [
                        'Name' => $name,
                        'Description' => (string) ($art['registryIdentifier'] ?? ''),
                        'StarCount' => 0,
                        'PullCount' => (int) ($art['downloadsCount'] ?? 0),
                        'Official' => false,
                    ];
                    if (count($repos) >= $limit) {
                        break 2;
                    }
                }
                $pageCount = (int) ($data['data']['pageCount'] ?? 1);
                if ($page >= $pageCount) {
                    break;
                }
                $page++;
            }
        }
        $q = strtolower(trim($query));
        if ($q !== '') {
            $repos = array_values(array_filter(
                $repos,
                static fn(array $r): bool => str_contains(strtolower($r['Name']), $q)
            ));
        }
        usort($repos, static fn(array $a, array $b): int => strcmp($a['Name'], $b['Name']));
        return ['Repositories' => array_slice($repos, 0, $limit), 'Query' => $query];
    }

    /** @param array<string, mixed> $art */
    private function gitnessArtifactRepoName(array $art, string $space): string
    {
        $pull = (string) ($art['pullCommand'] ?? '');
        if (preg_match('#docker\s+pull\s+(\S+)#i', $pull, $m)) {
            $ref = $m[1];
            // host/path:tag → path (drop host + tag)
            if (preg_match('#^[^/]+/(.+)$#', $ref, $rm) && str_contains($rm[1], '/')) {
                $path = $rm[1];
            } else {
                $path = $ref;
            }
            if (preg_match('#^(.+):([^:/]+)$#', $path, $tm)) {
                return $tm[1];
            }
            return $path;
        }
        $reg = (string) ($art['registryIdentifier'] ?? '');
        $name = (string) ($art['name'] ?? '');
        if ($reg === '' || $name === '') {
            return '';
        }
        return strtolower($space) . '/' . $reg . '/' . $name;
    }

    /** @return array{Name:string,Tags:list<array{Name:string,Size:int,LastUpdated:string}>} */
    private function v2Tags(string $repository): array
    {
        $base = $this->baseUrl();
        $encoded = implode('/', array_map('rawurlencode', explode('/', $repository)));
        $data = $this->registryRequest('GET', $base . '/v2/' . $encoded . '/tags/list');
        $tags = [];
        $list = $data['tags'] ?? [];
        if (!is_array($list)) {
            $list = [];
        }
        sort($list);
        foreach ($list as $tag) {
            if (!is_string($tag) || $tag === '') {
                continue;
            }
            $tags[] = [
                'Name' => $tag,
                'Size' => 0,
                'LastUpdated' => '',
            ];
        }
        return ['Name' => (string) ($data['name'] ?? $repository), 'Tags' => $tags];
    }

    private function baseUrl(): string
    {
        $url = trim((string) ($this->registry['url'] ?? ''));
        if ($url === '') {
            throw new \InvalidArgumentException('URL du registre manquante');
        }
        if (!preg_match('#^https?://#i', $url)) {
            $url = 'https://' . $url;
        }
        return rtrim($url, '/');
    }

    /** @return list<string> */
    private function hubAuthHeaders(): array
    {
        $user = (string) ($this->registry['username'] ?? '');
        $pass = (string) ($this->registry['password'] ?? '');
        if ($user === '' || $pass === '') {
            return [];
        }
        return ['Authorization: Basic ' . base64_encode($user . ':' . $pass)];
    }

    /**
     * Registry V2 request with Basic + Bearer challenge handling.
     * @return array<string, mixed>
     */
    private function registryRequest(string $method, string $url, ?string $bearer = null): array
    {
        $headers = ['Accept: application/json'];
        $user = (string) ($this->registry['username'] ?? '');
        $pass = (string) ($this->registry['password'] ?? '');
        if ($bearer) {
            $headers[] = 'Authorization: Bearer ' . $bearer;
        } elseif ($user !== '' || $pass !== '') {
            $headers[] = 'Authorization: Basic ' . base64_encode($user . ':' . $pass);
        }

        $ch = curl_init($url);
        if ($ch === false) {
            throw new \RuntimeException('Impossible d\'initialiser curl');
        }
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => 20,
            CURLOPT_HEADER => true,
            CURLOPT_HTTPHEADER => array_merge($headers, ['User-Agent: WharfMaster/2.3.7']),
        ]);
        $raw = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $headerSize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($raw === false) {
            throw new \RuntimeException($err !== '' ? $err : 'Requête registre échouée');
        }
        $headerBlob = substr($raw, 0, $headerSize);
        $body = substr($raw, $headerSize);

        if ($status === 401 && $bearer === null) {
            try {
                $token = $this->fetchBearerToken($headerBlob, $url);
            } catch (\Throwable $e) {
                throw new \RuntimeException($e->getMessage(), $e->getCode() >= 400 ? (int) $e->getCode() : 502);
            }
            if ($token !== null) {
                return $this->registryRequest($method, $url, $token);
            }
            throw new \RuntimeException(
                'Authentification registre refusée (401). Vérifiez email/utilisateur et jeton, et que le realm Bearer est joignable.',
                401
            );
        }
        if ($status >= 400) {
            $msg = trim($body) !== '' ? trim($body) : ('HTTP ' . $status);
            throw new \RuntimeException('Registre : ' . $msg, $status >= 400 && $status < 600 ? $status : 502);
        }
        if ($body === '' || $body === '{}') {
            return [];
        }
        $data = json_decode($body, true);
        if (!is_array($data)) {
            throw new \RuntimeException('Réponse registre invalide');
        }
        return $data;
    }

    private function fetchBearerToken(string $responseHeaders, string $requestUrl): ?string
    {
        if (!preg_match('/www-authenticate:\s*Bearer\s+(.+)/i', $responseHeaders, $m)) {
            return null;
        }
        $params = [];
        foreach (preg_split('/\s*,\s*/', trim($m[1])) ?: [] as $part) {
            if (preg_match('/^(\w+)="([^"]*)"$/', $part, $pm)) {
                $params[$pm[1]] = $pm[2];
            }
        }
        $realm = $params['realm'] ?? '';
        if ($realm === '') {
            return null;
        }
        // Harness/Gitness often advertises an internal realm (private IP).
        // Remap to the public registry host so token fetch works from outside.
        $realm = $this->rewriteRealmToRegistryHost($realm);
        $service = (string) ($params['service'] ?? '');
        $scope = (string) ($params['scope'] ?? '');
        // Gitness returns HTTP 404 when `scope` is passed on /v2/token; service alone is enough.
        $omitScope = $service !== '' && (
            strcasecmp($service, 'gitness-registry') === 0
            || str_contains(strtolower($service), 'gitness')
        );
        $query = [];
        if ($service !== '') {
            $query['service'] = $service;
        }
        if ($scope !== '' && !$omitScope) {
            $query['scope'] = $scope;
        }
        $headers = $this->basicAuthHeaders();
        $lastErr = '';
        try {
            $data = $this->requestRegistryToken($realm, $query, $headers);
        } catch (\Throwable $e) {
            $lastErr = $e->getMessage();
            $data = null;
            if (!$omitScope && $scope !== '') {
                // Some registries reject scope in the query — retry with service only.
                unset($query['scope']);
                try {
                    $data = $this->requestRegistryToken($realm, $query, $headers);
                } catch (\Throwable $e2) {
                    $lastErr = $e2->getMessage();
                    $data = null;
                }
            }
        }
        if ($data === null) {
            throw new \RuntimeException(
                'Impossible d’obtenir un jeton registre (realm ' . $realm . ')'
                . ($lastErr !== '' ? ' : ' . $lastErr : ''),
                502
            );
        }
        $token = (string) ($data['token'] ?? $data['access_token'] ?? '');
        return $token !== '' ? $token : null;
    }

    /**
     * @param array<string, string> $query
     * @param list<string> $headers
     * @return array<string, mixed>
     */
    private function requestRegistryToken(string $realm, array $query, array $headers): array
    {
        $tokenUrl = $realm;
        if ($query !== []) {
            $tokenUrl .= (str_contains($realm, '?') ? '&' : '?') . http_build_query($query);
        }
        return $this->httpJson($tokenUrl, $headers, 15);
    }

    /**
     * If WWW-Authenticate realm points to a private/unreachable host, reuse the
     * registry’s public scheme+host with the realm path (e.g. /v2/token).
     */
    private function rewriteRealmToRegistryHost(string $realm): string
    {
        $regBase = $this->baseUrl();
        $regParts = parse_url($regBase);
        $realmParts = parse_url($realm);
        if (!is_array($regParts) || !is_array($realmParts)) {
            return $realm;
        }
        $regHost = strtolower((string) ($regParts['host'] ?? ''));
        $realmHost = strtolower((string) ($realmParts['host'] ?? ''));
        if ($regHost === '' || $realmHost === '' || $regHost === $realmHost) {
            return $realm;
        }
        $private = filter_var($realmHost, FILTER_VALIDATE_IP)
            && !filter_var($realmHost, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE);
        // Also remap if realm host differs and looks like an internal hostname
        $likelyInternal = $private
            || str_ends_with($realmHost, '.local')
            || str_ends_with($realmHost, '.internal')
            || !str_contains($realmHost, '.');
        if (!$likelyInternal && !$private) {
            // Different public hosts — keep original (e.g. auth.docker.io)
            return $realm;
        }
        $scheme = (string) ($regParts['scheme'] ?? 'https');
        $port = isset($regParts['port']) ? ':' . $regParts['port'] : '';
        $path = (string) ($realmParts['path'] ?? '/v2/token');
        if ($path === '') {
            $path = '/v2/token';
        }
        return $scheme . '://' . $regHost . $port . $path;
    }

    /**
     * @param list<string> $headers
     * @return array<string, mixed>
     */
    private function httpJson(string $url, array $headers = [], int $timeout = 10): array
    {
        $ch = curl_init($url);
        if ($ch === false) {
            throw new \RuntimeException('Impossible d\'initialiser curl');
        }
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_HTTPHEADER => array_merge(
                ['Accept: application/json', 'User-Agent: WharfMaster/2.3.7'],
                $headers
            ),
        ]);
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($body === false) {
            throw new \RuntimeException($err !== '' ? $err : 'Requête HTTP échouée');
        }
        if ($status >= 400) {
            throw new \RuntimeException('HTTP ' . $status . (is_string($body) && $body !== '' ? ': ' . substr($body, 0, 200) : ''), $status);
        }
        $data = json_decode((string) $body, true);
        return is_array($data) ? $data : [];
    }
}
