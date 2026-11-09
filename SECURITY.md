# Security Policy

## Reporting a vulnerability

Please open a **private** security advisory on GitHub, or contact the maintainer. Do not file public issues for unfixed vulnerabilities.

## Hardening model

- **DocumentRoot = `public/` only.** Application code (`src/`), configuration (`config/`), runtime data (`var/`), and the agent sources (`agent/`) are outside the web root.
- **Single front controller** (`public/index.php`) for `/api`, `/app`, `/agent/*`, and `/docs/*`.
- **Runtime secrets** (JWT, SQLite, API keys) live under `var/` (Docker volume), mode `0700`. Never commit `var/`.
- **Config is read-only** (`config/app.php`). Initialization (JWT generation, legacy migration) runs via `bin/init.php` / the Docker entrypoint — not as a side effect of loading config.
- Agent install files are served from the single `agent/` tree through an allowlisted route (`/agent/install.sh`, …), not by exposing the whole directory.

## Deployment checklist

1. Serve only `public/` (Apache/Nginx DocumentRoot).
2. Persist `var/` on a dedicated volume; restrict filesystem permissions.
3. Prefer TLS termination in front of the container.
4. Keep `WM_MASTER_KEY` (or rotate carefully with `jwt.secret`) for registry password encryption at rest.
5. Rotate join tokens after use; treat downloaded agent `.env` packs as secrets.
