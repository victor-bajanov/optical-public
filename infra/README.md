# infra/

OpenTofu configuration for the codifiable Cloudflare resources backing the
scheduler Worker: D1, KV, DNS, Cloudflare Access.

See `docs/runbook.md` for the full bootstrap sequence; this directory is one
step in that sequence.

## Quick start

```bash
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values
export CLOUDFLARE_API_TOKEN=<token-with-account+zone+access+d1+kv+workers-scope>
tofu init
tofu plan
tofu apply
tofu output   # copy into worker/wrangler.toml
```

State is local and gitignored (single-operator setup). Migrate to an R2
backend if a second operator ever exists.

## Tests

Plan-only checks against mocked providers (no token, no API calls):

```bash
tofu init -backend=false
tofu fmt -check -recursive && tofu validate && tofu test
```

## Hosted trial zone (optional)

Setting `trial_zone_id` and `trial_hostname` adds
`cloudflare_ruleset.trial_skip_bic_api`, the trial zone's
`http_request_firewall_custom` entrypoint: the same scanner block rules as the
scheduler zone, plus a Browser Integrity Check skip for `/oauth` and `/v1` on
the trial host only. A zone has one entrypoint per phase, so before the first
apply check `GET zones/<trial_zone_id>/rulesets/phases/http_request_firewall_custom/entrypoint`
and `tofu import 'cloudflare_ruleset.trial_skip_bic_api[0]' 'zones/<trial_zone_id>/<ruleset_id>'`
if it exists. Re-run `create-api-token.sh` with `CF_TRIAL_ZONE_ID` set so the
deploy token's zone permissions cover the trial zone.
