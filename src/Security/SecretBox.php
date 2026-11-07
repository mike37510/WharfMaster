<?php
declare(strict_types=1);

namespace App\Security;

/**
 * Encrypt registry passwords at rest (AES-256-GCM).
 * Prefix: enc:v1:<base64(iv|tag|ciphertext)>
 */
final class SecretBox
{
    private const PREFIX = 'enc:v1:';

    public function __construct(
        private readonly string $keyMaterial,
    ) {
    }

    public static function fromConfig(array $config): self
    {
        $key = (string) (getenv('WM_MASTER_KEY') ?: '');
        if ($key === '') {
            $key = (string) ($config['jwt_secret'] ?? '');
        }
        return new self($key);
    }

    private function keyBytes(): string
    {
        return hash('sha256', $this->keyMaterial, true);
    }

    public function encrypt(string $plaintext): string
    {
        if ($plaintext === '' || $this->isEncrypted($plaintext)) {
            return $plaintext;
        }
        if ($this->keyMaterial === '') {
            return $plaintext;
        }
        $iv = random_bytes(12);
        $tag = '';
        $cipher = openssl_encrypt(
            $plaintext,
            'aes-256-gcm',
            $this->keyBytes(),
            OPENSSL_RAW_DATA,
            $iv,
            $tag,
            '',
            16,
        );
        if ($cipher === false) {
            throw new \RuntimeException('Échec du chiffrement du secret');
        }
        return self::PREFIX . base64_encode($iv . $tag . $cipher);
    }

    public function decrypt(string $stored): string
    {
        if ($stored === '' || !$this->isEncrypted($stored)) {
            return $stored;
        }
        if ($this->keyMaterial === '') {
            throw new \RuntimeException('WM_MASTER_KEY / jwt_secret manquant pour déchiffrer');
        }
        $raw = base64_decode(substr($stored, strlen(self::PREFIX)), true);
        if ($raw === false || strlen($raw) < 28) {
            throw new \RuntimeException('Secret chiffré invalide');
        }
        $iv = substr($raw, 0, 12);
        $tag = substr($raw, 12, 16);
        $cipher = substr($raw, 28);
        $plain = openssl_decrypt(
            $cipher,
            'aes-256-gcm',
            $this->keyBytes(),
            OPENSSL_RAW_DATA,
            $iv,
            $tag,
        );
        if ($plain === false) {
            throw new \RuntimeException('Échec du déchiffrement du secret');
        }
        return $plain;
    }

    public function isEncrypted(string $value): bool
    {
        return str_starts_with($value, self::PREFIX);
    }
}
