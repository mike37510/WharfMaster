<?php
declare(strict_types=1);

namespace App\Http\Controllers;

use App\Access\EndpointAcl;
use App\Access\Ownership;
use App\Http\Request;
use App\Http\Response;
use App\Security\PasswordPolicy;

final class AuthController extends BaseController
{
    public function adminInit(Request $request): Response
    {
        if ($this->repo->userCount() > 0) {
            return Response::error('L\'administrateur est déjà initialisé', 409);
        }
        $ip = $this->clientIp($request);
        $bucket = 'admin-init:' . $ip;
        if ($this->rateLimiter->tooMany($bucket)) {
            return Response::error('Trop de tentatives, réessayez plus tard', 429);
        }
        $this->rateLimiter->hit($bucket);

        $body = $request->json();
        $username = trim((string) ($body['Username'] ?? $body['username'] ?? ''));
        $password = (string) ($body['Password'] ?? $body['password'] ?? '');
        if ($username === '' || !preg_match('/^[a-zA-Z0-9._-]{3,64}$/', $username)) {
            return Response::error('Nom d\'utilisateur invalide (3–64 caractères alphanumériques)', 400);
        }
        if ($err = PasswordPolicy::validate($password)) {
            return Response::error($err, 400);
        }
        $user = $this->repo->createAdmin($username, $password);
        $this->rateLimiter->clear($bucket);
        $this->ensureSchedulerApiKey();
        $this->audit(
            ['id' => (int) $user['id'], 'username' => (string) $user['username'], 'role' => (int) $user['role']],
            'auth.admin_init',
            'Initialisation de l’administrateur « ' . $username . ' »',
            $request,
        );
        return Response::json($this->publicUser([
            'id' => (int) $user['id'],
            'username' => $user['username'],
            'role' => (int) $user['role'],
        ]), 200);
    }

    public function authenticate(Request $request): Response
    {
        $ip = $this->clientIp($request);
        $bucket = 'auth:' . $ip;
        if ($this->rateLimiter->tooMany($bucket)) {
            $retry = $this->rateLimiter->retryAfter($bucket);
            $this->audit(null, 'auth.login.rate_limited', 'Connexion refusée (trop de tentatives)', $request, [
                'ip' => $ip,
            ]);
            return new Response(
                429,
                json_encode(['message' => 'Trop de tentatives de connexion'], JSON_UNESCAPED_UNICODE) ?: '{}',
                [
                    'Content-Type' => 'application/json',
                    'Retry-After' => (string) max(1, $retry),
                ],
            );
        }

        $body = $request->json();
        $username = (string) ($body['Username'] ?? $body['username'] ?? '');
        $password = (string) ($body['Password'] ?? $body['password'] ?? '');
        $user = $this->tryAuthenticateUser($username, $password, $request);
        if (!$user) {
            $this->rateLimiter->hit($bucket);
            usleep(random_int(80_000, 180_000));
            $this->audit(
                null,
                'auth.login.fail',
                'Échec de connexion' . ($username !== '' ? ' pour « ' . $username . ' »' : ''),
                $request,
                ['username' => $username],
            );
            return Response::error('Identifiants invalides', 422);
        }
        $this->rateLimiter->clear($bucket);
        $token = $this->jwt->encode([
            'id' => (int) $user['id'],
            'username' => $user['username'],
            'role' => (int) $user['role'],
        ]);
        $this->audit(
            ['id' => (int) $user['id'], 'username' => (string) $user['username'], 'role' => (int) $user['role']],
            'auth.login.ok',
            'Connexion de « ' . $user['username'] . ' »',
            $request,
            ['authSource' => (string) ($user['auth_source'] ?? 'local')],
        );
        return Response::json(['jwt' => $token]);
    }

    /**
     * Local password first; if LDAP enabled, try AD then fall back to local.
     * @return array<string, mixed>|null
     */
    public function tryAuthenticateUser(string $username, string $password, Request $request): ?array
    {
        $ldapCfg = $this->ldapConfig();
        $ldapEnabled = !empty($ldapCfg['enabled']);

        if ($ldapEnabled) {
            try {
                $ldapUser = $this->ldap->authenticate($ldapCfg, $username, $password);
                if ($ldapUser !== null) {
                    $existing = $this->repo->findUserByUsername($ldapUser['username'])
                        ?? $this->repo->findUserByUsername($username);
                    if ($existing && (string) ($existing['auth_source'] ?? 'local') === 'local'
                        && Ownership::isGlobalAdmin($existing)) {
                        // Never hijack the bootstrap admin via LDAP same name
                        return password_verify($password, $existing['password_hash']) ? $existing : null;
                    }
                    if (!$existing) {
                        $existing = $this->repo->createLdapUser($ldapUser['username'], 2);
                    }
                    $teams = $this->repo->listTeams();
                    $matched = $this->ldap->matchTeamIds($ldapUser['groups'], $teams);
                    $this->repo->syncUserTeamMemberships((int) $existing['id'], $matched);
                    $existing['auth_source'] = 'ldap';
                    return $existing;
                }
            } catch (\Throwable $e) {
                error_log('[WharfMaster] LDAP auth error: ' . $e->getMessage());
                // fall through to local
            }
        }

        $user = $this->repo->findUserByUsername($username);
        if (!$user) {
            return null;
        }
        if ((string) ($user['auth_source'] ?? 'local') === 'ldap') {
            // LDAP-only account and LDAP failed above
            return null;
        }
        if (!password_verify($password, $user['password_hash'])) {
            return null;
        }
        return $user;
    }

    /** @param array<string, mixed> $user */
    public function joinNode(Request $request): Response
    {
        $ip = $this->clientIp($request);
        $bucket = 'node-join:' . $ip;
        if ($this->rateLimiter->tooMany($bucket)) {
            return Response::error('Trop de tentatives', 429);
        }
        $this->rateLimiter->hit($bucket);

        $body = $request->json();
        $token = trim((string) ($body['token'] ?? $body['Token'] ?? ''));
        $name = trim((string) ($body['name'] ?? $body['Name'] ?? ''));
        $agentUrl = rtrim(trim((string) ($body['agentUrl'] ?? $body['AgentURL'] ?? $body['advertise'] ?? '')), '/');

        if ($token === '' || !str_starts_with($token, 'wmj_')) {
            return Response::error('Token de jointure invalide', 422);
        }
        if ($name === '' || !preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/', $name)) {
            return Response::error('Nom de nœud invalide', 400);
        }
        if ($agentUrl === '' || !preg_match('#^https://#i', $agentUrl)) {
            return Response::error('URL agent (advertise) invalide — HTTPS obligatoire (ex. https://192.168.1.5:9001)', 400);
        }

        $row = $this->repo->findValidJoinToken($token);
        if (!$row) {
            $this->audit(null, 'node.join.fail', 'Échec de jointure (token invalide)', $request, [
                'name' => $name,
                'agentUrl' => $agentUrl,
            ]);
            return Response::error('Token de jointure invalide ou expiré', 403);
        }

        $existing = $this->repo->findEndpointByAgentUrl($agentUrl);
        $nodeSecret = 'wmn_' . bin2hex(random_bytes(24));
        $rejoined = false;
        if ($existing && (int) $existing['id'] > 1 && ($existing['kind'] ?? '') === 'agent') {
            $ep = $this->repo->rejoinAgentEndpoint((int) $existing['id'], $name, $nodeSecret);
            $rejoined = true;
        } else {
            $ep = $this->repo->createAgentEndpoint($name, $agentUrl, $nodeSecret);
        }
        $this->repo->incrementJoinTokenUse((int) $row['id']);
        $this->rateLimiter->clear($bucket);

        // Agent may not be listening yet at join time — pin when reachable
        $tlsMeta = AgentTls::inspect($agentUrl);
        $tlsExpiresAt = $tlsMeta['expiresAt'] ?? null;
        $tlsFp = $tlsMeta['fingerprint'] ?? '';
        if (!empty($ep['id'])) {
            $this->repo->updateEndpointTlsMeta((int) $ep['id'], $tlsExpiresAt, $tlsFp !== '' ? $tlsFp : null);
        }

        $this->audit(null, $rejoined ? 'node.rejoin' : 'node.join', 'Nœud « ' . $name . ' » ' . ($rejoined ? 'rejoint' : 'joint') . ' à l’infra', $request, [
            'endpointId' => (int) ($ep['id'] ?? 0),
            'agentUrl' => $agentUrl,
            'tlsExpiresAt' => $tlsExpiresAt,
            'tlsFingerprint' => $tlsFp !== '' ? AgentTls::short($tlsFp) : null,
            'rejoined' => $rejoined,
        ]);

        return Response::json([
            'NodeId' => (int) ($ep['id'] ?? 0),
            'TlsExpiresAt' => $tlsExpiresAt,
            'TlsFingerprint' => $tlsFp,
            'Name' => $name,
            'AgentURL' => $agentUrl,
            'NodeSecret' => $nodeSecret,
            'Rejoined' => $rejoined,
            'Message' => $rejoined
                ? 'Nœud déjà connu — secret renouvelé, redémarrez l’agent'
                : 'Nœud enregistré — démarrez l’agent avec ce NodeSecret',
        ], $rejoined ? 200 : 201);
    }

    /** @param array{id:int,username:string,role:int} $user */
}
