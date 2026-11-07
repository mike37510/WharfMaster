# Changelog

Toutes les dates sont en UTC+1.

## [1.0.2] — 2026-11-07

### Ajouté
- **Journaux** (audit applicatif) : connexions, actions utilisateurs / stacks / paramètres / clés API, mutations Docker (start/stop/create/remove, pull, prune…)
- Lecteur de **logs conteneur** enrichi : demux chronologique, tail configurable, suivi live incrémental (`since`), recherche, copier / télécharger, horodatage
- Documentation README : schéma API compatible Portainer (adaptateur)

### Modifié
- Licence MIT (open source)
- Labels UI : distinction claire « Journaux » (outil) vs « Logs conteneur »

## [1.0.1] — 2026-11-07

Produit renommé **WharfMaster**. Durcissement sécurité avant publication.

### Sécurité
- Stacks non-admin : validation via `docker compose config` (JSON résolu) — bloque binds/`.env`, `driver_opts`, privileged, host namespaces, etc.
- Blocage de l’accès web à `/data`, `/src`, `config.php`, secrets et SQLite (fuite critique corrigée)
- Rotation forcée du secret JWT + permissions `0600` / `0700` sur les données
- CORS restreint à l’origine same-host (plus de `*`)
- En-têtes HTTP de sécurité (nosniff, frame deny, referrer, CORP)
- Rate-limit connexion / init admin (8 essais / 15 min)
- JWT : rôle relu depuis la base à chaque requête ; TTL 4 h
- Politique mot de passe (10+ caractères, lettre + chiffre)
- Clé API : confirmation mot de passe obligatoire
- Proxy Docker : blocage swarm/plugins/secrets/attach/exec brut
- Conteneurs / Compose non-admin : pas de privileged, bind hôte, docker.sock, network/pid host
- Messages d’erreur 500 génériques (détail côté logs)

## [1.0.0] — 2026-11-07

Première version stable (alors nommée Docker Manager, devenu **WharfMaster**).

### Ajouté
- Tableau de bord (stats, conteneurs, ressources hôte, actions rapides)
- Gestion des conteneurs (création, start/stop/restart, logs, console, inspect en modal)
- Recherche d’images locale + Docker Hub (création de conteneur et pull)
- Build d’images depuis un Dockerfile (enregistrement / chargement)
- Volumes (création, explorateur de fichiers, montage à la création de conteneur)
- Réseaux, stacks Compose (éditeur, variables `.env`, déploiement)
- Registres (Docker Hub / Registry V2, parcours dépôts & tags, pull)
- Utilisateurs & rôles (admin / utilisateur)
- Isolation multi-utilisateurs (labels `dockermanager.owner*`, filtrage stacks / registres)
- Thème clair / sombre, interface en français
- Compatibilité des endpoints avec l’API Portainer CE (clients / scripts existants)
- Site public (`/`) présentant le projet, les fonctionnalités et l’API — console sous `/app`

### Corrigé
- Déploiement de stacks : erreurs Compose lisibles, timeout pull, nettoyage en cas d’échec
- Tableau conteneurs du dashboard (plus d’ascenseur / actions inutiles)
- Bouton « Nettoyer les orphelins » (prune Docker, réservé admin)
- UI Dockerfile (sélecteur de fichier / suppression)

[1.0.0]: https://dockermanager.borninthe80s.fr/
