<?php
declare(strict_types=1);

namespace App\Http\Controllers;

use App\Access\EndpointAcl;
use App\Access\Ownership;
use App\Http\Request;
use App\Http\Response;

final class VolumesController extends BaseController
{
    public function listBindVolumes(int $endpointId, Request $request, array $user): Response
    {
        [$ep, $deny] = $this->requireEndpointAccess($endpointId, $user, EndpointAcl::READ);
        if ($deny) {
            return $deny;
        }
        unset($ep);
        // Refresh stack-sourced binds so compose bind mounts appear in Volumes
        $this->syncBindVolumesFromEndpointStacks($endpointId);
        $rows = $this->repo->listBindVolumes($endpointId);
        return Response::json([
            'Volumes' => array_map([$this, 'formatBindVolume'], $rows),
        ]);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function createBindVolume(int $endpointId, Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        [$ep, $deny] = $this->requireEndpointAccess($endpointId, $user, EndpointAcl::ADMIN);
        if ($deny) {
            return $deny;
        }
        unset($ep);
        $body = $request->json();
        $name = trim((string) ($body['Name'] ?? $body['name'] ?? ''));
        $hostPath = trim((string) ($body['HostPath'] ?? $body['hostPath'] ?? $body['Path'] ?? ''));
        if ($name === '' || !preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/', $name)) {
            return Response::error('Nom invalide (lettres, chiffres, _ . -)', 400);
        }
        if ($hostPath === '' || !str_starts_with($hostPath, '/') || str_contains($hostPath, "\0")) {
            return Response::error('Chemin hôte absolu requis (ex. /data/app)', 400);
        }
        $hostPath = rtrim(str_replace('\\', '/', $hostPath), '/') ?: '/';
        if ($this->repo->getBindVolumeByName($endpointId, $name)) {
            return Response::error('Un volume bind portant ce nom existe déjà', 409);
        }
        $row = $this->repo->upsertBindVolume(
            $endpointId,
            $name,
            $hostPath,
            'manual',
            null,
            '',
            Ownership::username($user),
        );
        $this->audit($user, 'bind_volume.create', 'Déclaration du bind « ' . $name . ' » → ' . $hostPath, $request, [
            'endpointId' => $endpointId,
            'name' => $name,
            'hostPath' => $hostPath,
        ]);
        return Response::json($this->formatBindVolume($row), 201);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function deleteBindVolume(int $endpointId, int $id, Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        [$ep, $deny] = $this->requireEndpointAccess($endpointId, $user, EndpointAcl::ADMIN);
        if ($deny) {
            return $deny;
        }
        unset($ep);
        $row = $this->repo->getBindVolume($id);
        if (!$row || (int) ($row['endpoint_id'] ?? 0) !== $endpointId) {
            return Response::error('Bind introuvable', 404);
        }
        $this->repo->deleteBindVolume($id);
        $this->audit($user, 'bind_volume.delete', 'Suppression de la déclaration bind « ' . ($row['name'] ?? '') . ' »', $request, [
            'endpointId' => $endpointId,
            'name' => (string) ($row['name'] ?? ''),
            'hostPath' => (string) ($row['host_path'] ?? ''),
        ]);
        return Response::empty(204);
    }

    /** @param array<string, mixed> $row */
    public function browseVolume(int $endpointId, string $name, Request $request, array $user): Response
    {
        [$browser, $deny] = $this->volumeBrowserForEndpoint($endpointId, $name, $user);
        if ($deny || !$browser) {
            return $deny ?? Response::error('Volume introuvable', 404);
        }
        $rel = (string) ($request->query('path') ?? '/');
        try {
            return Response::json($browser->list($name, $rel));
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function readVolumeFile(int $endpointId, string $name, Request $request, array $user): Response
    {
        [$browser, $deny] = $this->volumeBrowserForEndpoint($endpointId, $name, $user);
        if ($deny || !$browser) {
            return $deny ?? Response::error('Volume introuvable', 404);
        }
        $rel = (string) ($request->query('path') ?? '');
        try {
            return Response::json($browser->readFile($name, $rel));
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function downloadVolumeFile(int $endpointId, string $name, Request $request, array $user): Response
    {
        [$browser, $deny] = $this->volumeBrowserForEndpoint($endpointId, $name, $user);
        if ($deny || !$browser) {
            return $deny ?? Response::error('Volume introuvable', 404);
        }
        $rel = (string) ($request->query('path') ?? '');
        try {
            $file = $browser->download($name, $rel);
            $safeName = preg_replace('/[^\w.\-]+/', '_', $file['Name']) ?: 'file';
            return new Response(
                200,
                $file['Bytes'],
                [
                    'Content-Type' => 'application/octet-stream',
                    'Content-Disposition' => 'attachment; filename="' . $safeName . '"',
                    'Content-Length' => (string) $file['Size'],
                ],
            );
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function writeVolumeFile(int $endpointId, string $name, Request $request, array $user): Response
    {
        [$browser, $deny] = $this->volumeBrowserForEndpoint($endpointId, $name, $user, EndpointAcl::OPERATE);
        if ($deny || !$browser) {
            return $deny ?? Response::error('Volume introuvable', 404);
        }
        $body = $request->json();
        $rel = (string) ($body['Path'] ?? $body['path'] ?? '');
        try {
            $result = $browser->writeFile($name, $rel, [
                'Content' => (string) ($body['Content'] ?? $body['content'] ?? ''),
                'Encoding' => (string) ($body['Encoding'] ?? $body['encoding'] ?? 'text'),
                'CreateOnly' => array_key_exists('CreateOnly', $body)
                    ? (bool) $body['CreateOnly']
                    : (array_key_exists('createOnly', $body) ? (bool) $body['createOnly'] : true),
            ]);
            return Response::json($result, 201);
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /**
     * Binary upload (application/octet-stream) — preferred for large files (up to 300 Mo).
     * @param array{id:int,username:string,role:int} $user
     */
    public function uploadVolumeFile(int $endpointId, string $name, Request $request, array $user): Response
    {
        [$browser, $deny] = $this->volumeBrowserForEndpoint($endpointId, $name, $user, EndpointAcl::OPERATE);
        if ($deny || !$browser) {
            return $deny ?? Response::error('Volume introuvable', 404);
        }
        $rel = (string) ($request->query('path') ?? $request->query('Path') ?? '');
        if ($rel === '') {
            return Response::error('Paramètre path requis', 400);
        }
        $len = strlen($request->rawBody);
        if ($len > VolumeBrowser::MAX_WRITE_BYTES) {
            return Response::error('Fichier trop volumineux (max 300 Mo)', 413);
        }
        $createOnly = in_array(strtolower((string) ($request->query('createOnly') ?? '')), ['1', 'true', 'yes'], true);
        try {
            $result = $browser->writeBytes($name, $rel, $request->rawBody, $createOnly);
            return Response::json($result, 201);
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function mkdirVolumePath(int $endpointId, string $name, Request $request, array $user): Response
    {
        [$browser, $deny] = $this->volumeBrowserForEndpoint($endpointId, $name, $user, EndpointAcl::OPERATE);
        if ($deny || !$browser) {
            return $deny ?? Response::error('Volume introuvable', 404);
        }
        $body = $request->json();
        $rel = (string) ($body['Path'] ?? $body['path'] ?? '');
        try {
            return Response::json($browser->mkdir($name, $rel), 201);
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function renameVolumePath(int $endpointId, string $name, Request $request, array $user): Response
    {
        [$browser, $deny] = $this->volumeBrowserForEndpoint($endpointId, $name, $user, EndpointAcl::OPERATE);
        if ($deny || !$browser) {
            return $deny ?? Response::error('Volume introuvable', 404);
        }
        $body = $request->json();
        $from = (string) ($body['From'] ?? $body['from'] ?? '');
        $to = (string) ($body['To'] ?? $body['to'] ?? '');
        try {
            return Response::json($browser->rename($name, $from, $to));
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function deleteVolumeEntry(int $endpointId, string $name, Request $request, array $user): Response
    {
        [$browser, $deny] = $this->volumeBrowserForEndpoint($endpointId, $name, $user, EndpointAcl::OPERATE);
        if ($deny || !$browser) {
            return $deny ?? Response::error('Volume introuvable', 404);
        }
        $body = $request->json();
        $rel = (string) ($body['Path'] ?? $body['path'] ?? $request->query('path') ?? '');
        try {
            $browser->delete($name, $rel);
            return Response::empty(204);
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
}
