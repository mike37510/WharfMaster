<?php
declare(strict_types=1);

namespace App\Stack;

use App\Docker\Client;
use App\Docker\VolumeBrowser;
use App\Http\Response;
use App\Storage\Repositories;

/**
 * Build a ZIP archive for one stack: compose, .env, named volumes + bind data.
 */
final class StackExporter
{
    public function __construct(
        private readonly Repositories $repo,
        private readonly ComposeDeployer $compose,
    ) {
    }

    /**
     * @param array<string, mixed> $stack DB row
     * @param array{id:int,username:string,role:int} $user
     * @return array{0:?Response,1:?string,2:?string} [errorResponse, zipPath, downloadName]
     */
    public function buildZip(array $stack, Client $docker, array $user): array
    {
        if (!class_exists(\ZipArchive::class)) {
            return [Response::error('Extension PHP zip indisponible', 500), null, null];
        }

        $stackId = (int) ($stack['id'] ?? 0);
        $endpointId = (int) ($stack['endpoint_id'] ?? 0);
        $stackName = (string) ($stack['name'] ?? 'stack');
        $projectPath = (string) ($stack['project_path'] ?? '');
        $entry = (string) ($stack['entry_point'] ?? 'docker-compose.yml');
        $safeName = $this->safeFilePart($stackName);
        $stamp = date('Ymd-His');
        $rootName = 'stack-' . $safeName . '-' . $stamp;
        $zipPath = sys_get_temp_dir() . '/' . $rootName . '-' . bin2hex(random_bytes(4)) . '.zip';
        $tmpVolFiles = [];

        try {
            $composeContent = '';
            if ($projectPath !== '') {
                try {
                    $composeContent = $this->compose->readComposeFile($projectPath, $entry);
                } catch (\Throwable) {
                    $composeContent = '';
                }
            }
            if ($composeContent === '') {
                return [Response::error('Fichier Compose introuvable pour cette stack', 404), null, null];
            }

            $zip = new \ZipArchive();
            if ($zip->open($zipPath, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) {
                throw new \RuntimeException('Impossible de créer l’archive ZIP', 500);
            }

            $files = [];
            $composeFileName = $entry !== '' ? basename($entry) : 'docker-compose.yml';
            if ($composeFileName === '' || $composeFileName === '.' || $composeFileName === '..') {
                $composeFileName = 'docker-compose.yml';
            }
            $zip->addFromString($rootName . '/' . $composeFileName, $composeContent);
            $files[] = $composeFileName;

            $envPath = rtrim($projectPath, '/') . '/.env';
            $envIncluded = false;
            if ($projectPath !== '' && is_file($envPath) && is_readable($envPath)) {
                $envBody = (string) file_get_contents($envPath);
                $zip->addFromString($rootName . '/.env', $envBody);
                $files[] = '.env';
                $envIncluded = true;
            }

            $volumeMeta = [];
            $named = $this->resolveNamedVolumes($docker, $stackName, $composeContent);
            foreach ($named as $vol) {
                $dockerName = (string) ($vol['Name'] ?? '');
                if ($dockerName === '') {
                    continue;
                }
                $label = (string) ($vol['Label'] ?? $dockerName);
                $tmp = sys_get_temp_dir() . '/wm-vol-' . bin2hex(random_bytes(6)) . '.tar';
                $tmpVolFiles[] = $tmp;
                $browser = new VolumeBrowser($docker);
                $bytes = $browser->exportTarToFile($dockerName, $tmp);
                $zipName = 'volumes/' . $this->safeFilePart($label) . '.tar';
                $zip->addFile($tmp, $rootName . '/' . $zipName);
                $files[] = $zipName;
                $volumeMeta[] = [
                    'kind' => 'named',
                    'name' => $dockerName,
                    'label' => $label,
                    'archive' => $zipName,
                    'bytes' => $bytes,
                ];
            }

            $binds = $this->resolveBindVolumes($endpointId, $stackId, $stackName, $composeContent, $projectPath);
            foreach ($binds as $bind) {
                $hostPath = (string) ($bind['hostPath'] ?? '');
                $label = (string) ($bind['name'] ?? basename($hostPath) ?: 'bind');
                if ($hostPath === '') {
                    continue;
                }
                $tmp = sys_get_temp_dir() . '/wm-bind-' . bin2hex(random_bytes(6)) . '.tar';
                $tmpVolFiles[] = $tmp;
                $browser = new VolumeBrowser($docker, $hostPath);
                try {
                    $bytes = $browser->exportTarToFile($label, $tmp);
                } catch (\Throwable $e) {
                    $volumeMeta[] = [
                        'kind' => 'bind',
                        'name' => $label,
                        'hostPath' => $hostPath,
                        'archive' => null,
                        'error' => $e->getMessage(),
                    ];
                    continue;
                }
                $zipName = 'binds/' . $this->safeFilePart($label) . '.tar';
                $zip->addFile($tmp, $rootName . '/' . $zipName);
                $files[] = $zipName;
                $volumeMeta[] = [
                    'kind' => 'bind',
                    'name' => $label,
                    'hostPath' => $hostPath,
                    'target' => (string) ($bind['target'] ?? ''),
                    'archive' => $zipName,
                    'bytes' => $bytes,
                ];
            }

            $manifest = [
                'app' => 'WharfMaster',
                'format' => 1,
                'kind' => 'stack-export',
                'createdAt' => date('c'),
                'createdBy' => $user['username'] ?? null,
                'stack' => [
                    'id' => $stackId,
                    'name' => $stackName,
                    'endpointId' => $endpointId,
                    'entryPoint' => $composeFileName,
                    'envIncluded' => $envIncluded,
                ],
                'files' => $files,
                'volumes' => $volumeMeta,
                'notes' => [
                    'Restore compose with docker compose -p <name> -f ' . $composeFileName . ' up -d',
                    'Named volume tars are Docker GET /archive of /volume (top folder often named "volume").',
                    'Extract into the target volume or bind path before starting services.',
                ],
            ];
            $zip->addFromString(
                $rootName . '/MANIFEST.json',
                json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?: '{}'
            );
            $zip->addFromString($rootName . '/RESTORE.md', $this->restoreGuide($stackName, $composeFileName, $envIncluded));
            if ($zip->close() !== true) {
                throw new \RuntimeException('Impossible de finaliser l’archive ZIP', 500);
            }

            foreach ($tmpVolFiles as $f) {
                @unlink($f);
            }
            $tmpVolFiles = [];

            if (!is_file($zipPath) || filesize($zipPath) < 22) {
                throw new \RuntimeException('Archive ZIP vide ou invalide', 500);
            }

            $downloadName = $rootName . '.zip';
            return [null, $zipPath, $downloadName];
        } catch (\Throwable $e) {
            foreach ($tmpVolFiles as $f) {
                @unlink($f);
            }
            if (is_file($zipPath)) {
                @unlink($zipPath);
            }
            $code = (int) $e->getCode();
            $status = $code >= 400 && $code < 600 ? $code : 500;
            return [Response::error($e->getMessage() !== '' ? $e->getMessage() : 'Export impossible', $status), null, null];
        }
    }

    /**
     * @return list<array{Name:string,Label:string}>
     */
    private function resolveNamedVolumes(Client $docker, string $project, string $composeContent): array
    {
        $projectLc = strtolower(trim($project));
        $out = [];
        $seen = [];

        try {
            $list = $docker->json('GET', '/volumes');
            $vols = is_array($list['Volumes'] ?? null) ? $list['Volumes'] : [];
            foreach ($vols as $v) {
                if (!is_array($v)) {
                    continue;
                }
                $name = (string) ($v['Name'] ?? '');
                if ($name === '') {
                    continue;
                }
                $labels = is_array($v['Labels'] ?? null) ? $v['Labels'] : [];
                $proj = strtolower((string) ($labels['com.docker.compose.project'] ?? ''));
                if ($proj === '' || $proj !== $projectLc) {
                    continue;
                }
                $label = (string) ($labels['com.docker.compose.volume'] ?? $name);
                $key = strtolower($name);
                if (isset($seen[$key])) {
                    continue;
                }
                $seen[$key] = true;
                $out[] = ['Name' => $name, 'Label' => $label !== '' ? $label : $name];
            }
        } catch (\Throwable) {
            // fall through to compose-declared names
        }

        // Also include compose-declared named volumes if they exist on the engine
        foreach ($this->composeNamedVolumeKeys($composeContent) as $key) {
            $candidates = [
                $project . '_' . $key,
                strtolower($project) . '_' . $key,
                $key,
            ];
            foreach ($candidates as $cand) {
                $ck = strtolower($cand);
                if (isset($seen[$ck])) {
                    break;
                }
                try {
                    $docker->json('GET', '/volumes/' . rawurlencode($cand));
                    $seen[$ck] = true;
                    $out[] = ['Name' => $cand, 'Label' => $key];
                    break;
                } catch (\Throwable) {
                    // try next candidate
                }
            }
        }

        return $out;
    }

    /**
     * @return list<string>
     */
    private function composeNamedVolumeKeys(string $compose): array
    {
        if (!preg_match('/^volumes:\s*$/mi', $compose, $m, PREG_OFFSET_CAPTURE)) {
            return [];
        }
        $start = (int) $m[0][1] + strlen($m[0][0]);
        $tail = substr($compose, $start);
        // Stop at next top-level key (no indent)
        if (preg_match('/^\S/m', $tail, $stop, PREG_OFFSET_CAPTURE)) {
            $tail = substr($tail, 0, (int) $stop[0][1]);
        }
        $keys = [];
        if (preg_match_all('/^\s{2}([A-Za-z0-9._-]+)\s*:/m', $tail, $km)) {
            foreach ($km[1] as $k) {
                $k = trim((string) $k);
                if ($k !== '') {
                    $keys[] = $k;
                }
            }
        }
        return array_values(array_unique($keys));
    }

    /**
     * @return list<array{name:string,hostPath:string,target:string}>
     */
    private function resolveBindVolumes(
        int $endpointId,
        int $stackId,
        string $stackName,
        string $composeContent,
        string $projectPath,
    ): array {
        $fromCompose = BindVolumeExtractor::fromCompose($composeContent, $stackName, $projectPath);
        $byHost = [];
        foreach ($fromCompose as $b) {
            $host = (string) ($b['hostPath'] ?? '');
            if ($host === '') {
                continue;
            }
            $byHost[strtolower($host)] = $b;
        }

        if ($endpointId > 0) {
            foreach ($this->repo->listBindVolumes($endpointId) as $row) {
                $sid = (int) ($row['stack_id'] ?? 0);
                if ($sid !== $stackId) {
                    continue;
                }
                $host = (string) ($row['host_path'] ?? '');
                if ($host === '') {
                    continue;
                }
                $key = strtolower($host);
                $byHost[$key] = [
                    'name' => (string) ($row['name'] ?? basename($host) ?: 'bind'),
                    'hostPath' => $host,
                    'target' => '',
                ];
            }
        }

        return array_values($byHost);
    }

    private function safeFilePart(string $value): string
    {
        $value = strtolower(trim($value));
        $value = preg_replace('/[^a-z0-9._-]+/', '-', $value) ?? 'stack';
        $value = trim($value, '.-');
        if ($value === '') {
            $value = 'stack';
        }
        return substr($value, 0, 80);
    }

    private function restoreGuide(string $stackName, string $composeFile, bool $envIncluded): string
    {
        $envLine = $envIncluded
            ? "- Le fichier `.env` est inclus (variables Compose).\n"
            : "- Pas de `.env` dans l’export.\n";
        return <<<MD
# Restauration — stack « {$stackName} »

## Contenu
- `{$composeFile}` — définition Compose
{$envLine}- `volumes/*.tar` — données des volumes nommés Docker
- `binds/*.tar` — données des bind mounts
- `MANIFEST.json` — inventaire

## Compose
```bash
docker compose -p {$stackName} -f {$composeFile} up -d
```

## Volumes / binds
Chaque `.tar` est une archive Docker (`GET /containers/.../archive` sur `/volume`).
Le premier dossier dans le tar s’appelle souvent `volume/`.

Exemple pour un volume nommé :
```bash
docker run --rm -v MON_VOLUME:/volume -v "\$PWD/volumes:/backup:ro" busybox:1.36 \\
  sh -c 'cd / && tar xf /backup/NOM.tar'
```

Pour un bind (`/chemin/hote`) :
```bash
mkdir -p /chemin/hote
tar xf binds/NOM.tar -C /tmp/extract
# puis copier le contenu de /tmp/extract/volume/ vers /chemin/hote
```
MD;
    }
}
