# WharfMaster

**WharfMaster** est une interface web de gestion Docker : conteneurs, images, volumes, réseaux, stacks Compose et registres — avec isolation multi-utilisateurs et une API compatible Portainer CE.

| | |
|---|---|
| **Version** | 1.0.1 |
| **Console** | `/app` |
| **Site public** | `/` |
| **API** | `/api` |
| **Dépôt** | https://github.com/mike37510/WharfMaster |

---

## Fonctionnalités

- **Tableau de bord** — stats, conteneurs, ressources hôte (CPU / RAM / disque), activité
- **Conteneurs** — création, start / stop / restart, logs, console, inspect
- **Images** — recherche locale + Docker Hub, pull, build Dockerfile
- **Volumes** — création, explorateur de fichiers (créer / renommer / supprimer au clic droit)
- **Réseaux & stacks Compose** — éditeur YAML, variables `.env`, déploiement
- **Registres** — Docker Hub / Registry V2, parcours dépôts & tags, pull
- **Utilisateurs** — rôles admin / utilisateur, isolation par labels `dockermanager.owner*`
- **Sécurité** — rate-limit login, politique Compose résolue (`docker compose config`), proxy Docker restreint pour les non-admins

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
| `http://votre-hote/api/status` | Santé API (JSON) |

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
```

---

## Sécurité (rappel)

- **`data/`** contient JWT + SQLite → ne pas exposer (bloqué par `.htaccess` / Apache)
- En production : **HTTPS** obligatoire
- Non-admin : pas de `privileged`, bind hôte, `docker.sock`, `network/pid: host`, etc.
- Stacks non-admin validées via `docker compose config` (YAML + `.env` résolus)
- Rate-limit : 8 tentatives de login / 15 min par IP

---

## API (aperçu)

Compatible endpoints type Portainer CE :

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

Projet personnel — adapter la licence selon vos besoins.
