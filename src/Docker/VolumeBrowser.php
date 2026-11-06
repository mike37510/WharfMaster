<?php
declare(strict_types=1);

namespace App\Docker;

final class VolumeBrowser
{
    private const BROWSE_IMAGE = 'busybox:1.36';
    private const MAX_PREVIEW_BYTES = 512_000;

    public function __construct(private readonly Client $docker)
    {
    }

    /**
     * @return array{Path:string,Entries:list<array{Name:string,Path:string,Type:string,Size:int,ModTime:int}>}
     */
    public function list(string $volumeName, string $path = '/'): array
    {
        $this->assertVolume($volumeName);
        $rel = $this->normalizePath($path);
        $target = $rel === '' ? '/volume' : '/volume/' . $rel;

        $script = <<<'SH'
set -e
TARGET="$1"
if [ ! -e "$TARGET" ]; then
  echo "NOT_FOUND" >&2
  exit 2
fi
if [ ! -d "$TARGET" ]; then
  echo "NOT_DIR" >&2
  exit 3
fi
# shellcheck disable=SC2012
ls -A "$TARGET" | while IFS= read -r name; do
  [ -z "$name" ] && continue
  p="$TARGET/$name"
  if [ -L "$p" ]; then t=link
  elif [ -d "$p" ]; then t=dir
  else t=file
  fi
  size=$(stat -c %s "$p" 2>/dev/null || echo 0)
  mtime=$(stat -c %Y "$p" 2>/dev/null || echo 0)
  # encode name as base64 to keep special chars safe
  enc=$(printf '%s' "$name" | base64 | tr -d '\n')
  printf '%s|%s|%s|%s\n' "$t" "$size" "$mtime" "$enc"
done
SH;

        $out = $this->runInVolume($volumeName, ['sh', '-c', $script, 'browse', $target], true);
        if (str_contains($out['Stderr'], 'NOT_FOUND')) {
            throw new \RuntimeException('Chemin introuvable', 404);
        }
        if (str_contains($out['Stderr'], 'NOT_DIR')) {
            throw new \RuntimeException('Ce chemin n’est pas un dossier', 400);
        }
        if ($out['ExitCode'] !== 0 && trim($out['Stdout']) === '') {
            throw new \RuntimeException(trim($out['Stderr']) !== '' ? trim($out['Stderr']) : 'Impossible de lister le volume', 500);
        }

        $entries = [];
        foreach (preg_split("/\r?\n/", trim($out['Stdout'])) ?: [] as $line) {
            if ($line === '') {
                continue;
            }
            $parts = explode('|', $line, 4);
            if (count($parts) < 4) {
                continue;
            }
            [$type, $size, $mtime, $enc] = $parts;
            $name = base64_decode($enc, true);
            if ($name === false || $name === '' || $name === '.' || $name === '..') {
                continue;
            }
            $childRel = $rel === '' ? $name : ($rel . '/' . $name);
            $entries[] = [
                'Name' => $name,
                'Path' => '/' . $childRel,
                'Type' => match ($type) {
                    'dir' => 'dir',
                    'link' => 'link',
                    default => 'file',
                },
                'Size' => (int) $size,
                'ModTime' => (int) $mtime,
            ];
        }

        usort($entries, static function (array $a, array $b): int {
            if ($a['Type'] === 'dir' && $b['Type'] !== 'dir') {
                return -1;
            }
            if ($a['Type'] !== 'dir' && $b['Type'] === 'dir') {
                return 1;
            }
            return strcasecmp($a['Name'], $b['Name']);
        });

        return [
            'Path' => '/' . $rel,
            'Entries' => $entries,
        ];
    }

    /**
     * @return array{Name:string,Path:string,Size:int,Content:string,Truncated:bool,Binary:bool}
     */
    public function readFile(string $volumeName, string $path): array
    {
        $this->assertVolume($volumeName);
        $rel = $this->normalizePath($path);
        if ($rel === '') {
            throw new \InvalidArgumentException('Fichier requis');
        }
        $target = '/volume/' . $rel;

        $statOut = $this->runInVolume($volumeName, [
            'sh', '-c',
            'if [ ! -e "$1" ]; then echo MISSING; exit 2; fi; if [ -d "$1" ]; then echo ISDIR; exit 3; fi; stat -c %s "$1"',
            'stat', $target,
        ], true);
        if (str_contains($statOut['Stdout'], 'MISSING') || str_contains($statOut['Stderr'], 'MISSING')) {
            throw new \RuntimeException('Fichier introuvable', 404);
        }
        if (str_contains($statOut['Stdout'], 'ISDIR') || str_contains($statOut['Stderr'], 'ISDIR')) {
            throw new \RuntimeException('Ce chemin est un dossier', 400);
        }
        $size = (int) trim($statOut['Stdout']);

        $preview = $this->runInVolume($volumeName, [
            'sh', '-c',
            'head -c ' . self::MAX_PREVIEW_BYTES . ' "$1" | base64',
            'read', $target,
        ], true);
        if ($preview['ExitCode'] !== 0) {
            throw new \RuntimeException(trim($preview['Stderr']) !== '' ? trim($preview['Stderr']) : 'Lecture impossible', 500);
        }
        $raw = base64_decode(preg_replace('/\s+/', '', $preview['Stdout']) ?: '', true);
        if ($raw === false) {
            $raw = '';
        }
        $binary = $this->looksBinary($raw);
        $truncated = $size > self::MAX_PREVIEW_BYTES;

        return [
            'Name' => basename($rel),
            'Path' => '/' . $rel,
            'Size' => $size,
            'Content' => $binary ? base64_encode($raw) : $raw,
            'Encoding' => $binary ? 'base64' : 'text',
            'Truncated' => $truncated,
            'Binary' => $binary,
        ];
    }

    private const MAX_DOWNLOAD_BYTES = 20_000_000;
    private const MAX_WRITE_BYTES = 2_000_000;

    /**
     * Create a directory (parents allowed).
     */
    public function mkdir(string $volumeName, string $path): array
    {
        $this->assertVolume($volumeName);
        $rel = $this->normalizePath($path);
        if ($rel === '') {
            throw new \InvalidArgumentException('Chemin de dossier requis');
        }
        $this->assertEntryName(basename($rel));
        $target = '/volume/' . $rel;
        $out = $this->runInVolume($volumeName, [
            'sh', '-c',
            'if [ -e "$1" ]; then echo EXISTS; exit 2; fi; mkdir -p "$1"',
            'mkdir', $target,
        ], false);
        if (str_contains($out['Stdout'] . $out['Stderr'], 'EXISTS') || $out['ExitCode'] === 2) {
            throw new \RuntimeException('Ce chemin existe déjà', 409);
        }
        if ($out['ExitCode'] !== 0) {
            throw new \RuntimeException($this->execError($out, 'Création du dossier impossible'), 500);
        }
        return ['Path' => '/' . $rel, 'Type' => 'dir'];
    }

    /**
     * Create an empty file or write text/binary content (base64 optional).
     * @param array{Content?:string,Encoding?:string} $opts
     */
    public function writeFile(string $volumeName, string $path, array $opts = []): array
    {
        $this->assertVolume($volumeName);
        $rel = $this->normalizePath($path);
        if ($rel === '') {
            throw new \InvalidArgumentException('Chemin de fichier requis');
        }
        $this->assertEntryName(basename($rel));
        $target = '/volume/' . $rel;
        $encoding = strtolower((string) ($opts['Encoding'] ?? 'text'));
        $content = (string) ($opts['Content'] ?? '');
        if ($encoding === 'base64') {
            $raw = base64_decode($content, true);
            if ($raw === false) {
                throw new \InvalidArgumentException('Contenu base64 invalide');
            }
        } else {
            $raw = $content;
        }
        if (strlen($raw) > self::MAX_WRITE_BYTES) {
            throw new \RuntimeException('Fichier trop volumineux (max 2 Mo)', 413);
        }
        $b64 = base64_encode($raw);
        $createOnly = !empty($opts['CreateOnly']);
        $script = $createOnly
            ? 'if [ -e "$1" ]; then echo EXISTS; exit 2; fi; if [ -d "$1" ]; then echo ISDIR; exit 3; fi; mkdir -p "$(dirname "$1")"; echo "$2" | base64 -d > "$1"'
            : 'if [ -d "$1" ]; then echo ISDIR; exit 3; fi; mkdir -p "$(dirname "$1")"; echo "$2" | base64 -d > "$1"';
        $out = $this->runInVolume($volumeName, ['sh', '-c', $script, 'write', $target, $b64], false);
        if (str_contains($out['Stdout'] . $out['Stderr'], 'EXISTS') || $out['ExitCode'] === 2) {
            throw new \RuntimeException('Ce fichier existe déjà', 409);
        }
        if (str_contains($out['Stdout'] . $out['Stderr'], 'ISDIR') || $out['ExitCode'] === 3) {
            throw new \RuntimeException('Ce chemin est un dossier', 400);
        }
        if ($out['ExitCode'] !== 0) {
            throw new \RuntimeException($this->execError($out, 'Écriture impossible'), 500);
        }
        return ['Path' => '/' . $rel, 'Type' => 'file', 'Size' => strlen($raw)];
    }

    public function rename(string $volumeName, string $from, string $to): array
    {
        $this->assertVolume($volumeName);
        $relFrom = $this->normalizePath($from);
        $relTo = $this->normalizePath($to);
        if ($relFrom === '' || $relTo === '') {
            throw new \InvalidArgumentException('Chemins source et destination requis');
        }
        if ($relFrom === $relTo) {
            return ['Path' => '/' . $relTo];
        }
        $this->assertEntryName(basename($relTo));
        // Prevent renaming a path into itself / child
        if (str_starts_with($relTo . '/', $relFrom . '/')) {
            throw new \InvalidArgumentException('Destination invalide');
        }
        $src = '/volume/' . $relFrom;
        $dst = '/volume/' . $relTo;
        $out = $this->runInVolume($volumeName, [
            'sh', '-c',
            'if [ ! -e "$1" ]; then echo MISSING; exit 2; fi; if [ -e "$2" ]; then echo EXISTS; exit 3; fi; mkdir -p "$(dirname "$2")"; mv "$1" "$2"',
            'rename', $src, $dst,
        ], false);
        if (str_contains($out['Stdout'] . $out['Stderr'], 'MISSING') || $out['ExitCode'] === 2) {
            throw new \RuntimeException('Élément introuvable', 404);
        }
        if (str_contains($out['Stdout'] . $out['Stderr'], 'EXISTS') || $out['ExitCode'] === 3) {
            throw new \RuntimeException('La destination existe déjà', 409);
        }
        if ($out['ExitCode'] !== 0) {
            throw new \RuntimeException($this->execError($out, 'Renommage impossible'), 500);
        }
        return ['Path' => '/' . $relTo, 'From' => '/' . $relFrom];
    }

    public function delete(string $volumeName, string $path): void
    {
        $this->assertVolume($volumeName);
        $rel = $this->normalizePath($path);
        if ($rel === '') {
            throw new \InvalidArgumentException('Impossible de supprimer la racine du volume');
        }
        $target = '/volume/' . $rel;
        $out = $this->runInVolume($volumeName, [
            'sh', '-c',
            'if [ ! -e "$1" ]; then echo MISSING; exit 2; fi; rm -rf "$1"',
            'delete', $target,
        ], false);
        if (str_contains($out['Stdout'] . $out['Stderr'], 'MISSING') || $out['ExitCode'] === 2) {
            throw new \RuntimeException('Élément introuvable', 404);
        }
        if ($out['ExitCode'] !== 0) {
            throw new \RuntimeException($this->execError($out, 'Suppression impossible'), 500);
        }
    }

    /**
     * @return array{Name:string,Path:string,Bytes:string,Size:int,Truncated:bool}
     */
    public function download(string $volumeName, string $path): array
    {
        $this->assertVolume($volumeName);
        $rel = $this->normalizePath($path);
        if ($rel === '') {
            throw new \InvalidArgumentException('Fichier requis');
        }
        $target = '/volume/' . $rel;
        $statOut = $this->runInVolume($volumeName, [
            'sh', '-c',
            'if [ ! -f "$1" ]; then echo MISSING; exit 2; fi; stat -c %s "$1"',
            'stat', $target,
        ], true);
        if (str_contains($statOut['Stdout'], 'MISSING') || $statOut['ExitCode'] !== 0) {
            throw new \RuntimeException('Fichier introuvable', 404);
        }
        $size = (int) trim($statOut['Stdout']);
        if ($size > self::MAX_DOWNLOAD_BYTES) {
            throw new \RuntimeException('Fichier trop volumineux (max 20 Mo)', 413);
        }
        $encoded = $this->runInVolume($volumeName, [
            'sh', '-c',
            'base64 "$1"',
            'dl', $target,
        ], true);
        if ($encoded['ExitCode'] !== 0) {
            throw new \RuntimeException(trim($encoded['Stderr']) !== '' ? trim($encoded['Stderr']) : 'Téléchargement impossible', 500);
        }
        $bytes = base64_decode(preg_replace('/\s+/', '', $encoded['Stdout']) ?: '', true);
        if ($bytes === false) {
            $bytes = '';
        }
        return [
            'Name' => basename($rel),
            'Path' => '/' . $rel,
            'Bytes' => $bytes,
            'Size' => strlen($bytes),
            'Truncated' => false,
        ];
    }

    /** @param list<string> $cmd */
    private function runInVolume(string $volumeName, array $cmd, bool $readOnly = true): array
    {
        $this->ensureBrowseImage();
        $containerId = $this->startBrowseContainer($volumeName, $readOnly);
        try {
            $exec = new Exec($this->docker);
            return $exec->run($containerId, $cmd, false, 60);
        } finally {
            $this->removeContainer($containerId);
        }
    }

    private function startBrowseContainer(string $volumeName, bool $readOnly): string
    {
        $mode = $readOnly ? 'ro' : 'rw';
        $created = $this->docker->json('POST', '/containers/create', [
            'Image' => self::BROWSE_IMAGE,
            'Cmd' => ['sleep', '120'],
            'HostConfig' => [
                'Binds' => [$volumeName . ':/volume:' . $mode],
                'AutoRemove' => false,
                'NetworkMode' => 'none',
            ],
            'Labels' => [
                'dockermanager.volume-browser' => '1',
            ],
        ]);
        $id = (string) ($created['Id'] ?? '');
        if ($id === '') {
            throw new \RuntimeException('Impossible de créer le conteneur d’exploration');
        }
        $start = $this->docker->request('POST', '/containers/' . rawurlencode($id) . '/start');
        if ($start['status'] >= 400) {
            $this->removeContainer($id);
            throw new \RuntimeException($start['body'] !== '' ? $start['body'] : 'Démarrage du conteneur d’exploration impossible', $start['status']);
        }
        return $id;
    }

    private function removeContainer(string $id): void
    {
        try {
            $this->docker->request('DELETE', '/containers/' . rawurlencode($id), null, [], ['force' => 'true']);
        } catch (\Throwable) {
            // ignore cleanup errors
        }
    }

    private function ensureBrowseImage(): void
    {
        try {
            $this->docker->json('GET', '/images/' . rawurlencode(self::BROWSE_IMAGE) . '/json');
            return;
        } catch (\Throwable) {
            // pull
        }
        $res = $this->docker->request(
            'POST',
            '/images/create',
            null,
            [],
            ['fromImage' => 'busybox', 'tag' => '1.36'],
        );
        if ($res['status'] >= 400) {
            throw new \RuntimeException(
                'Image busybox:1.36 requise pour l’explorateur. Pull impossible : '
                . ($res['body'] !== '' ? $res['body'] : 'HTTP ' . $res['status'])
            );
        }
    }

    private function assertVolume(string $name): void
    {
        $name = trim($name);
        if ($name === '' || !preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/', $name)) {
            throw new \InvalidArgumentException('Nom de volume invalide');
        }
        try {
            $this->docker->json('GET', '/volumes/' . rawurlencode($name));
        } catch (\Throwable $e) {
            throw new \RuntimeException('Volume introuvable', 404);
        }
    }

    private function assertEntryName(string $name): void
    {
        $name = trim($name);
        if ($name === '' || $name === '.' || $name === '..') {
            throw new \InvalidArgumentException('Nom invalide');
        }
        if (str_contains($name, '/') || str_contains($name, '\\') || str_contains($name, "\0")) {
            throw new \InvalidArgumentException('Le nom ne doit pas contenir de séparateur');
        }
        if (strlen($name) > 255) {
            throw new \InvalidArgumentException('Nom trop long');
        }
    }

    /** @param array{Stdout:string,Stderr:string,ExitCode:int} $out */
    private function execError(array $out, string $fallback): string
    {
        $msg = trim($out['Stderr'] !== '' ? $out['Stderr'] : $out['Stdout']);
        return $msg !== '' ? $msg : $fallback;
    }

    private function normalizePath(string $path): string
    {
        $path = str_replace('\\', '/', $path);
        $path = rawurldecode($path);
        $parts = [];
        foreach (explode('/', $path) as $part) {
            if ($part === '' || $part === '.') {
                continue;
            }
            if ($part === '..') {
                array_pop($parts);
                continue;
            }
            if (str_contains($part, "\0")) {
                throw new \InvalidArgumentException('Chemin invalide');
            }
            $parts[] = $part;
        }
        return implode('/', $parts);
    }

    private function looksBinary(string $data): bool
    {
        if ($data === '') {
            return false;
        }
        if (str_contains($data, "\0")) {
            return true;
        }
        $sample = substr($data, 0, 8000);
        $nonPrintable = preg_match_all('/[\x00-\x08\x0B\x0C\x0E-\x1F]/', $sample) ?: 0;
        return ($nonPrintable / max(1, strlen($sample))) > 0.05;
    }
}
