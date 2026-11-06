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

    /** Demux Docker multiplexed stream into stdout/stderr. */
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

    public function logs(string $containerId, int $tail = 200, bool $timestamps = true): string
    {
        $query = [
            'stdout' => 'true',
            'stderr' => 'true',
            'timestamps' => $timestamps ? 'true' : 'false',
            'tail' => (string) $tail,
        ];
        $res = $this->docker->request('GET', '/containers/' . rawurlencode($containerId) . '/logs', null, [], $query);
        if ($res['status'] >= 400) {
            throw new \RuntimeException($res['body'] !== '' ? $res['body'] : 'Échec de la récupération des journaux', $res['status']);
        }
        [$stdout, $stderr] = $this->demux($res['body']);
        return $stdout . $stderr;
    }
}
