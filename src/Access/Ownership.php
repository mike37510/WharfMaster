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

    /** @param array{id?:int,username?:string,role?:int,_endpointAdmin?:bool} $user */
    public static function isAdmin(array $user): bool
    {
        if (!empty($user['_endpointAdmin'])) {
            return true;
        }
        return (int) ($user['role'] ?? 0) === 1;
    }

    /** Global instance admin (ignores endpoint-level admin). */
    public static function isGlobalAdmin(array $user): bool
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
     * Merges into existing `labels:` maps and deduplicates keys (Compose rejects duplicates).
     *
     * @param array<string, string> $labels
     */
    public static function injectComposeServiceLabels(string $composeYaml, array $labels): string
    {
        if ($labels === [] || trim($composeYaml) === '') {
            return $composeYaml;
        }

        $lines = preg_split("/\r\n|\n|\r/", $composeYaml) ?: [];
        $out = [];
        $inServices = false;
        $servicesIndent = 0;
        $i = 0;
        $n = count($lines);

        while ($i < $n) {
            $line = $lines[$i];

            if (preg_match('/^( *)services\s*:\s*$/', $line, $m)) {
                $inServices = true;
                $servicesIndent = strlen($m[1]);
                $out[] = $line;
                $i++;
                continue;
            }

            if ($inServices && preg_match('/^( *)(\S[^:]*):\s*$/', $line, $m)) {
                $indent = strlen($m[1]);
                if ($indent <= $servicesIndent) {
                    $inServices = false;
                    $out[] = $line;
                    $i++;
                    continue;
                }
                if ($indent === $servicesIndent + 2) {
                    // Service block: consume properties, merge labels uniquely, re-emit
                    $out[] = $line;
                    $i++;
                    $serviceIndent = $indent;
                    $propIndent = $serviceIndent + 2;
                    $labelIndent = $propIndent + 2;
                    /** @var array<string, string> $labelsMap */
                    $labelsMap = [];
                    /** @var list<string> $labelOrder */
                    $labelOrder = [];
                    /** @var list<string> $otherProps */
                    $otherProps = [];

                    while ($i < $n) {
                        $prop = $lines[$i];
                        if (preg_match('/^( *)\S/', $prop, $pm)) {
                            $pi = strlen($pm[1]);
                            if ($pi <= $serviceIndent) {
                                break;
                            }
                            if ($pi === $propIndent && preg_match('/^( *)labels\s*:\s*$/', $prop)) {
                                $i++;
                                while ($i < $n) {
                                    $ll = $lines[$i];
                                    if (trim($ll) === '') {
                                        $i++;
                                        continue;
                                    }
                                    if (preg_match('/^( *)([^#:\s][^:]*):\s*(.*)$/', $ll, $lm)) {
                                        $li = strlen($lm[1]);
                                        if ($li <= $propIndent) {
                                            break;
                                        }
                                        if ($li === $labelIndent) {
                                            $key = trim($lm[2]);
                                            $val = trim($lm[3]);
                                            if ($key !== '') {
                                                if (!array_key_exists($key, $labelsMap)) {
                                                    $labelOrder[] = $key;
                                                }
                                                $labelsMap[$key] = $val; // last wins (dedupe)
                                            }
                                            $i++;
                                            continue;
                                        }
                                    }
                                    // Nested content under a label value — keep with previous key as opaque lines
                                    if (preg_match('/^( *)\S/', $ll, $xm) && strlen($xm[1]) > $labelIndent) {
                                        $i++;
                                        continue;
                                    }
                                    break;
                                }
                                continue;
                            }
                        }
                        $otherProps[] = $prop;
                        $i++;
                    }

                    foreach ($labels as $k => $v) {
                        $key = (string) $k;
                        $labelsMap[$key] = '"' . addcslashes((string) $v, "\\\"") . '"';
                        if (!in_array($key, $labelOrder, true)) {
                            $labelOrder[] = $key;
                        }
                    }

                    $out[] = str_repeat(' ', $propIndent) . 'labels:';
                    foreach ($labelOrder as $key) {
                        if (!array_key_exists($key, $labelsMap)) {
                            continue;
                        }
                        $out[] = str_repeat(' ', $labelIndent) . $key . ': ' . $labelsMap[$key];
                    }
                    foreach ($otherProps as $prop) {
                        $out[] = $prop;
                    }
                    continue;
                }
            }

            $out[] = $line;
            $i++;
        }

        $joined = implode("\n", $out);
        if (str_ends_with($composeYaml, "\n") && !str_ends_with($joined, "\n")) {
            $joined .= "\n";
        }
        return $joined;
    }
}
