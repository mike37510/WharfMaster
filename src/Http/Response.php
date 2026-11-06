<?php
declare(strict_types=1);

namespace App\Http;

final class Response
{
    /** @param array<string, string> $headers */
    public function __construct(
        public readonly int $status,
        public readonly string $body,
        public readonly array $headers = [],
    ) {
    }

    public static function json(mixed $data, int $status = 200, array $headers = []): self
    {
        $headers['Content-Type'] = 'application/json';
        return new self($status, json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?: 'null', $headers);
    }

    public static function text(string $body, int $status = 200, array $headers = []): self
    {
        if (!isset($headers['Content-Type'])) {
            $headers['Content-Type'] = 'text/plain; charset=utf-8';
        }
        return new self($status, $body, $headers);
    }

    public static function empty(int $status = 204): self
    {
        return new self($status, '', []);
    }

    public static function error(string $message, int $status = 400, array $details = []): self
    {
        $payload = ['message' => $message];
        if ($details !== []) {
            $payload['details'] = $details;
        }
        return self::json($payload, $status);
    }

    public function withSecurityHeaders(): self
    {
        $headers = $this->headers;
        $headers['X-Content-Type-Options'] = 'nosniff';
        $headers['X-Frame-Options'] = 'DENY';
        $headers['Referrer-Policy'] = 'same-origin';
        $headers['Permissions-Policy'] = 'camera=(), microphone=(), geolocation=()';
        $headers['Cross-Origin-Resource-Policy'] = 'same-origin';
        $headers['Cache-Control'] = $headers['Cache-Control'] ?? 'no-store';
        if (!isset($headers['Content-Security-Policy'])) {
            $headers['Content-Security-Policy'] = "default-src 'none'; frame-ancestors 'none'";
        }
        return new self($this->status, $this->body, $headers);
    }

    /**
     * Same-origin only. Do not reflect arbitrary Origin.
     */
    public function withCors(?string $origin = null): self
    {
        $headers = $this->headers;
        $allowed = self::allowedOrigin($origin);
        if ($allowed !== null) {
            $headers['Access-Control-Allow-Origin'] = $allowed;
            $headers['Access-Control-Allow-Credentials'] = 'true';
            $headers['Vary'] = 'Origin';
        }
        $headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, X-API-Key';
        $headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
        $headers['Access-Control-Max-Age'] = '600';
        return new self($this->status, $this->body, $headers);
    }

    private static function allowedOrigin(?string $origin): ?string
    {
        if ($origin === null || $origin === '') {
            return null;
        }
        $host = $_SERVER['HTTP_HOST'] ?? '';
        if ($host === '') {
            return null;
        }
        $parsed = parse_url($origin);
        if (!is_array($parsed) || empty($parsed['host'])) {
            return null;
        }
        $originHost = $parsed['host'] . (isset($parsed['port']) ? ':' . $parsed['port'] : '');
        if (strcasecmp($originHost, $host) !== 0) {
            return null;
        }
        $scheme = $parsed['scheme'] ?? 'https';
        if (!in_array($scheme, ['http', 'https'], true)) {
            return null;
        }
        return $scheme . '://' . $originHost;
    }

    public function send(): void
    {
        http_response_code($this->status);
        foreach ($this->headers as $name => $value) {
            header($name . ': ' . $value, true);
        }
        echo $this->body;
    }
}
