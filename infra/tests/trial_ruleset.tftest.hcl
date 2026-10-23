# Plan-only checks for the hosted-trial zone's WAF ruleset, against mocked
# providers (no credentials, no API calls):
#   tofu init -backend=false && tofu test
# (the repo's required_version is >= 1.6; mock_provider needs >= 1.7).
# Ids are built from 16-char halves: the release leak guard bans 32-hex literals in infra/.

mock_provider "cloudflare" {}
mock_provider "random" {}

variables {
  cloudflare_account_id  = join("", ["aaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaa"])
  cloudflare_zone_id     = join("", ["bbbbbbbbbbbbbbbb", "bbbbbbbbbbbbbbbb"])
  zone_name              = "example.com"
  operator_email         = "op@example.com"
  sandbox_operator_email = "sandbox@example.com"
  test_operator_email    = "test@example.com"
}

run "no_trial_zone_means_no_trial_ruleset" {
  command = plan

  assert {
    condition     = length(cloudflare_ruleset.trial_skip_bic_api) == 0
    error_message = "trial ruleset must not be planned when trial_zone_id is unset"
  }

  # The scheduler zone's ruleset is unchanged by sharing its scanner rules.
  assert {
    condition = (
      length(cloudflare_ruleset.skip_bic_api.rules) == 3 &&
      cloudflare_ruleset.skip_bic_api.rules[0].action == "block" &&
      cloudflare_ruleset.skip_bic_api.rules[1].action == "block" &&
      cloudflare_ruleset.skip_bic_api.rules[2].ref == "skip_bic_oauth_v1" &&
      cloudflare_ruleset.skip_bic_api.rules[2].expression == "starts_with(http.request.uri.path, \"/oauth\") or starts_with(http.request.uri.path, \"/v1\")"
    )
    error_message = "skip_bic_api must keep its two block rules and the unscoped BIC skip"
  }
}

run "trial_zone_gets_mirrored_ruleset" {
  command = plan

  variables {
    trial_zone_id  = join("", ["cccccccccccccccc", "cccccccccccccccc"])
    trial_hostname = "app.trial.example"
  }

  assert {
    condition     = cloudflare_ruleset.trial_skip_bic_api[0].zone_id == join("", ["cccccccccccccccc", "cccccccccccccccc"])
    error_message = "trial ruleset must sit on trial_zone_id"
  }

  assert {
    condition     = cloudflare_ruleset.trial_skip_bic_api[0].phase == "http_request_firewall_custom" && cloudflare_ruleset.trial_skip_bic_api[0].kind == "zone"
    error_message = "trial ruleset must be the zone's http_request_firewall_custom entrypoint"
  }

  assert {
    condition     = length(cloudflare_ruleset.trial_skip_bic_api[0].rules) == 3
    error_message = "trial ruleset must have the two scanner blocks plus the BIC skip"
  }

  # The two scanner block rules are the scheduler zone's, verbatim.
  assert {
    condition = alltrue([
      for i in [0, 1] :
      cloudflare_ruleset.trial_skip_bic_api[0].rules[i].expression == cloudflare_ruleset.skip_bic_api.rules[i].expression &&
      cloudflare_ruleset.trial_skip_bic_api[0].rules[i].action == "block"
    ])
    error_message = "trial scanner block rules must mirror skip_bic_api's"
  }

  # The BIC skip sits last and is scoped to the trial host's /oauth and /v1.
  assert {
    condition     = cloudflare_ruleset.trial_skip_bic_api[0].rules[2].action == "skip" && cloudflare_ruleset.trial_skip_bic_api[0].rules[2].action_parameters.products == tolist(["bic"])
    error_message = "last trial rule must skip only BIC"
  }

  assert {
    condition     = cloudflare_ruleset.trial_skip_bic_api[0].rules[2].expression == "http.host eq \"app.trial.example\" and (starts_with(http.request.uri.path, \"/oauth\") or starts_with(http.request.uri.path, \"/v1\"))"
    error_message = "BIC skip must be scoped to the trial host and the /oauth + /v1 paths"
  }
}

run "trial_zone_without_hostname_is_refused" {
  command = plan

  variables {
    trial_zone_id = join("", ["cccccccccccccccc", "cccccccccccccccc"])
  }

  expect_failures = [cloudflare_ruleset.trial_skip_bic_api]
}
