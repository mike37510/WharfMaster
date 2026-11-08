<?php
declare(strict_types=1);

namespace App\Docker;

use App\Security\AgentTls;

/**
 * HTTPS client for WharfMaster agent Compose API (/compose/up|down|…).
 */
final class AgentComposeClient
{
    private readonly string $baseUrl;

    public function __construct(
        string $baseUrl,
        private readonly string $bearerToken,
        private readonly string $tlsFingerprint = '',
    ) {
        $this->baseUrl = rtrim($baseUrl, '/');
    }

    /**
     * @param list<array{name?:string,value?:string,Name?:string,Value?:string}> $env
     * @return array<string, mixed>
     */
    public function up(
        string $name,
        string $composeFile,
        array $env = [],
        string $entryPoint = 'docker-compose.yml',
        bool $pull = false,
    ): array {
        return $this->post('/compose/up', [
            'name' => $name,
            'composeFile' => $composeFile,
            'env' => $env,
            'entryPoint' => $entryPoint,
            'pull' => $pull,
        ], 900);
    }

    /**
     * @param list<array{name?:string,value?:string,Name?:string,Value?:string}> $env
     * @return array<string, mixed>
     */
    public function down(string $name, array $env = [], string $entryPoint = 'docker-compose.yml'): array
    {
        return $this->post('/compose/down', [
            'name' => $name,
            'env' => $env,
            'entryPoint' => $entryPoint,
        ], 300);
    }

    /**
     * @param list<array{name?:string,value?:string,Name?:string,Value?:string}> $env
     * @return array<string, mixed>
     */
    public function start(string $name, array $env = [], string $entryPoint = 'docker-compose.yml'): array
    {
        return $this->post('/compose/start', [
            'name' => $name,
            'env' => $env,
            'entryPoint' => $entryPoint,
        ], 300);
    }

    /**
     * @param list<array{name?:string,value?:string,Name?:string,Value?:string}> $env
     * @return array<string, mixed>
     */
    public function stop(string $name, array $env = [], string $entryPoint = 'docker-compose.yml'): array
    {
        return $this->post('/compose/stop', [
            'name' => $name,
            'env' => $env,
            'entryPoint' => $entryPoint,
        ], 300);
    }

    /**
     * @param list<array{name?:string,value?:string,Name?:string,Value?:string}> $env
     * @return array<string, mixed>
     */
    public function restart(string $name, array $env = [], string $entryPoint = 'docker-compose.yml'): array
    {
        return $this->post('/compose/restart', [
            'name' => $name,
            'env' => $env,
            'entryPoint' => $entryPoint,
        ], 300);
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    private function post(string $path, array $payload, int $timeout): array
    {
        if ($this->tlsFingerprint !== '') {
            AgentTls::assertPinned($this->baseUrl, $this->tlsFingerprint);
        }
        $url = $this->baseUrl . $path;
        $ch = curl_init($url);
        if ($ch === false) {
            throw new \RuntimeException('curl init failed');
        }
        $body = json_encode($payload, JSON_UNESCAPED_SLASHES) ?: '{}';
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => 'POST',
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'Accept: application/json',
                'Authorization: Bearer ' . $this->bearerToken,
            ],
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_SSL_VERIFYHOST => 0,
        ]);
        $raw = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($raw === false) {
            throw new \RuntimeException('Agent compose unreachable: ' . $err, 502);
        }
        $decoded = json_decode($raw, true);
        if (!is_array($decoded)) {
            throw new \RuntimeException('Réponse agent invalide (HTTP ' . $status . ')', $status >= 400 ? $status : 502);
        }
        if ($status >= 400 || empty($decoded['ok'])) {
            $msg = (string) ($decoded['message'] ?? ('Erreur agent HTTP ' . $status));
            throw new \RuntimeException($msg, $status >= 400 ? $status : 500);
        }
        return $decoded;
    }
}
