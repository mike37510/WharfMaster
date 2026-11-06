# WharfMaster

Interface web de gestion Docker (conteneurs, images, volumes, réseaux, stacks Compose, registres) avec isolation multi-utilisateurs et API compatible Portainer CE.

**Version :** 1.0.1

## Prérequis

- PHP 8.2+ (Apache + `mod_rewrite`)
- Accès au socket Docker (`/var/run/docker.sock` ou `/var/run/docker.so`)
- Binaire `docker` / plugin Compose

## Installation rapide

1. Déployer le dépôt sous le DocumentRoot Apache (ex. `/var/www/html`).
2. S’assurer que `AllowOverride All` est actif pour `.htaccess`.
3. Donner à l’utilisateur Apache l’accès en écriture à `data/` (créé au premier démarrage).
4. Ouvrir `/` (site public) puis `/app` (console).

Au premier lancement, créer le compte administrateur.

## Sécurité

- Ne jamais exposer `data/` (JWT, SQLite) — déjà bloqué via `.htaccess` / config Apache.
- Placer HTTPS devant l’application en production.
- Les utilisateurs non-admin sont restreints (pas de privileged / bind hôte / socket Docker).

## Structure

```
api/          Front controller API
public/       SPA console + site public + assets
src/          Code PHP
config.php    Configuration (socket, chemins, TTL JWT)
CHANGELOG.md  Historique des versions
```

## Licence

Usage privé / projet personnel — ajuster selon vos besoins.
