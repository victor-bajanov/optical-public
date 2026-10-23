#!/usr/bin/env bash
# Apply D1 migrations, then deploy the Worker.
#
# Usage: bin/deploy.sh                 # prod (top-level wrangler config)
#        bin/deploy.sh --env <name>    # an [env.<name>] block, e.g. dev, trial
#
# With no flag this does exactly what it always has. With --env, every wrangler
# call carries --env <name> and the migration uses the binding form
# (`d1 migrations apply DB --env <name>`): a non-prod D1 only exists under its
# [env.<name>] block, so naming the database instead fails. There is no
# `--env prod` — prod is the top-level config, reached by omitting the flag.
#
# Solver/Container deployment is NOT covered here — see worker/docs/plan-d-deploy.md.

set -euo pipefail

usage() {
  echo "usage: $0 [--env <name>]   (omit --env for prod)" >&2
  exit 2
}

env_name=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      [[ $# -ge 2 && -n "$2" ]] || usage
      env_name="$2"
      shift 2
      ;;
    --env=?*)
      env_name="${1#--env=}"
      shift
      ;;
    *)
      usage
      ;;
  esac
done

if [[ "$env_name" == "prod" ]]; then
  echo "prod is the top-level config: omit --env to deploy prod." >&2
  exit 2
fi

cd "$(dirname "$0")/../worker"

if ! command -v npx >/dev/null 2>&1; then
  echo "npx not on PATH. Install Node.js (which provides npx)." >&2
  exit 1
fi

if [[ -z "$env_name" ]]; then
  echo "==> Applying D1 migrations"
  npx wrangler d1 migrations apply scheduler --remote

  echo "==> Deploying Worker"
  npx wrangler deploy
else
  echo "==> Applying D1 migrations (env: $env_name)"
  npx wrangler d1 migrations apply DB --env "$env_name" --remote

  echo "==> Deploying Worker (env: $env_name)"
  npx wrangler deploy --env "$env_name"
fi

echo "==> Done."
