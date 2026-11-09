# WharfMaster — pack agent (déploiement manuel)

Ce dossier contient tout le nécessaire pour déployer un agent distant **sans** passer par le one-liner `curl | sh`.

## Contenu

| Fichier | Rôle |
|---------|------|
| `Dockerfile` | Image PHP agent (TLS, Docker socket, Compose, Trivy) |
| `agent.php` / `router.php` / `entrypoint.sh` | Code de l’agent |
| `docker-compose.yml` | Service + volumes + port |
| `.env` / `.env.example` | URL principal, token, advertise, nom |
| `deploy.sh` | Join API puis `docker compose up -d --build` |
| `install.sh` | Installer alternatif (pull image / build + `docker run`) |

## Prérequis

- Docker (avec le plugin Compose `docker compose` ou `docker-compose`)
- `curl`
- Accès réseau HTTPS vers le principal WharfMaster
- Port agent joignable depuis le principal (défaut **9001**)

## Déploiement rapide

```sh
chmod +x deploy.sh entrypoint.sh install.sh
# Vérifier / compléter .env (WHARFMASTER_URL, JOIN_TOKEN, ADVERTISE_URL, NODE_NAME)
./deploy.sh
```

`deploy.sh` :

1. appelle `POST /api/nodes/join` avec le token ;
2. enregistre `NODE_SECRET` dans `.env` ;
3. construit l’image et démarre le conteneur via Compose.

## Compose seul (si déjà joint)

Si vous avez déjà un `NODE_SECRET` :

```sh
export NODE_SECRET=wmn_…
docker compose up -d --build
```

## Vérification

Sur le principal : **Nœuds** → ping sur le nœud créé.  
L’URL advertise doit être en `https://…` (certificat autosigné, renouvelé automatiquement).

## Sécurité

Le fichier `.env` contient le token de jointure puis le secret nœud — ne le committez pas et limitez les permissions (`chmod 600 .env`).
