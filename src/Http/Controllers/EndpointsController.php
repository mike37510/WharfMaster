<?php
declare(strict_types=1);

namespace App\Http\Controllers;

use App\Access\EndpointAcl;
use App\Access\Ownership;
use App\Http\Request;
use App\Http\Response;

final class EndpointsController extends BaseController
{
    public function proxyDocker(int $endpointId, string $dockerPath, Request $request, array $user): Response
    {
        $ep = $this->repo->getEndpoint($endpointId);
        if (!$ep) {
            return Response::error('Environnement introuvable', 404);
        }
        if ($deny = $this->assertEndpointUsable($ep)) {
            return $deny;
        }
        $role = $this->endpointAcl->roleFor($user, $endpointId);
        $viaShareOnly = false;
        if ($role === EndpointAcl::NONE) {
            if ($this->repo->userHasSharesOnEndpoint(Ownership::userId($user), $endpointId)) {
                // Share grants operate on shared resources only — not full node ACL.
                $role = EndpointAcl::OPERATE;
                $viaShareOnly = true;
            } else {
                return Response::error('Accès refusé à ce nœud', 403);
            }
        }
        $min = in_array(strtoupper($request->method), ['GET', 'HEAD'], true)
            ? EndpointAcl::READ
            : EndpointAcl::OPERATE;
        if (!$viaShareOnly && !$this->endpointAcl->can($user, $endpointId, $min)) {
            return Response::error('Permissions insuffisantes sur ce nœud', 403);
        }

        $dockerPath = $dockerPath === '' ? '/' : $dockerPath;
        $forwardHeaders = [];
        $contentType = $request->header('Content-Type');
        if ($contentType) {
            $forwardHeaders['Content-Type'] = $contentType;
        }

        // Never mark share-only users as endpoint admin.
        $scopedUser = $viaShareOnly ? $user : $this->endpointAcl->withEndpointContext($user, $role);
        $scope = $this->scopeForEndpoint($ep);
        $response = $scope->handle(
            $scopedUser,
            $request->method,
            $dockerPath,
            $request->rawBody !== '' ? $request->rawBody : null,
            $forwardHeaders,
            $request->query,
            $role,
        );
        if ($response->status < 400) {
            $this->repo->updateEndpointLastSeen((int) $ep['id'], 1);
            $this->auditDockerMutation($user, $request->method, $dockerPath, $request);
        }
        return $response;
    }

    /**
     * @param array{id:int,username:string,role:int} $user
     * @return array{0:?array,1:?Response} endpoint row or error
     */
    public function updateEndpointPortainer(int $id, Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $ep = $this->repo->getEndpoint($id);
        if (!$ep) {
            return Response::error('Environnement introuvable', 404);
        }
        $body = $request->json();
        if (isset($body['UserAccessPolicies']) && (is_array($body['UserAccessPolicies']) || is_object($body['UserAccessPolicies']))) {
            $this->syncPortainerPolicies($id, 'user', (array) $body['UserAccessPolicies']);
        }
        if (isset($body['TeamAccessPolicies']) && (is_array($body['TeamAccessPolicies']) || is_object($body['TeamAccessPolicies']))) {
            $this->syncPortainerPolicies($id, 'team', (array) $body['TeamAccessPolicies']);
        }
        $meta = [];
        if (isset($body['Name']) || isset($body['NodeName']) || isset($body['name'])) {
            $name = trim((string) ($body['NodeName'] ?? $body['Name'] ?? $body['name'] ?? ''));
            if ($name !== '' && preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/', $name)) {
                $meta['name'] = $name;
                $meta['node_name'] = $name;
            }
        }
        if (isset($body['PublicURL']) || isset($body['publicURL'])) {
            $meta['public_url'] = rtrim(trim((string) ($body['PublicURL'] ?? $body['publicURL'] ?? '')), '/');
        }
        if ($meta !== []) {
            $this->repo->updateEndpointDetails($id, $meta);
        }
        $this->audit($user, 'endpoint.update', 'Mise à jour endpoint #' . $id . ' (policies Portainer)', $request, [
            'endpointId' => $id,
        ]);
        $fresh = $this->repo->getEndpoint($id) ?? $ep;
        $fmt = $this->formatEndpoint($fresh);
        $fmt['AccessRole'] = $this->endpointAcl->roleFor($user, $id);
        return Response::json($fmt);
    }

    /** @param array<string|int, mixed> $policies */
}
