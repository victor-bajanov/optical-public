#!/usr/bin/env bash
# Idempotently push Worker secrets needed before first deploy.
#
# Required env: WRANGLER_CONFIG  (path to worker/wrangler.toml, defaults to ./worker/wrangler.toml)
# Optional env: GOOGLE_OAUTH_CLIENT_SECRET  (if set, used non-interactively)

set -euo pipefail

cd "$(dirname "$0")/.."

WRANGLER_CONFIG="${WRANGLER_CONFIG:-worker/wrangler.toml}"

if ! command -v wrangler >/dev/null 2>&1; then
  echo "wrangler not on PATH. Install via 'npm i -g wrangler' or use 'npx wrangler'." >&2
  exit 1
fi

existing_secrets() {
  wrangler --config "$WRANGLER_CONFIG" secret list 2>/dev/null | awk -F'"' '/"name":/ {print $4}'
}

put_random_secret() {
  local name="$1"
  if existing_secrets | grep -qx "$name"; then
    echo "  $name already set, skipping"
    return
  fi
  local value
  value=$(openssl rand -hex 32)
  printf '%s' "$value" | wrangler --config "$WRANGLER_CONFIG" secret put "$name" >/dev/null
  echo "  $name generated and pushed"
}

put_prompted_secret() {
  local name="$1"
  local env_var="$2"
  if existing_secrets | grep -qx "$name"; then
    echo "  $name already set, skipping (re-run with --force to overwrite)"
    return
  fi
  local value="${!env_var:-}"
  if [[ -z "$value" ]]; then
    read -rsp "  Enter value for $name (won't echo): " value
    echo
  fi
  if [[ -z "$value" ]]; then
    echo "  empty $name, skipping" >&2
    return 1
  fi
  printf '%s' "$value" | wrangler --config "$WRANGLER_CONFIG" secret put "$name" >/dev/null
  echo "  $name pushed"
}

echo "Bootstrapping Worker secrets..."
put_random_secret "TOKEN_HASH_PEPPER"
put_random_secret "WEBHOOK_CHANNEL_TOKEN"
put_prompted_secret "GOOGLE_OAUTH_CLIENT_SECRET" "GOOGLE_OAUTH_CLIENT_SECRET"
echo "Done."
