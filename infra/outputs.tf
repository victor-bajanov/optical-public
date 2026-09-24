output "d1_database_id" {
  description = "Paste into worker/wrangler.toml [[d1_databases]].database_id"
  value       = cloudflare_d1_database.scheduler.id
}

output "kv_namespace_id" {
  description = "Paste into worker/wrangler.toml [[kv_namespaces]].id"
  value       = cloudflare_workers_kv_namespace.google_token_cache.id
}

output "access_application_aud" {
  description = "Paste into worker/wrangler.toml [vars].ACCESS_POLICY_AUD"
  value       = cloudflare_zero_trust_access_application.scheduler.aud
}

output "access_application_dev_aud" {
  description = "Paste into worker/wrangler.toml [env.dev].vars.ACCESS_POLICY_AUD, then redeploy dev"
  value       = cloudflare_zero_trust_access_application.scheduler_dev.aud
}

output "hostname" {
  description = "The fully-qualified hostname Cloudflare Access protects"
  value       = local.hostname
}

output "oauth_issuer" {
  description = "Paste into worker/wrangler.toml [vars].OAUTH_ISSUER"
  value       = "https://${local.hostname}"
}

output "google_oauth_redirect_uri" {
  description = "Use this exact value when configuring the Google Cloud OAuth Web client"
  value       = "https://${local.hostname}/auth/callback"
}
