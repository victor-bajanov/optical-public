#!/usr/bin/env bash
# Usage: ./bin/register-pkce-client.sh <client_id> <redirect_uri> [--remote|--local] [--env <name>]
#
# Idempotently registers (or refreshes the redirect_uri of) a PKCE OAuth client
# in optical's oauth_clients D1 table.
#
#   default            → prod database `scheduler`        (--remote)
#   --local            → local `npx wrangler dev` database
#   --env dev          → dev database `scheduler-dev` with `--env dev` (remote)
#
# `--env <name>` targets the per-env worker config (wrangler.toml [env.<name>])
# and the D1 database named `scheduler-<name>`. Flags may appear in any order
# after the two positional args. Remote calls need CLOUDFLARE_API_TOKEN in the
# environment — inject it externally, e.g. `op run --env-file=.env -- ...`.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <client_id> <redirect_uri> [--remote|--local] [--env <name>]" >&2
  exit 64
fi

CLIENT_ID="$1"
REDIRECT_URI="$2"
shift 2

TARGET_FLAG="--remote"
ENV_NAME=""
ALLOWED_SCOPES="scheduler:read scheduler:write"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote) TARGET_FLAG="--remote" ;;
    --local)  TARGET_FLAG="--local" ;;
    --env)    ENV_NAME="${2:-}"; shift ;;
    --env=*)  ENV_NAME="${1#--env=}" ;;
    --scopes) ALLOWED_SCOPES="${2:-}"; shift ;;
    --scopes=*) ALLOWED_SCOPES="${1#--scopes=}" ;;
    *) echo "Unknown arg: $1 (expected --remote|--local|--env <name>|--scopes <scopes>)" >&2; exit 64 ;;
  esac
  shift
done

if [[ -n "$ENV_NAME" && ! "$ENV_NAME" =~ ^[a-z0-9-]+$ ]]; then
  echo "--env value must be a simple env name (got: $ENV_NAME)" >&2
  exit 64
fi

if [[ "$CLIENT_ID" == *"'"* || "$REDIRECT_URI" == *"'"* ]]; then
  echo "client_id and redirect_uri must not contain single-quote characters" >&2
  exit 64
fi

# Per-env worker config selects both the [env.<name>] block and the matching D1
# database (`scheduler-<name>`); prod (no --env) is the top-level `scheduler` db.
ENV_ARGS=()
if [[ -n "$ENV_NAME" ]]; then
  DB_NAME="scheduler-${ENV_NAME}"
  ENV_ARGS=(--env "$ENV_NAME")
else
  DB_NAME="scheduler"
fi

cd "$(dirname "$0")/../worker"

npx wrangler d1 execute "$DB_NAME" "$TARGET_FLAG" ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} --command "
  INSERT INTO oauth_clients (id, name, type, redirect_uris, allowed_scopes, created_at)
  VALUES ('$CLIENT_ID', 'codemode-mcp ($CLIENT_ID)', 'pkce',
          '[\"$REDIRECT_URI\"]', '$ALLOWED_SCOPES', datetime('now'))
  ON CONFLICT(id) DO UPDATE SET redirect_uris=excluded.redirect_uris, allowed_scopes=excluded.allowed_scopes;
"
echo "Registered/updated client_id=$CLIENT_ID redirect_uri=$REDIRECT_URI on ${DB_NAME} (${TARGET_FLAG}${ENV_NAME:+ --env $ENV_NAME})"
