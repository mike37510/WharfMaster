<?php
declare(strict_types=1);

namespace App\Security;

/**
 * Runs Trivy against a local Docker image (by ref or digest).
 */
final class ImageScanner
{
    /** Same window as stack/image update digest checks (24 h). */
    public const CACHE_TTL = \App\Stack\ImageUpdateChecker::STACK_CACHE_TTL;

    public function __construct(
        private readonly string $trivyBin = 'trivy',
        private readonly string $dockerSocket = '/var/run/docker.sock',
    ) {
    }

    public function available(): bool
    {
        $bin = $this->resolveBin();
        return $bin !== null;
    }

    public function resolveBin(): ?string
    {
        $env = getenv('TRIVY_BIN');
        $candidates = array_filter([
            is_string($env) && $env !== '' ? $env : null,
            $this->trivyBin !== 'trivy' ? $this->trivyBin : null,
            '/usr/local/bin/trivy',
            '/usr/bin/trivy',
            'trivy',
        ]);
        foreach ($candidates as $c) {
            if (!is_string($c) || $c === '') {
                continue;
            }
            // Absolute path: must exist + executable
            if (str_contains($c, '/')) {
                if (is_file($c) && is_executable($c)) {
                    return $c;
                }
                continue;
            }
            // Bare name: resolve via PATH (www-data may have a reduced PATH)
            $which = trim((string) shell_exec('command -v ' . escapeshellarg($c) . ' 2>/dev/null'));
            if ($which !== '' && is_executable($which)) {
                return $which;
            }
        }
        return null;
    }

    /**
     * @return array{summary:array<string,int>,findings:list<array<string,string>>,raw:string,status:string}
     */
    public function scanImage(string $imageRef, int $timeoutSec = 300): array
    {
        $bin = $this->resolveBin();
        if ($bin === null) {
            throw new \RuntimeException(
                'Trivy n\'est pas installé sur cette instance. Rebuild l\'image WharfMaster (Dockerfile inclut Trivy) ou placez le binaire dans /usr/local/bin/trivy.'
            );
        }
        $imageRef = trim($imageRef);
        if ($imageRef === '' || !preg_match('#^[a-zA-Z0-9._/:@-]+$#', $imageRef)) {
            throw new \InvalidArgumentException('Référence d\'image invalide');
        }

        $cmd = [
            $bin,
            'image',
            '--quiet',
            '--format', 'json',
            '--severity-exit-code', '0',
            '--scanners', 'vuln',
            $imageRef,
        ];
        $descriptors = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w'],
        ];
        $env = $_ENV + $_SERVER;
        $env['DOCKER_HOST'] = 'unix://' . $this->dockerSocket;
        $proc = proc_open($cmd, $descriptors, $pipes, null, $env);
        if (!is_resource($proc)) {
            throw new \RuntimeException('Impossible de démarrer Trivy');
        }
        fclose($pipes[0]);
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);
        $stdout = '';
        $stderr = '';
        $start = time();
        while (true) {
            $stdout .= stream_get_contents($pipes[1]) ?: '';
            $stderr .= stream_get_contents($pipes[2]) ?: '';
            $status = proc_get_status($proc);
            if (!$status['running']) {
                break;
            }
            if ((time() - $start) > $timeoutSec) {
                proc_terminate($proc, 9);
                throw new \RuntimeException('Scan Trivy expiré');
            }
            usleep(100_000);
        }
        $stdout .= stream_get_contents($pipes[1]) ?: '';
        $stderr .= stream_get_contents($pipes[2]) ?: '';
        fclose($pipes[1]);
        fclose($pipes[2]);
        $code = proc_close($proc);
        if ($code !== 0 && $stdout === '') {
            throw new \RuntimeException('Trivy a échoué : ' . trim($stderr !== '' ? $stderr : 'code ' . $code));
        }

        return $this->parseTrivyJson($stdout);
    }

    /**
     * @return array{summary:array<string,int>,findings:list<array<string,string>>,raw:string,status:string}
     */
    public function parseTrivyJson(string $json): array
    {
        $data = json_decode($json, true);
        $summary = [
            'CRITICAL' => 0,
            'HIGH' => 0,
            'MEDIUM' => 0,
            'LOW' => 0,
            'UNKNOWN' => 0,
            'TOTAL' => 0,
        ];
        $findings = [];
        if (!is_array($data)) {
            return ['summary' => $summary, 'findings' => [], 'raw' => $json, 'status' => 'error'];
        }
        $results = $data['Results'] ?? [];
        if (!is_array($results)) {
            $results = [];
        }
        foreach ($results as $result) {
            $vulns = $result['Vulnerabilities'] ?? [];
            if (!is_array($vulns)) {
                continue;
            }
            foreach ($vulns as $v) {
                if (!is_array($v)) {
                    continue;
                }
                $sev = strtoupper((string) ($v['Severity'] ?? 'UNKNOWN'));
                if (!isset($summary[$sev])) {
                    $sev = 'UNKNOWN';
                }
                $summary[$sev]++;
                $summary['TOTAL']++;
                $findings[] = [
                    'cve' => (string) ($v['VulnerabilityID'] ?? ''),
                    'package' => (string) ($v['PkgName'] ?? ''),
                    'version' => (string) ($v['InstalledVersion'] ?? ''),
                    'severity' => $sev,
                    'title' => (string) ($v['Title'] ?? $v['Description'] ?? ''),
                    'fixed_version' => (string) ($v['FixedVersion'] ?? ''),
                ];
            }
        }
        return [
            'summary' => $summary,
            'findings' => $findings,
            'raw' => $json,
            'status' => 'ok',
        ];
    }
}
