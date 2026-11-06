<?php
declare(strict_types=1);

namespace App\Security;

/**
 * Hardens container create / update payloads for non-admin users.
 * Prevents Docker socket escape and host filesystem takeover via binds.
 */
final class ContainerPolicy
{
    /** @var list<string> */
    private const DANGEROUS_HOST_PREFIXES = [
        '/',
        '/etc',
        '/root',
        '/home',
        '/var/run',
        '/run',
        '/proc',
        '/sys',
        '/dev',
        '/boot',
        '/usr',
        '/lib',
        '/lib64',
        '/opt',
        '/srv',
        '/mnt',
        '/media',
    ];

    /**
     * @param array<string, mixed> $body Docker container create JSON
     * @return array{0: array<string, mixed>, 1: list<string>} sanitized body + warnings
     */
    public static function sanitizeCreate(array $body, bool $isAdmin): array
    {
        if ($isAdmin) {
            return [$body, []];
        }

        $warnings = [];
        $hc = isset($body['HostConfig']) && is_array($body['HostConfig']) ? $body['HostConfig'] : [];

        foreach ([
            'Privileged' => false,
            'PublishAllPorts' => false,
        ] as $key => $value) {
            if (!empty($hc[$key])) {
                $warnings[] = $key . ' désactivé (réservé admin)';
            }
            $hc[$key] = $value;
        }

        foreach (['CapAdd', 'Devices', 'DeviceCgroupRules', 'DeviceRequests', 'Sysctls'] as $key) {
            if (!empty($hc[$key])) {
                $warnings[] = $key . ' retiré (réservé admin)';
                unset($hc[$key]);
            }
        }

        foreach (['PidMode', 'IpcMode', 'UTSMode', 'UsernsMode', 'CgroupnsMode'] as $key) {
            $val = strtolower((string) ($hc[$key] ?? ''));
            if ($val === 'host') {
                $warnings[] = $key . '=host retiré (réservé admin)';
                unset($hc[$key]);
            }
        }

        if (strtolower((string) ($hc['NetworkMode'] ?? '')) === 'host') {
            $warnings[] = 'NetworkMode=host retiré (réservé admin)';
            $hc['NetworkMode'] = 'bridge';
        }

        if (!empty($hc['SecurityOpt']) && is_array($hc['SecurityOpt'])) {
            $filtered = [];
            foreach ($hc['SecurityOpt'] as $opt) {
                $o = strtolower((string) $opt);
                if (str_contains($o, 'unconfined') || str_contains($o, 'seccomp=unconfined') || str_contains($o, 'apparmor=unconfined')) {
                    $warnings[] = 'SecurityOpt dangereux retiré';
                    continue;
                }
                $filtered[] = $opt;
            }
            $hc['SecurityOpt'] = $filtered;
        }

        if (!empty($hc['Binds']) && is_array($hc['Binds'])) {
            $safe = [];
            foreach ($hc['Binds'] as $bind) {
                if (!is_string($bind)) {
                    continue;
                }
                if (self::isDangerousBind($bind)) {
                    $warnings[] = 'Bind hôte refusé : ' . self::redactBind($bind);
                    continue;
                }
                $safe[] = $bind;
            }
            $hc['Binds'] = $safe;
        }

        if (!empty($hc['Mounts']) && is_array($hc['Mounts'])) {
            $safeMounts = [];
            foreach ($hc['Mounts'] as $mount) {
                if (!is_array($mount)) {
                    continue;
                }
                $type = strtolower((string) ($mount['Type'] ?? 'volume'));
                if ($type === 'bind') {
                    $src = (string) ($mount['Source'] ?? '');
                    if (self::isDangerousHostPath($src)) {
                        $warnings[] = 'Mount bind hôte refusé';
                        continue;
                    }
                }
                if ($type === 'volume') {
                    $src = (string) ($mount['Source'] ?? $mount['Name'] ?? '');
                    if ($src !== '' && !preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/', $src)) {
                        $warnings[] = 'Nom de volume invalide';
                        continue;
                    }
                }
                $safeMounts[] = $mount;
            }
            $hc['Mounts'] = $safeMounts;
        }

        $body['HostConfig'] = $hc;

        // Prevent overriding owner labels
        if (isset($body['Labels']) && is_array($body['Labels'])) {
            unset($body['Labels']['dockermanager.owner'], $body['Labels']['dockermanager.owner_id']);
        }

        return [$body, $warnings];
    }

    private static function redactBind(string $bind): string
    {
        $parts = explode(':', $bind, 2);
        return ($parts[0] ?? '?') . ':***';
    }

    public static function isDangerousBind(string $bind): bool
    {
        // host:container[:mode]
        $parts = explode(':', $bind);
        if ($parts === []) {
            return true;
        }
        $host = $parts[0];
        // named volume (no slash) is OK
        if ($host !== '' && !str_contains($host, '/') && !str_starts_with($host, '.')) {
            return false;
        }
        return self::isDangerousHostPath($host);
    }

    public static function isDangerousHostPath(string $path): bool
    {
        $path = trim($path);
        if ($path === '') {
            return true;
        }
        // Reject relative / traversal
        if (str_contains($path, '..') || str_starts_with($path, '.')) {
            return true;
        }
        $norm = rtrim(str_replace('\\', '/', $path), '/') ?: '/';
        $lower = strtolower($norm);

        foreach (['docker.sock', 'docker.so', '.ssh', 'id_rsa', 'shadow', 'passwd'] as $needle) {
            if (str_contains($lower, $needle)) {
                return true;
            }
        }

        // Any absolute host path is restricted for non-admins
        if (str_starts_with($norm, '/')) {
            return true;
        }

        return false;
    }

}

