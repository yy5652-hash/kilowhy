#!/usr/bin/env bash
# Copy the SAMPLE site files (data/sample/*.csv) into the local Zetaris driver container, where
# scripts/zetaris_ddl.ts registers them as FILESTORE tables (file:///home/zetaris/customer-data/shared/kw_<name>.csv).
set -euo pipefail
cd "$(dirname "$0")/.."
C="${ZETARIS_DRIVER_CONTAINER:-zetaris-driver-1}"
for f in meter_hh sites ops_log contract; do
  docker cp "data/sample/$f.csv" "$C:/home/zetaris/customer-data/shared/kw_$f.csv"
  echo "copied data/sample/$f.csv -> $C:/home/zetaris/customer-data/shared/kw_$f.csv"
done
