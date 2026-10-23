variable "cloudflare_account_id" {
  description = "Cloudflare account ID (32-char hex)"
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for the domain hosting scheduler.<zone>"
  type        = string
}

variable "subdomain" {
  description = "Subdomain on the zone where the scheduler will live (e.g. \"scheduler\")"
  type        = string
  default     = "scheduler"
}

variable "zone_name" {
  description = "Apex zone name (e.g. \"example.com\"). Used in computed hostnames."
  type        = string
}

variable "operator_email" {
  description = "Email of the single operator Cloudflare Access will allow (prod /admin)"
  type        = string
}

variable "sandbox_operator_email" {
  description = "Second identity allowed on the ISOLATED dev Access app only (multi-user smoke harness). Never added to the prod operator policy."
  type        = string
}

variable "test_operator_email" {
  description = "Third identity allowed on the ISOLATED dev Access app only (multi-user smoke harness). Never added to the prod operator policy."
  type        = string
}

# Hosted trial (internal design notes). Both default to null, which
# plans no trial resources; set both to manage the trial zone's WAF ruleset.
variable "trial_zone_id" {
  description = "Cloudflare zone ID of the hosted-trial deployment's zone. null (default) plans no trial resources."
  type        = string
  default     = null
}

variable "trial_hostname" {
  description = "Hostname of the hosted-trial worker on trial_zone_id (e.g. \"app.yourdomain.example\"). Required when trial_zone_id is set."
  type        = string
  default     = null
}
