# Changelog

Toutes les dates sont en UTC+1.

## Unreleased

## [2.3.0] — 2026-11-09

### Ajouté
- **Profil** (avatar) : compte, changement de mot de passe, gestion des **clés API** personnelles
- API tokens self-service : `GET/POST /api/users/{id}/tokens`, `DELETE /api/users/{id}/tokens/{tid}` — la clé hérite des droits du propriétaire (rôle, ACL, partages)
- **MàJ image en un clic** : pastille stack cliquable (pull + redeploy) ; action équivalente côté conteneur
- Détail stack : liste des **conteneurs liés** avec actions rapides
- Toolbars d’actions **à plat** (stacks / conteneurs) ; dates de création visibles

### Amélioré
- Courbes / sparklines : échelle depuis 0 (plus de courbes « plates » invisibles)
- Polling métriques (page visible, seuils de charge)
- Documentation console (`docs/DOCUMENTATION.md`) alignée 2.3

### Compatibilité
- Image / tag agent par défaut : **`wharfmaster-agent:2.3.0`**
- Auth API : JWT **ou** `X-API-Key` (Profil)

## [2.2.2] — 2026-11-09

### Ajouté
- Pastille **CPU / RAM** live dans la liste des conteneurs (barres + %) ; clic → modal ressources
- Rafraîchissement périodique des charges (~4 s) sur la liste / détail conteneur

### Corrigé
- Courbes de métriques conteneur vides : scope `ctr:…` tronqué à 64 caractères à l’écriture, clé complète à la lecture
- Alignement des pastilles « Mise à jour » (libellé toujours présent, halo réservé)
- Traits de tableau en escalier : `display:flex` retiré de `td.name-cell`

### Compatibilité
- Image / tag agent par défaut : **`wharfmaster-agent:2.2.2`**
- Anciennes lignes métriques tronquées toujours lisibles / migrées au premier échantillon

## [2.2.1] — 2026-11-09

### Ajouté
- **Partage de ressources** : partage stack / conteneur / volume / réseau entre utilisateurs (indépendant des ACL nœuds) ; cascade stack → ressources Compose ; `GET/POST/DELETE /api/shares`
- **Tests API Docker** (Diagnostics) : suite création → suppression (image, volume, réseau, conteneur) sur `#settings/diagnostics/api`
- Badge version console lu dynamiquement depuis `/api/status`

### Amélioré
- Menus d’actions conteneurs / stacks (overflow « … »)
- Modal schéma d’usage réseau (IP / ports)
- Ordre de navigation latérale

### Corrigé
- Vérification des mises à jour d’images / stacks (`ImageUpdateChecker` manquant)
- Création de planifications (`use App\Schedule\CronExpr`)
- Suppression de planifications (route `DELETE` sans `Request` → TypeError « Erreur interne »)
- Modal planification (`bag.DOW_LABELS`)

### Compatibilité
- Image / tag agent par défaut : **`wharfmaster-agent:2.2.1`**

## [2.2.0] — 2026-11-09

### Breaking
- **DocumentRoot = `public/` uniquement** — `src/`, `config/`, `var/`, `agent/` hors webroot
- Front controller unique `public/index.php` (`/api`, `/app`, `/agent/*`, `/docs/*`, `/` vitrine)
- Plus de fallback **`/var/run/docker.so`** ni rename auto **`portainer.sqlite`** — lancer `php bin/migrate-legacy.php`
- URLs `/public/…` → `/assets/…` et `/agent/…` ; volume runtime = `var/`

### Ajouté
- **Diagnostics admin** : Paramètres → Diagnostics (`#settings/diagnostics`) + `GET /api/system/diagnostics`
- Structure `docker/`, `bin/`, `SECURITY.md`, `composer.json`, `package.json` (esbuild)
- Site vitrine servi sur `/` depuis `site/`

### Code
- **PHP** : kernel `App` + `Http\Router` + `AppContext` + contrôleurs par domaine
- **JS** : modules ES sous `public/assets/js/src/` ; bundle `npm run build` → `public/assets/js/app.js`

### Compatibilité
- Image / tag agent par défaut : **`wharfmaster-agent:2.2.0`**
- Migration : `php bin/migrate-legacy.php` puis rebuild image

## [2.1.0] — 2026-11-09

### Ajouté
- **Images / CVE** : à l’ouverture de la page Images, scan auto de toutes les images taguées (pastille **CVE OK** / C·H·M) ; plus d’icône de scan manuel ; cache **24 h** aligné sur la vérif. de mises à jour d’images
- **Volumes bind** : volumes host bind gérés côté admin + sync automatique depuis les Compose
- **Conteneurs — métriques** : modal CPU / RAM / réseau ; icônes colorées selon la charge ; fenêtre / rétention partagées avec le dashboard (défaut 72 h / 90 j)
- **Conteneurs — images** : indicateur de statut de mise à jour (comme les stacks) ; plus de Pull+recreate sur un conteneur (upgrade via stack)
- **Agents** : téléchargement d’un **pack ZIP** (Dockerfile, sources, `docker-compose.yml`, `deploy.sh`, `.env` prérempli) en plus de la commande `curl | sh`

### Amélioré
- UX console : menus, logs colorés, modales redimensionnables, liste stacks

### Compatibilité
- Image / tag agent par défaut : **`wharfmaster-agent:2.1.0`**
- Endpoint admin : `POST|GET /api/nodes/agent-bundle`
- Endpoint : `POST /api/endpoints/{id}/images/scans/ensure`

## [2.0.1] — 2026-11-08

### Amélioré
- **Planifications** : formulaire user-friendly (tous les jours / lun–ven / hebdo / horaire) au lieu du cron brut ; résumé en français
- Badge version console aligné sur **2.0.1**

## [2.0.0] — 2026-11-08

Release majeure : gouvernance multi-équipes, SSO AD, ACL par nœud, scheduler, scan CVE Trivy, et UX Paramètres / Nœuds revue.

### Ajouté
- **Équipes** : CRUD + membres (recherche / ajout / retrait), mapping groupe AD
- **ACL par nœud** : rôles `read` / `operate` / `admin` (user ou équipe)
  - gestion depuis **Nœuds → Accès** (recherche user/équipe)
  - filtrage endpoints + enforcement proxy Docker / stacks
  - migration : users existants conservent `operate` partout
- **SSO Active Directory / LDAP** : Paramètres → Authentification
  - host / TLS / LDAPS / bind / filtre / attribut username
  - provision users au login + sync groupes → équipes
- **Scheduler** : cron start / stop / restart de stacks + sidecar Compose
- **Scan CVE Trivy** (0.76.2 dans Dockerfile principal + agent)
  - pastilles Images, scan manuel, agent `/scan/image`
  - avis non bloquant à la création conteneur / stack (`POST …/images/advise`)
  - interrupteur global Paramètres `TrivyEnabled`
- **Nœuds** : modal « Ajouter un nœud », édition (renommer, URL agent, URL publique), badge `Disabled`
- Menus admin regroupés sous **Paramètres** (Général, Authentification, Registres, Nœuds, Utilisateurs, Équipes)

### Compatibilité API Portainer CE
- `UserAccessPolicies` / `TeamAccessPolicies` depuis `endpoint_acls` (`RoleId` 1/2/3)
- `PUT /api/endpoints/{id}` accepte policies + renommage
- `GET /api/teams` → tableau nu `[{Id,Name}]` ; détail `?detail=1`
- Alias `GET|POST /api/team_memberships`, `GET /api/teams/{id}/memberships`
- Settings : `LDAPSettings` (+ `Ldap` UI), `TrivyEnabled` / `TrivyInstalled` / `TrivyAvailable`
- Registries : `Type` numérique CE (6=hub, 3=custom) + `RegistryKind` WM
- Endpoint désactivé → `Status` `2` ; flag `Disabled`
- `PUT /api/nodes/{id}` : mise à jour métadonnées nœud
- `GET /api/users/{id}` ; `AuthSource` correct sur `/api/users/me`

### Breaking / migration
- Image / tag agent par défaut : **`wharfmaster-agent:2.0.0`** (rebuild / `install.sh` mis à jour)
- Compose : service **`scheduler`** optionnel mais présent dans `docker-compose.yml`
- Les droits nœud ne se gèrent plus depuis la page Équipes (uniquement via Nœuds → Accès)

## [1.5.0] — 2026-11-08

### Ajouté
- **Stacks — indicateur d’images** : pastille **verte** (à jour) / **orange** (nouvelle image sur le registre)
  - comparaison digest local vs registre (tags flottants type `latest`)
  - colonne Images dans la liste + détail par service
  - **cache 24 h** + bouton « Rafraîchir images »
- **Stacks — forcer le pull** à la création / mise à jour (`docker compose up --pull always`)
  - case à cocher dans l’éditeur + bouton pull sur le détail
- **Tri des tableaux** (conteneurs, stacks, images, réseaux, volumes) : clic sur les en-têtes, défaut A→Z sur le nom
- Boutons start/stop **contextuels** (vert si arrêté, rouge si démarré) sur conteneurs et stacks
- Lignes des **stacks arrêtées** teintées comme les conteneurs

### Corrigé
- Injection des labels Compose : plus de clés YAML en double (`mapping key already defined`)

## [1.4.8] — 2026-11-08

### Corrigé
- Registres **Harness / Gitness** (`harness.vincz.fr`, etc.) :
  - login **e-mail + jeton** (Basic) pris en charge
  - realm Bearer interne (IP privée) réécrit vers l’URL publique
  - catalogue via l’API Gitness (pas de `/v2/_catalog` côté Harness)
  - jeton sans `scope` en query (sinon 404 Gitness)

## [1.4.7] — 2026-11-08

### Corrigé
- Ports à la création de conteneur :
  - `80` / `80,443` → **interne uniquement** (plus de publication aléatoire type `32804:80`)
  - `0:80` → publication sur **port hôte dynamique** (volontaire)
  - `8080:80` → port hôte fixe

## [1.4.6] — 2026-11-08

### Ajouté
- **Modification des registres** après création (nom, URL, type, identifiants) ; mot de passe vide = inchangé

### Corrigé
- Création de conteneur avec **port interne seul** (`80` / `80/tcp`) : plus d’erreur Docker `PortBindings` / JSON invalide
- Normalisation PHP des bindings vides (`{}` → `[]`) avant envoi à l’API Docker

## [1.4.5] — 2026-11-08

### Ajouté
- **Installation Docker Compose** : `Dockerfile`, `docker-compose.yml`, `.env.example`, entrypoint socket/`var/`
- **Backup complet** (admin, Paramètres) : ZIP SQLite + Compose + Dockerfiles + JWT (`GET /api/backup`)
- Point d’entrée physique **`/app`** (`app/index.php`) pour éviter le 404 Apache si rewrite/AllowOverride manque
- Exemple vhost [`deploy/apache-vhost.conf`](deploy/apache-vhost.conf)

### Modifié
- README : install Docker en option recommandée, dépannage 404 / Docker offline

## [1.4.4] — 2026-11-08

### Ajouté
- **Console conteneur** : exec en TTY avec `TERM` / `COLUMNS` / couleurs (ex. `ls` en colonnes colorées)
- **Éditeur Compose** colorisé (CodeMirror YAML) + lint temps réel (indentation, tabs, parse js-yaml) ; déploiement bloqué si invalide
- Colonne **Usage** sur images, volumes et réseaux (Inutilisé / N conteneurs) + modal listant les conteneurs liés
- **Pagination** (20 / page) sur conteneurs, images, volumes, réseaux et stacks
- Lignes des conteneurs **arrêtés** teintées en rouge léger

### Modifié
- Thème xterm / police console ; aperçu YAML colorisé sur le détail d’une stack

## [1.4.3] — 2026-11-08

### Ajouté
- Historique dashboard en **SQLite** (`metric_samples`) : conteneurs, images, volumes, réseaux, CPU, mémoire, disque
- Courbes KPI et « Ressources hôte » basées sur l’historique réel (plus de sparklines factices)
- Fenêtre des courbes + rétention **configurables** dans Paramètres (défaut 24 h / 90 j)
- Échelle Y **0 % / 50 % / 100 %** sur le graphique ressources hôte
- Modale de **progression** drag-and-drop (déjà en 1.4.2) + upload volume jusqu’à **300 Mo** (endpoint binaire `/upload`, archive Docker)
- Correctif drag-and-drop **multi-fichiers** (snapshot sync du `DataTransfer`)

### Modifié
- Limites PHP/Apache pour gros uploads (`deploy/php-uploads.ini`, `deploy/apache-uploads.conf`)
- Image agent : limites PHP upload relevées (Dockerfile)

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
- **`GET /api/health`** : docker, compose, droits `var/`, SQLite
- **`GET /api/backup`** (admin) : export SQLite cohérent
- Image agent **versionnée** (`…/wharfmaster-agent:1.4.0`) injectée dans la commande d’install
- Script [`(supprimé — une seule copie agent/)`]((supprimé — une seule copie agent/)) ; HSTS si HTTPS

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

## [1.0.2] — 2026-11-07

### Ajouté
- Journaux d’audit applicatif
- Logs conteneur enrichis (suivi live, recherche, export)

## [1.0.1] — 2026-11-06

Première version stable (alors nommée Docker Manager, devenu **WharfMaster**).
