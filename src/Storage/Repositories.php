<?php
declare(strict_types=1);

namespace App\Storage;

use App\Security\SecretBox;
use PDO;

final class Repositories
{
    private ?SecretBox $secrets = null;

    public function __construct(private readonly PDO $pdo, ?SecretBox $secrets = null)
    {
        $this->secrets = $secrets;
    }

    public function setSecretBox(SecretBox $secrets): void
    {
        $this->secrets = $secrets;
    }

    private function sealRegistryPassword(string $password): string
    {
        if ($this->secrets === null || $password === '') {
            return $password;
        }
        return $this->secrets->encrypt($password);
    }

    private function openRegistryPassword(string $stored): string
    {
        if ($this->secrets === null || $stored === '') {
            return $stored;
        }
        try {
            return $this->secrets->decrypt($stored);
        } catch (\Throwable) {
            return $stored;
        }
    }

    /** Encrypt any leftover plaintext registry passwords (idempotent). */
    public function migrateRegistryPasswords(): void
    {
        if ($this->secrets === null) {
            return;
        }
        $rows = $this->pdo->query('SELECT id, password FROM registries')->fetchAll() ?: [];
        $stmt = $this->pdo->prepare('UPDATE registries SET password = ? WHERE id = ?');
        foreach ($rows as $row) {
            $pass = (string) ($row['password'] ?? '');
            if ($pass === '' || $this->secrets->isEncrypted($pass)) {
                continue;
            }
            $stmt->execute([$this->secrets->encrypt($pass), (int) $row['id']]);
        }
    }

    public function userCount(): int
    {
        return (int) $this->pdo->query('SELECT COUNT(*) FROM users')->fetchColumn();
    }

    /** @return array<string, mixed>|null */
    public function findUserByUsername(string $username): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM users WHERE username = ?');
        $stmt->execute([$username]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /** @return array<string, mixed>|null */
    public function findUserById(int $id): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM users WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    public function createAdmin(string $username, string $password): array
    {
        return $this->createUser($username, $password, 1);
    }

    /** @return list<array<string, mixed>> */
    public function listUsers(): array
    {
        return $this->pdo->query(
            'SELECT id, username, role, created_at, auth_source FROM users ORDER BY id ASC'
        )->fetchAll() ?: [];
    }

    public function createUser(string $username, string $password, int $role = 2): array
    {
        $hash = password_hash($password, PASSWORD_DEFAULT);
        $now = time();
        $stmt = $this->pdo->prepare(
            'INSERT INTO users (username, password_hash, role, created_at, auth_source) VALUES (?, ?, ?, ?, \'local\')'
        );
        $stmt->execute([$username, $hash, $role, $now]);
        $id = (int) $this->pdo->lastInsertId();
        if ($role !== 1) {
            $this->seedOperateAclForUser($id);
        }
        return $this->findUserById($id) ?? [
            'id' => $id,
            'username' => $username,
            'role' => $role,
            'created_at' => $now,
            'auth_source' => 'local',
        ];
    }

    public function updateUserPassword(int $id, string $password): void
    {
        $hash = password_hash($password, PASSWORD_DEFAULT);
        $stmt = $this->pdo->prepare('UPDATE users SET password_hash = ? WHERE id = ?');
        $stmt->execute([$hash, $id]);
    }

    public function deleteUser(int $id): void
    {
        $stmt = $this->pdo->prepare('DELETE FROM users WHERE id = ?');
        $stmt->execute([$id]);
    }

    /**
     * Rename / retarget an endpoint (local or agent).
     *
     * @param array{name?:string,node_name?:string,agent_url?:string,public_url?:string,clear_tls_pin?:bool} $fields
     */
    public function updateEndpointDetails(int $id, array $fields): ?array
    {
        $ep = $this->getEndpoint($id);
        if (!$ep) {
            return null;
        }
        $name = array_key_exists('name', $fields)
            ? trim((string) $fields['name'])
            : (string) ($ep['name'] ?? '');
        $nodeName = array_key_exists('node_name', $fields)
            ? trim((string) $fields['node_name'])
            : (string) ($ep['node_name'] ?? $name);
        if ($nodeName === '') {
            $nodeName = $name;
        }
        if ($name === '') {
            $name = $nodeName;
        }
        $publicUrl = array_key_exists('public_url', $fields)
            ? rtrim(trim((string) $fields['public_url']), '/')
            : (string) ($ep['public_url'] ?? '');
        $agentUrl = (string) ($ep['agent_url'] ?? '');
        $url = (string) ($ep['url'] ?? '');
        $clearPin = !empty($fields['clear_tls_pin']);
        if (($ep['kind'] ?? '') === 'agent' && array_key_exists('agent_url', $fields)) {
            $agentUrl = rtrim(trim((string) $fields['agent_url']), '/');
            $url = $agentUrl;
            $prev = rtrim(trim((string) ($ep['agent_url'] ?? '')), '/');
            if ($agentUrl !== $prev) {
                $clearPin = true;
            }
        }
        if ($clearPin) {
            $stmt = $this->pdo->prepare(
                'UPDATE endpoints SET name = ?, node_name = ?, public_url = ?, url = ?, agent_url = ?, tls_fingerprint = \'\' WHERE id = ?'
            );
            $stmt->execute([$name, $nodeName, $publicUrl, $url, $agentUrl, $id]);
        } else {
            $stmt = $this->pdo->prepare(
                'UPDATE endpoints SET name = ?, node_name = ?, public_url = ?, url = ?, agent_url = ? WHERE id = ?'
            );
            $stmt->execute([$name, $nodeName, $publicUrl, $url, $agentUrl, $id]);
        }
        return $this->getEndpoint($id);
    }

    public function updateEndpointPublicUrl(int $id, string $publicUrl): void
    {
        $stmt = $this->pdo->prepare('UPDATE endpoints SET public_url = ? WHERE id = ?');
        $stmt->execute([$publicUrl, $id]);
    }

    /** Clear endpoint public_url values that still hold a legacy WharfMaster URL. */
    public function clearEndpointPublicUrlsMatching(string $url): int
    {
        $url = rtrim(trim($url), '/');
        if ($url === '') {
            return 0;
        }
        $stmt = $this->pdo->prepare(
            'UPDATE endpoints SET public_url = \'\' WHERE public_url = ? OR rtrim(public_url, \'/\') = ?'
        );
        $stmt->execute([$url, $url]);
        return $stmt->rowCount();
    }

    public function createApiKey(int $userId, string $description, string $rawKey): array
    {
        $prefix = substr($rawKey, 0, 8);
        $hash = hash('sha256', $rawKey);
        $now = time();
        $stmt = $this->pdo->prepare(
            'INSERT INTO api_keys (user_id, description, prefix, hash, raw_hint, date_created)
             VALUES (?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([$userId, $description, $prefix, $hash, substr($rawKey, -4), $now]);
        return [
            'id' => (int) $this->pdo->lastInsertId(),
            'user_id' => $userId,
            'description' => $description,
            'prefix' => $prefix,
            'dateCreated' => $now,
        ];
    }

    /** @return list<array<string, mixed>> */
    public function listApiKeysForUser(int $userId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT id, user_id, description, prefix, raw_hint, date_created, last_used
             FROM api_keys WHERE user_id = ? ORDER BY date_created DESC, id DESC'
        );
        $stmt->execute([$userId]);
        return $stmt->fetchAll() ?: [];
    }

    /** @return array<string, mixed>|null */
    public function findApiKeyById(int $id): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM api_keys WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    public function deleteApiKey(int $id): void
    {
        $stmt = $this->pdo->prepare('DELETE FROM api_keys WHERE id = ?');
        $stmt->execute([$id]);
    }

    /** @return array<string, mixed>|null */
    public function findApiKeyByRaw(string $rawKey): ?array
    {
        $hash = hash('sha256', $rawKey);
        $stmt = $this->pdo->prepare(
            'SELECT k.*, u.username, u.role FROM api_keys k
             JOIN users u ON u.id = k.user_id
             WHERE k.hash = ?'
        );
        $stmt->execute([$hash]);
        $row = $stmt->fetch();
        if ($row) {
            $upd = $this->pdo->prepare('UPDATE api_keys SET last_used = ? WHERE id = ?');
            $upd->execute([time(), $row['id']]);
        }
        return $row ?: null;
    }

    public function ensureLocalEndpoint(string $socketPath): array
    {
        $existing = $this->pdo->query('SELECT * FROM endpoints ORDER BY id ASC LIMIT 1')->fetch();
        if ($existing) {
            // Ensure local metadata
            $this->pdo->prepare(
                "UPDATE endpoints SET kind = 'local', node_name = COALESCE(NULLIF(node_name,''), name), url = ? WHERE id = ?"
            )->execute(['unix://' . $socketPath, (int) $existing['id']]);
            return $this->getEndpoint((int) $existing['id']) ?? $existing;
        }
        $now = time();
        $stmt = $this->pdo->prepare(
            'INSERT INTO endpoints (id, name, type, url, group_id, public_url, status, snapshots, created_at, kind, node_name)
             VALUES (1, ?, 1, ?, 1, ?, 1, ?, ?, \'local\', ?)'
        );
        $stmt->execute([
            'local',
            'unix://' . $socketPath,
            '',
            '[]',
            $now,
            'local',
        ]);
        return $this->getEndpoint(1) ?? [
            'id' => 1,
            'name' => 'local',
            'type' => 1,
            'url' => 'unix://' . $socketPath,
            'group_id' => 1,
            'public_url' => '',
            'status' => 1,
            'snapshots' => '[]',
            'created_at' => $now,
            'kind' => 'local',
            'node_name' => 'local',
        ];
    }

    public function createAgentEndpoint(string $name, string $agentUrl, string $agentSecret): array
    {
        $now = time();
        $stmt = $this->pdo->prepare(
            'INSERT INTO endpoints
            (name, type, url, group_id, public_url, status, snapshots, created_at, kind, agent_url, agent_secret, node_name, joined_at, last_seen_at)
            VALUES (?, 2, ?, 1, \'\', 1, \'[]\', ?, \'agent\', ?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $name,
            $agentUrl,
            $now,
            $agentUrl,
            $agentSecret,
            $name,
            $now,
            $now,
        ]);
        $id = (int) $this->pdo->lastInsertId();
        $this->seedOperateAclForEndpoint($id);
        return $this->getEndpoint($id) ?? [];
    }

    /** Re-join existing agent: rotate secret, refresh name/status (idempotent install). */
    public function rejoinAgentEndpoint(int $id, string $name, string $agentSecret): array
    {
        $now = time();
        $stmt = $this->pdo->prepare(
            'UPDATE endpoints SET name = ?, node_name = ?, agent_secret = ?, status = 1,
             joined_at = ?, last_seen_at = ? WHERE id = ? AND kind = \'agent\''
        );
        $stmt->execute([$name, $name, $agentSecret, $now, $now, $id]);
        return $this->getEndpoint($id) ?? [];
    }

    public function updateEndpointLastSeen(int $id, ?int $status = null): void
    {
        if ($status !== null) {
            $stmt = $this->pdo->prepare('UPDATE endpoints SET last_seen_at = ?, status = ? WHERE id = ?');
            $stmt->execute([time(), $status, $id]);
            return;
        }
        $stmt = $this->pdo->prepare('UPDATE endpoints SET last_seen_at = ? WHERE id = ?');
        $stmt->execute([time(), $id]);
    }

    public function updateEndpointTlsExpires(int $id, ?int $tlsExpiresAt): void
    {
        $stmt = $this->pdo->prepare('UPDATE endpoints SET tls_expires_at = ? WHERE id = ?');
        $stmt->execute([$tlsExpiresAt, $id]);
    }

    public function updateEndpointTlsFingerprint(int $id, string $fingerprint): void
    {
        $stmt = $this->pdo->prepare('UPDATE endpoints SET tls_fingerprint = ? WHERE id = ?');
        $stmt->execute([strtolower(trim($fingerprint)), $id]);
    }

    public function updateEndpointTlsMeta(int $id, ?int $tlsExpiresAt, ?string $fingerprint): void
    {
        if ($fingerprint !== null && $fingerprint !== '' && $tlsExpiresAt !== null) {
            $stmt = $this->pdo->prepare('UPDATE endpoints SET tls_expires_at = ?, tls_fingerprint = ? WHERE id = ?');
            $stmt->execute([$tlsExpiresAt, strtolower(trim($fingerprint)), $id]);
            return;
        }
        if ($fingerprint !== null && $fingerprint !== '') {
            $this->updateEndpointTlsFingerprint($id, $fingerprint);
        }
        if ($tlsExpiresAt !== null) {
            $this->updateEndpointTlsExpires($id, $tlsExpiresAt);
        }
    }

    public function setEndpointStatus(int $id, int $status): void
    {
        $stmt = $this->pdo->prepare('UPDATE endpoints SET status = ? WHERE id = ?');
        $stmt->execute([$status, $id]);
    }

    public function clearEndpointAgentSecret(int $id): void
    {
        $stmt = $this->pdo->prepare("UPDATE endpoints SET agent_secret = '', status = 2 WHERE id = ?");
        $stmt->execute([$id]);
    }

    public function deleteEndpoint(int $id): void
    {
        if ($id <= 1) {
            return;
        }
        $stmt = $this->pdo->prepare('DELETE FROM endpoints WHERE id = ? AND kind = \'agent\'');
        $stmt->execute([$id]);
    }

    public function findEndpointByAgentUrl(string $agentUrl): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM endpoints WHERE agent_url = ? LIMIT 1');
        $stmt->execute([rtrim($agentUrl, '/')]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /**
     * @return array{token:string, row:array<string,mixed>}
     */
    public function createJoinToken(string $createdBy, string $label = '', int $ttlSeconds = 86400, ?int $maxUses = null): array
    {
        $raw = 'wmj_' . bin2hex(random_bytes(24));
        $now = time();
        $stmt = $this->pdo->prepare(
            'INSERT INTO join_tokens
            (token_hash, token_hint, label, created_at, created_by, expires_at, revoked_at, max_uses, use_count)
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0)'
        );
        $stmt->execute([
            hash('sha256', $raw),
            substr($raw, -6),
            $label,
            $now,
            $createdBy,
            $now + max(60, $ttlSeconds),
            $maxUses,
        ]);
        $id = (int) $this->pdo->lastInsertId();
        $row = $this->getJoinToken($id) ?? [];
        return ['token' => $raw, 'row' => $row];
    }

    /** @return array<string, mixed>|null */
    public function getJoinToken(int $id): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM join_tokens WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /** @return array<string, mixed>|null */
    public function getActiveJoinToken(): ?array
    {
        $now = time();
        $stmt = $this->pdo->prepare(
            'SELECT * FROM join_tokens
             WHERE revoked_at IS NULL AND expires_at > ?
             ORDER BY id DESC LIMIT 1'
        );
        $stmt->execute([$now]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    public function revokeJoinToken(int $id): void
    {
        $stmt = $this->pdo->prepare('UPDATE join_tokens SET revoked_at = ? WHERE id = ?');
        $stmt->execute([time(), $id]);
    }

    public function revokeAllJoinTokens(): void
    {
        $this->pdo->prepare(
            'UPDATE join_tokens SET revoked_at = ? WHERE revoked_at IS NULL'
        )->execute([time()]);
    }

    /** @return array<string, mixed>|null */
    public function findValidJoinToken(string $raw): ?array
    {
        $hash = hash('sha256', $raw);
        $stmt = $this->pdo->prepare('SELECT * FROM join_tokens WHERE token_hash = ?');
        $stmt->execute([$hash]);
        $row = $stmt->fetch();
        if (!$row) {
            return null;
        }
        if ($row['revoked_at'] !== null) {
            return null;
        }
        if ((int) $row['expires_at'] < time()) {
            return null;
        }
        if ($row['max_uses'] !== null && (int) $row['use_count'] >= (int) $row['max_uses']) {
            return null;
        }
        return $row;
    }

    public function incrementJoinTokenUse(int $id): void
    {
        $this->pdo->prepare('UPDATE join_tokens SET use_count = use_count + 1 WHERE id = ?')->execute([$id]);
    }

    /** @return list<array<string, mixed>> */
    public function listEndpoints(): array
    {
        return $this->pdo->query('SELECT * FROM endpoints ORDER BY id ASC')->fetchAll() ?: [];
    }

    /** @return array<string, mixed>|null */
    public function getEndpoint(int $id): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM endpoints WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /** @return list<array<string, mixed>> */
    public function listStacks(?int $endpointId = null): array
    {
        if ($endpointId !== null) {
            $stmt = $this->pdo->prepare('SELECT * FROM stacks WHERE endpoint_id = ? ORDER BY id ASC');
            $stmt->execute([$endpointId]);
            return $stmt->fetchAll() ?: [];
        }
        return $this->pdo->query('SELECT * FROM stacks ORDER BY id ASC')->fetchAll() ?: [];
    }

    /** @return array<string, mixed>|null */
    public function getStack(int $id): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM stacks WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /** @param list<array{name?:string,value?:string}> $env */
    public function createStack(
        string $name,
        int $endpointId,
        string $projectPath,
        string $entryPoint,
        array $env,
        string $createdBy,
    ): array {
        $now = time();
        $stmt = $this->pdo->prepare(
            'INSERT INTO stacks
            (name, type, endpoint_id, swarm_id, entry_point, env_json, status, project_path, creation_date, created_by)
            VALUES (?, 2, ?, \'\', ?, ?, 1, ?, ?, ?)'
        );
        $stmt->execute([
            $name,
            $endpointId,
            $entryPoint,
            json_encode($env, JSON_UNESCAPED_SLASHES) ?: '[]',
            $projectPath,
            $now,
            $createdBy,
        ]);
        return $this->getStack((int) $this->pdo->lastInsertId()) ?? [];
    }

    /** @param list<array{name?:string,value?:string}> $env */
    public function updateStack(int $id, array $env, string $updatedBy): ?array
    {
        $stmt = $this->pdo->prepare(
            'UPDATE stacks SET env_json = ?, update_date = ?, updated_by = ? WHERE id = ?'
        );
        $stmt->execute([
            json_encode($env, JSON_UNESCAPED_SLASHES) ?: '[]',
            time(),
            $updatedBy,
            $id,
        ]);
        return $this->getStack($id);
    }

    public function deleteStack(int $id): void
    {
        $stmt = $this->pdo->prepare('DELETE FROM stacks WHERE id = ?');
        $stmt->execute([$id]);
    }

    /** Status: 1 = active, 2 = stopped */
    public function setStackStatus(int $id, int $status): ?array
    {
        $stmt = $this->pdo->prepare('UPDATE stacks SET status = ?, update_date = ? WHERE id = ?');
        $stmt->execute([$status, time(), $id]);
        return $this->getStack($id);
    }

    public function getSetting(string $key, ?string $default = null): ?string
    {
        $stmt = $this->pdo->prepare('SELECT value FROM settings WHERE key = ?');
        $stmt->execute([$key]);
        $val = $stmt->fetchColumn();
        return $val === false ? $default : (string) $val;
    }

    public function setSetting(string $key, string $value): void
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO settings (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        );
        $stmt->execute([$key, $value]);
    }

    /** @return list<array<string, mixed>> */
    public function listRegistries(): array
    {
        return $this->pdo->query('SELECT * FROM registries ORDER BY id ASC')->fetchAll() ?: [];
    }

    /** @return array<string, mixed>|null */
    public function getRegistry(int $id): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM registries WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        if (!$row) {
            return null;
        }
        $row['password'] = $this->openRegistryPassword((string) ($row['password'] ?? ''));
        return $row;
    }

    public function createRegistry(
        string $name,
        string $url,
        string $username,
        string $password,
        string $type,
        ?int $ownerId = null,
        string $ownerUsername = '',
        bool $shared = false,
    ): array {
        $now = time();
        $stmt = $this->pdo->prepare(
            'INSERT INTO registries (name, url, username, password, type, created_at, owner_id, owner_username, is_shared)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $name,
            $url,
            $username,
            $this->sealRegistryPassword($password),
            $type,
            $now,
            $ownerId,
            $ownerUsername,
            $shared ? 1 : 0,
        ]);
        return $this->getRegistry((int) $this->pdo->lastInsertId()) ?? [];
    }

    /** @return list<array<string, mixed>> */
    public function listRegistriesForUser(?int $userId, bool $isAdmin): array
    {
        if ($isAdmin) {
            return $this->listRegistries();
        }
        $stmt = $this->pdo->prepare(
            'SELECT * FROM registries
             WHERE is_shared = 1 OR owner_id = ?
             ORDER BY id ASC'
        );
        $stmt->execute([$userId ?? 0]);
        return $stmt->fetchAll() ?: [];
    }

    /**
     * Stacks owned by the user OR shared with them (independent of endpoint ACL).
     * Pass $userId to include resource_shares; without it, ownership-only (legacy).
     *
     * @return list<array<string, mixed>>
     */
    public function listStacksForUser(?string $username, bool $isAdmin, ?int $endpointId = null, ?int $userId = null): array
    {
        if ($isAdmin) {
            return $this->listStacks($endpointId);
        }
        $uname = $username ?? '';
        $uid = $userId ?? 0;
        if ($endpointId !== null) {
            if ($uid > 0) {
                $stmt = $this->pdo->prepare(
                    "SELECT DISTINCT s.* FROM stacks s
                     LEFT JOIN resource_shares sh
                       ON sh.resource_type = 'stack'
                      AND sh.endpoint_id = s.endpoint_id
                      AND sh.resource_key = CAST(s.id AS TEXT)
                      AND sh.grantee_type = 'user'
                      AND sh.grantee_id = ?
                     WHERE s.endpoint_id = ?
                       AND (s.created_by = ? OR sh.id IS NOT NULL)
                     ORDER BY s.id ASC"
                );
                $stmt->execute([$uid, $endpointId, $uname]);
                return $stmt->fetchAll() ?: [];
            }
            $stmt = $this->pdo->prepare(
                'SELECT * FROM stacks WHERE endpoint_id = ? AND created_by = ? ORDER BY id ASC'
            );
            $stmt->execute([$endpointId, $uname]);
            return $stmt->fetchAll() ?: [];
        }
        if ($uid > 0) {
            $stmt = $this->pdo->prepare(
                "SELECT DISTINCT s.* FROM stacks s
                 LEFT JOIN resource_shares sh
                   ON sh.resource_type = 'stack'
                  AND sh.endpoint_id = s.endpoint_id
                  AND sh.resource_key = CAST(s.id AS TEXT)
                  AND sh.grantee_type = 'user'
                  AND sh.grantee_id = ?
                 WHERE s.created_by = ? OR sh.id IS NOT NULL
                 ORDER BY s.id ASC"
            );
            $stmt->execute([$uid, $uname]);
            return $stmt->fetchAll() ?: [];
        }
        $stmt = $this->pdo->prepare('SELECT * FROM stacks WHERE created_by = ? ORDER BY id ASC');
        $stmt->execute([$uname]);
        return $stmt->fetchAll() ?: [];
    }

    public function updateRegistry(
        int $id,
        string $name,
        string $url,
        string $username,
        ?string $password,
        string $type,
    ): ?array {
        $existing = $this->getRegistry($id);
        if (!$existing) {
            return null;
        }
        $passPlain = $password !== null ? $password : (string) $existing['password'];
        $pass = $this->sealRegistryPassword($passPlain);
        $stmt = $this->pdo->prepare(
            'UPDATE registries SET name = ?, url = ?, username = ?, password = ?, type = ? WHERE id = ?'
        );
        $stmt->execute([$name, $url, $username, $pass, $type, $id]);
        return $this->getRegistry($id);
    }

    public function deleteRegistry(int $id): void
    {
        $stmt = $this->pdo->prepare('DELETE FROM registries WHERE id = ?');
        $stmt->execute([$id]);
    }

    public function ensureDefaultHubRegistry(): void
    {
        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM registries')->fetchColumn();
        if ($count > 0) {
            return;
        }
        $this->createRegistry('Docker Hub', 'https://docker.io', '', '', 'hub', null, '', true);
    }

    /**
     * @param array<string, mixed> $meta
     */
    public function addAuditEvent(
        ?int $userId,
        string $username,
        string $action,
        string $message,
        string $ip = '',
        array $meta = [],
    ): void {
        $stmt = $this->pdo->prepare(
            'INSERT INTO audit_events (created_at, user_id, username, action, message, ip, meta_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            time(),
            $userId,
            $username,
            $action,
            $message,
            $ip,
            json_encode($meta === [] ? new \stdClass() : $meta, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '{}',
        ]);
        // Keep the table bounded (~5000 latest events)
        $cutoff = $this->pdo->query(
            'SELECT id FROM audit_events ORDER BY id DESC LIMIT 1 OFFSET 4999'
        )->fetchColumn();
        if ($cutoff) {
            $del = $this->pdo->prepare('DELETE FROM audit_events WHERE id < ?');
            $del->execute([(int) $cutoff]);
        }
    }

    /**
     * @return list<array<string, mixed>>
     */
    public function listAuditEvents(int $limit = 100, int $offset = 0, ?string $action = null, ?int $userId = null): array
    {
        $limit = max(1, min(500, $limit));
        $offset = max(0, $offset);
        $sql = 'SELECT id, created_at, user_id, username, action, message, ip, meta_json
                FROM audit_events';
        $where = [];
        $params = [];
        if ($action !== null && $action !== '') {
            $where[] = 'action LIKE ?';
            $params[] = $action . '%';
        }
        if ($userId !== null) {
            $where[] = 'user_id = ?';
            $params[] = $userId;
        }
        if ($where) {
            $sql .= ' WHERE ' . implode(' AND ', $where);
        }
        $sql .= ' ORDER BY id DESC LIMIT ' . $limit . ' OFFSET ' . $offset;
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($params);
        return $stmt->fetchAll() ?: [];
    }

    public function countAuditEvents(?string $action = null, ?int $userId = null): int
    {
        $sql = 'SELECT COUNT(*) FROM audit_events';
        $where = [];
        $params = [];
        if ($action !== null && $action !== '') {
            $where[] = 'action LIKE ?';
            $params[] = $action . '%';
        }
        if ($userId !== null) {
            $where[] = 'user_id = ?';
            $params[] = $userId;
        }
        if ($where) {
            $sql .= ' WHERE ' . implode(' AND ', $where);
        }
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($params);
        return (int) $stmt->fetchColumn();
    }

    /**
     * Metric scopes: ep:{id}, all, or ctr:{ep}:{containerId}.
     * Must stay long enough for ctr:{ep}:{64-hex} (~70 chars). Legacy rows used a 64-char truncate.
     */
    private function normalizeMetricScope(string $scope): string
    {
        $scope = trim($scope);
        if ($scope === '') {
            return 'ep:1';
        }
        if (strlen($scope) > 96) {
            return substr($scope, 0, 96);
        }
        return $scope;
    }

    /** @return list<string> */
    private function metricScopeLookupKeys(string $scope): array
    {
        $scope = $this->normalizeMetricScope($scope);
        $keys = [$scope];
        // Pre-2.2.1 writes truncated to 64 chars — still readable
        if (strlen($scope) > 64) {
            $keys[] = substr($scope, 0, 64);
        }
        return array_values(array_unique($keys));
    }

    /**
     * Persist a dashboard metric sample (min gap per scope). Purges rows older than retentionDays.
     * @param array{containers?:int,images?:int,volumes?:int,networks?:int,cpu?:float,mem?:float,disk?:float} $metrics
     * @return array{inserted:bool,sample:array<string,mixed>,purged:int}
     */
    public function recordMetricSample(string $scope, array $metrics, int $minGapSec = 300, int $retentionDays = 90): array
    {
        $scope = $this->normalizeMetricScope($scope);
        // Migrate legacy truncated ctr scopes to the full key
        if (strlen($scope) > 64 && str_starts_with($scope, 'ctr:')) {
            $legacy = substr($scope, 0, 64);
            $mig = $this->pdo->prepare('UPDATE metric_samples SET scope = ? WHERE scope = ?');
            $mig->execute([$scope, $legacy]);
        }
        $now = time();
        $last = $this->pdo->prepare('SELECT sampled_at FROM metric_samples WHERE scope = ? ORDER BY sampled_at DESC LIMIT 1');
        $last->execute([$scope]);
        $lastAt = (int) ($last->fetchColumn() ?: 0);
        $inserted = false;
        $sample = [
            't' => $now * 1000,
            'containers' => (int) ($metrics['containers'] ?? 0),
            'images' => (int) ($metrics['images'] ?? 0),
            'volumes' => (int) ($metrics['volumes'] ?? 0),
            'networks' => (int) ($metrics['networks'] ?? 0),
            'cpu' => round((float) ($metrics['cpu'] ?? 0), 2),
            'mem' => round((float) ($metrics['mem'] ?? 0), 2),
            'disk' => round((float) ($metrics['disk'] ?? 0), 2),
        ];
        if ($lastAt <= 0 || ($now - $lastAt) >= $minGapSec) {
            $ins = $this->pdo->prepare(
                'INSERT INTO metric_samples (scope, sampled_at, containers, images, volumes, networks, cpu, mem, disk)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
            );
            $ins->execute([
                $scope,
                $now,
                $sample['containers'],
                $sample['images'],
                $sample['volumes'],
                $sample['networks'],
                $sample['cpu'],
                $sample['mem'],
                $sample['disk'],
            ]);
            $inserted = true;
        } else {
            // Refresh latest row in-place (same window) so host % stay current
            $upd = $this->pdo->prepare(
                'UPDATE metric_samples SET sampled_at = ?, containers = ?, images = ?, volumes = ?, networks = ?, cpu = ?, mem = ?, disk = ?
                 WHERE id = (SELECT id FROM metric_samples WHERE scope = ? ORDER BY sampled_at DESC LIMIT 1)'
            );
            $upd->execute([
                $now,
                $sample['containers'],
                $sample['images'],
                $sample['volumes'],
                $sample['networks'],
                $sample['cpu'],
                $sample['mem'],
                $sample['disk'],
                $scope,
            ]);
            $sample['t'] = $now * 1000;
        }

        $cutoff = $now - max(1, $retentionDays) * 86400;
        $purge = $this->pdo->prepare('DELETE FROM metric_samples WHERE sampled_at < ?');
        $purge->execute([$cutoff]);
        $purged = $purge->rowCount();

        return ['inserted' => $inserted, 'sample' => $sample, 'purged' => $purged];
    }

    /**
     * History for charts. Prefer $hours (rolling window); falls back to $days.
     * Downsamples evenly when denser than $maxPoints.
     * @return list<array{t:int,containers:int,images:int,volumes:int,networks:int,cpu:float,mem:float,disk:float}>
     */
    /**
     * @param ?int $hours Window length in hours (preferred over $days when set)
     * @param ?int $until Unix end of window (default: now) — allows paging through retention
     */
    public function listMetricSamples(string $scope, int $days = 90, int $maxPoints = 180, ?int $hours = null, ?int $until = null): array
    {
        $keys = $this->metricScopeLookupKeys($scope);
        $maxPoints = max(10, min(2000, $maxPoints));
        $now = time();
        $days = max(1, min(365, $days));
        $retentionFloor = $now - $days * 86400;
        $untilTs = $until !== null ? min($now, max(0, $until)) : $now;
        if ($hours !== null) {
            $hours = max(1, min(365 * 24, $hours));
            $since = $untilTs - $hours * 3600;
        } else {
            $since = $untilTs - $days * 86400;
        }
        $since = max($since, $retentionFloor);
        if ($since > $untilTs) {
            $since = $untilTs;
        }
        $placeholders = implode(',', array_fill(0, count($keys), '?'));
        $stmt = $this->pdo->prepare(
            "SELECT sampled_at, containers, images, volumes, networks, cpu, mem, disk
             FROM metric_samples WHERE scope IN ($placeholders) AND sampled_at >= ? AND sampled_at <= ? ORDER BY sampled_at ASC"
        );
        $stmt->execute([...$keys, $since, $untilTs]);
        $rows = $stmt->fetchAll() ?: [];
        $mapped = array_map(static function (array $r): array {
            return [
                't' => ((int) $r['sampled_at']) * 1000,
                'containers' => (int) $r['containers'],
                'images' => (int) $r['images'],
                'volumes' => (int) $r['volumes'],
                'networks' => (int) $r['networks'],
                'cpu' => (float) $r['cpu'],
                'mem' => (float) $r['mem'],
                'disk' => (float) $r['disk'],
            ];
        }, $rows);
        $n = count($mapped);
        if ($n <= $maxPoints) {
            return $mapped;
        }
        $out = [];
        for ($i = 0; $i < $maxPoints; $i++) {
            $idx = (int) round($i * ($n - 1) / ($maxPoints - 1));
            $out[] = $mapped[$idx];
        }
        return $out;
    }

    // --- Teams & endpoint ACLs ---

    /** @return list<array<string, mixed>> */
    public function listTeams(): array
    {
        return $this->pdo->query('SELECT * FROM teams ORDER BY name ASC')->fetchAll() ?: [];
    }

    /** @return array<string, mixed>|null */
    public function getTeam(int $id): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM teams WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    public function createTeam(string $name, string $description = '', string $adGroupDn = ''): array
    {
        $now = time();
        $stmt = $this->pdo->prepare(
            'INSERT INTO teams (name, description, ad_group_dn, created_at) VALUES (?, ?, ?, ?)'
        );
        $stmt->execute([$name, $description, $adGroupDn, $now]);
        return $this->getTeam((int) $this->pdo->lastInsertId()) ?? [
            'id' => (int) $this->pdo->lastInsertId(),
            'name' => $name,
            'description' => $description,
            'ad_group_dn' => $adGroupDn,
            'created_at' => $now,
        ];
    }

    public function updateTeam(int $id, string $name, string $description, string $adGroupDn): ?array
    {
        $stmt = $this->pdo->prepare(
            'UPDATE teams SET name = ?, description = ?, ad_group_dn = ? WHERE id = ?'
        );
        $stmt->execute([$name, $description, $adGroupDn, $id]);
        return $this->getTeam($id);
    }

    public function deleteTeam(int $id): void
    {
        $this->pdo->prepare('DELETE FROM teams WHERE id = ?')->execute([$id]);
        $this->pdo->prepare(
            "DELETE FROM endpoint_acls WHERE subject_type = 'team' AND subject_id = ?"
        )->execute([$id]);
    }

    /** @return list<array<string, mixed>> */
    public function listTeamMembers(int $teamId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT u.id, u.username, u.role, u.auth_source, u.created_at
             FROM team_members tm
             JOIN users u ON u.id = tm.user_id
             WHERE tm.team_id = ?
             ORDER BY u.username ASC'
        );
        $stmt->execute([$teamId]);
        return $stmt->fetchAll() ?: [];
    }

    /** @return list<int> */
    public function listTeamIdsForUser(int $userId): array
    {
        $stmt = $this->pdo->prepare('SELECT team_id FROM team_members WHERE user_id = ?');
        $stmt->execute([$userId]);
        return array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN) ?: []);
    }

    public function addTeamMember(int $teamId, int $userId): void
    {
        $this->pdo->prepare(
            'INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)'
        )->execute([$teamId, $userId]);
    }

    public function removeTeamMember(int $teamId, int $userId): void
    {
        $this->pdo->prepare(
            'DELETE FROM team_members WHERE team_id = ? AND user_id = ?'
        )->execute([$teamId, $userId]);
    }

    /** Replace LDAP-synced memberships for a user based on matched team ids. */
    public function syncUserTeamMemberships(int $userId, array $teamIds): void
    {
        $teamIds = array_values(array_unique(array_map('intval', $teamIds)));
        $ldapTeams = $this->pdo->query(
            "SELECT id FROM teams WHERE ad_group_dn IS NOT NULL AND TRIM(ad_group_dn) != ''"
        )->fetchAll(PDO::FETCH_COLUMN) ?: [];
        $ldapTeamIds = array_map('intval', $ldapTeams);
        if ($ldapTeamIds !== []) {
            $placeholders = implode(',', array_fill(0, count($ldapTeamIds), '?'));
            $params = array_merge([$userId], $ldapTeamIds);
            $this->pdo->prepare(
                "DELETE FROM team_members WHERE user_id = ? AND team_id IN ($placeholders)"
            )->execute($params);
        }
        foreach ($teamIds as $tid) {
            if ($tid > 0) {
                $this->addTeamMember($tid, $userId);
            }
        }
    }

    /** @return list<array<string, mixed>> */
    public function listEndpointAcls(?int $endpointId = null): array
    {
        if ($endpointId !== null) {
            $stmt = $this->pdo->prepare(
                'SELECT * FROM endpoint_acls WHERE endpoint_id = ? ORDER BY subject_type, subject_id'
            );
            $stmt->execute([$endpointId]);
            return $stmt->fetchAll() ?: [];
        }
        return $this->pdo->query(
            'SELECT * FROM endpoint_acls ORDER BY endpoint_id, subject_type, subject_id'
        )->fetchAll() ?: [];
    }

    public function upsertEndpointAcl(int $endpointId, string $subjectType, int $subjectId, string $role): array
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO endpoint_acls (endpoint_id, subject_type, subject_id, role)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(endpoint_id, subject_type, subject_id) DO UPDATE SET role = excluded.role'
        );
        $stmt->execute([$endpointId, $subjectType, $subjectId, $role]);
        $get = $this->pdo->prepare(
            'SELECT * FROM endpoint_acls WHERE endpoint_id = ? AND subject_type = ? AND subject_id = ?'
        );
        $get->execute([$endpointId, $subjectType, $subjectId]);
        return $get->fetch() ?: [];
    }

    public function deleteEndpointAcl(int $id): void
    {
        $this->pdo->prepare('DELETE FROM endpoint_acls WHERE id = ?')->execute([$id]);
    }

    public function deleteEndpointAclBySubject(int $endpointId, string $subjectType, int $subjectId): void
    {
        $this->pdo->prepare(
            'DELETE FROM endpoint_acls WHERE endpoint_id = ? AND subject_type = ? AND subject_id = ?'
        )->execute([$endpointId, $subjectType, $subjectId]);
    }

    /** Effective role for a user on an endpoint (max of direct + team ACLs). */
    public function resolveEndpointRole(int $userId, int $endpointId): string
    {
        $rank = ['none' => 0, 'read' => 1, 'operate' => 2, 'admin' => 3];
        $best = 'none';
        $stmt = $this->pdo->prepare(
            "SELECT role FROM endpoint_acls
             WHERE endpoint_id = ? AND subject_type = 'user' AND subject_id = ?"
        );
        $stmt->execute([$endpointId, $userId]);
        $direct = $stmt->fetchColumn();
        if (is_string($direct) && ($rank[$direct] ?? 0) > ($rank[$best] ?? 0)) {
            $best = $direct;
        }
        $teamIds = $this->listTeamIdsForUser($userId);
        if ($teamIds !== []) {
            $placeholders = implode(',', array_fill(0, count($teamIds), '?'));
            $params = array_merge([$endpointId], $teamIds);
            $stmt = $this->pdo->prepare(
                "SELECT role FROM endpoint_acls
                 WHERE endpoint_id = ? AND subject_type = 'team' AND subject_id IN ($placeholders)"
            );
            $stmt->execute($params);
            foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) ?: [] as $role) {
                $role = (string) $role;
                if (($rank[$role] ?? 0) > ($rank[$best] ?? 0)) {
                    $best = $role;
                }
            }
        }
        return $best;
    }

    /** When a new endpoint is created, grant operate to all non-admin users (compat). */
    public function seedOperateAclForEndpoint(int $endpointId): void
    {
        $users = $this->pdo->query('SELECT id, role FROM users')->fetchAll() ?: [];
        $ins = $this->pdo->prepare(
            'INSERT OR IGNORE INTO endpoint_acls (endpoint_id, subject_type, subject_id, role)
             VALUES (?, \'user\', ?, \'operate\')'
        );
        foreach ($users as $u) {
            if ((int) ($u['role'] ?? 0) === 1) {
                continue;
            }
            $ins->execute([$endpointId, (int) $u['id']]);
        }
    }

    /** When a new non-admin user is created, grant operate on all endpoints. */
    public function seedOperateAclForUser(int $userId): void
    {
        $endpoints = $this->pdo->query('SELECT id FROM endpoints')->fetchAll() ?: [];
        $ins = $this->pdo->prepare(
            'INSERT OR IGNORE INTO endpoint_acls (endpoint_id, subject_type, subject_id, role)
             VALUES (?, \'user\', ?, \'operate\')'
        );
        foreach ($endpoints as $ep) {
            $ins->execute([(int) $ep['id'], $userId]);
        }
    }

    public function createLdapUser(string $username, int $role = 2): array
    {
        $now = time();
        // Unusable local hash — LDAP users authenticate via directory only
        $hash = password_hash(bin2hex(random_bytes(32)), PASSWORD_DEFAULT);
        $stmt = $this->pdo->prepare(
            'INSERT INTO users (username, password_hash, role, created_at, auth_source)
             VALUES (?, ?, ?, ?, \'ldap\')'
        );
        $stmt->execute([$username, $hash, $role, $now]);
        $id = (int) $this->pdo->lastInsertId();
        $this->seedOperateAclForUser($id);
        return $this->findUserById($id) ?? [
            'id' => $id,
            'username' => $username,
            'role' => $role,
            'created_at' => $now,
            'auth_source' => 'ldap',
        ];
    }

    // --- Schedules ---

    /** @return list<array<string, mixed>> */
    public function listSchedules(?int $stackId = null, ?int $endpointId = null): array
    {
        $sql = 'SELECT * FROM schedules WHERE 1=1';
        $params = [];
        if ($stackId !== null) {
            $sql .= " AND target_type = 'stack' AND target_id = ?";
            $params[] = $stackId;
        }
        if ($endpointId !== null) {
            $sql .= ' AND endpoint_id = ?';
            $params[] = $endpointId;
        }
        $sql .= ' ORDER BY id ASC';
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($params);
        return $stmt->fetchAll() ?: [];
    }

    /** @return array<string, mixed>|null */
    public function getSchedule(int $id): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM schedules WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    public function createSchedule(
        string $name,
        int $endpointId,
        string $targetType,
        int $targetId,
        string $action,
        string $cronExpr,
        string $timezone,
        string $createdBy,
        ?int $nextRunAt = null,
    ): array {
        $now = time();
        $stmt = $this->pdo->prepare(
            'INSERT INTO schedules
            (name, endpoint_id, target_type, target_id, action, cron_expr, timezone, enabled,
             last_run_at, next_run_at, last_status, last_error, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, \'\', \'\', ?, ?)'
        );
        $stmt->execute([
            $name,
            $endpointId,
            $targetType,
            $targetId,
            $action,
            $cronExpr,
            $timezone,
            $nextRunAt,
            $createdBy,
            $now,
        ]);
        return $this->getSchedule((int) $this->pdo->lastInsertId()) ?? [];
    }

    public function updateSchedule(
        int $id,
        string $name,
        string $action,
        string $cronExpr,
        string $timezone,
        bool $enabled,
        ?int $nextRunAt,
    ): ?array {
        $stmt = $this->pdo->prepare(
            'UPDATE schedules SET name = ?, action = ?, cron_expr = ?, timezone = ?, enabled = ?, next_run_at = ?
             WHERE id = ?'
        );
        $stmt->execute([$name, $action, $cronExpr, $timezone, $enabled ? 1 : 0, $nextRunAt, $id]);
        return $this->getSchedule($id);
    }

    public function deleteSchedule(int $id): void
    {
        $this->pdo->prepare('DELETE FROM schedules WHERE id = ?')->execute([$id]);
    }

    /** @return list<array<string, mixed>> */
    public function listDueSchedules(int $now): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT * FROM schedules
             WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
             ORDER BY next_run_at ASC LIMIT 50'
        );
        $stmt->execute([$now]);
        return $stmt->fetchAll() ?: [];
    }

    public function markScheduleRun(int $id, string $status, string $error, ?int $nextRunAt): void
    {
        $stmt = $this->pdo->prepare(
            'UPDATE schedules SET last_run_at = ?, last_status = ?, last_error = ?, next_run_at = ? WHERE id = ?'
        );
        $stmt->execute([time(), $status, $error, $nextRunAt, $id]);
    }

    // --- Image vulnerability scans ---

    /** @return array<string, mixed>|null */
    public function getLatestImageScan(int $endpointId, string $imageRef, string $digest = ''): ?array
    {
        if ($digest !== '') {
            $stmt = $this->pdo->prepare(
                'SELECT * FROM image_scans WHERE endpoint_id = ? AND digest = ? ORDER BY scanned_at DESC LIMIT 1'
            );
            $stmt->execute([$endpointId, $digest]);
        } else {
            $stmt = $this->pdo->prepare(
                'SELECT * FROM image_scans WHERE endpoint_id = ? AND image_ref = ? ORDER BY scanned_at DESC LIMIT 1'
            );
            $stmt->execute([$endpointId, $imageRef]);
        }
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /** @return list<array<string, mixed>> */
    public function listImageScanSummaries(int $endpointId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT s.* FROM image_scans s
             INNER JOIN (
               SELECT COALESCE(NULLIF(digest, \'\'), image_ref) AS k, MAX(id) AS mid
               FROM image_scans WHERE endpoint_id = ? GROUP BY k
             ) t ON s.id = t.mid
             WHERE s.endpoint_id = ?
             ORDER BY s.scanned_at DESC'
        );
        $stmt->execute([$endpointId, $endpointId]);
        return $stmt->fetchAll() ?: [];
    }

    /** @param array<string, mixed> $summary */
    public function saveImageScan(
        int $endpointId,
        string $imageRef,
        string $digest,
        string $status,
        array $summary,
        string $rawJson,
        array $findings,
    ): array {
        $now = time();
        $existing = null;
        if ($digest !== '') {
            $stmt = $this->pdo->prepare(
                'SELECT id FROM image_scans WHERE endpoint_id = ? AND digest = ? LIMIT 1'
            );
            $stmt->execute([$endpointId, $digest]);
            $existing = $stmt->fetchColumn();
        }
        $summaryJson = json_encode($summary, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '{}';
        if ($existing) {
            $id = (int) $existing;
            $this->pdo->prepare(
                'UPDATE image_scans SET image_ref = ?, status = ?, scanned_at = ?, summary_json = ?, raw_json = ? WHERE id = ?'
            )->execute([$imageRef, $status, $now, $summaryJson, $rawJson, $id]);
            $this->pdo->prepare('DELETE FROM image_findings WHERE scan_id = ?')->execute([$id]);
        } else {
            $this->pdo->prepare(
                'INSERT INTO image_scans (endpoint_id, image_ref, digest, status, scanned_at, summary_json, raw_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?)'
            )->execute([$endpointId, $imageRef, $digest, $status, $now, $summaryJson, $rawJson]);
            $id = (int) $this->pdo->lastInsertId();
        }
        $ins = $this->pdo->prepare(
            'INSERT INTO image_findings (scan_id, cve, package, version, severity, title, fixed_version)
             VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        foreach ($findings as $f) {
            $ins->execute([
                $id,
                (string) ($f['cve'] ?? ''),
                (string) ($f['package'] ?? ''),
                (string) ($f['version'] ?? ''),
                (string) ($f['severity'] ?? 'UNKNOWN'),
                (string) ($f['title'] ?? ''),
                (string) ($f['fixed_version'] ?? ''),
            ]);
        }
        $row = $this->pdo->prepare('SELECT * FROM image_scans WHERE id = ?');
        $row->execute([$id]);
        return $row->fetch() ?: [];
    }

    /** @return list<array<string, mixed>> */
    public function listImageFindings(int $scanId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT * FROM image_findings WHERE scan_id = ? ORDER BY
             CASE severity
               WHEN \'CRITICAL\' THEN 1 WHEN \'HIGH\' THEN 2 WHEN \'MEDIUM\' THEN 3
               WHEN \'LOW\' THEN 4 ELSE 5 END, cve ASC'
        );
        $stmt->execute([$scanId]);
        return $stmt->fetchAll() ?: [];
    }

    /** @return list<array<string, mixed>> */
    public function listBindVolumes(int $endpointId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT * FROM bind_volumes WHERE endpoint_id = ? ORDER BY name COLLATE NOCASE ASC'
        );
        $stmt->execute([$endpointId]);
        return $stmt->fetchAll() ?: [];
    }

    public function getBindVolumeByName(int $endpointId, string $name): ?array
    {
        $stmt = $this->pdo->prepare(
            'SELECT * FROM bind_volumes WHERE endpoint_id = ? AND name = ? LIMIT 1'
        );
        $stmt->execute([$endpointId, $name]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    public function getBindVolume(int $id): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM bind_volumes WHERE id = ? LIMIT 1');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    /**
     * @return array<string, mixed>
     */
    public function upsertBindVolume(
        int $endpointId,
        string $name,
        string $hostPath,
        string $source = 'manual',
        ?int $stackId = null,
        string $stackName = '',
        string $createdBy = '',
    ): array {
        $existing = $this->getBindVolumeByName($endpointId, $name);
        if ($existing) {
            $stmt = $this->pdo->prepare(
                'UPDATE bind_volumes
                 SET host_path = ?, source = ?, stack_id = ?, stack_name = ?
                 WHERE id = ?'
            );
            $stmt->execute([
                $hostPath,
                $source,
                $stackId,
                $stackName,
                (int) $existing['id'],
            ]);
            return $this->getBindVolume((int) $existing['id']) ?: $existing;
        }
        $stmt = $this->pdo->prepare(
            'INSERT INTO bind_volumes (endpoint_id, name, host_path, source, stack_id, stack_name, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $endpointId,
            $name,
            $hostPath,
            $source,
            $stackId,
            $stackName,
            $createdBy,
            time(),
        ]);
        return $this->getBindVolume((int) $this->pdo->lastInsertId()) ?: [];
    }

    public function deleteBindVolume(int $id): void
    {
        $stmt = $this->pdo->prepare('DELETE FROM bind_volumes WHERE id = ?');
        $stmt->execute([$id]);
    }

    /** Remove stack-sourced binds that are no longer present for a stack. */
    public function pruneStackBindVolumes(int $stackId, array $keepNames): void
    {
        $keep = array_values(array_filter(array_map('strval', $keepNames)));
        if ($keep === []) {
            $stmt = $this->pdo->prepare(
                "DELETE FROM bind_volumes WHERE stack_id = ? AND source = 'stack'"
            );
            $stmt->execute([$stackId]);
            return;
        }
        $placeholders = implode(',', array_fill(0, count($keep), '?'));
        $stmt = $this->pdo->prepare(
            "DELETE FROM bind_volumes WHERE stack_id = ? AND source = 'stack' AND name NOT IN ($placeholders)"
        );
        $stmt->execute([$stackId, ...$keep]);
    }

    public const SHARE_TYPES = ['stack', 'container', 'volume', 'network'];

    public function userHasSharesOnEndpoint(int $userId, int $endpointId): bool
    {
        if ($userId <= 0 || $endpointId <= 0) {
            return false;
        }
        $stmt = $this->pdo->prepare(
            "SELECT 1 FROM resource_shares
             WHERE grantee_type = 'user' AND grantee_id = ? AND endpoint_id = ?
             LIMIT 1"
        );
        $stmt->execute([$userId, $endpointId]);
        return (bool) $stmt->fetchColumn();
    }

    /** @return list<int> */
    public function listEndpointIdsSharedWithUser(int $userId): array
    {
        if ($userId <= 0) {
            return [];
        }
        $stmt = $this->pdo->prepare(
            "SELECT DISTINCT endpoint_id FROM resource_shares
             WHERE grantee_type = 'user' AND grantee_id = ?"
        );
        $stmt->execute([$userId]);
        return array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN) ?: []);
    }

    public function hasResourceShare(int $userId, string $type, int $endpointId, string $key): bool
    {
        if ($userId <= 0 || $endpointId <= 0 || $key === '' || !in_array($type, self::SHARE_TYPES, true)) {
            return false;
        }
        $stmt = $this->pdo->prepare(
            "SELECT 1 FROM resource_shares
             WHERE grantee_type = 'user' AND grantee_id = ?
               AND resource_type = ? AND endpoint_id = ? AND resource_key = ?
             LIMIT 1"
        );
        $stmt->execute([$userId, $type, $endpointId, $key]);
        return (bool) $stmt->fetchColumn();
    }

    /** @return list<string> */
    public function listSharedResourceKeys(int $userId, string $type, ?int $endpointId = null): array
    {
        if ($userId <= 0 || !in_array($type, self::SHARE_TYPES, true)) {
            return [];
        }
        if ($endpointId !== null) {
            $stmt = $this->pdo->prepare(
                "SELECT resource_key FROM resource_shares
                 WHERE grantee_type = 'user' AND grantee_id = ?
                   AND resource_type = ? AND endpoint_id = ?"
            );
            $stmt->execute([$userId, $type, $endpointId]);
        } else {
            $stmt = $this->pdo->prepare(
                "SELECT resource_key FROM resource_shares
                 WHERE grantee_type = 'user' AND grantee_id = ? AND resource_type = ?"
            );
            $stmt->execute([$userId, $type]);
        }
        return array_values(array_filter(array_map('strval', $stmt->fetchAll(PDO::FETCH_COLUMN) ?: [])));
    }

    /** @return list<array<string, mixed>> */
    public function listSharesForResource(string $type, int $endpointId, string $key): array
    {
        $stmt = $this->pdo->prepare(
            "SELECT s.*, u.username AS grantee_username
             FROM resource_shares s
             JOIN users u ON u.id = s.grantee_id
             WHERE s.resource_type = ? AND s.endpoint_id = ? AND s.resource_key = ?
             ORDER BY s.id ASC"
        );
        $stmt->execute([$type, $endpointId, $key]);
        return $stmt->fetchAll() ?: [];
    }

    public function getResourceShare(int $id): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM resource_shares WHERE id = ?');
        $stmt->execute([$id]);
        $row = $stmt->fetch();
        return $row ?: null;
    }

    public function createResourceShare(
        string $type,
        int $endpointId,
        string $key,
        int $granteeUserId,
        int $createdByUserId,
        string $role = 'operate',
    ): array {
        $now = time();
        $stmt = $this->pdo->prepare(
            "INSERT INTO resource_shares
             (resource_type, endpoint_id, resource_key, grantee_type, grantee_id, role, created_by_user_id, created_at)
             VALUES (?, ?, ?, 'user', ?, ?, ?, ?)
             ON CONFLICT(resource_type, endpoint_id, resource_key, grantee_type, grantee_id)
             DO UPDATE SET role = excluded.role"
        );
        $stmt->execute([$type, $endpointId, $key, $granteeUserId, $role, $createdByUserId, $now]);
        $shares = $this->listSharesForResource($type, $endpointId, $key);
        foreach ($shares as $s) {
            if ((int) $s['grantee_id'] === $granteeUserId) {
                return $s;
            }
        }
        return $shares[0] ?? [
            'resource_type' => $type,
            'endpoint_id' => $endpointId,
            'resource_key' => $key,
            'grantee_id' => $granteeUserId,
            'role' => $role,
        ];
    }

    public function deleteResourceShare(int $id): void
    {
        $stmt = $this->pdo->prepare('DELETE FROM resource_shares WHERE id = ?');
        $stmt->execute([$id]);
    }
}
