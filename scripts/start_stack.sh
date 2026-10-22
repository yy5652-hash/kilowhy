#!/usr/bin/env bash
# Bring the whole Kilowhy stack up on a Mac after a reboot, then serve the UI + API on http://127.0.0.1:5174.
#   1. Docker Desktop and the local Zetaris platform (docker compose in $ZETARIS_DIR, default ~/zetaris/zetaris-platform)
#   2. Re-cache the Kilowhy Zetaris tables (they survive a restart, the in-memory cache does not)
#   3. Check Meterless Nightshift (the primary AI provider) on 127.0.0.1:8088 — open the Nightshift app yourself if it is offline
#   4. Start the Kilowhy server (foreground; Ctrl-C to stop)
set -euo pipefail
cd "$(dirname "$0")/.."
ZETARIS_DIR="${ZETARIS_DIR:-$HOME/zetaris/zetaris-platform}"

echo "1/4 Docker + Zetaris"
docker info >/dev/null 2>&1 || { open -a Docker; for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 3; done; }
(cd "$ZETARIS_DIR" && docker compose up -d >/dev/null)
for _ in $(seq 1 60); do (cd "$ZETARIS_DIR" && ./verify.sh 2>/dev/null | grep -q "All 9 checks passed") && break; sleep 10; done
(cd "$ZETARIS_DIR" && ./verify.sh | tail -1)

echo "2/4 Re-cache Kilowhy tables in Zetaris"
node scripts/zetaris_ddl.ts --warm | awk '{print $1}' | sort | uniq -c

echo "3/4 Meterless Nightshift"
if [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8088/healthz)" = "200" ]; then
  echo "    online at http://127.0.0.1:8088/v1"
else
  echo "    offline — open the Nightshift app (Applications). Until then answers use the labelled NVIDIA-direct route."
fi

echo "4/4 Kilowhy server"
exec node server/src/http.ts
