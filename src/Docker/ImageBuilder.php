<?php
declare(strict_types=1);

namespace App\Docker;

final class ImageBuilder
{
    public function __construct(
        private readonly Client $docker,
        private readonly string $dockerfilesDir,
    ) {
        if (!is_dir($this->dockerfilesDir)) {
            mkdir($this->dockerfilesDir, 0755, true);
        }
    }

    /**
     * @param array<string, string> $labels
     * @return array{status:int, body:string, success:bool, error:?string}
     */
    public function build(string $dockerfile, string $tag, array $labels = []): array
    {
        $tag = trim($tag);
        if ($tag === '' || !preg_match('/^[a-z0-9][a-z0-9._\/:-]{0,127}$/i', $tag)) {
            throw new \InvalidArgumentException('Tag d\'image invalide');
        }
        if (trim($dockerfile) === '') {
            throw new \InvalidArgumentException('Le Dockerfile est vide');
        }

        $tar = $this->makeContextTar($dockerfile);
        $query = [
            't' => $tag,
            'dockerfile' => 'Dockerfile',
            'rm' => 'true',
            'forcerm' => 'true',
        ];
        if ($labels !== []) {
            $query['labels'] = json_encode($labels, JSON_UNESCAPED_SLASHES) ?: '{}';
        }
        $res = $this->docker->request(
            'POST',
            '/build',
            $tar,
            ['Content-Type' => 'application/x-tar'],
            $query,
        );

        $error = null;
        $success = $res['status'] >= 200 && $res['status'] < 300;
        foreach (preg_split("/\r\n|\n|\r/", $res['body']) ?: [] as $line) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }
            $json = json_decode($line, true);
            if (!is_array($json)) {
                continue;
            }
            if (!empty($json['error'])) {
                $error = (string) $json['error'];
                $success = false;
            } elseif (!empty($json['errorDetail']['message'])) {
                $error = (string) $json['errorDetail']['message'];
                $success = false;
            }
        }

        return [
            'status' => $res['status'],
            'body' => $res['body'],
            'success' => $success && $error === null,
            'error' => $error,
        ];
    }

    /** @return list<array{Name:string, UpdatedAt:int, Size:int}> */
    public function listDockerfiles(): array
    {
        $out = [];
        foreach (glob($this->dockerfilesDir . '/*.Dockerfile') ?: [] as $file) {
            $base = basename($file, '.Dockerfile');
            $out[] = [
                'Name' => $base,
                'UpdatedAt' => (int) filemtime($file),
                'Size' => (int) filesize($file),
            ];
        }
        usort($out, static fn ($a, $b) => $b['UpdatedAt'] <=> $a['UpdatedAt']);
        return $out;
    }

    public function readDockerfile(string $name): string
    {
        $path = $this->pathFor($name);
        if (!is_file($path)) {
            throw new \RuntimeException('Dockerfile introuvable', 404);
        }
        return (string) file_get_contents($path);
    }

    public function saveDockerfile(string $name, string $content): void
    {
        $path = $this->pathFor($name);
        if (file_put_contents($path, $content) === false) {
            throw new \RuntimeException('Impossible d\'enregistrer le Dockerfile');
        }
    }

    public function deleteDockerfile(string $name): void
    {
        $path = $this->pathFor($name);
        if (is_file($path) && !unlink($path)) {
            throw new \RuntimeException('Impossible de supprimer le Dockerfile');
        }
    }

    private function pathFor(string $name): string
    {
        $safe = preg_replace('/[^a-zA-Z0-9._-]+/', '-', trim($name)) ?: '';
        $safe = trim($safe, '.-');
        if ($safe === '' || strlen($safe) > 80) {
            throw new \InvalidArgumentException('Nom de Dockerfile invalide');
        }
        return $this->dockerfilesDir . '/' . $safe . '.Dockerfile';
    }

    private function makeContextTar(string $dockerfile): string
    {
        $dir = sys_get_temp_dir() . '/dm-build-' . bin2hex(random_bytes(4));
        if (!mkdir($dir, 0700) && !is_dir($dir)) {
            throw new \RuntimeException('Impossible de créer le contexte de build');
        }
        $dockerfilePath = $dir . '/Dockerfile';
        file_put_contents($dockerfilePath, $dockerfile);
        $tarPath = $dir . '.tar';

        $created = false;
        if (class_exists(\PharData::class)) {
            try {
                if (is_file($tarPath)) {
                    @unlink($tarPath);
                }
                $phar = new \PharData($tarPath);
                $phar->addFile($dockerfilePath, 'Dockerfile');
                unset($phar);
                $created = is_file($tarPath);
            } catch (\Throwable) {
                $created = false;
            }
        }

        if (!$created) {
            $cmd = 'tar -cf ' . escapeshellarg($tarPath) . ' -C ' . escapeshellarg($dir) . ' Dockerfile';
            $out = [];
            $code = 0;
            exec($cmd . ' 2>&1', $out, $code);
            if ($code !== 0 || !is_file($tarPath)) {
                $this->cleanupDir($dir, $tarPath);
                throw new \RuntimeException('Échec de la création de l\'archive tar : ' . implode("\n", $out));
            }
        }

        $data = file_get_contents($tarPath);
        $this->cleanupDir($dir, $tarPath);
        if ($data === false || $data === '') {
            throw new \RuntimeException('Archive de build vide');
        }
        return $data;
    }

    private function cleanupDir(string $dir, string $tarPath): void
    {
        @unlink($dir . '/Dockerfile');
        @rmdir($dir);
        @unlink($tarPath);
    }
}
