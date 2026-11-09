<?php
declare(strict_types=1);

namespace App\Http\Controllers;

use App\Access\EndpointAcl;
use App\Access\Ownership;
use App\Docker\ContainerRecreate;
use App\Http\Request;
use App\Http\Response;
use App\Stack\ImageUpdateChecker;

final class ContainersController extends BaseController
{
    public function listContainerImageUpdates(int $endpointId, Request $request, array $user): Response
    {
        [$ep, $deny] = $this->requireEndpointAccess($endpointId, $user, EndpointAcl::READ);
        if ($deny) {
            return $deny;
        }
        $role = $this->endpointAcl->roleFor($user, $endpointId);
        $scopedUser = $this->endpointAcl->withEndpointContext($user, $role);
        $docker = $this->dockerForEndpoint($ep);
        $scope = $this->scopeForEndpoint($ep);
        $force = $this->wantsStackUpdateRefresh($request);
        try {
            $all = $docker->json('GET', '/containers/json', null, ['all' => 'true']);
            if (!is_array($all)) {
                $all = [];
            }
            $filtered = [];
            foreach ($all as $c) {
                if (!is_array($c)) {
                    continue;
                }
                $cid = (string) ($c['Id'] ?? '');
                if ($cid === '' || !$scope->canAccessContainer($cid, $scopedUser)) {
                    continue;
                }
                $filtered[] = $c;
            }
            $updates = $this->imageUpdates->checkContainers(
                $filtered,
                $docker,
                $this->registriesWithPasswordsForUser($user),
                $force,
            );
            return Response::json([
                'Updates' => $updates,
                'CacheTtl' => ImageUpdateChecker::STACK_CACHE_TTL,
                'Forced' => $force,
            ]);
        } catch (\Throwable $e) {
            return Response::error($e->getMessage(), 502);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function getContainerImageUpdate(int $endpointId, string $containerId, Request $request, array $user): Response
    {
        [$ep, $deny] = $this->requireEndpointAccess($endpointId, $user, EndpointAcl::READ);
        if ($deny) {
            return $deny;
        }
        $role = $this->endpointAcl->roleFor($user, $endpointId);
        $scopedUser = $this->endpointAcl->withEndpointContext($user, $role);
        $scope = $this->scopeForEndpoint($ep);
        if (!$scope->canAccessContainer($containerId, $scopedUser)) {
            return Response::error('Accès refusé à ce conteneur', 403);
        }
        $force = $this->wantsStackUpdateRefresh($request);
        try {
            $docker = $this->dockerForEndpoint($ep);
            $info = $docker->json('GET', '/containers/' . rawurlencode($containerId) . '/json');
            $image = trim((string) ($info['Config']['Image'] ?? ''));
            $name = ltrim((string) ($info['Name'] ?? ''), '/');
            $item = $this->imageUpdates->checkImageRef(
                $image,
                $docker,
                $this->registriesWithPasswordsForUser($user),
                $force,
                $name !== '' ? $name : 'container',
            );
            return Response::json([
                'Status' => $item['Status'],
                'UpdateCount' => $item['Status'] === 'update' ? 1 : 0,
                'Checked' => in_array($item['Status'], ['update', 'fresh', 'pinned'], true) ? 1 : 0,
                'Image' => $item['Image'],
                'Detail' => $item['Detail'],
                'LocalDigest' => $item['LocalDigest'],
                'RemoteDigest' => $item['RemoteDigest'],
                'Images' => [$item],
            ]);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 502);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function updateContainerImage(int $endpointId, string $containerId, Request $request, array $user): Response
    {
        [$ep, $deny] = $this->requireEndpointAccess($endpointId, $user, EndpointAcl::OPERATE);
        if ($deny) {
            return $deny;
        }
        $role = $this->endpointAcl->roleFor($user, $endpointId);
        $scopedUser = $this->endpointAcl->withEndpointContext($user, $role);
        $scope = $this->scopeForEndpoint($ep);
        if (!$scope->canAccessContainer($containerId, $scopedUser)) {
            return Response::error('Accès refusé à ce conteneur', 403);
        }
        $body = $request->json();
        $pull = !array_key_exists('Pull', $body) || !empty($body['Pull']) || !empty($body['PullImage']);
        try {
            $docker = $this->dockerForEndpoint($ep);
            $info = $docker->json('GET', '/containers/' . rawurlencode($containerId) . '/json');
            $image = trim((string) ($info['Config']['Image'] ?? ''));
            $creds = $image !== ''
                ? $this->imageUpdates->registryCredsForImage($image, $this->registriesWithPasswordsForUser($user))
                : [];
            $result = (new ContainerRecreate($docker))->upgrade($containerId, $pull, $creds);
            $this->audit(
                $user,
                'container.update_image',
                'Mise à jour image « ' . $result['Name'] . ' » (' . $result['Image'] . ')',
                $request,
                [
                    'endpointId' => $endpointId,
                    'previousId' => $result['PreviousId'],
                    'newId' => $result['Id'],
                    'pulled' => $result['Pulled'],
                ],
            );
            return Response::json($result);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 502);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function containerLogs(int $endpointId, string $containerId, Request $request, array $user): Response
    {
        [$ep, $deny] = $this->requireEndpointAccess($endpointId, $user, EndpointAcl::READ);
        if ($deny) {
            return $deny;
        }
        $role = $this->endpointAcl->roleFor($user, $endpointId);
        $scopedUser = $this->endpointAcl->withEndpointContext($user, $role);
        $scope = $this->scopeForEndpoint($ep);
        if (!$scope->canAccessContainer($containerId, $scopedUser)) {
            return Response::error('Accès refusé à ce conteneur', 403);
        }

        $tailRaw = (string) ($request->query('tail') ?? '200');
        $tail = strtolower($tailRaw) === 'all' ? 'all' : max(0, min(5000, (int) $tailRaw));
        $timestamps = ($request->query('timestamps') ?? 'true') !== 'false';
        $stdout = ($request->query('stdout') ?? 'true') !== 'false';
        $stderr = ($request->query('stderr') ?? 'true') !== 'false';
        $annotate = ($request->query('annotate') ?? 'true') !== 'false';
        $sinceRaw = $request->query('since');
        $since = ($sinceRaw !== null && $sinceRaw !== '' && (int) $sinceRaw > 0) ? (int) $sinceRaw : null;

        try {
            $exec = new \App\Docker\Exec($this->dockerForEndpoint($ep));
            $text = $exec->logs($containerId, [
                'tail' => $tail,
                'timestamps' => $timestamps,
                'stdout' => $stdout,
                'stderr' => $stderr,
                'since' => $since,
                'annotate' => $annotate,
            ]);
        } catch (\Throwable $e) {
            $status = $e->getCode() >= 400 && $e->getCode() < 600 ? (int) $e->getCode() : 500;
            return Response::error($e->getMessage(), $status);
        }
        $this->repo->updateEndpointLastSeen((int) $ep['id'], 1);
        return Response::text($text, 200, ['Content-Type' => 'text/plain; charset=utf-8']);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function containerExec(int $endpointId, string $containerId, Request $request, array $user): Response
    {
        [$ep, $deny] = $this->requireEndpointAccess($endpointId, $user, EndpointAcl::OPERATE);
        if ($deny) {
            return $deny;
        }
        $role = $this->endpointAcl->roleFor($user, $endpointId);
        $scopedUser = $this->endpointAcl->withEndpointContext($user, $role);
        $scope = $this->scopeForEndpoint($ep);
        if (!$scope->canAccessContainer($containerId, $scopedUser)) {
            return Response::error('Accès refusé à ce conteneur', 403);
        }
        $docker = $this->dockerForEndpoint($ep);
        $body = $request->json();
        $command = trim((string) ($body['command'] ?? $body['Command'] ?? ''));
        $userShell = (string) ($body['shell'] ?? '/bin/sh');
        if ($command === '') {
            return Response::error('La commande est requise', 400);
        }
        if (strlen($command) > 4000) {
            return Response::error('Commande trop longue', 400);
        }
        if (!in_array($userShell, ['/bin/sh', '/bin/bash', '/bin/ash', 'sh', 'bash', 'ash'], true)) {
            return Response::error('Shell non autorisé', 400);
        }
        $cwd = trim((string) ($body['cwd'] ?? ''));
        if ($cwd !== '' && (str_contains($cwd, "\0") || strlen($cwd) > 512)) {
            return Response::error('Répertoire de travail invalide', 400);
        }
        $cols = max(40, min(250, (int) ($body['cols'] ?? $body['Cols'] ?? 120)));
        $rows = max(8, min(100, (int) ($body['rows'] ?? $body['Rows'] ?? 40)));
        // TTY so tools like `ls` use columns + colors (like a real shell)
        $tty = !array_key_exists('tty', $body) || !empty($body['tty']);
        $env = [
            'TERM=xterm-256color',
            'COLORTERM=truecolor',
            'COLUMNS=' . $cols,
            'LINES=' . $rows,
            'FORCE_COLOR=1',
            'CLICOLOR=1',
            'CLICOLOR_FORCE=1',
        ];
        $script = $cwd !== '' ? 'cd ' . escapeshellarg($cwd) . ' && ' . $command : $command;
        $cmd = [$userShell, '-lc', $script];
        try {
            $exec = new \App\Docker\Exec($docker);
            $result = $exec->run($containerId, $cmd, $tty, 60, $env);
        } catch (\Throwable $e) {
            // Retry with /bin/sh if bash missing
            if ($userShell !== '/bin/sh') {
                try {
                    $exec = new \App\Docker\Exec($docker);
                    $result = $exec->run($containerId, ['/bin/sh', '-lc', $script], $tty, 60, $env);
                } catch (\Throwable $e2) {
                    $status = $e2->getCode() >= 400 && $e2->getCode() < 600 ? (int) $e2->getCode() : 500;
                    return Response::error($e2->getMessage(), $status);
                }
            } else {
                $status = $e->getCode() >= 400 && $e->getCode() < 600 ? (int) $e->getCode() : 500;
                return Response::error($e->getMessage(), $status);
            }
        }
        return Response::json($result);
    }

    /** @param array{id:int,username:string,role:int} $user */
}
