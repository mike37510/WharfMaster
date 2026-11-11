<?php
declare(strict_types=1);

namespace App;

use App\Access\EndpointAcl;
use App\Http\AppContext;
use App\Http\Controllers\AclsController;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\ContainersController;
use App\Http\Controllers\EndpointsController;
use App\Http\Controllers\ImagesController;
use App\Http\Controllers\NodesController;
use App\Http\Controllers\RegistriesController;
use App\Http\Controllers\SchedulesController;
use App\Http\Controllers\SharesController;
use App\Http\Controllers\StacksController;
use App\Http\Controllers\SystemController;
use App\Http\Controllers\TeamsController;
use App\Http\Controllers\UsersController;
use App\Http\Controllers\VolumesController;
use App\Http\Request;
use App\Http\Response;
use App\Http\Router;

/**
 * Application kernel: wires services, registers routes, dispatches.
 */
final class App
{
    private AppContext $ctx;
    private Router $publicRoutes;
    private Router $routes;

    /** @param array<string, mixed> $config */
    public function __construct(array $config)
    {
        $this->ctx = new AppContext($config);
        $this->publicRoutes = new Router();
        $this->routes = new Router();
        $this->registerRoutes();
    }

    public function handle(Request $request): Response
    {
        if ($request->method === 'OPTIONS') {
            return Response::empty(204);
        }

        $path = rtrim($request->path, '/') ?: '/';
        if ($path === '/api') {
            $path = '/api/status';
        }

        try {
            return $this->dispatch($request, $path);
        } catch (\Throwable $e) {
            $status = $e->getCode() >= 400 && $e->getCode() < 600 ? (int) $e->getCode() : 500;
            $message = $status >= 500 ? 'Erreur interne' : $e->getMessage();
            if ($status >= 500) {
                error_log('[WharfMaster] ' . $e->getMessage() . "\n" . $e->getTraceAsString());
            }
            return Response::error($message, $status);
        }
    }

    private function dispatch(Request $request, string $path): Response
    {
        $hit = $this->publicRoutes->match($request, $path);
        if ($hit !== null) {
            return ($hit['handler'])($request, $hit['params']);
        }

        $user = $this->ctx->authenticateRequest($request);
        if ($user instanceof Response) {
            return $user;
        }

        $hit = $this->routes->match($request, $path);
        if ($hit === null) {
            return Response::error('Introuvable', 404);
        }
        $params = $hit['params'];
        $params['__user'] = $user;
        return ($hit['handler'])($request, $params);
    }

    private function registerRoutes(): void
    {
        $ctx = $this->ctx;
        $sys = new SystemController($ctx);
        $auth = new AuthController($ctx);
        $users = new UsersController($ctx);
        $teams = new TeamsController($ctx);
        $acls = new AclsController($ctx);
        $nodes = new NodesController($ctx);
        $endpoints = new EndpointsController($ctx);
        $containers = new ContainersController($ctx);
        $images = new ImagesController($ctx);
        $volumes = new VolumesController($ctx);
        $stacks = new StacksController($ctx);
        $registries = new RegistriesController($ctx);
        $schedules = new SchedulesController($ctx);
        $shares = new SharesController($ctx);

        $u = static fn (array $p): array => $p['__user'];

        // --- Public ---
        $this->publicRoutes->get('/api/status', function () use ($ctx) {
            return Response::json([
                'Version' => $ctx->config['version'],
                'InstanceID' => $ctx->repo->getSetting('instance_id', $ctx->ensureInstanceId()),
            ]);
        });
        $this->publicRoutes->get('/api/system/status', function () use ($ctx) {
            return Response::json([
                'Version' => $ctx->config['version'],
                'InstanceID' => $ctx->repo->getSetting('instance_id', $ctx->ensureInstanceId()),
            ]);
        });
        $this->publicRoutes->get('/api/system/version', function () use ($ctx) {
            return Response::json([
                'Version' => $ctx->config['version'],
                'Platform' => 'WharfMaster',
                'ServerVersion' => $ctx->config['version'],
                'DatabaseEdition' => $ctx->config['edition'],
                'AgentImage' => $ctx->config['agent_image'] ?? null,
            ]);
        });
        $this->publicRoutes->get('/api/health', fn () => $sys->healthCheck());
        $this->publicRoutes->get('/api/users/admin/check', fn () => Response::json(['adminInit' => $ctx->repo->userCount() === 0]));
        $this->publicRoutes->post('/api/users/admin/init', fn ($r) => $auth->adminInit($r));
        $this->publicRoutes->post('/api/auth', fn ($r) => $auth->authenticate($r));
        $this->publicRoutes->post('/api/nodes/join', fn ($r) => $auth->joinNode($r));

        // --- Authenticated ---
        $R = $this->routes;

        $R->get('/api/audit', fn ($r, $p) => $sys->listAudit($r, $u($p)));
        $R->get('/api/users/me', fn ($r, $p) => Response::json($ctx->publicUser($u($p))));
        $R->get('/api/system/host', fn () => Response::json($ctx->hostResources()));
        $R->get('/api/metrics/history', fn ($r) => $sys->metricsHistory($r));
        $R->post('/api/metrics/sample', fn ($r, $p) => $sys->metricsSample($r, $u($p)));
        $R->get('/api/settings', fn () => Response::json($ctx->formatSettings()));
        $R->put('/api/settings', fn ($r, $p) => $sys->updateSettings($r, $u($p)));
        $R->get('/api/system/diagnostics', fn ($r, $p) => $sys->diagnostics($u($p)));
        $R->get('/api/backup', fn ($r, $p) => $sys->downloadBackup($r, $u($p)));

        $R->get('/api/users/directory', fn ($r, $p) => $shares->listDirectory($u($p)));
        $R->get('/api/users', fn ($r, $p) => $users->listUsers($u($p)));
        $R->post('/api/users', fn ($r, $p) => $users->createUser($r, $u($p)));
        $R->put('/api/users/{id}/passwd', fn ($r, $p) => $users->changeUserPassword((int) $p['id'], $r, $u($p)));
        $R->delete('/api/users/{id}', fn ($r, $p) => $users->deleteUser((int) $p['id'], $u($p)));
        $R->get('/api/users/{id}/tokens', fn ($r, $p) => $users->listTokens((int) $p['id'], $u($p)));
        $R->post('/api/users/{id}/tokens', fn ($r, $p) => $users->createToken((int) $p['id'], $r, $u($p)));
        $R->delete('/api/users/{id}/tokens/{tid}', fn ($r, $p) => $users->revokeToken((int) $p['id'], (int) $p['tid'], $r, $u($p)));
        $R->get('/api/users/{id}', fn ($r, $p) => $users->getUserPortainer((int) $p['id'], $u($p)));

        $R->get('/api/teams', function ($r, $p) use ($teams, $u) {
            $detail = strtolower((string) ($r->query('detail') ?? $r->query('expand') ?? ''));
            if (in_array($detail, ['1', 'true', 'yes'], true)) {
                return $teams->listTeamsDetailed($u($p));
            }
            return $teams->listTeams($u($p));
        });
        $R->post('/api/teams', fn ($r, $p) => $teams->createTeam($r, $u($p)));
        $R->get('/api/teams/{id}', fn ($r, $p) => $teams->getTeam((int) $p['id'], $u($p)));
        $R->put('/api/teams/{id}', fn ($r, $p) => $teams->updateTeam((int) $p['id'], $r, $u($p)));
        $R->delete('/api/teams/{id}', fn ($r, $p) => $teams->deleteTeam((int) $p['id'], $u($p)));
        $R->post('/api/teams/{id}/members', fn ($r, $p) => $teams->addTeamMember((int) $p['id'], $r, $u($p)));
        $R->delete('/api/teams/{id}/members/{uid}', fn ($r, $p) => $teams->removeTeamMember((int) $p['id'], (int) $p['uid'], $u($p)));
        $R->get('/api/teams/{id}/memberships', fn ($r, $p) => $teams->listTeamMembershipsForTeam((int) $p['id'], $u($p)));
        $R->get('/api/team_memberships', fn ($r, $p) => $teams->listTeamMembershipsPortainer($u($p)));
        $R->post('/api/team_memberships', fn ($r, $p) => $teams->createTeamMembershipPortainer($r, $u($p)));
        $R->delete('/api/team_memberships/{id}', fn ($r, $p) => $teams->deleteTeamMembershipPortainer((int) $p['id'], $r, $u($p)));

        $R->get('/api/acls', fn ($r, $p) => $acls->listAcls($r, $u($p)));
        $R->post('/api/acls', fn ($r, $p) => $acls->upsertAcl($r, $u($p)));
        $R->delete('/api/acls/{id}', fn ($r, $p) => $acls->deleteAcl((int) $p['id'], $r, $u($p)));

        $R->get('/api/shares', fn ($r, $p) => $shares->listShares($r, $u($p)));
        $R->post('/api/shares', fn ($r, $p) => $shares->createShare($r, $u($p)));
        $R->delete('/api/shares/{id}', fn ($r, $p) => $shares->deleteShare((int) $p['id'], $r, $u($p)));

        $R->get('/api/schedules', fn ($r, $p) => $schedules->listSchedules($r, $u($p)));
        $R->post('/api/schedules', fn ($r, $p) => $schedules->createSchedule($r, $u($p)));
        $R->post('/api/schedules/run-due', fn ($r, $p) => $schedules->runDueSchedules($r, $u($p)));
        $R->get('/api/schedules/{id}', fn ($r, $p) => $schedules->getScheduleApi((int) $p['id'], $u($p)));
        $R->put('/api/schedules/{id}', fn ($r, $p) => $schedules->updateSchedule((int) $p['id'], $r, $u($p)));
        $R->delete('/api/schedules/{id}', fn ($r, $p) => $schedules->deleteSchedule((int) $p['id'], $r, $u($p)));
        $R->post('/api/schedules/{id}/run', fn ($r, $p) => $schedules->runScheduleNow((int) $p['id'], $r, $u($p)));

        $R->get('/api/endpoints/{id}/images/scans', fn ($r, $p) => $images->listImageScans((int) $p['id'], $u($p)));
        $R->post('/api/endpoints/{id}/images/scans/ensure', fn ($r, $p) => $images->ensureImageScans((int) $p['id'], $r, $u($p)));
        $R->post('/api/endpoints/{id}/images/advise', fn ($r, $p) => $images->adviseImages((int) $p['id'], $r, $u($p)));
        $R->add(['GET', 'POST'], '/api/endpoints/{id}/images/scan', function ($r, $p) use ($images, $u) {
            return strtoupper($r->method) === 'GET'
                ? $images->getImageScan((int) $p['id'], $r, $u($p))
                : $images->scanImage((int) $p['id'], $r, $u($p));
        });

        $R->get('/api/endpoints', function ($r, $p) use ($ctx, $u) {
            $user = $u($p);
            $eps = $ctx->endpointAcl->filterEndpoints($user, $ctx->repo->listEndpoints());
            return Response::json(array_map(static function (array $ep) use ($ctx, $user): array {
                $fmt = $ctx->formatEndpoint($ep);
                $fmt['AccessRole'] = $ctx->endpointAcl->roleFor($user, (int) $ep['id']);
                return $fmt;
            }, $eps));
        });
        $R->post('/api/endpoints', fn () => Response::error('Utilisez /api/nodes/join pour enrôler un nœud agent', 400));
        $R->get('/api/endpoints/{id}', function ($r, $p) use ($ctx, $u) {
            $user = $u($p);
            $ep = $ctx->repo->getEndpoint((int) $p['id']);
            if (!$ep) {
                return Response::error('Environnement introuvable', 404);
            }
            if (!$ctx->endpointAcl->can($user, (int) $ep['id'], EndpointAcl::READ)) {
                return Response::error('Accès refusé à ce nœud', 403);
            }
            $fmt = $ctx->formatEndpoint($ep);
            $fmt['AccessRole'] = $ctx->endpointAcl->roleFor($user, (int) $ep['id']);
            return Response::json($fmt);
        });
        $R->put('/api/endpoints/{id}', fn ($r, $p) => $endpoints->updateEndpointPortainer((int) $p['id'], $r, $u($p)));

        $R->get('/api/nodes', fn ($r, $p) => $nodes->listNodes($u($p)));
        $R->get('/api/nodes/join-token', fn ($r, $p) => $nodes->getJoinTokenMeta($u($p)));
        $R->post('/api/nodes/join-token', fn ($r, $p) => $nodes->createJoinToken($r, $u($p)));
        $R->post('/api/nodes/join-token/rotate', fn ($r, $p) => $nodes->rotateJoinToken($r, $u($p)));
        $R->add(['GET', 'POST'], '/api/nodes/agent-bundle', fn ($r, $p) => $nodes->downloadAgentBundle($r, $u($p)));
        $R->post('/api/nodes/{id}/disable', fn ($r, $p) => $nodes->setNodeEnabled((int) $p['id'], false, $r, $u($p)));
        $R->post('/api/nodes/{id}/enable', fn ($r, $p) => $nodes->setNodeEnabled((int) $p['id'], true, $r, $u($p)));
        $R->post('/api/nodes/{id}/ping', fn ($r, $p) => $nodes->pingNode((int) $p['id'], $u($p)));
        $R->put('/api/nodes/{id}', fn ($r, $p) => $nodes->updateNode((int) $p['id'], $r, $u($p)));
        $R->delete('/api/nodes/{id}', fn ($r, $p) => $nodes->unlinkNode((int) $p['id'], $r, $u($p)));

        $R->add(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], '/api/endpoints/{id}/docker{dockerPath:.*}', function ($r, $p) use ($endpoints, $u) {
            $dockerPath = $p['dockerPath'] ?? '/';
            if ($dockerPath === '') {
                $dockerPath = '/';
            }
            return $endpoints->proxyDocker((int) $p['id'], $dockerPath, $r, $u($p));
        });

        $R->get('/api/endpoints/{id}/containers', fn ($r, $p) => $endpoints->proxyDocker((int) $p['id'], '/containers/json', $r, $u($p)));
        $R->get('/api/endpoints/{id}/containers/updates', fn ($r, $p) => $containers->listContainerImageUpdates((int) $p['id'], $r, $u($p)));
        $R->get('/api/endpoints/{id}/containers/{cid}/updates', fn ($r, $p) => $containers->getContainerImageUpdate((int) $p['id'], (string) $p['cid'], $r, $u($p)));
        $R->post('/api/endpoints/{id}/containers/{cid}/update', fn ($r, $p) => $containers->updateContainerImage((int) $p['id'], (string) $p['cid'], $r, $u($p)));
        $R->get('/api/endpoints/{id}/containers/{cid}/logs', fn ($r, $p) => $containers->containerLogs((int) $p['id'], (string) $p['cid'], $r, $u($p)));
        $R->post('/api/endpoints/{id}/containers/{cid}/exec', fn ($r, $p) => $containers->containerExec((int) $p['id'], (string) $p['cid'], $r, $u($p)));
        $R->post('/api/endpoints/{id}/containers/{cid}/console', fn ($r, $p) => $containers->containerConsole((int) $p['id'], (string) $p['cid'], $r, $u($p)));
        $R->post('/api/endpoints/{id}/console/{eid}/resize', fn ($r, $p) => $containers->containerConsoleResize((int) $p['id'], (string) $p['eid'], $r, $u($p)));

        $R->get('/api/endpoints/{id}/bind-volumes', fn ($r, $p) => $volumes->listBindVolumes((int) $p['id'], $r, $u($p)));
        $R->post('/api/endpoints/{id}/bind-volumes', fn ($r, $p) => $volumes->createBindVolume((int) $p['id'], $r, $u($p)));
        $R->delete('/api/endpoints/{id}/bind-volumes/{vid}', fn ($r, $p) => $volumes->deleteBindVolume((int) $p['id'], (int) $p['vid'], $r, $u($p)));

        $R->get('/api/endpoints/{id}/volumes/{name}/browse', fn ($r, $p) => $volumes->browseVolume((int) $p['id'], rawurldecode((string) $p['name']), $r, $u($p)));
        $R->get('/api/endpoints/{id}/volumes/{name}/file', fn ($r, $p) => $volumes->readVolumeFile((int) $p['id'], rawurldecode((string) $p['name']), $r, $u($p)));
        $R->post('/api/endpoints/{id}/volumes/{name}/file', fn ($r, $p) => $volumes->writeVolumeFile((int) $p['id'], rawurldecode((string) $p['name']), $r, $u($p)));
        $R->post('/api/endpoints/{id}/volumes/{name}/upload', fn ($r, $p) => $volumes->uploadVolumeFile((int) $p['id'], rawurldecode((string) $p['name']), $r, $u($p)));
        $R->post('/api/endpoints/{id}/volumes/{name}/mkdir', fn ($r, $p) => $volumes->mkdirVolumePath((int) $p['id'], rawurldecode((string) $p['name']), $r, $u($p)));
        $R->post('/api/endpoints/{id}/volumes/{name}/rename', fn ($r, $p) => $volumes->renameVolumePath((int) $p['id'], rawurldecode((string) $p['name']), $r, $u($p)));
        $R->delete('/api/endpoints/{id}/volumes/{name}/entry', fn ($r, $p) => $volumes->deleteVolumeEntry((int) $p['id'], rawurldecode((string) $p['name']), $r, $u($p)));
        $R->get('/api/endpoints/{id}/volumes/{name}/download', fn ($r, $p) => $volumes->downloadVolumeFile((int) $p['id'], rawurldecode((string) $p['name']), $r, $u($p)));

        $R->get('/api/images/search', fn ($r) => $images->searchImages($r));
        $R->get('/api/images/tags', fn ($r) => $images->searchImageTags($r));
        $R->post('/api/images/build', fn ($r, $p) => $images->buildImage($r, $u($p)));
        $R->get('/api/dockerfiles', fn () => Response::json($ctx->imageBuilder->listDockerfiles()));
        $R->post('/api/dockerfiles', fn ($r) => $images->saveDockerfile($r));
        $R->get('/api/dockerfiles/{name}', function ($r, $p) use ($ctx) {
            try {
                $name = rawurldecode((string) $p['name']);
                return Response::json(['Name' => $name, 'Content' => $ctx->imageBuilder->readDockerfile($name)]);
            } catch (\Throwable $e) {
                $code = (int) $e->getCode();
                return Response::error($e->getMessage(), $code >= 400 ? $code : 404);
            }
        });
        $R->delete('/api/dockerfiles/{name}', function ($r, $p) use ($ctx) {
            try {
                $ctx->imageBuilder->deleteDockerfile(rawurldecode((string) $p['name']));
                return Response::empty(204);
            } catch (\Throwable $e) {
                return Response::error($e->getMessage(), 400);
            }
        });

        $legacyVol = function (string $action) use ($volumes, $ctx, $u) {
            return function ($r, $p) use ($action, $volumes, $ctx, $u) {
                $ep = $ctx->endpointIdFromRequest($r);
                $name = rawurldecode((string) $p['name']);
                return $volumes->$action($ep, $name, $r, $u($p));
            };
        };
        $R->get('/api/volumes/{name}/browse', $legacyVol('browseVolume'));
        $R->get('/api/volumes/{name}/file', $legacyVol('readVolumeFile'));
        $R->post('/api/volumes/{name}/file', $legacyVol('writeVolumeFile'));
        $R->post('/api/volumes/{name}/upload', $legacyVol('uploadVolumeFile'));
        $R->post('/api/volumes/{name}/mkdir', $legacyVol('mkdirVolumePath'));
        $R->post('/api/volumes/{name}/rename', $legacyVol('renameVolumePath'));
        $R->delete('/api/volumes/{name}/entry', $legacyVol('deleteVolumeEntry'));
        $R->get('/api/volumes/{name}/download', $legacyVol('downloadVolumeFile'));

        $R->get('/api/registries', function ($r, $p) use ($ctx, $u) {
            $user = $u($p);
            $rows = $ctx->repo->listRegistriesForUser(
                \App\Access\Ownership::userId($user),
                \App\Access\Ownership::isAdmin($user),
            );
            return Response::json(array_map([$ctx, 'formatRegistry'], $rows));
        });
        $R->post('/api/registries', fn ($r, $p) => $registries->createRegistry($r, $u($p)));
        $R->get('/api/registries/{id}', function ($r, $p) use ($ctx, $u) {
            $row = $ctx->repo->getRegistry((int) $p['id']);
            if (!$row || !$ctx->canAccessRegistry($row, $u($p))) {
                return Response::error('Registre introuvable', 404);
            }
            return Response::json($ctx->formatRegistry($row));
        });
        $R->put('/api/registries/{id}', fn ($r, $p) => $registries->updateRegistry((int) $p['id'], $r, $u($p)));
        $R->delete('/api/registries/{id}', function ($r, $p) use ($ctx, $u) {
            $row = $ctx->repo->getRegistry((int) $p['id']);
            if (!$row || !$ctx->canManageRegistry($row, $u($p))) {
                return Response::error('Registre introuvable ou accès refusé', 404);
            }
            $ctx->repo->deleteRegistry((int) $p['id']);
            return Response::empty(204);
        });
        $R->get('/api/registries/{id}/ping', fn ($r, $p) => $registries->pingRegistry((int) $p['id'], $u($p)));
        $R->get('/api/registries/{id}/repositories', fn ($r, $p) => $registries->browseRegistryRepos((int) $p['id'], $r, $u($p)));
        $R->get('/api/registries/{id}/tags', function ($r, $p) use ($registries, $u) {
            $repo = (string) ($r->query('repo') ?? $r->query('repository') ?? '');
            return $registries->browseRegistryTags((int) $p['id'], $repo, $u($p));
        });
        $R->post('/api/registries/{id}/pull', fn ($r, $p) => $registries->pullFromRegistry((int) $p['id'], $r, $u($p)));

        $R->get('/api/stacks', fn ($r, $p) => $stacks->listStacks($r, $u($p)));
        $R->get('/api/stacks/updates', fn ($r, $p) => $stacks->listStackImageUpdates($r, $u($p)));
        $R->get('/api/stacks/{id}/updates', fn ($r, $p) => $stacks->getStackImageUpdates((int) $p['id'], $r, $u($p)));
        $R->post('/api/stacks/create/standalone/string', fn ($r, $p) => $stacks->createStack($r, $u($p)));
        $R->post('/api/stacks', function ($r, $p) use ($stacks, $u) {
            $type = (int) ($r->query('type') ?? 2);
            $methodParam = $r->query('method') ?? 'string';
            if ($type === 2 && $methodParam === 'string') {
                return $stacks->createStack($r, $u($p));
            }
            return Response::error('Méthode de création de stack non prise en charge', 400);
        });
        $R->get('/api/stacks/{id}/file', fn ($r, $p) => $stacks->getStackFile((int) $p['id'], $u($p)));
        $R->post('/api/stacks/{id}/{action:start|stop|restart}', fn ($r, $p) => $ctx->controlStack((int) $p['id'], (string) $p['action'], $r, $u($p)));
        $R->get('/api/stacks/{id}', fn ($r, $p) => $stacks->getStack((int) $p['id'], $u($p)));
        $R->put('/api/stacks/{id}', fn ($r, $p) => $stacks->updateStack((int) $p['id'], $r, $u($p)));
        $R->delete('/api/stacks/{id}', fn ($r, $p) => $stacks->deleteStack((int) $p['id'], $r, $u($p)));
    }
}
