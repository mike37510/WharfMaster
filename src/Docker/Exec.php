<?php
declare(strict_types=1);

namespace App\Docker;

final class Exec
{
    public function __construct(private readonly Client $docker)
    {
    }

    /**
     * Run a one-shot command inside a container (console helper).
     *
     * @param list<string> $cmd
     * @return array{Stdout:string,Stderr:string,ExitCode:int}
     */
    public function run(string $containerId, array $cmd, bool $tty = false, int $timeout = 60): array
    {
        $create = $this->docker->json('POST', '/containers/' . rawurlencode($containerId) . '/exec', [
            'AttachStdin' => false,
            'AttachStdout' => true,
            'AttachStderr' => true,
            'Tty' => $tty,
            'Cmd' => $cmd,
        ]);

        $execId = (string) ($create['Id'] ?? '');
        if ($execId === '') {
            throw new \RuntimeException('Échec de la création de la session exec');
        }

        $started = $this->docker->request(
            'POST',
            '/exec/' . rawurlencode($execId) . '/start',
            json_encode(['Detach' => false, 'Tty' => $tty], JSON_UNESCAPED_SLASHES) ?: '{}',
            ['Content-Type' => 'application/json'],
        );

        if ($started['status'] >= 400) {
            throw new \RuntimeException($started['body'] !== '' ? $started['body'] : 'Échec du démarrage de la session exec', $started['status']);
        }

        $raw = $started['body'];
        if ($tty) {
            $stdout = $raw;
            $stderr = '';
        } else {
            [$stdout, $stderr] = $this->demux($raw);
        }

        $inspect = $this->docker->json('GET', '/exec/' . rawurlencode($execId) . '/json');
        $exit = (int) ($inspect['ExitCode'] ?? 0);

        return [
            'Stdout' => $stdout,
            'Stderr' => $stderr,
            'ExitCode' => $exit,
        ];
    }

    /**
     * Demux Docker multiplexed stream into separate stdout/stderr buffers.
     *
     * @return array{0:string,1:string}
     */
    public function demux(string $raw): array
    {
        $stdout = '';
        $stderr = '';
        $offset = 0;
        $len = strlen($raw);
        while ($offset + 8 <= $len) {
            $header = substr($raw, $offset, 8);
            $unpacked = unpack('Cstream/C/C/C/Nsize', $header);
            if ($unpacked === false) {
                break;
            }
            $offset += 8;
            $size = (int) $unpacked['size'];
            if ($offset + $size > $len) {
                $chunk = substr($raw, $offset);
                $offset = $len;
            } else {
                $chunk = substr($raw, $offset, $size);
                $offset += $size;
            }
            if ((int) $unpacked['stream'] === 2) {
                $stderr .= $chunk;
            } else {
                $stdout .= $chunk;
            }
        }
        if ($offset === 0 && $raw !== '') {
            // Not multiplexed (TTY or plain)
            $stdout = $raw;
        }
        return [$stdout, $stderr];
    }

    /**
     * Demux Docker multiplexed frames in chronological order (stdout/stderr interleaved).
     * When $annotateStderr is true, each stderr line is prefixed with "\x1e" for UI styling.
     */
    public function demuxChronological(
        string $raw,
        bool $wantStdout = true,
        bool $wantStderr = true,
        bool $annotateStderr = false,
    ): string {
        $out = '';
        $offset = 0;
        $len = strlen($raw);
        $sawHeader = false;
        while ($offset + 8 <= $len) {
            $header = substr($raw, $offset, 8);
            $unpacked = unpack('Cstream/C/C/C/Nsize', $header);
            if ($unpacked === false) {
                break;
            }
            $sawHeader = true;
            $offset += 8;
            $size = (int) $unpacked['size'];
            if ($offset + $size > $len) {
                $chunk = substr($raw, $offset);
                $offset = $len;
            } else {
                $chunk = substr($raw, $offset, $size);
                $offset += $size;
            }
            $isStderr = ((int) $unpacked['stream'] === 2);
            if ($isStderr) {
                if (!$wantStderr) {
                    continue;
                }
                $out .= $annotateStderr ? $this->annotateStderrChunk($chunk) : $chunk;
            } else {
                if (!$wantStdout) {
                    continue;
                }
                $out .= $chunk;
            }
        }
        if (!$sawHeader && $raw !== '') {
            if ($wantStdout) {
                $out = $raw;
            }
        }
        return $out;
    }

    private function annotateStderrChunk(string $chunk): string
    {
        if ($chunk === '') {
            return '';
        }
        $parts = preg_split("/(\r\n|\n|\r)/", $chunk, -1, PREG_SPLIT_DELIM_CAPTURE);
        if ($parts === false) {
            return "\x1e" . $chunk;
        }
        $out = '';
        $atLineStart = true;
        foreach ($parts as $part) {
            if ($part === "\r\n" || $part === "\n" || $part === "\r") {
                $out .= $part;
                $atLineStart = true;
                continue;
            }
            if ($part === '') {
                continue;
            }
            if ($atLineStart) {
                $out .= "\x1e";
                $atLineStart = false;
            }
            $out .= $part;
        }
        return $out;
    }

    /**
     * Fetch container logs as demuxed plain text (chronological).
     *
     * @param array{
     *   tail?: int|string,
     *   timestamps?: bool,
     *   stdout?: bool,
     *   stderr?: bool,
     *   since?: int|null,
     *   annotate?: bool
     * } $opts
     */
    public function logs(string $containerId, array $opts = []): string
    {
        $timestamps = (bool) ($opts['timestamps'] ?? true);
        $wantStdout = (bool) ($opts['stdout'] ?? true);
        $wantStderr = (bool) ($opts['stderr'] ?? true);
        $annotate = (bool) ($opts['annotate'] ?? false);
        $since = $opts['since'] ?? null;

        if (!$wantStdout && !$wantStderr) {
            return '';
        }

        $tail = $opts['tail'] ?? 200;
        if ($tail === 'all' || $tail === 'ALL') {
            $tailStr = 'all';
        } else {
            $tailInt = (int) $tail;
            if ($tailInt < 0) {
                $tailInt = 0;
            }
            if ($tailInt > 5000) {
                $tailInt = 5000;
            }
            $tailStr = (string) $tailInt;
        }

        $query = [
            'stdout' => $wantStdout ? 'true' : 'false',
            'stderr' => $wantStderr ? 'true' : 'false',
            'timestamps' => $timestamps ? 'true' : 'false',
            'tail' => $tailStr,
        ];
        if ($since !== null && $since !== '' && (int) $since > 0) {
            $query['since'] = (string) ((int) $since);
        }

        $res = $this->docker->request('GET', '/containers/' . rawurlencode($containerId) . '/logs', null, [], $query);
        if ($res['status'] >= 400) {
            throw new \RuntimeException($res['body'] !== '' ? $res['body'] : 'Échec de la récupération des journaux', $res['status']);
        }
        return $this->demuxChronological($res['body'], $wantStdout, $wantStderr, $annotate);
    }
}
