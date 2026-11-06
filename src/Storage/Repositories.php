<?php
declare(strict_types=1);

namespace App\Storage;

use PDO;

final class Repositories
{
    public function __construct(private readonly PDO $pdo)
    {
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
            'SELECT id, username, role, created_at FROM users ORDER BY id ASC'
        )->fetchAll() ?: [];
    }

    public function createUser(string $username, string $password, int $role = 2): array
    {
        $hash = password_hash($password, PASSWORD_DEFAULT);
        $now = time();
        $stmt = $this->pdo->prepare(
            'INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)'
        );
        $stmt->execute([$username, $hash, $role, $now]);
        $id = (int) $this->pdo->lastInsertId();
        return $this->findUserById($id) ?? [
            'id' => $id,
            'username' => $username,
            'role' => $role,
            'created_at' => $now,
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

    public function updateEndpointPublicUrl(int $id, string $publicUrl): void
    {
        $stmt = $this->pdo->prepare('UPDATE endpoints SET public_url = ? WHERE id = ?');
        $stmt->execute([$publicUrl, $id]);
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
            return $existing;
        }
        $now = time();
        $stmt = $this->pdo->prepare(
            'INSERT INTO endpoints (id, name, type, url, group_id, public_url, status, snapshots, created_at)
             VALUES (1, ?, 1, ?, 1, ?, 1, ?, ?)'
        );
        $stmt->execute([
            'local',
            'unix://' . $socketPath,
            '',
            '[]',
            $now,
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
        ];
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
        return $row ?: null;
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
            $password,
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

    /** @return list<array<string, mixed>> */
    public function listStacksForUser(?string $username, bool $isAdmin, ?int $endpointId = null): array
    {
        if ($isAdmin) {
            return $this->listStacks($endpointId);
        }
        if ($endpointId !== null) {
            $stmt = $this->pdo->prepare(
                'SELECT * FROM stacks WHERE endpoint_id = ? AND created_by = ? ORDER BY id ASC'
            );
            $stmt->execute([$endpointId, $username ?? '']);
            return $stmt->fetchAll() ?: [];
        }
        $stmt = $this->pdo->prepare('SELECT * FROM stacks WHERE created_by = ? ORDER BY id ASC');
        $stmt->execute([$username ?? '']);
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
        $pass = $password !== null ? $password : (string) $existing['password'];
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
}
