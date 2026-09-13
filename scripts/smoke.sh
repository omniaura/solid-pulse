#!/usr/bin/env bash
# Consumer smoke for the example app:
#  1. production build must not contain any devtools/simulator code,
#  2. the dev server must expose both control planes and answer the mock API.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/examples/basic"

echo "== production build"
rm -rf dist
bunx vite build >/tmp/smoke-build.log 2>&1 || { cat /tmp/smoke-build.log; exit 1; }
if grep -rlE "solid-pulse|__SOLID_PULSE__|scenario-sim|__sim/" dist/assets >/dev/null; then
  echo "FAIL: production bundle contains devtools/simulator code"; grep -rlE "solid-pulse|__SOLID_PULSE__|scenario-sim|__sim/" dist/assets; exit 1
fi
echo "ok: $(ls dist/assets | wc -l | tr -d ' ') assets, none mention solid-pulse or scenario-sim"

echo "== dev server"
VITE_SIMULATOR=true bunx vite --mode simulator --port 5199 --strictPort >/tmp/smoke-dev.log 2>&1 &
dev=$!
trap 'kill $dev 2>/dev/null || true' EXIT
for i in $(seq 1 40); do curl -sf http://localhost:5199/__pulse/api/status >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf http://localhost:5199/__pulse/api/status | grep -q '"tool":"@omniaura/solid-pulse"' && echo "ok: /__pulse/api/status"
curl -sf http://localhost:5199/__sim/scenarios | grep -q '"notes-happy"' && echo "ok: /__sim/scenarios"
curl -sf http://localhost:5199/api/notes | grep -q '"items"' && echo "ok: GET /api/notes answered by the simulator"
created=$(curl -sf -X POST http://localhost:5199/api/notes -H 'content-type: application/json' -d '{"title":"smoke"}')
echo "$created" | grep -q '"title":"smoke"' && echo "ok: POST /api/notes → $(echo "$created" | head -c 60)…"
curl -sf http://localhost:5199/__sim/state?collection=notes | grep -q '"smoke"' && echo "ok: state reflects the mutation"
curl -sf http://localhost:5199/ | grep -q '/@solid-pulse/init' && echo "ok: dev HTML injects the pulse runtime first"
# CLI discovery via node_modules/.vite/solid-pulse.json written by the plugin
(cd "$root/examples/basic" && node "$root/packages/solid-pulse/dist/cli.js" status --json | grep -q '"tool"') && echo "ok: solid-pulse CLI auto-discovered the bridge"
node "$root/packages/scenario-sim/dist/cli.js" status --url http://localhost:5199/__sim --json | grep -q '"scenario"' && echo "ok: scenario-sim CLI reached /__sim"
echo "smoke passed"
