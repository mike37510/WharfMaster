<?php
declare(strict_types=1);

namespace App\Http\Controllers;

use App\Access\EndpointAcl;
use App\Access\Ownership;
use App\Http\Request;
use App\Http\Response;
use App\Stack\ImageUpdateChecker;

final class ImagesController extends BaseController
{
    public function searchImages(Request $request): Response
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

    public function searchImageTags(Request $request): Response
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

    public function buildImage(Request $request, array $user): Response
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

    public function saveDockerfile(Request $request): Response
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

    public function adviseImages(int $endpointId, Request $request, array $user): Response
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
    public function listImageScans(int $endpointId, array $user): Response
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
    public function ensureImageScans(int $endpointId, Request $request, array $user): Response
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
    public function getImageScan(int $endpointId, Request $request, array $user): Response
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
    public function scanImage(int $endpointId, Request $request, array $user): Response
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
}
