<?php
declare(strict_types=1);

namespace App\Security;

/**
 * Simple filesystem rate limiter (no Redis required).
 */
final class RateLimiter
{
    public function __construct(
        private readonly string $dir,
        private readonly int $maxAttempts = 8,
        private readonly int $windowSeconds = 900,
    ) {
        if (!is_dir($this->dir)) {
            mkdir($this->dir, 0700, true);
        }
    }

    public function tooMany(string $bucket): bool
    {
        $state = $this->read($bucket);
        $now = time();
        if ($state['reset'] <= $now) {
            return false;
        }
        return $state['count'] >= $this->maxAttempts;
    }

    public function hit(string $bucket): void
    {
        $state = $this->read($bucket);
        $now = time();
        if ($state['reset'] <= $now) {
            $state = ['count' => 0, 'reset' => $now + $this->windowSeconds];
        }
        $state['count']++;
        $this->write($bucket, $state);
    }

    public function clear(string $bucket): void
    {
        $file = $this->file($bucket);
        if (is_file($file)) {
            @unlink($file);
        }
    }

    public function retryAfter(string $bucket): int
    {
        $state = $this->read($bucket);
        return max(0, $state['reset'] - time());
    }

    /** @return array{count:int,reset:int} */
    private function read(string $bucket): array
    {
        $file = $this->file($bucket);
        if (!is_file($file)) {
            return ['count' => 0, 'reset' => time() + $this->windowSeconds];
        }
        $raw = @file_get_contents($file);
        $data = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($data)) {
            return ['count' => 0, 'reset' => time() + $this->windowSeconds];
        }
        return [
            'count' => (int) ($data['count'] ?? 0),
            'reset' => (int) ($data['reset'] ?? time() + $this->windowSeconds),
        ];
    }

    /** @param array{count:int,reset:int} $state */
    private function write(string $bucket, array $state): void
    {
        $file = $this->file($bucket);
        $tmp = $file . '.' . bin2hex(random_bytes(4));
        file_put_contents($tmp, json_encode($state), LOCK_EX);
        chmod($tmp, 0600);
        rename($tmp, $file);
    }

    private function file(string $bucket): string
    {
        return $this->dir . '/' . hash('sha256', $bucket) . '.json';
    }
}
