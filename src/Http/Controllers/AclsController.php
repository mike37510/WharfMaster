<?php
declare(strict_types=1);

namespace App\Http\Controllers;

use App\Access\EndpointAcl;
use App\Access\Ownership;
use App\Http\Request;
use App\Http\Response;

final class AclsController extends BaseController
{
    public function listAcls(Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $endpointId = $request->query('endpointId');
        $filter = $endpointId !== null && $endpointId !== '' ? (int) $endpointId : null;
        $rows = $this->repo->listEndpointAcls($filter);
        $items = [];
        foreach ($rows as $row) {
            $items[] = $this->formatAcl($row);
        }
        return Response::json(['Items' => $items]);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function upsertAcl(Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $body = $request->json();
        $endpointId = (int) ($body['EndpointId'] ?? $body['endpoint_id'] ?? 0);
        $subjectType = strtolower(trim((string) ($body['SubjectType'] ?? $body['subject_type'] ?? 'user')));
        $subjectId = (int) ($body['SubjectId'] ?? $body['subject_id'] ?? 0);
        $role = strtolower(trim((string) ($body['Role'] ?? $body['role'] ?? 'operate')));
        if (!$this->repo->getEndpoint($endpointId)) {
            return Response::error('Nœud introuvable', 404);
        }
        if (!in_array($subjectType, ['user', 'team'], true)) {
            return Response::error('SubjectType invalide (user|team)', 400);
        }
        if (!EndpointAcl::isValidRole($role)) {
            return Response::error('Rôle invalide (read|operate|admin)', 400);
        }
        if ($subjectType === 'user' && !$this->repo->findUserById($subjectId)) {
            return Response::error('Utilisateur introuvable', 404);
        }
        if ($subjectType === 'team' && !$this->repo->getTeam($subjectId)) {
            return Response::error('Équipe introuvable', 404);
        }
        $row = $this->repo->upsertEndpointAcl($endpointId, $subjectType, $subjectId, $role);
        $this->audit($user, 'acl.upsert', 'ACL nœud mise à jour', $request, [
            'endpointId' => $endpointId,
            'subjectType' => $subjectType,
            'subjectId' => $subjectId,
            'role' => $role,
        ]);
        return Response::json($this->formatAcl($row));
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function deleteAcl(int $id, Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $this->repo->deleteEndpointAcl($id);
        $this->audit($user, 'acl.delete', 'ACL nœud supprimée', $request, ['aclId' => $id]);
        return Response::empty(204);
    }

    /** @param array<string, mixed> $row */
}
