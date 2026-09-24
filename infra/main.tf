terraform {
  required_version = ">= 1.6.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "cloudflare" {
  # API token via env: CLOUDFLARE_API_TOKEN
}

locals {
  hostname     = "${var.subdomain}.${var.zone_name}"
  dev_hostname = "${var.subdomain}-dev.${var.zone_name}"
}

resource "cloudflare_d1_database" "scheduler" {
  account_id = var.cloudflare_account_id
  name       = "scheduler"

  # The CF v5 provider sends `read_replication = null` if this block is omitted,
  # and the API rejects that ("Expected object, received null"). Declaring the
  # default explicitly keeps plans clean.
  read_replication = {
    mode = "disabled"
  }
}

resource "cloudflare_workers_kv_namespace" "google_token_cache" {
  account_id = var.cloudflare_account_id
  title      = "scheduler-google-token-cache"
}

# Worker custom-domain route is created by `wrangler deploy` via wrangler.toml's
# [[routes]] block; we only need the DNS record here so the hostname resolves.
resource "cloudflare_dns_record" "scheduler" {
  zone_id = var.cloudflare_zone_id
  name    = var.subdomain
  type    = "AAAA"
  content = "100::" # CF placeholder; Worker routing overrides
  proxied = true
  ttl     = 1
}

resource "cloudflare_zero_trust_access_policy" "scheduler_operator" {
  account_id = var.cloudflare_account_id
  name       = "operator"
  decision   = "allow"

  include = [{
    email = { email = var.operator_email }
  }]
}

# Access now guards only the human dev-ui (/admin/dev-ui), which authenticates
# the operator's browser via SSO. The OAuth endpoints (/oauth/*), the
# bearer-authenticated API (/v1/*), and the cross-user admin routes
# (/admin/offboard, /admin/run-cron, /admin/stop-channel,
# /admin/renew-subscriptions) are public at the edge and authenticate in the
# Worker: the admin routes via bearer + admin role + the `admin` scope, and the
# Google calendar webhook (/v1/webhook/google-calendar) via the
# X-Goog-Channel-Token header. Scoping Access to /admin/dev-ui is what lets
# those reach the Worker without a dedicated bypass application.
resource "cloudflare_zero_trust_access_application" "scheduler" {
  account_id                = var.cloudflare_account_id
  name                      = "Weekly Scheduling Assistant"
  domain                    = "${local.hostname}/admin/dev-ui"
  type                      = "self_hosted"
  session_duration          = "24h"
  auto_redirect_to_identity = false

  policies = [{
    id         = cloudflare_zero_trust_access_policy.scheduler_operator.id
    precedence = 1
  }]
}

# --- Isolated dev admin Access (separate AUD, two identities) -----------------
# Dev gets its own Access application with its own AUD and a two-email policy,
# so the dev-ui can authenticate either operator identity WITHOUT widening the
# prod policy. The Worker still VERIFIES the CF Access JWT in requireAccess
# against ACCESS_POLICY_AUD for /admin/dev-ui. The cross-user admin routes no
# longer rely on Access at all — they authenticate via bearer + admin role +
# `admin` scope in the Worker, so the smoke harnesses drive them with a minted
# bearer alone (no CF Access cookie).
#
# The dev hostname serves the dev Worker via a Workers Custom Domain, attached
# by `wrangler deploy --env dev` from [env.dev.routes] (same split as prod:
# tofu owns the placeholder DNS record, wrangler owns the Custom Domain on top
# of it). The custom domain exists because Cloudflare blocks worker→worker
# fetches to *.workers.dev hostnames on the same account (404, error 1042) —
# codemode-mcp's optical-dev worker must reach this Worker's /oauth/token
# server-side. It also means the Access app below now gates /admin/dev-ui at the
# Cloudflare edge on this hostname. After apply, repoint
# worker/wrangler.toml [env.dev].vars.ACCESS_POLICY_AUD to
# `tofu output access_application_dev_aud` and redeploy dev.
resource "cloudflare_dns_record" "scheduler_dev" {
  zone_id = var.cloudflare_zone_id
  name    = "${var.subdomain}-dev"
  type    = "AAAA"
  content = "100::" # CF placeholder; Worker routing overrides
  proxied = true
  ttl     = 1
}

resource "cloudflare_zero_trust_access_policy" "scheduler_dev_operator" {
  account_id = var.cloudflare_account_id
  name       = "dev-operators"
  decision   = "allow"

  # All identities the dev harness drives. Prod's single-operator policy above
  # is intentionally left unchanged.
  include = [
    { email = { email = var.operator_email } },
    { email = { email = var.sandbox_operator_email } },
    { email = { email = var.test_operator_email } },
  ]
}

resource "cloudflare_zero_trust_access_application" "scheduler_dev" {
  account_id                = var.cloudflare_account_id
  name                      = "Weekly Scheduling Assistant (dev)"
  domain                    = "${local.dev_hostname}/admin/dev-ui"
  type                      = "self_hosted"
  session_duration          = "24h"
  auto_redirect_to_identity = false

  policies = [{
    id         = cloudflare_zero_trust_access_policy.scheduler_dev_operator.id
    precedence = 1
  }]
}

# This zone's single http_request_firewall_custom entrypoint. Optical owns it
# (example.com is the scheduler's zone). A sibling project used to
# manage it via a for_each but dropped this zone — its presence here is just
# redirect subdomains — so this resource creates the entrypoint fresh.
#
# The two block rules guard the whole zone (the scheduler included) against
# scanner / secrets probes, so e.g. /oauth/.env stays blocked. The skip rule
# disables Browser Integrity Check — which rejects non-browser User-Agents
# (e.g. Python urllib) with HTTP 403 "error code: 1010" — for the
# Worker-authenticated /oauth and /v1 paths. BIC is the ONLY product skipped,
# and the skip sits last so the block rules still apply to those paths.
#
# The scanner expressions are intentionally duplicated with another project's WAF config
# (zone-scoped rulesets across separate TF states). Tech-debt follow-up: lift
# this zone's infra into its own repo that both projects change via PR.
resource "cloudflare_ruleset" "skip_bic_api" {
  zone_id = var.cloudflare_zone_id
  name    = "example.com custom rules"
  kind    = "zone"
  phase   = "http_request_firewall_custom"

  rules = [
    {
      description = "Block WordPress / PHP scanner probes (wp-admin, wp-login, xmlrpc, .php, phpinfo, wlwmanifest)"
      expression  = "lower(http.request.uri.path) contains \"wp-admin\" or lower(http.request.uri.path) contains \"wp-login\" or lower(http.request.uri.path) contains \"wp-content\" or lower(http.request.uri.path) contains \"wp-includes\" or lower(http.request.uri.path) contains \"wlwmanifest\" or lower(http.request.uri.path) contains \"xmlrpc.php\" or lower(http.request.uri.path) contains \"/wordpress/\" or ends_with(lower(http.request.uri.path), \".php\") or lower(http.request.uri.path) contains \"phpinfo\""
      action      = "block"
      enabled     = true
    },
    {
      description = "Block secrets harvesting (.env, .git, service-account.json, appsettings.json, _environment)"
      expression  = "lower(http.request.uri.path) contains \"/.env\" or lower(http.request.uri.path) contains \"/.git/\" or lower(http.request.uri.path) contains \"service-account.json\" or lower(http.request.uri.path) contains \"appsettings.json\" or lower(http.request.uri.path) contains \"/_environment\" or lower(http.request.uri.path) eq \"/env.json\" or lower(http.request.uri.path) eq \"/config.json\""
      action      = "block"
      enabled     = true
    },
    {
      ref         = "skip_bic_oauth_v1"
      description = "Skip Browser Integrity Check for Worker-authenticated OAuth and bearer API paths"
      expression  = "starts_with(http.request.uri.path, \"/oauth\") or starts_with(http.request.uri.path, \"/v1\")"
      action      = "skip"
      action_parameters = {
        products = ["bic"]
      }
    },
  ]
}
