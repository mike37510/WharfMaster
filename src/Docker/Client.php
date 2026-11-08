<?php
declare(strict_types=1);

namespace App\Docker;

use App\Security\AgentTls;

final class Client
{
    public function __construct(
        private readonly string $socketPath = '',
        private readonly string $apiVersion = 'v1.45',
        private readonly string $baseUrl = '',
        private readonly string $bearerToken = '',
        private readonly string $tlsFingerprint = '',
    ) {
    }

    public static function unix(string $socketPath, string $apiVersion = 'v1.45'): self
    {
        return new self($socketPath, $apiVersion, '', '', '');
    }

    public static function httpAgent(
        string $baseUrl,
        string $bearerToken,
        string $apiVersion = 'v1.45',
        string $tlsFingerprint = '',
    ): self {
        return new self('', $apiVersion, rtrim($baseUrl, '/'), $bearerToken, $tlsFingerprint);
    }

    public function isRemote(): bool
    {
        return $this->baseUrl !== '';
    }

    /**
     * @return array{status:int, headers:array<string,string>, body:string}
     */
    public function request(
        string $method,
        string $path,
        ?string $body = null,
        array $headers = [],
        array $query = [],
    ): array {
        $path = $this->normalizePath($path);
        if ($query !== []) {
            $path .= (str_contains($path, '?') ? '&' : '?') . http_build_query($query);
        }

        $headerLines = [];
        foreach ($headers as $name => $value) {
            if (strcasecmp((string) $name, 'Host') === 0 || strcasecmp((string) $name, 'Content-Length') === 0) {
                continue;
            }
            $headerLines[] = $name . ': ' . $value;
        }
        if ($body !== null && $body !== '' && !$this->hasHeader($headerLines, 'Content-Type')) {
            $headerLines[] = 'Content-Type: application/json';
        }

        if ($this->baseUrl !== '') {
            return $this->requestHttp($method, $path, $body, $headerLines);
        }
        return $this->requestUnix($method, $path, $body, $headerLines);
    }

    /**
     * @param list<string> $headerLines
     * @return array{status:int, headers:array<string,string>, body:string}
     */
    private function requestUnix(string $method, string $path, ?string $body, array $headerLines): array
    {
        $url = 'http://localhost' . $path;
        $ch = curl_init($url);
        if ($ch === false) {
            throw new \RuntimeException("Impossible d'initialiser curl");
        }

        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => strtoupper($method),
            CURLOPT_UNIX_SOCKET_PATH => $this->socketPath,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HEADER => true,
            CURLOPT_TIMEOUT => 900,
            CURLOPT_HTTPHEADER => $headerLines,
        ]);

        if ($body !== null && strtoupper($method) !== 'GET' && strtoupper($method) !== 'HEAD') {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }

        return $this->execCurl($ch, 'Erreur du socket Docker : ');
    }

    /**
     * @param list<string> $headerLines
     * @return array{status:int, headers:array<string,string>, body:string}
     */
    private function requestHttp(string $method, string $path, ?string $body, array $headerLines): array
    {
        if ($this->tlsFingerprint !== '') {
            AgentTls::assertPinned($this->baseUrl, $this->tlsFingerprint);
        }

        // Agent exposes Docker API under /docker/* and health at /health
        $url = $this->baseUrl . '/docker' . $path;
        if ($this->bearerToken !== '' && !$this->hasHeader($headerLines, 'Authorization')) {
            $headerLines[] = 'Authorization: Bearer ' . $this->bearerToken;
        }

        $ch = curl_init($url);
        if ($ch === false) {
            throw new \RuntimeException("Impossible d'initialiser curl");
        }

        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => strtoupper($method),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HEADER => true,
            CURLOPT_TIMEOUT => 900,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_HTTPHEADER => $headerLines,
            // Pinning is enforced via AgentTls::assertPinned above (self-signed agents)
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_SSL_VERIFYHOST => 0,
        ]);

        if ($body !== null && strtoupper($method) !== 'GET' && strtoupper($method) !== 'HEAD') {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }

        return $this->execCurl($ch, 'Erreur agent Docker : ');
    }

    /**
     * @param \CurlHandle $ch
     * @return array{status:int, headers:array<string,string>, body:string}
     */
    private function execCurl(\CurlHandle $ch, string $errPrefix): array
    {
        $raw = curl_exec($ch);
        if ($raw === false) {
            $err = curl_error($ch);
            curl_close($ch);
            throw new \RuntimeException($errPrefix . $err);
        }

        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $headerSize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        curl_close($ch);

        $rawHeaders = substr($raw, 0, $headerSize);
        $responseBody = substr($raw, $headerSize);
        $parsedHeaders = $this->parseHeaders($rawHeaders);

        return [
            'status' => $status,
            'headers' => $parsedHeaders,
            'body' => $responseBody === false ? '' : $responseBody,
        ];
    }

    public function ping(): bool
    {
        try {
            if ($this->baseUrl !== '') {
                if ($this->tlsFingerprint !== '') {
                    AgentTls::assertPinned($this->baseUrl, $this->tlsFingerprint);
                }
                $ch = curl_init($this->baseUrl . '/health');
                if ($ch === false) {
                    return false;
                }
                $headers = [];
                if ($this->bearerToken !== '') {
                    $headers[] = 'Authorization: Bearer ' . $this->bearerToken;
                }
                curl_setopt_array($ch, [
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_TIMEOUT => 5,
                    CURLOPT_HTTPHEADER => $headers,
                    CURLOPT_SSL_VERIFYPEER => false,
                    CURLOPT_SSL_VERIFYHOST => 0,
                ]);
                $body = curl_exec($ch);
                $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
                curl_close($ch);
                if ($status === 200 && is_string($body)) {
                    $json = json_decode($body, true);
                    return is_array($json) && ($json['ok'] ?? false) === true;
                }
                return false;
            }
            $res = $this->request('GET', '/_ping');
            return $res['status'] === 200 && trim($res['body']) === 'OK';
        } catch (\Throwable) {
            return false;
        }
    }

    /** @return array<string, mixed> */
    public function json(string $method, string $path, ?array $payload = null, array $query = []): array
    {
        $body = $payload === null ? null : (json_encode($payload, JSON_UNESCAPED_SLASHES) ?: '{}');
        $res = $this->request($method, $path, $body, [], $query);
        $decoded = json_decode($res['body'], true);
        if ($res['status'] >= 400) {
            $message = is_array($decoded) ? ($decoded['message'] ?? $res['body']) : $res['body'];
            throw new \RuntimeException((string) $message, $res['status']);
        }
        return is_array($decoded) ? $decoded : [];
    }

    private function normalizePath(string $path): string
    {
        if ($path === '' || $path[0] !== '/') {
            $path = '/' . $path;
        }
        if ($path === '/_ping' || str_starts_with($path, '/v1.')) {
            return $path;
        }
        return '/' . $this->apiVersion . $path;
    }

    /** @param list<string> $headerLines */
    private function hasHeader(array $headerLines, string $name): bool
    {
        foreach ($headerLines as $line) {
            if (stripos($line, $name . ':') === 0) {
                return true;
            }
        }
        return false;
    }

    /** @return array<string, string> */
    private function parseHeaders(string $raw): array
    {
        $headers = [];
        foreach (explode("\r\n", $raw) as $line) {
            if (!str_contains($line, ':')) {
                continue;
            }
            [$name, $value] = explode(':', $line, 2);
            $headers[trim($name)] = trim($value);
        }
        return $headers;
    }
}
