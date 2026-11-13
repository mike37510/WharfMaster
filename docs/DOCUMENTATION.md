# WharfMaster — Documentation

Guide d’utilisation de la console et de l’**API HTTP**. Version applicative : **2.3.5**.

| | |
|---|---|
| Console | `/app` |
| API | `/api` |
| DocumentRoot | `public/` uniquement |
| Santé | `GET /api/health` |
| Vitrine | `/` (site public) |
| Dépôt | https://github.com/mike37510/WharfMaster |

---

## 1. Présentation

**WharfMaster** est une interface web de gestion Docker (standalone Compose + multi-nœuds) :

- conteneurs, images, volumes, réseaux ;
- stacks Compose (nœud local **et** agents distants) ;
- registres (Docker Hub / Registry V2) ;
- multi-utilisateurs (labels owner) + **partages** de ressources ;
- **équipes**, **ACL par nœud**, **SSO AD/LDAP** ;
- **scheduler** (start / stop / restart de stacks) ;
- **scan CVE Trivy** (pastilles Images, cache 24 h) ;
- **indicateurs de mise à jour** d’images (stacks & conteneurs) avec **mise à jour en un clic** ;
- **métriques** CPU / RAM / réseau (pastille couleur + historique) ;
- diagnostics admin + tests API Docker ;
- API compatible **Portainer CE** + extensions WharfMaster.

Licence : **MIT**.

---

## 2. Architecture

```
Navigateur (/app)
    │  HTTPS + JWT
    ▼
Principal (PHP/Apache + SQLite)
    ├── Docker local (unix socket)
    └── Agents distants (HTTPS + Bearer NODE_SECRET)
            └── docker compose / API Engine sur le nœud
```

| Composant | Rôle |
|-----------|------|
| Principal | UI, auth, validation Compose, miroir YAML, proxy Docker |
| Agent | Proxy Engine + API `/compose/*` sur chaque hôte distant |
| SQLite `var/` | utilisateurs, endpoints, stacks, registres, shares, métriques, audit |

Les stacks distantes : le principal **valide** (`ComposePolicy` + `docker compose config`) et **stocke un miroir** ; le déploiement réel (`up` / `down` / start / stop) est délégué à l’agent.

DocumentRoot = **`public/`** uniquement (`src/`, `config/`, `var/`, `agent/` hors webroot). Front controller : `public/index.php`.

---

## 3. Console

### Connexion

1. Ouvrir `/app`.
2. Premier démarrage : créer l’admin (mot de passe ≥ 10 caractères, lettre + chiffre).
3. Ensuite : utilisateur / mot de passe → JWT (navigateur).

### Navigation

| Menu | Contenu |
|------|---------|
| Tableau de bord | Stats, ressources hôte, activité, prune (admin) |
| Stacks | Compose : déployer, start/stop/restart, conteneurs liés, schedules, MàJ images |
| Conteneurs | CRUD, logs, console, inspect, stats, pastille charge, MàJ image |
| Volumes | Named + binds, explorateur de fichiers |
| Images | Liste, pull, build, pastilles CVE + usage |
| Réseaux | Liste, création, schéma d’usage |
| Journaux | Audit applicatif |
| Paramètres | Général, Auth LDAP, Registres, Nœuds, Users, Équipes, Diagnostics |
| Documentation | Ce guide |

La version affichée dans la barre latérale est lue dynamiquement via `/api/status`.

#### Paramètres

| Sous-menu | Contenu |
|-----------|---------|
| Général | URL WharfMaster + hôte des ports, métriques, Trivy, backup ZIP (thème via le bouton header) |
| Authentification | Active Directory / LDAP |
| Registres | Hub / Registry V2 |
| Nœuds | Agents : commande / pack ZIP, ping, ACL, pin TLS |
| Utilisateurs | Comptes locaux |
| Équipes | Groupes + membres (+ mapping AD) |
| Diagnostics | Santé runtime |
| Tests API | Smoke Docker (image / volume / réseau / conteneur) |

### Sélecteur de nœud

En haut à droite : nœud local, agent, ou **Tous les nœuds** (agrégat surtout en **lecture**). Les écritures Docker demandent un nœud précis ; les actions **stack** passent par l’id de stack (nœud d’origine).

### Stacks

- Créer / éditer le YAML + variables `.env` ; option **Pull images** au déploiement.
- Fiche stack : barre d’actions complète (démarrer, arrêter, redémarrer, éditeur, partager, pull+redéployer, supprimer).
- Section **Conteneurs** : services Compose du projet (`com.docker.compose.project`) avec start / stop / restart.
- **Planifications** : cron convivial (tous les jours, lun–ven, hebdo, horaire) → start / stop / restart.
- Pastille **Images** (vert = à jour, orange = MàJ) : **clic orange** → confirmation → pull + redéploiement Compose.
- Colonne **Créé** (date) dans la liste.

### Conteneurs

- Actions liste : start / stop / restart, pastille charge (vert / orange ≥ 65 % / rouge ≥ 85 %, refresh ~10 s sur la page visible), logs / console / inspect / partager (menu …).
- Modal **Ressources** : jauges live + courbes historiques (rétention configurable).
- Pastille **MàJ** : clic orange → si le conteneur appartient à une stack Compose, upgrade de la **stack** ; sinon pull + recreate du conteneur.
- Colonne **Créé**.

### Images / CVE

- À l’ouverture de **Images** : scan auto des images taguées (pastille CVE OK / C·H·M), cache **24 h**.
- Pull Hub / registre, build Dockerfile, usage par conteneurs.
- Interrupteur global Trivy : Paramètres → Général. L’avis à la création (`advise`) est **non bloquant**.

### Volumes & réseaux

- Volumes named + **binds** (sync auto depuis les Compose, gestion admin).
- Explorateur de fichiers sur volume.
- Réseaux : usage / schéma IP·ports ; partage possible.

### Partages

Un utilisateur peut **partager** stack / conteneur / volume / réseau avec un autre (indépendant des ACL nœuds). Partager une stack **cascade** vers les ressources Compose du même projet. Bouton Partager dans les actions.

### Agents (Paramètres → Nœuds)

1. **Ajouter un nœud** → IP + nom → générer la **commande** ou télécharger le **pack ZIP**.
2. Exécuter sur la machine distante (`--advertise https://…` obligatoire).
3. Empreinte TLS **épinglée** (badge `pin …`).
4. **Accès** : user ou équipe → `lecture` / `opération` / `admin nœud`.
5. Ping, activer / désactiver, délier, éditer nom / URL.

---

## 4. Installation (rappel)

### Docker Compose (recommandé)

```bash
git clone https://github.com/mike37510/WharfMaster.git
cd WharfMaster
export DOCKER_GID=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || echo 999)
docker compose up -d --build
# → http://localhost:9000/app
```

Données : volume `wharfmaster-data` → `var/`. Après clone / upgrade front : `npm install && npm run build`.

Migration legacy (ancienne base `portainer.sqlite` / ancienne arborescence) :

```bash
php bin/migrate-legacy.php
```

### Apache sur l’hôte

Prérequis : PHP 8.2+, Apache (`mod_rewrite`, `AllowOverride All`), socket Docker, `docker` + Compose.  
`DocumentRoot` = **`public/`**. Voir `docker/apache-vhost.conf` et `README.md`.

```bash
php bin/init.php
chown -R www-data:www-data var && chmod 700 var
```

Variables utiles :

```bash
export DOCKER_SOCKET=/var/run/docker.sock
export WM_MASTER_KEY='…'          # chiffrement mots de passe registres
export WHARFMASTER_AGENT_IMAGE=ghcr.io/mike37510/wharfmaster-agent:2.3.5
```

Backup admin :

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" -o backup.zip https://SERVEUR/api/backup
# Restauration : voir RESTORE.md dans l’archive (pas d’upload in-app)
```

---

## 5. API — conventions

### Base URL

```
https://votre-serveur/api
```

### Authentification

1. **JWT** — `Authorization: Bearer <jwt>`
2. **Clé API** — `X-API-Key: ptr_<48 hex>`  
   Générée depuis **Profil** (avatar en haut à droite) ou `POST /api/users/{id}/tokens`.  
   La clé agit avec les **droits du propriétaire** (rôle, ACL, partages).

### Format

- JSON : `Content-Type: application/json`
- Erreurs : `{ "message": "…" }` + code HTTP
- Alignement **Portainer CE** sur de nombreux chemins
- Extensions WharfMaster additives : `/api/acls`, `/api/shares`, `/api/schedules`, `/api/metrics/*`, diagnostics, scans Trivy, updates d’images, etc.

### Exemple de session

```bash
TOKEN=$(curl -fsS -X POST https://SERVEUR/api/auth \
  -H 'Content-Type: application/json' \
  -d '{"Username":"admin","Password":"VotreMotDePasse1"}' \
  | jq -r .jwt)

curl -fsS https://SERVEUR/api/users/me -H "Authorization: Bearer $TOKEN"
curl -fsS https://SERVEUR/api/health
```

### Console interactive (WebSocket)

1. `POST /api/endpoints/{id}/containers/{cid}/console` avec `{ "shell": "/bin/sh" }` → `{ Id, Token }`
2. Ouvrir `wss://SERVEUR/api/websocket/exec?id=<Id>&endpointId=<id>&token=<Token>`
3. Flux TTY bidirectionnel (stdin/stdout) ; resize via `POST …/console/{Id}/resize?h=&w=`

Le reverse-proxy (npmplus, nginx, Traefik…) doit transmettre `Upgrade` et `Connection` sur `/api/websocket/`.

---

## 6. API — publics / système

| Méthode | Chemin | Auth | Description |
|---------|--------|------|-------------|
| GET | `/api/status` | non | Version + InstanceID |
| GET | `/api/system/status` | non | Alias status |
| GET | `/api/system/version` | non | Version + image agent |
| GET | `/api/health` | non | Checks docker / compose / data / sqlite |
| GET | `/api/system/diagnostics` | admin | Diagnostics détaillés |
| GET | `/api/users/admin/check` | non | `{ "adminInit": true\|false }` |
| POST | `/api/users/admin/init` | non* | Premier admin |
| POST | `/api/auth` | non | Login → `{ jwt }` |
| POST | `/api/nodes/join` | token wmj_ | Enrôlement agent |
| GET | `/api/metrics/history?scope=&hours=` | user | Historique courbes |
| POST | `/api/metrics/sample` | user | Échantillon (CPU/RAM/…) |

`scope` métriques : `ep:{id}`, `all`, ou `ctr:{ep}:{containerId}`.

---

## 7. API — utilisateurs, paramètres, audit

| Méthode | Chemin | Rôle | Description |
|---------|--------|------|-------------|
| GET | `/api/users/me` | user | Profil |
| GET/POST | `/api/users` | admin | Liste / créer |
| PUT | `/api/users/{id}/passwd` | self/admin | Mot de passe |
| DELETE | `/api/users/{id}` | admin | Supprimer |
| GET | `/api/users/{id}/tokens` | self/admin | Lister les clés API |
| POST | `/api/users/{id}/tokens` | self/admin | Créer une clé (`password` + `description`) → `rawAPIKey` une fois |
| DELETE | `/api/users/{id}/tokens/{tid}` | self/admin | Révoquer une clé |
| GET/PUT | `/api/settings` | user / admin | PublicURL (WharfMaster), PortsHostURL (ports), métriques, LDAP, Trivy… |
| GET | `/api/backup` | admin | ZIP (`?format=sqlite` = base seule) |
| GET | `/api/audit` | user | Journaux |
| GET | `/api/system/host` | user | Ressources hôte |

---

## 8. API — nœuds, équipes, ACL, partages

| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `/api/endpoints` | Liste (+ `AccessRole`) |
| GET/PUT | `/api/endpoints/{id}` | Détail / policies CE |
| GET | `/api/nodes` | Liste enrichie (admin) |
| POST | `/api/nodes/join-token` | Commande + token |
| GET/POST | `/api/nodes/agent-bundle` | Pack ZIP agent |
| POST | `/api/nodes/{id}/ping` | Ping + refresh TLS |
| GET/POST/DELETE | `/api/acls` | ACL nœud user/équipe |
| GET/POST/DELETE | `/api/shares` | Partages ressources |
| GET/POST | `/api/teams` | Équipes (`?detail=1`) |
| POST/DELETE | `/api/teams/{id}/members…` | Membres |

### Partages

```http
POST /api/shares
{ "ResourceType": "stack|container|volume|network", "ResourceKey": "…", "ToUserId": 2 }
```

Une stack partagée donne accès aux conteneurs / volumes / réseaux Compose du même projet.

---

## 9. API — proxy Docker

```http
{METHOD} /api/endpoints/{endpointId}/docker/{chemin Engine}
Authorization: Bearer …
```

Exemples : `/containers/json?all=true`, `/containers/{id}/start|stop`, `/images/json`, prune, etc. Sur agent : vérification de l’empreinte TLS épinglée.

### Helpers WharfMaster

| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `/api/endpoints/{id}/containers/{cid}/logs` | Logs |
| POST | `/api/endpoints/{id}/containers/{cid}/exec` | Exec one-shot (JSON) |
| POST | `/api/endpoints/{id}/containers/{cid}/console` | Session TTY → `{ Id, Token }` |
| POST | `/api/endpoints/{id}/console/{eid}/resize` | Resize TTY (`h`, `w`) |
| WS | `/api/websocket/exec?id=&endpointId=&token=` | Attach interactif (hijack Docker) |
| GET | `/api/endpoints/{id}/containers/updates` | Statuts MàJ images (liste) |
| GET | `/api/endpoints/{id}/containers/{cid}/updates` | Statut MàJ d’un conteneur |
| POST | `/api/endpoints/{id}/containers/{cid}/update` | Pull + recreate |
| GET | `/api/images/search?q=` | Recherche Hub |
| POST | `/api/images/build` | Build |
| GET/POST | `/api/endpoints/{id}/images/scans…` | CVE Trivy |
| GET | `/api/volumes/{name}/browse` | Explorateur |
| GET | `/api/bind-volumes` | Binds déclarés |

---

## 10. API — stacks Compose

| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `/api/stacks?endpointId=` | Liste |
| POST | `/api/stacks/create/standalone/string?endpointId=` | Créer + déployer (`PullImages` optionnel) |
| GET | `/api/stacks/{id}` | Métadonnées |
| GET | `/api/stacks/{id}/file` | YAML miroir |
| PUT | `/api/stacks/{id}` | MAJ + `up` (`PullImages`, `prune`) |
| POST | `/api/stacks/{id}/start\|stop\|restart` | Lifecycle |
| DELETE | `/api/stacks/{id}` | `down` + purge |
| GET | `/api/stacks/updates` | Statuts MàJ images (toutes stacks du nœud) |
| GET | `/api/stacks/{id}/updates` | Détail MàJ par service |

Création :

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  "$BASE/api/stacks/create/standalone/string?endpointId=1" \
  -d '{
    "Name": "demo",
    "StackFileContent": "services:\n  web:\n    image: nginx:alpine\n",
    "Env": [],
    "PullImages": true
  }'
```

---

## 11. API — registres

| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET/POST | `/api/registries` | Liste / créer |
| GET/PUT/DELETE | `/api/registries/{id}` | CRUD |
| GET | `/api/registries/{id}/ping` | Test |
| GET | `/api/registries/{id}/repositories` | Dépôts |
| GET | `/api/registries/{id}/tags` | Tags |
| POST | `/api/registries/{id}/pull` | Pull |

Secrets chiffrés (`enc:v1:…`) ; la liste n’expose pas le mot de passe.

---

## 12. API — schedules & CVE

| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `/api/schedules` | Liste (`?stackId=` / `?endpointId=`) |
| POST | `/api/schedules` | Créer (`Action` start\|stop\|restart, `Cron` 5 champs) |
| PUT/DELETE | `/api/schedules/{id}` | MAJ / supprimer |
| POST | `/api/schedules/{id}/run` | Exécuter maintenant |
| POST | `/api/schedules/run-due` | Sidecar admin : due now |
| GET/POST | `/api/endpoints/{id}/images/scan…` | Scans Trivy |
| POST | `/api/endpoints/{id}/images/scans/ensure` | Scan auto liste |
| POST | `/api/endpoints/{id}/images/advise` | Avis soft (jamais bloquant) |

Si `TrivyEnabled=false` : advise → `Worst=disabled` ; scan manuel → 403.

---

## 13. Agent distant

Image : `ghcr.io/mike37510/wharfmaster-agent:2.3.5` (ou `WHARFMASTER_AGENT_IMAGE`).

| Chemin agent | Description |
|--------------|-------------|
| `GET /health` | Docker + compose + TLS |
| `*` `/docker/…` | Proxy Engine |
| `POST /compose/up\|down\|start\|stop\|restart\|config` | Compose |
| `GET /compose/file?name=` | YAML distant |
| `POST /scan/image` | Trivy local |

```bash
curl -fsSL https://SERVEUR/agent/install.sh | sh -s -- \
  --url https://SERVEUR \
  --token wmj_… \
  --advertise https://IP:9001 \
  --name mon-noeud \
  --image ghcr.io/mike37510/wharfmaster-agent:2.3.5
```

Pack ZIP : Paramètres → Nœuds → bundle (Dockerfile, sources, `deploy.sh`, `.env`).

---

## 14. Sécurité (points clés)

- Non-admin : pas de privileged / bind hôte / docker.sock / network|pid host ; Compose validé résolu.
- ACL nœud : `read` / `operate` / `admin` (user ou équipe) ; admins globaux toujours OK.
- Partages = exception explicite ressource par ressource (en plus des ACL).
- Rate-limit login / join ; JWT TTL 4 h ; rôle relu en base.
- TLS agent : empreinte SHA-256 ; refresh pin si `/health` Bearer OK.
- DocumentRoot = `public/` uniquement.

---

## 15. Limites connues

- **Tous les nœuds** : agrégation surtout en lecture pour Docker.
- Pas de placement multi-nœud d’une même stack.
- Pas de sync si édition manuelle des fichiers sur l’agent.
- Console interactive via WebSocket (`/api/websocket/exec`) — le reverse-proxy frontal doit laisser passer `Upgrade` / `Connection`.
- Swarm / secrets Engine / plugins : bloqués au proxy.
- Pas de Kubernetes / Edge / NAT-tunnel ; l’agent doit être joignable depuis le principal.
- Pas de SSO OIDC/SAML (LDAP/AD uniquement).
- Backup = téléchargement ; restore manuel (`RESTORE.md`).
- Templates « App Templates » / stacks Git : non fournis (Compose string uniquement).
- Scan CVE dépend de Trivy ; désactivable sans bloquer les déploiements.

---

## 16. Fichiers utiles

| Fichier | Rôle |
|---------|------|
| `README.md` | Install & overview |
| `CHANGELOG.md` | Historique versions |
| `SECURITY.md` | Durcissement |
| `docs/DOCUMENTATION.md` | Ce guide (`/docs/…` en console) |
| `config/app.php` | Config lecture seule |
| `bin/init.php` / `bin/migrate-legacy.php` | Init / migration |
| `public/index.php` | Front controller |
| `agent/install.sh` | Installer un nœud |
| `package.json` | `npm run build` → `public/assets/js/app.js` |

Pour toute évolution API, privilégier la compatibilité Portainer CE lorsque c’est pertinent, et documenter les extensions WharfMaster ici.
