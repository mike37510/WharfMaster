<?php
declare(strict_types=1);

namespace App\Stack;

/**
 * Extract host bind mounts from a Compose file.
 *
 * @phpstan-type BindRow array{name:string,hostPath:string,target:string}
 */
final class BindVolumeExtractor
{
    /**
     * @return list<BindRow>
     */
    public static function fromCompose(string $content, string $stackName = '', string $projectDir = ''): array
    {
        $stackName = self::slug($stackName !== '' ? $stackName : 'stack');
        $projectDir = rtrim(str_replace('\\', '/', $projectDir), '/');
        $binds = [];

        // Long syntax: type: bind + source/target (possibly multiline-ish via naive scan)
        if (preg_match_all(
            '/type:\s*bind\b[\s\S]*?(?:source|Source):\s*["\']?([^\s"\'#]+)["\']?[\s\S]*?(?:target|Target):\s*["\']?([^\s"\'#]+)["\']?/i',
            $content,
            $longMatches,
            PREG_SET_ORDER,
        )) {
            foreach ($longMatches as $m) {
                $host = self::resolveHostPath(trim($m[1]), $projectDir);
                $target = trim($m[2]);
                if ($host !== null) {
                    $binds[] = self::row($stackName, $host, $target);
                }
            }
        }

        // Also catch target-before-source order
        if (preg_match_all(
            '/type:\s*bind\b[\s\S]*?(?:target|Target):\s*["\']?([^\s"\'#]+)["\']?[\s\S]*?(?:source|Source):\s*["\']?([^\s"\'#]+)["\']?/i',
            $content,
            $longMatches2,
            PREG_SET_ORDER,
        )) {
            foreach ($longMatches2 as $m) {
                $host = self::resolveHostPath(trim($m[2]), $projectDir);
                $target = trim($m[1]);
                if ($host !== null) {
                    $binds[] = self::row($stackName, $host, $target);
                }
            }
        }

        // Short syntax lines under volumes:  - /host:/container[:ro]
        // Avoid matching named volumes (no leading . or /)
        if (preg_match_all(
            '/^\s*-\s*["\']?((?:\.\/|\.\.\/|\/)[^"\'#\n]+?)["\']?\s*$/m',
            $content,
            $shortMatches,
        )) {
            foreach ($shortMatches[1] as $spec) {
                $spec = trim($spec);
                $parts = explode(':', $spec);
                if (count($parts) < 2) {
                    continue;
                }
                // Windows drive letter edge-case skipped; Linux/agent hosts only
                $hostRaw = $parts[0];
                $target = $parts[1];
                if ($target === '' || str_starts_with($target, './') || str_starts_with($target, '../')) {
                    continue;
                }
                $host = self::resolveHostPath($hostRaw, $projectDir);
                if ($host !== null) {
                    $binds[] = self::row($stackName, $host, $target);
                }
            }
        }

        // Dedupe by host path
        $out = [];
        $seen = [];
        foreach ($binds as $b) {
            $key = strtolower($b['hostPath']);
            if (isset($seen[$key])) {
                continue;
            }
            $seen[$key] = true;
            $out[] = $b;
        }
        return $out;
    }

    /**
     * @return BindRow
     */
    private static function row(string $stackName, string $hostPath, string $target): array
    {
        $base = basename(rtrim($hostPath, '/'));
        if ($base === '' || $base === '.' || $base === '/') {
            $base = 'bind';
        }
        $name = self::slug($stackName . '-' . $base);
        return [
            'name' => $name,
            'hostPath' => $hostPath,
            'target' => $target,
        ];
    }

    private static function resolveHostPath(string $raw, string $projectDir): ?string
    {
        $raw = trim($raw);
        if ($raw === '' || $raw === '/' || str_contains($raw, "\0")) {
            return null;
        }
        // Reject volume names (no path separators / relative markers)
        if (!str_starts_with($raw, '/') && !str_starts_with($raw, './') && !str_starts_with($raw, '../') && $raw !== '.') {
            return null;
        }
        if (str_starts_with($raw, '/')) {
            return self::normalizeAbs($raw);
        }
        if ($projectDir === '') {
            // Keep relative form normalized; agent may resolve later
            $joined = $raw;
        } else {
            $joined = $projectDir . '/' . $raw;
        }
        return self::normalizeAbs($joined);
    }

    private static function normalizeAbs(string $path): string
    {
        $path = str_replace('\\', '/', $path);
        $parts = [];
        $absolute = str_starts_with($path, '/');
        foreach (explode('/', $path) as $part) {
            if ($part === '' || $part === '.') {
                continue;
            }
            if ($part === '..') {
                array_pop($parts);
                continue;
            }
            $parts[] = $part;
        }
        $out = implode('/', $parts);
        return $absolute ? '/' . $out : $out;
    }

    private static function slug(string $value): string
    {
        $value = strtolower(trim($value));
        $value = preg_replace('/[^a-z0-9_.-]+/', '-', $value) ?? 'bind';
        $value = trim($value, '-.');
        if ($value === '' || !preg_match('/^[a-z0-9]/', $value)) {
            $value = 'b' . $value;
        }
        return substr($value, 0, 120);
    }
}
