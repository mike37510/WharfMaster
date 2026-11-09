<?php
declare(strict_types=1);

namespace App\Http\Controllers;

use App\Access\EndpointAcl;
use App\Access\Ownership;
use App\Http\Request;
use App\Http\Response;

final class UsersController extends BaseController
{
    public function createToken(int $userId, Request $request, array $user): Response
    {
        if ((int) $user['id'] !== $userId && (int) $user['role'] !== 1) {
            return Response::error('Accès refusé', 403);
        }
        $body = $request->json();
        $description = (string) ($body['description'] ?? $body['Description'] ?? 'api-key');
        $password = (string) ($body['password'] ?? $body['Password'] ?? '');
        $dbUser = $this->repo->findUserById($userId);
        if (!$dbUser) {
            return Response::error('Utilisateur introuvable', 404);
        }
        if ($password === '' || !password_verify($password, $dbUser['password_hash'])) {
            return Response::error('Mot de passe requis pour créer une clé API', 422);
        }
        $raw = 'ptr_' . bin2hex(random_bytes(24));
        $meta = $this->repo->createApiKey($userId, $description, $raw);
        $this->audit($user, 'api_key.create', 'Création d’une clé API (« ' . $description . ' »)', $request, [
            'targetUserId' => $userId,
            'prefix' => $meta['prefix'],
        ]);
        return Response::json([
            'id' => $meta['id'],
            'description' => $description,
            'prefix' => $meta['prefix'],
            'dateCreated' => $meta['dateCreated'],
            'rawAPIKey' => $raw,
        ]);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function listUsers(array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $rows = array_values(array_filter(
            $this->repo->listUsers(),
            static fn(array $row): bool => (string) ($row['username'] ?? '') !== '__scheduler__',
        ));
        return Response::json(array_map(static function (array $row): array {
            return [
                'Id' => (int) $row['id'],
                'Username' => $row['username'],
                'Role' => (int) $row['role'],
                'AuthSource' => (string) ($row['auth_source'] ?? 'local'),
                'ThemeSettings' => (object) [],
            ];
        }, $rows));
    }

    /** @param array<string, mixed> $user */
    public function createUser(Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $body = $request->json();
        $username = trim((string) ($body['Username'] ?? $body['username'] ?? ''));
        $password = (string) ($body['Password'] ?? $body['password'] ?? '');
        $role = (int) ($body['Role'] ?? $body['role'] ?? 2);
        if ($username === '' || !preg_match('/^[a-zA-Z0-9._-]{3,64}$/', $username)) {
            return Response::error('Nom d\'utilisateur invalide (3–64 caractères alphanumériques)', 400);
        }
        if ($err = PasswordPolicy::validate($password)) {
            return Response::error($err, 400);
        }
        if (!in_array($role, [1, 2], true)) {
            return Response::error('Rôle invalide', 400);
        }
        if ($this->repo->findUserByUsername($username)) {
            return Response::error('Ce nom d\'utilisateur existe déjà', 409);
        }
        $created = $this->repo->createUser($username, $password, $role);
        $this->audit($user, 'user.create', 'Création de l’utilisateur « ' . $username . ' »', $request, [
            'targetId' => (int) $created['id'],
            'role' => $role,
        ]);
        return Response::json($this->publicUser([
            'id' => (int) $created['id'],
            'username' => $created['username'],
            'role' => (int) $created['role'],
        ]), 200);
    }

    /** @param array<string, mixed> $user */
    public function changeUserPassword(int $id, Request $request, array $user): Response
    {
        $isAdmin = (int) ($user['role'] ?? 0) === 1;
        $isSelf = (int) ($user['id'] ?? 0) === $id;
        if (!$isAdmin && !$isSelf) {
            return Response::error('Accès refusé', 403);
        }
        $target = $this->repo->findUserById($id);
        if (!$target) {
            return Response::error('Utilisateur introuvable', 404);
        }
        $body = $request->json();
        $newPassword = (string) ($body['Password'] ?? $body['password'] ?? $body['NewPassword'] ?? '');
        if ($err = PasswordPolicy::validate($newPassword)) {
            return Response::error($err, 400);
        }
        $confirm = $body['PasswordConfirm'] ?? $body['passwordConfirm'] ?? $body['ConfirmPassword'] ?? null;
        if ($confirm !== null && !hash_equals($newPassword, (string) $confirm)) {
            return Response::error('Les mots de passe ne correspondent pas', 400);
        }
        // Changing own password requires current password. Admin reset of another user does not.
        if ($isSelf) {
            $current = (string) ($body['CurrentPassword'] ?? $body['currentPassword'] ?? '');
            if ($current === '' || !password_verify($current, $target['password_hash'])) {
                return Response::error('Mot de passe actuel invalide', 422);
            }
        }
        $this->repo->updateUserPassword($id, $newPassword);
        $this->audit($user, 'user.password', 'Changement de mot de passe pour « ' . $target['username'] . ' »', $request, [
            'targetId' => $id,
            'self' => $isSelf,
        ]);
        return Response::empty(204);
    }

    /** @param array<string, mixed> $user */
    public function deleteUser(int $id, Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        if ((int) $user['id'] === $id) {
            return Response::error('Vous ne pouvez pas supprimer votre propre compte', 400);
        }
        $target = $this->repo->findUserById($id);
        if (!$target) {
            return Response::error('Utilisateur introuvable', 404);
        }
        // Prevent deleting the last admin
        if ((int) $target['role'] === 1) {
            $admins = array_filter($this->repo->listUsers(), static fn(array $u): bool => (int) $u['role'] === 1);
            if (count($admins) <= 1) {
                return Response::error('Impossible de supprimer le dernier administrateur', 400);
            }
        }
        $this->repo->deleteUser($id);
        $this->audit($user, 'user.delete', 'Suppression de l’utilisateur « ' . $target['username'] . ' »', $request, [
            'targetId' => $id,
        ]);
        return Response::empty(204);
    }

    /** @param array<string, mixed> $user */
    public function getUserPortainer(int $id, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $row = $this->repo->findUserById($id);
        if (!$row || (string) ($row['username'] ?? '') === '__scheduler__') {
            return Response::error('Utilisateur introuvable', 404);
        }
        return Response::json([
            'Id' => (int) $row['id'],
            'Username' => (string) $row['username'],
            'Role' => (int) $row['role'],
            'AuthSource' => (string) ($row['auth_source'] ?? 'local'),
            'ThemeSettings' => (object) [],
        ]);
    }

    // --- LDAP helpers ---

    /** @return array<string, mixed> */
}
