<?php
declare(strict_types=1);

namespace App\Http;

use App\Access\DockerScope;
use App\Access\EndpointAcl;
use App\Access\Ownership;
use App\Auth\Jwt;
use App\Auth\LdapClient;
use App\Docker\AgentComposeClient;
use App\Docker\Client as DockerClient;
use App\Docker\ContainerRecreate;
use App\Docker\ImageBuilder;
use App\Docker\VolumeBrowser;
use App\Http\Request;
use App\Http\Response;
use App\Registry\Client as RegistryClient;
use App\Schedule\CronExpr;
use App\Security\AgentTls;
use App\Security\ComposePolicy;
use App\Security\ImageScanner;
use App\Security\PasswordPolicy;
use App\Security\RateLimiter;
use App\Security\SecretBox;
use App\Stack\BindVolumeExtractor;
use App\Stack\ComposeDeployer;
use App\Stack\ImageUpdateChecker;
use App\Storage\Database;
use App\Storage\Repositories;

/**
 * Shared services + helpers for HTTP controllers.
 */
final class AppContext
{
    public Repositories $repo;
    public Jwt $jwt;
    public DockerClient $docker;
    public ComposeDeployer $compose;
    public ImageUpdateChecker $imageUpdates;
    public ImageBuilder $imageBuilder;
    public VolumeBrowser $volumeBrowser;
    public DockerScope $dockerScope;
    public EndpointAcl $endpointAcl;
    public ImageScanner $imageScanner;
    public LdapClient $ldap;
    public RateLimiter $rateLimiter;
    public SecretBox $secrets;
    /** @var array<string, mixed> */
    public array $config;

    /** @param array<string, mixed> $config */
    public function __construct(array $config)
    {
        $this->config = $config;
        $db = new Database($config['sqlite_path']);
        $db->migrate();
        $this->secrets = SecretBox::fromConfig($config);
        $this->repo = new Repositories($db->pdo(), $this->secrets);
        $this->jwt = new Jwt($config['jwt_secret'], (int) $config['jwt_ttl']);
        $this->docker = new DockerClient($config['docker_socket'], $config['docker_api_version']);
        $this->compose = new ComposeDeployer(
            $config['compose_dir'],
            $config['docker_socket'],
            $config['docker_bin'],
            $config['compose_bin'],
        );
        $cacheDir = dirname((string) $config['sqlite_path']) . '/image_digest_cache';
        $this->imageUpdates = new ImageUpdateChecker($this->compose, $cacheDir);
        $this->imageBuilder = new ImageBuilder(
            $this->docker,
            (string) $config['dockerfiles_dir'],
        );
        $this->volumeBrowser = new VolumeBrowser($this->docker);
        $this->dockerScope = new DockerScope($this->docker, $this->repo);
        $this->endpointAcl = new EndpointAcl($this->repo);
        $this->imageScanner = new ImageScanner(
            (string) (getenv('TRIVY_BIN') ?: 'trivy'),
            (string) $config['docker_socket'],
        );
        $this->ldap = new LdapClient();
        $rateDir = dirname((string) $config['sqlite_path']) . '/rate_limit';
        $this->rateLimiter = new RateLimiter($rateDir, 8, 900);
        $this->repo->ensureLocalEndpoint($config['docker_socket']);
        $this->repo->ensureDefaultHubRegistry();
        $this->repo->migrateRegistryPasswords();
        $this->ensureSchedulerApiKey();
    }

    public function authenticateRequest(Request $request): array|Response
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
            $dbUser = $this->repo->findUserById((int) $row['user_id']);
            return [
                'id' => (int) $row['user_id'],
                'username' => (string) $row['username'],
                'role' => (int) $row['role'],
                'auth_source' => (string) ($dbUser['auth_source'] ?? 'local'),
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
            'auth_source' => (string) ($dbUser['auth_source'] ?? 'local'),
        ];
    }

    public function clientIp(Request $request): string
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

    public function requireEndpointAccess(int $endpointId, array $user, string $minRole): array
    {
        $ep = $this->repo->getEndpoint($endpointId);
        if (!$ep) {
            return [null, Response::error('Environnement introuvable', 404)];
        }
        if ($deny = $this->assertEndpointUsable($ep)) {
            return [null, $deny];
        }
        if (!$this->endpointAcl->can($user, $endpointId, $minRole)) {
            return [null, Response::error('Accès refusé à ce nœud', 403)];
        }
        return [$ep, null];
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function wantsStackUpdateRefresh(Request $request): bool
    {
        $q = strtolower((string) ($request->query('refresh') ?? $request->query('force') ?? ''));
        return in_array($q, ['1', 'true', 'yes'], true);
    }

    /**
     * Registries with decrypted passwords for digest probes.
     * @param array{id:int,username:string,role:int} $user
     * @return list<array<string, mixed>>
     */
    public function registriesWithPasswordsForUser(array $user): array
    {
        $rows = $this->repo->listRegistriesForUser(
            Ownership::userId($user),
            Ownership::isAdmin($user),
        );
        $out = [];
        foreach ($rows as $row) {
            $full = $this->repo->getRegistry((int) $row['id']);
            if ($full) {
                $out[] = $full;
            }
        }
        return $out;
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function agentComposeClient(array $ep): AgentComposeClient
    {
        $url = trim((string) ($ep['agent_url'] ?? ''));
        $secret = trim((string) ($ep['agent_secret'] ?? ''));
        if ($url === '' || $secret === '') {
            throw new \RuntimeException('Agent non configuré (URL ou secret manquant)');
        }
        $fp = (string) ($ep['tls_fingerprint'] ?? '');
        return new AgentComposeClient($url, $secret, $fp);
    }

    /** @param array<string, mixed> $user */
    public function requireAdmin(array $user): ?Response
    {
        if ((int) ($user['role'] ?? 0) !== 1) {
            return Response::error('Accès administrateur requis', 403);
        }
        return null;
    }

    public function endpointIdFromRequest(Request $request): int
    {
        $raw = $request->query('endpointId');
        $id = $raw !== null && $raw !== '' ? (int) $raw : 1;
        return $id > 0 ? $id : 1;
    }

    /**
     * @param array{id:int,username:string,role:int} $user
     * @return array{0:?VolumeBrowser,1:?Response}
     */
    public function volumeBrowserForEndpoint(int $endpointId, string $name, array $user, string $minRole = EndpointAcl::READ): array
    {
        [$ep, $deny] = $this->requireEndpointAccess($endpointId, $user, $minRole);
        if ($deny) {
            return [null, $deny];
        }
        $role = $this->endpointAcl->roleFor($user, $endpointId);
        $scopedUser = $this->endpointAcl->withEndpointContext($user, $role);
        $docker = $this->dockerForEndpoint($ep);
        $bind = $this->repo->getBindVolumeByName($endpointId, $name);
        if ($bind) {
            $hostPath = (string) ($bind['host_path'] ?? '');
            return [new VolumeBrowser($docker, $hostPath), null];
        }
        $scope = new DockerScope($docker, $this->repo);
        if (!$scope->canAccessVolume($name, $scopedUser)) {
            return [null, Response::error('Volume introuvable ou accès refusé', 404)];
        }
        return [new VolumeBrowser($docker), null];
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function formatBindVolume(array $row): array
    {
        return [
            'Id' => (int) ($row['id'] ?? 0),
            'Name' => (string) ($row['name'] ?? ''),
            'Driver' => 'bind',
            'Mountpoint' => (string) ($row['host_path'] ?? ''),
            'HostPath' => (string) ($row['host_path'] ?? ''),
            'Source' => (string) ($row['source'] ?? 'manual'),
            'StackId' => isset($row['stack_id']) && $row['stack_id'] !== null ? (int) $row['stack_id'] : null,
            'StackName' => (string) ($row['stack_name'] ?? ''),
            'CreatedBy' => (string) ($row['created_by'] ?? ''),
            'CreatedAt' => (int) ($row['created_at'] ?? 0),
            'Labels' => [
                'wharfmaster.bind' => '1',
                'wharfmaster.bind.source' => (string) ($row['source'] ?? 'manual'),
            ],
            'Scope' => 'local',
            'Options' => null,
            'UsageData' => null,
            '_bind' => true,
        ];
    }

    public function syncBindVolumesFromEndpointStacks(int $endpointId): void
    {
        $stacks = $this->repo->listStacksForUser(null, true, $endpointId);
        foreach ($stacks as $stack) {
            $this->syncBindVolumesForStack($stack);
        }
    }

    /** @param array<string, mixed> $stack */
    public function syncBindVolumesForStack(array $stack): void
    {
        $stackId = (int) ($stack['id'] ?? 0);
        $endpointId = (int) ($stack['endpoint_id'] ?? 0);
        $stackName = (string) ($stack['name'] ?? '');
        if ($stackId <= 0 || $endpointId <= 0) {
            return;
        }
        $path = (string) ($stack['project_path'] ?? '');
        $entry = (string) ($stack['entry_point'] ?? 'docker-compose.yml');
        $content = '';
        try {
            if ($path !== '') {
                $content = $this->compose->readComposeFile($path, $entry);
            }
        } catch (\Throwable) {
            $content = '';
        }
        if ($content === '') {
            return;
        }
        $binds = BindVolumeExtractor::fromCompose($content, $stackName, $path);
        $keep = [];
        foreach ($binds as $b) {
            $name = (string) ($b['name'] ?? '');
            $host = (string) ($b['hostPath'] ?? '');
            if ($name === '' || $host === '') {
                continue;
            }
            // Don't overwrite a manual bind with the same name
            $existing = $this->repo->getBindVolumeByName($endpointId, $name);
            if ($existing && (string) ($existing['source'] ?? '') === 'manual') {
                $keep[] = $name;
                continue;
            }
            $this->repo->upsertBindVolume(
                $endpointId,
                $name,
                $host,
                'stack',
                $stackId,
                $stackName,
                (string) ($stack['created_by'] ?? ''),
            );
            $keep[] = $name;
        }
        $this->repo->pruneStackBindVolumes($stackId, $keep);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function formatRegistry(array $row): array
    {
        return [
            'Id' => (int) $row['id'],
            'Name' => (string) $row['name'],
            'URL' => (string) $row['url'],
            'Username' => (string) $row['username'],
            'Authentication' => ((string) ($row['username'] ?? '') !== '' || (string) ($row['password'] ?? '') !== ''),
            // Portainer CE Type enum: 6 = Docker Hub, 3 = Custom / Registry v2
            'Type' => ((string) ($row['type'] ?? 'v2') === 'hub') ? 6 : 3,
            'RegistryKind' => (string) ($row['type'] ?? 'v2'),
            'CreatedAt' => (int) ($row['created_at'] ?? 0),
            'OwnerId' => isset($row['owner_id']) ? (int) $row['owner_id'] : null,
            'OwnerUsername' => (string) ($row['owner_username'] ?? ''),
            'Shared' => !empty($row['is_shared']),
        ];
    }

    /** Accept Portainer int Type (6=hub, 3=custom) or WM string kind. */
    public function normalizeRegistryKind(mixed $type): string
    {
        if (is_int($type) || (is_string($type) && ctype_digit($type))) {
            return ((int) $type) === 6 ? 'hub' : 'v2';
        }
        $s = strtolower(trim((string) $type));
        return $s === 'hub' ? 'hub' : 'v2';
    }

    /**
     * Non-admin stacks: resolve via `docker compose config` then apply ComposePolicy.
     * @param list<array{name?:string,value?:string}|array{Name?:string,Value?:string}> $env
     * @param array{id:int,username:string,role:int} $user
     */
    public function assertComposeSafeForUser(string $content, array $env, array $user): ?Response
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
    public function canAccessStack(array $stack, array $user): bool
    {
        if (Ownership::isGlobalAdmin($user)) {
            return true;
        }
        $eid = (int) ($stack['endpoint_id'] ?? 0);
        if (!$this->endpointAcl->can($user, $eid, EndpointAcl::READ)) {
            return false;
        }
        if ($this->endpointAcl->can($user, $eid, EndpointAcl::ADMIN)) {
            return true;
        }
        return strcasecmp((string) ($stack['created_by'] ?? ''), Ownership::username($user)) === 0;
    }

    /** @param array<string, mixed> $stack @param array{id:int,username:string,role:int} $user */
    public function canOperateStack(array $stack, array $user): bool
    {
        if (!$this->canAccessStack($stack, $user)) {
            return false;
        }
        $eid = (int) ($stack['endpoint_id'] ?? 0);
        return $this->endpointAcl->can($user, $eid, EndpointAcl::OPERATE);
    }

    /** @param array<string, mixed> $row @param array{id:int,username:string,role:int} $user */
    public function canAccessRegistry(array $row, array $user): bool
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
    public function canManageRegistry(array $row, array $user): bool
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

    public function httpGet(string $url, int $timeout = 10): string
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
                'User-Agent: WharfMaster/2.2.0',
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
    public function hostResources(): array
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

    public function metricsChartHours(): int
    {
        $v = (int) ($this->repo->getSetting('metrics_chart_hours', '72') ?? '72');
        return max(1, min(168, $v > 0 ? $v : 72));
    }

    public function metricsRetentionDays(): int
    {
        $v = (int) ($this->repo->getSetting('metrics_retention_days', '90') ?? '90');
        return max(7, min(365, $v > 0 ? $v : 90));
    }

    public function formatSettings(): array
    {
        $publicUrl = (string) ($this->repo->getSetting('public_url', '') ?? '');
        $ep = $this->repo->getEndpoint(1);
        if ($publicUrl === '' && $ep && !empty($ep['public_url'])) {
            $publicUrl = (string) $ep['public_url'];
        }
        $ldap = $this->ldapConfig();
        return [
            'LogoURL' => '',
            'BlackListedLabels' => [],
            'AuthenticationMethod' => !empty($ldap['enabled']) ? 2 : 1,
            'InternalAuthSettings' => ['RequiredPasswordLength' => 8],
            'EnableEdgeComputeFeatures' => false,
            'UserSessionTimeout' => '8h',
            'EnableTelemetry' => false,
            'SnapshotInterval' => '5m',
            'PublicURL' => $publicUrl,
            // Alias used by our UI
            'HostURL' => $publicUrl,
            'MetricsChartHours' => $this->metricsChartHours(),
            'MetricsRetentionDays' => $this->metricsRetentionDays(),
            'Ldap' => [
                'Enabled' => !empty($ldap['enabled']),
                'Host' => (string) ($ldap['host'] ?? ''),
                'Port' => (int) ($ldap['port'] ?? 389),
                'UseTls' => !empty($ldap['use_tls']),
                'UseSsl' => !empty($ldap['use_ssl']),
                'BaseDn' => (string) ($ldap['base_dn'] ?? ''),
                'BindDn' => (string) ($ldap['bind_dn'] ?? ''),
                'BindPasswordSet' => trim((string) ($ldap['bind_password'] ?? '')) !== '',
                'UserFilter' => (string) ($ldap['user_filter'] ?? '(sAMAccountName={username})'),
                'UsernameAttr' => (string) ($ldap['username_attr'] ?? 'sAMAccountName'),
            ],
            // Portainer CE shape (clients reading settings.LDAPSettings)
            'LDAPSettings' => $this->formatLdapSettingsPortainer($ldap),
            'TrivyEnabled' => $this->trivyEnabled(),
            'TrivyInstalled' => $this->imageScanner->available(),
            'TrivyAvailable' => $this->trivyEnabled() && $this->imageScanner->available(),
        ];
    }

    public function trivyEnabled(): bool
    {
        $v = strtolower(trim((string) ($this->repo->getSetting('trivy_enabled', '1') ?? '1')));
        return !in_array($v, ['0', 'false', 'off', 'no'], true);
    }

    /** @param array<string, mixed> $user */
    public function publicUser(array $user): array
    {
        $role = (int) $user['role'];
        return [
            'Id' => (int) $user['id'],
            'Username' => $user['username'],
            'Role' => $role,
            'IsAdmin' => $role === 1,
            'AuthSource' => (string) ($user['auth_source'] ?? 'local'),
            'ThemeSettings' => (object) [],
        ];
    }

    /** @param array<string, mixed> $ep */
    public function formatEndpoint(array $ep): array
    {
        $stored = (int) ($ep['status'] ?? 1);
        // Portainer CE Status: 1=up, 2=down (disabled maps to down, never 0)
        $status = $stored === 0 ? 2 : 2;
        $tlsExpiresAt = isset($ep['tls_expires_at']) && $ep['tls_expires_at'] !== null
            ? (int) $ep['tls_expires_at']
            : null;
        if ($stored !== 0) {
            try {
                $status = $this->dockerForEndpoint($ep)->ping() ? 1 : 2;
                if ($status === 1) {
                    $this->repo->updateEndpointLastSeen((int) $ep['id'], 1);
                    if (($ep['kind'] ?? '') === 'agent') {
                        $meta = $this->probeAgentTlsMeta($ep);
                        if ($meta !== null) {
                            $tlsExpiresAt = $meta['expiresAt'] ?? $tlsExpiresAt;
                            $observed = (string) ($meta['fingerprint'] ?? '');
                            $prev = trim((string) ($ep['tls_fingerprint'] ?? ''));
                            // TOFU or authenticated pin refresh after cert renewal
                            $pinToStore = $observed !== '' && ($prev === '' || $prev !== $observed)
                                ? $observed
                                : ($prev !== '' ? $prev : null);
                            $this->repo->updateEndpointTlsMeta(
                                (int) $ep['id'],
                                $meta['expiresAt'] ?? null,
                                $pinToStore,
                            );
                            if ($observed !== '') {
                                $ep['tls_fingerprint'] = $observed;
                            }
                        }
                    }
                } elseif (($ep['kind'] ?? '') === 'agent') {
                    $this->repo->updateEndpointLastSeen((int) $ep['id'], 2);
                }
            } catch (\Throwable) {
                $status = 2;
            }
        }

        $kind = (string) ($ep['kind'] ?? 'local');
        $tlsDaysLeft = null;
        if ($tlsExpiresAt !== null && $tlsExpiresAt > 0) {
            $tlsDaysLeft = (int) floor(($tlsExpiresAt - time()) / 86400);
        }
        [$userPolicies, $teamPolicies] = $this->portainerAccessPolicies((int) $ep['id']);
        return [
            'Id' => (int) $ep['id'],
            'Name' => $ep['name'],
            'Type' => (int) $ep['type'],
            'URL' => $kind === 'agent' ? (string) ($ep['agent_url'] ?? $ep['url']) : $ep['url'],
            'GroupId' => (int) $ep['group_id'],
            'PublicURL' => $ep['public_url'] !== ''
                ? $ep['public_url']
                : (string) ($this->repo->getSetting('public_url', '') ?? ''),
            'Status' => $status,
            'Snapshots' => json_decode($ep['snapshots'] ?: '[]', true) ?: [],
            'IsEdgeDevice' => false,
            'UserAccessPolicies' => $userPolicies,
            'TeamAccessPolicies' => $teamPolicies,
            'TagIds' => [],
            'Kubernetes' => (object) [],
            'Kind' => $kind,
            'NodeName' => (string) ($ep['node_name'] ?? $ep['name']),
            'AgentURL' => (string) ($ep['agent_url'] ?? ''),
            'Disabled' => $stored === 0,
            'LastSeenAt' => isset($ep['last_seen_at']) ? (int) $ep['last_seen_at'] : null,
            'JoinedAt' => isset($ep['joined_at']) ? (int) $ep['joined_at'] : null,
            'Tls' => $kind === 'agent',
            'TlsExpiresAt' => $tlsExpiresAt,
            'TlsDaysLeft' => $tlsDaysLeft,
            'TlsRenewBy' => $tlsExpiresAt ? date('Y-m-d', max(0, $tlsExpiresAt - 30 * 86400)) : null,
            'TlsFingerprint' => (string) ($ep['tls_fingerprint'] ?? ''),
            'TlsFingerprintShort' => AgentTls::short((string) ($ep['tls_fingerprint'] ?? '')),
            'TlsPinned' => trim((string) ($ep['tls_fingerprint'] ?? '')) !== '',
        ];
    }

    /**
     * @param array<string, mixed> $ep
     * @return array{fingerprint:string, expiresAt:?int}|null
     */
    public function probeAgentTlsMeta(array $ep): ?array
    {
        $url = (string) ($ep['agent_url'] ?? '');
        if ($url === '' || !str_starts_with(strtolower($url), 'https://')) {
            return null;
        }
        $secret = (string) ($ep['agent_secret'] ?? '');
        $pinned = trim((string) ($ep['tls_fingerprint'] ?? ''));
        $info = AgentTls::inspect($url);
        if ($info === null) {
            return null;
        }
        if ($pinned !== '' && !hash_equals($pinned, $info['fingerprint'])) {
            // Cert renewed (agent entrypoint) — only rotate pin if Bearer health succeeds
            if ($secret === '' || !AgentTls::healthOk($url, $secret)) {
                return null;
            }
        }
        if (AgentTls::healthOk($url, $secret)) {
            try {
                $ch = curl_init(rtrim($url, '/') . '/health');
                if ($ch) {
                    curl_setopt_array($ch, [
                        CURLOPT_RETURNTRANSFER => true,
                        CURLOPT_TIMEOUT => 5,
                        CURLOPT_HTTPHEADER => [
                            'Authorization: Bearer ' . $secret,
                            'Accept: application/json',
                        ],
                        CURLOPT_SSL_VERIFYPEER => false,
                        CURLOPT_SSL_VERIFYHOST => 0,
                    ]);
                    $body = curl_exec($ch);
                    curl_close($ch);
                    if (is_string($body) && $body !== '') {
                        $json = json_decode($body, true);
                        if (is_array($json) && !empty($json['tlsExpiresAt'])) {
                            $info['expiresAt'] = (int) $json['tlsExpiresAt'];
                        }
                    }
                }
            } catch (\Throwable) {
                // keep cert-based expiry
            }
        }
        return $info;
    }

    /** @param array<string, mixed> $ep */
    public function probeAgentTls(array $ep): ?int
    {
        $meta = $this->probeAgentTlsMeta($ep);
        return $meta['expiresAt'] ?? null;
    }

    /** @param array<string, mixed> $stack */
    public function formatStack(array $stack): array
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

    public function ensureInstanceId(): string
    {
        $id = $this->repo->getSetting('instance_id');
        if ($id) {
            return $id;
        }
        $id = bin2hex(random_bytes(16));
        $this->repo->setSetting('instance_id', $id);
        return $id;
    }

    public function snapshotSqliteFile(): string
    {
        $sqlite = (string) ($this->config['sqlite_path'] ?? '');
        if ($sqlite === '' || !is_file($sqlite)) {
            throw new \RuntimeException('Base SQLite introuvable', 404);
        }
        $tmp = sys_get_temp_dir() . '/wm-backup-' . bin2hex(random_bytes(6)) . '.sqlite';
        try {
            $src = new \PDO('sqlite:' . $sqlite);
            $src->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
            $src->exec('VACUUM INTO ' . $src->quote($tmp));
        } catch (\Throwable) {
            if (!@copy($sqlite, $tmp)) {
                throw new \RuntimeException('Impossible de créer le snapshot SQLite', 500);
            }
        }
        return $tmp;
    }

    public function zipAddDirectory(\ZipArchive $zip, string $dir, string $zipPrefix): array
    {
        $added = [];
        $dir = rtrim($dir, '/');
        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::SELF_FIRST
        );
        foreach ($iterator as $fileInfo) {
            /** @var \SplFileInfo $fileInfo */
            $full = $fileInfo->getPathname();
            $rel = substr($full, strlen($dir) + 1);
            if ($rel === false || $rel === '') {
                continue;
            }
            $rel = str_replace('\\', '/', $rel);
            $target = $zipPrefix . '/' . $rel;
            if ($fileInfo->isDir()) {
                $zip->addEmptyDir($target);
                continue;
            }
            if (!$fileInfo->isFile() || !$fileInfo->isReadable()) {
                continue;
            }
            // Skip hidden paths / logs
            if (str_starts_with($rel, '.') || str_contains($rel, '/.') || str_ends_with($rel, '.log')) {
                continue;
            }
            $zip->addFile($full, $target);
            $added[] = preg_replace('#^[^/]+/#', '', $target) ?: $target;
        }
        return $added;
    }

    public function backupRestoreGuide(string $stamp): string
    {
        $ver = (string) ($this->config['version'] ?? '');
        return <<<MD
# Restauration WharfMaster (backup {$stamp})

Archive générée par WharfMaster {$ver}.

## Contenu
- `database/dockermanager.sqlite` — utilisateurs, nœuds/agents, stacks, registres, paramètres, audit, métriques
- `compose/` — fichiers Docker Compose des stacks (miroir local)
- `dockerfiles/` — Dockerfiles enregistrés dans l’UI
- `secrets/jwt.secret` — secret JWT (sessions / API)
- `MANIFEST.json` — métadonnées + aperçu des settings

## Non inclus
- Données dans les **volumes Docker** / fichiers des conteneurs
- Images Docker locales
- Certificats TLS des agents distants (hors empreinte en base)

## Restauration rapide
1. Arrêter WharfMaster (Apache/PHP ou conteneur).
2. Remplacer `var/dockermanager.sqlite` par `database/dockermanager.sqlite`.
3. Restaurer `var/compose/` et `var/dockerfiles/` depuis l’archive.
4. Restaurer `var/jwt.secret` depuis `secrets/jwt.secret` (permissions `0600`).
5. Corriger le propriétaire (`www-data` ou utilisateur du conteneur) puis redémarrer.

```bash
# Exemple (chemins à adapter)
unzip wharfmaster-backup-{$stamp}.zip
install -m 600 wharfmaster-backup-{$stamp}/secrets/jwt.secret /var/www/html/var/jwt.secret
install -m 600 wharfmaster-backup-{$stamp}/database/dockermanager.sqlite /var/www/html/var/dockermanager.sqlite
rm -rf /var/www/html/var/compose /var/www/html/var/dockerfiles
cp -a wharfmaster-backup-{$stamp}/compose /var/www/html/var/compose
cp -a wharfmaster-backup-{$stamp}/dockerfiles /var/www/html/var/dockerfiles
chown -R www-data:www-data /var/www/html/data
```

Conservez cette archive hors ligne : elle contient des secrets (JWT, mots de passe registres chiffrés, secrets agents).
MD;
    }

    /** @param array<string, mixed> $ep */
    public function dockerForEndpoint(array $ep): DockerClient
    {
        $kind = (string) ($ep['kind'] ?? 'local');
        $api = (string) ($this->config['docker_api_version'] ?? 'v1.45');
        if ($kind === 'agent') {
            $url = (string) ($ep['agent_url'] ?? '');
            $secret = (string) ($ep['agent_secret'] ?? '');
            if ($url === '' || $secret === '') {
                throw new \RuntimeException('Nœud agent mal configuré', 503);
            }
            $fp = (string) ($ep['tls_fingerprint'] ?? '');
            return DockerClient::httpAgent($url, $secret, $api, $fp);
        }
        return $this->docker;
    }

    /** @param array<string, mixed> $ep */
    public function scopeForEndpoint(array $ep): DockerScope
    {
        return new DockerScope($this->dockerForEndpoint($ep), $this->repo);
    }

    /** @param array<string, mixed> $ep */
    public function assertEndpointUsable(array $ep): ?Response
    {
        if ((int) ($ep['status'] ?? 1) === 0) {
            return Response::error('Nœud désactivé', 503);
        }
        if (($ep['kind'] ?? 'local') === 'agent' && trim((string) ($ep['agent_secret'] ?? '')) === '') {
            return Response::error('Nœud délié ou secret manquant', 503);
        }
        return null;
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function formatJoinTokenResponse(
        string $rawToken,
        array $row,
        ?Request $request = null,
        string $nodeHost = '',
        string $nodeName = '',
        int $nodePort = 9001,
    ): array {
        $public = $this->resolvePublicBaseUrl($request);
        $cmd = $this->buildInstallCommand($public, $rawToken, $nodeHost, $nodeName, $nodePort);
        return [
            'Token' => $rawToken,
            'Hint' => '…' . (string) ($row['token_hint'] ?? ''),
            'ExpiresAt' => (int) ($row['expires_at'] ?? 0),
            'MaxUses' => isset($row['max_uses']) && $row['max_uses'] !== null ? (int) $row['max_uses'] : null,
            'NodeHost' => $nodeHost,
            'NodeName' => $nodeName,
            'NodePort' => $nodePort > 0 ? $nodePort : 9001,
            'PublicURL' => $public,
            'AdvertiseURL' => $this->buildAdvertiseUrl($nodeHost, $nodePort),
            'InstallCommand' => $cmd,
            'BundleDownload' => '/api/nodes/agent-bundle',
        ];
    }

    /**
     * ZIP pack for manual agent deploy: sources + Dockerfile + compose + deploy.sh + .env.
     *
     * @param array{id:int,username:string,role:int} $user
     */
    public function resolveAgentSourceDir(): ?string
    {
        $dir = (string) ($this->config['agent_dir'] ?? (dirname(__DIR__) . '/agent'));
        if (is_dir($dir) && is_file($dir . '/agent.php') && is_file($dir . '/Dockerfile')) {
            return $dir;
        }
        return null;
    }

    /** @param array<string, string> $vars */
    public function buildAgentEnvFile(array $vars): string
    {
        $lines = [
            '# WharfMaster agent — généré depuis le principal. chmod 600 .env',
            '# Puis: chmod +x deploy.sh && ./deploy.sh',
            '',
        ];
        foreach ($vars as $k => $v) {
            $lines[] = $k . '=' . $v;
        }
        $lines[] = '';
        $lines[] = '# Rempli automatiquement par ./deploy.sh après le join :';
        $lines[] = '# NODE_SECRET=';
        $lines[] = '';
        return implode("\n", $lines);
    }

    public function agentComposeYmlTemplate(): string
    {
        return <<<'YAML'
services:
  agent:
    build: .
    image: ${AGENT_IMAGE:-wharfmaster-agent:local}
    container_name: wharfmaster-agent
    restart: unless-stopped
    environment:
      NODE_SECRET: ${NODE_SECRET:?NODE_SECRET requis}
      DOCKER_SOCKET: /var/run/docker.sock
      AGENT_PORT: "9001"
      AGENT_TLS_CN: ${AGENT_TLS_CN:-wharfmaster-agent}
      AGENT_TLS_DAYS: ${AGENT_TLS_DAYS:-365}
      AGENT_CERT_DIR: /data/certs
      AGENT_STACKS_DIR: /data/stacks
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - wharfmaster-agent-certs:/data/certs
      - ${STACKS_DIR:-/var/lib/wharfmaster/stacks}:/data/stacks
    ports:
      - "${AGENT_HOST_PORT:-9001}:9001"

volumes:
  wharfmaster-agent-certs:
YAML;
    }

    public function agentDeployShTemplate(): string
    {
        $path = dirname(__DIR__) . '/agent/deploy.sh';
        if (is_file($path)) {
            return (string) file_get_contents($path);
        }
        return "#!/bin/sh\necho 'deploy.sh manquant'\nexit 1\n";
    }

    public function agentReadmeTemplate(): string
    {
        $path = dirname(__DIR__) . '/agent/README.md';
        if (is_file($path)) {
            return (string) file_get_contents($path);
        }
        return "# WharfMaster agent\n\nchmod +x deploy.sh && ./deploy.sh\n";
    }

    public function agentEnvExampleTemplate(): string
    {
        $path = dirname(__DIR__) . '/agent/.env.example';
        if (is_file($path)) {
            return (string) file_get_contents($path);
        }
        return "WHARFMASTER_URL=https://VOTRE-SERVEUR\nJOIN_TOKEN=wmj_\nADVERTISE_URL=https://IP:9001\nNODE_NAME=mon-serveur\nAGENT_HOST_PORT=9001\n";
    }

    /** URL publique configurée, sinon origine de la requête courante. */
    public function resolvePublicBaseUrl(?Request $request = null): string
    {
        $public = trim((string) ($this->repo->getSetting('public_url', '') ?? ''));
        if ($public === '') {
            $ep = $this->repo->getEndpoint(1);
            if ($ep && !empty($ep['public_url'])) {
                $public = trim((string) $ep['public_url']);
            }
        }
        if ($public === '' && $request !== null) {
            $host = trim((string) ($request->header('X-Forwarded-Host')
                ?? $request->header('Host')
                ?? ''));
            // first value if comma-separated
            if (str_contains($host, ',')) {
                $host = trim(explode(',', $host, 2)[0]);
            }
            if ($host !== '') {
                $proto = strtolower(trim((string) ($request->header('X-Forwarded-Proto') ?? '')));
                if ($proto === '' || !in_array($proto, ['http', 'https'], true)) {
                    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
                        || ((int) ($_SERVER['SERVER_PORT'] ?? 0) === 443);
                    $proto = $https ? 'https' : 'http';
                }
                $public = $proto . '://' . $host;
            }
        }
        return rtrim($public !== '' ? $public : 'https://VOTRE-SERVEUR', '/');
    }

    public function buildAdvertiseUrl(string $nodeHost, int $nodePort = 9001): string
    {
        $host = trim($nodeHost);
        $host = preg_replace('#^https?://#i', '', $host) ?? $host;
        $host = rtrim($host, '/');
        if ($host === '') {
            return 'https://IP_DU_NOEUD:9001';
        }
        // host:port already provided
        if (preg_match('#^\[.+\]:\d+$#', $host) || preg_match('#^[^/]+:\d+$#', $host)) {
            return 'https://' . $host;
        }
        $port = $nodePort > 0 && $nodePort <= 65535 ? $nodePort : 9001;
        return 'https://' . $host . ':' . $port;
    }

    public function buildInstallCommand(
        string $publicUrl,
        string $token,
        string $nodeHost = '',
        string $nodeName = '',
        int $nodePort = 9001,
    ): string {
        $base = rtrim($publicUrl !== '' ? $publicUrl : 'https://VOTRE-SERVEUR', '/');
        $advertise = $this->buildAdvertiseUrl($nodeHost, $nodePort);
        $name = $nodeName !== '' ? $nodeName : 'mon-serveur';
        // Single-line, ready to paste — uses configured Public URL / host
        $image = (string) ($this->config['agent_image'] ?? 'ghcr.io/mike37510/wharfmaster-agent:2.2.0');
        return 'curl -fsSL ' . escapeshellarg($base . '/agent/install.sh')
            . ' | sh -s --'
            . ' --url ' . escapeshellarg($base)
            . ' --token ' . escapeshellarg($token)
            . ' --advertise ' . escapeshellarg($advertise)
            . ' --name ' . escapeshellarg($name)
            . ' --image ' . escapeshellarg($image);
    }

    public function audit(?array $user, string $action, string $message, ?Request $request = null, array $meta = []): void
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
    public function auditDockerMutation(array $user, string $method, string $dockerPath, Request $request): void
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
    public function aclRoleToPortainerRoleId(string $role): int
    {
        return match ($role) {
            EndpointAcl::ADMIN => 1,
            EndpointAcl::OPERATE => 2,
            EndpointAcl::READ => 3,
            default => 2,
        };
    }

    public function portainerRoleIdToAclRole(int $roleId): string
    {
        return match ($roleId) {
            1 => EndpointAcl::ADMIN,
            3 => EndpointAcl::READ,
            default => EndpointAcl::OPERATE,
        };
    }

    /**
     * @return array{0:object|array<string,array{RoleId:int}>,1:object|array<string,array{RoleId:int}>}
     */
    public function portainerAccessPolicies(int $endpointId): array
    {
        $userPolicies = [];
        $teamPolicies = [];
        foreach ($this->repo->listEndpointAcls($endpointId) as $row) {
            $stype = (string) ($row['subject_type'] ?? '');
            $sid = (string) (int) ($row['subject_id'] ?? 0);
            $roleId = $this->aclRoleToPortainerRoleId((string) ($row['role'] ?? 'operate'));
            if ($stype === 'user') {
                $userPolicies[$sid] = ['RoleId' => $roleId];
            } elseif ($stype === 'team') {
                $teamPolicies[$sid] = ['RoleId' => $roleId];
            }
        }
        return [
            $userPolicies === [] ? new \stdClass() : $userPolicies,
            $teamPolicies === [] ? new \stdClass() : $teamPolicies,
        ];
    }

    /** @param array<string, mixed> $ldap */
    public function formatLdapSettingsPortainer(array $ldap): array
    {
        $host = (string) ($ldap['host'] ?? '');
        $port = (int) ($ldap['port'] ?? 389);
        $url = $host;
        if ($host !== '' && $port > 0) {
            $url = $host . ':' . $port;
        }
        return [
            'AnonymousMode' => false,
            'ReaderDN' => (string) ($ldap['bind_dn'] ?? ''),
            'Password' => '',
            'URL' => $url,
            'TLSConfig' => [
                'TLS' => !empty($ldap['use_ssl']),
                'TLSSkipVerify' => false,
                'StartTLS' => !empty($ldap['use_tls']),
            ],
            'StartTLS' => !empty($ldap['use_tls']),
            'SearchSettings' => [[
                'BaseDN' => (string) ($ldap['base_dn'] ?? ''),
                'Filter' => (string) ($ldap['user_filter'] ?? '(sAMAccountName={username})'),
                'UserNameAttribute' => (string) ($ldap['username_attr'] ?? 'sAMAccountName'),
            ]],
            'GroupSearchSettings' => [],
            'AutoCreateUsers' => true,
        ];
    }

    /** @param array<string, mixed> $ldap */
    public function saveLdapSettingsFromPortainer(array $ldap): void
    {
        $url = trim((string) ($ldap['URL'] ?? $ldap['url'] ?? ''));
        $host = $url;
        $port = 389;
        if (str_contains($url, ':')) {
            $parts = explode(':', $url);
            // host:port (ignore scheme if present)
            $host = preg_replace('#^ldaps?://#i', '', $parts[0]) ?: $parts[0];
            if (isset($parts[1]) && ctype_digit($parts[1])) {
                $port = (int) $parts[1];
            }
            if (count($parts) > 2 && ctype_digit($parts[count($parts) - 1])) {
                $port = (int) $parts[count($parts) - 1];
                $host = preg_replace('#^ldaps?://#i', '', implode(':', array_slice($parts, 0, -1))) ?: $host;
            }
        }
        $search = [];
        if (isset($ldap['SearchSettings'][0]) && is_array($ldap['SearchSettings'][0])) {
            $search = $ldap['SearchSettings'][0];
        }
        $tls = is_array($ldap['TLSConfig'] ?? null) ? $ldap['TLSConfig'] : [];
        $mapped = [
            'Enabled' => true,
            'Host' => $host,
            'Port' => $port,
            'UseTls' => !empty($ldap['StartTLS'] ?? $tls['StartTLS'] ?? false),
            'UseSsl' => !empty($tls['TLS'] ?? false),
            'BaseDn' => (string) ($search['BaseDN'] ?? ''),
            'BindDn' => (string) ($ldap['ReaderDN'] ?? ''),
            'UserFilter' => (string) ($search['Filter'] ?? '(sAMAccountName={username})'),
            'UsernameAttr' => (string) ($search['UserNameAttribute'] ?? 'sAMAccountName'),
        ];
        $pass = $ldap['Password'] ?? null;
        if (is_string($pass) && $pass !== '') {
            $mapped['BindPassword'] = $pass;
        }
        // AuthenticationMethod=2 typically accompanies LDAPSettings write
        $authMethod = $this->repo->getSetting('ldap_json', '');
        $this->saveLdapSettings($mapped);
        unset($authMethod);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function syncPortainerPolicies(int $endpointId, string $subjectType, array $policies): void
    {
        $existing = $this->repo->listEndpointAcls($endpointId);
        foreach ($existing as $row) {
            if ((string) ($row['subject_type'] ?? '') === $subjectType) {
                $this->repo->deleteEndpointAcl((int) $row['id']);
            }
        }
        foreach ($policies as $sid => $policy) {
            $subjectId = (int) $sid;
            if ($subjectId <= 0) {
                continue;
            }
            $roleId = 2;
            if (is_array($policy)) {
                $roleId = (int) ($policy['RoleId'] ?? $policy['roleId'] ?? $policy['Role'] ?? 2);
            } elseif (is_object($policy)) {
                $roleId = (int) ($policy->RoleId ?? $policy->roleId ?? 2);
            }
            $role = $this->portainerRoleIdToAclRole($roleId);
            if ($subjectType === 'user' && !$this->repo->findUserById($subjectId)) {
                continue;
            }
            if ($subjectType === 'team' && !$this->repo->getTeam($subjectId)) {
                continue;
            }
            $this->repo->upsertEndpointAcl($endpointId, $subjectType, $subjectId, $role);
        }
    }

    /** Synthetic membership id: teamId * 1_000_000 + userId */
    public function membershipId(int $teamId, int $userId): int
    {
        return ($teamId * 1_000_000) + $userId;
    }

    /** @return array{0:int,1:int}|null */
    public function parseMembershipId(int $id): ?array
    {
        if ($id < 1_000_001) {
            return null;
        }
        $teamId = intdiv($id, 1_000_000);
        $userId = $id % 1_000_000;
        if ($teamId <= 0 || $userId <= 0) {
            return null;
        }
        return [$teamId, $userId];
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function ldapConfig(): array
    {
        $raw = (string) ($this->repo->getSetting('ldap_json', '{}') ?? '{}');
        $cfg = json_decode($raw, true);
        if (!is_array($cfg)) {
            $cfg = [];
        }
        if (!empty($cfg['bind_password_enc']) && is_string($cfg['bind_password_enc'])) {
            try {
                $cfg['bind_password'] = $this->secrets->decrypt($cfg['bind_password_enc']);
            } catch (\Throwable) {
                $cfg['bind_password'] = '';
            }
        }
        return $cfg;
    }

    /** @param array<string, mixed> $ldap */
    public function saveLdapSettings(array $ldap): void
    {
        $prev = $this->ldapConfig();
        $cfg = [
            'enabled' => !empty($ldap['Enabled'] ?? $ldap['enabled'] ?? false),
            'host' => trim((string) ($ldap['Host'] ?? $ldap['host'] ?? '')),
            'port' => (int) ($ldap['Port'] ?? $ldap['port'] ?? 389),
            'use_tls' => !empty($ldap['UseTls'] ?? $ldap['use_tls'] ?? false),
            'use_ssl' => !empty($ldap['UseSsl'] ?? $ldap['use_ssl'] ?? false),
            'base_dn' => trim((string) ($ldap['BaseDn'] ?? $ldap['base_dn'] ?? '')),
            'bind_dn' => trim((string) ($ldap['BindDn'] ?? $ldap['bind_dn'] ?? '')),
            'user_filter' => trim((string) ($ldap['UserFilter'] ?? $ldap['user_filter'] ?? '(sAMAccountName={username})')),
            'username_attr' => trim((string) ($ldap['UsernameAttr'] ?? $ldap['username_attr'] ?? 'sAMAccountName')),
        ];
        $newPass = $ldap['BindPassword'] ?? $ldap['bind_password'] ?? null;
        if (is_string($newPass) && $newPass !== '') {
            $cfg['bind_password_enc'] = $this->secrets->encrypt($newPass);
        } elseif (!empty($prev['bind_password_enc'])) {
            $cfg['bind_password_enc'] = $prev['bind_password_enc'];
        }
        unset($cfg['bind_password']);
        $this->repo->setSetting('ldap_json', json_encode($cfg, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '{}');
    }

    // --- Teams ---

    /** Portainer CE: bare array `[{ Id, Name }, …]`. */
    public function formatTeam(array $t, array $members): array
    {
        return [
            'Id' => (int) $t['id'],
            'Name' => (string) $t['name'],
            'Description' => (string) ($t['description'] ?? ''),
            'AdGroupDn' => (string) ($t['ad_group_dn'] ?? ''),
            'CreatedAt' => (int) ($t['created_at'] ?? 0),
            'Members' => array_map(static function (array $m): array {
                return [
                    'Id' => (int) $m['id'],
                    'Username' => (string) $m['username'],
                    'Role' => (int) $m['role'],
                    'AuthSource' => (string) ($m['auth_source'] ?? 'local'),
                ];
            }, $members),
        ];
    }

    // --- ACLs ---

    /** @param array{id:int,username:string,role:int} $user */
    public function formatAcl(array $row): array
    {
        $stype = (string) ($row['subject_type'] ?? '');
        $sid = (int) ($row['subject_id'] ?? 0);
        $name = '';
        if ($stype === 'user') {
            $u = $this->repo->findUserById($sid);
            $name = $u ? (string) $u['username'] : '';
        } elseif ($stype === 'team') {
            $t = $this->repo->getTeam($sid);
            $name = $t ? (string) $t['name'] : '';
        }
        return [
            'Id' => (int) ($row['id'] ?? 0),
            'EndpointId' => (int) ($row['endpoint_id'] ?? 0),
            'SubjectType' => $stype,
            'SubjectId' => $sid,
            'SubjectName' => $name,
            'Role' => (string) ($row['role'] ?? ''),
        ];
    }

    // --- Schedules ---

    public function ensureSchedulerApiKey(): void
    {
        $path = dirname((string) $this->config['sqlite_path']) . '/scheduler.api_key';
        if (is_file($path) && trim((string) file_get_contents($path)) !== '') {
            if (($this->repo->getSetting('scheduler_api_key_hint', '') ?? '') === '') {
                $raw = trim((string) file_get_contents($path));
                $this->repo->setSetting('scheduler_api_key_hint', substr($raw, -4));
            }
            return;
        }
        // Wait until a real admin exists (do not block adminInit)
        if ($this->repo->userCount() === 0) {
            return;
        }
        $admins = array_values(array_filter(
            $this->repo->listUsers(),
            static fn(array $u): bool => (int) ($u['role'] ?? 0) === 1
                && (string) ($u['username'] ?? '') !== '__scheduler__',
        ));
        if ($admins === []) {
            return;
        }
        $raw = 'ptr_' . bin2hex(random_bytes(24));
        $this->repo->createApiKey((int) $admins[0]['id'], 'scheduler-sidecar', $raw);
        @file_put_contents($path, $raw);
        @chmod($path, 0600);
        $this->repo->setSetting('scheduler_api_key_hint', substr($raw, -4));
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function executeScheduleRow(array $row, Request $request, array $user, bool $manual): Response
    {
        $action = (string) $row['action'];
        $targetId = (int) $row['target_id'];
        $cron = (string) $row['cron_expr'];
        try {
            $ctrl = $this->controlStack($targetId, $action, $request, $user);
            if ($ctrl->status >= 400) {
                $this->repo->markScheduleRun(
                    (int) $row['id'],
                    'error',
                    'HTTP ' . $ctrl->status,
                    CronExpr::nextAfter($cron, time()),
                );
                return $ctrl;
            }
            $this->repo->markScheduleRun(
                (int) $row['id'],
                $manual ? 'ok-manual' : 'ok',
                '',
                CronExpr::nextAfter($cron, time()),
            );
            $this->audit($user, 'schedule.run', 'Exécution planification #' . $row['id'] . ' (' . $action . ')', $request, [
                'scheduleId' => (int) $row['id'],
                'manual' => $manual,
            ]);
            return $ctrl;
        } catch (\Throwable $e) {
            $this->repo->markScheduleRun(
                (int) $row['id'],
                'error',
                $e->getMessage(),
                CronExpr::nextAfter($cron, time()),
            );
            return Response::error($e->getMessage(), 500);
        }
    }

    /** @param array<string, mixed> $row @param array{id:int,username:string,role:int} $user */
    public function canAccessSchedule(array $row, array $user): bool
    {
        if (Ownership::isGlobalAdmin($user)) {
            return true;
        }
        if ((string) ($row['target_type'] ?? '') !== 'stack') {
            return false;
        }
        $stack = $this->repo->getStack((int) $row['target_id']);
        return $stack ? $this->canAccessStack($stack, $user) : false;
    }

    /** @param array<string, mixed> $row @param array{id:int,username:string,role:int} $user */
    public function canOperateSchedule(array $row, array $user): bool
    {
        if (Ownership::isGlobalAdmin($user)) {
            return true;
        }
        $stack = $this->repo->getStack((int) $row['target_id']);
        return $stack ? $this->canOperateStack($stack, $user) : false;
    }

    /** @param array<string, mixed> $row */
    public function formatSchedule(array $row): array
    {
        return [
            'Id' => (int) $row['id'],
            'Name' => (string) $row['name'],
            'EndpointId' => (int) $row['endpoint_id'],
            'TargetType' => (string) $row['target_type'],
            'TargetId' => (int) $row['target_id'],
            'StackId' => (int) $row['target_id'],
            'Action' => (string) $row['action'],
            'Cron' => (string) $row['cron_expr'],
            'Timezone' => (string) $row['timezone'],
            'Enabled' => (int) $row['enabled'] === 1,
            'LastRunAt' => $row['last_run_at'] !== null ? (int) $row['last_run_at'] : null,
            'NextRunAt' => $row['next_run_at'] !== null ? (int) $row['next_run_at'] : null,
            'LastStatus' => (string) ($row['last_status'] ?? ''),
            'LastError' => (string) ($row['last_error'] ?? ''),
            'CreatedBy' => (string) ($row['created_by'] ?? ''),
            'CreatedAt' => (int) ($row['created_at'] ?? 0),
        ];
    }

    // --- Image CVE scans ---

    /**
     * Soft CVE check for create/deploy flows: never blocks the caller.
     * Prefer cache; on Trivy/agent failure return Status=skipped with a Warning.
     *
     * @param array{id:int,username:string,role:int} $user
     */
    public function softAdviseOneImage(array $ep, int $endpointId, string $ref): array
    {
        $cached = $this->repo->getLatestImageScan($endpointId, $ref, '');
        if ($cached && (int) ($cached['scanned_at'] ?? 0) > time() - ImageUpdateChecker::STACK_CACHE_TTL) {
            $summary = json_decode((string) ($cached['summary_json'] ?? '{}'), true);
            return [
                'ImageRef' => $ref,
                'Status' => (string) ($cached['status'] ?? 'ok'),
                'ScannedAt' => (int) $cached['scanned_at'],
                'Summary' => is_array($summary) ? $summary : [],
                'FromCache' => true,
                'Warning' => null,
                'CacheTtl' => ImageUpdateChecker::STACK_CACHE_TTL,
            ];
        }

        $kind = (string) ($ep['kind'] ?? 'local');
        try {
            if ($kind === 'agent') {
                $parsed = $this->scanImageViaAgent($ep, $ref);
            } else {
                if (!$this->imageScanner->available()) {
                    return [
                        'ImageRef' => $ref,
                        'Status' => 'skipped',
                        'ScannedAt' => null,
                        'Summary' => [],
                        'FromCache' => false,
                        'Warning' => 'Trivy indisponible — déploiement non bloqué',
                    ];
                }
                $parsed = $this->imageScanner->scanImage($ref);
            }
            $row = $this->repo->saveImageScan(
                $endpointId,
                $ref,
                '',
                (string) ($parsed['status'] ?? 'ok'),
                $parsed['summary'] ?? [],
                (string) ($parsed['raw'] ?? ''),
                $parsed['findings'] ?? [],
            );
            return [
                'ImageRef' => $ref,
                'Status' => (string) ($row['status'] ?? 'ok'),
                'ScannedAt' => (int) ($row['scanned_at'] ?? time()),
                'Summary' => $parsed['summary'] ?? [],
                'FromCache' => false,
                'Warning' => null,
            ];
        } catch (\Throwable $e) {
            return [
                'ImageRef' => $ref,
                'Status' => 'skipped',
                'ScannedAt' => null,
                'Summary' => [],
                'FromCache' => false,
                'Warning' => 'Scan CVE impossible : ' . $e->getMessage() . ' — déploiement non bloqué',
            ];
        }
    }

    /** @return list<string> */
    public function extractComposeImageRefs(string $compose): array
    {
        $refs = [];
        if (preg_match_all('/^\s*image:\s*["\']?([^\s"\'#]+)/mi', $compose, $m)) {
            foreach ($m[1] as $raw) {
                $ref = trim((string) $raw);
                if ($ref !== '' && !str_starts_with($ref, '$')) {
                    $refs[] = $ref;
                }
            }
        }
        return array_values(array_unique($refs));
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function scanImageViaAgent(array $ep, string $imageRef): array
    {
        $url = rtrim((string) ($ep['agent_url'] ?? ''), '/');
        $secret = (string) ($ep['agent_secret'] ?? '');
        if ($url === '' || $secret === '') {
            throw new \RuntimeException('Agent non configuré');
        }
        $ch = curl_init($url . '/scan/image');
        if (!$ch) {
            throw new \RuntimeException('curl init failed');
        }
        $payload = json_encode(['image' => $imageRef], JSON_UNESCAPED_SLASHES) ?: '{}';
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_HTTPHEADER => [
                'Authorization: Bearer ' . $secret,
                'Content-Type: application/json',
                'Accept: application/json',
            ],
            CURLOPT_TIMEOUT => 360,
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_SSL_VERIFYHOST => 0,
        ]);
        $fp = trim((string) ($ep['tls_fingerprint'] ?? ''));
        if ($fp !== '') {
            // pinning handled by AgentTls elsewhere; keep soft verify for scan
        }
        $body = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($body === false || $code >= 400) {
            throw new \RuntimeException($err !== '' ? $err : ('Agent scan HTTP ' . $code . ': ' . (string) $body));
        }
        $json = json_decode((string) $body, true);
        if (!is_array($json)) {
            throw new \RuntimeException('Réponse agent invalide');
        }
        if (isset($json['raw']) && is_string($json['raw'])) {
            return $this->imageScanner->parseTrivyJson($json['raw']);
        }
        return [
            'summary' => is_array($json['summary'] ?? null) ? $json['summary'] : [],
            'findings' => is_array($json['findings'] ?? null) ? $json['findings'] : [],
            'raw' => (string) ($json['raw'] ?? $body),
            'status' => (string) ($json['status'] ?? 'ok'),
        ];
    }

    public function controlStack(int $id, string $action, Request $request, array $user): Response
    {
        $stack = $this->repo->getStack($id);
        if (!$stack || !$this->canAccessStack($stack, $user)) {
            return Response::error('Stack introuvable', 404);
        }
        if (!$this->canOperateStack($stack, $user)) {
            return Response::error('Permissions insuffisantes (lecture seule)', 403);
        }
        if (!in_array($action, ['start', 'stop', 'restart'], true)) {
            return Response::error('Action invalide', 400);
        }
        $ep = $this->repo->getEndpoint((int) $stack['endpoint_id']);
        if (!$ep) {
            return Response::error('Environnement introuvable', 404);
        }
        $env = json_decode($stack['env_json'], true);
        if (!is_array($env)) {
            $env = [];
        }
        $name = (string) $stack['name'];
        $entry = (string) ($stack['entry_point'] ?? 'docker-compose.yml');
        $isAgent = ($ep['kind'] ?? 'local') === 'agent';
        try {
            if ($isAgent) {
                $client = $this->agentComposeClient($ep);
                match ($action) {
                    'start' => $client->start($name, $env, $entry),
                    'stop' => $client->stop($name, $env, $entry),
                    default => $client->restart($name, $env, $entry),
                };
            } else {
                match ($action) {
                    'start' => $this->compose->start($stack['project_path'], $name, $env),
                    'stop' => $this->compose->stop($stack['project_path'], $name, $env),
                    default => $this->compose->restart($stack['project_path'], $name, $env),
                };
            }
            $status = $action === 'stop' ? 2 : 1;
            $row = $this->repo->setStackStatus($id, $status);
        } catch (\Throwable $e) {
            return Response::error($e->getMessage(), 500);
        }
        $labels = ['start' => 'Démarrage', 'stop' => 'Arrêt', 'restart' => 'Redémarrage'];
        $this->audit(
            $user,
            'stack.' . $action,
            ($labels[$action] ?? $action) . ' de la stack « ' . $name . ' »',
            $request,
            ['stackId' => $id, 'name' => $name],
        );
        return Response::json($this->formatStack($row ?? $stack));
    }

    /** @param array<string, mixed> $ep */
}
