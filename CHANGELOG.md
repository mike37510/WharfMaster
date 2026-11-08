# Changelog

Toutes les dates sont en UTC+1.

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
- **Installation Docker Compose** : `Dockerfile`, `docker-compose.yml`, `.env.example`, entrypoint socket/`data/`
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

## [1.0.2] — 2026-11-07

### Ajouté
- Journaux d’audit applicatif
- Logs conteneur enrichis (suivi live, recherche, export)

## [1.0.1] — 2026-11-06

Première version stable (alors nommée Docker Manager, devenu **WharfMaster**).
