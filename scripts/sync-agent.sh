#!/bin/sh
# Sync agent/ → public/agent/ (single source of truth for served installer sources).
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/agent"
DST="$ROOT/public/agent"

for f in Dockerfile agent.php entrypoint.sh router.php install.sh .htaccess; do
  if [ -f "$SRC/$f" ]; then
    cp -a "$SRC/$f" "$DST/$f"
    echo "synced $f"
  fi
done
# install.sh is authored under public/agent (served); keep agent/ copy in sync too
if [ -f "$DST/install.sh" ]; then
  cp -a "$DST/install.sh" "$SRC/install.sh"
  echo "synced install.sh → agent/"
fi
echo "OK — agent sources aligned"
