#!/bin/sh
set -eu
cd /workspace

# :8081 is QA-only — a revive must never inherit a stale built-output preview.
node scripts/preview.mjs stop >/dev/null 2>&1 || true

if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  exit 0
fi

mkdir -p data /tmp
: >/tmp/offerlayer-ui.log
: >/tmp/offerlayer-api.log

API_HEALTH="http://127.0.0.1:8787/health"
if ! curl -sf -o /dev/null --max-time 2 "$API_HEALTH"; then
  npx tsx apps/api/src/index.ts >>/tmp/offerlayer-api.log 2>&1 &
  i=0
  while [ "$i" -lt 40 ]; do
    if curl -sf -o /dev/null --max-time 2 "$API_HEALTH"; then
      break
    fi
    sleep 0.25
    i=$((i + 1))
  done
fi

npm run dev >>/tmp/offerlayer-ui.log 2>&1 &

i=0
while [ "$i" -lt 80 ]; do
  if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
    exit 0
  fi
  sleep 0.25
  i=$((i + 1))
done

echo "[startup] preview did not become healthy" >&2
tail -50 /tmp/offerlayer-ui.log >&2 || true
tail -20 /tmp/offerlayer-api.log >&2 || true
exit 0
