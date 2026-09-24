#!/usr/bin/env bash
# Apply D1 migrations, then deploy the Worker.
#
# Solver/Container deployment is NOT covered here — see worker/docs/plan-d-deploy.md.

set -euo pipefail

cd "$(dirname "$0")/../worker"

if ! command -v npx >/dev/null 2>&1; then
  echo "npx not on PATH. Install Node.js (which provides npx)." >&2
  exit 1
fi

echo "==> Applying D1 migrations"
npx wrangler d1 migrations apply scheduler --remote

echo "==> Deploying Worker"
npx wrangler deploy

echo "==> Done."
