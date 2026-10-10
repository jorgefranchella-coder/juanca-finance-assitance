#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../apps/web"
# Avoid serving a new bundle before its additive migrations have completed.
bundle_backup=$(mktemp -d -t juanca-build-XXXXXXXX)
if [[ -d dist ]]; then cp -a dist "$bundle_backup/dist"; fi
active_services=()
for service in patrimonio-juanca-web patrimonio-juanca-worker; do
  if systemctl --user is-active --quiet "$service"; then active_services+=("$service"); fi
done
resume_services() {
  local build_status=$?
  if ((build_status != 0)) && [[ -d "$bundle_backup/dist" ]]; then
    rm -rf dist
    cp -a "$bundle_backup/dist" dist
  fi
  rm -rf "$bundle_backup"
  if ((${#active_services[@]})); then systemctl --user start "${active_services[@]}"; fi
  return "$build_status"
}
trap resume_services EXIT
if ((${#active_services[@]})); then systemctl --user stop "${active_services[@]}"; fi
npm run build
python3 - <<'PY'
import json
from pathlib import Path
p=Path('dist/server/wrangler.json')
c=json.loads(p.read_text())
c['d1_databases'][0]['migrations_dir']='../../drizzle'
p.write_text(json.dumps(c))
PY
./node_modules/.bin/wrangler d1 migrations apply DB --local --config dist/server/wrangler.json --persist-to ../../integration/state
