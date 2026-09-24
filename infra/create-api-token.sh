#!/usr/bin/env bash
set -euo pipefail

# Creates (or updates in place) a single scoped Cloudflare API token for the
# Optical / weekly-scheduling-assistant project. The token is used by BOTH:
#
#   * wrangler deploy  (worker/ — Workers Scripts, D1 + migrations, KV,
#                        and the custom-domain route on example.com)
#   * terraform        (infra/ — D1, KV, DNS record, Zero Trust Access apps,
#                        and a WAF custom rule that skips Browser Integrity Check)
#
# Both read it from the CLOUDFLARE_API_TOKEN env var (see infra/main.tf and
# wrangler's standard auth). We no longer use the Global API Key.
#
# Auth: this script authenticates with a *single-use creation token* you mint
# by hand, NOT the global key. That creation token only needs:
#       User > API Tokens > Edit
# (it can be deleted immediately after this script succeeds).
#
# Usage:
#   export CF_CREATE_TOKEN='<single-use token with User API Tokens: Edit>'
#   ./infra/create-api-token.sh
#
# Account / zone are not secrets — hardcoded from infra/terraform.tfvars.
CF_ACCOUNT_ID="REPLACE_WITH_YOUR_CLOUDFLARE_ACCOUNT_ID"   # your Cloudflare account
CF_ZONE_ID="REPLACE_WITH_YOUR_ZONE_ID"       # example.com
TOKEN_NAME="optical-deploy"

: "${CF_CREATE_TOKEN:?Set CF_CREATE_TOKEN to a single-use token with 'User > API Tokens > Edit'}"

API="https://api.cloudflare.com/client/v4"
AUTH=(-H "Authorization: Bearer ${CF_CREATE_TOKEN}")

echo "Fetching permission groups..."
RAW=$(curl -sf "${AUTH[@]}" "${API}/user/tokens/permission_groups")

# Exact permissions needed, with explicit scope.
# Format: "scope|name" where scope is "account" or "zone".
WANTED=(
  # --- wrangler deploy: worker code, D1 (incl. migrations), KV ---
  "account|Workers Scripts Read"
  "account|Workers Scripts Write"
  "account|D1 Read"
  "account|D1 Write"
  "account|Workers KV Storage Read"
  "account|Workers KV Storage Write"

  # --- solver/ deploys as a Cloudflare Container: wrangler probes
  #     GET /accounts/:id/containers/me and pushes the built image to the
  #     managed registry. Without these the deploy 403s on /containers/me. ---
  "account|Workers Containers Read"
  "account|Workers Containers Write"

  # --- bin/create-turnstile-widget.py: mints the booking page's Turnstile
  #     widget (sitekey + secret) for a hostname. Without these,
  #     /accounts/:id/challenges/widgets answers 10000 Authentication error. ---
  "account|Turnstile Sites Read"
  "account|Turnstile Sites Write"

  # --- card 3.0 problem capture: the worker binds R2 bucket
  #     optical-solver-capture (SOLVER_CAPTURE) and bin/solver-capture-pull.py
  #     downloads captured problems via `wrangler r2 object get`. Without
  #     these, r2 object/bucket calls answer 10000 Authentication error.
  #     (Bucket was created once via the Worker Bindings MCP, 2026-08-24.) ---
  "account|Workers R2 Storage Read"
  "account|Workers R2 Storage Write"

  # --- Cloudflare Observability MCP tools (query_worker_observability,
  #     workers_get_worker, etc.): read-only log/metrics queries against the
  #     deployed worker. Also used by the solver usage/cost model
  #     (internal design notes): bin/solver-usage-backfill.py
  #     reads Workers Logs through the observability telemetry endpoint
  #     (403s without it) and bin/container-usage.py reads
  #     accountContainersUsageAdaptiveGroups via GraphQL Analytics. All
  #     read-only. ---
  "account|Workers Observability Read"
  "account|Account Analytics Read"

  # --- terraform: Zero Trust Access apps + policies (and identity reads) ---
  "account|Access: Apps and Policies Read"
  "account|Access: Apps and Policies Write"
  "account|Access: Organizations, Identity Providers, and Groups Read"
  "account|Access: Organizations, Identity Providers, and Groups Write"

  # --- zone (example.com) ---
  # Workers Routes: the worker's custom domain (scheduler.example.com).
  # DNS: terraform manages the proxied AAAA record for the hostname.
  # Zone WAF: terraform's http_request_firewall_custom ruleset that skips
  #           Browser Integrity Check for the /oauth and /v1 API paths.
  "zone|Workers Routes Read"
  "zone|Workers Routes Write"
  "zone|DNS Read"
  "zone|DNS Write"
  "zone|Zone WAF Read"
  "zone|Zone WAF Write"
)

# Look up each permission by exact name + scope.
ACCOUNT_PG_JSON=""
ZONE_PG_JSON=""
MISSING=()

for entry in "${WANTED[@]}"; do
  want_scope="${entry%%|*}"
  want_name="${entry#*|}"

  if [ "$want_scope" = "account" ]; then
    scope_match="com.cloudflare.api.account"
  else
    scope_match="com.cloudflare.api.account.zone"
  fi

  id=$(echo "$RAW" | jq -r --arg name "$want_name" --arg scope "$scope_match" '
    .result[] | select(.name == $name and ((.scopes // [])[0] == $scope)) | .id
  ')

  if [ -z "$id" ]; then
    MISSING+=("${want_scope}|${want_name}")
    continue
  fi

  pg="{\"id\":\"${id}\"}"
  if [ "$want_scope" = "account" ]; then
    [ -n "$ACCOUNT_PG_JSON" ] && ACCOUNT_PG_JSON+=","
    ACCOUNT_PG_JSON+="$pg"
  else
    [ -n "$ZONE_PG_JSON" ] && ZONE_PG_JSON+=","
    ZONE_PG_JSON+="$pg"
  fi

  printf "  %-55s [%s]\n" "$want_name" "$want_scope"
done

if [ ${#MISSING[@]} -gt 0 ]; then
  echo ""
  echo "Missing permissions:"
  for m in "${MISSING[@]}"; do
    echo "  - ${m#*|} (${m%%|*})"
  done
  echo ""
  echo "Available permission groups matching Workers/KV/D1/Access/DNS:"
  echo "$RAW" | jq -r '
    .result[] | select(.name | test("Workers Script|Workers Route|Workers KV|D1|Access|DNS|WAF|Firewall|Ruleset|Container|Registry|Image|Turnstile|Challenge|Observability|Analytics|Logs"; "i"))
    | "  \(.id)  \(.name)  \((.scopes // []) | join(", "))"
  '
  echo ""
  echo "Update WANTED in this script to match the above, then rerun."
  exit 1
fi

# Build policies: one account-scoped, one zone-scoped.
POLICIES="[{
  \"effect\": \"allow\",
  \"resources\": {\"com.cloudflare.api.account.${CF_ACCOUNT_ID}\": \"*\"},
  \"permission_groups\": [${ACCOUNT_PG_JSON}]
}"

if [ -n "$ZONE_PG_JSON" ]; then
  POLICIES+=",{
  \"effect\": \"allow\",
  \"resources\": {\"com.cloudflare.api.account.zone.${CF_ZONE_ID}\": \"*\"},
  \"permission_groups\": [${ZONE_PG_JSON}]
}"
fi

POLICIES+="]"

echo ""
echo "Token policies:"
printf '{"name":"%s","policies":%s}' "$TOKEN_NAME" "$POLICIES" \
  | jq '.policies[] | {resources: (.resources | keys), permissions: [.permission_groups[].id[:8]]}' 2>/dev/null || true

# Idempotent: update an existing token of the same name in place, else create.
echo ""
echo "Checking for existing '${TOKEN_NAME}' token..."
EXISTING=$(curl -sf "${AUTH[@]}" "${API}/user/tokens" \
  | jq -r --arg name "$TOKEN_NAME" '.result[] | select(.name == $name) | .id')

if [ -n "$EXISTING" ]; then
  TOKEN_ID="$EXISTING"
  echo "Found existing token: ${TOKEN_ID} — updating permissions..."

  UPDATE_PAYLOAD=$(printf '{"name":"%s","policies":%s,"status":"active"}' "$TOKEN_NAME" "$POLICIES")

  RESPONSE=$(curl -sf "${AUTH[@]}" \
    -H "Content-Type: application/json" \
    -X PUT "${API}/user/tokens/${TOKEN_ID}" \
    -d "${UPDATE_PAYLOAD}")

  SUCCESS=$(echo "$RESPONSE" | jq -r '.success')
  if [ "$SUCCESS" != "true" ]; then
    echo "Failed to update token:"
    echo "$RESPONSE" | jq '.errors'
    exit 1
  fi

  echo "Token updated successfully!"
  echo ""
  echo "  Token ID: ${TOKEN_ID}"
  echo ""
  echo "The token value is unchanged. If you need a new value, roll it in the dashboard."
else
  echo "No existing token found — creating new one..."

  PAYLOAD=$(printf '{"name":"%s","policies":%s}' "$TOKEN_NAME" "$POLICIES")

  RESPONSE=$(curl -sf "${AUTH[@]}" \
    -H "Content-Type: application/json" \
    -X POST "${API}/user/tokens" \
    -d "${PAYLOAD}")

  SUCCESS=$(echo "$RESPONSE" | jq -r '.success')
  if [ "$SUCCESS" != "true" ]; then
    echo "Failed to create token:"
    echo "$RESPONSE" | jq '.errors'
    exit 1
  fi

  TOKEN=$(echo "$RESPONSE" | jq -r '.result.value')
  TOKEN_ID=$(echo "$RESPONSE" | jq -r '.result.id')

  echo "Token created successfully!"
  echo ""
  echo "  Token ID: ${TOKEN_ID}"
  echo "  Value:    ${TOKEN}"
  echo ""
  echo "Store this value securely — it won't be shown again."
fi

echo ""
echo "Next steps:"
echo "  1. Store the token value in 1Password (e.g. item 'Cloudflare API Token', field 'credential')."
echo "  2. Point .env at it (replacing the old global-key lines):"
echo "       CLOUDFLARE_API_TOKEN=op://YourVault/<item>/credential"
echo "  3. Deploy the worker:"
echo "       op run --env-file=.env -- bin/deploy.sh"
echo "  4. Terraform (also reads CLOUDFLARE_API_TOKEN):"
echo "       op run --env-file=.env -- terraform -chdir=infra plan"
echo ""
echo "  Then delete the single-use CF_CREATE_TOKEN you used to run this script."
