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

CREATE TABLE IF NOT EXISTS metric_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,
    sampled_at INTEGER NOT NULL,
    containers INTEGER NOT NULL DEFAULT 0,
    images INTEGER NOT NULL DEFAULT 0,
    volumes INTEGER NOT NULL DEFAULT 0,
    networks INTEGER NOT NULL DEFAULT 0,
    cpu REAL NOT NULL DEFAULT 0,
    mem REAL NOT NULL DEFAULT 0,
    disk REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_metric_samples_scope_time ON metric_samples(scope, sampled_at DESC);

CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    ad_group_dn TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
    team_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (team_id, user_id),
    FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS endpoint_acls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint_id INTEGER NOT NULL,
    subject_type TEXT NOT NULL,
    subject_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    UNIQUE(endpoint_id, subject_type, subject_id),
    FOREIGN KEY(endpoint_id) REFERENCES endpoints(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_endpoint_acls_subject ON endpoint_acls(subject_type, subject_id);

CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT '',
    endpoint_id INTEGER NOT NULL,
    target_type TEXT NOT NULL DEFAULT 'stack',
    target_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    cron_expr TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at INTEGER,
    next_run_at INTEGER,
    last_status TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    FOREIGN KEY(endpoint_id) REFERENCES endpoints(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_schedules_next ON schedules(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS image_scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint_id INTEGER NOT NULL,
    image_ref TEXT NOT NULL,
    digest TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    scanned_at INTEGER,
    summary_json TEXT NOT NULL DEFAULT '{}',
    raw_json TEXT NOT NULL DEFAULT '',
    UNIQUE(endpoint_id, image_ref, digest)
);
CREATE INDEX IF NOT EXISTS idx_image_scans_lookup ON image_scans(endpoint_id, digest);

CREATE TABLE IF NOT EXISTS image_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id INTEGER NOT NULL,
    cve TEXT NOT NULL DEFAULT '',
    package TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT '',
    severity TEXT NOT NULL DEFAULT 'UNKNOWN',
    title TEXT NOT NULL DEFAULT '',
    fixed_version TEXT NOT NULL DEFAULT '',
    FOREIGN KEY(scan_id) REFERENCES image_scans(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_image_findings_scan ON image_findings(scan_id);

CREATE TABLE IF NOT EXISTS bind_volumes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    host_path TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    stack_id INTEGER,
    stack_name TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE(endpoint_id, name),
    FOREIGN KEY(endpoint_id) REFERENCES endpoints(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bind_volumes_endpoint ON bind_volumes(endpoint_id);
CREATE INDEX IF NOT EXISTS idx_bind_volumes_stack ON bind_volumes(stack_id);

CREATE TABLE IF NOT EXISTS resource_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_type TEXT NOT NULL,
    endpoint_id INTEGER NOT NULL,
    resource_key TEXT NOT NULL,
    grantee_type TEXT NOT NULL DEFAULT 'user',
    grantee_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'operate',
    created_by_user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(resource_type, endpoint_id, resource_key, grantee_type, grantee_id),
    FOREIGN KEY(endpoint_id) REFERENCES endpoints(id) ON DELETE CASCADE,
    FOREIGN KEY(grantee_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_resource_shares_grantee ON resource_shares(grantee_type, grantee_id);
CREATE INDEX IF NOT EXISTS idx_resource_shares_resource ON resource_shares(resource_type, endpoint_id, resource_key);
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

        $this->ensureColumn('users', 'auth_source', "TEXT NOT NULL DEFAULT 'local'");
        $this->ensureColumn('teams', 'ad_group_dn', "TEXT NOT NULL DEFAULT ''");

        $this->seedDefaultEndpointAcls();
    }

    /**
     * One-shot compat: grant every non-admin user "operate" on all endpoints
     * so behaviour matches pre-ACL until an admin tightens access.
     */
    private function seedDefaultEndpointAcls(): void
    {
        $flag = $this->pdo->query(
            "SELECT value FROM settings WHERE key = 'acl_seeded_v1'"
        )->fetchColumn();
        if ($flag === '1') {
            return;
        }
        $users = $this->pdo->query('SELECT id, role FROM users')->fetchAll() ?: [];
        $endpoints = $this->pdo->query('SELECT id FROM endpoints')->fetchAll() ?: [];
        $ins = $this->pdo->prepare(
            'INSERT OR IGNORE INTO endpoint_acls (endpoint_id, subject_type, subject_id, role)
             VALUES (?, \'user\', ?, \'operate\')'
        );
        foreach ($users as $u) {
            if ((int) ($u['role'] ?? 0) === 1) {
                continue;
            }
            foreach ($endpoints as $ep) {
                $ins->execute([(int) $ep['id'], (int) $u['id']]);
            }
        }
        $this->pdo->prepare(
            "INSERT INTO settings (key, value) VALUES ('acl_seeded_v1', '1')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )->execute();
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
