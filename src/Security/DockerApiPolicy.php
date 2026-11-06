<?php
declare(strict_types=1);

namespace App\Security;

/**
 * Allow / deny Docker Engine API paths exposed through the proxy.
 */
final class DockerApiPolicy
{
    /**
     * Paths blocked for everyone (engine takeover / swarm / plugins).
     * @return string|null denial message
     */
    public static function denyAlways(string $method, string $path): ?string
    {
        $pathOnly = strtok($path, '?') ?: $path;
        $method = strtoupper($method);

        $blockedPrefixes = [
            '/plugins',
            '/swarm',
            '/nodes',
            '/secrets',
            '/configs',
            '/session',
            '/grpc',
            '/distribution',
        ];
        foreach ($blockedPrefixes as $prefix) {
            if ($pathOnly === $prefix || str_starts_with($pathOnly, $prefix . '/')) {
                return 'Endpoint Docker non autorisé : ' . $prefix;
            }
        }

        // Never allow hijacking via raw attach upgrade from HTTP proxy
        if (preg_match('#^/containers/[^/]+/attach#', $pathOnly)) {
            return 'Attach interactif non supporté via le proxy (utilisez la console)';
        }
        if (preg_match('#^/exec/[^/]+/start#', $pathOnly) && $method === 'POST') {
            // Allow only through our controlled /exec UI helper — block raw hijack
            return 'Exec brut non autorisé via le proxy (utilisez /api/.../exec)';
        }

        return null;
    }

    /**
     * Extra restrictions for non-admin users.
     */
    public static function denyNonAdmin(string $method, string $path): ?string
    {
        $pathOnly = strtok($path, '?') ?: $path;
        $method = strtoupper($method);

        if ($method === 'POST' && preg_match('#/(containers|images|networks|volumes|build)/prune#', $pathOnly)) {
            return 'Le nettoyage global est réservé aux administrateurs';
        }

        // Host filesystem write into containers via archive put — still ownership-checked,
        // but block recursive root writes patterns later; allow for owned containers.
        if ($method === 'POST' && ($pathOnly === '/images/load' || str_starts_with($pathOnly, '/images/load'))) {
            return 'Le chargement d’images (.tar) est réservé aux administrateurs';
        }

        if ($method === 'POST' && ($pathOnly === '/containers/create' || str_starts_with($pathOnly, '/containers/create'))) {
            return null; // sanitized separately
        }

        return null;
    }
}
