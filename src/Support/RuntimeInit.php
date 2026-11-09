<?php
declare(strict_types=1);

namespace App\Support;

/**
 * Creates var/ layout, JWT secret, migrates legacy data/ → var/.
 * Does NOT rename portainer.sqlite — use bin/migrate-legacy.php.
 */
final class RuntimeInit
{
    public static function ensure(string $root, ?string $varDir = null): string
    {
        $varDir = $varDir ?: (getenv('WHARFMASTER_VAR') ?: ($root . '/var'));
        $legacyData = $root . '/data';

        if (!is_dir($varDir)) {
            mkdir($varDir, 0700, true);
        }

        if (is_dir($legacyData)) {
            foreach (['dockermanager.sqlite', 'jwt.secret', 'scheduler.api_key'] as $name) {
                $src = $legacyData . '/' . $name;
                $dst = $varDir . '/' . $name;
                if (is_file($src) && !is_file($dst)) {
                    @rename($src, $dst) || @copy($src, $dst);
                }
            }
            foreach (['compose', 'dockerfiles', 'rate_limit', 'image_digest_cache'] as $dir) {
                $src = $legacyData . '/' . $dir;
                $dst = $varDir . '/' . $dir;
                if (!is_dir($src)) {
                    continue;
                }
                if (!is_dir($dst)) {
                    @rename($src, $dst);
                    continue;
                }
                self::mergeDir($src, $dst);
            }
        }

        foreach (['compose', 'dockerfiles', 'rate_limit', 'image_digest_cache'] as $dir) {
            $path = $varDir . '/' . $dir;
            if (!is_dir($path)) {
                mkdir($path, 0755, true);
            }
        }

        $jwtFile = $varDir . '/jwt.secret';
        if (!is_file($jwtFile)) {
            file_put_contents($jwtFile, bin2hex(random_bytes(32)));
            chmod($jwtFile, 0600);
        }

        @chmod($varDir, 0700);
        return $varDir;
    }

    private static function mergeDir(string $src, string $dst): void
    {
        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($src, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::SELF_FIRST
        );
        foreach ($iterator as $item) {
            $target = $dst . DIRECTORY_SEPARATOR . $iterator->getSubPathName();
            if ($item->isDir()) {
                if (!is_dir($target)) {
                    mkdir($target, 0755, true);
                }
                continue;
            }
            if (!is_file($target)) {
                @copy($item->getPathname(), $target);
            }
        }
    }
}
