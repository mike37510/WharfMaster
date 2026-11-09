<?php
declare(strict_types=1);

namespace App\Http\Controllers;

use App\Access\Ownership;
use App\Http\Request;
use App\Http\Response;
use App\Storage\Repositories;

/**
 * Per-resource shares between users — independent of endpoint/node ACL.
 */
final class SharesController extends BaseController
{
    /** Directory of users for the share picker (any authenticated user). */
    public function listDirectory(array $user): Response
    {
        $me = Ownership::userId($user);
        $out = [];
        foreach ($this->repo->listUsers() as $u) {
            $id = (int) ($u['id'] ?? 0);
            if ($id === $me) {
                continue;
            }
            $out[] = [
                'Id' => $id,
                'Username' => (string) ($u['username'] ?? ''),
            ];
        }
        return Response::json($out);
    }

    public function listShares(Request $request, array $user): Response
    {
        $type = strtolower(trim((string) ($request->query('type') ?? $request->query('Type') ?? '')));
        $endpointId = (int) ($request->query('endpointId') ?? $request->query('EndpointId') ?? 0);
        $key = trim((string) ($request->query('key') ?? $request->query('Key') ?? ''));
        if (!in_array($type, Repositories::SHARE_TYPES, true) || $endpointId < 1 || $key === '') {
            return Response::error('Paramètres type, endpointId et key requis', 400);
        }
        if ($err = $this->assertCanManageShares($type, $endpointId, $key, $user)) {
            return $err;
        }
        $rows = $this->repo->listSharesForResource($type, $endpointId, $key);
        return Response::json(array_map([$this, 'formatShare'], $rows));
    }

    public function createShare(Request $request, array $user): Response
    {
        $body = $request->json();
        $type = strtolower(trim((string) ($body['Type'] ?? $body['type'] ?? '')));
        $endpointId = (int) ($body['EndpointId'] ?? $body['endpointId'] ?? 0);
        $key = trim((string) ($body['Key'] ?? $body['key'] ?? ''));
        $granteeId = (int) ($body['GranteeUserId'] ?? $body['granteeUserId'] ?? $body['UserId'] ?? 0);
        if (!in_array($type, Repositories::SHARE_TYPES, true) || $endpointId < 1 || $key === '') {
            return Response::error('Type, EndpointId et Key requis', 400);
        }
        if ($granteeId < 1) {
            return Response::error('GranteeUserId requis', 400);
        }
        if ($granteeId === Ownership::userId($user)) {
            return Response::error('Impossible de partager avec soi-même', 400);
        }
        $grantee = $this->repo->findUserById($granteeId);
        if (!$grantee) {
            return Response::error('Utilisateur introuvable', 404);
        }
        if ($err = $this->assertCanManageShares($type, $endpointId, $key, $user)) {
            return $err;
        }
        $row = $this->repo->createResourceShare(
            $type,
            $endpointId,
            $this->normalizeKey($type, $key),
            $granteeId,
            Ownership::userId($user),
            'operate',
        );
        $this->audit($user, 'share.create', 'Partage ' . $type . ' → ' . ($grantee['username'] ?? $granteeId), $request, [
            'type' => $type,
            'endpointId' => $endpointId,
            'key' => $key,
            'granteeId' => $granteeId,
        ]);
        return Response::json($this->formatShare($row), 201);
    }

    public function deleteShare(int $id, Request $request, array $user): Response
    {
        $row = $this->repo->getResourceShare($id);
        if (!$row) {
            return Response::error('Partage introuvable', 404);
        }
        $type = (string) $row['resource_type'];
        $endpointId = (int) $row['endpoint_id'];
        $key = (string) $row['resource_key'];
        if ($err = $this->assertCanManageShares($type, $endpointId, $key, $user)) {
            return $err;
        }
        $this->repo->deleteResourceShare($id);
        $this->audit($user, 'share.delete', 'Suppression partage #' . $id, $request, [
            'type' => $type,
            'endpointId' => $endpointId,
            'key' => $key,
        ]);
        return Response::json(['Ok' => true]);
    }

    /**
     * Only the resource owner (or global admin) can manage shares — not a mere grantee.
     * @param array{id:int,username:string,role:int} $user
     */
    private function assertCanManageShares(string $type, int $endpointId, string $key, array $user): ?Response
    {
        if (Ownership::isGlobalAdmin($user)) {
            return null;
        }
        $key = $this->normalizeKey($type, $key);
        if ($type === 'stack') {
            $stack = $this->repo->getStack((int) $key);
            if (!$stack || (int) ($stack['endpoint_id'] ?? 0) !== $endpointId) {
                return Response::error('Stack introuvable', 404);
            }
            if (!$this->ownsStackRecord($stack, $user)) {
                return Response::error('Seul le propriétaire peut gérer le partage', 403);
            }
            return null;
        }

        $ep = $this->repo->getEndpoint($endpointId);
        if (!$ep) {
            return Response::error('Nœud introuvable', 404);
        }
        if ($deny = $this->assertEndpointUsable($ep)) {
            return $deny;
        }
        try {
            $scope = $this->scopeForEndpoint($ep);
            $ok = match ($type) {
                'container' => $this->userOwnsDockerObject($ep, $user, 'container', $key),
                'volume' => $this->userOwnsDockerObject($ep, $user, 'volume', $key),
                'network' => $this->userOwnsDockerObject($ep, $user, 'network', $key),
                default => false,
            };
            unset($scope);
        } catch (\Throwable $e) {
            return Response::error($e->getMessage(), 502);
        }
        if (!$ok) {
            return Response::error('Seul le propriétaire peut gérer le partage', 403);
        }
        return null;
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function userOwnsDockerObject(array $ep, array $user, string $type, string $key): bool
    {
        $docker = $this->dockerForEndpoint($ep);
        try {
            if ($type === 'container') {
                $info = $docker->json('GET', '/containers/' . rawurlencode($key) . '/json');
                $labels = $info['Config']['Labels'] ?? $info['Labels'] ?? [];
            } elseif ($type === 'volume') {
                $info = $docker->json('GET', '/volumes/' . rawurlencode($key));
                $labels = $info['Labels'] ?? [];
            } else {
                $info = $docker->json('GET', '/networks/' . rawurlencode($key));
                $labels = $info['Labels'] ?? [];
            }
        } catch (\Throwable) {
            return false;
        }
        if (!is_array($labels)) {
            $labels = [];
        }
        // Owner label OR compose project belonging to a stack the user owns.
        $ownedStacks = [];
        foreach ($this->repo->listStacks((int) ($ep['id'] ?? 0)) as $stack) {
            if (strcasecmp((string) ($stack['created_by'] ?? ''), Ownership::username($user)) === 0) {
                $ownedStacks[] = (string) ($stack['name'] ?? '');
            }
        }
        return Ownership::ownsDockerResource($labels, $user, $ownedStacks);
    }

    private function normalizeKey(string $type, string $key): string
    {
        $key = trim($key);
        if ($type === 'container' || $type === 'network' || $type === 'volume') {
            $key = ltrim($key, '/');
        }
        return $key;
    }

    /** @param array<string, mixed> $row */
    private function formatShare(array $row): array
    {
        $type = (string) ($row['resource_type'] ?? '');
        return [
            'Id' => (int) ($row['id'] ?? 0),
            'Type' => $type,
            'EndpointId' => (int) ($row['endpoint_id'] ?? 0),
            'Key' => (string) ($row['resource_key'] ?? ''),
            'GranteeUserId' => (int) ($row['grantee_id'] ?? 0),
            'GranteeUsername' => (string) ($row['grantee_username'] ?? ''),
            'Role' => (string) ($row['role'] ?? 'operate'),
            'CreatedByUserId' => (int) ($row['created_by_user_id'] ?? 0),
            'CreatedAt' => (int) ($row['created_at'] ?? 0),
            // Stack share cascades to Compose containers / volumes / networks (same project).
            'Cascades' => $type === 'stack',
        ];
    }
}
