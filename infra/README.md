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
