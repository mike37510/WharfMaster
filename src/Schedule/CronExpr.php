<?php
declare(strict_types=1);

namespace App\Schedule;

/**
 * Minimal 5-field cron matcher (minute hour dom month dow).
 * Supports star, lists (1,2), ranges (1-5), steps (star/5, 1-10/2).
 */
final class CronExpr
{
    public static function isValid(string $expr): bool
    {
        $parts = preg_split('/\s+/', trim($expr)) ?: [];
        if (count($parts) !== 5) {
            return false;
        }
        $bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
        foreach ($parts as $i => $part) {
            if (!self::fieldValid($part, $bounds[$i][0], $bounds[$i][1])) {
                return false;
            }
        }
        return true;
    }

    public static function matches(string $expr, int $ts): bool
    {
        $parts = preg_split('/\s+/', trim($expr)) ?: [];
        if (count($parts) !== 5) {
            return false;
        }
        $vals = [
            (int) gmdate('i', $ts),
            (int) gmdate('G', $ts),
            (int) gmdate('j', $ts),
            (int) gmdate('n', $ts),
            (int) gmdate('w', $ts),
        ];
        $bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
        foreach ($parts as $i => $part) {
            if (!self::fieldMatches($part, $vals[$i], $bounds[$i][0], $bounds[$i][1])) {
                return false;
            }
        }
        return true;
    }

    /** Next matching minute strictly after $from (UTC), search up to 366 days. */
    public static function nextAfter(string $expr, int $from): ?int
    {
        if (!self::isValid($expr)) {
            return null;
        }
        $ts = ((int) floor($from / 60) * 60) + 60;
        $limit = $from + 366 * 86400;
        while ($ts <= $limit) {
            if (self::matches($expr, $ts)) {
                return $ts;
            }
            $ts += 60;
        }
        return null;
    }

    private static function fieldValid(string $field, int $min, int $max): bool
    {
        foreach (explode(',', $field) as $piece) {
            $piece = trim($piece);
            if ($piece === '') {
                return false;
            }
            $step = 1;
            if (str_contains($piece, '/')) {
                $bits = explode('/', $piece, 2);
                $piece = $bits[0];
                $stepStr = $bits[1] ?? '';
                if (!ctype_digit($stepStr) || (int) $stepStr < 1) {
                    return false;
                }
                $step = (int) $stepStr;
            }
            if ($piece === '*') {
                continue;
            }
            if (str_contains($piece, '-')) {
                $bits = explode('-', $piece, 2);
                $a = $bits[0] ?? '';
                $b = $bits[1] ?? '';
                if (!self::isIntIn($a, $min, $max) || !self::isIntIn($b, $min, $max)) {
                    return false;
                }
                if ((int) $a > (int) $b) {
                    return false;
                }
                continue;
            }
            if (!self::isIntIn($piece, $min, $max)) {
                return false;
            }
            // Keep $step referenced so validators stay honest about step syntax.
            if ($step < 1) {
                return false;
            }
        }
        return true;
    }

    private static function fieldMatches(string $field, int $value, int $min, int $max): bool
    {
        foreach (explode(',', $field) as $piece) {
            $piece = trim($piece);
            $step = 1;
            if (str_contains($piece, '/')) {
                $bits = explode('/', $piece, 2);
                $piece = $bits[0];
                $step = max(1, (int) ($bits[1] ?? '1'));
            }
            if ($piece === '*') {
                if ((($value - $min) % $step) === 0) {
                    return true;
                }
                continue;
            }
            if (str_contains($piece, '-')) {
                $bits = explode('-', $piece, 2);
                $start = (int) ($bits[0] ?? '0');
                $end = (int) ($bits[1] ?? '0');
                if ($value >= $start && $value <= $end && (($value - $start) % $step) === 0) {
                    return true;
                }
                continue;
            }
            $n = (int) $piece;
            if ($value === $n || ($step > 1 && $value >= $n && (($value - $n) % $step) === 0)) {
                return true;
            }
        }
        return false;
    }

    private static function isIntIn(string $s, int $min, int $max): bool
    {
        if (!preg_match('/^-?\d+$/', $s)) {
            return false;
        }
        $n = (int) $s;
        return $n >= $min && $n <= $max;
    }
}
