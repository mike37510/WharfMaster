# WharfMaster

**WharfMaster** est une interface web de gestion Docker : conteneurs, images, volumes, réseaux, stacks Compose et registres — avec isolation multi-utilisateurs et une API compatible Portainer CE.

| | |
|---|---|
| **Version** | 1.4.2 |
| **Console** | `/app` |
| **Site public** | `/` |
| **API** | `/api` |
| **Dépôt** | https://github.com/mike37510/WharfMaster |

<p align="center">
  <img src="public/img/wharfmaster-logo.jpg" alt="WharfMaster" width="420">
</p>

## Captures d’écran

### Tableau de bord

![Tableau de bord WharfMaster](public/site/shots/dashboard.png)

### Conteneurs

![Liste des conteneurs](public/site/shots/containers.png)

### Explorateur de volumes

![Explorateur de volumes](public/site/shots/volume-browse.png)

### Images

![Images Docker](public/site/shots/images.png)

### Connexion

![Écran de connexion](public/site/shots/login.png)

---

## Fonctionnalités

- **Tableau de bord** — stats, conteneurs, ressources hôte (CPU / RAM / disque), activité ; vue **Tous les nœuds** agrégée
- **Conteneurs** — création, start / stop / restart, logs (suivi live, recherche, export), console, inspect
- **Images** — recherche locale + Docker Hub, pull, build Dockerfile
- **Volumes** — création, explorateur de fichiers (créer / renommer / supprimer au clic droit)
- **Réseaux & stacks Compose** — éditeur YAML, variables `.env`, déploiement local **et sur agents**
- **Registres** — Docker Hub / Registry V2, parcours dépôts & tags, pull
- **Utilisateurs** — rôles admin / utilisateur, isolation par labels `dockermanager.owner*`
- **Journaux** — audit applicatif (connexions, actions Docker / stacks / utilisateurs)
- **Nœuds (multinode)** — agents HTTPS, token de jointure, sélecteur (nœud ou **Tous**), TLS, délier, stacks distantes
- **Sécurité** — rate-limit login, politique Compose résolue (`docker compose config`), proxy Docker restreint pour les non-admins

---

## Multinode (agents)

Le serveur principal génère un **token de jointure**. Sur chaque hôte Docker distant, une commande installe un **agent HTTPS** (certificat autosigné) ; le principal proxyfie l’API Docker via cet agent. Le certificat est renouvelé automatiquement ~30 jours avant expiration ; la page **Nœuds** affiche la date de renouvellement / expiration TLS.

Les **stacks Compose** peuvent être déployées sur un nœud agent : le principal valide le YAML (`ComposePolicy` + `docker compose config`) et conserve un miroir local pour l’éditeur ; l’agent exécute `docker compose up/down` sur le socket Docker du nœud. Les projets sont stockés sur l’hôte agent sous `/var/lib/wharfmaster/stacks` (monté dans l’agent en `/data/stacks`).

### Enrôler un nœud

1. Console → **Nœuds** (admin) → saisir l’**IP** et le **nom** du nœud → **Générer la commande**
2. Copier-coller la commande sur la machine distante (Docker + curl). L’URL `--url` reprend l’**URL publique** configurée dans Paramètres. **`--advertise` doit être en `https://`**.

Exemple (valeurs déjà remplies par l’UI) :

```bash
curl -fsSL https://VOTRE-SERVEUR/public/agent/install.sh | sh -s -- \
  --url https://VOTRE-SERVEUR \
  --token wmj_... \
  --advertise https://192.168.1.5:9001 \
  --name node5
```

Optionnel : `--stacks-dir /chemin` (défaut `/var/lib/wharfmaster/stacks`).

3. Dans la console, choisir le nœud via le sélecteur en haut à droite — ou **Tous les nœuds** pour le dashboard / listes agrégés (lecture seule ; create/update/delete stack et actions Docker demandent un nœud précis).

Le nœud local ne peut pas être délié. Relancer `install.sh` sur le même advertise **rejoint** le nœud (nouveau secret) et met à jour l’image agent (Compose inclus). Les échanges HTTP non chiffrés vers l’agent sont refusés à la jointure.

Fichiers agent : [`agent/`](agent/), script public : [`public/agent/install.sh`](public/agent/install.sh).

---

## Prérequis

- **PHP 8.2+** avec Apache (`mod_rewrite`, `AllowOverride All`)
- Accès au **socket Docker** : `/var/run/docker.sock` ou `/var/run/docker.so`
- Binaires **`docker`** et Compose (`docker compose` ou `docker-compose`)
- Droits d’écriture Apache sur le dossier `data/` (créé au premier démarrage)

---

## Installation

### 1. Cloner le projet

```bash
git clone https://github.com/mike37510/WharfMaster.git
cd WharfMaster
```

### 2. Déployer sous Apache

Placez le contenu à la racine du DocumentRoot (ex. `/var/www/html`) **ou** configurez un VirtualHost pointant vers ce dossier.

Exemple minimal :

```apache
<VirtualHost *:80>
    ServerName wharfmaster.example.com
    DocumentRoot /var/www/html

    <Directory /var/www/html>
        AllowOverride All
        Require all granted
    </Directory>
</VirtualHost>
```

Activez les modules nécessaires :

```bash
a2enmod rewrite headers
systemctl reload apache2
```

### 3. Permissions

```bash
mkdir -p data
chown -R www-data:www-data data
chmod 700 data
```

L’utilisateur Apache doit pouvoir lire/écrire le socket Docker (groupe `docker` en général).

### 4. Ouvrir l’application

| URL | Rôle |
|-----|------|
| `http://votre-hote/` | Site public de présentation |
| `http://votre-hote/app` | Console WharfMaster |
| `http://votre-hote/api/status` | Version / InstanceID |
| `http://votre-hote/api/health` | Santé (docker, compose, `data/`) |
| `http://votre-hote/api/backup` | Export SQLite (admin, JWT) |

---

## Premier démarrage / connexion

### Première installation (aucun compte)

1. Aller sur **`/app`**
2. WharfMaster détecte qu’aucun admin n’existe (`adminInit`)
3. Créer le **compte administrateur** :
   - **Nom d’utilisateur** : libre (le champ est prérempli avec `admin`)
   - **Mot de passe** : **au moins 10 caractères**, avec **au moins une lettre et un chiffre**

Il n’y a **pas** de mot de passe par défaut : vous le choisissez à l’initialisation.

### Connexions suivantes

| Champ | Valeur typique |
|-------|----------------|
| Utilisateur | celui créé à l’init (souvent `admin`) |
| Mot de passe | celui défini à l’initialisation |

> Si vous avez oublié le mot de passe admin : réinitialisez-le via la base SQLite `data/dockermanager.sqlite` (table `users`) ou recréez un environnement propre en vidant `data/` (perte des users / stacks enregistrés).

### Comptes utilisateurs

Un **admin** peut créer d’autres utilisateurs dans **Utilisateurs** (rôle admin ou utilisateur).  
Les non-admins ne voient que leurs ressources (labels propriétaire / stacks personnelles).

---

## Configuration

Fichier principal : [`config.php`](config.php)

| Clé | Description | Défaut |
|-----|-------------|--------|
| `docker_socket` | Socket Docker | auto (`DOCKER_SOCKET` / `.so` / `.sock`) |
| `sqlite_path` | Base SQLite | `data/dockermanager.sqlite` |
| `jwt_secret` | Secret JWT (fichier) | `data/jwt.secret` (généré auto) |
| `jwt_ttl` | Durée de session | 4 heures |
| `compose_dir` | Projets Compose | `data/compose` |
| `dockerfiles_dir` | Dockerfiles sauvés | `data/dockerfiles` |

Variables d’environnement utiles :

```bash
export DOCKER_SOCKET=/var/run/docker.sock
export DOCKER_BIN=/usr/bin/docker
export COMPOSE_BIN=/usr/local/bin/docker-compose
export DOCKER_API_VERSION=v1.45
export WM_MASTER_KEY='…'   # chiffrement registres (sinon dérivé de jwt.secret)
export WHARFMASTER_AGENT_IMAGE=ghcr.io/mike37510/wharfmaster-agent:1.4.2
```

### Backup / restauration

```bash
# Export (admin JWT)
curl -fsS -H "Authorization: Bearer $TOKEN" -o backup.sqlite https://VOTRE-SERVEUR/api/backup

# Restauration : arrêter Apache, remplacer data/dockermanager.sqlite, redémarrer
# Conserver aussi data/jwt.secret (et WM_MASTER_KEY) pour déchiffrer les registres.
```

Sources agent : éditer [`agent/`](agent/) puis `sh scripts/sync-agent.sh` avant release.

---

## Sécurité (rappel)

- **`data/`** contient JWT + SQLite → ne pas exposer (bloqué par `.htaccess` / Apache)
- En production : **HTTPS** obligatoire (HSTS activé si `HTTPS=on`)
- Agents : empreinte TLS épinglée (SHA-256) ; mismatch → refus (rejoindre le nœud)
- Mots de passe registres chiffrés at-rest (`enc:v1:…`)
- Non-admin : pas de `privileged`, bind hôte, `docker.sock`, `network/pid: host`, etc.
- Stacks non-admin validées via `docker compose config` (YAML + `.env` résolus)
- Rate-limit : 8 tentatives de login / 15 min par IP

---

## Documentation

Guide produit + **référence API** (auth JWT / clé API, Docker proxy, stacks, nœuds, registres, health, backup) :

- Fichier : [`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md)
- Console : menu **Documentation** (`/app#docs`)

---

## API compatible Portainer CE

WharfMaster expose une **API alignée sur Portainer CE** (`/api`). L’intérêt : une application qui parlait déjà à Portainer peut basculer vers WharfMaster **sans être réécrite** — même protocole en entrée, Docker Engine derrière.

<p align="center">
  <img src="docs/api-portainer-adapter.png" alt="WharfMaster remplace Portainer : même API, Docker derrière, zéro recodage" width="520">
</p>

**En résumé**

| | Avant | Avec WharfMaster |
|---|---|---|
| Ton app | parle API Portainer | **identique** (zéro recodage) |
| Intermédiaire | Portainer | **WharfMaster** (adaptateur) |
| Infra | Docker | **même Docker** |

- **Entrée** : protocole / endpoints type Portainer CE  
- **Sortie** : Docker Engine (socket / API)  
- **Gain** : conserver clients, scripts et intégrations existants

### Endpoints (aperçu)

```http
GET  /api/status
GET  /api/users/admin/check
POST /api/users/admin/init
POST /api/auth
GET  /api/users/me
GET  /api/endpoints
…   /api/endpoints/1/docker/*
GET|POST /api/stacks
GET|POST /api/registries
```

Authentification : header `Authorization: Bearer <jwt>` (obtenu via `POST /api/auth`).

---

## Structure du dépôt

```
├── api/                 Front controller API PHP
├── agent/               Agent distant (Dockerfile + PHP)
├── docs/                Documentation (`DOCUMENTATION.md`) + visuels API
├── public/
│   ├── index.html       SPA console (/app)
│   ├── js/ css/         Interface
│   ├── img/             Logo WharfMaster
│   └── site/            Site public (/)
├── src/                 Code applicatif PHP
├── config.php           Configuration
├── index.php            Entrée racine
├── .htaccess            Routage + protections
├── CHANGELOG.md
└── README.md
```

Le dossier `data/` (runtime) est **ignoré par git** (secrets, base, compose déployés).

---

## Dépannage

| Problème | Piste |
|----------|--------|
| Page blanche / 404 sur `/app` | `mod_rewrite` + `AllowOverride All` |
| « Docker offline » | Socket accessible par `www-data` ? `ls -l /var/run/docker.sock` |
| Stacks Compose échouent | `docker` / `docker compose` dans le PATH Apache |
| Impossible de se connecter | Mot de passe ≥ 10 car. lettre+chiffre ; rate-limit éventuel |
| Réinit complète | Arrêter Apache, supprimer `data/`, redémarrer → nouvel admin |

---

## Licence

**MIT** — libre d’utilisation, modification et redistribution. Voir [`LICENSE`](LICENSE).
