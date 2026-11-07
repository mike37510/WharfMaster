<?php
declare(strict_types=1);

namespace App\Storage;

use PDO;

final class Database
{
    private PDO $pdo;

    public function __construct(string $path)
    {
        $dir = dirname($path);
        if (!is_dir($dir)) {
            mkdir($dir, 0755, true);
        }
        $this->pdo = new PDO('sqlite:' . $path, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
        $this->pdo->exec('PRAGMA foreign_keys = ON');
    }

    public function pdo(): PDO
    {
        return $this->pdo;
    }

    public function migrate(): void
    {
        $this->pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    prefix TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    raw_hint TEXT NOT NULL DEFAULT '',
    date_created INTEGER NOT NULL,
    last_used INTEGER,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS endpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type INTEGER NOT NULL DEFAULT 1,
    url TEXT NOT NULL,
    group_id INTEGER NOT NULL DEFAULT 1,
    public_url TEXT NOT NULL DEFAULT '',
    status INTEGER NOT NULL DEFAULT 1,
    snapshots TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type INTEGER NOT NULL DEFAULT 2,
    endpoint_id INTEGER NOT NULL,
    swarm_id TEXT NOT NULL DEFAULT '',
    entry_point TEXT NOT NULL DEFAULT 'docker-compose.yml',
    env_json TEXT NOT NULL DEFAULT '[]',
    status INTEGER NOT NULL DEFAULT 1,
    project_path TEXT NOT NULL,
    creation_date INTEGER NOT NULL,
    created_by TEXT NOT NULL DEFAULT 'admin',
    update_date INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT NOT NULL DEFAULT '',
    from_app_template INTEGER NOT NULL DEFAULT 0,
    UNIQUE(name, endpoint_id)
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS registries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'v2',
    created_at INTEGER NOT NULL,
    owner_id INTEGER,
    owner_username TEXT NOT NULL DEFAULT '',
    is_shared INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    user_id INTEGER,
    username TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_action ON audit_events(action);

CREATE TABLE IF NOT EXISTS join_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    token_hint TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL DEFAULT '',
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    max_uses INTEGER,
    use_count INTEGER NOT NULL DEFAULT 0
);
SQL);
        $this->ensureColumn('registries', 'owner_id', 'INTEGER');
        $this->ensureColumn('registries', 'owner_username', "TEXT NOT NULL DEFAULT ''");
        $this->ensureColumn('registries', 'is_shared', 'INTEGER NOT NULL DEFAULT 0');
        // Legacy registries without owner become shared (visible to all)
        $this->pdo->exec("UPDATE registries SET is_shared = 1 WHERE (owner_id IS NULL OR owner_id = 0) AND (owner_username IS NULL OR owner_username = '')");

        $this->ensureColumn('endpoints', 'kind', "TEXT NOT NULL DEFAULT 'local'");
        $this->ensureColumn('endpoints', 'agent_url', "TEXT NOT NULL DEFAULT ''");
        $this->ensureColumn('endpoints', 'agent_secret', "TEXT NOT NULL DEFAULT ''");
        $this->ensureColumn('endpoints', 'node_name', "TEXT NOT NULL DEFAULT ''");
        $this->ensureColumn('endpoints', 'last_seen_at', 'INTEGER');
        $this->ensureColumn('endpoints', 'joined_at', 'INTEGER');
        $this->ensureColumn('endpoints', 'tls_expires_at', 'INTEGER');
        $this->ensureColumn('endpoints', 'tls_fingerprint', "TEXT NOT NULL DEFAULT ''");
        $this->pdo->exec("UPDATE endpoints SET kind = 'local' WHERE id = 1 AND (kind IS NULL OR kind = '')");
        $this->pdo->exec("UPDATE endpoints SET node_name = name WHERE (node_name IS NULL OR node_name = '') AND name IS NOT NULL AND name != ''");
    }

    private function ensureColumn(string $table, string $column, string $ddl): void
    {
        $cols = $this->pdo->query('PRAGMA table_info(' . $table . ')')->fetchAll() ?: [];
        foreach ($cols as $col) {
            if (($col['name'] ?? '') === $column) {
                return;
            }
        }
        $this->pdo->exec('ALTER TABLE ' . $table . ' ADD COLUMN ' . $column . ' ' . $ddl);
    }
}
