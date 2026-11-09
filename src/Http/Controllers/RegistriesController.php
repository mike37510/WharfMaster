<?php
declare(strict_types=1);

namespace App\Http\Controllers;

use App\Access\EndpointAcl;
use App\Access\Ownership;
use App\Http\Request;
use App\Http\Response;

final class RegistriesController extends BaseController
{
    public function createRegistry(Request $request, array $user): Response
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
    public function updateRegistry(int $id, Request $request, array $user): Response
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
    public function pingRegistry(int $id, array $user): Response
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
    public function browseRegistryRepos(int $id, Request $request, array $user): Response
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
    public function browseRegistryTags(int $id, string $repository, array $user): Response
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
    public function pullFromRegistry(int $id, Request $request, array $user): Response
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
}
