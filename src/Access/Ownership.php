<?php
declare(strict_types=1);

namespace App\Access;

/**
 * Multi-user isolation for WharfMaster resources.
 *
 * Admins (role=1) see everything. Other users only see resources labeled
 * with their username / id, or app records they own (stacks, registries).
 */
final class Ownership
{
    public const LABEL_OWNER = 'dockermanager.owner';
    public const LABEL_OWNER_ID = 'dockermanager.owner_id';
    public const COMPOSE_PROJECT = 'com.docker.compose.project';

    /** @param array{id?:int,username?:string,role?:int} $user */
    public static function isAdmin(array $user): bool
    {
        return (int) ($user['role'] ?? 0) === 1;
    }

    /** @param array{id?:int,username?:string,role?:int} $user */
    public static function username(array $user): string
    {
        return (string) ($user['username'] ?? '');
    }

    /** @param array{id?:int,username?:string,role?:int} $user */
    public static function userId(array $user): int
    {
        return (int) ($user['id'] ?? 0);
    }

    /**
     * Labels to stamp on created Docker objects.
     * @param array{id?:int,username?:string,role?:int} $user
     * @return array<string, string>
     */
    public static function labelsFor(array $user): array
    {
        return [
            self::LABEL_OWNER => self::username($user),
            self::LABEL_OWNER_ID => (string) self::userId($user),
        ];
    }

    /**
     * @param array<string, mixed>|null $labels
     * @param array{id?:int,username?:string,role?:int} $user
     */
    public static function ownsLabels(?array $labels, array $user): bool
    {
        if (self::isAdmin($user)) {
            return true;
        }
        if (!is_array($labels) || $labels === []) {
            return false;
        }
        $owner = (string) ($labels[self::LABEL_OWNER] ?? '');
        $ownerId = (string) ($labels[self::LABEL_OWNER_ID] ?? '');
        if ($ownerId !== '' && $ownerId === (string) self::userId($user)) {
            return true;
        }
        if ($owner !== '' && strcasecmp($owner, self::username($user)) === 0) {
            return true;
        }
        return false;
    }

    /**
     * Container/volume belongs to user via owner label OR compose project they own.
     * @param array<string, mixed>|null $labels
     * @param array{id?:int,username?:string,role?:int} $user
     * @param list<string> $ownedStackNames
     */
    public static function ownsDockerResource(?array $labels, array $user, array $ownedStackNames = []): bool
    {
        if (self::isAdmin($user)) {
            return true;
        }
        if (self::ownsLabels($labels, $user)) {
            return true;
        }
        if ($ownedStackNames === [] || !is_array($labels)) {
            return false;
        }
        $project = (string) ($labels[self::COMPOSE_PROJECT] ?? '');
        if ($project === '') {
            return false;
        }
        foreach ($ownedStackNames as $name) {
            if (strcasecmp($project, (string) $name) === 0) {
                return true;
            }
        }
        return false;
    }

    /**
     * Merge owner labels into a Labels map (container/volume/network create body).
     * @param array<string, mixed>|null $existing
     * @param array{id?:int,username?:string,role?:int} $user
     * @return array<string, string>
     */
    public static function mergeLabels(?array $existing, array $user): array
    {
        $out = [];
        if (is_array($existing)) {
            foreach ($existing as $k => $v) {
                if (is_string($k)) {
                    $out[$k] = is_scalar($v) || $v === null ? (string) $v : '';
                }
            }
        }
        foreach (self::labelsFor($user) as $k => $v) {
            $out[$k] = $v;
        }
        return $out;
    }

    /**
     * Inject owner labels under every Compose service (best-effort YAML edit).
     * @param array<string, string> $labels
     */
    public static function injectComposeServiceLabels(string $composeYaml, array $labels): string
    {
        if ($labels === [] || trim($composeYaml) === '') {
            return $composeYaml;
        }
        $labelBlock = "    labels:\n";
        foreach ($labels as $k => $v) {
            $labelBlock .= '      ' . $k . ': "' . addcslashes((string) $v, "\\\"") . "\"\n";
        }

        $lines = preg_split("/\r\n|\n|\r/", $composeYaml) ?: [];
        $out = [];
        $inServices = false;
        $servicesIndent = 0;
        $pendingService = false;
        $serviceIndent = 0;

        foreach ($lines as $line) {
            if (preg_match('/^( *)services\s*:\s*$/', $line, $m)) {
                $inServices = true;
                $servicesIndent = strlen($m[1]);
                $out[] = $line;
                continue;
            }
            if ($inServices && preg_match('/^( *)(\S[^:]*):\s*$/', $line, $m)) {
                $indent = strlen($m[1]);
                if ($indent <= $servicesIndent) {
                    // left services section
                    if ($pendingService) {
                        $out[] = rtrim($labelBlock);
                        $pendingService = false;
                    }
                    $inServices = false;
                    $out[] = $line;
                    continue;
                }
                if ($indent === $servicesIndent + 2) {
                    if ($pendingService) {
                        $out[] = rtrim($labelBlock);
                    }
                    $pendingService = true;
                    $serviceIndent = $indent;
                    $out[] = $line;
                    continue;
                }
            }
            if ($pendingService && preg_match('/^( *)labels\s*:\s*$/', $line, $m) && strlen($m[1]) === $serviceIndent + 2) {
                // merge into existing labels block
                $out[] = $line;
                foreach ($labels as $k => $v) {
                    $out[] = str_repeat(' ', $serviceIndent + 4) . $k . ': "' . addcslashes((string) $v, "\\\"") . '"';
                }
                $pendingService = false;
                continue;
            }
            if ($pendingService && preg_match('/^( *)\S/', $line, $m) && strlen($m[1]) === $serviceIndent + 2) {
                // first property of service — insert labels before it
                $out[] = rtrim($labelBlock);
                $pendingService = false;
                $out[] = $line;
                continue;
            }
            $out[] = $line;
        }
        if ($pendingService) {
            $out[] = rtrim($labelBlock);
        }
        return implode("\n", $out) . (str_ends_with($composeYaml, "\n") ? "\n" : '');
    }
}
