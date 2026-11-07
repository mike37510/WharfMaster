<?php
declare(strict_types=1);

namespace App\Security;

/**
 * TLS certificate fingerprint helpers for WharfMaster agents (self-signed OK).
 * Fingerprint format: lowercase hex SHA-256 of the DER certificate (openssl_x509_fingerprint).
 */
final class AgentTls
{
    /**
     * @return array{fingerprint:string, expiresAt:?int}|null
     */
    public static function inspect(string $httpsUrl, float $timeout = 5.0): ?array
    {
        $parts = parse_url($httpsUrl);
        $host = (string) ($parts['host'] ?? '');
        $port = (int) ($parts['port'] ?? 443);
        if ($host === '' || $port < 1) {
            return null;
        }
        $ctx = stream_context_create([
            'ssl' => [
                'capture_peer_cert' => true,
                'verify_peer' => false,
                'verify_peer_name' => false,
                'allow_self_signed' => true,
            ],
        ]);
        $client = @stream_socket_client(
            'ssl://' . $host . ':' . $port,
            $errno,
            $errstr,
            $timeout,
            STREAM_CLIENT_CONNECT,
            $ctx,
        );
        if ($client === false) {
            return null;
        }
        $params = stream_context_get_params($ctx);
        fclose($client);
        $peer = $params['options']['ssl']['peer_certificate'] ?? null;
        if (!$peer) {
            return null;
        }
        $fp = openssl_x509_fingerprint($peer, 'sha256');
        if (!is_string($fp) || $fp === '') {
            return null;
        }
        $parsed = @openssl_x509_parse($peer);
        $expires = is_array($parsed) && !empty($parsed['validTo_time_t'])
            ? (int) $parsed['validTo_time_t']
            : null;
        return [
            'fingerprint' => strtolower($fp),
            'expiresAt' => $expires,
        ];
    }

    public static function fingerprint(string $httpsUrl, float $timeout = 5.0): ?string
    {
        $info = self::inspect($httpsUrl, $timeout);
        return $info['fingerprint'] ?? null;
    }

    /**
     * @throws \RuntimeException on mismatch or unreachable peer when expected is non-empty
     */
    public static function assertPinned(string $httpsUrl, string $expectedFingerprint, float $timeout = 5.0): string
    {
        $expected = strtolower(trim($expectedFingerprint));
        $info = self::inspect($httpsUrl, $timeout);
        if ($info === null) {
            throw new \RuntimeException('Impossible de lire le certificat TLS de l’agent', 502);
        }
        $got = $info['fingerprint'];
        if ($expected !== '' && !hash_equals($expected, $got)) {
            throw new \RuntimeException(
                'Empreinte TLS agent incorrecte (attendu ' . substr($expected, 0, 12)
                . '…, reçu ' . substr($got, 0, 12) . '…). Possible MITM ou certificat renouvelé — rejoignez le nœud.',
                495,
            );
        }
        return $got;
    }

    public static function short(string $fingerprint): string
    {
        $fp = strtolower(trim($fingerprint));
        if ($fp === '') {
            return '';
        }
        return substr($fp, 0, 12);
    }

    /**
     * Health check with Bearer (self-signed OK). Used to authorize pin refresh after cert renewal.
     */
    public static function healthOk(string $httpsUrl, string $bearerToken, float $timeout = 5.0): bool
    {
        $ch = curl_init(rtrim($httpsUrl, '/') . '/health');
        if ($ch === false) {
            return false;
        }
        $headers = ['Accept: application/json'];
        if ($bearerToken !== '') {
            $headers[] = 'Authorization: Bearer ' . $bearerToken;
        }
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => (int) ceil($timeout),
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_SSL_VERIFYHOST => 0,
        ]);
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($status !== 200 || !is_string($body)) {
            return false;
        }
        $json = json_decode($body, true);
        return is_array($json) && ($json['ok'] ?? false) === true;
    }
}
