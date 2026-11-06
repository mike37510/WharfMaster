<?php
declare(strict_types=1);

namespace App\Docker;

final class Client
{
    public function __construct(
        private readonly string $socketPath,
        private readonly string $apiVersion = 'v1.45',
    ) {
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

        $url = 'http://localhost' . $path;
        $ch = curl_init($url);
        if ($ch === false) {
            throw new \RuntimeException("Impossible d'initialiser curl");
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

        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => strtoupper($method),
            CURLOPT_UNIX_SOCKET_PATH => $this->socketPath,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HEADER => true,
            CURLOPT_TIMEOUT => 300,
            CURLOPT_HTTPHEADER => $headerLines,
        ]);

        if ($body !== null && strtoupper($method) !== 'GET' && strtoupper($method) !== 'HEAD') {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }

        $raw = curl_exec($ch);
        if ($raw === false) {
            $err = curl_error($ch);
            curl_close($ch);
            throw new \RuntimeException('Erreur du socket Docker : ' . $err);
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
