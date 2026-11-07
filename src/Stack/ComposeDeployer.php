<?php
declare(strict_types=1);

namespace App\Stack;

final class ComposeDeployer
{
    public function __construct(
        private readonly string $composeRoot,
        private readonly string $socketPath,
        private readonly string $dockerBin,
        private readonly string $composeBin,
    ) {
        if (!is_dir($this->composeRoot)) {
            mkdir($this->composeRoot, 0755, true);
        }
    }

    public function projectDir(string $stackName): string
    {
        $safe = preg_replace('/[^a-zA-Z0-9_.-]/', '_', $stackName) ?: 'stack';
        return rtrim($this->composeRoot, '/') . '/' . $safe;
    }

    public function writeComposeFile(string $stackName, string $content, string $entryPoint = 'docker-compose.yml'): string
    {
        $dir = $this->projectDir($stackName);
        $this->writeComposeContent($dir, $content, $entryPoint);
        return $dir;
    }

    public function writeComposeContent(string $projectPath, string $content, string $entryPoint = 'docker-compose.yml'): void
    {
        if (!is_dir($projectPath)) {
            mkdir($projectPath, 0755, true);
        }
        $path = rtrim($projectPath, '/') . '/' . $entryPoint;
        if (file_put_contents($path, $content) === false) {
            throw new \RuntimeException("Impossible d'écrire le fichier Compose");
        }
    }

    public function readComposeFile(string $projectPath, string $entryPoint = 'docker-compose.yml'): string
    {
        $path = rtrim($projectPath, '/') . '/' . $entryPoint;
        if (!is_file($path)) {
            throw new \RuntimeException('Fichier Compose introuvable');
        }
        return (string) file_get_contents($path);
    }

    /**
     * Write a .env file used by Compose for ${VAR} substitution.
     * @param list<array{name?:string,value?:string}|array{Name?:string,Value?:string}> $env
     */
    public function writeEnvFile(string $projectPath, array $env): void
    {
        if (!is_dir($projectPath)) {
            mkdir($projectPath, 0755, true);
        }
        $lines = [];
        foreach ($env as $pair) {
            $name = (string) ($pair['name'] ?? $pair['Name'] ?? '');
            if ($name === '' || !preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $name)) {
                continue;
            }
            $value = (string) ($pair['value'] ?? $pair['Value'] ?? '');
            if ($value === '' || preg_match('/[\s#"\'\\\\$]/', $value)) {
                $value = '"' . addcslashes($value, "\\\"$\n\r") . '"';
            }
            $lines[] = $name . '=' . $value;
        }
        $path = rtrim($projectPath, '/') . '/.env';
        if ($lines === []) {
            if (is_file($path)) {
                unlink($path);
            }
            return;
        }
        if (file_put_contents($path, implode("\n", $lines) . "\n") === false) {
            throw new \RuntimeException("Impossible d'écrire le fichier .env");
        }
    }

    /**
     * Resolve Compose file + env via `docker compose config --format json`
     * (same engine as deploy — expands ${VAR}, YAML anchors, etc.).
     *
     * @param list<array{name?:string,value?:string}|array{Name?:string,Value?:string}> $env
     * @return array<string, mixed>
     */
    public function resolveConfig(string $content, array $env = [], string $entryPoint = 'docker-compose.yml'): array
    {
        $tmp = sys_get_temp_dir() . '/dm-ccheck-' . bin2hex(random_bytes(8));
        if (!mkdir($tmp, 0700) && !is_dir($tmp)) {
            throw new \RuntimeException('Impossible de créer le répertoire de validation Compose');
        }
        try {
            $safeEntry = preg_replace('/[^a-zA-Z0-9._-]+/', '', $entryPoint) ?: 'docker-compose.yml';
            if (!str_ends_with($safeEntry, '.yml') && !str_ends_with($safeEntry, '.yaml')) {
                $safeEntry = 'docker-compose.yml';
            }
            if (file_put_contents($tmp . '/' . $safeEntry, $content) === false) {
                throw new \RuntimeException('Impossible d’écrire le Compose temporaire');
            }
            $this->writeEnvFile($tmp, $env);
            $out = $this->runComposeCapture($tmp, 'dmcheck' . bin2hex(random_bytes(3)), ['config', '--format', 'json'], $env);
            $decoded = json_decode($out, true);
            if (!is_array($decoded)) {
                throw new \RuntimeException('Sortie Compose config invalide');
            }
            return $decoded;
        } finally {
            $this->removeProjectDir($tmp);
        }
    }

    /** @param list<array{name?:string,value?:string}|array{Name?:string,Value?:string}> $env */
    public function up(string $projectPath, string $projectName, array $env = []): void
    {
        $this->writeEnvFile($projectPath, $env);
        $this->runCompose($projectPath, $projectName, ['up', '-d', '--remove-orphans'], $env);
    }

    /** @param list<array{name?:string,value?:string}|array{Name?:string,Value?:string}> $env */
    public function down(string $projectPath, string $projectName, array $env = []): void
    {
        if (!is_dir($projectPath)) {
            return;
        }
        try {
            $this->runCompose($projectPath, $projectName, ['down', '--remove-orphans'], $env);
        } catch (\Throwable) {
            // best-effort cleanup
        }
    }

    /** @param list<array{name?:string,value?:string}|array{Name?:string,Value?:string}> $env */
    public function start(string $projectPath, string $projectName, array $env = []): void
    {
        if (!is_dir($projectPath)) {
            throw new \RuntimeException('Projet Compose introuvable');
        }
        try {
            $this->runCompose($projectPath, $projectName, ['start'], $env);
        } catch (\Throwable) {
            // Conteneurs absents après un down partiel → recreate
            $this->up($projectPath, $projectName, $env);
        }
    }

    /** @param list<array{name?:string,value?:string}|array{Name?:string,Value?:string}> $env */
    public function stop(string $projectPath, string $projectName, array $env = []): void
    {
        if (!is_dir($projectPath)) {
            return;
        }
        $this->runCompose($projectPath, $projectName, ['stop'], $env);
    }

    /** @param list<array{name?:string,value?:string}|array{Name?:string,Value?:string}> $env */
    public function restart(string $projectPath, string $projectName, array $env = []): void
    {
        if (!is_dir($projectPath)) {
            throw new \RuntimeException('Projet Compose introuvable');
        }
        try {
            $this->runCompose($projectPath, $projectName, ['restart'], $env);
        } catch (\Throwable) {
            $this->up($projectPath, $projectName, $env);
        }
    }

    public function removeProjectDir(string $projectPath): void
    {
        if (!is_dir($projectPath)) {
            return;
        }
        $files = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($projectPath, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($files as $file) {
            /** @var \SplFileInfo $file */
            if ($file->isDir()) {
                rmdir($file->getPathname());
            } else {
                unlink($file->getPathname());
            }
        }
        rmdir($projectPath);
    }

    /** @param list<string> $args */
    /** @param list<array{name?:string,value?:string}|array{Name?:string,Value?:string}> $env */
    private function runCompose(string $projectPath, string $projectName, array $args, array $env): void
    {
        $this->runComposeCapture($projectPath, $projectName, $args, $env, 900);
    }

    /**
     * @param list<string> $args
     * @param list<array{name?:string,value?:string}|array{Name?:string,Value?:string}> $env
     */
    private function runComposeCapture(
        string $projectPath,
        string $projectName,
        array $args,
        array $env,
        int $maxSeconds = 60,
    ): string {
        $composeFile = $this->findComposeFile($projectPath);
        $cmd = [
            ...$this->resolveComposeCommand(),
            '--progress', 'plain',
            '-f', $composeFile,
            '-p', $projectName,
            ...$args,
        ];

        $descriptors = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w'],
        ];

        $procEnv = [];
        foreach (array_merge($_SERVER, $_ENV) as $key => $value) {
            if (is_string($key) && (is_string($value) || is_int($value) || is_float($value) || is_bool($value))) {
                $procEnv[$key] = (string) $value;
            }
        }
        $procEnv['DOCKER_HOST'] = 'unix://' . $this->socketPath;
        $procEnv['COMPOSE_PROGRESS'] = 'plain';
        $procEnv['DOCKER_CLI_HINTS'] = 'false';
        // Avoid interactive TTY progress bars that flood stderr
        $procEnv['TERM'] = 'dumb';
        foreach ($env as $pair) {
            $name = (string) ($pair['name'] ?? $pair['Name'] ?? '');
            $value = (string) ($pair['value'] ?? $pair['Value'] ?? '');
            if ($name !== '') {
                $procEnv[$name] = $value;
            }
        }

        $process = proc_open($cmd, $descriptors, $pipes, $projectPath, $procEnv);
        if (!is_resource($process)) {
            throw new \RuntimeException('Échec du démarrage de docker compose');
        }
        fclose($pipes[0]);

        // Non-blocking read to avoid deadlock if buffers fill during long pulls
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);
        $stdout = '';
        $stderr = '';
        $start = time();
        $status = ['running' => true, 'exitcode' => -1];
        while (true) {
            $status = proc_get_status($process);
            $stdout .= stream_get_contents($pipes[1]) ?: '';
            $stderr .= stream_get_contents($pipes[2]) ?: '';
            if (!$status['running']) {
                break;
            }
            if ((time() - $start) > $maxSeconds) {
                proc_terminate($process, 9);
                fclose($pipes[1]);
                fclose($pipes[2]);
                proc_close($process);
                throw new \RuntimeException('Délai dépassé pendant docker compose (pull trop long ?)');
            }
            usleep(100_000);
        }
        $stdout .= stream_get_contents($pipes[1]) ?: '';
        $stderr .= stream_get_contents($pipes[2]) ?: '';
        fclose($pipes[1]);
        fclose($pipes[2]);
        $code = proc_close($process);
        // proc_get_status exitcode is more reliable after process ends
        if ($code === -1 && isset($status['exitcode']) && $status['exitcode'] >= 0) {
            $code = (int) $status['exitcode'];
        }

        if ($code !== 0) {
            throw new \RuntimeException($this->formatComposeError($stderr, $stdout, $code));
        }
        return $stdout;
    }

    private function formatComposeError(string $stderr, string $stdout, int $code): string
    {
        $raw = trim($stderr !== '' ? $stderr : $stdout);
        if ($raw === '') {
            return 'docker compose a échoué avec le code ' . $code;
        }
        // Strip ANSI
        $raw = preg_replace('/\x1b\[[0-9;]*[a-zA-Z]/', '', $raw) ?? $raw;
        $lines = preg_split("/\r\n|\n|\r/", $raw) ?: [];
        $important = [];
        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }
            // Skip noisy pull progress
            if (preg_match('/\b(Downloading|Extracting|Waiting|Pulling|Download complete|Pull complete|Already exists|Verifying Checksum|Digest:|Status:)\b/i', $line)) {
                continue;
            }
            if (preg_match('/^\[=*>?\s*\]/', $line)) {
                continue;
            }
            $important[] = $line;
        }
        if ($important === []) {
            // fallback: last few lines of raw
            $tail = array_slice(array_filter(array_map('trim', $lines)), -8);
            return implode("\n", $tail) !== ''
                ? implode("\n", $tail)
                : 'docker compose a échoué avec le code ' . $code;
        }
        // Prefer lines that look like errors
        $errors = array_values(array_filter($important, static fn(string $l): bool => (bool) preg_match('/error|failed|fatal|cannot|unable|denied|conflict|in use|invalid/i', $l)));
        $pick = $errors !== [] ? array_slice($errors, -6) : array_slice($important, -8);
        return implode("\n", $pick);
    }

    private function findComposeFile(string $projectPath): string
    {
        foreach (['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'] as $name) {
            $candidate = rtrim($projectPath, '/') . '/' . $name;
            if (is_file($candidate)) {
                return $candidate;
            }
        }
        throw new \RuntimeException('Aucun fichier Compose dans le répertoire du projet');
    }

    /** @return list<string> */
    private function resolveComposeCommand(): array
    {
        // Prefer `docker compose` plugin when available
        if (is_executable($this->dockerBin)) {
            return [$this->dockerBin, 'compose'];
        }
        if (is_executable($this->composeBin)) {
            return [$this->composeBin];
        }
        return ['docker', 'compose'];
    }
}
