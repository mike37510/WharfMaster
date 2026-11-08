<?php
declare(strict_types=1);

namespace App\Auth;

/**
 * Active Directory / LDAP authentication helper.
 *
 * @phpstan-type LdapConfig array{
 *   enabled?:bool,
 *   host?:string,
 *   port?:int,
 *   use_tls?:bool,
 *   use_ssl?:bool,
 *   base_dn?:string,
 *   bind_dn?:string,
 *   bind_password?:string,
 *   user_filter?:string,
 *   username_attr?:string
 * }
 */
final class LdapClient
{
    /**
     * @param LdapConfig $config
     * @return array{username:string,dn:string,groups:list<string>}|null
     */
    public function authenticate(array $config, string $username, string $password): ?array
    {
        if (!extension_loaded('ldap')) {
            throw new \RuntimeException('Extension PHP ldap non disponible');
        }
        $username = trim($username);
        $password = (string) $password;
        if ($username === '' || $password === '') {
            return null;
        }
        if (!preg_match('/^[a-zA-Z0-9._@-]{1,64}$/', $username)) {
            return null;
        }

        $host = trim((string) ($config['host'] ?? ''));
        $port = (int) ($config['port'] ?? 389);
        $baseDn = trim((string) ($config['base_dn'] ?? ''));
        $bindDn = trim((string) ($config['bind_dn'] ?? ''));
        $bindPassword = (string) ($config['bind_password'] ?? '');
        $useSsl = !empty($config['use_ssl']);
        $useTls = !empty($config['use_tls']);
        $userFilter = trim((string) ($config['user_filter'] ?? ''));
        if ($userFilter === '') {
            $userFilter = '(sAMAccountName={username})';
        }
        $usernameAttr = trim((string) ($config['username_attr'] ?? 'sAMAccountName'));
        if ($usernameAttr === '') {
            $usernameAttr = 'sAMAccountName';
        }

        if ($host === '' || $baseDn === '') {
            throw new \RuntimeException('Configuration LDAP incomplète (host / base DN)');
        }

        $uri = ($useSsl ? 'ldaps://' : 'ldap://') . $host . ':' . ($port > 0 ? $port : ($useSsl ? 636 : 389));
        $conn = @ldap_connect($uri);
        if (!$conn) {
            throw new \RuntimeException('Connexion LDAP impossible');
        }
        ldap_set_option($conn, LDAP_OPT_PROTOCOL_VERSION, 3);
        ldap_set_option($conn, LDAP_OPT_REFERRALS, 0);
        ldap_set_option($conn, LDAP_OPT_NETWORK_TIMEOUT, 8);

        if ($useTls && !$useSsl) {
            if (!@ldap_start_tls($conn)) {
                $err = ldap_error($conn);
                @ldap_unbind($conn);
                throw new \RuntimeException('StartTLS LDAP échoué : ' . $err);
            }
        }

        if ($bindDn !== '') {
            if (!@ldap_bind($conn, $bindDn, $bindPassword)) {
                $err = ldap_error($conn);
                @ldap_unbind($conn);
                throw new \RuntimeException('Bind service LDAP échoué : ' . $err);
            }
        }

        $escaped = $this->escapeFilter($username);
        $filter = str_replace('{username}', $escaped, $userFilter);
        $search = @ldap_search($conn, $baseDn, $filter, [$usernameAttr, 'memberOf', 'dn', 'distinguishedName']);
        if ($search === false) {
            $err = ldap_error($conn);
            @ldap_unbind($conn);
            throw new \RuntimeException('Recherche LDAP échouée : ' . $err);
        }
        $entries = ldap_get_entries($conn, $search);
        if (!is_array($entries) || (int) ($entries['count'] ?? 0) < 1) {
            @ldap_unbind($conn);
            return null;
        }
        $entry = $entries[0];
        $userDn = (string) ($entry['dn'] ?? '');
        if ($userDn === '') {
            @ldap_unbind($conn);
            return null;
        }

        if (!@ldap_bind($conn, $userDn, $password)) {
            @ldap_unbind($conn);
            return null;
        }

        $groups = [];
        if (isset($entry['memberof']['count'])) {
            $n = (int) $entry['memberof']['count'];
            for ($i = 0; $i < $n; $i++) {
                $g = (string) ($entry['memberof'][$i] ?? '');
                if ($g !== '') {
                    $groups[] = $g;
                }
            }
        }

        $resolvedUsername = $username;
        $attrKey = strtolower($usernameAttr);
        if (isset($entry[$attrKey][0]) && is_string($entry[$attrKey][0]) && $entry[$attrKey][0] !== '') {
            $resolvedUsername = (string) $entry[$attrKey][0];
        }

        @ldap_unbind($conn);
        return [
            'username' => $resolvedUsername,
            'dn' => $userDn,
            'groups' => $groups,
        ];
    }

    public function escapeFilter(string $value): string
    {
        return str_replace(
            ['\\', '*', '(', ')', "\x00"],
            ['\\5c', '\\2a', '\\28', '\\29', '\\00'],
            $value,
        );
    }

    /**
     * Match team ad_group_dn against user's memberOf list (case-insensitive DN or CN).
     * @param list<string> $memberOf
     * @param list<array<string,mixed>> $teams
     * @return list<int>
     */
    public function matchTeamIds(array $memberOf, array $teams): array
    {
        $ids = [];
        $normalized = array_map(static fn(string $g): string => strtolower(trim($g)), $memberOf);
        foreach ($teams as $team) {
            $dn = strtolower(trim((string) ($team['ad_group_dn'] ?? '')));
            if ($dn === '') {
                continue;
            }
            $matched = false;
            foreach ($normalized as $g) {
                if ($g === $dn || str_contains($g, $dn) || str_contains($dn, $g)) {
                    $matched = true;
                    break;
                }
                // CN=Foo,OU=... match by CN alone if configured as "Foo" or "CN=Foo"
                if (preg_match('/^cn=([^,]+)/i', $g, $m) && strcasecmp($m[1], $dn) === 0) {
                    $matched = true;
                    break;
                }
                if (preg_match('/^cn=([^,]+)/i', $dn, $m2)) {
                    if (preg_match('/^cn=([^,]+)/i', $g, $m3) && strcasecmp($m2[1], $m3[1]) === 0) {
                        $matched = true;
                        break;
                    }
                }
            }
            if ($matched) {
                $ids[] = (int) $team['id'];
            }
        }
        return $ids;
    }
}
