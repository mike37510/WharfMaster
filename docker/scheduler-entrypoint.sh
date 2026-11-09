#!/bin/sh
set -eu
# Ping WharfMaster every minute to run due schedules.
BASE="${WHARFMASTER_INTERNAL_URL:-http://wharfmaster}"
KEY_FILE="${SCHEDULER_KEY_FILE:-/data/scheduler.api_key}"

echo "[scheduler] waiting for API key at ${KEY_FILE}"
i=0
while [ ! -f "$KEY_FILE" ]; do
  i=$((i + 1))
  if [ "$i" -gt 120 ]; then
    echo "[scheduler] timeout waiting for scheduler.api_key" >&2
    exit 1
  fi
  sleep 2
done

echo "[scheduler] ready — polling ${BASE}/api/schedules/run-due every 60s"
while true; do
  KEY=$(cat "$KEY_FILE" | tr -d '\r\n')
  if [ -n "$KEY" ]; then
    curl -sS -X POST \
      -H "Content-Type: application/json" \
      -H "Accept: application/json" \
      -H "X-API-Key: ${KEY}" \
      -d '{}' \
      "${BASE}/api/schedules/run-due" || true
  fi
  sleep 60
done
