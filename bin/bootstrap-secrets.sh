#!/usr/bin/env bash
# Idempotently push Worker secrets needed before first deploy.
#
# Usage: bin/bootstrap-secrets.sh                 # prod (top-level wrangler config)
#        bin/bootstrap-secrets.sh --env <name>    # an [env.<name>] block
#
# Required env: WRANGLER_CONFIG  (path to worker/wrangler.toml, defaults to ./worker/wrangler.toml)
# Optional env: GOOGLE_OAUTH_CLIENT_SECRET  (if set, used non-interactively)
#
# Prod (no flag) behaves exactly as it always has: TOKEN_HASH_PEPPER and
# WEBHOOK_CHANNEL_TOKEN are generated if unset, GOOGLE_OAUTH_CLIENT_SECRET is
# read from the env or prompted for.
#
# --env <name> pushes ONLY from env vars (inject them with `op run`): it never
# generates and never prompts, every wrangler call carries --env <name>, and a
# missing or empty var fails the run before any `secret put`. Already-set
# secrets are skipped, as in prod. Each env has a fixed secret set below; an
# env without one is refused.

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

# Secret name == env var name. TURNSTILE_SECRET is not here: it is minted and
# installed by bin/create-turnstile-widget.py. WEBHOOK_CHANNEL_TOKEN is not
# used by the trial.
env_secret_set() {
  case "$1" in
    trial)
      echo "GOOGLE_OAUTH_CLIENT_SECRET MICROSOFT_OAUTH_CLIENT_SECRET SYSTEM_MAIL_API_KEY TOKEN_HASH_PEPPER HASHING_KEY ENCRYPTION_KEY HMAC_KEY"
      ;;
    *)
      return 1
      ;;
  esac
}

if [[ "$env_name" == "prod" ]]; then
  echo "prod is the top-level config: omit --env to bootstrap prod." >&2
  exit 2
fi

if [[ -n "$env_name" ]]; then
  if ! secret_set=$(env_secret_set "$env_name"); then
    echo "no secret set defined for env '$env_name' (known: trial)." >&2
    exit 2
  fi
  missing=()
  for name in $secret_set; do
    [[ -n "${!name:-}" ]] || missing+=("$name")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "missing env vars for --env $env_name: ${missing[*]} (inject with op run); nothing pushed." >&2
    exit 1
  fi
fi

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

if [[ -n "$env_name" ]]; then
  echo "Bootstrapping Worker secrets (env: $env_name, from env vars only)..."
  # Fail closed: a failed list (auth/network, or the Worker not deployed yet)
  # must not fall through to blind puts. wrangler's own error stays on stderr.
  if ! existing=$(wrangler --config "$WRANGLER_CONFIG" secret list --env "$env_name" | awk -F'"' '/"name":/ {print $4}'); then
    echo "secret list failed for env $env_name; nothing pushed. If the Worker does not exist yet, run bin/deploy.sh --env $env_name first, then re-run." >&2
    exit 1
  fi
  for name in $secret_set; do
    if grep -qx "$name" <<<"$existing"; then
      echo "  $name already set, skipping"
      continue
    fi
    printf '%s' "${!name}" | wrangler --config "$WRANGLER_CONFIG" secret put "$name" --env "$env_name" >/dev/null
    echo "  $name pushed"
  done
  echo "Done."
  exit 0
fi

echo "Bootstrapping Worker secrets..."
put_random_secret "TOKEN_HASH_PEPPER"
put_random_secret "WEBHOOK_CHANNEL_TOKEN"
put_prompted_secret "GOOGLE_OAUTH_CLIENT_SECRET" "GOOGLE_OAUTH_CLIENT_SECRET"
echo "Done."
