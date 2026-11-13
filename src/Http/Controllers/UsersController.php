<?php
declare(strict_types=1);

namespace App\Http\Controllers;

use App\Access\EndpointAcl;
use App\Access\Ownership;
use App\Http\Request;
use App\Http\Response;
use App\Security\PasswordPolicy;

final class UsersController extends BaseController
{
    public function createToken(int $userId, Request $request, array $user): Response
    {
        if ((int) $user['id'] !== $userId && (int) $user['role'] !== 1) {
            return Response::error('Accès refusé', 403);
        }
        $body = $request->json();
        $description = trim((string) ($body['description'] ?? $body['Description'] ?? 'api-key'));
        if ($description === '') {
            $description = 'api-key';
        }
        if (mb_strlen($description) > 120) {
            return Response::error('Description trop longue (max 120)', 400);
        }
        if ($description === 'scheduler-sidecar') {
            return Response::error('Description réservée', 400);
        }
        $password = (string) ($body['password'] ?? $body['Password'] ?? '');
        $dbUser = $this->repo->findUserById($userId);
        if (!$dbUser) {
            return Response::error('Utilisateur introuvable', 404);
        }
        if (!$this->verifyUserPassword($dbUser, $password)) {
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
            'rawHint' => substr($raw, -4),
            'dateCreated' => $meta['dateCreated'],
            'rawAPIKey' => $raw,
        ]);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function listTokens(int $userId, array $user): Response
    {
        if ((int) $user['id'] !== $userId && (int) $user['role'] !== 1) {
            return Response::error('Accès refusé', 403);
        }
        if (!$this->repo->findUserById($userId)) {
            return Response::error('Utilisateur introuvable', 404);
        }
        $rows = array_values(array_filter(
            $this->repo->listApiKeysForUser($userId),
            static fn(array $row): bool => (string) ($row['description'] ?? '') !== 'scheduler-sidecar',
        ));
        return Response::json(array_map(static function (array $row): array {
            return [
                'id' => (int) $row['id'],
                'description' => (string) ($row['description'] ?? ''),
                'prefix' => (string) ($row['prefix'] ?? ''),
                'rawHint' => (string) ($row['raw_hint'] ?? ''),
                'dateCreated' => (int) ($row['date_created'] ?? 0),
                'lastUsed' => isset($row['last_used']) && $row['last_used'] !== null
                    ? (int) $row['last_used']
                    : null,
            ];
        }, $rows));
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function revokeToken(int $userId, int $tokenId, Request $request, array $user): Response
    {
        if ((int) $user['id'] !== $userId && (int) $user['role'] !== 1) {
            return Response::error('Accès refusé', 403);
        }
        $row = $this->repo->findApiKeyById($tokenId);
        if (!$row || (int) $row['user_id'] !== $userId) {
            return Response::error('Clé API introuvable', 404);
        }
        if ((string) ($row['description'] ?? '') === 'scheduler-sidecar') {
            return Response::error('Cette clé système ne peut pas être révoquée ici', 400);
        }
        $this->repo->deleteApiKey($tokenId);
        $this->audit($user, 'api_key.revoke', 'Révocation d’une clé API (« ' . ($row['description'] ?? '') . ' »)', $request, [
            'targetUserId' => $userId,
            'prefix' => (string) ($row['prefix'] ?? ''),
            'tokenId' => $tokenId,
        ]);
        return Response::empty(204);
    }

    /** @param array<string, mixed> $dbUser */
    private function verifyUserPassword(array $dbUser, string $password): bool
    {
        if ($password === '') {
            return false;
        }
        $authSource = (string) ($dbUser['auth_source'] ?? 'local');
        if ($authSource === 'ldap') {
            $ldapCfg = $this->ldapConfig();
            if (empty($ldapCfg['enabled'])) {
                return false;
            }
            try {
                return $this->ldap->authenticate($ldapCfg, (string) $dbUser['username'], $password) !== null;
            } catch (\Throwable $e) {
                error_log('[WharfMaster] LDAP verify for API key: ' . $e->getMessage());
                return false;
            }
        }
        return password_verify($password, (string) $dbUser['password_hash']);
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
