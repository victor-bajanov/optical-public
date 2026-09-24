#!/usr/bin/env bash
# POST bin/fixtures/seed.json to the live scheduler.
#
# Required env:
#   SCHEDULER_URL    e.g. https://scheduler.example.com
#   SCHEDULER_BEARER bearer token from bin/mint-token.py (federated PKCE; see docs/runbook.md)

set -euo pipefail

cd "$(dirname "$0")/.."

: "${SCHEDULER_URL:?SCHEDULER_URL is required}"
: "${SCHEDULER_BEARER:?SCHEDULER_BEARER is required}"

FIXTURE="bin/fixtures/seed.json"

if [[ ! -f "$FIXTURE" ]]; then
  echo "fixture $FIXTURE not found" >&2
  exit 1
fi

post() {
  local path="$1"
  local body="$2"
  local code
  code=$(curl -sS -o /tmp/seed-resp.$$ -w "%{http_code}" \
    -X POST "$SCHEDULER_URL$path" \
    -H "authorization: Bearer $SCHEDULER_BEARER" \
    -H "content-type: application/json" \
    -d "$body")
  if [[ "$code" -ge 300 ]]; then
    echo "  POST $path -> HTTP $code" >&2
    cat /tmp/seed-resp.$$ >&2
    echo >&2
    rm -f /tmp/seed-resp.$$
    return 1
  fi
  rm -f /tmp/seed-resp.$$
  echo "  POST $path -> $code"
}

task_count=$(jq '.tasks | length' "$FIXTURE")
tmpl_count=$(jq '.templates | length' "$FIXTURE")

echo "Seeding $task_count tasks and $tmpl_count templates to $SCHEDULER_URL"

for i in $(seq 0 $((task_count - 1))); do
  body=$(jq -c ".tasks[$i] | del(.id)" "$FIXTURE")
  post "/v1/tasks" "$body"
done

for i in $(seq 0 $((tmpl_count - 1))); do
  body=$(jq -c ".templates[$i] | del(.id)" "$FIXTURE")
  post "/v1/templates" "$body"
done

echo "Done."
