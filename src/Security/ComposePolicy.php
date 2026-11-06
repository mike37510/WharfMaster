<?php
declare(strict_types=1);

namespace App\Security;

/**
 * Policy on a fully resolved Compose project (docker compose config --format json).
 * Catches YAML/env tricks that a text regex would miss.
 */
final class ComposePolicy
{
    /**
     * @param array<string, mixed> $resolved Output of `docker compose config --format json`
     * @return list<string>
     */
    public static function violations(array $resolved): array
    {
        $errors = [];

        $services = $resolved['services'] ?? [];
        if (!is_array($services)) {
            return ['Fichier Compose invalide (services manquants)'];
        }

        foreach ($services as $name => $svc) {
            if (!is_array($svc)) {
                continue;
            }
            $label = 'service « ' . (string) $name . ' »';
            $errors = array_merge($errors, self::serviceViolations($label, $svc));
        }

        $volumes = $resolved['volumes'] ?? [];
        if (is_array($volumes)) {
            foreach ($volumes as $volName => $vol) {
                if (!is_array($vol)) {
                    continue;
                }
                $errors = array_merge($errors, self::namedVolumeViolations((string) $volName, $vol));
            }
        }

        $secrets = $resolved['secrets'] ?? [];
        if (is_array($secrets)) {
            foreach ($secrets as $secName => $sec) {
                if (!is_array($sec)) {
                    continue;
                }
                if (!empty($sec['file']) || !empty($sec['external'])) {
                    // file-based secrets read host paths; block for non-admin
                    if (!empty($sec['file'])) {
                        $errors[] = 'secret « ' . (string) $secName . ' » : les secrets fichier (hôte) sont réservés aux administrateurs';
                    }
                }
            }
        }

        $configs = $resolved['configs'] ?? [];
        if (is_array($configs)) {
            foreach ($configs as $cfgName => $cfg) {
                if (!is_array($cfg)) {
                    continue;
                }
                if (!empty($cfg['file'])) {
                    $errors[] = 'config « ' . (string) $cfgName . ' » : les configs fichier (hôte) sont réservées aux administrateurs';
                }
            }
        }

        return array_values(array_unique($errors));
    }

    /**
     * @param array<string, mixed> $svc
     * @return list<string>
     */
    private static function serviceViolations(string $label, array $svc): array
    {
        $errors = [];

        if (!empty($svc['privileged'])) {
            $errors[] = $label . ' : privileged est réservé aux administrateurs';
        }

        foreach (['network_mode' => 'network_mode', 'pid' => 'pid', 'ipc' => 'ipc', 'uts' => 'uts', 'userns_mode' => 'userns_mode', 'cgroup' => 'cgroup'] as $key => $human) {
            $val = strtolower((string) ($svc[$key] ?? ''));
            if ($val === 'host' || str_starts_with($val, 'host')) {
                $errors[] = $label . ' : ' . $human . '=host est réservé aux administrateurs';
            }
            // Sharing another container's namespace can also escalate; block for non-admin
            if (str_starts_with($val, 'container:')) {
                $errors[] = $label . ' : ' . $human . '=container:… est réservé aux administrateurs';
            }
        }

        if (!empty($svc['cap_add']) && is_array($svc['cap_add']) && $svc['cap_add'] !== []) {
            $errors[] = $label . ' : cap_add est réservé aux administrateurs';
        }

        if (!empty($svc['devices']) && is_array($svc['devices']) && $svc['devices'] !== []) {
            $errors[] = $label . ' : devices est réservé aux administrateurs';
        }

        if (!empty($svc['device_cgroup_rules']) && is_array($svc['device_cgroup_rules']) && $svc['device_cgroup_rules'] !== []) {
            $errors[] = $label . ' : device_cgroup_rules est réservé aux administrateurs';
        }

        if (!empty($svc['sysctls']) && (is_array($svc['sysctls']) ? $svc['sysctls'] !== [] : true)) {
            $errors[] = $label . ' : sysctls est réservé aux administrateurs';
        }

        if (!empty($svc['security_opt']) && is_array($svc['security_opt'])) {
            foreach ($svc['security_opt'] as $opt) {
                $o = strtolower((string) $opt);
                if (str_contains($o, 'unconfined')) {
                    $errors[] = $label . ' : security_opt unconfined est réservé aux administrateurs';
                    break;
                }
            }
        }

        $vols = $svc['volumes'] ?? [];
        if (is_array($vols)) {
            foreach ($vols as $mount) {
                if (!is_array($mount)) {
                    // short string form should already be expanded by compose config
                    if (is_string($mount) && self::looksLikeHostBind($mount)) {
                        $errors[] = $label . ' : bind hôte interdit — utilisez un volume nommé';
                    }
                    continue;
                }
                $type = strtolower((string) ($mount['type'] ?? 'volume'));
                if ($type === 'bind') {
                    $src = (string) ($mount['source'] ?? '');
                    $errors[] = $label . ' : montage bind hôte interdit'
                        . ($src !== '' ? ' (' . self::redactPath($src) . ')' : '')
                        . ' — utilisez un volume nommé';
                    if (self::isDockerSocketPath($src)) {
                        $errors[] = $label . ' : montage du socket Docker interdit';
                    }
                }
                if ($type === 'volume') {
                    $src = (string) ($mount['source'] ?? '');
                    if ($src !== '' && !preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/', $src) && str_contains($src, '/')) {
                        $errors[] = $label . ' : source de volume suspecte';
                    }
                }
            }
        }

        return $errors;
    }

    /**
     * @param array<string, mixed> $vol
     * @return list<string>
     */
    private static function namedVolumeViolations(string $name, array $vol): array
    {
        $errors = [];
        $opts = $vol['driver_opts'] ?? null;
        if (!is_array($opts)) {
            return $errors;
        }
        $joined = strtolower(implode(' ', array_map(static fn($v) => (string) $v, $opts)));
        $device = (string) ($opts['device'] ?? $opts['Device'] ?? '');
        $o = strtolower((string) ($opts['o'] ?? $opts['O'] ?? ''));
        $type = strtolower((string) ($opts['type'] ?? $opts['Type'] ?? ''));

        if (str_contains($o, 'bind') || $type === 'none' || str_contains($joined, 'bind')) {
            if ($device !== '' && (str_starts_with($device, '/') || str_starts_with($device, '.'))) {
                $errors[] = 'volume « ' . $name . ' » : driver_opts bind vers l’hôte interdit ('
                    . self::redactPath($device) . ')';
            }
        }
        if (self::isDockerSocketPath($device) || self::isDockerSocketPath($joined)) {
            $errors[] = 'volume « ' . $name . ' » : socket Docker interdit';
        }
        return $errors;
    }

    private static function looksLikeHostBind(string $mount): bool
    {
        $src = explode(':', $mount, 2)[0] ?? '';
        return str_starts_with($src, '/') || str_starts_with($src, '.') || self::isDockerSocketPath($src);
    }

    private static function isDockerSocketPath(string $path): bool
    {
        $p = strtolower($path);
        return str_contains($p, 'docker.sock')
            || str_contains($p, 'docker.so')
            || str_contains($p, '/var/run/docker')
            || str_contains($p, '/run/docker');
    }

    private static function redactPath(string $path): string
    {
        $path = trim($path);
        if (strlen($path) <= 48) {
            return $path;
        }
        return substr($path, 0, 20) . '…' . substr($path, -12);
    }
}
