# WharfMaster — Documentation

Guide d’utilisation de la console et de l’**API HTTP**. Version applicative : **2.1.0**.

| | |
|---|---|
| Console | `/app` (`/` redirige vers `/app`) |
| API | `/api` |
| DocumentRoot | `public/` uniquement |
| Santé | `GET /api/health` |
| Dépôt | https://github.com/mike37510/WharfMaster |

---

## 1. Présentation

**WharfMaster** est une interface web de gestion Docker :

- conteneurs, images, volumes, réseaux ;
- stacks Compose (nœud local **et** agents distants) ;
- registres (Docker Hub / Registry V2) ;
- multi-utilisateurs avec isolation par labels ;
- **équipes**, **ACL par nœud**, **SSO AD/LDAP**, **scheduler**, **scan CVE Trivy** ;
- infrastructure **multi-nœuds** via agents HTTPS ;
- API compatible **Portainer CE** pour scripts et clients existants.

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
| SQLite `var/` | utilisateurs, endpoints, stacks, registres, audit |

Les stacks distantes : le principal **valide** (`ComposePolicy` + `docker compose config`) et **stocke un miroir** ; le déploiement réel (`up` / `down` / start / stop) est délégué à l’agent.

---

## 3. Console

### Connexion

1. Ouvrir `/app`.
2. Premier démarrage : créer l’admin (mot de passe ≥ 10 caractères, lettre + chiffre).
3. Ensuite : utilisateur / mot de passe → JWT stocké côté navigateur.

### Navigation

| Menu | Contenu |
|------|---------|
| Tableau de bord | Stats, aperçus, répartition multi-nœuds |
| Conteneurs / Images / Volumes / Réseaux | CRUD Docker (nœud sélectionné) ; Images : pastilles CVE |
| Stacks | Compose : déployer, démarrer, arrêter, redémarrer, supprimer, schedules |
| Journaux | Audit applicatif |
| Paramètres (admin) | Sous-menus : Général, Authentification (LDAP), Registres, Nœuds, Utilisateurs, Équipes |
| Documentation | Ce guide |
| À propos | Version et licence |

#### Paramètres (admin)

| Sous-menu | Contenu |
|-----------|---------|
| Général | Thème, URL publique, métriques, Trivy on/off, backup |
| Authentification | Active Directory / LDAP |
| Registres | Hub / Registry V2 |
| Nœuds | Agents : ajouter, éditer, **Accès** (ACL user/équipe), ping, délier |
| Utilisateurs | Comptes locaux |
| Équipes | Groupes + membres (recherche / ajout / retrait) |

### Sélecteur de nœud

En haut à droite : nœud local, agent, ou **Tous les nœuds** (listes agrégées en lecture). Les actions d’écriture Docker exigent en général un nœud précis ; les actions **stack** (start/stop/…) fonctionnent via l’id de stack (nœud d’origine).

### Stacks

- Créer / éditer le YAML + variables `.env`.
- Actions : **Démarrer**, **Arrêter**, **Redémarrer**, **Supprimer** (comme les conteneurs).
- Sur un agent : fichiers hôte sous `/var/lib/wharfmaster/stacks` (monté dans l’agent).

### Agents (Paramètres → Nœuds)

1. **Ajouter un nœud** → IP + nom → **Générer la commande**.
2. Exécuter `install.sh` sur la machine distante (`--advertise https://…` obligatoire).
3. L’empreinte TLS du certificat agent est **épinglée** (badge `pin …`).
4. **Accès** (icône users) : rechercher un utilisateur ou une équipe et attribuer `lecture` / `opération` / `admin nœud`.
5. **Modifier** : renommer, changer l’URL agent / URL publique.

Relancer l’install sur le même advertise = **rejoin** (nouveau secret).

### CVE (Trivy)

- Activable dans **Paramètres → Général**.
- Pastilles sur Images + scan manuel.
- À la création conteneur / stack : avis non bloquant (`advise`) ; Trivy KO n’empêche jamais le déploiement.

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

Fichiers : `Dockerfile`, `docker-compose.yml`, `.env.example`. Données dans le volume `wharfmaster-data`.

### Apache sur l’hôte

Prérequis : PHP 8.2+, Apache (`mod_rewrite`, `AllowOverride All`), socket Docker, binaires `docker` + Compose.  
`DocumentRoot` = **`public/`** uniquement. Voir `docker/apache-vhost.conf` et `README.md`.

```bash
git clone https://github.com/mike37510/WharfMaster.git
cd WharfMaster
php bin/init.php
chown -R www-data:www-data var && chmod 700 var
```

Variables utiles :

```bash
export DOCKER_SOCKET=/var/run/docker.sock
export WM_MASTER_KEY='…'          # chiffrement mots de passe registres
export WHARFMASTER_AGENT_IMAGE=ghcr.io/mike37510/wharfmaster-agent:2.1.0
```

Backup admin (ZIP complet ; `?format=sqlite` = base seule) :

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" -o backup.zip https://SERVEUR/api/backup
```

---

## 5. API — conventions

### Base URL

```
https://votre-serveur/api
```

### Authentification

Deux modes :

1. **JWT** (console / scripts)  
   `Authorization: Bearer <jwt>`
2. **Clé API** (intégrations)  
   `X-API-Key: ptr_<48 hex>`  
   (générée depuis la console utilisateurs)

### Format

- Corps JSON : `Content-Type: application/json`
- Erreurs : `{ "message": "…" }` + code HTTP
- Alignement volontaire avec **Portainer CE** sur de nombreux chemins
- Extensions WharfMaster (`/api/acls`, `/api/schedules`, scans Trivy, `AccessRole`, `RegistryKind`) : **additives**, n’écrasent pas les shapes CE
- Policies d’accès nœud exposées comme Portainer : `UserAccessPolicies` / `TeamAccessPolicies` avec `{ "RoleId": 1|2|3 }`
  (1 ≈ admin nœud, 2 ≈ operate, 3 ≈ read) — aussi via `PUT /api/endpoints/{id}`
- Équipes : `GET /api/teams` = tableau CE ; memberships CE via `/api/team_memberships`
- LDAP : `AuthenticationMethod` + `LDAPSettings` (shape CE) en plus de `Ldap` (UI WM)

### Exemple de session

```bash
# 1. Login
TOKEN=$(curl -fsS -X POST https://SERVEUR/api/auth \
  -H 'Content-Type: application/json' \
  -d '{"Username":"admin","Password":"VotreMotDePasse1"}' \
  | jq -r .jwt)

# 2. Qui suis-je ?
curl -fsS https://SERVEUR/api/users/me \
  -H "Authorization: Bearer $TOKEN"

# 3. Santé (sans auth)
curl -fsS https://SERVEUR/api/health
```

Réponse login :

```json
{ "jwt": "eyJ…" }
```

---

## 6. API — endpoints publics / système

| Méthode | Chemin | Auth | Description |
|---------|--------|------|-------------|
| GET | `/api/status` | non | Version + InstanceID |
| GET | `/api/system/status` | non | Alias status |
| GET | `/api/system/version` | non | Version détaillée + image agent |
| GET | `/api/health` | non | Checks docker / compose / data / sqlite |
| GET | `/api/users/admin/check` | non | `{ "adminInit": true\|false }` |
| POST | `/api/users/admin/init` | non* | Créer le premier admin (*si aucun user) |
| POST | `/api/auth` | non | Login → `{ jwt }` |
| POST | `/api/nodes/join` | token wmj_ | Enrôlement agent (pas de JWT) |

### Init admin

```http
POST /api/users/admin/init
Content-Type: application/json

{ "Username": "admin", "Password": "MotDePasse12" }
```

### Health

```json
{
  "ok": true,
  "version": "2.1.0",
  "checks": {
    "docker": true,
    "dockerSocket": true,
    "compose": true,
    "dataWritable": true,
    "composeDirWritable": true,
    "sqlite": true
  }
}
```

---

## 7. API — utilisateurs & paramètres

| Méthode | Chemin | Rôle | Description |
|---------|--------|------|-------------|
| GET | `/api/users/me` | user | Profil courant |
| GET | `/api/users` | admin | Liste |
| POST | `/api/users` | admin | Créer `{ Username, Password, Role }` (1=admin, 2=user) |
| PUT | `/api/users/{id}/passwd` | self/admin | Changer mot de passe |
| DELETE | `/api/users/{id}` | admin | Supprimer |
| POST | `/api/users/{id}/tokens` | self/admin | Créer clé API |
| GET | `/api/settings` | user | Paramètres (`PublicURL`, `Ldap`/`LDAPSettings`, `TrivyEnabled`…) |
| PUT | `/api/settings` | admin | MAJ (URL, métriques, LDAP, `TrivyEnabled`) |
| GET | `/api/backup` | admin | Backup ZIP complet (SQLite, Compose, Dockerfiles, JWT). `?format=sqlite` = base seule |
| GET | `/api/audit` | user | Journaux (`?limit=&offset=&action=`) |
| GET | `/api/system/host` | user | Ressources hôte |

### Changement de mot de passe

```http
PUT /api/users/1/passwd
Authorization: Bearer …
Content-Type: application/json

{
  "Password": "NouveauMot12",
  "PasswordConfirm": "NouveauMot12",
  "CurrentPassword": "AncienMot12"
}
```

`CurrentPassword` obligatoire pour soi-même. `PasswordConfirm` vérifié s’il est envoyé.

---

## 8. API — endpoints / nœuds

| Méthode | Chemin | Rôle | Description |
|---------|--------|------|-------------|
| GET | `/api/endpoints` | user | Liste (format Portainer + `AccessRole`) |
| GET | `/api/endpoints/{id}` | user | Détail |
| PUT | `/api/endpoints/{id}` | admin | MAJ policies CE (`UserAccessPolicies` / `TeamAccessPolicies`) |
| GET | `/api/teams` | admin | Liste CE `[{Id,Name}]` — `?detail=1` pour Members/AD |
| GET/POST | `/api/team_memberships` | admin | Memberships shape Portainer |
| GET | `/api/teams/{id}/memberships` | admin | Memberships d’une équipe |
| GET | `/api/users/{id}` | admin | Détail utilisateur |
| GET | `/api/nodes` | admin | Liste enrichie (TLS, pin, `Disabled`…) |
| PUT | `/api/nodes/{id}` | admin | Renommer / URL agent / URL publique |
| GET | `/api/nodes/join-token` | admin | Métadonnées token actif |
| POST | `/api/nodes/join-token` | admin | Générer commande + token |
| POST | `/api/nodes/join-token/rotate` | admin | Rotation |
| POST | `/api/nodes/{id}/ping` | admin | Ping + refresh TLS |
| POST | `/api/nodes/{id}/disable` | admin | Désactiver |
| POST | `/api/nodes/{id}/enable` | admin | Activer |
| DELETE | `/api/nodes/{id}` | admin | Délier |
| POST | `/api/nodes/join` | wmj_ | Join agent |
| GET | `/api/acls?endpointId=` | admin | Liste ACL (filtre nœud optionnel) |
| POST | `/api/acls` | admin | Upsert `{ EndpointId, SubjectType, SubjectId, Role }` |
| DELETE | `/api/acls/{id}` | admin | Retirer un droit |
| GET/POST | `/api/teams` | admin | CRUD équipes (`?detail=1`) |
| PUT/DELETE | `/api/teams/{id}` | admin | MAJ / supprimer |
| POST/DELETE | `/api/teams/{id}/members[/{uid}]` | admin | Membres |

### Join agent (côté machine distante via install.sh)

```http
POST /api/nodes/join
Content-Type: application/json

{
  "token": "wmj_…",
  "name": "node5",
  "agentUrl": "https://192.168.1.5:9001"
}
```

Réponse : `NodeSecret`, `NodeId`, éventuelle `TlsFingerprint`.

---

## 9. API — proxy Docker

Toute l’API Engine Docker est exposée sous :

```http
{METHOD} /api/endpoints/{endpointId}/docker/{chemin Engine}
Authorization: Bearer …
```

Exemples :

```bash
# Conteneurs
curl -fsS -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/endpoints/1/docker/containers/json?all=true"

# Start / stop
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/endpoints/1/docker/containers/ID/start"

curl -fsS -X POST -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/endpoints/1/docker/containers/ID/stop"

# Images
curl -fsS -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/endpoints/1/docker/images/json"
```

Sur un **agent**, le principal vérifie l’empreinte TLS épinglée avant le proxy.

### Helpers WharfMaster (hors Engine brut)

| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `/api/endpoints/{id}/containers` | Liste filtrée (scope user) |
| GET | `/api/endpoints/{id}/containers/{cid}/logs` | Logs enrichis |
| POST | `/api/endpoints/{id}/containers/{cid}/exec` | Exécuter une commande (pas un attach TTY interactif) |
| GET | `/api/images/search?q=` | Recherche Hub |
| GET | `/api/images/tags?repo=` | Tags |
| POST | `/api/images/build` | Build Dockerfile |
| GET/POST/DELETE | `/api/dockerfiles[/{name}]` | Bibliothèque Dockerfiles |
| GET | `/api/volumes/{name}/browse?path=` | Explorateur volume |
| GET/POST/DELETE | `/api/volumes/{name}/file` … | Fichiers volume |

---

## 10. API — stacks Compose

| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `/api/stacks?endpointId=` | Liste (`0` / absent = tous) |
| POST | `/api/stacks/create/standalone/string?endpointId=` | Créer + déployer |
| GET | `/api/stacks/{id}` | Métadonnées |
| GET | `/api/stacks/{id}/file` | Contenu YAML (miroir) |
| PUT | `/api/stacks/{id}` | Mettre à jour + `up` |
| POST | `/api/stacks/{id}/start` | `compose start` (ou `up`) |
| POST | `/api/stacks/{id}/stop` | `compose stop` |
| POST | `/api/stacks/{id}/restart` | `compose restart` |
| DELETE | `/api/stacks/{id}` | `down` + purge |

### Créer une stack

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  "$BASE/api/stacks/create/standalone/string?endpointId=1" \
  -d '{
    "Name": "demo",
    "StackFileContent": "services:\n  web:\n    image: nginx:alpine\n    ports:\n      - \"8088:80\"\n",
    "Env": [{ "name": "FOO", "value": "bar" }]
  }'
```

Sur `endpointId` agent : validation locale + `POST` agent `/compose/up`.

---

## 11. API — registres

| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `/api/registries` | Liste |
| POST | `/api/registries` | Créer |
| GET/PUT/DELETE | `/api/registries/{id}` | CRUD |
| GET | `/api/registries/{id}/ping` | Test |
| GET | `/api/registries/{id}/repositories?q=` | Dépôts |
| GET | `/api/registries/{id}/tags?repo=` | Tags |
| POST | `/api/registries/{id}/pull` | Pull `{ Repository, Tag }` |

Les mots de passe sont stockés chiffrés (`enc:v1:…`) ; l’API de liste n’expose pas le secret en clair (flag `Authentication`).

---

## 12. API — schedules & CVE

| Méthode | Chemin | Description |
|---------|--------|-------------|
| GET | `/api/schedules` | Liste (`?stackId=` / `?endpointId=`) |
| POST | `/api/schedules` | Créer (cron + action start/stop/restart) |
| PUT/DELETE | `/api/schedules/{id}` | MAJ / supprimer |
| POST | `/api/schedules/{id}/run` | Exécuter maintenant |
| GET | `/api/endpoints/{id}/images/scans` | Résumés scans Trivy |
| GET | `/api/endpoints/{id}/images/scan?ref=` | Dernier scan + findings |
| POST | `/api/endpoints/{id}/images/scan` | Lancer un scan (`Force` optionnel) |
| POST | `/api/endpoints/{id}/images/advise` | Avis soft (création/deploy) — **jamais bloquant** |

Si `TrivyEnabled=false` : advise renvoie `Worst=disabled` ; scan manuel → 403.

---

## 13. Agent distant (référence)

Image : `ghcr.io/mike37510/wharfmaster-agent:2.1.0` (ou build local).

| Chemin agent | Description |
|--------------|-------------|
| `GET /health` | Docker + `compose` + TLS expiry |
| `*` `/docker/…` | Proxy Engine (Bearer `NODE_SECRET`) |
| `POST /compose/up\|down\|start\|stop\|restart\|config` | Runtime Compose |
| `GET /compose/file?name=` | Lire YAML distant |
| `POST /scan/image` | Scan Trivy local à l’agent |

Install :

```bash
curl -fsSL https://SERVEUR/agent/install.sh | sh -s -- \
  --url https://SERVEUR \
  --token wmj_… \
  --advertise https://IP:9001 \
  --name mon-noeud \
  --image ghcr.io/mike37510/wharfmaster-agent:2.1.0
```

---

## 14. Sécurité (points clés)

- Non-admin : pas de privileged / bind hôte / docker.sock / network|pid host ; Compose validé résolu.
- ACL nœud : `read` / `operate` / `admin` (direct user ou via équipe) ; admins globaux toujours autorisés.
- Rate-limit login / join.
- JWT TTL 4 h ; rôle relu en base à chaque requête.
- TLS agent : empreinte SHA-256 ; refresh pin seulement si `/health` Bearer OK (renouvellement cert).
- HSTS si `HTTPS=on`.
- DocumentRoot = `public/` uniquement ; `var/`, `src/`, `config/`, `agent/` hors webroot.

---

## 15. Limites connues

- Mode **Tous les nœuds** : agrégation surtout en lecture pour Docker.
- Pas de placement multi-nœud d’une même stack.
- Pas de sync si édition manuelle des fichiers sur l’agent.
- Console conteneur = exécution de commandes (pas d’attach TTY interactif).
- Swarm / secrets Engine bloqués au proxy.
- L’agent doit être joignable depuis le principal (pas de mode edge/NAT).
- Scan CVE dépend de Trivy (local ou agent) ; désactivable sans bloquer les déploiements.

---

## 16. Fichiers utiles

| Fichier | Rôle |
|---------|------|
| `README.md` | Install & overview |
| `CHANGELOG.md` | Historique versions |
| `SECURITY.md` | Modèle de durcissement |
| `docs/DOCUMENTATION.md` | Ce guide (servi en console via `/docs/…`) |
| `config/app.php` | Configuration (lecture seule) |
| `bin/init.php` | Init runtime `var/` |
| `public/index.php` | Front controller unique |
| `agent/install.sh` | Installer un nœud (`/agent/install.sh`) |

Pour toute évolution API, privilégier la compatibilité Portainer CE lorsque c’est pertinent, et documenter les extensions WharfMaster (`/api/health`, `/api/backup`, `/api/stacks/{id}/start|stop|restart`, nœuds, etc.) dans ce fichier.
