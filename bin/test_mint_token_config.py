#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27"]
# ///
"""Guard for bin/mint-token.py's config-file logic: resolving the target URL
and the expected account from ~/.config/optical-smoke/config.toml (format
fixed in internal design notes, schema owned by bin/_smoke_identity.py)
instead of command-line flags, and the EXPECTED_TEST_ACCOUNT line the export
block gains when the expected account is known.

httpx is here only so the TARGET_URLS drift check can load
bin/_smoke_registry.py (which imports _smoke_lib, which needs httpx).

Run: uv run bin/test_mint_token_config.py
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parent / filename)
    assert spec and spec.loader, f"could not load {filename}"
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


mint = _load("mint_token", "mint-token.py")
RunnerConfig = mint._smoke_identity.RunnerConfig

DEV_URL = "https://scheduler-dev.example.com"
PROD_URL = "https://scheduler.example.com"

# The full example from internal design notes ("Config file").
DESIGN_DOC_CONFIG = """\
[defaults]
target = "dev"

[google]
a = "smoke.a@example.com"
b = "smoke.b@example.com"
c = "smoke.c@example.com"
primary = "a"

[microsoft]
a = "ms.test@dev-tenant.example"
primary = "a"
attendee = "ms2@other-tenant.example"

[poll]
invitee_a = "smoke.b@example.com"
invitee_b = "smoke.c@example.com"
"""


@pytest.fixture
def design_cfg(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text(DESIGN_DOC_CONFIG)
    return mint.load_optional_config(path)


# =============================================================================
# TARGET_URLS — must stay identical to _smoke_registry's TARGETS (mint-token
# can't import the registry at runtime: it would drag in httpx)
# =============================================================================


def test_target_urls_match_the_registry():
    registry = _load("_smoke_registry", "_smoke_registry.py")
    assert mint.TARGET_URLS == {
        name: t.scheduler_url for name, t in registry.TARGETS.items()
    }


def test_prod_is_not_a_target_name():
    assert PROD_URL not in mint.TARGET_URLS.values()


def test_target_names_are_the_smoke_deployments():
    expected = {"dev"}
    assert set(mint.TARGET_URLS) == expected
    assert mint.TARGET_URLS["dev"] == DEV_URL


# =============================================================================
# load_optional_config — missing file is "no config", malformed is loud
# =============================================================================


def test_load_optional_config_returns_none_when_file_absent(tmp_path):
    assert mint.load_optional_config(tmp_path / "config.toml") is None


def test_load_optional_config_parses_the_design_doc_example(design_cfg):
    assert design_cfg is not None
    assert design_cfg.target == "dev"
    assert design_cfg.google["b"] == "smoke.b@example.com"
    assert design_cfg.google_primary == "a"
    assert design_cfg.microsoft["a"] == "ms.test@dev-tenant.example"
    assert design_cfg.microsoft_primary == "a"


def test_load_optional_config_raises_on_malformed_toml(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text("[google\n")
    with pytest.raises(ValueError):
        mint.load_optional_config(path)


# =============================================================================
# resolve_url — --url > config target > $SCHEDULER_URL > prod
# =============================================================================


def test_resolve_url_explicit_flag_wins_over_everything(design_cfg):
    url = mint.resolve_url(
        "https://elsewhere.example", design_cfg, {"SCHEDULER_URL": "https://env.example"}
    )
    assert url == "https://elsewhere.example"


def test_resolve_url_config_target_dev_maps_to_dev_host(design_cfg):
    assert mint.resolve_url(None, design_cfg, {}) == DEV_URL




def test_resolve_url_config_target_beats_stale_scheduler_url_env(design_cfg):
    # The stale-env lesson: a leftover env var must not retarget a run once
    # the config declares a default target.
    url = mint.resolve_url(None, design_cfg, {"SCHEDULER_URL": "https://stale.example"})
    assert url == DEV_URL


def test_resolve_url_unknown_target_is_loud():
    with pytest.raises(ValueError, match="target"):
        mint.resolve_url(None, RunnerConfig(target="prod"), {})


def test_resolve_url_without_config_falls_back_to_env_then_prod():
    assert (
        mint.resolve_url(None, None, {"SCHEDULER_URL": "https://env.example"})
        == "https://env.example"
    )
    assert mint.resolve_url(None, None, {}) == PROD_URL


def test_resolve_url_config_without_defaults_section_targets_dev(tmp_path):
    # RunnerConfig's target default: a config file that only lists the cast
    # still means "smokes go to dev", never prod.
    path = tmp_path / "config.toml"
    path.write_text('[google]\na = "a@x"\n')
    cfg = mint.load_optional_config(path)
    assert mint.resolve_url(None, cfg, {}) == DEV_URL


# =============================================================================
# resolve_expected_email — the account cast, per provider
# =============================================================================


def test_expected_email_google_follows_the_primary_letter(design_cfg):
    assert mint.resolve_expected_email(design_cfg, "google") == "smoke.a@example.com"


def test_expected_email_google_primary_letter_is_respected():
    cfg = RunnerConfig(google={"a": "a@x", "b": "b@x"}, google_primary="b")
    assert mint.resolve_expected_email(cfg, "google") == "b@x"


def test_expected_email_google_primary_defaults_to_a(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text('[google]\na = "a@x"\nb = "b@x"\n')
    cfg = mint.load_optional_config(path)
    assert mint.resolve_expected_email(cfg, "google") == "a@x"


def test_expected_email_google_invalid_primary_letter_is_loud():
    cfg = RunnerConfig(google={"a": "a@x"}, google_primary="z")
    with pytest.raises(ValueError, match="primary"):
        mint.resolve_expected_email(cfg, "google")


def test_expected_email_google_missing_email_for_primary_is_none():
    cfg = RunnerConfig(google={"b": "b@x"})  # primary defaults to a; a not given
    assert mint.resolve_expected_email(cfg, "google") is None


def test_expected_email_microsoft_uses_ms_primary_not_attendee(design_cfg):
    assert (
        mint.resolve_expected_email(design_cfg, "microsoft")
        == "ms.test@dev-tenant.example"
    )


def test_expected_email_microsoft_primary_letter_is_respected():
    cfg = RunnerConfig(microsoft={"a": "a@x", "b": "b@x"}, microsoft_primary="b")
    assert mint.resolve_expected_email(cfg, "microsoft") == "b@x"


def test_expected_email_microsoft_primary_defaults_to_a(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text('[microsoft]\na = "a@x"\nb = "b@x"\n')
    cfg = mint.load_optional_config(path)
    assert mint.resolve_expected_email(cfg, "microsoft") == "a@x"


def test_expected_email_microsoft_invalid_primary_letter_is_loud():
    cfg = RunnerConfig(microsoft={"a": "a@x"}, microsoft_primary="z")
    with pytest.raises(ValueError, match="primary"):
        mint.resolve_expected_email(cfg, "microsoft")


def test_expected_email_microsoft_missing_email_for_primary_is_none():
    cfg = RunnerConfig(microsoft={"b": "b@x"})  # primary defaults to a; a not given
    assert mint.resolve_expected_email(cfg, "microsoft") is None


def test_expected_email_blank_saved_microsoft_primary_does_not_raise(tmp_path):
    # REVIEW FIX (Opus review): [microsoft]\nprimary = "" must load as
    # letter "a" (see bin/test_smoke_runner_identity.py's companion test on
    # load_config directly) so this call degrades to None, never raises.
    path = tmp_path / "config.toml"
    path.write_text('[microsoft]\nprimary = ""\n')
    cfg = mint.load_optional_config(path)
    assert mint.resolve_expected_email(cfg, "microsoft") is None


def test_expected_email_unconfigured_provider_is_none():
    cfg = RunnerConfig()
    assert mint.resolve_expected_email(cfg, "google") is None
    assert mint.resolve_expected_email(cfg, "microsoft") is None


def test_expected_email_no_config_is_none():
    assert mint.resolve_expected_email(None, "google") is None
    assert mint.resolve_expected_email(None, "microsoft") is None


def test_expected_email_blank_values_count_as_absent():
    cfg = RunnerConfig(microsoft={"a": "   "})
    assert mint.resolve_expected_email(cfg, "microsoft") is None


# =============================================================================
# whoami_matches — same semantics as mu-smoke-login's wrong-account guard
# =============================================================================


def test_whoami_matches_is_case_insensitive():
    assert mint.whoami_matches("smoke.A@example.com", "smoke.a@example.com")


def test_whoami_matches_rejects_different_and_empty_emails():
    assert not mint.whoami_matches("other@gmail.com", "smoke.a@example.com")
    assert not mint.whoami_matches("", "smoke.a@example.com")


# =============================================================================
# token_export_lines — EXPECTED_TEST_ACCOUNT rides along only when known
# (the base three-line shape is guarded by bin/test_mint_token_exports.py)
# =============================================================================


MINTED_AT = "2026-09-01T00:00:00+00:00"


def test_token_export_lines_without_expected_account_is_unchanged():
    assert mint.token_export_lines("acc", "ref", MINTED_AT) == [
        "export SCHEDULER_BEARER=acc",
        "export SCHEDULER_REFRESH_TOKEN=ref",
        f"export SCHEDULER_MINTED_AT={MINTED_AT}",
    ]


def test_token_export_lines_with_expected_account_appends_it():
    assert mint.token_export_lines("acc", "ref", MINTED_AT, "smoke.a@example.com") == [
        "export SCHEDULER_BEARER=acc",
        "export SCHEDULER_REFRESH_TOKEN=ref",
        f"export SCHEDULER_MINTED_AT={MINTED_AT}",
        "export EXPECTED_TEST_ACCOUNT=smoke.a@example.com",
    ]


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
