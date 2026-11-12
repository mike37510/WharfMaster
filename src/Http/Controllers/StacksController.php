<?php
declare(strict_types=1);

namespace App\Http\Controllers;

use App\Access\EndpointAcl;
use App\Access\Ownership;
use App\Http\Request;
use App\Http\Response;
use App\Stack\ImageUpdateChecker;
use App\Stack\StackExporter;

final class StacksController extends BaseController
{
    public function listStacks(Request $request, array $user): Response
    {
        $endpointId = $request->query('endpointId');
        // endpointId 0 / absent = tous les nœuds (vue agrégée)
        $filter = null;
        if ($endpointId !== null && (int) $endpointId > 0) {
            $filter = (int) $endpointId;
            $hasAcl = $this->endpointAcl->can($user, $filter, EndpointAcl::READ);
            $hasShare = $this->repo->userHasSharesOnEndpoint(Ownership::userId($user), $filter);
            if (!$hasAcl && !$hasShare && !Ownership::isGlobalAdmin($user)) {
                return Response::error('Accès refusé à ce nœud', 403);
            }
        }
        $isEpAdmin = $filter !== null && $this->endpointAcl->can($user, $filter, EndpointAcl::ADMIN);
        $rows = $this->repo->listStacksForUser(
            Ownership::username($user),
            Ownership::isGlobalAdmin($user) || $isEpAdmin,
            $filter,
            Ownership::userId($user),
        );
        if ($filter === null && !Ownership::isGlobalAdmin($user)) {
            $rows = array_values(array_filter($rows, fn (array $s): bool => $this->canAccessStack($s, $user)));
        }
        return Response::json(array_map([$this, 'formatStack'], $rows));
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function listStackImageUpdates(Request $request, array $user): Response
    {
        $endpointId = $request->query('endpointId');
        $filter = null;
        if ($endpointId !== null && (int) $endpointId > 0) {
            $filter = (int) $endpointId;
        }
        $rows = $this->repo->listStacksForUser(
            Ownership::username($user),
            Ownership::isAdmin($user),
            $filter,
            Ownership::userId($user),
        );
        $rows = array_values(array_filter($rows, fn (array $s): bool => $this->canAccessStack($s, $user)));
        $registries = $this->registriesWithPasswordsForUser($user);
        $force = $this->wantsStackUpdateRefresh($request);
        $out = [];
        $dockerByEp = [];
        foreach ($rows as $stack) {
            $sid = (int) ($stack['id'] ?? 0);
            $eid = (int) ($stack['endpoint_id'] ?? 0);
            try {
                if (!isset($dockerByEp[$eid])) {
                    $ep = $this->repo->getEndpoint($eid);
                    if (!$ep) {
                        $out[(string) $sid] = [
                            'Status' => 'unknown',
                            'UpdateCount' => 0,
                            'Checked' => 0,
                            'Images' => [],
                            'FromCache' => false,
                        ];
                        continue;
                    }
                    $dockerByEp[$eid] = $this->dockerForEndpoint($ep);
                }
                $out[(string) $sid] = $this->imageUpdates->checkStack(
                    $stack,
                    $dockerByEp[$eid],
                    $registries,
                    $force,
                );
            } catch (\Throwable $e) {
                $out[(string) $sid] = [
                    'Status' => 'unknown',
                    'UpdateCount' => 0,
                    'Checked' => 0,
                    'Images' => [],
                    'FromCache' => false,
                    'Error' => $e->getMessage(),
                ];
            }
        }
        return Response::json([
            'Updates' => $out,
            'CacheTtl' => ImageUpdateChecker::STACK_CACHE_TTL,
            'Forced' => $force,
        ]);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function getStackImageUpdates(int $id, Request $request, array $user): Response
    {
        $stack = $this->repo->getStack($id);
        if (!$stack || !$this->canAccessStack($stack, $user)) {
            return Response::error('Stack introuvable', 404);
        }
        $ep = $this->repo->getEndpoint((int) $stack['endpoint_id']);
        if (!$ep) {
            return Response::error('Nœud introuvable', 404);
        }
        $force = $this->wantsStackUpdateRefresh($request);
        try {
            $data = $this->imageUpdates->checkStack(
                $stack,
                $this->dockerForEndpoint($ep),
                $this->registriesWithPasswordsForUser($user),
                $force,
            );
            return Response::json($data);
        } catch (\Throwable $e) {
            return Response::error($e->getMessage(), 502);
        }
    }

    public function getStack(int $id, array $user): Response
    {
        $stack = $this->repo->getStack($id);
        if (!$stack || !$this->canAccessStack($stack, $user)) {
            return Response::error('Stack introuvable', 404);
        }
        return Response::json($this->formatStack($stack));
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function getStackFile(int $id, array $user): Response
    {
        $stack = $this->repo->getStack($id);
        if (!$stack || !$this->canAccessStack($stack, $user)) {
            return Response::error('Stack introuvable', 404);
        }
        try {
            $content = $this->compose->readComposeFile($stack['project_path'], $stack['entry_point']);
        } catch (\Throwable $e) {
            return Response::error($e->getMessage(), 404);
        }
        return Response::json(['StackFileContent' => $content]);
    }

    /**
     * ZIP: compose + .env + données volumes/binds de la stack.
     * @param array{id:int,username:string,role:int} $user
     */
    public function exportStack(int $id, Request $request, array $user): Response
    {
        $stack = $this->repo->getStack($id);
        if (!$stack || !$this->canAccessStack($stack, $user)) {
            return Response::error('Stack introuvable', 404);
        }
        $endpointId = (int) ($stack['endpoint_id'] ?? 0);
        [$ep, $deny] = $this->requireEndpointAccess($endpointId, $user, EndpointAcl::READ);
        if ($deny) {
            // Stack share may allow access without endpoint ACL — still need docker for volumes
            $ep = $this->repo->getEndpoint($endpointId);
            if (!$ep) {
                return Response::error('Nœud introuvable', 404);
            }
        }
        unset($deny);
        try {
            $docker = $this->dockerForEndpoint($ep);
            $exporter = new StackExporter($this->repo, $this->compose);
            [$err, $zipPath, $downloadName] = $exporter->buildZip($stack, $docker, $user);
            if ($err) {
                return $err;
            }
            if (!$zipPath || !is_file($zipPath) || !$downloadName) {
                return Response::error('Export impossible', 500);
            }
            $blob = (string) file_get_contents($zipPath);
            @unlink($zipPath);
            $this->audit($user, 'stack.export', 'Export ZIP de la stack « ' . ($stack['name'] ?? '') . ' »', $request, [
                'stackId' => $id,
                'name' => $stack['name'] ?? '',
                'bytes' => strlen($blob),
            ]);
            return new Response(200, $blob, [
                'Content-Type' => 'application/zip',
                'Content-Disposition' => 'attachment; filename="' . $downloadName . '"',
                'Cache-Control' => 'no-store',
                'Content-Security-Policy' => "default-src 'none'",
            ]);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error(
                $e->getMessage() !== '' ? $e->getMessage() : 'Export impossible',
                $code >= 400 && $code < 600 ? $code : 500,
            );
        }
    }

    /** @param array<string, mixed> $user */
    public function createStack(Request $request, array $user): Response
    {
        $endpointId = (int) ($request->query('endpointId') ?? 1);
        if ($endpointId < 1) {
            return Response::error('Choisissez un nœud pour déployer la stack', 400);
        }
        $ep = $this->repo->getEndpoint($endpointId);
        if (!$ep) {
            return Response::error('Environnement introuvable', 404);
        }
        if (!$this->endpointAcl->can($user, $endpointId, EndpointAcl::OPERATE)) {
            return Response::error('Permissions insuffisantes sur ce nœud', 403);
        }
        $isAgent = ($ep['kind'] ?? 'local') === 'agent';
        $body = $request->json();
        $name = trim((string) ($body['Name'] ?? $body['name'] ?? ''));
        $content = (string) ($body['StackFileContent'] ?? $body['stackFileContent'] ?? '');
        $env = $body['Env'] ?? $body['env'] ?? [];
        if (!is_array($env)) {
            $env = [];
        }
        if ($name === '' || $content === '') {
            return Response::error('Le nom et le contenu Compose sont requis', 400);
        }
        if (!preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/', $name)) {
            return Response::error('Nom de stack invalide', 400);
        }
        if ($deny = $this->assertComposeSafeForUser($content, $env, $user)) {
            return $deny;
        }

        $entryPoint = 'docker-compose.yml';
        $projectPath = null;
        $deployedOnAgent = false;
        try {
            foreach ($this->repo->listStacks($endpointId) as $existing) {
                if (strcasecmp((string) $existing['name'], $name) === 0) {
                    return Response::error('Une stack avec ce nom existe déjà', 409);
                }
            }
            $content = Ownership::injectComposeServiceLabels($content, Ownership::labelsFor($user));
            // Miroir YAML local (éditeur UI) — déploiement réel sur local ou agent
            // Préfixe ep{N}_ pour éviter collision de miroirs entre nœuds
            $mirrorKey = $isAgent ? ('ep' . $endpointId . '_' . $name) : $name;
            $projectPath = $this->compose->writeComposeFile($mirrorKey, $content, $entryPoint);
            $this->compose->writeEnvFile($projectPath, $env);
            $pullImages = !empty($body['PullImages']) || !empty($body['pullImages']) || !empty($body['Pull']);
            if ($isAgent) {
                $this->agentComposeClient($ep)->up($name, $content, $env, $entryPoint, $pullImages);
                $deployedOnAgent = true;
            } else {
                $this->compose->up($projectPath, $name, $env, $pullImages);
            }
            $row = $this->repo->createStack(
                $name,
                $endpointId,
                $projectPath,
                $entryPoint,
                $env,
                (string) $user['username'],
            );
            $this->imageUpdates->invalidateStack((int) ($row['id'] ?? 0));
        } catch (\Throwable $e) {
            if ($deployedOnAgent && is_array($ep ?? null)) {
                try {
                    $this->agentComposeClient($ep)->down($name, $env, $entryPoint);
                } catch (\Throwable) {
                }
            }
            if (is_string($projectPath) && $projectPath !== '') {
                if (!$isAgent) {
                    try {
                        $this->compose->down($projectPath, $name, $env);
                    } catch (\Throwable) {
                    }
                }
                $this->compose->removeProjectDir($projectPath);
            }
            return Response::error($e->getMessage(), 500);
        }

        $this->audit($user, 'stack.create', 'Création de la stack « ' . $name . ' »', $request, [
            'stackId' => (int) ($row['id'] ?? 0),
            'name' => $name,
            'endpointId' => $endpointId,
        ]);
        if (is_array($row)) {
            $this->syncBindVolumesForStack($row);
        }
        return Response::json($this->formatStack($row), 200);
    }

    /** @param array<string, mixed> $user */
    public function updateStack(int $id, Request $request, array $user): Response
    {
        $stack = $this->repo->getStack($id);
        if (!$stack || !$this->canAccessStack($stack, $user)) {
            return Response::error('Stack introuvable', 404);
        }
        if (!$this->canOperateStack($stack, $user)) {
            return Response::error('Permissions insuffisantes (lecture seule)', 403);
        }
        $ep = $this->repo->getEndpoint((int) $stack['endpoint_id']);
        if (!$ep) {
            return Response::error('Environnement introuvable', 404);
        }
        $isAgent = ($ep['kind'] ?? 'local') === 'agent';
        $body = $request->json();
        $content = (string) ($body['StackFileContent'] ?? $body['stackFileContent'] ?? '');
        $env = $body['Env'] ?? $body['env'] ?? json_decode($stack['env_json'], true);
        if (!is_array($env)) {
            $env = [];
        }
        if ($content === '') {
            try {
                $content = $this->compose->readComposeFile($stack['project_path'], $stack['entry_point']);
            } catch (\Throwable $e) {
                return Response::error($e->getMessage(), 400);
            }
        }
        if ($deny = $this->assertComposeSafeForUser($content, $env, $user)) {
            return $deny;
        }

        try {
            $content = Ownership::injectComposeServiceLabels($content, Ownership::labelsFor($user));
            $this->compose->writeComposeContent(
                (string) $stack['project_path'],
                $content,
                (string) $stack['entry_point'],
            );
            $this->compose->writeEnvFile($stack['project_path'], $env);
            $pullImages = !empty($body['PullImages']) || !empty($body['pullImages']) || !empty($body['Pull']);
            if ($isAgent) {
                $this->agentComposeClient($ep)->up(
                    (string) $stack['name'],
                    $content,
                    $env,
                    (string) $stack['entry_point'],
                    $pullImages,
                );
            } else {
                $this->compose->up($stack['project_path'], $stack['name'], $env, $pullImages);
            }
            $row = $this->repo->updateStack($id, $env, (string) $user['username']);
            $this->repo->setStackStatus($id, 1);
            $row = $this->repo->getStack($id) ?? $row;
            $this->imageUpdates->invalidateStack($id);
        } catch (\Throwable $e) {
            return Response::error($e->getMessage(), 500);
        }

        $this->audit($user, 'stack.update', 'Mise à jour de la stack « ' . $stack['name'] . ' »', $request, [
            'stackId' => $id,
            'name' => $stack['name'],
        ]);
        $fresh = $row ?? $stack;
        if (is_array($fresh)) {
            $this->syncBindVolumesForStack($fresh);
        }
        return Response::json($this->formatStack($fresh));
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function deleteStack(int $id, Request $request, array $user): Response
    {
        $stack = $this->repo->getStack($id);
        if (!$stack || !$this->canAccessStack($stack, $user)) {
            return Response::error('Stack introuvable', 404);
        }
        if (!$this->canOperateStack($stack, $user)) {
            return Response::error('Permissions insuffisantes (lecture seule)', 403);
        }
        $ep = $this->repo->getEndpoint((int) $stack['endpoint_id']);
        $env = json_decode($stack['env_json'], true);
        if (!is_array($env)) {
            $env = [];
        }
        try {
            if ($ep && ($ep['kind'] ?? 'local') === 'agent') {
                $this->agentComposeClient($ep)->down(
                    (string) $stack['name'],
                    $env,
                    (string) ($stack['entry_point'] ?? 'docker-compose.yml'),
                );
            } else {
                $this->compose->down($stack['project_path'], $stack['name'], $env);
            }
            $this->compose->removeProjectDir($stack['project_path']);
            $this->repo->pruneStackBindVolumes($id, []);
            $this->repo->deleteStack($id);
            $this->imageUpdates->invalidateStack($id);
        } catch (\Throwable $e) {
            return Response::error($e->getMessage(), 500);
        }
        $this->audit($user, 'stack.delete', 'Suppression de la stack « ' . $stack['name'] . ' »', $request, [
            'stackId' => $id,
            'name' => $stack['name'],
        ]);
        return Response::empty(204);
    }

    /**
     * @param 'start'|'stop'|'restart' $action
     * @param array{id:int,username:string,role:int} $user
     */
}
