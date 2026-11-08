<?php
declare(strict_types=1);

namespace App\Access;

use App\Storage\Repositories;

/**
 * Per-endpoint access roles: none < read < operate < admin.
 * Global admins (users.role=1) always resolve to admin.
 */
final class EndpointAcl
{
    public const NONE = 'none';
    public const READ = 'read';
    public const OPERATE = 'operate';
    public const ADMIN = 'admin';

    private const RANK = [
        self::NONE => 0,
        self::READ => 1,
        self::OPERATE => 2,
        self::ADMIN => 3,
    ];

    public function __construct(private readonly Repositories $repo)
    {
    }

    public static function isValidRole(string $role): bool
    {
        return isset(self::RANK[$role]) && $role !== self::NONE;
    }

    public static function rank(string $role): int
    {
        return self::RANK[$role] ?? 0;
    }

    public static function maxRole(string $a, string $b): string
    {
        return self::rank($a) >= self::rank($b) ? $a : $b;
    }

    /** @param array{id?:int,username?:string,role?:int} $user */
    public function roleFor(array $user, int $endpointId): string
    {
        if (Ownership::isAdmin($user)) {
            return self::ADMIN;
        }
        $uid = Ownership::userId($user);
        if ($uid <= 0 || $endpointId <= 0) {
            return self::NONE;
        }
        return $this->repo->resolveEndpointRole($uid, $endpointId);
    }

    /** @param array{id?:int,username?:string,role?:int} $user */
    public function can(array $user, int $endpointId, string $minRole): bool
    {
        return self::rank($this->roleFor($user, $endpointId)) >= self::rank($minRole);
    }

    /**
     * Annotate user for DockerScope: endpoint-level admin bypasses ownership filters.
     * @param array{id:int,username:string,role:int} $user
     * @return array{id:int,username:string,role:int,_endpointAdmin?:bool,_endpointRole?:string}
     */
    public function withEndpointContext(array $user, string $endpointRole): array
    {
        $user['_endpointRole'] = $endpointRole;
        if ($endpointRole === self::ADMIN) {
            $user['_endpointAdmin'] = true;
        }
        return $user;
    }

    /**
     * @param array{id?:int,username?:string,role?:int} $user
     * @return list<array<string, mixed>>
     */
    public function filterEndpoints(array $user, array $endpoints): array
    {
        if (Ownership::isAdmin($user)) {
            return $endpoints;
        }
        $out = [];
        foreach ($endpoints as $ep) {
            $id = (int) ($ep['id'] ?? 0);
            if ($this->can($user, $id, self::READ)) {
                $ep['_aclRole'] = $this->roleFor($user, $id);
                $out[] = $ep;
            }
        }
        return $out;
    }
}
