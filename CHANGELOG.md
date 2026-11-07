# Changelog

Toutes les dates sont en UTC+1.

## [1.4.2] — 2026-11-07

### Ajouté
- Modale de **progression** lors du drag-and-drop vers un volume (barre %, fichier en cours)

### Modifié
- Upload volume : tous types de fichiers (binaires via `ArrayBuffer` → base64)

## [1.4.1] — 2026-11-07

### Ajouté
- **Drag-and-drop** dans l’explorateur de volumes (fichiers et dossiers, max 2 Mo / fichier)

### Corrigé
- Explorateur / écriture de volumes sur **nœuds agent** (APIs scopées `/api/endpoints/{id}/volumes/…`)
- Ascenseur inutile masqué dans la barre latérale

## [1.4.0] — 2026-11-07

### Ajouté
- **Pinning TLS agent** : empreinte SHA-256 stockée à la jointure / premier ping (TOFU) ; refus si mismatch
- **Chiffrement at-rest** des mots de passe registres (AES-256-GCM, clé `WM_MASTER_KEY` ou `jwt.secret`)
- **`GET /api/health`** : docker, compose, droits `data/`, SQLite
- **`GET /api/backup`** (admin) : export SQLite cohérent
- Image agent **versionnée** (`…/wharfmaster-agent:1.4.0`) injectée dans la commande d’install
- Script [`scripts/sync-agent.sh`](scripts/sync-agent.sh) ; HSTS si HTTPS

### Modifié
- Colonne Nœuds TLS : badge compact + courte empreinte (`pin abcdef…`)
- Version site / console alignées sur 1.4.0

## [1.3.0] — 2026-11-07

### Ajouté
- **Stacks Compose sur nœuds agent** : le principal valide + miroir YAML ; `up` / `down` délégués à l’agent (`/compose/up|down`)
- Image agent : `docker-cli` + plugin Compose ; bind-mount hôte `/var/lib/wharfmaster/stacks` → `/data/stacks`
- Client `AgentComposeClient` ; liste stacks agrégée en mode **Tous les nœuds** (colonne Nœud)

### Modifié
- `install.sh` : `--stacks-dir`, volume stacks, health `compose: true`
- Création / maj / suppression de stacks autorisées sur un endpoint agent sélectionné

### Limites
- Mode « Tous » : create stack exige un nœud précis (pas de placement multi-nœud d’une même stack)
- Pas de sync bidirectionnelle si les fichiers sont édités à la main sur le nœud

## [1.2.0] — 2026-11-07

### Ajouté
- **Vue « Tous les nœuds »** dans le sélecteur : dashboard et listes (conteneurs, images, volumes, réseaux) **agrégés** avec colonne Nœud
- Répartition par nœud sur le dashboard commun ; échantillon équitable (plus seulement le nœud local)
- Enrôlement guidé : saisie IP + nom → commande `install.sh` **prête à coller** (URL publique configurable)
- Re-join idempotent (même advertise = renouvellement du secret agent, plus d’erreur 409)
- Colonne **TLS** (expiration / date de renouvellement) ; agent HTTPS autosigné avec renouvellement auto ~30 j avant expiry

### Modifié
- Sources agent servies en statique (`public/agent/.htaccess`) pour le build local si le pull d’image échoue
- Commande d’install basée sur l’**URL publique / hôte** (paramètres) ou l’origine de la requête

### Corrigé
- Création de conteneur : `PortBindings` / `ExposedPorts` vides plus envoyés comme `[]` (rejet Docker)
- Statut « En ligne » en mode Tous les nœuds (poll qui n’appelait plus `Api.docker()` à tort)
- Ascenseur horizontal inutile dans le panneau Nœuds du dashboard

### Limites
- Mode « Tous » en **lecture** : start/stop/create/pull/build exigent un nœud précis
- Stacks Compose sur nœuds agent non supportées (nœud local uniquement) — levé en **1.3.0**

## [1.1.0] — 2026-11-07

### Ajouté
- **Multinode** : token de jointure, enrôlement d’agents distants, page **Nœuds** (liste, ping, désactiver, délier)
- Agent **HTTPS** autosigné (`agent/` + socat OPENSSL) + script `public/agent/install.sh` (`--advertise https://…` obligatoire)
- Sélecteur de nœud dans la console ; proxy Docker vers agents (`/api/endpoints/{id}/…`)
- API `/api/nodes` (admin) + `POST /api/nodes/join` (token, HTTPS only)

### Limites
- L’agent doit être joignable depuis le serveur principal (pas de mode edge/NAT)
- Certificats autosignés : le principal ne vérifie pas la CA (verify peer désactivé)

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
