# WharfMaster — Documentation

Guide d’utilisation de la console et de l’**API HTTP**. Version applicative : **1.4.4**.

| | |
|---|---|
| Console | `/app` |
| Site public | `/` |
| API | `/api` |
| Santé | `GET /api/health` |
| Dépôt | https://github.com/mike37510/WharfMaster |

---

## 1. Présentation

**WharfMaster** est une interface web de gestion Docker :

- conteneurs, images, volumes, réseaux ;
- stacks Compose (nœud local **et** agents distants) ;
- registres (Docker Hub / Registry V2) ;
- multi-utilisateurs avec isolation par labels ;
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
| SQLite `data/` | utilisateurs, endpoints, stacks, registres, audit |

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
| Conteneurs / Images / Volumes / Réseaux | CRUD Docker (nœud sélectionné) |
| Stacks | Compose : déployer, démarrer, arrêter, redémarrer, supprimer |
| Registres | Hub / registry privés, parcours, pull |
| Nœuds (admin) | Joindre / ping / désactiver / délier des agents |
| Journaux | Audit applicatif |
| Paramètres | URL publique, thème |
| Utilisateurs (admin) | Comptes et mots de passe |
| Documentation | Ce guide |
| À propos | Version et licence |

### Sélecteur de nœud

En haut à droite : nœud local, agent, ou **Tous les nœuds** (listes agrégées en lecture). Les actions d’écriture Docker exigent en général un nœud précis ; les actions **stack** (start/stop/…) fonctionnent via l’id de stack (nœud d’origine).

### Stacks

- Créer / éditer le YAML + variables `.env`.
- Actions : **Démarrer**, **Arrêter**, **Redémarrer**, **Supprimer** (comme les conteneurs).
- Sur un agent : fichiers hôte sous `/var/lib/wharfmaster/stacks` (monté dans l’agent).

### Agents (admin → Nœuds)

1. Saisir IP + nom → **Générer la commande**.
2. Exécuter `install.sh` sur la machine distante (`--advertise https://…` obligatoire).
3. L’empreinte TLS du certificat agent est **épinglée** (affichée en badge `pin …`).

Relancer l’install sur le même advertise = **rejoin** (nouveau secret).

---

## 4. Installation (rappel)

Prérequis : PHP 8.2+, Apache (`mod_rewrite`), accès socket Docker, binaires `docker` + Compose.

```bash
git clone https://github.com/mike37510/WharfMaster.git
cd WharfMaster
mkdir -p data && chown -R www-data:www-data data && chmod 700 data
```

Configurer un VirtualHost sur ce dossier (`AllowOverride All`). Détails : voir `README.md`.

Variables utiles :

```bash
export DOCKER_SOCKET=/var/run/docker.sock
export WM_MASTER_KEY='…'          # chiffrement mots de passe registres
export WHARFMASTER_AGENT_IMAGE=ghcr.io/mike37510/wharfmaster-agent:1.4.4
```

Backup admin :

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" -o backup.sqlite https://SERVEUR/api/backup
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
  "version": "1.4.4",
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
| GET | `/api/settings` | user | Paramètres (URL publique…) |
| PUT | `/api/settings` | admin | Mettre à jour |
| GET | `/api/backup` | admin | Télécharger SQLite |
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
| GET | `/api/endpoints` | user | Liste (format Portainer) |
| GET | `/api/endpoints/{id}` | user | Détail |
| GET | `/api/nodes` | admin | Liste enrichie (TLS, pin…) |
| GET | `/api/nodes/join-token` | admin | Métadonnées token actif |
| POST | `/api/nodes/join-token` | admin | Générer commande + token |
| POST | `/api/nodes/join-token/rotate` | admin | Rotation |
| POST | `/api/nodes/{id}/ping` | admin | Ping + refresh TLS |
| POST | `/api/nodes/{id}/disable` | admin | Désactiver |
| POST | `/api/nodes/{id}/enable` | admin | Activer |
| DELETE | `/api/nodes/{id}` | admin | Délier |
| POST | `/api/nodes/join` | wmj_ | Join agent |

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

## 12. Agent distant (référence)

Image : `ghcr.io/mike37510/wharfmaster-agent:1.4.4` (ou build local).

| Chemin agent | Description |
|--------------|-------------|
| `GET /health` | Docker + `compose` + TLS expiry |
| `*` `/docker/…` | Proxy Engine (Bearer `NODE_SECRET`) |
| `POST /compose/up\|down\|start\|stop\|restart\|config` | Runtime Compose |
| `GET /compose/file?name=` | Lire YAML distant |

Install :

```bash
curl -fsSL https://SERVEUR/public/agent/install.sh | sh -s -- \
  --url https://SERVEUR \
  --token wmj_… \
  --advertise https://IP:9001 \
  --name mon-noeud \
  --image ghcr.io/mike37510/wharfmaster-agent:1.4.4
```

---

## 13. Sécurité (points clés)

- Non-admin : pas de privileged / bind hôte / docker.sock / network|pid host ; Compose validé résolu.
- Rate-limit login / join.
- JWT TTL 4 h ; rôle relu en base à chaque requête.
- TLS agent : empreinte SHA-256 ; refresh pin seulement si `/health` Bearer OK (renouvellement cert).
- HSTS si `HTTPS=on`.
- `data/`, `src/`, `config.php` non exposés via `.htaccess`.

---

## 14. Limites connues

- Mode **Tous les nœuds** : agrégation surtout en lecture pour Docker.
- Pas de placement multi-nœud d’une même stack.
- Pas de sync si édition manuelle des fichiers sur l’agent.
- Console conteneur = exécution de commandes (pas d’attach TTY interactif).
- Swarm / secrets Engine bloqués au proxy.
- L’agent doit être joignable depuis le principal (pas de mode edge/NAT).

---

## 15. Fichiers utiles

| Fichier | Rôle |
|---------|------|
| `README.md` | Install & overview |
| `CHANGELOG.md` | Historique versions |
| `docs/DOCUMENTATION.md` | Ce guide (aussi servi en console) |
| `config.php` | Configuration |
| `scripts/sync-agent.sh` | Aligner `agent/` ↔ `public/agent/` |
| `public/agent/install.sh` | Installer un nœud |

Pour toute évolution API, privilégier la compatibilité Portainer CE lorsque c’est pertinent, et documenter les extensions WharfMaster (`/api/health`, `/api/backup`, `/api/stacks/{id}/start|stop|restart`, nœuds, etc.) dans ce fichier.
