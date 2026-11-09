<?php
declare(strict_types=1);

namespace App\Docker;

use App\Registry\ManifestClient;

/**
 * Pull latest image tag and recreate a container with the same config (Portainer-style upgrade).
 */
final class ContainerRecreate
{
    public function __construct(private readonly Client $docker)
    {
    }

    /**
     * @param array{url?:string,username?:string,password?:string,type?:string} $registryCreds
     * @return array{Id:string,Name:string,Image:string,PreviousId:string,Pulled:bool,Started:bool}
     */
    public function upgrade(string $containerId, bool $pull = true, array $registryCreds = []): array
    {
        $inspect = $this->docker->json('GET', '/containers/' . rawurlencode($containerId) . '/json');
        $image = trim((string) ($inspect['Config']['Image'] ?? ''));
        if ($image === '') {
            throw new \RuntimeException('Image du conteneur introuvable');
        }
        $name = ltrim((string) ($inspect['Name'] ?? ''), '/');
        if ($name === '') {
            $name = substr($containerId, 0, 12);
        }
        $wasRunning = strtolower((string) ($inspect['State']['Status'] ?? '')) === 'running';

        if ($pull) {
            $this->pullImage($image, $registryCreds);
        }

        if ($wasRunning) {
            try {
                $this->docker->request('POST', '/containers/' . rawurlencode($containerId) . '/stop', null, [], ['t' => '10']);
            } catch (\Throwable) {
                // already stopped / dying
            }
        }

        $tmpName = $this->tempName($name);
        $this->docker->request(
            'POST',
            '/containers/' . rawurlencode($containerId) . '/rename',
            null,
            [],
            ['name' => $tmpName],
        );

        try {
            $createBody = $this->buildCreateBody($inspect);
            $created = $this->docker->json('POST', '/containers/create', $createBody, ['name' => $name]);
            $newId = (string) ($created['Id'] ?? '');
            if ($newId === '') {
                throw new \RuntimeException('Échec de la création du nouveau conteneur');
            }
        } catch (\Throwable $e) {
            // Best-effort rollback rename so the original container keeps its name
            try {
                $this->docker->request(
                    'POST',
                    '/containers/' . rawurlencode($containerId) . '/rename',
                    null,
                    [],
                    ['name' => $name],
                );
                if ($wasRunning) {
                    $this->docker->request('POST', '/containers/' . rawurlencode($containerId) . '/start');
                }
            } catch (\Throwable) {
            }
            throw $e;
        }

        if ($wasRunning) {
            $this->docker->request('POST', '/containers/' . rawurlencode($newId) . '/start');
        }

        try {
            $this->docker->request(
                'DELETE',
                '/containers/' . rawurlencode($containerId),
                null,
                [],
                ['force' => 'true'],
            );
        } catch (\Throwable) {
            // Old container leftover — new one is already up
        }

        return [
            'Id' => $newId,
            'Name' => $name,
            'Image' => $image,
            'PreviousId' => $containerId,
            'Pulled' => $pull,
            'Started' => $wasRunning,
        ];
    }

    /**
     * @param array{url?:string,username?:string,password?:string,type?:string} $creds
     */
    private function pullImage(string $image, array $creds): void
    {
        $parsed = ManifestClient::parse($image);
        if ($parsed === null) {
            throw new \RuntimeException('Référence image invalide : ' . $image);
        }
        if ($parsed['digest'] !== null) {
            // Digest-pinned — nothing useful to pull as a floating tag
            return;
        }

        $fromImage = $this->fromImageRef($parsed);
        $tag = $parsed['tag'] !== '' ? $parsed['tag'] : 'latest';
        $headers = [];
        $username = trim((string) ($creds['username'] ?? ''));
        $password = (string) ($creds['password'] ?? '');
        if ($username !== '' || $password !== '') {
            $type = strtolower((string) ($creds['type'] ?? 'v2'));
            $server = $type === 'hub' || ManifestClient::isDockerHub($parsed['host'])
                ? 'https://index.docker.io/v1/'
                : (string) ($creds['url'] ?? '');
            $headers['X-Registry-Auth'] = base64_encode(json_encode([
                'username' => $username,
                'password' => $password,
                'serveraddress' => $server !== '' ? $server : $parsed['host'],
            ], JSON_UNESCAPED_SLASHES) ?: '{}');
        }

        $res = $this->docker->request(
            'POST',
            '/images/create',
            null,
            $headers,
            ['fromImage' => $fromImage, 'tag' => $tag],
        );
        if ($res['status'] >= 400) {
            $decoded = json_decode($res['body'], true);
            $msg = is_array($decoded) ? (string) ($decoded['message'] ?? $res['body']) : $res['body'];
            throw new \RuntimeException($msg !== '' ? $msg : 'Échec du pull', $res['status']);
        }
    }

    /**
     * @param array{host:string,port:?int,repository:string,tag:string,digest:?string} $parsed
     */
    private function fromImageRef(array $parsed): string
    {
        $repo = $parsed['repository'];
        if (ManifestClient::isDockerHub($parsed['host'])) {
            // docker pull library/nginx → nginx
            if (str_starts_with($repo, 'library/')) {
                return substr($repo, strlen('library/'));
            }
            return $repo;
        }
        $host = $parsed['host'];
        if (!empty($parsed['port'])) {
            $host .= ':' . $parsed['port'];
        }
        return $host . '/' . $repo;
    }

    /** @param array<string, mixed> $inspect */
    private function buildCreateBody(array $inspect): array
    {
        $config = is_array($inspect['Config'] ?? null) ? $inspect['Config'] : [];
        $hostConfig = is_array($inspect['HostConfig'] ?? null) ? $inspect['HostConfig'] : [];
        $networks = [];
        $netSettings = is_array($inspect['NetworkSettings']['Networks'] ?? null)
            ? $inspect['NetworkSettings']['Networks']
            : [];
        foreach ($netSettings as $netName => $cfg) {
            if (!is_array($cfg)) {
                continue;
            }
            $endpoint = [];
            foreach (['IPAMConfig', 'Links', 'Aliases', 'NetworkID', 'EndpointID', 'Gateway', 'IPAddress', 'IPPrefixLen', 'IPv6Gateway', 'GlobalIPv6Address', 'GlobalIPv6PrefixLen', 'MacAddress', 'DriverOpts'] as $k) {
                if (array_key_exists($k, $cfg) && $cfg[$k] !== null && $cfg[$k] !== '' && $cfg[$k] !== []) {
                    $endpoint[$k] = $cfg[$k];
                }
            }
            $networks[(string) $netName] = $endpoint;
        }

        $image = (string) ($inspect['Config']['Image'] ?? '');
        $body = $config;
        $body['Image'] = $image;
        // Avoid stale network attachments conflicting with NetworkingConfig
        if ($networks !== [] && is_array($hostConfig)) {
            unset($hostConfig['NetworkMode']);
        }
        $body['HostConfig'] = $hostConfig;
        if ($networks !== []) {
            $body['NetworkingConfig'] = ['EndpointsConfig' => $networks];
        }
        return $body;
    }

    private function tempName(string $name): string
    {
        $base = preg_replace('/[^a-zA-Z0-9_.-]/', '-', $name) ?: 'container';
        $base = substr($base, 0, 40);
        return $base . '-wm-' . bin2hex(random_bytes(3));
    }
}
