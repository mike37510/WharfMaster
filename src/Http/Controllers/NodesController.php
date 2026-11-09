<?php
declare(strict_types=1);

namespace App\Http\Controllers;

use App\Access\EndpointAcl;
use App\Access\Ownership;
use App\Http\Request;
use App\Http\Response;

final class NodesController extends BaseController
{
    public function listNodes(array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $items = [];
        foreach ($this->repo->listEndpoints() as $ep) {
            $items[] = $this->formatEndpoint($ep);
        }
        return Response::json(['Items' => $items]);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function getJoinTokenMeta(array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $row = $this->repo->getActiveJoinToken();
        if (!$row) {
            return Response::json(['Active' => null]);
        }
        return Response::json([
            'Active' => [
                'Id' => (int) $row['id'],
                'Hint' => '…' . (string) $row['token_hint'],
                'Label' => (string) $row['label'],
                'CreatedAt' => (int) $row['created_at'],
                'CreatedBy' => (string) $row['created_by'],
                'ExpiresAt' => (int) $row['expires_at'],
                'MaxUses' => $row['max_uses'] !== null ? (int) $row['max_uses'] : null,
                'UseCount' => (int) $row['use_count'],
            ],
        ]);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function createJoinToken(Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $body = $request->json();
        $ttl = (int) ($body['ttlSeconds'] ?? $body['TtlSeconds'] ?? 86400);
        $ttl = max(300, min(86400 * 30, $ttl));
        $label = trim((string) ($body['label'] ?? $body['Label'] ?? ''));
        $maxUses = $body['maxUses'] ?? $body['MaxUses'] ?? null;
        $maxUses = $maxUses === null || $maxUses === '' ? null : max(1, (int) $maxUses);
        $nodeHost = trim((string) ($body['nodeHost'] ?? $body['NodeHost'] ?? $body['ip'] ?? $body['Ip'] ?? ''));
        $nodeName = trim((string) ($body['nodeName'] ?? $body['NodeName'] ?? $body['name'] ?? $body['Name'] ?? ''));
        $nodePort = (int) ($body['nodePort'] ?? $body['NodePort'] ?? $body['port'] ?? $body['Port'] ?? 9001);

        $this->repo->revokeAllJoinTokens();
        $created = $this->repo->createJoinToken((string) $user['username'], $label, $ttl, $maxUses);
        $this->audit($user, 'node.token.create', 'Génération d’un token de jointure', $request, [
            'hint' => $created['row']['token_hint'] ?? '',
            'expiresAt' => $created['row']['expires_at'] ?? null,
            'nodeHost' => $nodeHost,
            'nodeName' => $nodeName,
        ]);
        return Response::json($this->formatJoinTokenResponse(
            $created['token'],
            $created['row'],
            $request,
            $nodeHost,
            $nodeName,
            $nodePort,
        ));
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function rotateJoinToken(Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $body = $request->json();
        $ttl = (int) ($body['ttlSeconds'] ?? $body['TtlSeconds'] ?? 86400);
        $ttl = max(300, min(86400 * 30, $ttl));
        $nodeHost = trim((string) ($body['nodeHost'] ?? $body['NodeHost'] ?? $body['ip'] ?? $body['Ip'] ?? ''));
        $nodeName = trim((string) ($body['nodeName'] ?? $body['NodeName'] ?? $body['name'] ?? $body['Name'] ?? ''));
        $nodePort = (int) ($body['nodePort'] ?? $body['NodePort'] ?? $body['port'] ?? $body['Port'] ?? 9001);
        $this->repo->revokeAllJoinTokens();
        $created = $this->repo->createJoinToken((string) $user['username'], 'rotated', $ttl, null);
        $this->audit($user, 'node.token.rotate', 'Rotation du token de jointure', $request, [
            'nodeHost' => $nodeHost,
            'nodeName' => $nodeName,
        ]);
        return Response::json($this->formatJoinTokenResponse(
            $created['token'],
            $created['row'],
            $request,
            $nodeHost,
            $nodeName,
            $nodePort,
        ));
    }

    /** @param array<string, mixed> $row */
    public function downloadAgentBundle(Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        if (!class_exists(\ZipArchive::class)) {
            return Response::error('Extension PHP zip indisponible', 500);
        }

        $body = strtoupper($request->method) === 'POST' ? $request->json() : [];
        if (!is_array($body)) {
            $body = [];
        }
        $token = trim((string) ($body['Token'] ?? $body['token'] ?? $request->query('token') ?? ''));
        $nodeHost = trim((string) ($body['NodeHost'] ?? $body['nodeHost'] ?? $request->query('nodeHost') ?? ''));
        $nodeName = trim((string) ($body['NodeName'] ?? $body['nodeName'] ?? $request->query('nodeName') ?? ''));
        $nodePort = (int) ($body['NodePort'] ?? $body['nodePort'] ?? $request->query('nodePort') ?? 9001);
        if ($nodePort < 1 || $nodePort > 65535) {
            $nodePort = 9001;
        }
        $public = trim((string) ($body['PublicURL'] ?? $body['publicUrl'] ?? ''));
        if ($public === '') {
            $public = $this->resolvePublicBaseUrl($request);
        }
        $advertise = trim((string) ($body['AdvertiseURL'] ?? $body['advertiseUrl'] ?? ''));
        if ($advertise === '') {
            $advertise = $this->buildAdvertiseUrl($nodeHost, $nodePort);
        }
        if ($nodeName === '') {
            $nodeName = 'mon-serveur';
        }

        $agentDir = $this->resolveAgentSourceDir();
        if ($agentDir === null) {
            return Response::error('Sources agent introuvables sur le serveur', 500);
        }

        $safeName = preg_replace('/[^a-zA-Z0-9._-]+/', '-', $nodeName) ?: 'agent';
        $rootName = 'wharfmaster-agent-' . $safeName;
        $zipPath = sys_get_temp_dir() . '/' . $rootName . '-' . bin2hex(random_bytes(4)) . '.zip';

        try {
            $zip = new \ZipArchive();
            if ($zip->open($zipPath, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) {
                throw new \RuntimeException('Impossible de créer l’archive ZIP', 500);
            }

            $required = ['Dockerfile', 'agent.php', 'router.php', 'entrypoint.sh'];
            foreach ($required as $file) {
                $path = $agentDir . '/' . $file;
                if (!is_file($path)) {
                    throw new \RuntimeException('Fichier agent manquant : ' . $file, 500);
                }
                $zip->addFile($path, $rootName . '/' . $file);
            }

            $optional = ['install.sh', 'docker-compose.yml', 'deploy.sh', 'README.md', '.env.example'];
            foreach ($optional as $file) {
                $path = $agentDir . '/' . $file;
                if (is_file($path)) {
                    $zip->addFile($path, $rootName . '/' . $file);
                }
            }

            // Prefer in-tree templates; fall back to generated content if missing
            if (!is_file($agentDir . '/docker-compose.yml')) {
                $zip->addFromString($rootName . '/docker-compose.yml', $this->agentComposeYmlTemplate());
            }
            if (!is_file($agentDir . '/deploy.sh')) {
                $zip->addFromString($rootName . '/deploy.sh', $this->agentDeployShTemplate());
            }
            if (!is_file($agentDir . '/README.md')) {
                $zip->addFromString($rootName . '/README.md', $this->agentReadmeTemplate());
            }

            $tlsCn = preg_replace('#^https?://#i', '', $advertise) ?? '';
            $tlsCn = preg_replace('#[:/].*$#', '', $tlsCn) ?? '';
            if ($tlsCn === '') {
                $tlsCn = $nodeName;
            }

            $env = $this->buildAgentEnvFile([
                'WHARFMASTER_URL' => rtrim($public, '/'),
                'JOIN_TOKEN' => $token !== '' ? $token : 'wmj_REMPLACER',
                'ADVERTISE_URL' => $advertise,
                'NODE_NAME' => $nodeName,
                'AGENT_HOST_PORT' => (string) $nodePort,
                'AGENT_TLS_CN' => $tlsCn,
                'AGENT_TLS_DAYS' => '365',
                'STACKS_DIR' => '/var/lib/wharfmaster/stacks',
                'AGENT_IMAGE' => 'wharfmaster-agent:local',
            ]);
            $zip->addFromString($rootName . '/.env', $env);
            if (!is_file($agentDir . '/.env.example')) {
                $zip->addFromString($rootName . '/.env.example', $this->agentEnvExampleTemplate());
            }

            $zip->addFromString($rootName . '/MANIFEST.txt', implode("\n", [
                'WharfMaster agent pack',
                'Generated: ' . date('c'),
                'NodeName: ' . $nodeName,
                'Advertise: ' . $advertise,
                'Principal: ' . rtrim($public, '/'),
                'Token included: ' . ($token !== '' ? 'yes' : 'no (fill JOIN_TOKEN in .env)'),
                '',
                'Run: chmod +x deploy.sh entrypoint.sh install.sh && ./deploy.sh',
                '',
            ]));

            $zip->close();
            $blob = (string) file_get_contents($zipPath);
            $this->audit($user, 'node.agent_bundle', 'Téléchargement pack agent ZIP', $request, [
                'nodeName' => $nodeName,
                'advertise' => $advertise,
                'bytes' => strlen($blob),
                'hasToken' => $token !== '',
            ]);

            return new Response(200, $blob, [
                'Content-Type' => 'application/zip',
                'Content-Disposition' => 'attachment; filename="' . $rootName . '.zip"',
                'Cache-Control' => 'no-store',
                'Content-Security-Policy' => "default-src 'none'",
            ]);
        } catch (\Throwable $e) {
            $status = $e->getCode() >= 400 && $e->getCode() < 600 ? (int) $e->getCode() : 500;
            return Response::error($e->getMessage() !== '' ? $e->getMessage() : 'Échec génération pack agent', $status);
        } finally {
            @unlink($zipPath);
        }
    }

    public function updateNode(int $id, Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $ep = $this->repo->getEndpoint($id);
        if (!$ep) {
            return Response::error('Nœud introuvable', 404);
        }
        $body = $request->json();
        $name = trim((string) ($body['NodeName'] ?? $body['Name'] ?? $body['name'] ?? ''));
        if ($name === '') {
            return Response::error('Le nom du nœud est requis', 400);
        }
        if (!preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/', $name)) {
            return Response::error('Nom de nœud invalide (lettres, chiffres, . _ - ; 1–64 caractères)', 400);
        }

        $fields = [
            'name' => $name,
            'node_name' => $name,
        ];
        if (array_key_exists('PublicURL', $body) || array_key_exists('publicURL', $body) || array_key_exists('public_url', $body)) {
            $publicUrl = rtrim(trim((string) ($body['PublicURL'] ?? $body['publicURL'] ?? $body['public_url'] ?? '')), '/');
            if ($publicUrl !== '' && !preg_match('#^https?://#i', $publicUrl)) {
                return Response::error('L\'URL publique doit commencer par http:// ou https://', 400);
            }
            $fields['public_url'] = $publicUrl;
        }

        $kind = (string) ($ep['kind'] ?? 'local');
        if ($kind === 'agent') {
            $agentUrl = trim((string) ($body['AgentURL'] ?? $body['agentURL'] ?? $body['URL'] ?? $body['url'] ?? ''));
            if ($agentUrl === '') {
                $agentUrl = (string) ($ep['agent_url'] ?? '');
            }
            $agentUrl = rtrim($agentUrl, '/');
            if ($agentUrl === '' || !preg_match('#^https?://#i', $agentUrl)) {
                return Response::error('URL agent invalide (http:// ou https:// requis)', 400);
            }
            $fields['agent_url'] = $agentUrl;
            if (!empty($body['ClearTlsPin']) || !empty($body['clearTlsPin'])) {
                $fields['clear_tls_pin'] = true;
            }
        }

        $fresh = $this->repo->updateEndpointDetails($id, $fields);
        if (!$fresh) {
            return Response::error('Nœud introuvable', 404);
        }
        $this->audit($user, 'node.update', 'Modification du nœud « ' . $name . ' »', $request, [
            'endpointId' => $id,
            'kind' => $kind,
            'agentUrl' => $fields['agent_url'] ?? null,
        ]);
        return Response::json($this->formatEndpoint($fresh));
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function unlinkNode(int $id, Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        if ($id <= 1) {
            return Response::error('Le nœud local ne peut pas être délié', 400);
        }
        $ep = $this->repo->getEndpoint($id);
        if (!$ep || ($ep['kind'] ?? '') !== 'agent') {
            return Response::error('Nœud introuvable', 404);
        }
        $name = (string) ($ep['node_name'] ?? $ep['name']);
        $this->repo->deleteEndpoint($id);
        $this->audit($user, 'node.unlink', 'Déliaison du nœud « ' . $name . ' »', $request, [
            'endpointId' => $id,
        ]);
        return Response::empty(204);
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function setNodeEnabled(int $id, bool $enabled, Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        if ($id <= 1) {
            return Response::error('Le nœud local ne peut pas être désactivé', 400);
        }
        $ep = $this->repo->getEndpoint($id);
        if (!$ep || ($ep['kind'] ?? '') !== 'agent') {
            return Response::error('Nœud introuvable', 404);
        }
        $this->repo->setEndpointStatus($id, $enabled ? 1 : 0);
        $this->audit(
            $user,
            $enabled ? 'node.enable' : 'node.disable',
            ($enabled ? 'Activation' : 'Désactivation') . ' du nœud « ' . ($ep['node_name'] ?? $ep['name']) . ' »',
            $request,
            ['endpointId' => $id],
        );
        $fresh = $this->repo->getEndpoint($id);
        return Response::json($this->formatEndpoint($fresh ?? $ep));
    }

    /** @param array{id:int,username:string,role:int} $user */
    public function pingNode(int $id, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $ep = $this->repo->getEndpoint($id);
        if (!$ep) {
            return Response::error('Nœud introuvable', 404);
        }
        if ((int) ($ep['status'] ?? 1) === 0) {
            return Response::json(['Ok' => false, 'Status' => 0, 'Message' => 'Nœud désactivé']);
        }
        try {
            $ok = $this->dockerForEndpoint($ep)->ping();
        } catch (\Throwable $e) {
            $ok = false;
        }
        $this->repo->updateEndpointLastSeen($id, $ok ? 1 : 2);
        $tlsExpiresAt = null;
        $tlsFp = (string) ($ep['tls_fingerprint'] ?? '');
        if ($ok && ($ep['kind'] ?? '') === 'agent') {
            $meta = $this->probeAgentTlsMeta($ep);
            if ($meta !== null) {
                $tlsExpiresAt = $meta['expiresAt'] ?? null;
                $observed = (string) ($meta['fingerprint'] ?? '');
                if ($tlsFp === '' && $observed !== '') {
                    $tlsFp = $observed;
                }
                $this->repo->updateEndpointTlsMeta(
                    $id,
                    $tlsExpiresAt,
                    $tlsFp !== '' ? $tlsFp : null,
                );
            }
        }
        return Response::json([
            'Ok' => $ok,
            'Status' => $ok ? 1 : 2,
            'LastSeenAt' => time(),
            'TlsExpiresAt' => $tlsExpiresAt,
            'TlsDaysLeft' => $tlsExpiresAt ? (int) floor(($tlsExpiresAt - time()) / 86400) : null,
            'TlsRenewBy' => $tlsExpiresAt ? date('Y-m-d', max(0, $tlsExpiresAt - 30 * 86400)) : null,
            'TlsFingerprint' => $tlsFp,
            'TlsFingerprintShort' => AgentTls::short($tlsFp),
            'TlsPinned' => $tlsFp !== '',
        ]);
    }

    /**
     * @param array{id?:int,username?:string,role?:int}|null $user
     * @param array<string, mixed> $meta
     */
}
