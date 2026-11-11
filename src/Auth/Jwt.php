<?php
declare(strict_types=1);

namespace App\Auth;

final class Jwt
{
    public function __construct(
        private readonly string $secret,
        private readonly int $ttl = 28800,
    ) {
    }

    /** @param array<string, mixed> $claims */
    public function encode(array $claims): string
    {
        return $this->encodeWithTtl($claims, $this->ttl);
    }

    /** @param array<string, mixed> $claims */
    public function encodeWithTtl(array $claims, int $ttlSeconds): string
    {
        $header = ['alg' => 'HS256', 'typ' => 'JWT'];
        $now = time();
        $ttl = max(30, $ttlSeconds);
        $payload = array_merge($claims, [
            'iat' => $now,
            'exp' => $now + $ttl,
        ]);

        $segments = [
            $this->b64(json_encode($header, JSON_UNESCAPED_SLASHES) ?: '{}'),
            $this->b64(json_encode($payload, JSON_UNESCAPED_SLASHES) ?: '{}'),
        ];
        $signingInput = implode('.', $segments);
        $signature = hash_hmac('sha256', $signingInput, $this->secret, true);
        $segments[] = $this->b64($signature);

        return implode('.', $segments);
    }

    /** @return array<string, mixed>|null */
    public function decode(string $token): ?array
    {
        $parts = explode('.', $token);
        if (count($parts) !== 3) {
            return null;
        }

        [$h64, $p64, $s64] = $parts;
        $expected = $this->b64(hash_hmac('sha256', $h64 . '.' . $p64, $this->secret, true));
        if (!hash_equals($expected, $s64)) {
            return null;
        }

        $payload = json_decode($this->ub64($p64), true);
        if (!is_array($payload)) {
            return null;
        }
        if (isset($payload['exp']) && (int) $payload['exp'] < time()) {
            return null;
        }

        return $payload;
    }

    private function b64(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    private function ub64(string $data): string
    {
        $remainder = strlen($data) % 4;
        if ($remainder) {
            $data .= str_repeat('=', 4 - $remainder);
        }
        return (string) base64_decode(strtr($data, '-_', '+/'), true);
    }
}
