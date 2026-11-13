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
        // Inspect-only / read-only fields must not be replayed on create
        foreach (['Hostname', 'Domainname'] as $keepEmptyOk) {
            if (array_key_exists($keepEmptyOk, $body) && $body[$keepEmptyOk] === '') {
                unset($body[$keepEmptyOk]);
            }
        }
        $body['Image'] = $image;
        // Avoid stale network attachments conflicting with NetworkingConfig
        if ($networks !== [] && is_array($hostConfig)) {
            unset($hostConfig['NetworkMode']);
        }
        $body['HostConfig'] = $hostConfig;
        if ($networks !== []) {
            $body['NetworkingConfig'] = ['EndpointsConfig' => $networks];
        }
        return $this->normalizeCreateMaps($body);
    }

    /**
     * json_decode(…, true) turns Docker JSON {} into []. Go/Docker reject arrays
     * for ExposedPorts / Volumes / PortBindings (must be objects/maps).
     *
     * @param array<string, mixed> $body
     * @return array<string, mixed>
     */
    private function normalizeCreateMaps(array $body): array
    {
        $body['ExposedPorts'] = $this->objectMapOfEmptyStructs($body['ExposedPorts'] ?? null);
        if ($body['ExposedPorts'] === null) {
            unset($body['ExposedPorts']);
        }

        $body['Volumes'] = $this->objectMapOfEmptyStructs($body['Volumes'] ?? null);
        if ($body['Volumes'] === null) {
            unset($body['Volumes']);
        }

        if (isset($body['Labels']) && is_array($body['Labels']) && $body['Labels'] === []) {
            unset($body['Labels']);
        }

        if (isset($body['HostConfig']) && is_array($body['HostConfig'])) {
            $hc = &$body['HostConfig'];
            if (isset($hc['PortBindings'])) {
                if (!is_array($hc['PortBindings']) || $hc['PortBindings'] === [] || array_is_list($hc['PortBindings'])) {
                    unset($hc['PortBindings']);
                } else {
                    foreach ($hc['PortBindings'] as $port => $bindings) {
                        if (!is_array($bindings) || $bindings === []) {
                            unset($hc['PortBindings'][$port]);
                            continue;
                        }
                        $fixed = [];
                        foreach ($bindings as $b) {
                            if (!is_array($b) || $b === []) {
                                continue;
                            }
                            if (!array_key_exists('HostPort', $b) && !array_key_exists('HostIp', $b)) {
                                continue;
                            }
                            $obj = new \stdClass();
                            foreach ($b as $k => $v) {
                                if (is_string($k)) {
                                    $obj->{$k} = $v;
                                }
                            }
                            $fixed[] = $obj;
                        }
                        if ($fixed === []) {
                            unset($hc['PortBindings'][$port]);
                        } else {
                            $hc['PortBindings'][$port] = $fixed;
                        }
                    }
                    if ($hc['PortBindings'] === []) {
                        unset($hc['PortBindings']);
                    }
                }
            }
            foreach (['StorageOpt', 'Sysctls', 'Tmpfs', 'BlkioDeviceReadBps', 'BlkioDeviceWriteBps', 'BlkioDeviceReadIOps', 'BlkioDeviceWriteIOps'] as $mapKey) {
                if (isset($hc[$mapKey]) && is_array($hc[$mapKey]) && $hc[$mapKey] === []) {
                    unset($hc[$mapKey]);
                }
            }
            if (isset($hc['RestartPolicy']) && is_array($hc['RestartPolicy']) && ($hc['RestartPolicy']['Name'] ?? '') === '' && empty($hc['RestartPolicy']['MaximumRetryCount'])) {
                unset($hc['RestartPolicy']);
            }
            unset($hc);
        }

        return $body;
    }

    /**
     * @return array<string, \stdClass>|null null = omit field
     */
    private function objectMapOfEmptyStructs(mixed $map): ?array
    {
        if (!is_array($map) || $map === [] || array_is_list($map)) {
            return null;
        }
        $out = [];
        foreach ($map as $key => $_) {
            if (!is_string($key) || $key === '') {
                continue;
            }
            $out[$key] = new \stdClass();
        }
        return $out === [] ? null : $out;
    }

    private function tempName(string $name): string
    {
        $base = preg_replace('/[^a-zA-Z0-9_.-]/', '-', $name) ?: 'container';
        $base = substr($base, 0, 40);
        return $base . '-wm-' . bin2hex(random_bytes(3));
    }
}
