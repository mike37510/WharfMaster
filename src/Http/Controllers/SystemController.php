<?php
declare(strict_types=1);

namespace App\Http\Controllers;

use App\Access\EndpointAcl;
use App\Access\Ownership;
use App\Http\Request;
use App\Http\Response;

final class SystemController extends BaseController
{
    public function metricsHistory(Request $request): Response
    {
        $scope = (string) ($request->query('scope') ?? 'ep:1');
        $retention = $this->metricsRetentionDays();
        $defaultHours = $this->metricsChartHours();
        $hoursRaw = $request->query('hours');
        $useHours = ($hoursRaw !== null && $hoursRaw !== '')
            ? max(1, min($retention * 24, (int) $hoursRaw))
            : $defaultHours;
        $points = (int) ($request->query('points') ?? 288);
        $series = $this->repo->listMetricSamples($scope, $retention, $points, $useHours);
        return Response::json([
            'Scope' => $scope,
            'Hours' => $useHours,
            'ChartHours' => $defaultHours,
            'RetentionDays' => $retention,
            'Storage' => 'sqlite',
            'Series' => $series,
            'Count' => count($series),
        ]);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function metricsSample(Request $request, array $user): Response
    {
        $body = $request->json();
        $scope = trim((string) ($body['Scope'] ?? $body['scope'] ?? 'ep:1'));
        if ($scope === '') {
            $scope = 'ep:1';
        }
        $retention = $this->metricsRetentionDays();
        $result = $this->repo->recordMetricSample($scope, [
            'containers' => (int) ($body['containers'] ?? $body['Containers'] ?? 0),
            'images' => (int) ($body['images'] ?? $body['Images'] ?? 0),
            'volumes' => (int) ($body['volumes'] ?? $body['Volumes'] ?? 0),
            'networks' => (int) ($body['networks'] ?? $body['Networks'] ?? 0),
            'cpu' => (float) ($body['cpu'] ?? $body['Cpu'] ?? 0),
            'mem' => (float) ($body['mem'] ?? $body['Mem'] ?? 0),
            'disk' => (float) ($body['disk'] ?? $body['Disk'] ?? 0),
        ], 300, $retention);
        return Response::json([
            'Ok' => true,
            'Inserted' => $result['inserted'],
            'Purged' => $result['purged'],
            'Sample' => $result['sample'],
            'RetentionDays' => $retention,
        ], $result['inserted'] ? 201 : 200);
    }

    public function updateSettings(Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $body = $request->json();
        $publicUrl = (string) ($this->repo->getSetting('public_url', '') ?? '');
        if (array_key_exists('PublicURL', $body) || array_key_exists('HostURL', $body) || array_key_exists('publicURL', $body)) {
            $publicUrl = rtrim(trim((string) ($body['PublicURL'] ?? $body['HostURL'] ?? $body['publicURL'] ?? '')), '/');
            if ($publicUrl !== '' && !preg_match('#^https?://#i', $publicUrl)) {
                return Response::error('L\'URL publique doit commencer par http:// ou https://', 400);
            }
            $this->repo->setSetting('public_url', $publicUrl);
            $this->repo->updateEndpointPublicUrl(1, $publicUrl);
        }

        if (array_key_exists('MetricsChartHours', $body) || array_key_exists('metricsChartHours', $body)) {
            $hours = (int) ($body['MetricsChartHours'] ?? $body['metricsChartHours'] ?? 72);
            $hours = max(1, min(168, $hours));
            $this->repo->setSetting('metrics_chart_hours', (string) $hours);
        }
        if (array_key_exists('MetricsRetentionDays', $body) || array_key_exists('metricsRetentionDays', $body)) {
            $days = (int) ($body['MetricsRetentionDays'] ?? $body['metricsRetentionDays'] ?? 90);
            $days = max(7, min(365, $days));
            $this->repo->setSetting('metrics_retention_days', (string) $days);
        }

        if (array_key_exists('TrivyEnabled', $body) || array_key_exists('trivyEnabled', $body)) {
            $raw = $body['TrivyEnabled'] ?? $body['trivyEnabled'];
            $on = filter_var($raw, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
            if ($on === null) {
                $on = !in_array(strtolower(trim((string) $raw)), ['0', 'false', 'off', 'no', ''], true);
            }
            $this->repo->setSetting('trivy_enabled', $on ? '1' : '0');
        }

        if (isset($body['Ldap']) && is_array($body['Ldap'])) {
            $this->saveLdapSettings($body['Ldap']);
        } elseif (isset($body['LDAPSettings']) && is_array($body['LDAPSettings'])) {
            $this->saveLdapSettingsFromPortainer($body['LDAPSettings']);
        }

        $this->audit($user, 'settings.update', 'Mise à jour des paramètres', $request, [
            'publicUrl' => $publicUrl,
            'metricsChartHours' => $this->metricsChartHours(),
            'metricsRetentionDays' => $this->metricsRetentionDays(),
            'ldapEnabled' => !empty($this->ldapConfig()['enabled']),
            'trivyEnabled' => $this->trivyEnabled(),
        ]);
        return Response::json($this->formatSettings());
    }

    /** @param array<string, mixed> $user */
    public function healthCheck(): Response
    {
        $socket = (string) ($this->config['docker_socket'] ?? '');
        $dataDir = dirname((string) ($this->config['sqlite_path'] ?? ''));
        $composeDir = (string) ($this->config['compose_dir'] ?? '');
        $dockerOk = false;
        try {
            $dockerOk = $this->docker->ping();
        } catch (\Throwable) {
            $dockerOk = false;
        }
        $composeBin = (string) ($this->config['compose_bin'] ?? '');
        $dockerBin = (string) ($this->config['docker_bin'] ?? 'docker');
        $composeOk = false;
        $out = [];
        $code = 1;
        @exec(escapeshellarg($dockerBin) . ' compose version 2>/dev/null', $out, $code);
        if ($code === 0) {
            $composeOk = true;
        } elseif ($composeBin !== '' && is_executable($composeBin)) {
            $composeOk = true;
        }
        $dataWritable = $dataDir !== '' && is_dir($dataDir) && is_writable($dataDir);
        $composeWritable = $composeDir !== '' && (is_dir($composeDir) || @mkdir($composeDir, 0755, true)) && is_writable($composeDir);
        $sqliteOk = is_file((string) ($this->config['sqlite_path'] ?? '')) && is_readable((string) $this->config['sqlite_path']);
        $checks = [
            'docker' => $dockerOk,
            'dockerSocket' => $socket !== '' && (file_exists($socket) || is_link($socket)),
            'compose' => $composeOk,
            'dataWritable' => $dataWritable,
            'composeDirWritable' => $composeWritable,
            'sqlite' => $sqliteOk,
        ];
        $ok = !in_array(false, $checks, true);
        return Response::json([
            'ok' => $ok,
            'version' => $this->config['version'],
            'checks' => $checks,
        ], $ok ? 200 : 503);
    }

    /**
     * Admin self-test after migrations / upgrades.
     *
     * @param array{id:int,username:string,role:int} $user
     */
    public function diagnostics(array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }

        $checks = [];
        $add = static function (string $id, string $group, bool $ok, string $detail, string $level = '') use (&$checks): void {
            $checks[] = [
                'id' => $id,
                'group' => $group,
                'ok' => $ok,
                'level' => $level !== '' ? $level : ($ok ? 'ok' : 'fail'),
                'detail' => $detail,
            ];
        };

        $version = (string) ($this->config['version'] ?? '');
        $add('app.version', 'Runtime', $version !== '', $version !== '' ? 'Version ' . $version : 'Version manquante');

        $socket = (string) ($this->config['docker_socket'] ?? '');
        $socketExists = $socket !== '' && (file_exists($socket) || is_link($socket));
        $add(
            'docker.socket',
            'Runtime',
            $socketExists,
            $socket === '' ? 'DOCKER_SOCKET non défini' : ($socket . ($socketExists ? ' (présent)' : ' (absent)'))
        );

        $dockerOk = false;
        $dockerDetail = 'Ping échoué';
        try {
            $dockerOk = $this->docker->ping();
            $dockerDetail = $dockerOk ? 'Ping OK' : 'Ping refusé';
        } catch (\Throwable $e) {
            $dockerDetail = $e->getMessage();
        }
        $add('docker.ping', 'Runtime', $dockerOk, $dockerDetail);

        $dockerBin = (string) ($this->config['docker_bin'] ?? 'docker');
        $composeBin = (string) ($this->config['compose_bin'] ?? '');
        $out = [];
        $code = 1;
        @exec(escapeshellarg($dockerBin) . ' compose version 2>/dev/null', $out, $code);
        $composeOk = $code === 0 || ($composeBin !== '' && is_executable($composeBin));
        $add(
            'docker.compose',
            'Runtime',
            $composeOk,
            $composeOk
                ? (implode(' ', $out) ?: 'docker compose disponible')
                : 'docker compose introuvable'
        );

        $trivyOn = $this->trivyEnabled();
        $trivyAvail = $this->imageScanner->available();
        if ($trivyOn) {
            $add(
                'trivy',
                'Runtime',
                $trivyAvail,
                $trivyAvail ? 'Trivy activé et binaire détecté' : 'Trivy activé mais binaire manquant',
                $trivyAvail ? 'ok' : 'warn'
            );
        } else {
            $add('trivy', 'Runtime', true, 'Trivy désactivé', 'warn');
        }

        $varDir = (string) ($this->config['var_dir'] ?? dirname((string) ($this->config['sqlite_path'] ?? '')));
        $varOk = $varDir !== '' && is_dir($varDir) && is_writable($varDir);
        $add('var.writable', 'Runtime', $varOk, $varDir !== '' ? $varDir : 'var_dir manquant');

        $sqlitePath = (string) ($this->config['sqlite_path'] ?? '');
        $sqliteOk = $sqlitePath !== '' && is_file($sqlitePath) && is_readable($sqlitePath);
        $add('sqlite', 'Runtime', $sqliteOk, $sqlitePath !== '' ? $sqlitePath : 'sqlite_path manquant');

        $jwt = (string) ($this->config['jwt_secret'] ?? '');
        $add('jwt.secret', 'Runtime', $jwt !== '', $jwt !== '' ? 'JWT secret chargé' : 'JWT secret vide — exécutez bin/init.php');

        $endpoints = $this->repo->listEndpoints();
        $local = 0;
        $agents = 0;
        foreach ($endpoints as $ep) {
            $kind = strtolower((string) ($ep['kind'] ?? $ep['Kind'] ?? ''));
            if ($kind === 'agent') {
                $agents++;
            } else {
                $local++;
            }
        }
        $add(
            'endpoints',
            'Données',
            count($endpoints) > 0,
            sprintf('%d endpoint(s) — local=%d, agents=%d', count($endpoints), $local, $agents),
            count($endpoints) > 0 ? 'ok' : 'warn'
        );

        $join = $this->repo->getActiveJoinToken();
        $add(
            'join.token',
            'Données',
            true,
            $join ? ('Token actif …' . (string) ($join['token_hint'] ?? '')) : 'Aucun token d’enrôlement actif',
            $join ? 'ok' : 'warn'
        );

        $root = (string) ($this->config['root'] ?? dirname(__DIR__, 2));
        $publicFiles = [
            'http.landing' => [$root . '/site/index.html', '/'],
            'http.app' => [$root . '/public/app.html', '/app'],
            'http.site.css' => [$root . '/site/site.css', '/site/site.css'],
            'http.app.js' => [$root . '/public/assets/js/app.js', '/assets/js/app.js'],
            'http.app.css' => [$root . '/public/assets/css/app.css', '/assets/css/app.css'],
        ];
        foreach ($publicFiles as $id => [$file, $url]) {
            $ok = is_file($file) && is_readable($file);
            $add($id, 'HTTP public', $ok, $ok ? $url . ' → ' . $file : $url . ' manquant (' . $file . ')');
        }

        foreach ($this->probePublicUrls() as $probe) {
            $add($probe['id'], 'HTTP public', $probe['ok'], $probe['detail'], $probe['level'] ?? '');
        }

        $failed = count(array_filter($checks, static fn(array $c): bool => empty($c['ok']) || ($c['level'] ?? '') === 'fail'));
        $warns = count(array_filter($checks, static fn(array $c): bool => ($c['level'] ?? '') === 'warn'));

        return Response::json([
            'ok' => $failed === 0,
            'version' => $version,
            'summary' => [
                'total' => count($checks),
                'failed' => $failed,
                'warnings' => $warns,
            ],
            'checks' => $checks,
        ]);
    }

    /**
     * Best-effort HTTP probes against the local front controller.
     *
     * @return list<array{id:string,ok:bool,detail:string,level?:string}>
     */
    private function probePublicUrls(): array
    {
        $base = 'http://127.0.0.1';
        $paths = [
            'probe.status' => '/api/status',
            'probe.health' => '/api/health',
            'probe.landing' => '/',
            'probe.app' => '/app',
        ];
        $out = [];
        foreach ($paths as $id => $path) {
            $url = $base . $path;
            $ch = curl_init($url);
            if ($ch === false) {
                $out[] = ['id' => $id, 'ok' => false, 'detail' => 'curl_init a échoué pour ' . $path];
                continue;
            }
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => false,
                CURLOPT_TIMEOUT => 3,
                CURLOPT_CONNECTTIMEOUT => 2,
                CURLOPT_HEADER => true,
                CURLOPT_NOBODY => false,
            ]);
            $raw = curl_exec($ch);
            $errno = curl_errno($ch);
            $err = curl_error($ch);
            $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);
            if ($errno !== 0) {
                $out[] = [
                    'id' => $id,
                    'ok' => true,
                    'level' => 'warn',
                    'detail' => $path . ' non joignable en local (' . $err . ') — fichiers vérifiés à part',
                ];
                continue;
            }
            $ok = $status >= 200 && $status < 400;
            $out[] = [
                'id' => $id,
                'ok' => $ok,
                'detail' => sprintf('%s → HTTP %d', $path, $status),
            ];
            unset($raw);
        }
        return $out;
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function downloadBackup(Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $format = strtolower(trim((string) ($request->query('format') ?? 'zip')));
        if ($format === 'sqlite') {
            return $this->downloadSqliteBackupOnly();
        }
        return $this->downloadFullBackupZip($request, $user);
    }

    public function downloadSqliteBackupOnly(): Response
    {
        try {
            $tmp = $this->snapshotSqliteFile();
        } catch (\Throwable $e) {
            $status = $e->getCode() >= 400 && $e->getCode() < 600 ? (int) $e->getCode() : 500;
            return Response::error($e->getMessage(), $status);
        }
        $blob = (string) file_get_contents($tmp);
        @unlink($tmp);
        $name = 'wharfmaster-backup-' . date('Ymd-His') . '.sqlite';
        return new Response(200, $blob, [
            'Content-Type' => 'application/x-sqlite3',
            'Content-Disposition' => 'attachment; filename="' . $name . '"',
            'Cache-Control' => 'no-store',
            'Content-Security-Policy' => "default-src 'none'",
        ]);
    }

    /**
     * Full disaster-recovery archive: SQLite, Compose stacks, Dockerfiles, JWT secret, manifest.
     *
     * @param array{id:int,username:string,role:int} $user
     */
    public function downloadFullBackupZip(Request $request, array $user): Response
    {
        if (!class_exists(\ZipArchive::class)) {
            return Response::error('Extension PHP zip indisponible — utilisez ?format=sqlite', 500);
        }

        $stamp = date('Ymd-His');
        $rootName = 'wharfmaster-backup-' . $stamp;
        $zipPath = sys_get_temp_dir() . '/' . $rootName . '-' . bin2hex(random_bytes(4)) . '.zip';
        $sqliteTmp = null;

        try {
            $sqliteTmp = $this->snapshotSqliteFile();
            $zip = new \ZipArchive();
            if ($zip->open($zipPath, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) {
                throw new \RuntimeException('Impossible de créer l’archive ZIP', 500);
            }

            $files = [];
            $zip->addFile($sqliteTmp, $rootName . '/database/dockermanager.sqlite');
            $files[] = 'database/dockermanager.sqlite';

            $jwtFile = dirname((string) $this->config['sqlite_path']) . '/jwt.secret';
            if (is_file($jwtFile)) {
                $zip->addFile($jwtFile, $rootName . '/secrets/jwt.secret');
                $files[] = 'secrets/jwt.secret';
            }

            $composeDir = (string) ($this->config['compose_dir'] ?? '');
            if ($composeDir !== '' && is_dir($composeDir)) {
                $added = $this->zipAddDirectory($zip, $composeDir, $rootName . '/compose');
                $files = array_merge($files, $added);
            }

            $dfDir = (string) ($this->config['dockerfiles_dir'] ?? '');
            if ($dfDir !== '' && is_dir($dfDir)) {
                $added = $this->zipAddDirectory($zip, $dfDir, $rootName . '/dockerfiles');
                $files = array_merge($files, $added);
            }

            $settings = $this->formatSettings();
            $meta = [
                'app' => 'WharfMaster',
                'version' => $this->config['version'] ?? null,
                'createdAt' => date('c'),
                'createdBy' => $user['username'] ?? null,
                'format' => 1,
                'contents' => $files,
                'settings' => $settings,
                'config' => [
                    'app_name' => $this->config['app_name'] ?? 'WharfMaster',
                    'version' => $this->config['version'] ?? null,
                    'agent_image' => $this->config['agent_image'] ?? null,
                    'docker_api_version' => $this->config['docker_api_version'] ?? null,
                    'compose_dir' => 'var/compose',
                    'dockerfiles_dir' => 'var/dockerfiles',
                    'sqlite_path' => 'var/dockermanager.sqlite',
                ],
                'notes' => [
                    'Includes users, endpoints/agents, stacks metadata, registries, audit, metrics, settings (SQLite).',
                    'Includes on-disk Compose projects and saved Dockerfiles.',
                    'Includes jwt.secret — keep the archive private.',
                    'Docker container filesystem / volumes on hosts are NOT included.',
                ],
            ];
            $zip->addFromString(
                $rootName . '/MANIFEST.json',
                json_encode($meta, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?: '{}'
            );
            $zip->addFromString($rootName . '/RESTORE.md', $this->backupRestoreGuide($stamp));
            $zip->close();

            $blob = (string) file_get_contents($zipPath);
            $this->audit($user, 'backup.download', 'Téléchargement backup complet (ZIP)', $request, [
                'format' => 'zip',
                'bytes' => strlen($blob),
                'files' => count($files),
            ]);

            return new Response(200, $blob, [
                'Content-Type' => 'application/zip',
                'Content-Disposition' => 'attachment; filename="' . $rootName . '.zip"',
                'Cache-Control' => 'no-store',
                'Content-Security-Policy' => "default-src 'none'",
            ]);
        } catch (\Throwable $e) {
            $status = $e->getCode() >= 400 && $e->getCode() < 600 ? (int) $e->getCode() : 500;
            return Response::error($e->getMessage() !== '' ? $e->getMessage() : 'Échec du backup', $status);
        } finally {
            if ($sqliteTmp !== null) {
                @unlink($sqliteTmp);
            }
            @unlink($zipPath);
        }
    }

    /**
     * @return list<string> paths added relative to archive root prefix
     */
    public function listAudit(Request $request, array $user): Response
    {
        $isAdmin = (int) ($user['role'] ?? 0) === 1;
        $limit = (int) ($request->query('limit') ?? 100);
        $offset = (int) ($request->query('offset') ?? 0);
        $action = trim((string) ($request->query('action') ?? ''));
        $actionFilter = $action !== '' ? $action : null;
        $userFilter = $isAdmin ? null : (int) $user['id'];

        $rows = $this->repo->listAuditEvents($limit, $offset, $actionFilter, $userFilter);
        $total = $this->repo->countAuditEvents($actionFilter, $userFilter);

        $items = array_map(static function (array $row): array {
            $meta = json_decode((string) ($row['meta_json'] ?? '{}'), true);
            if (!is_array($meta)) {
                $meta = [];
            }
            return [
                'Id' => (int) $row['id'],
                'CreatedAt' => (int) $row['created_at'],
                'UserId' => $row['user_id'] !== null ? (int) $row['user_id'] : null,
                'Username' => (string) ($row['username'] ?? ''),
                'Action' => (string) $row['action'],
                'Message' => (string) $row['message'],
                'Ip' => (string) ($row['ip'] ?? ''),
                'Meta' => $meta,
            ];
        }, $rows);

        return Response::json([
            'Total' => $total,
            'Items' => $items,
        ]);
    }

    // --- Portainer CE compatibility helpers ---

    /**
     * Map WM ACL roles → Portainer RoleId on endpoints.
     * 1 ≈ endpoint admin, 2 ≈ helpdesk/operate, 3 ≈ readonly
     */
}
