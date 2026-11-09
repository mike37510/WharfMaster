<?php
declare(strict_types=1);

namespace App;

use App\Access\DockerScope;
use App\Access\EndpointAcl;
use App\Access\Ownership;
use App\Auth\Jwt;
use App\Auth\LdapClient;
use App\Docker\AgentComposeClient;
use App\Docker\Client as DockerClient;
use App\Docker\ContainerRecreate;
use App\Docker\ImageBuilder;
use App\Docker\VolumeBrowser;
use App\Http\Request;
use App\Http\Response;
use App\Registry\Client as RegistryClient;
use App\Schedule\CronExpr;
use App\Security\AgentTls;
use App\Security\ComposePolicy;
use App\Security\ImageScanner;
use App\Security\PasswordPolicy;
use App\Security\RateLimiter;
use App\Security\SecretBox;
use App\Stack\BindVolumeExtractor;
use App\Stack\ComposeDeployer;
use App\Stack\ImageUpdateChecker;
use App\Storage\Database;
use App\Storage\Repositories;

final class App
{
    private Repositories $repo;
    private Jwt $jwt;
    private DockerClient $docker;
    private ComposeDeployer $compose;
    private ImageUpdateChecker $imageUpdates;
    private ImageBuilder $imageBuilder;
    private VolumeBrowser $volumeBrowser;
    private DockerScope $dockerScope;
    private EndpointAcl $endpointAcl;
    private ImageScanner $imageScanner;
    private LdapClient $ldap;
    private RateLimiter $rateLimiter;
    private SecretBox $secrets;
    /** @var array<string, mixed> */
    private array $config;

    /** @param array<string, mixed> $config */
    public function __construct(array $config)
    {
        $this->config = $config;
        $db = new Database($config['sqlite_path']);
        $db->migrate();
        $this->secrets = SecretBox::fromConfig($config);
        $this->repo = new Repositories($db->pdo(), $this->secrets);
        $this->jwt = new Jwt($config['jwt_secret'], (int) $config['jwt_ttl']);
        $this->docker = new DockerClient($config['docker_socket'], $config['docker_api_version']);
        $this->compose = new ComposeDeployer(
            $config['compose_dir'],
            $config['docker_socket'],
            $config['docker_bin'],
            $config['compose_bin'],
        );
        $cacheDir = dirname((string) $config['sqlite_path']) . '/image_digest_cache';
        $this->imageUpdates = new ImageUpdateChecker($this->compose, $cacheDir);
        $this->imageBuilder = new ImageBuilder(
            $this->docker,
            (string) $config['dockerfiles_dir'],
        );
        $this->volumeBrowser = new VolumeBrowser($this->docker);
        $this->dockerScope = new DockerScope($this->docker, $this->repo);
        $this->endpointAcl = new EndpointAcl($this->repo);
        $this->imageScanner = new ImageScanner(
            (string) (getenv('TRIVY_BIN') ?: 'trivy'),
            (string) $config['docker_socket'],
        );
        $this->ldap = new LdapClient();
        $rateDir = dirname((string) $config['sqlite_path']) . '/rate_limit';
        $this->rateLimiter = new RateLimiter($rateDir, 8, 900);
        $this->repo->ensureLocalEndpoint($config['docker_socket']);
        $this->repo->ensureDefaultHubRegistry();
        $this->repo->migrateRegistryPasswords();
        $this->ensureSchedulerApiKey();
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
            return $this->route($request, $path);
        } catch (\Throwable $e) {
            $status = $e->getCode() >= 400 && $e->getCode() < 600 ? (int) $e->getCode() : 500;
            $message = $status >= 500 ? 'Erreur interne' : $e->getMessage();
            if ($status >= 500) {
                error_log('[WharfMaster] ' . $e->getMessage() . "\n" . $e->getTraceAsString());
            }
            return Response::error($message, $status);
        }
    }

    private function route(Request $request, string $path): Response
    {
        $method = $request->method;

        if (($path === '/api/status' || $path === '/api/system/status') && $method === 'GET') {
            return Response::json([
                'Version' => $this->config['version'],
                'InstanceID' => $this->repo->getSetting('instance_id', $this->ensureInstanceId()),
            ]);
        }

        if ($path === '/api/system/version' && $method === 'GET') {
            return Response::json([
                'Version' => $this->config['version'],
                'Platform' => 'WharfMaster',
                'ServerVersion' => $this->config['version'],
                'DatabaseEdition' => $this->config['edition'],
                'AgentImage' => $this->config['agent_image'] ?? null,
            ]);
        }

        if ($path === '/api/health' && $method === 'GET') {
            return $this->healthCheck();
        }

        if ($path === '/api/users/admin/check' && $method === 'GET') {
            return Response::json(['adminInit' => $this->repo->userCount() === 0]);
        }

        if ($path === '/api/users/admin/init' && $method === 'POST') {
            return $this->adminInit($request);
        }

        if ($path === '/api/auth' && $method === 'POST') {
            return $this->authenticate($request);
        }

        // Agent enrollment — authenticated by join token only (no JWT)
        if ($path === '/api/nodes/join' && $method === 'POST') {
            return $this->joinNode($request);
        }

        $user = $this->authenticateRequest($request);
        if ($user instanceof Response) {
            return $user;
        }

        if ($path === '/api/audit' && $method === 'GET') {
            return $this->listAudit($request, $user);
        }

        if ($path === '/api/users/me' && $method === 'GET') {
            return Response::json($this->publicUser($user));
        }

        if ($path === '/api/system/host' && $method === 'GET') {
            return Response::json($this->hostResources());
        }

        if ($path === '/api/metrics/history' && $method === 'GET') {
            return $this->metricsHistory($request);
        }
        if ($path === '/api/metrics/sample' && $method === 'POST') {
            return $this->metricsSample($request, $user);
        }

        if ($path === '/api/settings' && $method === 'GET') {
            return Response::json($this->formatSettings());
        }

        if ($path === '/api/settings' && $method === 'PUT') {
            return $this->updateSettings($request, $user);
        }

        if ($path === '/api/backup' && $method === 'GET') {
            return $this->downloadBackup($request, $user);
        }

        if ($path === '/api/users' && $method === 'GET') {
            return $this->listUsers($user);
        }

        if ($path === '/api/users' && $method === 'POST') {
            return $this->createUser($request, $user);
        }

        if (preg_match('#^/api/users/(\d+)/passwd$#', $path, $m) && $method === 'PUT') {
            return $this->changeUserPassword((int) $m[1], $request, $user);
        }

        if (preg_match('#^/api/users/(\d+)$#', $path, $m) && $method === 'DELETE') {
            return $this->deleteUser((int) $m[1], $request, $user);
        }

        if (preg_match('#^/api/users/(\d+)/tokens$#', $path, $m) && $method === 'POST') {
            return $this->createToken((int) $m[1], $request, $user);
        }

        // --- Teams ---
        if ($path === '/api/teams' && $method === 'GET') {
            $detail = strtolower((string) ($request->query('detail') ?? $request->query('expand') ?? ''));
            if (in_array($detail, ['1', 'true', 'yes'], true)) {
                return $this->listTeamsDetailed($user);
            }
            return $this->listTeams($user);
        }
        if ($path === '/api/teams' && $method === 'POST') {
            return $this->createTeam($request, $user);
        }
        if (preg_match('#^/api/teams/(\d+)$#', $path, $m)) {
            $tid = (int) $m[1];
            if ($method === 'GET') {
                return $this->getTeam($tid, $user);
            }
            if ($method === 'PUT') {
                return $this->updateTeam($tid, $request, $user);
            }
            if ($method === 'DELETE') {
                return $this->deleteTeam($tid, $request, $user);
            }
        }
        if (preg_match('#^/api/teams/(\d+)/members$#', $path, $m) && $method === 'POST') {
            return $this->addTeamMember((int) $m[1], $request, $user);
        }
        if (preg_match('#^/api/teams/(\d+)/members/(\d+)$#', $path, $m) && $method === 'DELETE') {
            return $this->removeTeamMember((int) $m[1], (int) $m[2], $request, $user);
        }

        // --- Endpoint ACLs ---
        if ($path === '/api/acls' && $method === 'GET') {
            return $this->listAcls($request, $user);
        }
        if ($path === '/api/acls' && $method === 'POST') {
            return $this->upsertAcl($request, $user);
        }
        if (preg_match('#^/api/acls/(\d+)$#', $path, $m) && $method === 'DELETE') {
            return $this->deleteAcl((int) $m[1], $request, $user);
        }

        // --- Schedules ---
        if ($path === '/api/schedules' && $method === 'GET') {
            return $this->listSchedules($request, $user);
        }
        if ($path === '/api/schedules' && $method === 'POST') {
            return $this->createSchedule($request, $user);
        }
        if ($path === '/api/schedules/run-due' && $method === 'POST') {
            return $this->runDueSchedules($request, $user);
        }
        if (preg_match('#^/api/schedules/(\d+)$#', $path, $m)) {
            $sid = (int) $m[1];
            if ($method === 'GET') {
                return $this->getScheduleApi($sid, $user);
            }
            if ($method === 'PUT') {
                return $this->updateSchedule($sid, $request, $user);
            }
            if ($method === 'DELETE') {
                return $this->deleteSchedule($sid, $request, $user);
            }
        }
        if (preg_match('#^/api/schedules/(\d+)/run$#', $path, $m) && $method === 'POST') {
            return $this->runScheduleNow((int) $m[1], $request, $user);
        }

        // --- Image CVE scans ---
        if (preg_match('#^/api/endpoints/(\d+)/images/scans$#', $path, $m) && $method === 'GET') {
            return $this->listImageScans((int) $m[1], $user);
        }
        if (preg_match('#^/api/endpoints/(\d+)/images/scans/ensure$#', $path, $m) && $method === 'POST') {
            return $this->ensureImageScans((int) $m[1], $request, $user);
        }
        if (preg_match('#^/api/endpoints/(\d+)/images/advise$#', $path, $m) && $method === 'POST') {
            return $this->adviseImages((int) $m[1], $request, $user);
        }
        if (preg_match('#^/api/endpoints/(\d+)/images/scan$#', $path, $m) && $method === 'POST') {
            return $this->scanImage((int) $m[1], $request, $user);
        }
        if (preg_match('#^/api/endpoints/(\d+)/images/scan$#', $path, $m) && $method === 'GET') {
            return $this->getImageScan((int) $m[1], $request, $user);
        }

        if ($path === '/api/endpoints' && $method === 'GET') {
            $eps = $this->endpointAcl->filterEndpoints($user, $this->repo->listEndpoints());
            return Response::json(array_map(function (array $ep) use ($user): array {
                $fmt = $this->formatEndpoint($ep);
                $fmt['AccessRole'] = $this->endpointAcl->roleFor($user, (int) $ep['id']);
                return $fmt;
            }, $eps));
        }

        if ($path === '/api/endpoints' && $method === 'POST') {
            return Response::error('Utilisez /api/nodes/join pour enrôler un nœud agent', 400);
        }

        if (preg_match('#^/api/endpoints/(\d+)$#', $path, $m) && $method === 'GET') {
            $ep = $this->repo->getEndpoint((int) $m[1]);
            if (!$ep) {
                return Response::error('Environnement introuvable', 404);
            }
            if (!$this->endpointAcl->can($user, (int) $ep['id'], EndpointAcl::READ)) {
                return Response::error('Accès refusé à ce nœud', 403);
            }
            $fmt = $this->formatEndpoint($ep);
            $fmt['AccessRole'] = $this->endpointAcl->roleFor($user, (int) $ep['id']);
            return Response::json($fmt);
        }

        // Portainer CE: update endpoint access policies
        if (preg_match('#^/api/endpoints/(\d+)$#', $path, $m) && $method === 'PUT') {
            return $this->updateEndpointPortainer((int) $m[1], $request, $user);
        }

        // Portainer CE team memberships
        if ($path === '/api/team_memberships' && $method === 'GET') {
            return $this->listTeamMembershipsPortainer($user);
        }
        if ($path === '/api/team_memberships' && $method === 'POST') {
            return $this->createTeamMembershipPortainer($request, $user);
        }
        if (preg_match('#^/api/team_memberships/(\d+)$#', $path, $m) && $method === 'DELETE') {
            return $this->deleteTeamMembershipPortainer((int) $m[1], $request, $user);
        }
        if (preg_match('#^/api/teams/(\d+)/memberships$#', $path, $m) && $method === 'GET') {
            return $this->listTeamMembershipsForTeam((int) $m[1], $user);
        }

        // Portainer CE: GET single user
        if (preg_match('#^/api/users/(\d+)$#', $path, $m) && $method === 'GET') {
            return $this->getUserPortainer((int) $m[1], $user);
        }

        // --- Multinode / agents (admin) ---
        if ($path === '/api/nodes' && $method === 'GET') {
            return $this->listNodes($user);
        }
        if ($path === '/api/nodes/join-token' && $method === 'GET') {
            return $this->getJoinTokenMeta($user);
        }
        if ($path === '/api/nodes/join-token' && $method === 'POST') {
            return $this->createJoinToken($request, $user);
        }
        if ($path === '/api/nodes/join-token/rotate' && $method === 'POST') {
            return $this->rotateJoinToken($request, $user);
        }
        if ($path === '/api/nodes/agent-bundle' && ($method === 'GET' || $method === 'POST')) {
            return $this->downloadAgentBundle($request, $user);
        }
        if (preg_match('#^/api/nodes/(\d+)/disable$#', $path, $m) && $method === 'POST') {
            return $this->setNodeEnabled((int) $m[1], false, $request, $user);
        }
        if (preg_match('#^/api/nodes/(\d+)/enable$#', $path, $m) && $method === 'POST') {
            return $this->setNodeEnabled((int) $m[1], true, $request, $user);
        }
        if (preg_match('#^/api/nodes/(\d+)/ping$#', $path, $m) && $method === 'POST') {
            return $this->pingNode((int) $m[1], $user);
        }
        if (preg_match('#^/api/nodes/(\d+)$#', $path, $m) && $method === 'PUT') {
            return $this->updateNode((int) $m[1], $request, $user);
        }
        if (preg_match('#^/api/nodes/(\d+)$#', $path, $m) && $method === 'DELETE') {
            return $this->unlinkNode((int) $m[1], $request, $user);
        }

        if (preg_match('#^/api/endpoints/(\d+)/docker(/.*)?$#', $path, $m)) {
            return $this->proxyDocker((int) $m[1], $m[2] ?? '/', $request, $user);
        }

        if (preg_match('#^/api/endpoints/(\d+)/containers$#', $path, $m) && $method === 'GET') {
            return $this->proxyDocker((int) $m[1], '/containers/json', $request, $user);
        }

        if (preg_match('#^/api/endpoints/(\d+)/containers/updates$#', $path, $m) && $method === 'GET') {
            return $this->listContainerImageUpdates((int) $m[1], $request, $user);
        }

        if (preg_match('#^/api/endpoints/(\d+)/containers/([^/]+)/updates$#', $path, $m) && $method === 'GET') {
            return $this->getContainerImageUpdate((int) $m[1], $m[2], $request, $user);
        }

        if (preg_match('#^/api/endpoints/(\d+)/containers/([^/]+)/update$#', $path, $m) && $method === 'POST') {
            return $this->updateContainerImage((int) $m[1], $m[2], $request, $user);
        }

        // Clean logs (demuxed) — handy for UI
        if (preg_match('#^/api/endpoints/(\d+)/containers/([^/]+)/logs$#', $path, $m) && $method === 'GET') {
            return $this->containerLogs((int) $m[1], $m[2], $request, $user);
        }

        // One-shot exec for console UI
        if (preg_match('#^/api/endpoints/(\d+)/containers/([^/]+)/exec$#', $path, $m) && $method === 'POST') {
            return $this->containerExec((int) $m[1], $m[2], $request, $user);
        }

        if (preg_match('#^/api/endpoints/(\d+)/bind-volumes$#', $path, $m) && $method === 'GET') {
            return $this->listBindVolumes((int) $m[1], $request, $user);
        }
        if (preg_match('#^/api/endpoints/(\d+)/bind-volumes$#', $path, $m) && $method === 'POST') {
            return $this->createBindVolume((int) $m[1], $request, $user);
        }
        if (preg_match('#^/api/endpoints/(\d+)/bind-volumes/(\d+)$#', $path, $m) && $method === 'DELETE') {
            return $this->deleteBindVolume((int) $m[1], (int) $m[2], $request, $user);
        }

        // Volume explorer (scoped to endpoint / remote agent)
        if (preg_match('#^/api/endpoints/(\d+)/volumes/([^/]+)/browse$#', $path, $m) && $method === 'GET') {
            return $this->browseVolume((int) $m[1], rawurldecode($m[2]), $request, $user);
        }
        if (preg_match('#^/api/endpoints/(\d+)/volumes/([^/]+)/file$#', $path, $m) && $method === 'GET') {
            return $this->readVolumeFile((int) $m[1], rawurldecode($m[2]), $request, $user);
        }
        if (preg_match('#^/api/endpoints/(\d+)/volumes/([^/]+)/file$#', $path, $m) && $method === 'POST') {
            return $this->writeVolumeFile((int) $m[1], rawurldecode($m[2]), $request, $user);
        }
        if (preg_match('#^/api/endpoints/(\d+)/volumes/([^/]+)/upload$#', $path, $m) && $method === 'POST') {
            return $this->uploadVolumeFile((int) $m[1], rawurldecode($m[2]), $request, $user);
        }
        if (preg_match('#^/api/endpoints/(\d+)/volumes/([^/]+)/mkdir$#', $path, $m) && $method === 'POST') {
            return $this->mkdirVolumePath((int) $m[1], rawurldecode($m[2]), $request, $user);
        }
        if (preg_match('#^/api/endpoints/(\d+)/volumes/([^/]+)/rename$#', $path, $m) && $method === 'POST') {
            return $this->renameVolumePath((int) $m[1], rawurldecode($m[2]), $request, $user);
        }
        if (preg_match('#^/api/endpoints/(\d+)/volumes/([^/]+)/entry$#', $path, $m) && $method === 'DELETE') {
            return $this->deleteVolumeEntry((int) $m[1], rawurldecode($m[2]), $request, $user);
        }
        if (preg_match('#^/api/endpoints/(\d+)/volumes/([^/]+)/download$#', $path, $m) && $method === 'GET') {
            return $this->downloadVolumeFile((int) $m[1], rawurldecode($m[2]), $request, $user);
        }

        if ($path === '/api/images/search' && $method === 'GET') {
            return $this->searchImages($request);
        }
        if ($path === '/api/images/tags' && $method === 'GET') {
            return $this->searchImageTags($request);
        }
        if ($path === '/api/images/build' && $method === 'POST') {
            return $this->buildImage($request, $user);
        }
        if ($path === '/api/dockerfiles' && $method === 'GET') {
            return Response::json($this->imageBuilder->listDockerfiles());
        }
        if ($path === '/api/dockerfiles' && $method === 'POST') {
            return $this->saveDockerfile($request);
        }
        if (preg_match('#^/api/dockerfiles/([^/]+)$#', $path, $m) && $method === 'GET') {
            try {
                return Response::json([
                    'Name' => rawurldecode($m[1]),
                    'Content' => $this->imageBuilder->readDockerfile(rawurldecode($m[1])),
                ]);
            } catch (\Throwable $e) {
                $code = (int) $e->getCode();
                return Response::error($e->getMessage(), $code >= 400 ? $code : 404);
            }
        }
        if (preg_match('#^/api/dockerfiles/([^/]+)$#', $path, $m) && $method === 'DELETE') {
            try {
                $this->imageBuilder->deleteDockerfile(rawurldecode($m[1]));
                return Response::empty(204);
            } catch (\Throwable $e) {
                return Response::error($e->getMessage(), 400);
            }
        }

        // Legacy volume routes → nœud local (endpointId=1) unless ?endpointId=
        if (preg_match('#^/api/volumes/([^/]+)/browse$#', $path, $m) && $method === 'GET') {
            return $this->browseVolume($this->endpointIdFromRequest($request), rawurldecode($m[1]), $request, $user);
        }
        if (preg_match('#^/api/volumes/([^/]+)/file$#', $path, $m) && $method === 'GET') {
            return $this->readVolumeFile($this->endpointIdFromRequest($request), rawurldecode($m[1]), $request, $user);
        }
        if (preg_match('#^/api/volumes/([^/]+)/file$#', $path, $m) && $method === 'POST') {
            return $this->writeVolumeFile($this->endpointIdFromRequest($request), rawurldecode($m[1]), $request, $user);
        }
        if (preg_match('#^/api/volumes/([^/]+)/upload$#', $path, $m) && $method === 'POST') {
            return $this->uploadVolumeFile($this->endpointIdFromRequest($request), rawurldecode($m[1]), $request, $user);
        }
        if (preg_match('#^/api/volumes/([^/]+)/mkdir$#', $path, $m) && $method === 'POST') {
            return $this->mkdirVolumePath($this->endpointIdFromRequest($request), rawurldecode($m[1]), $request, $user);
        }
        if (preg_match('#^/api/volumes/([^/]+)/rename$#', $path, $m) && $method === 'POST') {
            return $this->renameVolumePath($this->endpointIdFromRequest($request), rawurldecode($m[1]), $request, $user);
        }
        if (preg_match('#^/api/volumes/([^/]+)/entry$#', $path, $m) && $method === 'DELETE') {
            return $this->deleteVolumeEntry($this->endpointIdFromRequest($request), rawurldecode($m[1]), $request, $user);
        }
        if (preg_match('#^/api/volumes/([^/]+)/download$#', $path, $m) && $method === 'GET') {
            return $this->downloadVolumeFile($this->endpointIdFromRequest($request), rawurldecode($m[1]), $request, $user);
        }

        if ($path === '/api/registries' && $method === 'GET') {
            $rows = $this->repo->listRegistriesForUser(
                Ownership::userId($user),
                Ownership::isAdmin($user),
            );
            return Response::json(array_map([$this, 'formatRegistry'], $rows));
        }
        if ($path === '/api/registries' && $method === 'POST') {
            return $this->createRegistry($request, $user);
        }
        if (preg_match('#^/api/registries/(\d+)$#', $path, $m)) {
            $id = (int) $m[1];
            if ($method === 'GET') {
                $row = $this->repo->getRegistry($id);
                if (!$row || !$this->canAccessRegistry($row, $user)) {
                    return Response::error('Registre introuvable', 404);
                }
                return Response::json($this->formatRegistry($row));
            }
            if ($method === 'PUT') {
                return $this->updateRegistry($id, $request, $user);
            }
            if ($method === 'DELETE') {
                $row = $this->repo->getRegistry($id);
                if (!$row || !$this->canManageRegistry($row, $user)) {
                    return Response::error('Registre introuvable ou accès refusé', 404);
                }
                $this->repo->deleteRegistry($id);
                return Response::empty(204);
            }
        }
        if (preg_match('#^/api/registries/(\d+)/ping$#', $path, $m) && $method === 'GET') {
            return $this->pingRegistry((int) $m[1], $user);
        }
        if (preg_match('#^/api/registries/(\d+)/repositories$#', $path, $m) && $method === 'GET') {
            return $this->browseRegistryRepos((int) $m[1], $request, $user);
        }
        if (preg_match('#^/api/registries/(\d+)/tags$#', $path, $m) && $method === 'GET') {
            $repo = (string) ($request->query('repo') ?? $request->query('repository') ?? '');
            return $this->browseRegistryTags((int) $m[1], $repo, $user);
        }
        if (preg_match('#^/api/registries/(\d+)/pull$#', $path, $m) && $method === 'POST') {
            return $this->pullFromRegistry((int) $m[1], $request, $user);
        }

        if ($path === '/api/stacks' && $method === 'GET') {
            return $this->listStacks($request, $user);
        }

        if ($path === '/api/stacks/updates' && $method === 'GET') {
            return $this->listStackImageUpdates($request, $user);
        }

        if (preg_match('#^/api/stacks/(\d+)/updates$#', $path, $m) && $method === 'GET') {
            return $this->getStackImageUpdates((int) $m[1], $request, $user);
        }

        if ($path === '/api/stacks/create/standalone/string' && $method === 'POST') {
            return $this->createStack($request, $user);
        }

        if ($path === '/api/stacks' && $method === 'POST') {
            $type = (int) ($request->query('type') ?? 2);
            $methodParam = $request->query('method') ?? 'string';
            if ($type === 2 && $methodParam === 'string') {
                return $this->createStack($request, $user);
            }
            return Response::error('Méthode de création de stack non prise en charge', 400);
        }

        if (preg_match('#^/api/stacks/(\d+)/file$#', $path, $m) && $method === 'GET') {
            return $this->getStackFile((int) $m[1], $user);
        }

        if (preg_match('#^/api/stacks/(\d+)/(start|stop|restart)$#', $path, $m) && $method === 'POST') {
            return $this->controlStack((int) $m[1], (string) $m[2], $request, $user);
        }

        if (preg_match('#^/api/stacks/(\d+)$#', $path, $m)) {
            $id = (int) $m[1];
            if ($method === 'GET') {
                return $this->getStack($id, $user);
            }
            if ($method === 'PUT') {
                return $this->updateStack($id, $request, $user);
            }
            if ($method === 'DELETE') {
                return $this->deleteStack($id, $request, $user);
            }
        }

        return Response::error('Introuvable', 404);
    }

    /** @return array<string, mixed>|Response */
    private function authenticateRequest(Request $request): array|Response
    {
        $apiKey = $request->header('X-API-Key') ?? $request->header('X-Api-Key');
        if ($apiKey) {
            if (!preg_match('/^ptr_[a-f0-9]{48}$/', $apiKey)) {
                return Response::error('Clé API invalide', 401);
            }
            $row = $this->repo->findApiKeyByRaw($apiKey);
            if (!$row) {
                return Response::error('Clé API invalide', 401);
            }
            $dbUser = $this->repo->findUserById((int) $row['user_id']);
            return [
                'id' => (int) $row['user_id'],
                'username' => (string) $row['username'],
                'role' => (int) $row['role'],
                'auth_source' => (string) ($dbUser['auth_source'] ?? 'local'),
            ];
        }

        $auth = $request->header('Authorization');
        if (!$auth || !preg_match('/^Bearer\s+(\S+)$/i', $auth, $m)) {
            return Response::error('Non autorisé', 401);
        }
        $claims = $this->jwt->decode($m[1]);
        if (!$claims || !isset($claims['id'])) {
            return Response::error('Jeton JWT invalide', 401);
        }
        // Always reload role/username from DB (token alone is not authoritative).
        $dbUser = $this->repo->findUserById((int) $claims['id']);
        if (!$dbUser) {
            return Response::error('Jeton JWT invalide', 401);
        }
        return [
            'id' => (int) $dbUser['id'],
            'username' => (string) $dbUser['username'],
            'role' => (int) $dbUser['role'],
            'auth_source' => (string) ($dbUser['auth_source'] ?? 'local'),
        ];
    }

    private function clientIp(Request $request): string
    {
        $xff = $request->header('X-Forwarded-For');
        if ($xff) {
            $first = trim(explode(',', $xff)[0]);
            if (filter_var($first, FILTER_VALIDATE_IP)) {
                return $first;
            }
        }
        $ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
        return is_string($ip) ? $ip : '0.0.0.0';
    }

    private function adminInit(Request $request): Response
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

    private function authenticate(Request $request): Response
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
    private function tryAuthenticateUser(string $username, string $password, Request $request): ?array
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
    private function createToken(int $userId, Request $request, array $user): Response
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
    private function proxyDocker(int $endpointId, string $dockerPath, Request $request, array $user): Response
    {
        $ep = $this->repo->getEndpoint($endpointId);
        if (!$ep) {
            return Response::error('Environnement introuvable', 404);
        }
        if ($deny = $this->assertEndpointUsable($ep)) {
            return $deny;
        }
        $role = $this->endpointAcl->roleFor($user, $endpointId);
        if ($role === EndpointAcl::NONE) {
            return Response::error('Accès refusé à ce nœud', 403);
        }
        $min = in_array(strtoupper($request->method), ['GET', 'HEAD'], true)
            ? EndpointAcl::READ
            : EndpointAcl::OPERATE;
        if (!$this->endpointAcl->can($user, $endpointId, $min)) {
            return Response::error('Permissions insuffisantes sur ce nœud', 403);
        }

        $dockerPath = $dockerPath === '' ? '/' : $dockerPath;
        $forwardHeaders = [];
        $contentType = $request->header('Content-Type');
        if ($contentType) {
            $forwardHeaders['Content-Type'] = $contentType;
        }

        $scopedUser = $this->endpointAcl->withEndpointContext($user, $role);
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
    private function requireEndpointAccess(int $endpointId, array $user, string $minRole): array
    {
        $ep = $this->repo->getEndpoint($endpointId);
        if (!$ep) {
            return [null, Response::error('Environnement introuvable', 404)];
        }
        if ($deny = $this->assertEndpointUsable($ep)) {
            return [null, $deny];
        }
        if (!$this->endpointAcl->can($user, $endpointId, $minRole)) {
            return [null, Response::error('Accès refusé à ce nœud', 403)];
        }
        return [$ep, null];
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function listContainerImageUpdates(int $endpointId, Request $request, array $user): Response
    {
        [$ep, $deny] = $this->requireEndpointAccess($endpointId, $user, EndpointAcl::READ);
        if ($deny) {
            return $deny;
        }
        $role = $this->endpointAcl->roleFor($user, $endpointId);
        $scopedUser = $this->endpointAcl->withEndpointContext($user, $role);
        $docker = $this->dockerForEndpoint($ep);
        $scope = $this->scopeForEndpoint($ep);
        $force = $this->wantsStackUpdateRefresh($request);
        try {
            $all = $docker->json('GET', '/containers/json', null, ['all' => 'true']);
            if (!is_array($all)) {
                $all = [];
            }
            $filtered = [];
            foreach ($all as $c) {
                if (!is_array($c)) {
                    continue;
                }
                $cid = (string) ($c['Id'] ?? '');
                if ($cid === '' || !$scope->canAccessContainer($cid, $scopedUser)) {
                    continue;
                }
                $filtered[] = $c;
            }
            $updates = $this->imageUpdates->checkContainers(
                $filtered,
                $docker,
                $this->registriesWithPasswordsForUser($user),
                $force,
            );
            return Response::json([
                'Updates' => $updates,
                'CacheTtl' => ImageUpdateChecker::STACK_CACHE_TTL,
                'Forced' => $force,
            ]);
        } catch (\Throwable $e) {
            return Response::error($e->getMessage(), 502);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function getContainerImageUpdate(int $endpointId, string $containerId, Request $request, array $user): Response
    {
        [$ep, $deny] = $this->requireEndpointAccess($endpointId, $user, EndpointAcl::READ);
        if ($deny) {
            return $deny;
        }
        $role = $this->endpointAcl->roleFor($user, $endpointId);
        $scopedUser = $this->endpointAcl->withEndpointContext($user, $role);
        $scope = $this->scopeForEndpoint($ep);
        if (!$scope->canAccessContainer($containerId, $scopedUser)) {
            return Response::error('Accès refusé à ce conteneur', 403);
        }
        $force = $this->wantsStackUpdateRefresh($request);
        try {
            $docker = $this->dockerForEndpoint($ep);
            $info = $docker->json('GET', '/containers/' . rawurlencode($containerId) . '/json');
            $image = trim((string) ($info['Config']['Image'] ?? ''));
            $name = ltrim((string) ($info['Name'] ?? ''), '/');
            $item = $this->imageUpdates->checkImageRef(
                $image,
                $docker,
                $this->registriesWithPasswordsForUser($user),
                $force,
                $name !== '' ? $name : 'container',
            );
            return Response::json([
                'Status' => $item['Status'],
                'UpdateCount' => $item['Status'] === 'update' ? 1 : 0,
                'Checked' => in_array($item['Status'], ['update', 'fresh', 'pinned'], true) ? 1 : 0,
                'Image' => $item['Image'],
                'Detail' => $item['Detail'],
                'LocalDigest' => $item['LocalDigest'],
                'RemoteDigest' => $item['RemoteDigest'],
                'Images' => [$item],
            ]);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 502);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function updateContainerImage(int $endpointId, string $containerId, Request $request, array $user): Response
    {
        [$ep, $deny] = $this->requireEndpointAccess($endpointId, $user, EndpointAcl::OPERATE);
        if ($deny) {
            return $deny;
        }
        $role = $this->endpointAcl->roleFor($user, $endpointId);
        $scopedUser = $this->endpointAcl->withEndpointContext($user, $role);
        $scope = $this->scopeForEndpoint($ep);
        if (!$scope->canAccessContainer($containerId, $scopedUser)) {
            return Response::error('Accès refusé à ce conteneur', 403);
        }
        $body = $request->json();
        $pull = !array_key_exists('Pull', $body) || !empty($body['Pull']) || !empty($body['PullImage']);
        try {
            $docker = $this->dockerForEndpoint($ep);
            $info = $docker->json('GET', '/containers/' . rawurlencode($containerId) . '/json');
            $image = trim((string) ($info['Config']['Image'] ?? ''));
            $creds = $image !== ''
                ? $this->imageUpdates->registryCredsForImage($image, $this->registriesWithPasswordsForUser($user))
                : [];
            $result = (new ContainerRecreate($docker))->upgrade($containerId, $pull, $creds);
            $this->audit(
                $user,
                'container.update_image',
                'Mise à jour image « ' . $result['Name'] . ' » (' . $result['Image'] . ')',
                $request,
                [
                    'endpointId' => $endpointId,
                    'previousId' => $result['PreviousId'],
                    'newId' => $result['Id'],
                    'pulled' => $result['Pulled'],
                ],
            );
            return Response::json($result);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 502);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function containerLogs(int $endpointId, string $containerId, Request $request, array $user): Response
    {
        [$ep, $deny] = $this->requireEndpointAccess($endpointId, $user, EndpointAcl::READ);
        if ($deny) {
            return $deny;
        }
        $role = $this->endpointAcl->roleFor($user, $endpointId);
        $scopedUser = $this->endpointAcl->withEndpointContext($user, $role);
        $scope = $this->scopeForEndpoint($ep);
        if (!$scope->canAccessContainer($containerId, $scopedUser)) {
            return Response::error('Accès refusé à ce conteneur', 403);
        }

        $tailRaw = (string) ($request->query('tail') ?? '200');
        $tail = strtolower($tailRaw) === 'all' ? 'all' : max(0, min(5000, (int) $tailRaw));
        $timestamps = ($request->query('timestamps') ?? 'true') !== 'false';
        $stdout = ($request->query('stdout') ?? 'true') !== 'false';
        $stderr = ($request->query('stderr') ?? 'true') !== 'false';
        $annotate = ($request->query('annotate') ?? 'true') !== 'false';
        $sinceRaw = $request->query('since');
        $since = ($sinceRaw !== null && $sinceRaw !== '' && (int) $sinceRaw > 0) ? (int) $sinceRaw : null;

        try {
            $exec = new \App\Docker\Exec($this->dockerForEndpoint($ep));
            $text = $exec->logs($containerId, [
                'tail' => $tail,
                'timestamps' => $timestamps,
                'stdout' => $stdout,
                'stderr' => $stderr,
                'since' => $since,
                'annotate' => $annotate,
            ]);
        } catch (\Throwable $e) {
            $status = $e->getCode() >= 400 && $e->getCode() < 600 ? (int) $e->getCode() : 500;
            return Response::error($e->getMessage(), $status);
        }
        $this->repo->updateEndpointLastSeen((int) $ep['id'], 1);
        return Response::text($text, 200, ['Content-Type' => 'text/plain; charset=utf-8']);
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function containerExec(int $endpointId, string $containerId, Request $request, array $user): Response
    {
        [$ep, $deny] = $this->requireEndpointAccess($endpointId, $user, EndpointAcl::OPERATE);
        if ($deny) {
            return $deny;
        }
        $role = $this->endpointAcl->roleFor($user, $endpointId);
        $scopedUser = $this->endpointAcl->withEndpointContext($user, $role);
        $scope = $this->scopeForEndpoint($ep);
        if (!$scope->canAccessContainer($containerId, $scopedUser)) {
            return Response::error('Accès refusé à ce conteneur', 403);
        }
        $docker = $this->dockerForEndpoint($ep);
        $body = $request->json();
        $command = trim((string) ($body['command'] ?? $body['Command'] ?? ''));
        $userShell = (string) ($body['shell'] ?? '/bin/sh');
        if ($command === '') {
            return Response::error('La commande est requise', 400);
        }
        if (strlen($command) > 4000) {
            return Response::error('Commande trop longue', 400);
        }
        if (!in_array($userShell, ['/bin/sh', '/bin/bash', '/bin/ash', 'sh', 'bash', 'ash'], true)) {
            return Response::error('Shell non autorisé', 400);
        }
        $cwd = trim((string) ($body['cwd'] ?? ''));
        if ($cwd !== '' && (str_contains($cwd, "\0") || strlen($cwd) > 512)) {
            return Response::error('Répertoire de travail invalide', 400);
        }
        $cols = max(40, min(250, (int) ($body['cols'] ?? $body['Cols'] ?? 120)));
        $rows = max(8, min(100, (int) ($body['rows'] ?? $body['Rows'] ?? 40)));
        // TTY so tools like `ls` use columns + colors (like a real shell)
        $tty = !array_key_exists('tty', $body) || !empty($body['tty']);
        $env = [
            'TERM=xterm-256color',
            'COLORTERM=truecolor',
            'COLUMNS=' . $cols,
            'LINES=' . $rows,
            'FORCE_COLOR=1',
            'CLICOLOR=1',
            'CLICOLOR_FORCE=1',
        ];
        $script = $cwd !== '' ? 'cd ' . escapeshellarg($cwd) . ' && ' . $command : $command;
        $cmd = [$userShell, '-lc', $script];
        try {
            $exec = new \App\Docker\Exec($docker);
            $result = $exec->run($containerId, $cmd, $tty, 60, $env);
        } catch (\Throwable $e) {
            // Retry with /bin/sh if bash missing
            if ($userShell !== '/bin/sh') {
                try {
                    $exec = new \App\Docker\Exec($docker);
                    $result = $exec->run($containerId, ['/bin/sh', '-lc', $script], $tty, 60, $env);
                } catch (\Throwable $e2) {
                    $status = $e2->getCode() >= 400 && $e2->getCode() < 600 ? (int) $e2->getCode() : 500;
                    return Response::error($e2->getMessage(), $status);
                }
            } else {
                $status = $e->getCode() >= 400 && $e->getCode() < 600 ? (int) $e->getCode() : 500;
                return Response::error($e->getMessage(), $status);
            }
        }
        return Response::json($result);
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function listStacks(Request $request, array $user): Response
    {
        $endpointId = $request->query('endpointId');
        // endpointId 0 / absent = tous les nœuds (vue agrégée)
        $filter = null;
        if ($endpointId !== null && (int) $endpointId > 0) {
            $filter = (int) $endpointId;
            if (!$this->endpointAcl->can($user, $filter, EndpointAcl::READ)) {
                return Response::error('Accès refusé à ce nœud', 403);
            }
        }
        $isEpAdmin = $filter !== null && $this->endpointAcl->can($user, $filter, EndpointAcl::ADMIN);
        $rows = $this->repo->listStacksForUser(
            Ownership::username($user),
            Ownership::isGlobalAdmin($user) || $isEpAdmin,
            $filter,
        );
        if ($filter === null && !Ownership::isGlobalAdmin($user)) {
            $rows = array_values(array_filter($rows, function (array $s) use ($user): bool {
                $eid = (int) ($s['endpoint_id'] ?? 0);
                if (!$this->endpointAcl->can($user, $eid, EndpointAcl::READ)) {
                    return false;
                }
                if ($this->endpointAcl->can($user, $eid, EndpointAcl::ADMIN)) {
                    return true;
                }
                return strcasecmp((string) ($s['created_by'] ?? ''), Ownership::username($user)) === 0;
            }));
        }
        return Response::json(array_map([$this, 'formatStack'], $rows));
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function listStackImageUpdates(Request $request, array $user): Response
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
        );
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
    private function getStackImageUpdates(int $id, Request $request, array $user): Response
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

    private function wantsStackUpdateRefresh(Request $request): bool
    {
        $q = strtolower((string) ($request->query('refresh') ?? $request->query('force') ?? ''));
        return in_array($q, ['1', 'true', 'yes'], true);
    }

    /**
     * Registries with decrypted passwords for digest probes.
     * @param array{id:int,username:string,role:int} $user
     * @return list<array<string, mixed>>
     */
    private function registriesWithPasswordsForUser(array $user): array
    {
        $rows = $this->repo->listRegistriesForUser(
            Ownership::userId($user),
            Ownership::isAdmin($user),
        );
        $out = [];
        foreach ($rows as $row) {
            $full = $this->repo->getRegistry((int) $row['id']);
            if ($full) {
                $out[] = $full;
            }
        }
        return $out;
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function getStack(int $id, array $user): Response
    {
        $stack = $this->repo->getStack($id);
        if (!$stack || !$this->canAccessStack($stack, $user)) {
            return Response::error('Stack introuvable', 404);
        }
        return Response::json($this->formatStack($stack));
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function getStackFile(int $id, array $user): Response
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

    /** @param array<string, mixed> $user */
    private function createStack(Request $request, array $user): Response
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
    private function updateStack(int $id, Request $request, array $user): Response
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
    private function deleteStack(int $id, Request $request, array $user): Response
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
    private function controlStack(int $id, string $action, Request $request, array $user): Response
    {
        $stack = $this->repo->getStack($id);
        if (!$stack || !$this->canAccessStack($stack, $user)) {
            return Response::error('Stack introuvable', 404);
        }
        if (!$this->canOperateStack($stack, $user)) {
            return Response::error('Permissions insuffisantes (lecture seule)', 403);
        }
        if (!in_array($action, ['start', 'stop', 'restart'], true)) {
            return Response::error('Action invalide', 400);
        }
        $ep = $this->repo->getEndpoint((int) $stack['endpoint_id']);
        if (!$ep) {
            return Response::error('Environnement introuvable', 404);
        }
        $env = json_decode($stack['env_json'], true);
        if (!is_array($env)) {
            $env = [];
        }
        $name = (string) $stack['name'];
        $entry = (string) ($stack['entry_point'] ?? 'docker-compose.yml');
        $isAgent = ($ep['kind'] ?? 'local') === 'agent';
        try {
            if ($isAgent) {
                $client = $this->agentComposeClient($ep);
                match ($action) {
                    'start' => $client->start($name, $env, $entry),
                    'stop' => $client->stop($name, $env, $entry),
                    default => $client->restart($name, $env, $entry),
                };
            } else {
                match ($action) {
                    'start' => $this->compose->start($stack['project_path'], $name, $env),
                    'stop' => $this->compose->stop($stack['project_path'], $name, $env),
                    default => $this->compose->restart($stack['project_path'], $name, $env),
                };
            }
            $status = $action === 'stop' ? 2 : 1;
            $row = $this->repo->setStackStatus($id, $status);
        } catch (\Throwable $e) {
            return Response::error($e->getMessage(), 500);
        }
        $labels = ['start' => 'Démarrage', 'stop' => 'Arrêt', 'restart' => 'Redémarrage'];
        $this->audit(
            $user,
            'stack.' . $action,
            ($labels[$action] ?? $action) . ' de la stack « ' . $name . ' »',
            $request,
            ['stackId' => $id, 'name' => $name],
        );
        return Response::json($this->formatStack($row ?? $stack));
    }

    /** @param array<string, mixed> $ep */
    private function agentComposeClient(array $ep): AgentComposeClient
    {
        $url = trim((string) ($ep['agent_url'] ?? ''));
        $secret = trim((string) ($ep['agent_secret'] ?? ''));
        if ($url === '' || $secret === '') {
            throw new \RuntimeException('Agent non configuré (URL ou secret manquant)');
        }
        $fp = (string) ($ep['tls_fingerprint'] ?? '');
        return new AgentComposeClient($url, $secret, $fp);
    }

    /** @param array<string, mixed> $user */
    private function requireAdmin(array $user): ?Response
    {
        if ((int) ($user['role'] ?? 0) !== 1) {
            return Response::error('Accès administrateur requis', 403);
        }
        return null;
    }

    private function endpointIdFromRequest(Request $request): int
    {
        $raw = $request->query('endpointId');
        $id = $raw !== null && $raw !== '' ? (int) $raw : 1;
        return $id > 0 ? $id : 1;
    }

    /**
     * @param array{id:int,username:string,role:int} $user
     * @return array{0:?VolumeBrowser,1:?Response}
     */
    private function volumeBrowserForEndpoint(int $endpointId, string $name, array $user, string $minRole = EndpointAcl::READ): array
    {
        [$ep, $deny] = $this->requireEndpointAccess($endpointId, $user, $minRole);
        if ($deny) {
            return [null, $deny];
        }
        $role = $this->endpointAcl->roleFor($user, $endpointId);
        $scopedUser = $this->endpointAcl->withEndpointContext($user, $role);
        $docker = $this->dockerForEndpoint($ep);
        $bind = $this->repo->getBindVolumeByName($endpointId, $name);
        if ($bind) {
            $hostPath = (string) ($bind['host_path'] ?? '');
            return [new VolumeBrowser($docker, $hostPath), null];
        }
        $scope = new DockerScope($docker, $this->repo);
        if (!$scope->canAccessVolume($name, $scopedUser)) {
            return [null, Response::error('Volume introuvable ou accès refusé', 404)];
        }
        return [new VolumeBrowser($docker), null];
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function listBindVolumes(int $endpointId, Request $request, array $user): Response
    {
        [$ep, $deny] = $this->requireEndpointAccess($endpointId, $user, EndpointAcl::READ);
        if ($deny) {
            return $deny;
        }
        unset($ep);
        // Refresh stack-sourced binds so compose bind mounts appear in Volumes
        $this->syncBindVolumesFromEndpointStacks($endpointId);
        $rows = $this->repo->listBindVolumes($endpointId);
        return Response::json([
            'Volumes' => array_map([$this, 'formatBindVolume'], $rows),
        ]);
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function createBindVolume(int $endpointId, Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        [$ep, $deny] = $this->requireEndpointAccess($endpointId, $user, EndpointAcl::ADMIN);
        if ($deny) {
            return $deny;
        }
        unset($ep);
        $body = $request->json();
        $name = trim((string) ($body['Name'] ?? $body['name'] ?? ''));
        $hostPath = trim((string) ($body['HostPath'] ?? $body['hostPath'] ?? $body['Path'] ?? ''));
        if ($name === '' || !preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/', $name)) {
            return Response::error('Nom invalide (lettres, chiffres, _ . -)', 400);
        }
        if ($hostPath === '' || !str_starts_with($hostPath, '/') || str_contains($hostPath, "\0")) {
            return Response::error('Chemin hôte absolu requis (ex. /data/app)', 400);
        }
        $hostPath = rtrim(str_replace('\\', '/', $hostPath), '/') ?: '/';
        if ($this->repo->getBindVolumeByName($endpointId, $name)) {
            return Response::error('Un volume bind portant ce nom existe déjà', 409);
        }
        $row = $this->repo->upsertBindVolume(
            $endpointId,
            $name,
            $hostPath,
            'manual',
            null,
            '',
            Ownership::username($user),
        );
        $this->audit($user, 'bind_volume.create', 'Déclaration du bind « ' . $name . ' » → ' . $hostPath, $request, [
            'endpointId' => $endpointId,
            'name' => $name,
            'hostPath' => $hostPath,
        ]);
        return Response::json($this->formatBindVolume($row), 201);
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function deleteBindVolume(int $endpointId, int $id, Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        [$ep, $deny] = $this->requireEndpointAccess($endpointId, $user, EndpointAcl::ADMIN);
        if ($deny) {
            return $deny;
        }
        unset($ep);
        $row = $this->repo->getBindVolume($id);
        if (!$row || (int) ($row['endpoint_id'] ?? 0) !== $endpointId) {
            return Response::error('Bind introuvable', 404);
        }
        $this->repo->deleteBindVolume($id);
        $this->audit($user, 'bind_volume.delete', 'Suppression de la déclaration bind « ' . ($row['name'] ?? '') . ' »', $request, [
            'endpointId' => $endpointId,
            'name' => (string) ($row['name'] ?? ''),
            'hostPath' => (string) ($row['host_path'] ?? ''),
        ]);
        return Response::empty(204);
    }

    /** @param array<string, mixed> $row */
    private function formatBindVolume(array $row): array
    {
        return [
            'Id' => (int) ($row['id'] ?? 0),
            'Name' => (string) ($row['name'] ?? ''),
            'Driver' => 'bind',
            'Mountpoint' => (string) ($row['host_path'] ?? ''),
            'HostPath' => (string) ($row['host_path'] ?? ''),
            'Source' => (string) ($row['source'] ?? 'manual'),
            'StackId' => isset($row['stack_id']) && $row['stack_id'] !== null ? (int) $row['stack_id'] : null,
            'StackName' => (string) ($row['stack_name'] ?? ''),
            'CreatedBy' => (string) ($row['created_by'] ?? ''),
            'CreatedAt' => (int) ($row['created_at'] ?? 0),
            'Labels' => [
                'wharfmaster.bind' => '1',
                'wharfmaster.bind.source' => (string) ($row['source'] ?? 'manual'),
            ],
            'Scope' => 'local',
            'Options' => null,
            'UsageData' => null,
            '_bind' => true,
        ];
    }

    private function syncBindVolumesFromEndpointStacks(int $endpointId): void
    {
        $stacks = $this->repo->listStacksForUser(null, true, $endpointId);
        foreach ($stacks as $stack) {
            $this->syncBindVolumesForStack($stack);
        }
    }

    /** @param array<string, mixed> $stack */
    private function syncBindVolumesForStack(array $stack): void
    {
        $stackId = (int) ($stack['id'] ?? 0);
        $endpointId = (int) ($stack['endpoint_id'] ?? 0);
        $stackName = (string) ($stack['name'] ?? '');
        if ($stackId <= 0 || $endpointId <= 0) {
            return;
        }
        $path = (string) ($stack['project_path'] ?? '');
        $entry = (string) ($stack['entry_point'] ?? 'docker-compose.yml');
        $content = '';
        try {
            if ($path !== '') {
                $content = $this->compose->readComposeFile($path, $entry);
            }
        } catch (\Throwable) {
            $content = '';
        }
        if ($content === '') {
            return;
        }
        $binds = BindVolumeExtractor::fromCompose($content, $stackName, $path);
        $keep = [];
        foreach ($binds as $b) {
            $name = (string) ($b['name'] ?? '');
            $host = (string) ($b['hostPath'] ?? '');
            if ($name === '' || $host === '') {
                continue;
            }
            // Don't overwrite a manual bind with the same name
            $existing = $this->repo->getBindVolumeByName($endpointId, $name);
            if ($existing && (string) ($existing['source'] ?? '') === 'manual') {
                $keep[] = $name;
                continue;
            }
            $this->repo->upsertBindVolume(
                $endpointId,
                $name,
                $host,
                'stack',
                $stackId,
                $stackName,
                (string) ($stack['created_by'] ?? ''),
            );
            $keep[] = $name;
        }
        $this->repo->pruneStackBindVolumes($stackId, $keep);
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function browseVolume(int $endpointId, string $name, Request $request, array $user): Response
    {
        [$browser, $deny] = $this->volumeBrowserForEndpoint($endpointId, $name, $user);
        if ($deny || !$browser) {
            return $deny ?? Response::error('Volume introuvable', 404);
        }
        $rel = (string) ($request->query('path') ?? '/');
        try {
            return Response::json($browser->list($name, $rel));
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function readVolumeFile(int $endpointId, string $name, Request $request, array $user): Response
    {
        [$browser, $deny] = $this->volumeBrowserForEndpoint($endpointId, $name, $user);
        if ($deny || !$browser) {
            return $deny ?? Response::error('Volume introuvable', 404);
        }
        $rel = (string) ($request->query('path') ?? '');
        try {
            return Response::json($browser->readFile($name, $rel));
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function downloadVolumeFile(int $endpointId, string $name, Request $request, array $user): Response
    {
        [$browser, $deny] = $this->volumeBrowserForEndpoint($endpointId, $name, $user);
        if ($deny || !$browser) {
            return $deny ?? Response::error('Volume introuvable', 404);
        }
        $rel = (string) ($request->query('path') ?? '');
        try {
            $file = $browser->download($name, $rel);
            $safeName = preg_replace('/[^\w.\-]+/', '_', $file['Name']) ?: 'file';
            return new Response(
                200,
                $file['Bytes'],
                [
                    'Content-Type' => 'application/octet-stream',
                    'Content-Disposition' => 'attachment; filename="' . $safeName . '"',
                    'Content-Length' => (string) $file['Size'],
                ],
            );
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function writeVolumeFile(int $endpointId, string $name, Request $request, array $user): Response
    {
        [$browser, $deny] = $this->volumeBrowserForEndpoint($endpointId, $name, $user, EndpointAcl::OPERATE);
        if ($deny || !$browser) {
            return $deny ?? Response::error('Volume introuvable', 404);
        }
        $body = $request->json();
        $rel = (string) ($body['Path'] ?? $body['path'] ?? '');
        try {
            $result = $browser->writeFile($name, $rel, [
                'Content' => (string) ($body['Content'] ?? $body['content'] ?? ''),
                'Encoding' => (string) ($body['Encoding'] ?? $body['encoding'] ?? 'text'),
                'CreateOnly' => array_key_exists('CreateOnly', $body)
                    ? (bool) $body['CreateOnly']
                    : (array_key_exists('createOnly', $body) ? (bool) $body['createOnly'] : true),
            ]);
            return Response::json($result, 201);
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /**
     * Binary upload (application/octet-stream) — preferred for large files (up to 300 Mo).
     * @param array{id:int,username:string,role:int} $user
     */
    private function uploadVolumeFile(int $endpointId, string $name, Request $request, array $user): Response
    {
        [$browser, $deny] = $this->volumeBrowserForEndpoint($endpointId, $name, $user, EndpointAcl::OPERATE);
        if ($deny || !$browser) {
            return $deny ?? Response::error('Volume introuvable', 404);
        }
        $rel = (string) ($request->query('path') ?? $request->query('Path') ?? '');
        if ($rel === '') {
            return Response::error('Paramètre path requis', 400);
        }
        $len = strlen($request->rawBody);
        if ($len > VolumeBrowser::MAX_WRITE_BYTES) {
            return Response::error('Fichier trop volumineux (max 300 Mo)', 413);
        }
        $createOnly = in_array(strtolower((string) ($request->query('createOnly') ?? '')), ['1', 'true', 'yes'], true);
        try {
            $result = $browser->writeBytes($name, $rel, $request->rawBody, $createOnly);
            return Response::json($result, 201);
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function mkdirVolumePath(int $endpointId, string $name, Request $request, array $user): Response
    {
        [$browser, $deny] = $this->volumeBrowserForEndpoint($endpointId, $name, $user, EndpointAcl::OPERATE);
        if ($deny || !$browser) {
            return $deny ?? Response::error('Volume introuvable', 404);
        }
        $body = $request->json();
        $rel = (string) ($body['Path'] ?? $body['path'] ?? '');
        try {
            return Response::json($browser->mkdir($name, $rel), 201);
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function renameVolumePath(int $endpointId, string $name, Request $request, array $user): Response
    {
        [$browser, $deny] = $this->volumeBrowserForEndpoint($endpointId, $name, $user, EndpointAcl::OPERATE);
        if ($deny || !$browser) {
            return $deny ?? Response::error('Volume introuvable', 404);
        }
        $body = $request->json();
        $from = (string) ($body['From'] ?? $body['from'] ?? '');
        $to = (string) ($body['To'] ?? $body['to'] ?? '');
        try {
            return Response::json($browser->rename($name, $from, $to));
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function deleteVolumeEntry(int $endpointId, string $name, Request $request, array $user): Response
    {
        [$browser, $deny] = $this->volumeBrowserForEndpoint($endpointId, $name, $user, EndpointAcl::OPERATE);
        if ($deny || !$browser) {
            return $deny ?? Response::error('Volume introuvable', 404);
        }
        $body = $request->json();
        $rel = (string) ($body['Path'] ?? $body['path'] ?? $request->query('path') ?? '');
        try {
            $browser->delete($name, $rel);
            return Response::empty(204);
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 500);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function createRegistry(Request $request, array $user): Response
    {
        $body = $request->json();
        $name = trim((string) ($body['Name'] ?? $body['name'] ?? ''));
        $url = trim((string) ($body['URL'] ?? $body['Url'] ?? $body['url'] ?? ''));
        $username = trim((string) ($body['Username'] ?? $body['username'] ?? ''));
        $password = (string) ($body['Password'] ?? $body['password'] ?? '');
        $type = $this->normalizeRegistryKind($body['Type'] ?? $body['type'] ?? $body['RegistryKind'] ?? 'v2');
        $shared = Ownership::isAdmin($user) && !empty($body['Shared']);
        if ($name === '' || $url === '') {
            return Response::error('Le nom et l’URL sont requis', 400);
        }
        if ($type === 'hub') {
            $url = 'https://docker.io';
        } elseif (!preg_match('#^https?://#i', $url)) {
            $url = 'https://' . $url;
        }
        try {
            $client = new RegistryClient([
                'name' => $name,
                'url' => $url,
                'username' => $username,
                'password' => $password,
                'type' => $type,
            ]);
            $client->ping();
        } catch (\Throwable $e) {
            return Response::error('Connexion au registre impossible : ' . $e->getMessage(), 400);
        }
        $row = $this->repo->createRegistry(
            $name,
            $url,
            $username,
            $password,
            $type,
            Ownership::userId($user),
            Ownership::username($user),
            $shared,
        );
        return Response::json($this->formatRegistry($row), 201);
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function updateRegistry(int $id, Request $request, array $user): Response
    {
        $existing = $this->repo->getRegistry($id);
        if (!$existing || !$this->canManageRegistry($existing, $user)) {
            return Response::error('Registre introuvable', 404);
        }
        $body = $request->json();
        $name = trim((string) ($body['Name'] ?? $body['name'] ?? $existing['name']));
        $url = trim((string) ($body['URL'] ?? $body['Url'] ?? $body['url'] ?? $existing['url']));
        $username = trim((string) ($body['Username'] ?? $body['username'] ?? $existing['username']));
        // Mot de passe : absent ou chaîne vide = conserver l’existant ; ClearPassword=true = effacer
        $password = null;
        $clearPass = !empty($body['ClearPassword']) || !empty($body['clearPassword']);
        if ($clearPass) {
            $password = '';
        } elseif (array_key_exists('Password', $body) || array_key_exists('password', $body)) {
            $incoming = (string) ($body['Password'] ?? $body['password'] ?? '');
            if ($incoming !== '') {
                $password = $incoming;
            }
        }
        $typeRaw = $body['Type'] ?? $body['type'] ?? $body['RegistryKind'] ?? $existing['type'];
        $type = $this->normalizeRegistryKind($typeRaw);
        if ($name === '' || $url === '') {
            return Response::error('Le nom et l’URL sont requis', 400);
        }
        if ($type === 'hub') {
            $url = 'https://docker.io';
        } elseif (!preg_match('#^https?://#i', $url)) {
            $url = 'https://' . $url;
        }
        $passForTest = $password !== null ? $password : (string) $existing['password'];
        try {
            $client = new RegistryClient([
                'url' => $url,
                'username' => $username,
                'password' => $passForTest,
                'type' => $type,
            ]);
            $client->ping();
        } catch (\Throwable $e) {
            return Response::error('Connexion au registre impossible : ' . $e->getMessage(), 400);
        }
        $row = $this->repo->updateRegistry($id, $name, $url, $username, $password, $type);
        return Response::json($this->formatRegistry($row ?? $existing));
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function pingRegistry(int $id, array $user): Response
    {
        $row = $this->repo->getRegistry($id);
        if (!$row || !$this->canAccessRegistry($row, $user)) {
            return Response::error('Registre introuvable', 404);
        }
        try {
            $result = (new RegistryClient($row))->ping();
            return Response::json($result);
        } catch (\Throwable $e) {
            return Response::error($e->getMessage(), 502);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function browseRegistryRepos(int $id, Request $request, array $user): Response
    {
        $row = $this->repo->getRegistry($id);
        if (!$row || !$this->canAccessRegistry($row, $user)) {
            return Response::error('Registre introuvable', 404);
        }
        $q = (string) ($request->query('q') ?? $request->query('query') ?? '');
        $n = (int) ($request->query('n') ?? 50);
        try {
            $data = (new RegistryClient($row))->listRepositories($q, max(1, min(200, $n)));
            return Response::json($data);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 502);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function browseRegistryTags(int $id, string $repository, array $user): Response
    {
        $row = $this->repo->getRegistry($id);
        if (!$row || !$this->canAccessRegistry($row, $user)) {
            return Response::error('Registre introuvable', 404);
        }
        try {
            $data = (new RegistryClient($row))->listTags($repository);
            return Response::json($data);
        } catch (\Throwable $e) {
            $code = (int) $e->getCode();
            return Response::error($e->getMessage(), $code >= 400 && $code < 600 ? $code : 502);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function pullFromRegistry(int $id, Request $request, array $user): Response
    {
        $row = $this->repo->getRegistry($id);
        if (!$row || !$this->canAccessRegistry($row, $user)) {
            return Response::error('Registre introuvable', 404);
        }
        $body = $request->json();
        $repo = trim((string) ($body['Repository'] ?? $body['repository'] ?? $body['Name'] ?? ''));
        $tag = trim((string) ($body['Tag'] ?? $body['tag'] ?? 'latest'));
        if ($repo === '') {
            return Response::error('Dépôt requis', 400);
        }
        if ($tag === '') {
            $tag = 'latest';
        }
        $type = (string) ($row['type'] ?? 'v2');
        if ($type === 'hub') {
            $fromImage = $repo;
        } else {
            $host = preg_replace('#^https?://#i', '', (string) $row['url']);
            $host = rtrim((string) $host, '/');
            $fromImage = $host . '/' . $repo;
        }
        $headers = [];
        $username = (string) ($row['username'] ?? '');
        $password = (string) ($row['password'] ?? '');
        if ($username !== '' || $password !== '') {
            $auth = [
                'username' => $username,
                'password' => $password,
                'serveraddress' => $type === 'hub' ? 'https://index.docker.io/v1/' : (string) $row['url'],
            ];
            $headers['X-Registry-Auth'] = base64_encode(json_encode($auth, JSON_UNESCAPED_SLASHES) ?: '{}');
        }
        try {
            $res = $this->docker->request(
                'POST',
                '/images/create',
                null,
                $headers,
                ['fromImage' => $fromImage, 'tag' => $tag],
            );
            if ($res['status'] >= 400) {
                $decoded = json_decode($res['body'], true);
                $msg = is_array($decoded) ? (string) ($decoded['message'] ?? $res['body']) : $res['body'];
                return Response::error($msg !== '' ? $msg : 'Échec du pull', $res['status']);
            }
            return Response::json([
                'Image' => $fromImage . ':' . $tag,
                'Log' => $res['body'],
            ]);
        } catch (\Throwable $e) {
            return Response::error($e->getMessage(), 500);
        }
    }

    /** @param array<string, mixed> $row */
    private function formatRegistry(array $row): array
    {
        return [
            'Id' => (int) $row['id'],
            'Name' => (string) $row['name'],
            'URL' => (string) $row['url'],
            'Username' => (string) $row['username'],
            'Authentication' => ((string) ($row['username'] ?? '') !== '' || (string) ($row['password'] ?? '') !== ''),
            // Portainer CE Type enum: 6 = Docker Hub, 3 = Custom / Registry v2
            'Type' => ((string) ($row['type'] ?? 'v2') === 'hub') ? 6 : 3,
            'RegistryKind' => (string) ($row['type'] ?? 'v2'),
            'CreatedAt' => (int) ($row['created_at'] ?? 0),
            'OwnerId' => isset($row['owner_id']) ? (int) $row['owner_id'] : null,
            'OwnerUsername' => (string) ($row['owner_username'] ?? ''),
            'Shared' => !empty($row['is_shared']),
        ];
    }

    /** Accept Portainer int Type (6=hub, 3=custom) or WM string kind. */
    private function normalizeRegistryKind(mixed $type): string
    {
        if (is_int($type) || (is_string($type) && ctype_digit($type))) {
            return ((int) $type) === 6 ? 'hub' : 'v2';
        }
        $s = strtolower(trim((string) $type));
        return $s === 'hub' ? 'hub' : 'v2';
    }

    /**
     * Non-admin stacks: resolve via `docker compose config` then apply ComposePolicy.
     * @param list<array{name?:string,value?:string}|array{Name?:string,Value?:string}> $env
     * @param array{id:int,username:string,role:int} $user
     */
    private function assertComposeSafeForUser(string $content, array $env, array $user): ?Response
    {
        if (Ownership::isAdmin($user)) {
            return null;
        }
        try {
            $resolved = $this->compose->resolveConfig($content, $env);
            $violations = ComposePolicy::violations($resolved);
        } catch (\Throwable $e) {
            return Response::error('Compose invalide : ' . $e->getMessage(), 400);
        }
        if ($violations !== []) {
            return Response::error(implode(' · ', $violations), 403);
        }
        return null;
    }

    /** @param array<string, mixed> $stack @param array{id:int,username:string,role:int} $user */
    private function canAccessStack(array $stack, array $user): bool
    {
        if (Ownership::isGlobalAdmin($user)) {
            return true;
        }
        $eid = (int) ($stack['endpoint_id'] ?? 0);
        if (!$this->endpointAcl->can($user, $eid, EndpointAcl::READ)) {
            return false;
        }
        if ($this->endpointAcl->can($user, $eid, EndpointAcl::ADMIN)) {
            return true;
        }
        return strcasecmp((string) ($stack['created_by'] ?? ''), Ownership::username($user)) === 0;
    }

    /** @param array<string, mixed> $stack @param array{id:int,username:string,role:int} $user */
    private function canOperateStack(array $stack, array $user): bool
    {
        if (!$this->canAccessStack($stack, $user)) {
            return false;
        }
        $eid = (int) ($stack['endpoint_id'] ?? 0);
        return $this->endpointAcl->can($user, $eid, EndpointAcl::OPERATE);
    }

    /** @param array<string, mixed> $row @param array{id:int,username:string,role:int} $user */
    private function canAccessRegistry(array $row, array $user): bool
    {
        if (Ownership::isAdmin($user)) {
            return true;
        }
        if (!empty($row['is_shared'])) {
            return true;
        }
        return (int) ($row['owner_id'] ?? 0) === Ownership::userId($user);
    }

    /** @param array<string, mixed> $row @param array{id:int,username:string,role:int} $user */
    private function canManageRegistry(array $row, array $user): bool
    {
        if (Ownership::isAdmin($user)) {
            return true;
        }
        // Shared system registries: admin only
        if (!empty($row['is_shared']) && (int) ($row['owner_id'] ?? 0) === 0) {
            return false;
        }
        return (int) ($row['owner_id'] ?? 0) === Ownership::userId($user);
    }

    private function searchImages(Request $request): Response
    {
        $q = trim((string) ($request->query('q') ?? $request->query('query') ?? ''));
        if (strlen($q) < 1) {
            return Response::json(['Local' => [], 'Remote' => [], 'Query' => $q]);
        }
        $qLower = strtolower($q);
        $local = [];
        try {
            $images = $this->docker->json('GET', '/images/json');
            foreach ($images as $img) {
                $tags = $img['RepoTags'] ?? [];
                if (!is_array($tags) || $tags === []) {
                    continue;
                }
                foreach ($tags as $tag) {
                    if (!is_string($tag) || $tag === '<none>:<none>') {
                        continue;
                    }
                    if (!str_contains(strtolower($tag), $qLower)) {
                        continue;
                    }
                    $local[] = [
                        'Name' => $tag,
                        'Id' => (string) ($img['Id'] ?? ''),
                        'Size' => (int) ($img['Size'] ?? 0),
                        'Source' => 'local',
                        'Official' => false,
                        'Description' => 'Image locale',
                        'StarCount' => 0,
                    ];
                }
            }
        } catch (\Throwable) {
            // ignore local failures; still try hub
        }

        $remote = [];
        try {
            $url = 'https://hub.docker.com/v2/search/repositories/?query=' . rawurlencode($q) . '&page_size=20';
            $raw = $this->httpGet($url, 8);
            $data = json_decode($raw, true);
            foreach (($data['results'] ?? []) as $row) {
                $name = (string) ($row['repo_name'] ?? $row['name'] ?? '');
                if ($name === '') {
                    continue;
                }
                $remote[] = [
                    'Name' => $name,
                    'Id' => '',
                    'Size' => 0,
                    'Source' => 'hub',
                    'Official' => !empty($row['is_official']),
                    'Description' => (string) ($row['short_description'] ?? $row['description'] ?? ''),
                    'StarCount' => (int) ($row['star_count'] ?? 0),
                    'PullCount' => (int) ($row['pull_count'] ?? 0),
                ];
            }
        } catch (\Throwable $e) {
            return Response::json([
                'Local' => array_slice($local, 0, 30),
                'Remote' => [],
                'Query' => $q,
                'HubError' => $e->getMessage(),
            ]);
        }

        return Response::json([
            'Local' => array_slice($local, 0, 30),
            'Remote' => $remote,
            'Query' => $q,
        ]);
    }

    private function searchImageTags(Request $request): Response
    {
        $repo = trim((string) ($request->query('repo') ?? $request->query('image') ?? ''));
        if ($repo === '') {
            return Response::error('Le paramètre repo est requis', 400);
        }
        $repo = ltrim($repo, '/');
        // official images live under library/
        $hubRepo = str_contains($repo, '/') ? $repo : ('library/' . $repo);
        try {
            $parts = explode('/', $hubRepo);
            $url = 'https://hub.docker.com/v2/repositories/'
                . implode('/', array_map('rawurlencode', $parts))
                . '/tags?page_size=40&ordering=-last_updated';
            $raw = $this->httpGet($url, 10);
            $data = json_decode($raw, true);
            $tags = [];
            foreach (($data['results'] ?? []) as $row) {
                $name = (string) ($row['name'] ?? '');
                if ($name === '') {
                    continue;
                }
                $tags[] = [
                    'Name' => $name,
                    'Size' => (int) ($row['full_size'] ?? 0),
                    'LastUpdated' => (string) ($row['last_updated'] ?? ''),
                ];
            }
            return Response::json([
                'Repo' => $repo,
                'Tags' => $tags,
            ]);
        } catch (\Throwable $e) {
            return Response::error('Impossible de récupérer les tags : ' . $e->getMessage(), 502);
        }
    }

    private function httpGet(string $url, int $timeout = 10): string
    {
        $ch = curl_init($url);
        if ($ch === false) {
            throw new \RuntimeException('Impossible d\'initialiser curl');
        }
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_HTTPHEADER => [
                'Accept: application/json',
                'User-Agent: WharfMaster/2.1.0',
            ],
        ]);
        $body = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($body === false) {
            throw new \RuntimeException($err !== '' ? $err : 'Requête HTTP échouée');
        }
        if ($status >= 400) {
            throw new \RuntimeException('HTTP ' . $status);
        }
        return $body;
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function buildImage(Request $request, array $user): Response
    {
        $body = $request->json();
        $dockerfile = (string) ($body['Dockerfile'] ?? $body['dockerfile'] ?? '');
        $tag = trim((string) ($body['Tag'] ?? $body['tag'] ?? $body['Name'] ?? ''));
        $saveAs = trim((string) ($body['SaveAs'] ?? $body['saveAs'] ?? ''));
        try {
            if ($saveAs !== '') {
                $this->imageBuilder->saveDockerfile($saveAs, $dockerfile);
            }
            $result = $this->imageBuilder->build($dockerfile, $tag, Ownership::labelsFor($user));
            $status = $result['success'] ? 200 : 500;
            return Response::json([
                'Success' => $result['success'],
                'Tag' => $tag,
                'Log' => $result['body'],
                'Error' => $result['error'],
            ], $status);
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            return Response::error($e->getMessage(), 500);
        }
    }

    private function saveDockerfile(Request $request): Response
    {
        $body = $request->json();
        $name = trim((string) ($body['Name'] ?? $body['name'] ?? ''));
        $content = (string) ($body['Content'] ?? $body['Dockerfile'] ?? $body['dockerfile'] ?? '');
        try {
            $this->imageBuilder->saveDockerfile($name, $content);
            return Response::json(['Name' => $name], 201);
        } catch (\InvalidArgumentException $e) {
            return Response::error($e->getMessage(), 400);
        } catch (\Throwable $e) {
            return Response::error($e->getMessage(), 500);
        }
    }

    private function hostResources(): array
    {
        $path = '/';
        $total = @disk_total_space($path);
        $free = @disk_free_space($path);
        if ($total === false || $free === false || $total <= 0) {
            return [
                'DiskTotal' => 0,
                'DiskFree' => 0,
                'DiskUsed' => 0,
                'DiskUsedPercent' => 0,
                'Path' => $path,
            ];
        }
        $used = max(0, (float) $total - (float) $free);
        return [
            'DiskTotal' => (float) $total,
            'DiskFree' => (float) $free,
            'DiskUsed' => $used,
            'DiskUsedPercent' => round(($used / (float) $total) * 100, 1),
            'Path' => $path,
        ];
    }

    private function metricsChartHours(): int
    {
        $v = (int) ($this->repo->getSetting('metrics_chart_hours', '72') ?? '72');
        return max(1, min(168, $v > 0 ? $v : 72));
    }

    private function metricsRetentionDays(): int
    {
        $v = (int) ($this->repo->getSetting('metrics_retention_days', '90') ?? '90');
        return max(7, min(365, $v > 0 ? $v : 90));
    }

    private function metricsHistory(Request $request): Response
    {
        $scope = (string) ($request->query('scope') ?? 'ep:1');
        $retention = $this->metricsRetentionDays();
        $defaultHours = $this->metricsChartHours();
        $hoursRaw = $request->query('hours');
        $useHours = ($hoursRaw !== null && $hoursRaw !== '')
            ? max(1, min($retention * 24, (int) $hoursRaw))
            : $defaultHours;
        $points = (int) ($request->query('points') ?? 288);
        $series = $this->repo->listMetricSamples($scope, $retention, $points, $useHours);
        return Response::json([
            'Scope' => $scope,
            'Hours' => $useHours,
            'ChartHours' => $defaultHours,
            'RetentionDays' => $retention,
            'Storage' => 'sqlite',
            'Series' => $series,
            'Count' => count($series),
        ]);
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function metricsSample(Request $request, array $user): Response
    {
        $body = $request->json();
        $scope = trim((string) ($body['Scope'] ?? $body['scope'] ?? 'ep:1'));
        if ($scope === '') {
            $scope = 'ep:1';
        }
        $retention = $this->metricsRetentionDays();
        $result = $this->repo->recordMetricSample($scope, [
            'containers' => (int) ($body['containers'] ?? $body['Containers'] ?? 0),
            'images' => (int) ($body['images'] ?? $body['Images'] ?? 0),
            'volumes' => (int) ($body['volumes'] ?? $body['Volumes'] ?? 0),
            'networks' => (int) ($body['networks'] ?? $body['Networks'] ?? 0),
            'cpu' => (float) ($body['cpu'] ?? $body['Cpu'] ?? 0),
            'mem' => (float) ($body['mem'] ?? $body['Mem'] ?? 0),
            'disk' => (float) ($body['disk'] ?? $body['Disk'] ?? 0),
        ], 300, $retention);
        return Response::json([
            'Ok' => true,
            'Inserted' => $result['inserted'],
            'Purged' => $result['purged'],
            'Sample' => $result['sample'],
            'RetentionDays' => $retention,
        ], $result['inserted'] ? 201 : 200);
    }

    private function formatSettings(): array
    {
        $publicUrl = (string) ($this->repo->getSetting('public_url', '') ?? '');
        $ep = $this->repo->getEndpoint(1);
        if ($publicUrl === '' && $ep && !empty($ep['public_url'])) {
            $publicUrl = (string) $ep['public_url'];
        }
        $ldap = $this->ldapConfig();
        return [
            'LogoURL' => '',
            'BlackListedLabels' => [],
            'AuthenticationMethod' => !empty($ldap['enabled']) ? 2 : 1,
            'InternalAuthSettings' => ['RequiredPasswordLength' => 8],
            'EnableEdgeComputeFeatures' => false,
            'UserSessionTimeout' => '8h',
            'EnableTelemetry' => false,
            'SnapshotInterval' => '5m',
            'PublicURL' => $publicUrl,
            // Alias used by our UI
            'HostURL' => $publicUrl,
            'MetricsChartHours' => $this->metricsChartHours(),
            'MetricsRetentionDays' => $this->metricsRetentionDays(),
            'Ldap' => [
                'Enabled' => !empty($ldap['enabled']),
                'Host' => (string) ($ldap['host'] ?? ''),
                'Port' => (int) ($ldap['port'] ?? 389),
                'UseTls' => !empty($ldap['use_tls']),
                'UseSsl' => !empty($ldap['use_ssl']),
                'BaseDn' => (string) ($ldap['base_dn'] ?? ''),
                'BindDn' => (string) ($ldap['bind_dn'] ?? ''),
                'BindPasswordSet' => trim((string) ($ldap['bind_password'] ?? '')) !== '',
                'UserFilter' => (string) ($ldap['user_filter'] ?? '(sAMAccountName={username})'),
                'UsernameAttr' => (string) ($ldap['username_attr'] ?? 'sAMAccountName'),
            ],
            // Portainer CE shape (clients reading settings.LDAPSettings)
            'LDAPSettings' => $this->formatLdapSettingsPortainer($ldap),
            'TrivyEnabled' => $this->trivyEnabled(),
            'TrivyInstalled' => $this->imageScanner->available(),
            'TrivyAvailable' => $this->trivyEnabled() && $this->imageScanner->available(),
        ];
    }

    private function trivyEnabled(): bool
    {
        $v = strtolower(trim((string) ($this->repo->getSetting('trivy_enabled', '1') ?? '1')));
        return !in_array($v, ['0', 'false', 'off', 'no'], true);
    }

    /** @param array<string, mixed> $user */
    private function updateSettings(Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $body = $request->json();
        $publicUrl = (string) ($this->repo->getSetting('public_url', '') ?? '');
        if (array_key_exists('PublicURL', $body) || array_key_exists('HostURL', $body) || array_key_exists('publicURL', $body)) {
            $publicUrl = rtrim(trim((string) ($body['PublicURL'] ?? $body['HostURL'] ?? $body['publicURL'] ?? '')), '/');
            if ($publicUrl !== '' && !preg_match('#^https?://#i', $publicUrl)) {
                return Response::error('L\'URL publique doit commencer par http:// ou https://', 400);
            }
            $this->repo->setSetting('public_url', $publicUrl);
            $this->repo->updateEndpointPublicUrl(1, $publicUrl);
        }

        if (array_key_exists('MetricsChartHours', $body) || array_key_exists('metricsChartHours', $body)) {
            $hours = (int) ($body['MetricsChartHours'] ?? $body['metricsChartHours'] ?? 72);
            $hours = max(1, min(168, $hours));
            $this->repo->setSetting('metrics_chart_hours', (string) $hours);
        }
        if (array_key_exists('MetricsRetentionDays', $body) || array_key_exists('metricsRetentionDays', $body)) {
            $days = (int) ($body['MetricsRetentionDays'] ?? $body['metricsRetentionDays'] ?? 90);
            $days = max(7, min(365, $days));
            $this->repo->setSetting('metrics_retention_days', (string) $days);
        }

        if (array_key_exists('TrivyEnabled', $body) || array_key_exists('trivyEnabled', $body)) {
            $raw = $body['TrivyEnabled'] ?? $body['trivyEnabled'];
            $on = filter_var($raw, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
            if ($on === null) {
                $on = !in_array(strtolower(trim((string) $raw)), ['0', 'false', 'off', 'no', ''], true);
            }
            $this->repo->setSetting('trivy_enabled', $on ? '1' : '0');
        }

        if (isset($body['Ldap']) && is_array($body['Ldap'])) {
            $this->saveLdapSettings($body['Ldap']);
        } elseif (isset($body['LDAPSettings']) && is_array($body['LDAPSettings'])) {
            $this->saveLdapSettingsFromPortainer($body['LDAPSettings']);
        }

        $this->audit($user, 'settings.update', 'Mise à jour des paramètres', $request, [
            'publicUrl' => $publicUrl,
            'metricsChartHours' => $this->metricsChartHours(),
            'metricsRetentionDays' => $this->metricsRetentionDays(),
            'ldapEnabled' => !empty($this->ldapConfig()['enabled']),
            'trivyEnabled' => $this->trivyEnabled(),
        ]);
        return Response::json($this->formatSettings());
    }

    /** @param array<string, mixed> $user */
    private function listUsers(array $user): Response
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
    private function createUser(Request $request, array $user): Response
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
    private function changeUserPassword(int $id, Request $request, array $user): Response
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
    private function deleteUser(int $id, Request $request, array $user): Response
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
    private function publicUser(array $user): array
    {
        $role = (int) $user['role'];
        return [
            'Id' => (int) $user['id'],
            'Username' => $user['username'],
            'Role' => $role,
            'IsAdmin' => $role === 1,
            'AuthSource' => (string) ($user['auth_source'] ?? 'local'),
            'ThemeSettings' => (object) [],
        ];
    }

    /** @param array<string, mixed> $ep */
    private function formatEndpoint(array $ep): array
    {
        $stored = (int) ($ep['status'] ?? 1);
        // Portainer CE Status: 1=up, 2=down (disabled maps to down, never 0)
        $status = $stored === 0 ? 2 : 2;
        $tlsExpiresAt = isset($ep['tls_expires_at']) && $ep['tls_expires_at'] !== null
            ? (int) $ep['tls_expires_at']
            : null;
        if ($stored !== 0) {
            try {
                $status = $this->dockerForEndpoint($ep)->ping() ? 1 : 2;
                if ($status === 1) {
                    $this->repo->updateEndpointLastSeen((int) $ep['id'], 1);
                    if (($ep['kind'] ?? '') === 'agent') {
                        $meta = $this->probeAgentTlsMeta($ep);
                        if ($meta !== null) {
                            $tlsExpiresAt = $meta['expiresAt'] ?? $tlsExpiresAt;
                            $observed = (string) ($meta['fingerprint'] ?? '');
                            $prev = trim((string) ($ep['tls_fingerprint'] ?? ''));
                            // TOFU or authenticated pin refresh after cert renewal
                            $pinToStore = $observed !== '' && ($prev === '' || $prev !== $observed)
                                ? $observed
                                : ($prev !== '' ? $prev : null);
                            $this->repo->updateEndpointTlsMeta(
                                (int) $ep['id'],
                                $meta['expiresAt'] ?? null,
                                $pinToStore,
                            );
                            if ($observed !== '') {
                                $ep['tls_fingerprint'] = $observed;
                            }
                        }
                    }
                } elseif (($ep['kind'] ?? '') === 'agent') {
                    $this->repo->updateEndpointLastSeen((int) $ep['id'], 2);
                }
            } catch (\Throwable) {
                $status = 2;
            }
        }

        $kind = (string) ($ep['kind'] ?? 'local');
        $tlsDaysLeft = null;
        if ($tlsExpiresAt !== null && $tlsExpiresAt > 0) {
            $tlsDaysLeft = (int) floor(($tlsExpiresAt - time()) / 86400);
        }
        [$userPolicies, $teamPolicies] = $this->portainerAccessPolicies((int) $ep['id']);
        return [
            'Id' => (int) $ep['id'],
            'Name' => $ep['name'],
            'Type' => (int) $ep['type'],
            'URL' => $kind === 'agent' ? (string) ($ep['agent_url'] ?? $ep['url']) : $ep['url'],
            'GroupId' => (int) $ep['group_id'],
            'PublicURL' => $ep['public_url'] !== ''
                ? $ep['public_url']
                : (string) ($this->repo->getSetting('public_url', '') ?? ''),
            'Status' => $status,
            'Snapshots' => json_decode($ep['snapshots'] ?: '[]', true) ?: [],
            'IsEdgeDevice' => false,
            'UserAccessPolicies' => $userPolicies,
            'TeamAccessPolicies' => $teamPolicies,
            'TagIds' => [],
            'Kubernetes' => (object) [],
            'Kind' => $kind,
            'NodeName' => (string) ($ep['node_name'] ?? $ep['name']),
            'AgentURL' => (string) ($ep['agent_url'] ?? ''),
            'Disabled' => $stored === 0,
            'LastSeenAt' => isset($ep['last_seen_at']) ? (int) $ep['last_seen_at'] : null,
            'JoinedAt' => isset($ep['joined_at']) ? (int) $ep['joined_at'] : null,
            'Tls' => $kind === 'agent',
            'TlsExpiresAt' => $tlsExpiresAt,
            'TlsDaysLeft' => $tlsDaysLeft,
            'TlsRenewBy' => $tlsExpiresAt ? date('Y-m-d', max(0, $tlsExpiresAt - 30 * 86400)) : null,
            'TlsFingerprint' => (string) ($ep['tls_fingerprint'] ?? ''),
            'TlsFingerprintShort' => AgentTls::short((string) ($ep['tls_fingerprint'] ?? '')),
            'TlsPinned' => trim((string) ($ep['tls_fingerprint'] ?? '')) !== '',
        ];
    }

    /**
     * @param array<string, mixed> $ep
     * @return array{fingerprint:string, expiresAt:?int}|null
     */
    private function probeAgentTlsMeta(array $ep): ?array
    {
        $url = (string) ($ep['agent_url'] ?? '');
        if ($url === '' || !str_starts_with(strtolower($url), 'https://')) {
            return null;
        }
        $secret = (string) ($ep['agent_secret'] ?? '');
        $pinned = trim((string) ($ep['tls_fingerprint'] ?? ''));
        $info = AgentTls::inspect($url);
        if ($info === null) {
            return null;
        }
        if ($pinned !== '' && !hash_equals($pinned, $info['fingerprint'])) {
            // Cert renewed (agent entrypoint) — only rotate pin if Bearer health succeeds
            if ($secret === '' || !AgentTls::healthOk($url, $secret)) {
                return null;
            }
        }
        if (AgentTls::healthOk($url, $secret)) {
            try {
                $ch = curl_init(rtrim($url, '/') . '/health');
                if ($ch) {
                    curl_setopt_array($ch, [
                        CURLOPT_RETURNTRANSFER => true,
                        CURLOPT_TIMEOUT => 5,
                        CURLOPT_HTTPHEADER => [
                            'Authorization: Bearer ' . $secret,
                            'Accept: application/json',
                        ],
                        CURLOPT_SSL_VERIFYPEER => false,
                        CURLOPT_SSL_VERIFYHOST => 0,
                    ]);
                    $body = curl_exec($ch);
                    curl_close($ch);
                    if (is_string($body) && $body !== '') {
                        $json = json_decode($body, true);
                        if (is_array($json) && !empty($json['tlsExpiresAt'])) {
                            $info['expiresAt'] = (int) $json['tlsExpiresAt'];
                        }
                    }
                }
            } catch (\Throwable) {
                // keep cert-based expiry
            }
        }
        return $info;
    }

    /** @param array<string, mixed> $ep */
    private function probeAgentTls(array $ep): ?int
    {
        $meta = $this->probeAgentTlsMeta($ep);
        return $meta['expiresAt'] ?? null;
    }

    /** @param array<string, mixed> $stack */
    private function formatStack(array $stack): array
    {
        $env = json_decode($stack['env_json'] ?? '[]', true);
        if (!is_array($env)) {
            $env = [];
        }
        return [
            'Id' => (int) $stack['id'],
            'Name' => $stack['name'],
            'Type' => (int) $stack['type'],
            'EndpointId' => (int) $stack['endpoint_id'],
            'SwarmId' => $stack['swarm_id'],
            'EntryPoint' => $stack['entry_point'],
            'Env' => $env,
            'Status' => (int) $stack['status'],
            'ProjectPath' => $stack['project_path'],
            'CreationDate' => (int) $stack['creation_date'],
            'CreatedBy' => $stack['created_by'],
            'UpdateDate' => (int) $stack['update_date'],
            'UpdatedBy' => $stack['updated_by'],
            'FromAppTemplate' => (bool) $stack['from_app_template'],
            'GitConfig' => null,
            'IsComposeFormat' => true,
        ];
    }

    private function ensureInstanceId(): string
    {
        $id = $this->repo->getSetting('instance_id');
        if ($id) {
            return $id;
        }
        $id = bin2hex(random_bytes(16));
        $this->repo->setSetting('instance_id', $id);
        return $id;
    }

    private function healthCheck(): Response
    {
        $socket = (string) ($this->config['docker_socket'] ?? '');
        $dataDir = dirname((string) ($this->config['sqlite_path'] ?? ''));
        $composeDir = (string) ($this->config['compose_dir'] ?? '');
        $dockerOk = false;
        try {
            $dockerOk = $this->docker->ping();
        } catch (\Throwable) {
            $dockerOk = false;
        }
        $composeBin = (string) ($this->config['compose_bin'] ?? '');
        $dockerBin = (string) ($this->config['docker_bin'] ?? 'docker');
        $composeOk = false;
        $out = [];
        $code = 1;
        @exec(escapeshellarg($dockerBin) . ' compose version 2>/dev/null', $out, $code);
        if ($code === 0) {
            $composeOk = true;
        } elseif ($composeBin !== '' && is_executable($composeBin)) {
            $composeOk = true;
        }
        $dataWritable = $dataDir !== '' && is_dir($dataDir) && is_writable($dataDir);
        $composeWritable = $composeDir !== '' && (is_dir($composeDir) || @mkdir($composeDir, 0755, true)) && is_writable($composeDir);
        $sqliteOk = is_file((string) ($this->config['sqlite_path'] ?? '')) && is_readable((string) $this->config['sqlite_path']);
        $checks = [
            'docker' => $dockerOk,
            'dockerSocket' => $socket !== '' && (file_exists($socket) || is_link($socket)),
            'compose' => $composeOk,
            'dataWritable' => $dataWritable,
            'composeDirWritable' => $composeWritable,
            'sqlite' => $sqliteOk,
        ];
        $ok = !in_array(false, $checks, true);
        return Response::json([
            'ok' => $ok,
            'version' => $this->config['version'],
            'checks' => $checks,
        ], $ok ? 200 : 503);
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function downloadBackup(Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $format = strtolower(trim((string) ($request->query('format') ?? 'zip')));
        if ($format === 'sqlite') {
            return $this->downloadSqliteBackupOnly();
        }
        return $this->downloadFullBackupZip($request, $user);
    }

    private function snapshotSqliteFile(): string
    {
        $sqlite = (string) ($this->config['sqlite_path'] ?? '');
        if ($sqlite === '' || !is_file($sqlite)) {
            throw new \RuntimeException('Base SQLite introuvable', 404);
        }
        $tmp = sys_get_temp_dir() . '/wm-backup-' . bin2hex(random_bytes(6)) . '.sqlite';
        try {
            $src = new \PDO('sqlite:' . $sqlite);
            $src->setAttribute(\PDO::ATTR_ERRMODE, \PDO::ERRMODE_EXCEPTION);
            $src->exec('VACUUM INTO ' . $src->quote($tmp));
        } catch (\Throwable) {
            if (!@copy($sqlite, $tmp)) {
                throw new \RuntimeException('Impossible de créer le snapshot SQLite', 500);
            }
        }
        return $tmp;
    }

    private function downloadSqliteBackupOnly(): Response
    {
        try {
            $tmp = $this->snapshotSqliteFile();
        } catch (\Throwable $e) {
            $status = $e->getCode() >= 400 && $e->getCode() < 600 ? (int) $e->getCode() : 500;
            return Response::error($e->getMessage(), $status);
        }
        $blob = (string) file_get_contents($tmp);
        @unlink($tmp);
        $name = 'wharfmaster-backup-' . date('Ymd-His') . '.sqlite';
        return new Response(200, $blob, [
            'Content-Type' => 'application/x-sqlite3',
            'Content-Disposition' => 'attachment; filename="' . $name . '"',
            'Cache-Control' => 'no-store',
            'Content-Security-Policy' => "default-src 'none'",
        ]);
    }

    /**
     * Full disaster-recovery archive: SQLite, Compose stacks, Dockerfiles, JWT secret, manifest.
     *
     * @param array{id:int,username:string,role:int} $user
     */
    private function downloadFullBackupZip(Request $request, array $user): Response
    {
        if (!class_exists(\ZipArchive::class)) {
            return Response::error('Extension PHP zip indisponible — utilisez ?format=sqlite', 500);
        }

        $stamp = date('Ymd-His');
        $rootName = 'wharfmaster-backup-' . $stamp;
        $zipPath = sys_get_temp_dir() . '/' . $rootName . '-' . bin2hex(random_bytes(4)) . '.zip';
        $sqliteTmp = null;

        try {
            $sqliteTmp = $this->snapshotSqliteFile();
            $zip = new \ZipArchive();
            if ($zip->open($zipPath, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) {
                throw new \RuntimeException('Impossible de créer l’archive ZIP', 500);
            }

            $files = [];
            $zip->addFile($sqliteTmp, $rootName . '/database/dockermanager.sqlite');
            $files[] = 'database/dockermanager.sqlite';

            $jwtFile = dirname((string) $this->config['sqlite_path']) . '/jwt.secret';
            if (is_file($jwtFile)) {
                $zip->addFile($jwtFile, $rootName . '/secrets/jwt.secret');
                $files[] = 'secrets/jwt.secret';
            }

            $composeDir = (string) ($this->config['compose_dir'] ?? '');
            if ($composeDir !== '' && is_dir($composeDir)) {
                $added = $this->zipAddDirectory($zip, $composeDir, $rootName . '/compose');
                $files = array_merge($files, $added);
            }

            $dfDir = (string) ($this->config['dockerfiles_dir'] ?? '');
            if ($dfDir !== '' && is_dir($dfDir)) {
                $added = $this->zipAddDirectory($zip, $dfDir, $rootName . '/dockerfiles');
                $files = array_merge($files, $added);
            }

            $settings = $this->formatSettings();
            $meta = [
                'app' => 'WharfMaster',
                'version' => $this->config['version'] ?? null,
                'createdAt' => date('c'),
                'createdBy' => $user['username'] ?? null,
                'format' => 1,
                'contents' => $files,
                'settings' => $settings,
                'config' => [
                    'app_name' => $this->config['app_name'] ?? 'WharfMaster',
                    'version' => $this->config['version'] ?? null,
                    'agent_image' => $this->config['agent_image'] ?? null,
                    'docker_api_version' => $this->config['docker_api_version'] ?? null,
                    'compose_dir' => 'data/compose',
                    'dockerfiles_dir' => 'data/dockerfiles',
                    'sqlite_path' => 'data/dockermanager.sqlite',
                ],
                'notes' => [
                    'Includes users, endpoints/agents, stacks metadata, registries, audit, metrics, settings (SQLite).',
                    'Includes on-disk Compose projects and saved Dockerfiles.',
                    'Includes jwt.secret — keep the archive private.',
                    'Docker container filesystem / volumes on hosts are NOT included.',
                ],
            ];
            $zip->addFromString(
                $rootName . '/MANIFEST.json',
                json_encode($meta, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?: '{}'
            );
            $zip->addFromString($rootName . '/RESTORE.md', $this->backupRestoreGuide($stamp));
            $zip->close();

            $blob = (string) file_get_contents($zipPath);
            $this->audit($user, 'backup.download', 'Téléchargement backup complet (ZIP)', $request, [
                'format' => 'zip',
                'bytes' => strlen($blob),
                'files' => count($files),
            ]);

            return new Response(200, $blob, [
                'Content-Type' => 'application/zip',
                'Content-Disposition' => 'attachment; filename="' . $rootName . '.zip"',
                'Cache-Control' => 'no-store',
                'Content-Security-Policy' => "default-src 'none'",
            ]);
        } catch (\Throwable $e) {
            $status = $e->getCode() >= 400 && $e->getCode() < 600 ? (int) $e->getCode() : 500;
            return Response::error($e->getMessage() !== '' ? $e->getMessage() : 'Échec du backup', $status);
        } finally {
            if ($sqliteTmp !== null) {
                @unlink($sqliteTmp);
            }
            @unlink($zipPath);
        }
    }

    /**
     * @return list<string> paths added relative to archive root prefix
     */
    private function zipAddDirectory(\ZipArchive $zip, string $dir, string $zipPrefix): array
    {
        $added = [];
        $dir = rtrim($dir, '/');
        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::SELF_FIRST
        );
        foreach ($iterator as $fileInfo) {
            /** @var \SplFileInfo $fileInfo */
            $full = $fileInfo->getPathname();
            $rel = substr($full, strlen($dir) + 1);
            if ($rel === false || $rel === '') {
                continue;
            }
            $rel = str_replace('\\', '/', $rel);
            $target = $zipPrefix . '/' . $rel;
            if ($fileInfo->isDir()) {
                $zip->addEmptyDir($target);
                continue;
            }
            if (!$fileInfo->isFile() || !$fileInfo->isReadable()) {
                continue;
            }
            // Skip hidden paths / logs
            if (str_starts_with($rel, '.') || str_contains($rel, '/.') || str_ends_with($rel, '.log')) {
                continue;
            }
            $zip->addFile($full, $target);
            $added[] = preg_replace('#^[^/]+/#', '', $target) ?: $target;
        }
        return $added;
    }

    private function backupRestoreGuide(string $stamp): string
    {
        $ver = (string) ($this->config['version'] ?? '');
        return <<<MD
# Restauration WharfMaster (backup {$stamp})

Archive générée par WharfMaster {$ver}.

## Contenu
- `database/dockermanager.sqlite` — utilisateurs, nœuds/agents, stacks, registres, paramètres, audit, métriques
- `compose/` — fichiers Docker Compose des stacks (miroir local)
- `dockerfiles/` — Dockerfiles enregistrés dans l’UI
- `secrets/jwt.secret` — secret JWT (sessions / API)
- `MANIFEST.json` — métadonnées + aperçu des settings

## Non inclus
- Données dans les **volumes Docker** / fichiers des conteneurs
- Images Docker locales
- Certificats TLS des agents distants (hors empreinte en base)

## Restauration rapide
1. Arrêter WharfMaster (Apache/PHP ou conteneur).
2. Remplacer `data/dockermanager.sqlite` par `database/dockermanager.sqlite`.
3. Restaurer `data/compose/` et `data/dockerfiles/` depuis l’archive.
4. Restaurer `data/jwt.secret` depuis `secrets/jwt.secret` (permissions `0600`).
5. Corriger le propriétaire (`www-data` ou utilisateur du conteneur) puis redémarrer.

```bash
# Exemple (chemins à adapter)
unzip wharfmaster-backup-{$stamp}.zip
install -m 600 wharfmaster-backup-{$stamp}/secrets/jwt.secret /var/www/html/data/jwt.secret
install -m 600 wharfmaster-backup-{$stamp}/database/dockermanager.sqlite /var/www/html/data/dockermanager.sqlite
rm -rf /var/www/html/data/compose /var/www/html/data/dockerfiles
cp -a wharfmaster-backup-{$stamp}/compose /var/www/html/data/compose
cp -a wharfmaster-backup-{$stamp}/dockerfiles /var/www/html/data/dockerfiles
chown -R www-data:www-data /var/www/html/data
```

Conservez cette archive hors ligne : elle contient des secrets (JWT, mots de passe registres chiffrés, secrets agents).
MD;
    }

    /** @param array<string, mixed> $ep */
    private function dockerForEndpoint(array $ep): DockerClient
    {
        $kind = (string) ($ep['kind'] ?? 'local');
        $api = (string) ($this->config['docker_api_version'] ?? 'v1.45');
        if ($kind === 'agent') {
            $url = (string) ($ep['agent_url'] ?? '');
            $secret = (string) ($ep['agent_secret'] ?? '');
            if ($url === '' || $secret === '') {
                throw new \RuntimeException('Nœud agent mal configuré', 503);
            }
            $fp = (string) ($ep['tls_fingerprint'] ?? '');
            return DockerClient::httpAgent($url, $secret, $api, $fp);
        }
        return $this->docker;
    }

    /** @param array<string, mixed> $ep */
    private function scopeForEndpoint(array $ep): DockerScope
    {
        return new DockerScope($this->dockerForEndpoint($ep), $this->repo);
    }

    /** @param array<string, mixed> $ep */
    private function assertEndpointUsable(array $ep): ?Response
    {
        if ((int) ($ep['status'] ?? 1) === 0) {
            return Response::error('Nœud désactivé', 503);
        }
        if (($ep['kind'] ?? 'local') === 'agent' && trim((string) ($ep['agent_secret'] ?? '')) === '') {
            return Response::error('Nœud délié ou secret manquant', 503);
        }
        return null;
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function listNodes(array $user): Response
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
    private function getJoinTokenMeta(array $user): Response
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
    private function createJoinToken(Request $request, array $user): Response
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
    private function rotateJoinToken(Request $request, array $user): Response
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
    private function formatJoinTokenResponse(
        string $rawToken,
        array $row,
        ?Request $request = null,
        string $nodeHost = '',
        string $nodeName = '',
        int $nodePort = 9001,
    ): array {
        $public = $this->resolvePublicBaseUrl($request);
        $cmd = $this->buildInstallCommand($public, $rawToken, $nodeHost, $nodeName, $nodePort);
        return [
            'Token' => $rawToken,
            'Hint' => '…' . (string) ($row['token_hint'] ?? ''),
            'ExpiresAt' => (int) ($row['expires_at'] ?? 0),
            'MaxUses' => isset($row['max_uses']) && $row['max_uses'] !== null ? (int) $row['max_uses'] : null,
            'NodeHost' => $nodeHost,
            'NodeName' => $nodeName,
            'NodePort' => $nodePort > 0 ? $nodePort : 9001,
            'PublicURL' => $public,
            'AdvertiseURL' => $this->buildAdvertiseUrl($nodeHost, $nodePort),
            'InstallCommand' => $cmd,
            'BundleDownload' => '/api/nodes/agent-bundle',
        ];
    }

    /**
     * ZIP pack for manual agent deploy: sources + Dockerfile + compose + deploy.sh + .env.
     *
     * @param array{id:int,username:string,role:int} $user
     */
    private function downloadAgentBundle(Request $request, array $user): Response
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

    private function resolveAgentSourceDir(): ?string
    {
        $candidates = [
            dirname(__DIR__) . '/agent',
            dirname(__DIR__) . '/public/agent',
        ];
        foreach ($candidates as $dir) {
            if (is_dir($dir) && is_file($dir . '/agent.php') && is_file($dir . '/Dockerfile')) {
                return $dir;
            }
        }
        return null;
    }

    /** @param array<string, string> $vars */
    private function buildAgentEnvFile(array $vars): string
    {
        $lines = [
            '# WharfMaster agent — généré depuis le principal. chmod 600 .env',
            '# Puis: chmod +x deploy.sh && ./deploy.sh',
            '',
        ];
        foreach ($vars as $k => $v) {
            $lines[] = $k . '=' . $v;
        }
        $lines[] = '';
        $lines[] = '# Rempli automatiquement par ./deploy.sh après le join :';
        $lines[] = '# NODE_SECRET=';
        $lines[] = '';
        return implode("\n", $lines);
    }

    private function agentComposeYmlTemplate(): string
    {
        return <<<'YAML'
services:
  agent:
    build: .
    image: ${AGENT_IMAGE:-wharfmaster-agent:local}
    container_name: wharfmaster-agent
    restart: unless-stopped
    environment:
      NODE_SECRET: ${NODE_SECRET:?NODE_SECRET requis}
      DOCKER_SOCKET: /var/run/docker.sock
      AGENT_PORT: "9001"
      AGENT_TLS_CN: ${AGENT_TLS_CN:-wharfmaster-agent}
      AGENT_TLS_DAYS: ${AGENT_TLS_DAYS:-365}
      AGENT_CERT_DIR: /data/certs
      AGENT_STACKS_DIR: /data/stacks
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - wharfmaster-agent-certs:/data/certs
      - ${STACKS_DIR:-/var/lib/wharfmaster/stacks}:/data/stacks
    ports:
      - "${AGENT_HOST_PORT:-9001}:9001"

volumes:
  wharfmaster-agent-certs:
YAML;
    }

    private function agentDeployShTemplate(): string
    {
        $path = dirname(__DIR__) . '/agent/deploy.sh';
        if (is_file($path)) {
            return (string) file_get_contents($path);
        }
        return "#!/bin/sh\necho 'deploy.sh manquant'\nexit 1\n";
    }

    private function agentReadmeTemplate(): string
    {
        $path = dirname(__DIR__) . '/agent/README.md';
        if (is_file($path)) {
            return (string) file_get_contents($path);
        }
        return "# WharfMaster agent\n\nchmod +x deploy.sh && ./deploy.sh\n";
    }

    private function agentEnvExampleTemplate(): string
    {
        $path = dirname(__DIR__) . '/agent/.env.example';
        if (is_file($path)) {
            return (string) file_get_contents($path);
        }
        return "WHARFMASTER_URL=https://VOTRE-SERVEUR\nJOIN_TOKEN=wmj_\nADVERTISE_URL=https://IP:9001\nNODE_NAME=mon-serveur\nAGENT_HOST_PORT=9001\n";
    }

    /** URL publique configurée, sinon origine de la requête courante. */
    private function resolvePublicBaseUrl(?Request $request = null): string
    {
        $public = trim((string) ($this->repo->getSetting('public_url', '') ?? ''));
        if ($public === '') {
            $ep = $this->repo->getEndpoint(1);
            if ($ep && !empty($ep['public_url'])) {
                $public = trim((string) $ep['public_url']);
            }
        }
        if ($public === '' && $request !== null) {
            $host = trim((string) ($request->header('X-Forwarded-Host')
                ?? $request->header('Host')
                ?? ''));
            // first value if comma-separated
            if (str_contains($host, ',')) {
                $host = trim(explode(',', $host, 2)[0]);
            }
            if ($host !== '') {
                $proto = strtolower(trim((string) ($request->header('X-Forwarded-Proto') ?? '')));
                if ($proto === '' || !in_array($proto, ['http', 'https'], true)) {
                    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
                        || ((int) ($_SERVER['SERVER_PORT'] ?? 0) === 443);
                    $proto = $https ? 'https' : 'http';
                }
                $public = $proto . '://' . $host;
            }
        }
        return rtrim($public !== '' ? $public : 'https://VOTRE-SERVEUR', '/');
    }

    private function buildAdvertiseUrl(string $nodeHost, int $nodePort = 9001): string
    {
        $host = trim($nodeHost);
        $host = preg_replace('#^https?://#i', '', $host) ?? $host;
        $host = rtrim($host, '/');
        if ($host === '') {
            return 'https://IP_DU_NOEUD:9001';
        }
        // host:port already provided
        if (preg_match('#^\[.+\]:\d+$#', $host) || preg_match('#^[^/]+:\d+$#', $host)) {
            return 'https://' . $host;
        }
        $port = $nodePort > 0 && $nodePort <= 65535 ? $nodePort : 9001;
        return 'https://' . $host . ':' . $port;
    }

    private function buildInstallCommand(
        string $publicUrl,
        string $token,
        string $nodeHost = '',
        string $nodeName = '',
        int $nodePort = 9001,
    ): string {
        $base = rtrim($publicUrl !== '' ? $publicUrl : 'https://VOTRE-SERVEUR', '/');
        $advertise = $this->buildAdvertiseUrl($nodeHost, $nodePort);
        $name = $nodeName !== '' ? $nodeName : 'mon-serveur';
        // Single-line, ready to paste — uses configured Public URL / host
        $image = (string) ($this->config['agent_image'] ?? 'ghcr.io/mike37510/wharfmaster-agent:2.1.0');
        return 'curl -fsSL ' . escapeshellarg($base . '/public/agent/install.sh')
            . ' | sh -s --'
            . ' --url ' . escapeshellarg($base)
            . ' --token ' . escapeshellarg($token)
            . ' --advertise ' . escapeshellarg($advertise)
            . ' --name ' . escapeshellarg($name)
            . ' --image ' . escapeshellarg($image);
    }

    private function joinNode(Request $request): Response
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
    private function updateNode(int $id, Request $request, array $user): Response
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
    private function unlinkNode(int $id, Request $request, array $user): Response
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
    private function setNodeEnabled(int $id, bool $enabled, Request $request, array $user): Response
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
    private function pingNode(int $id, array $user): Response
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
    private function audit(?array $user, string $action, string $message, ?Request $request = null, array $meta = []): void
    {
        try {
            $ip = $request ? $this->clientIp($request) : '';
            $this->repo->addAuditEvent(
                isset($user['id']) ? (int) $user['id'] : null,
                (string) ($user['username'] ?? ''),
                $action,
                $message,
                $ip,
                $meta,
            );
        } catch (\Throwable $e) {
            error_log('[WharfMaster] audit failed: ' . $e->getMessage());
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function auditDockerMutation(array $user, string $method, string $dockerPath, Request $request): void
    {
        $method = strtoupper($method);
        $path = $dockerPath === '' ? '/' : $dockerPath;
        $action = null;
        $message = null;
        $meta = ['method' => $method, 'path' => $path];

        if ($method === 'POST' && preg_match('#^/containers/([^/]+)/start$#', $path, $m)) {
            $action = 'docker.container.start';
            $message = 'Démarrage du conteneur ' . $m[1];
            $meta['containerId'] = $m[1];
        } elseif ($method === 'POST' && preg_match('#^/containers/([^/]+)/stop#', $path, $m)) {
            $action = 'docker.container.stop';
            $message = 'Arrêt du conteneur ' . $m[1];
            $meta['containerId'] = $m[1];
        } elseif ($method === 'POST' && preg_match('#^/containers/([^/]+)/restart#', $path, $m)) {
            $action = 'docker.container.restart';
            $message = 'Redémarrage du conteneur ' . $m[1];
            $meta['containerId'] = $m[1];
        } elseif ($method === 'POST' && preg_match('#^/containers/create#', $path)) {
            $action = 'docker.container.create';
            $message = 'Création d’un conteneur';
            $name = (string) ($request->query('name') ?? '');
            if ($name !== '') {
                $message .= ' « ' . $name . ' »';
                $meta['name'] = $name;
            }
        } elseif ($method === 'DELETE' && preg_match('#^/containers/([^/]+)#', $path, $m)) {
            $action = 'docker.container.remove';
            $message = 'Suppression du conteneur ' . $m[1];
            $meta['containerId'] = $m[1];
        } elseif ($method === 'POST' && preg_match('#^/images/create#', $path)) {
            $action = 'docker.image.pull';
            $from = (string) ($request->query('fromImage') ?? $request->query('fromSrc') ?? '');
            $message = 'Pull d’image' . ($from !== '' ? ' « ' . $from . ' »' : '');
            $meta['image'] = $from;
        } elseif ($method === 'DELETE' && preg_match('#^/images/(.+)$#', $path, $m)) {
            $action = 'docker.image.remove';
            $message = 'Suppression de l’image ' . rawurldecode($m[1]);
            $meta['image'] = rawurldecode($m[1]);
        } elseif ($method === 'POST' && preg_match('#^/volumes/create#', $path)) {
            $action = 'docker.volume.create';
            $message = 'Création d’un volume';
        } elseif ($method === 'DELETE' && preg_match('#^/volumes/(.+)$#', $path, $m)) {
            $action = 'docker.volume.remove';
            $message = 'Suppression du volume ' . rawurldecode($m[1]);
            $meta['volume'] = rawurldecode($m[1]);
        } elseif ($method === 'POST' && preg_match('#^/networks/create#', $path)) {
            $action = 'docker.network.create';
            $message = 'Création d’un réseau';
        } elseif ($method === 'DELETE' && preg_match('#^/networks/(.+)$#', $path, $m)) {
            $action = 'docker.network.remove';
            $message = 'Suppression du réseau ' . rawurldecode($m[1]);
            $meta['network'] = rawurldecode($m[1]);
        } elseif ($method === 'POST' && preg_match('#^/(containers|images|networks|build)/prune#', $path, $m)) {
            $action = 'docker.prune.' . $m[1];
            $message = 'Nettoyage Docker (' . $m[1] . ')';
        }

        if ($action !== null && $message !== null) {
            $this->audit($user, $action, $message, $request, $meta);
        }
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function listAudit(Request $request, array $user): Response
    {
        $isAdmin = (int) ($user['role'] ?? 0) === 1;
        $limit = (int) ($request->query('limit') ?? 100);
        $offset = (int) ($request->query('offset') ?? 0);
        $action = trim((string) ($request->query('action') ?? ''));
        $actionFilter = $action !== '' ? $action : null;
        $userFilter = $isAdmin ? null : (int) $user['id'];

        $rows = $this->repo->listAuditEvents($limit, $offset, $actionFilter, $userFilter);
        $total = $this->repo->countAuditEvents($actionFilter, $userFilter);

        $items = array_map(static function (array $row): array {
            $meta = json_decode((string) ($row['meta_json'] ?? '{}'), true);
            if (!is_array($meta)) {
                $meta = [];
            }
            return [
                'Id' => (int) $row['id'],
                'CreatedAt' => (int) $row['created_at'],
                'UserId' => $row['user_id'] !== null ? (int) $row['user_id'] : null,
                'Username' => (string) ($row['username'] ?? ''),
                'Action' => (string) $row['action'],
                'Message' => (string) $row['message'],
                'Ip' => (string) ($row['ip'] ?? ''),
                'Meta' => $meta,
            ];
        }, $rows);

        return Response::json([
            'Total' => $total,
            'Items' => $items,
        ]);
    }

    // --- Portainer CE compatibility helpers ---

    /**
     * Map WM ACL roles → Portainer RoleId on endpoints.
     * 1 ≈ endpoint admin, 2 ≈ helpdesk/operate, 3 ≈ readonly
     */
    private function aclRoleToPortainerRoleId(string $role): int
    {
        return match ($role) {
            EndpointAcl::ADMIN => 1,
            EndpointAcl::OPERATE => 2,
            EndpointAcl::READ => 3,
            default => 2,
        };
    }

    private function portainerRoleIdToAclRole(int $roleId): string
    {
        return match ($roleId) {
            1 => EndpointAcl::ADMIN,
            3 => EndpointAcl::READ,
            default => EndpointAcl::OPERATE,
        };
    }

    /**
     * @return array{0:object|array<string,array{RoleId:int}>,1:object|array<string,array{RoleId:int}>}
     */
    private function portainerAccessPolicies(int $endpointId): array
    {
        $userPolicies = [];
        $teamPolicies = [];
        foreach ($this->repo->listEndpointAcls($endpointId) as $row) {
            $stype = (string) ($row['subject_type'] ?? '');
            $sid = (string) (int) ($row['subject_id'] ?? 0);
            $roleId = $this->aclRoleToPortainerRoleId((string) ($row['role'] ?? 'operate'));
            if ($stype === 'user') {
                $userPolicies[$sid] = ['RoleId' => $roleId];
            } elseif ($stype === 'team') {
                $teamPolicies[$sid] = ['RoleId' => $roleId];
            }
        }
        return [
            $userPolicies === [] ? new \stdClass() : $userPolicies,
            $teamPolicies === [] ? new \stdClass() : $teamPolicies,
        ];
    }

    /** @param array<string, mixed> $ldap */
    private function formatLdapSettingsPortainer(array $ldap): array
    {
        $host = (string) ($ldap['host'] ?? '');
        $port = (int) ($ldap['port'] ?? 389);
        $url = $host;
        if ($host !== '' && $port > 0) {
            $url = $host . ':' . $port;
        }
        return [
            'AnonymousMode' => false,
            'ReaderDN' => (string) ($ldap['bind_dn'] ?? ''),
            'Password' => '',
            'URL' => $url,
            'TLSConfig' => [
                'TLS' => !empty($ldap['use_ssl']),
                'TLSSkipVerify' => false,
                'StartTLS' => !empty($ldap['use_tls']),
            ],
            'StartTLS' => !empty($ldap['use_tls']),
            'SearchSettings' => [[
                'BaseDN' => (string) ($ldap['base_dn'] ?? ''),
                'Filter' => (string) ($ldap['user_filter'] ?? '(sAMAccountName={username})'),
                'UserNameAttribute' => (string) ($ldap['username_attr'] ?? 'sAMAccountName'),
            ]],
            'GroupSearchSettings' => [],
            'AutoCreateUsers' => true,
        ];
    }

    /** @param array<string, mixed> $ldap */
    private function saveLdapSettingsFromPortainer(array $ldap): void
    {
        $url = trim((string) ($ldap['URL'] ?? $ldap['url'] ?? ''));
        $host = $url;
        $port = 389;
        if (str_contains($url, ':')) {
            $parts = explode(':', $url);
            // host:port (ignore scheme if present)
            $host = preg_replace('#^ldaps?://#i', '', $parts[0]) ?: $parts[0];
            if (isset($parts[1]) && ctype_digit($parts[1])) {
                $port = (int) $parts[1];
            }
            if (count($parts) > 2 && ctype_digit($parts[count($parts) - 1])) {
                $port = (int) $parts[count($parts) - 1];
                $host = preg_replace('#^ldaps?://#i', '', implode(':', array_slice($parts, 0, -1))) ?: $host;
            }
        }
        $search = [];
        if (isset($ldap['SearchSettings'][0]) && is_array($ldap['SearchSettings'][0])) {
            $search = $ldap['SearchSettings'][0];
        }
        $tls = is_array($ldap['TLSConfig'] ?? null) ? $ldap['TLSConfig'] : [];
        $mapped = [
            'Enabled' => true,
            'Host' => $host,
            'Port' => $port,
            'UseTls' => !empty($ldap['StartTLS'] ?? $tls['StartTLS'] ?? false),
            'UseSsl' => !empty($tls['TLS'] ?? false),
            'BaseDn' => (string) ($search['BaseDN'] ?? ''),
            'BindDn' => (string) ($ldap['ReaderDN'] ?? ''),
            'UserFilter' => (string) ($search['Filter'] ?? '(sAMAccountName={username})'),
            'UsernameAttr' => (string) ($search['UserNameAttribute'] ?? 'sAMAccountName'),
        ];
        $pass = $ldap['Password'] ?? null;
        if (is_string($pass) && $pass !== '') {
            $mapped['BindPassword'] = $pass;
        }
        // AuthenticationMethod=2 typically accompanies LDAPSettings write
        $authMethod = $this->repo->getSetting('ldap_json', '');
        $this->saveLdapSettings($mapped);
        unset($authMethod);
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function updateEndpointPortainer(int $id, Request $request, array $user): Response
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
    private function syncPortainerPolicies(int $endpointId, string $subjectType, array $policies): void
    {
        $existing = $this->repo->listEndpointAcls($endpointId);
        foreach ($existing as $row) {
            if ((string) ($row['subject_type'] ?? '') === $subjectType) {
                $this->repo->deleteEndpointAcl((int) $row['id']);
            }
        }
        foreach ($policies as $sid => $policy) {
            $subjectId = (int) $sid;
            if ($subjectId <= 0) {
                continue;
            }
            $roleId = 2;
            if (is_array($policy)) {
                $roleId = (int) ($policy['RoleId'] ?? $policy['roleId'] ?? $policy['Role'] ?? 2);
            } elseif (is_object($policy)) {
                $roleId = (int) ($policy->RoleId ?? $policy->roleId ?? 2);
            }
            $role = $this->portainerRoleIdToAclRole($roleId);
            if ($subjectType === 'user' && !$this->repo->findUserById($subjectId)) {
                continue;
            }
            if ($subjectType === 'team' && !$this->repo->getTeam($subjectId)) {
                continue;
            }
            $this->repo->upsertEndpointAcl($endpointId, $subjectType, $subjectId, $role);
        }
    }

    /** Synthetic membership id: teamId * 1_000_000 + userId */
    private function membershipId(int $teamId, int $userId): int
    {
        return ($teamId * 1_000_000) + $userId;
    }

    /** @return array{0:int,1:int}|null */
    private function parseMembershipId(int $id): ?array
    {
        if ($id < 1_000_001) {
            return null;
        }
        $teamId = intdiv($id, 1_000_000);
        $userId = $id % 1_000_000;
        if ($teamId <= 0 || $userId <= 0) {
            return null;
        }
        return [$teamId, $userId];
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function listTeamMembershipsPortainer(array $user): Response
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
    private function listTeamMembershipsForTeam(int $teamId, array $user): Response
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
    private function createTeamMembershipPortainer(Request $request, array $user): Response
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
    private function deleteTeamMembershipPortainer(int $id, Request $request, array $user): Response
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
    private function getUserPortainer(int $id, array $user): Response
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
    private function ldapConfig(): array
    {
        $raw = (string) ($this->repo->getSetting('ldap_json', '{}') ?? '{}');
        $cfg = json_decode($raw, true);
        if (!is_array($cfg)) {
            $cfg = [];
        }
        if (!empty($cfg['bind_password_enc']) && is_string($cfg['bind_password_enc'])) {
            try {
                $cfg['bind_password'] = $this->secrets->decrypt($cfg['bind_password_enc']);
            } catch (\Throwable) {
                $cfg['bind_password'] = '';
            }
        }
        return $cfg;
    }

    /** @param array<string, mixed> $ldap */
    private function saveLdapSettings(array $ldap): void
    {
        $prev = $this->ldapConfig();
        $cfg = [
            'enabled' => !empty($ldap['Enabled'] ?? $ldap['enabled'] ?? false),
            'host' => trim((string) ($ldap['Host'] ?? $ldap['host'] ?? '')),
            'port' => (int) ($ldap['Port'] ?? $ldap['port'] ?? 389),
            'use_tls' => !empty($ldap['UseTls'] ?? $ldap['use_tls'] ?? false),
            'use_ssl' => !empty($ldap['UseSsl'] ?? $ldap['use_ssl'] ?? false),
            'base_dn' => trim((string) ($ldap['BaseDn'] ?? $ldap['base_dn'] ?? '')),
            'bind_dn' => trim((string) ($ldap['BindDn'] ?? $ldap['bind_dn'] ?? '')),
            'user_filter' => trim((string) ($ldap['UserFilter'] ?? $ldap['user_filter'] ?? '(sAMAccountName={username})')),
            'username_attr' => trim((string) ($ldap['UsernameAttr'] ?? $ldap['username_attr'] ?? 'sAMAccountName')),
        ];
        $newPass = $ldap['BindPassword'] ?? $ldap['bind_password'] ?? null;
        if (is_string($newPass) && $newPass !== '') {
            $cfg['bind_password_enc'] = $this->secrets->encrypt($newPass);
        } elseif (!empty($prev['bind_password_enc'])) {
            $cfg['bind_password_enc'] = $prev['bind_password_enc'];
        }
        unset($cfg['bind_password']);
        $this->repo->setSetting('ldap_json', json_encode($cfg, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '{}');
    }

    // --- Teams ---

    /** Portainer CE: bare array `[{ Id, Name }, …]`. */
    private function listTeams(array $user): Response
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
    private function listTeamsDetailed(array $user): Response
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
    private function getTeam(int $id, array $user): Response
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
    private function createTeam(Request $request, array $user): Response
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
    private function updateTeam(int $id, Request $request, array $user): Response
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
    private function deleteTeam(int $id, Request $request, array $user): Response
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
    private function addTeamMember(int $teamId, Request $request, array $user): Response
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
    private function removeTeamMember(int $teamId, int $memberId, Request $request, array $user): Response
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
    private function formatTeam(array $t, array $members): array
    {
        return [
            'Id' => (int) $t['id'],
            'Name' => (string) $t['name'],
            'Description' => (string) ($t['description'] ?? ''),
            'AdGroupDn' => (string) ($t['ad_group_dn'] ?? ''),
            'CreatedAt' => (int) ($t['created_at'] ?? 0),
            'Members' => array_map(static function (array $m): array {
                return [
                    'Id' => (int) $m['id'],
                    'Username' => (string) $m['username'],
                    'Role' => (int) $m['role'],
                    'AuthSource' => (string) ($m['auth_source'] ?? 'local'),
                ];
            }, $members),
        ];
    }

    // --- ACLs ---

    /** @param array{id:int,username:string,role:int} $user */
    private function listAcls(Request $request, array $user): Response
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
    private function upsertAcl(Request $request, array $user): Response
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
    private function deleteAcl(int $id, Request $request, array $user): Response
    {
        if ($err = $this->requireAdmin($user)) {
            return $err;
        }
        $this->repo->deleteEndpointAcl($id);
        $this->audit($user, 'acl.delete', 'ACL nœud supprimée', $request, ['aclId' => $id]);
        return Response::empty(204);
    }

    /** @param array<string, mixed> $row */
    private function formatAcl(array $row): array
    {
        $stype = (string) ($row['subject_type'] ?? '');
        $sid = (int) ($row['subject_id'] ?? 0);
        $name = '';
        if ($stype === 'user') {
            $u = $this->repo->findUserById($sid);
            $name = $u ? (string) $u['username'] : '';
        } elseif ($stype === 'team') {
            $t = $this->repo->getTeam($sid);
            $name = $t ? (string) $t['name'] : '';
        }
        return [
            'Id' => (int) ($row['id'] ?? 0),
            'EndpointId' => (int) ($row['endpoint_id'] ?? 0),
            'SubjectType' => $stype,
            'SubjectId' => $sid,
            'SubjectName' => $name,
            'Role' => (string) ($row['role'] ?? ''),
        ];
    }

    // --- Schedules ---

    private function ensureSchedulerApiKey(): void
    {
        $path = dirname((string) $this->config['sqlite_path']) . '/scheduler.api_key';
        if (is_file($path) && trim((string) file_get_contents($path)) !== '') {
            if (($this->repo->getSetting('scheduler_api_key_hint', '') ?? '') === '') {
                $raw = trim((string) file_get_contents($path));
                $this->repo->setSetting('scheduler_api_key_hint', substr($raw, -4));
            }
            return;
        }
        // Wait until a real admin exists (do not block adminInit)
        if ($this->repo->userCount() === 0) {
            return;
        }
        $admins = array_values(array_filter(
            $this->repo->listUsers(),
            static fn(array $u): bool => (int) ($u['role'] ?? 0) === 1
                && (string) ($u['username'] ?? '') !== '__scheduler__',
        ));
        if ($admins === []) {
            return;
        }
        $raw = 'ptr_' . bin2hex(random_bytes(24));
        $this->repo->createApiKey((int) $admins[0]['id'], 'scheduler-sidecar', $raw);
        @file_put_contents($path, $raw);
        @chmod($path, 0600);
        $this->repo->setSetting('scheduler_api_key_hint', substr($raw, -4));
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function listSchedules(Request $request, array $user): Response
    {
        $stackId = $request->query('stackId');
        $endpointId = $request->query('endpointId');
        $sid = $stackId !== null && $stackId !== '' ? (int) $stackId : null;
        $eid = $endpointId !== null && $endpointId !== '' ? (int) $endpointId : null;
        if ($sid !== null) {
            $stack = $this->repo->getStack($sid);
            if (!$stack || !$this->canAccessStack($stack, $user)) {
                return Response::error('Stack introuvable', 404);
            }
        } elseif (!Ownership::isGlobalAdmin($user)) {
            return Response::error('Accès administrateur requis', 403);
        }
        $rows = $this->repo->listSchedules($sid, $eid);
        return Response::json(['Items' => array_map([$this, 'formatSchedule'], $rows)]);
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function getScheduleApi(int $id, array $user): Response
    {
        $row = $this->repo->getSchedule($id);
        if (!$row) {
            return Response::error('Planification introuvable', 404);
        }
        if (!$this->canAccessSchedule($row, $user)) {
            return Response::error('Accès refusé', 403);
        }
        return Response::json($this->formatSchedule($row));
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function createSchedule(Request $request, array $user): Response
    {
        $body = $request->json();
        $stackId = (int) ($body['StackId'] ?? $body['stack_id'] ?? $body['TargetId'] ?? 0);
        $action = strtolower(trim((string) ($body['Action'] ?? $body['action'] ?? '')));
        $cron = trim((string) ($body['Cron'] ?? $body['cron_expr'] ?? $body['CronExpr'] ?? ''));
        $name = trim((string) ($body['Name'] ?? $body['name'] ?? ''));
        $tz = trim((string) ($body['Timezone'] ?? $body['timezone'] ?? 'UTC')) ?: 'UTC';
        if (!in_array($action, ['start', 'stop', 'restart'], true)) {
            return Response::error('Action invalide (start|stop|restart)', 400);
        }
        if (!CronExpr::isValid($cron)) {
            return Response::error('Expression cron invalide (5 champs)', 400);
        }
        $stack = $this->repo->getStack($stackId);
        if (!$stack || !$this->canOperateStack($stack, $user)) {
            return Response::error('Stack introuvable ou accès refusé', 404);
        }
        if ($name === '') {
            $name = $action . ' · ' . $stack['name'];
        }
        $next = CronExpr::nextAfter($cron, time());
        $row = $this->repo->createSchedule(
            $name,
            (int) $stack['endpoint_id'],
            'stack',
            $stackId,
            $action,
            $cron,
            $tz,
            Ownership::username($user),
            $next,
        );
        $this->audit($user, 'schedule.create', 'Planification créée pour « ' . $stack['name'] . ' »', $request, [
            'scheduleId' => (int) ($row['id'] ?? 0),
            'action' => $action,
            'cron' => $cron,
        ]);
        return Response::json($this->formatSchedule($row), 201);
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function updateSchedule(int $id, Request $request, array $user): Response
    {
        $row = $this->repo->getSchedule($id);
        if (!$row || !$this->canAccessSchedule($row, $user)) {
            return Response::error('Planification introuvable', 404);
        }
        if (!$this->canOperateSchedule($row, $user)) {
            return Response::error('Permissions insuffisantes', 403);
        }
        $body = $request->json();
        $name = trim((string) ($body['Name'] ?? $body['name'] ?? $row['name']));
        $action = strtolower(trim((string) ($body['Action'] ?? $body['action'] ?? $row['action'])));
        $cron = trim((string) ($body['Cron'] ?? $body['cron_expr'] ?? $body['CronExpr'] ?? $row['cron_expr']));
        $tz = trim((string) ($body['Timezone'] ?? $body['timezone'] ?? $row['timezone'])) ?: 'UTC';
        $enabled = array_key_exists('Enabled', $body) || array_key_exists('enabled', $body)
            ? !empty($body['Enabled'] ?? $body['enabled'])
            : ((int) $row['enabled'] === 1);
        if (!in_array($action, ['start', 'stop', 'restart'], true)) {
            return Response::error('Action invalide', 400);
        }
        if (!CronExpr::isValid($cron)) {
            return Response::error('Expression cron invalide', 400);
        }
        $next = $enabled ? CronExpr::nextAfter($cron, time()) : null;
        $updated = $this->repo->updateSchedule($id, $name, $action, $cron, $tz, $enabled, $next);
        $this->audit($user, 'schedule.update', 'Planification mise à jour', $request, ['scheduleId' => $id]);
        return Response::json($this->formatSchedule($updated ?? $row));
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function deleteSchedule(int $id, Request $request, array $user): Response
    {
        $row = $this->repo->getSchedule($id);
        if (!$row || !$this->canAccessSchedule($row, $user)) {
            return Response::error('Planification introuvable', 404);
        }
        if (!$this->canOperateSchedule($row, $user)) {
            return Response::error('Permissions insuffisantes', 403);
        }
        $this->repo->deleteSchedule($id);
        $this->audit($user, 'schedule.delete', 'Planification supprimée', $request, ['scheduleId' => $id]);
        return Response::empty(204);
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function runScheduleNow(int $id, Request $request, array $user): Response
    {
        $row = $this->repo->getSchedule($id);
        if (!$row || !$this->canAccessSchedule($row, $user)) {
            return Response::error('Planification introuvable', 404);
        }
        if (!$this->canOperateSchedule($row, $user)) {
            return Response::error('Permissions insuffisantes', 403);
        }
        return $this->executeScheduleRow($row, $request, $user, true);
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function runDueSchedules(Request $request, array $user): Response
    {
        if (!Ownership::isGlobalAdmin($user)) {
            return Response::error('Accès refusé', 403);
        }
        $now = time();
        $due = $this->repo->listDueSchedules($now);
        $results = [];
        foreach ($due as $row) {
            $res = $this->executeScheduleRow($row, $request, $user, false);
            $results[] = [
                'Id' => (int) $row['id'],
                'Status' => $res->status,
            ];
        }
        return Response::json(['Ran' => count($results), 'Results' => $results]);
    }

    /**
     * @param array<string, mixed> $row
     * @param array{id:int,username:string,role:int} $user
     */
    private function executeScheduleRow(array $row, Request $request, array $user, bool $manual): Response
    {
        $action = (string) $row['action'];
        $targetId = (int) $row['target_id'];
        $cron = (string) $row['cron_expr'];
        try {
            $ctrl = $this->controlStack($targetId, $action, $request, $user);
            if ($ctrl->status >= 400) {
                $this->repo->markScheduleRun(
                    (int) $row['id'],
                    'error',
                    'HTTP ' . $ctrl->status,
                    CronExpr::nextAfter($cron, time()),
                );
                return $ctrl;
            }
            $this->repo->markScheduleRun(
                (int) $row['id'],
                $manual ? 'ok-manual' : 'ok',
                '',
                CronExpr::nextAfter($cron, time()),
            );
            $this->audit($user, 'schedule.run', 'Exécution planification #' . $row['id'] . ' (' . $action . ')', $request, [
                'scheduleId' => (int) $row['id'],
                'manual' => $manual,
            ]);
            return $ctrl;
        } catch (\Throwable $e) {
            $this->repo->markScheduleRun(
                (int) $row['id'],
                'error',
                $e->getMessage(),
                CronExpr::nextAfter($cron, time()),
            );
            return Response::error($e->getMessage(), 500);
        }
    }

    /** @param array<string, mixed> $row @param array{id:int,username:string,role:int} $user */
    private function canAccessSchedule(array $row, array $user): bool
    {
        if (Ownership::isGlobalAdmin($user)) {
            return true;
        }
        if ((string) ($row['target_type'] ?? '') !== 'stack') {
            return false;
        }
        $stack = $this->repo->getStack((int) $row['target_id']);
        return $stack ? $this->canAccessStack($stack, $user) : false;
    }

    /** @param array<string, mixed> $row @param array{id:int,username:string,role:int} $user */
    private function canOperateSchedule(array $row, array $user): bool
    {
        if (Ownership::isGlobalAdmin($user)) {
            return true;
        }
        $stack = $this->repo->getStack((int) $row['target_id']);
        return $stack ? $this->canOperateStack($stack, $user) : false;
    }

    /** @param array<string, mixed> $row */
    private function formatSchedule(array $row): array
    {
        return [
            'Id' => (int) $row['id'],
            'Name' => (string) $row['name'],
            'EndpointId' => (int) $row['endpoint_id'],
            'TargetType' => (string) $row['target_type'],
            'TargetId' => (int) $row['target_id'],
            'StackId' => (int) $row['target_id'],
            'Action' => (string) $row['action'],
            'Cron' => (string) $row['cron_expr'],
            'Timezone' => (string) $row['timezone'],
            'Enabled' => (int) $row['enabled'] === 1,
            'LastRunAt' => $row['last_run_at'] !== null ? (int) $row['last_run_at'] : null,
            'NextRunAt' => $row['next_run_at'] !== null ? (int) $row['next_run_at'] : null,
            'LastStatus' => (string) ($row['last_status'] ?? ''),
            'LastError' => (string) ($row['last_error'] ?? ''),
            'CreatedBy' => (string) ($row['created_by'] ?? ''),
            'CreatedAt' => (int) ($row['created_at'] ?? 0),
        ];
    }

    // --- Image CVE scans ---

    /**
     * Soft CVE check for create/deploy flows: never blocks the caller.
     * Prefer cache; on Trivy/agent failure return Status=skipped with a Warning.
     *
     * @param array{id:int,username:string,role:int} $user
     */
    private function adviseImages(int $endpointId, Request $request, array $user): Response
    {
        if (!$this->endpointAcl->can($user, $endpointId, EndpointAcl::READ)) {
            return Response::error('Accès refusé à ce nœud', 403);
        }
        if (!$this->trivyEnabled()) {
            return Response::json([
                'Items' => [],
                'TrivyAvailable' => false,
                'TrivyEnabled' => false,
                'Blocking' => false,
                'Worst' => 'disabled',
                'Warning' => 'Scan CVE désactivé dans les paramètres',
            ]);
        }
        $ep = $this->repo->getEndpoint($endpointId);
        if (!$ep) {
            return Response::error('Nœud introuvable', 404);
        }
        $body = $request->json();
        $refs = [];
        if (isset($body['Images']) && is_array($body['Images'])) {
            foreach ($body['Images'] as $img) {
                $refs[] = trim((string) $img);
            }
        }
        $single = trim((string) ($body['Image'] ?? $body['image'] ?? $body['Ref'] ?? $body['ref'] ?? ''));
        if ($single !== '') {
            $refs[] = $single;
        }
        $compose = (string) ($body['Compose'] ?? $body['compose'] ?? $body['StackFileContent'] ?? '');
        if ($compose !== '') {
            $refs = array_merge($refs, $this->extractComposeImageRefs($compose));
        }
        $refs = array_values(array_unique(array_filter($refs, static fn (string $r): bool => $r !== '')));
        $refs = array_slice($refs, 0, 12);

        $items = [];
        $kind = (string) ($ep['kind'] ?? 'local');
        $trivyOk = $kind === 'agent' ? true : $this->imageScanner->available();
        foreach ($refs as $ref) {
            $items[] = $this->softAdviseOneImage($ep, $endpointId, $ref);
        }

        $worst = 'ok';
        foreach ($items as $it) {
            $st = (string) ($it['Status'] ?? '');
            if ($st === 'skipped' && $worst === 'ok') {
                $worst = 'skipped';
            }
            $sum = is_array($it['Summary'] ?? null) ? $it['Summary'] : [];
            if ((int) ($sum['CRITICAL'] ?? 0) > 0) {
                $worst = 'critical';
                break;
            }
            if ((int) ($sum['HIGH'] ?? 0) > 0) {
                $worst = 'high';
            } elseif ($worst !== 'high' && (int) ($sum['TOTAL'] ?? 0) > 0) {
                $worst = 'findings';
            }
        }

        return Response::json([
            'Items' => $items,
            'TrivyAvailable' => $trivyOk,
            'TrivyEnabled' => true,
            'Blocking' => false,
            'Worst' => $worst,
        ]);
    }

    /**
     * @param array<string, mixed> $ep
     * @return array<string, mixed>
     */
    private function softAdviseOneImage(array $ep, int $endpointId, string $ref): array
    {
        $cached = $this->repo->getLatestImageScan($endpointId, $ref, '');
        if ($cached && (int) ($cached['scanned_at'] ?? 0) > time() - ImageUpdateChecker::STACK_CACHE_TTL) {
            $summary = json_decode((string) ($cached['summary_json'] ?? '{}'), true);
            return [
                'ImageRef' => $ref,
                'Status' => (string) ($cached['status'] ?? 'ok'),
                'ScannedAt' => (int) $cached['scanned_at'],
                'Summary' => is_array($summary) ? $summary : [],
                'FromCache' => true,
                'Warning' => null,
                'CacheTtl' => ImageUpdateChecker::STACK_CACHE_TTL,
            ];
        }

        $kind = (string) ($ep['kind'] ?? 'local');
        try {
            if ($kind === 'agent') {
                $parsed = $this->scanImageViaAgent($ep, $ref);
            } else {
                if (!$this->imageScanner->available()) {
                    return [
                        'ImageRef' => $ref,
                        'Status' => 'skipped',
                        'ScannedAt' => null,
                        'Summary' => [],
                        'FromCache' => false,
                        'Warning' => 'Trivy indisponible — déploiement non bloqué',
                    ];
                }
                $parsed = $this->imageScanner->scanImage($ref);
            }
            $row = $this->repo->saveImageScan(
                $endpointId,
                $ref,
                '',
                (string) ($parsed['status'] ?? 'ok'),
                $parsed['summary'] ?? [],
                (string) ($parsed['raw'] ?? ''),
                $parsed['findings'] ?? [],
            );
            return [
                'ImageRef' => $ref,
                'Status' => (string) ($row['status'] ?? 'ok'),
                'ScannedAt' => (int) ($row['scanned_at'] ?? time()),
                'Summary' => $parsed['summary'] ?? [],
                'FromCache' => false,
                'Warning' => null,
            ];
        } catch (\Throwable $e) {
            return [
                'ImageRef' => $ref,
                'Status' => 'skipped',
                'ScannedAt' => null,
                'Summary' => [],
                'FromCache' => false,
                'Warning' => 'Scan CVE impossible : ' . $e->getMessage() . ' — déploiement non bloqué',
            ];
        }
    }

    /** @return list<string> */
    private function extractComposeImageRefs(string $compose): array
    {
        $refs = [];
        if (preg_match_all('/^\s*image:\s*["\']?([^\s"\'#]+)/mi', $compose, $m)) {
            foreach ($m[1] as $raw) {
                $ref = trim((string) $raw);
                if ($ref !== '' && !str_starts_with($ref, '$')) {
                    $refs[] = $ref;
                }
            }
        }
        return array_values(array_unique($refs));
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function listImageScans(int $endpointId, array $user): Response
    {
        if (!$this->endpointAcl->can($user, $endpointId, EndpointAcl::READ)) {
            return Response::error('Accès refusé à ce nœud', 403);
        }
        $enabled = $this->trivyEnabled();
        if (!$enabled) {
            return Response::json([
                'Items' => [],
                'TrivyAvailable' => false,
                'TrivyEnabled' => false,
            ]);
        }
        $rows = $this->repo->listImageScanSummaries($endpointId);
        $items = [];
        foreach ($rows as $row) {
            $summary = json_decode((string) ($row['summary_json'] ?? '{}'), true);
            if (!is_array($summary)) {
                $summary = [];
            }
            $items[] = [
                'Id' => (int) $row['id'],
                'ImageRef' => (string) $row['image_ref'],
                'Digest' => (string) ($row['digest'] ?? ''),
                'Status' => (string) $row['status'],
                'ScannedAt' => $row['scanned_at'] !== null ? (int) $row['scanned_at'] : null,
                'Summary' => $summary,
            ];
        }
        return Response::json([
            'Items' => $items,
            'TrivyAvailable' => $this->imageScanner->available(),
            'TrivyEnabled' => true,
            'CacheTtl' => ImageUpdateChecker::STACK_CACHE_TTL,
        ]);
    }

    /**
     * Ensure CVE scans exist for the given image refs (cache TTL = image update checks).
     * Soft / fail-open — used when opening the Images page.
     *
     * @param array{id:int,username:string,role:int} $user
     */
    private function ensureImageScans(int $endpointId, Request $request, array $user): Response
    {
        if (!$this->endpointAcl->can($user, $endpointId, EndpointAcl::READ)) {
            return Response::error('Accès refusé à ce nœud', 403);
        }
        if (!$this->trivyEnabled()) {
            return Response::json([
                'Items' => [],
                'TrivyAvailable' => false,
                'TrivyEnabled' => false,
                'CacheTtl' => ImageUpdateChecker::STACK_CACHE_TTL,
            ]);
        }
        $ep = $this->repo->getEndpoint($endpointId);
        if (!$ep) {
            return Response::error('Nœud introuvable', 404);
        }
        $body = $request->json();
        $refs = [];
        if (isset($body['Images']) && is_array($body['Images'])) {
            foreach ($body['Images'] as $img) {
                $refs[] = trim((string) $img);
            }
        }
        $single = trim((string) ($body['Image'] ?? $body['image'] ?? $body['Ref'] ?? $body['ref'] ?? ''));
        if ($single !== '') {
            $refs[] = $single;
        }
        $refs = array_values(array_unique(array_filter($refs, static fn (string $r): bool => $r !== '' && $r !== '<none>:<none>')));
        $refs = array_slice($refs, 0, 80);

        $items = [];
        $kind = (string) ($ep['kind'] ?? 'local');
        $trivyOk = $kind === 'agent' ? true : $this->imageScanner->available();
        foreach ($refs as $ref) {
            $items[] = $this->softAdviseOneImage($ep, $endpointId, $ref);
        }

        return Response::json([
            'Items' => $items,
            'TrivyAvailable' => $trivyOk,
            'TrivyEnabled' => true,
            'CacheTtl' => ImageUpdateChecker::STACK_CACHE_TTL,
        ]);
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function getImageScan(int $endpointId, Request $request, array $user): Response
    {
        if (!$this->endpointAcl->can($user, $endpointId, EndpointAcl::READ)) {
            return Response::error('Accès refusé à ce nœud', 403);
        }
        $ref = trim((string) ($request->query('ref') ?? $request->query('image') ?? ''));
        $digest = trim((string) ($request->query('digest') ?? ''));
        if ($ref === '' && $digest === '') {
            return Response::error('Paramètre ref ou digest requis', 400);
        }
        $row = $this->repo->getLatestImageScan($endpointId, $ref, $digest);
        if (!$row) {
            return Response::error('Aucun scan', 404);
        }
        $summary = json_decode((string) ($row['summary_json'] ?? '{}'), true);
        if (!is_array($summary)) {
            $summary = [];
        }
        $findings = $this->repo->listImageFindings((int) $row['id']);
        return Response::json([
            'Id' => (int) $row['id'],
            'ImageRef' => (string) $row['image_ref'],
            'Digest' => (string) ($row['digest'] ?? ''),
            'Status' => (string) $row['status'],
            'ScannedAt' => $row['scanned_at'] !== null ? (int) $row['scanned_at'] : null,
            'Summary' => $summary,
            'Findings' => array_map(static function (array $f): array {
                return [
                    'Cve' => (string) $f['cve'],
                    'Package' => (string) $f['package'],
                    'Version' => (string) $f['version'],
                    'Severity' => (string) $f['severity'],
                    'Title' => (string) $f['title'],
                    'FixedVersion' => (string) $f['fixed_version'],
                ];
            }, $findings),
        ]);
    }

    /** @param array{id:int,username:string,role:int} $user */
    private function scanImage(int $endpointId, Request $request, array $user): Response
    {
        if (!$this->endpointAcl->can($user, $endpointId, EndpointAcl::OPERATE)) {
            return Response::error('Permissions insuffisantes', 403);
        }
        if (!$this->trivyEnabled()) {
            return Response::error('Scan CVE désactivé dans les paramètres', 403);
        }
        $ep = $this->repo->getEndpoint($endpointId);
        if (!$ep) {
            return Response::error('Nœud introuvable', 404);
        }
        $body = $request->json();
        $ref = trim((string) ($body['Image'] ?? $body['image'] ?? $body['Ref'] ?? $body['ref'] ?? ''));
        $digest = trim((string) ($body['Digest'] ?? $body['digest'] ?? ''));
        $force = !empty($body['Force'] ?? $body['force'] ?? false);
        if ($ref === '') {
            return Response::error('Image requise', 400);
        }

        if (!$force) {
            $cached = $this->repo->getLatestImageScan($endpointId, $ref, $digest);
            $ttl = ImageUpdateChecker::STACK_CACHE_TTL;
            if ($cached && (int) ($cached['scanned_at'] ?? 0) > time() - $ttl) {
                $summary = json_decode((string) ($cached['summary_json'] ?? '{}'), true);
                $findings = $this->repo->listImageFindings((int) $cached['id']);
                return Response::json([
                    'Id' => (int) $cached['id'],
                    'ImageRef' => (string) $cached['image_ref'],
                    'Digest' => (string) ($cached['digest'] ?? ''),
                    'Status' => (string) $cached['status'],
                    'ScannedAt' => (int) $cached['scanned_at'],
                    'Summary' => is_array($summary) ? $summary : [],
                    'Findings' => array_map(static function (array $f): array {
                        return [
                            'Cve' => (string) ($f['cve'] ?? ''),
                            'Package' => (string) ($f['package'] ?? ''),
                            'Version' => (string) ($f['version'] ?? ''),
                            'Severity' => (string) ($f['severity'] ?? ''),
                            'Title' => (string) ($f['title'] ?? ''),
                            'FixedVersion' => (string) ($f['fixed_version'] ?? ''),
                        ];
                    }, $findings),
                    'FromCache' => true,
                    'CacheTtl' => $ttl,
                ]);
            }
        }

        $kind = (string) ($ep['kind'] ?? 'local');
        try {
            if ($kind === 'agent') {
                $parsed = $this->scanImageViaAgent($ep, $ref);
            } else {
                $parsed = $this->imageScanner->scanImage($ref);
            }
        } catch (\Throwable $e) {
            return Response::error($e->getMessage(), 502);
        }

        $row = $this->repo->saveImageScan(
            $endpointId,
            $ref,
            $digest,
            (string) ($parsed['status'] ?? 'ok'),
            $parsed['summary'] ?? [],
            (string) ($parsed['raw'] ?? ''),
            $parsed['findings'] ?? [],
        );
        $this->audit($user, 'image.scan', 'Scan CVE de « ' . $ref . ' »', $request, [
            'endpointId' => $endpointId,
            'digest' => $digest,
            'summary' => $parsed['summary'] ?? [],
        ]);
        return Response::json([
            'Id' => (int) $row['id'],
            'ImageRef' => (string) $row['image_ref'],
            'Digest' => (string) ($row['digest'] ?? ''),
            'Status' => (string) $row['status'],
            'ScannedAt' => (int) ($row['scanned_at'] ?? time()),
            'Summary' => $parsed['summary'] ?? [],
            'Findings' => array_map(static function (array $f): array {
                return [
                    'Cve' => (string) ($f['cve'] ?? ''),
                    'Package' => (string) ($f['package'] ?? ''),
                    'Version' => (string) ($f['version'] ?? ''),
                    'Severity' => (string) ($f['severity'] ?? ''),
                    'Title' => (string) ($f['title'] ?? ''),
                    'FixedVersion' => (string) ($f['fixed_version'] ?? ''),
                ];
            }, $parsed['findings'] ?? []),
            'FromCache' => false,
        ]);
    }

    /**
     * @param array<string, mixed> $ep
     * @return array{summary:array<string,int>,findings:list<array<string,string>>,raw:string,status:string}
     */
    private function scanImageViaAgent(array $ep, string $imageRef): array
    {
        $url = rtrim((string) ($ep['agent_url'] ?? ''), '/');
        $secret = (string) ($ep['agent_secret'] ?? '');
        if ($url === '' || $secret === '') {
            throw new \RuntimeException('Agent non configuré');
        }
        $ch = curl_init($url . '/scan/image');
        if (!$ch) {
            throw new \RuntimeException('curl init failed');
        }
        $payload = json_encode(['image' => $imageRef], JSON_UNESCAPED_SLASHES) ?: '{}';
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_HTTPHEADER => [
                'Authorization: Bearer ' . $secret,
                'Content-Type: application/json',
                'Accept: application/json',
            ],
            CURLOPT_TIMEOUT => 360,
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_SSL_VERIFYHOST => 0,
        ]);
        $fp = trim((string) ($ep['tls_fingerprint'] ?? ''));
        if ($fp !== '') {
            // pinning handled by AgentTls elsewhere; keep soft verify for scan
        }
        $body = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($body === false || $code >= 400) {
            throw new \RuntimeException($err !== '' ? $err : ('Agent scan HTTP ' . $code . ': ' . (string) $body));
        }
        $json = json_decode((string) $body, true);
        if (!is_array($json)) {
            throw new \RuntimeException('Réponse agent invalide');
        }
        if (isset($json['raw']) && is_string($json['raw'])) {
            return $this->imageScanner->parseTrivyJson($json['raw']);
        }
        return [
            'summary' => is_array($json['summary'] ?? null) ? $json['summary'] : [],
            'findings' => is_array($json['findings'] ?? null) ? $json['findings'] : [],
            'raw' => (string) ($json['raw'] ?? $body),
            'status' => (string) ($json['status'] ?? 'ok'),
        ];
    }
}
