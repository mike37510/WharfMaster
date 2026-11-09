<?php
declare(strict_types=1);

namespace App\Http\Controllers;

use App\Access\EndpointAcl;
use App\Access\Ownership;
use App\Http\Request;
use App\Http\Response;

final class TeamsController extends BaseController
{
    public function listTeamMembershipsPortainer(array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $items = [];
        foreach ($this->repo->listTeams() as $t) {
            $tid = (int) $t['id'];
            foreach ($this->repo->listTeamMembers($tid) as $m) {
                $uid = (int) $m['id'];
                $items[] = [
                    'Id' => $this->membershipId($tid, $uid),
                    'UserID' => $uid,
                    'TeamID' => $tid,
                    'Role' => 2, // member (Portainer: 1=leader, 2=member)
                ];
            }
        }
        return Response::json($items);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function listTeamMembershipsForTeam(int $teamId, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        if (!$this->repo->getTeam($teamId)) {
            return Response::error('Équipe introuvable', 404);
        }
        $items = [];
        foreach ($this->repo->listTeamMembers($teamId) as $m) {
            $uid = (int) $m['id'];
            $items[] = [
                'Id' => $this->membershipId($teamId, $uid),
                'UserID' => $uid,
                'TeamID' => $teamId,
                'Role' => 2,
            ];
        }
        return Response::json($items);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function createTeamMembershipPortainer(Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $body = $request->json();
        $teamId = (int) ($body['TeamID'] ?? $body['TeamId'] ?? $body['team_id'] ?? 0);
        $userId = (int) ($body['UserID'] ?? $body['UserId'] ?? $body['user_id'] ?? 0);
        if (!$this->repo->getTeam($teamId)) {
            return Response::error('Équipe introuvable', 404);
        }
        if (!$this->repo->findUserById($userId)) {
            return Response::error('Utilisateur introuvable', 404);
        }
        $this->repo->addTeamMember($teamId, $userId);
        $this->audit($user, 'team.member_add', 'Membership Portainer team=' . $teamId, $request, [
            'teamId' => $teamId,
            'userId' => $userId,
        ]);
        return Response::json([
            'Id' => $this->membershipId($teamId, $userId),
            'UserID' => $userId,
            'TeamID' => $teamId,
            'Role' => (int) ($body['Role'] ?? 2),
        ], 200);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function deleteTeamMembershipPortainer(int $id, Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $parsed = $this->parseMembershipId($id);
        if ($parsed === null) {
            return Response::error('Membership introuvable', 404);
        }
        [$teamId, $userId] = $parsed;
        $this->repo->removeTeamMember($teamId, $userId);
        $this->audit($user, 'team.member_remove', 'Membership Portainer #' . $id, $request, [
            'teamId' => $teamId,
            'userId' => $userId,
        ]);
        return Response::empty(204);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function listTeams(array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $items = [];
        foreach ($this->repo->listTeams() as $t) {
            $items[] = [
                'Id' => (int) $t['id'],
                'Name' => (string) $t['name'],
            ];
        }
        return Response::json($items);
    }

    /** WharfMaster detailed teams (Members, AdGroupDn, …) — also a bare array. */
    public function listTeamsDetailed(array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $items = [];
        foreach ($this->repo->listTeams() as $t) {
            $members = $this->repo->listTeamMembers((int) $t['id']);
            $items[] = $this->formatTeam($t, $members);
        }
        return Response::json($items);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function getTeam(int $id, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $t = $this->repo->getTeam($id);
        if (!$t) {
            return Response::error('Équipe introuvable', 404);
        }
        return Response::json($this->formatTeam($t, $this->repo->listTeamMembers($id)));
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function createTeam(Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $body = $request->json();
        $name = trim((string) ($body['Name'] ?? $body['name'] ?? ''));
        $desc = trim((string) ($body['Description'] ?? $body['description'] ?? ''));
        $adDn = trim((string) ($body['AdGroupDn'] ?? $body['ad_group_dn'] ?? ''));
        if ($name === '' || strlen($name) > 64) {
            return Response::error('Nom d\'équipe invalide', 400);
        }
        try {
            $t = $this->repo->createTeam($name, $desc, $adDn);
        } catch (\Throwable $e) {
            return Response::error('Équipe déjà existante ou invalide', 409);
        }
        $this->audit($user, 'team.create', 'Création de l\'équipe « ' . $name . ' »', $request, [
            'teamId' => (int) $t['id'],
        ]);
        return Response::json($this->formatTeam($t, []), 201);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function updateTeam(int $id, Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $t = $this->repo->getTeam($id);
        if (!$t) {
            return Response::error('Équipe introuvable', 404);
        }
        $body = $request->json();
        $name = trim((string) ($body['Name'] ?? $body['name'] ?? $t['name']));
        $desc = trim((string) ($body['Description'] ?? $body['description'] ?? $t['description'] ?? ''));
        $adDn = trim((string) ($body['AdGroupDn'] ?? $body['ad_group_dn'] ?? $t['ad_group_dn'] ?? ''));
        $updated = $this->repo->updateTeam($id, $name, $desc, $adDn);
        $this->audit($user, 'team.update', 'Mise à jour de l\'équipe « ' . $name . ' »', $request, [
            'teamId' => $id,
        ]);
        return Response::json($this->formatTeam($updated ?? $t, $this->repo->listTeamMembers($id)));
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function deleteTeam(int $id, Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $t = $this->repo->getTeam($id);
        if (!$t) {
            return Response::error('Équipe introuvable', 404);
        }
        $this->repo->deleteTeam($id);
        $this->audit($user, 'team.delete', 'Suppression de l\'équipe « ' . $t['name'] . ' »', $request, [
            'teamId' => $id,
        ]);
        return Response::empty(204);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function addTeamMember(int $teamId, Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $t = $this->repo->getTeam($teamId);
        if (!$t) {
            return Response::error('Équipe introuvable', 404);
        }
        $body = $request->json();
        $uid = (int) ($body['UserId'] ?? $body['user_id'] ?? 0);
        if (!$this->repo->findUserById($uid)) {
            return Response::error('Utilisateur introuvable', 404);
        }
        $this->repo->addTeamMember($teamId, $uid);
        $this->audit($user, 'team.member_add', 'Ajout d\'un membre à « ' . $t['name'] . ' »', $request, [
            'teamId' => $teamId,
            'userId' => $uid,
        ]);
        return Response::json($this->formatTeam($t, $this->repo->listTeamMembers($teamId)));
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function removeTeamMember(int $teamId, int $memberId, Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $t = $this->repo->getTeam($teamId);
        if (!$t) {
            return Response::error('Équipe introuvable', 404);
        }
        $this->repo->removeTeamMember($teamId, $memberId);
        $this->audit($user, 'team.member_remove', 'Retrait d\'un membre de « ' . $t['name'] . ' »', $request, [
            'teamId' => $teamId,
            'userId' => $memberId,
        ]);
        return Response::empty(204);
    }

    /**
     * @param array<string, mixed> $t
     * @param list<array<string, mixed>> $members
     */
}
