#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27"]
# ///
"""Guards for bin/_smoke_registry.py: the declarative TARGETS/HARNESSES data,
compose_env's env-composition + Blocked algorithm, is_smoke_var's scrub
scope, and project_identity's env-var projection. Per
the internal design notes' WP1 section — TDD per repo
practice: written first, red against a module that doesn't exist yet.

WP1 duck-types the identity/config objects (does not import
bin/_smoke_identity.py, per the plan's layering rule) — FakeTokens/FakeConfig
below are local stubs matching the structural contract WP2 pins:
  IdentityTokens: .slot .bearer .refresh .email .client_id .minted_at
  RunnerConfig:   .target .google .google_primary .microsoft .microsoft_primary
                  .microsoft_attendee .poll_invitee_a .poll_invitee_b
`.microsoft_primary` is a LETTER ("a"/"b"/"c"), mirroring `.google_primary` —
internal design notes Decision 2.

Run: uv run bin/test_smoke_runner_registry.py
"""
from __future__ import annotations

import importlib.util
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

BIN = Path(__file__).resolve().parent

_spec = importlib.util.spec_from_file_location("_smoke_registry", BIN / "_smoke_registry.py")
assert _spec and _spec.loader, "could not load _smoke_registry module"
reg = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = reg
_spec.loader.exec_module(reg)


# Where the Microsoft modes run (the target hosting provider "microsoft"), the
# targets the Google modes that also run there allow, every target name, and
# each target's hosted providers (dev hosts both providers).
MICROSOFT_TARGET = "dev"
SHARED_TARGETS: tuple[str, ...] = ("dev",)
EXPECTED_PROVIDERS = {"dev": ("google", "microsoft")}
MICROSOFT_TURNSTILE_VAR = f"TURNSTILE_SECRET_{MICROSOFT_TARGET.upper()}"


# =============================================================================
# Local stubs — duck-type WP2's IdentityTokens / RunnerConfig, per the plan's
# "WP1 imports _smoke_lib but NOT _smoke_identity" layering rule.
# =============================================================================


@dataclass(frozen=True)
class FakeTokens:
    slot: str
    bearer: str
    refresh: str
    email: str
    client_id: str = "smoke-cli"
    minted_at: datetime | None = None


@dataclass(frozen=True)
class FakeConfig:
    target: str = "dev"
    google: dict = field(default_factory=lambda: {
        "a": "a@example.com", "b": "b@example.com", "c": "c@example.com",
    })
    google_primary: str = "a"
    microsoft: dict = field(default_factory=lambda: {
        "a": "msa@example.com", "b": "msb@example.com", "c": "msc@example.com",
    })
    microsoft_primary: str = "a"
    microsoft_attendee: str = "attendee@other-tenant.example"
    poll_invitee_a: str = "b@example.com"
    poll_invitee_b: str = "c@example.com"


def full_config(**overrides) -> FakeConfig:
    return FakeConfig(**overrides)


def full_identities(cfg: FakeConfig) -> dict:
    return {
        "google:a": FakeTokens(slot="google:a", bearer="bearA", refresh="refrA", email=cfg.google["a"]),
        "google:b": FakeTokens(slot="google:b", bearer="bearB", refresh="refrB", email=cfg.google["b"]),
        "google:c": FakeTokens(slot="google:c", bearer="bearC", refresh="refrC", email=cfg.google["c"]),
        "microsoft:a": FakeTokens(slot="microsoft:a", bearer="bearMSA", refresh="refrMSA", email=cfg.microsoft["a"]),
        "microsoft:b": FakeTokens(slot="microsoft:b", bearer="bearMSB", refresh="refrMSB", email=cfg.microsoft["b"]),
        "microsoft:c": FakeTokens(slot="microsoft:c", bearer="bearMSC", refresh="refrMSC", email=cfg.microsoft["c"]),
    }


def full_base_env(**overrides) -> dict:
    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": "/root",
        "CLOUDFLARE_API_TOKEN": "cf-tok-abc",
        "TURNSTILE_SECRET_DEV": "ts-secret-abc",
    }
    env.update(overrides)
    return env


def expect_blocked(harness_name, mode, target, env, identities, cfg, **kwargs) -> str:
    harness = reg.HARNESSES[harness_name]
    with pytest.raises(reg.Blocked) as ei:
        reg.compose_env(harness, mode, target, env, identities, cfg, **kwargs)
    return ei.value.reason


@pytest.fixture(autouse=True)
def _pin_weekday(monkeypatch):
    """poll-smoke's advisory Mon-Thu gate reads reg._today(); pin a Thursday so
    tests composing poll-smoke don't fail Fri-Sun. Day-gate tests re-pin."""
    monkeypatch.setattr(reg, "_today", lambda: date(2024, 1, 4))  # Thursday


@pytest.fixture
def google_only_target(monkeypatch):
    """A synthetic, Google-only target no registered mode lists — the dev
    triple under another name — so the wrong-target and provider-hosting
    gates can be exercised whatever the real TARGETS hold."""
    dev = reg.TARGETS["dev"]
    monkeypatch.setitem(reg.TARGETS, "google-only", reg.Target(
        name="google-only", scheduler_url=dev.scheduler_url, db_id=dev.db_id,
        wrangler_env=dev.wrangler_env, providers=("google",),
    ))
    return "google-only"


# =============================================================================
# TARGETS — the target triples must satisfy _smoke_lib's own guards, so the
# registry can never drift from the guard's covered behaviour.
# =============================================================================


def test_target_names():
    assert set(reg.TARGETS) == set(EXPECTED_PROVIDERS)


def test_target_triples_satisfy_smoke_lib_guards():
    for target in reg.TARGETS.values():
        reg._smoke_lib.assert_dev_url(target.scheduler_url)   # no raise
        reg._smoke_lib.assert_dev_db(target.db_id)             # no raise
        reg._smoke_lib.assert_env_consistent(target.scheduler_url, target.db_id)  # no raise


def test_dev_target_matches_smoke_lib_constants():
    dev = reg.TARGETS["dev"]
    assert dev.db_id == reg._smoke_lib.DEV_DB_ID
    assert dev.wrangler_env == "dev"
    assert dev.scheduler_url == "https://scheduler-dev.example.com"




# =============================================================================
# HARNESSES — sanity: all ten present, with the audited exit/parser/target
# facts from the implementation plan.
# =============================================================================


def test_all_ten_harnesses_registered():
    assert set(reg.HARNESSES) == {
        "regression-smoke", "reset-smoke-env", "multiuser-smoke", "meeting-smoke",
        "booking-smoke", "config-smoke", "engine-smoke", "feed-smoke",
        "poll-smoke", "ms-smoke",
    }


@pytest.mark.parametrize("name,exit_convention,parser,interactive", [
    ("regression-smoke", "pass01", "regression", False),
    ("reset-smoke-env", "pass01", "none", False),
    ("multiuser-smoke", "pass01", "colon", False),
    ("meeting-smoke", "pass012", "colon", False),
    ("booking-smoke", "pass01", "dash", False),
    ("config-smoke", "pass01", "dash", False),
    ("engine-smoke", "pass01", "dash", False),
    ("feed-smoke", "pass01", "dash", False),
    ("poll-smoke", "pass012", "dash", False),
    ("ms-smoke", "pass012", "colon", False),
])
def test_harness_exit_convention_parser_interactive(name, exit_convention, parser, interactive):
    h = reg.HARNESSES[name]
    assert h.exit_convention == exit_convention
    assert h.parser == parser
    assert h.interactive is interactive
    assert h.script == f"bin/{name}.py"


def test_multiuser_smoke_default_level_order_is_m7_last():
    # M7 (offboard) is destructive; the harness's own argparse default keeps
    # it last regardless of numeric order — the registry must not silently
    # resort this into 1..8.
    h = reg.HARNESSES["multiuser-smoke"]
    assert h.levels == ("1", "2", "3", "4", "5", "6", "8", "7")


def test_meeting_smoke_levels_are_per_mode_not_harness_level():
    h = reg.HARNESSES["meeting-smoke"]
    two_acc = next(m for m in h.modes if m.name == "2-account")
    three_acc = next(m for m in h.modes if m.name == "3-account")
    assert two_acc.levels == ("2A", "2B", "2C", "2D", "2E", "2F")
    assert three_acc.levels == ("M1", "M2", "M3")


def test_regression_smoke_levels_include_owned_meetings_as_selectable():
    # h.levels is every SELECTABLE label — owned-meetings is off by default
    # but a caller can still choose it explicitly.
    h = reg.HARNESSES["regression-smoke"]
    assert h.levels == ("1", "2", "3", "4", "5.1", "5.2", "6", "7", "8", "owned-meetings")


def test_regression_smoke_default_levels_exclude_owned_meetings():
    h = reg.HARNESSES["regression-smoke"]
    assert h.default_levels == ("1", "2", "3", "4", "5.1", "5.2", "6", "7", "8")
    assert "owned-meetings" not in h.default_levels


def test_ms_smoke_default_levels_are_1_through_6():
    assert reg.HARNESSES["ms-smoke"].levels == ("1", "2", "3", "4", "5", "6")


def test_multiuser_smoke_default_mode_targets():
    h = reg.HARNESSES["multiuser-smoke"]
    mode = h.modes[0]
    assert mode.targets == SHARED_TARGETS


def test_ms_smoke_targets_only_the_microsoft_target():
    h = reg.HARNESSES["ms-smoke"]
    mode = h.modes[0]
    assert mode.targets == (MICROSOFT_TARGET,)


def test_poll_smoke_is_not_interactive_and_mon_thu_gated():
    # poll-smoke runs captured like every other harness: its mailbox relay
    # resolves invitee links without an operator, and with the child's stdin
    # detached (smoke-runner.default_execute) a relay miss exits with the
    # harness's own "stdin is not a TTY" message instead of prompting.
    h = reg.HARNESSES["poll-smoke"]
    assert h.interactive is False
    assert h.run_days == "mon-thu"


# =============================================================================
# is_smoke_var — scrub scope: letter suffixes are a closed set (arbitrary
# A_*/B_*/C_* vars from the user's shell must survive), SCHEDULER_*/SMOKE_*/
# INVITEE_* are wildcards, everything else named exactly.
# =============================================================================


@pytest.mark.parametrize("name", [
    "A_BEARER", "B_REFRESH", "C_EXPECTED_EMAIL", "A_CLIENT_ID", "B_MINTED_AT", "C_HOME_TZ",
    "SCHEDULER_URL", "SCHEDULER_BEARER", "SCHEDULER_CLIENT_ID",
    "SMOKE_WRANGLER_ENV", "SMOKE_PROVIDER", "SMOKE_DONE_COLOR_ID",
    "EXPECTED_TEST_ACCOUNT", "D1_DATABASE_ID", "MS2_ATTENDEE_EMAIL",
    "POLL_SMOKE_ALLOW_ANY_DAY", "POLL_SMOKE_DEADLINE_HOURS",
    "NUDGE_INVITEE_EMAIL", "EDIT_C_EMAIL",
    "INVITEE_A_EMAIL", "INVITEE_B_EMAIL", "INVITEE_A_TOKEN", "INVITEE_B_TOKEN",
    "NUDGE_TOKEN", "UNHAPPY_A_TOKEN", "UNHAPPY_B_TOKEN",
    "HIDDEN_A_TOKEN", "HIDDEN_B_TOKEN", "GUESTWAIT_A_TOKEN", "GUESTWAIT_B_TOKEN",
    "BOOKBEST_A_TOKEN", "EDIT_A_TOKEN", "EDIT_B_TOKEN", "EDIT_C_TOKEN", "EDIT_D_TOKEN",
])
def test_is_smoke_var_true_for_known_smoke_vars(name):
    assert reg.is_smoke_var(name) is True


@pytest.mark.parametrize("name", [
    "MS_A_BEARER", "MS_B_REFRESH", "MS_C_EXPECTED_EMAIL",
    "MS_A_CLIENT_ID", "MS_B_MINTED_AT", "MS_C_HOME_TZ",
])
def test_is_smoke_var_true_for_ms_letter_family(name):
    # Microsoft letters seed from the MS_<L>_* env family (Decision 3) —
    # the runner scrubs those too, even though project_identity never
    # writes them itself (it projects onto plain <L>_* — see
    # test_project_identity_letter_prefix_works_regardless_of_provider).
    assert reg.is_smoke_var(name) is True


@pytest.mark.parametrize("name", [
    "CLOUDFLARE_API_TOKEN", "TURNSTILE_SECRET_DEV", "PATH", "HOME",
    "A_TEAM", "A_CUSTOM_THING", "B_PROJECT", "C_NOTES",
    "SCHEDULERISH", "SMOKEY", "MY_INVITEE_COUNT",
    "MS_TEAM", "MSA_BEARER",
])
def test_is_smoke_var_false_for_unrelated_vars(name):
    # Arbitrary A_*/B_*/C_* vars from the user's shell (not one of the known
    # letter suffixes) must survive the scrub — see the plan's explicit
    # "do NOT nuke arbitrary A_* vars" warning.
    assert reg.is_smoke_var(name) is False


# =============================================================================
# project_identity — env-var projection per prefix; MINTED_AT/CLIENT_ID are
# included iff present/non-default.
# =============================================================================


def test_project_identity_scheduler_prefix_omits_optional_fields_by_default():
    tokens = FakeTokens(slot="google:a", bearer="b", refresh="r", email="e@example.com")
    out = reg.project_identity("SCHEDULER", tokens)
    assert out == {
        "SCHEDULER_BEARER": "b",
        "SCHEDULER_REFRESH_TOKEN": "r",
        "EXPECTED_TEST_ACCOUNT": "e@example.com",
    }


def test_project_identity_scheduler_includes_client_id_when_overridden():
    tokens = FakeTokens(slot="google:a", bearer="b", refresh="r", email="e@example.com", client_id="other-cli")
    out = reg.project_identity("SCHEDULER", tokens)
    assert out["SCHEDULER_CLIENT_ID"] == "other-cli"


def test_project_identity_scheduler_includes_minted_at_when_present():
    dt = datetime(2026, 8, 1, 10, 0, 0, tzinfo=timezone.utc)
    tokens = FakeTokens(slot="google:a", bearer="b", refresh="r", email="e@example.com", minted_at=dt)
    out = reg.project_identity("SCHEDULER", tokens)
    assert out["SCHEDULER_MINTED_AT"] == dt.isoformat()


def test_project_identity_letter_prefix_omits_optional_fields_by_default():
    tokens = FakeTokens(slot="google:b", bearer="bB", refresh="rB", email="b@example.com")
    out = reg.project_identity("B", tokens)
    assert out == {"B_BEARER": "bB", "B_REFRESH": "rB", "B_EXPECTED_EMAIL": "b@example.com"}


def test_project_identity_letter_prefix_includes_client_id_and_minted_at():
    dt = datetime(2026, 8, 1, 10, 0, 0, tzinfo=timezone.utc)
    tokens = FakeTokens(slot="google:c", bearer="bC", refresh="rC", email="c@example.com",
                        client_id="other-cli", minted_at=dt)
    out = reg.project_identity("C", tokens)
    assert out["C_CLIENT_ID"] == "other-cli"
    assert out["C_MINTED_AT"] == dt.isoformat()


def test_project_identity_letter_prefix_works_regardless_of_provider():
    # A microsoft:a identity projected under prefix "A" writes the PLAIN
    # A_BEARER/A_REFRESH/A_EXPECTED_EMAIL family — harnesses never learn the
    # MS_ names (internal design notes Decision 3).
    # project_identity is keyed purely by prefix, so it needs no provider
    # awareness at all; this test just proves that stays true.
    tokens = FakeTokens(slot="microsoft:a", bearer="msBearA", refresh="msRefrA", email="msa@example.com")
    out = reg.project_identity("A", tokens)
    assert out == {"A_BEARER": "msBearA", "A_REFRESH": "msRefrA", "A_EXPECTED_EMAIL": "msa@example.com"}


# =============================================================================
# compose_env — per-harness env composition. Each test isolates the
# harness's required vars against the audited facts in the implementation
# plan; SCHEDULER_URL/D1_DATABASE_ID/SMOKE_WRANGLER_ENV are always present
# (compose_env step 2), regardless of whether the harness itself needs them.
# =============================================================================


def assert_target_triple(run, target_name):
    target = reg.TARGETS[target_name]
    assert run.env["SCHEDULER_URL"] == target.scheduler_url
    assert run.env["D1_DATABASE_ID"] == target.db_id
    assert run.env["SMOKE_WRANGLER_ENV"] == target.wrangler_env


def test_regression_smoke_google_mode_env():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["regression-smoke"], "google", "dev",
                          full_base_env(), full_identities(cfg), cfg)
    assert run.env["SCHEDULER_BEARER"] == "bearA"
    assert run.env["SCHEDULER_REFRESH_TOKEN"] == "refrA"
    assert run.env["EXPECTED_TEST_ACCOUNT"] == "a@example.com"
    assert "SCHEDULER_CLIENT_ID" not in run.env
    assert_target_triple(run, "dev")
    assert run.argv[:3] == ("uv", "run", "bin/regression-smoke.py")
    assert "--provider" in run.argv
    assert run.argv[run.argv.index("--provider") + 1] == "google"


def test_regression_smoke_google_mode_uses_configured_primary_letter():
    cfg = full_config(google_primary="b")
    run = reg.compose_env(reg.HARNESSES["regression-smoke"], "google", "dev",
                          full_base_env(), full_identities(cfg), cfg)
    assert run.env["SCHEDULER_BEARER"] == "bearB"
    assert run.env["EXPECTED_TEST_ACCOUNT"] == "b@example.com"


def test_regression_smoke_microsoft_mode_env():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["regression-smoke"], "microsoft", MICROSOFT_TARGET,
                          full_base_env(), full_identities(cfg), cfg)
    assert run.env["SCHEDULER_BEARER"] == "bearMSA"
    assert run.env["EXPECTED_TEST_ACCOUNT"] == cfg.microsoft["a"]
    assert_target_triple(run, MICROSOFT_TARGET)
    assert run.argv[run.argv.index("--provider") + 1] == "microsoft"


def test_regression_smoke_microsoft_mode_uses_configured_primary_letter():
    cfg = full_config(microsoft_primary="b")
    run = reg.compose_env(reg.HARNESSES["regression-smoke"], "microsoft", MICROSOFT_TARGET,
                          full_base_env(), full_identities(cfg), cfg)
    assert run.env["SCHEDULER_BEARER"] == "bearMSB"
    assert run.env["EXPECTED_TEST_ACCOUNT"] == cfg.microsoft["b"]


def test_regression_smoke_webhook_check_mode():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["regression-smoke"], "webhook-check", "dev",
                          full_base_env(), full_identities(cfg), cfg)
    assert "--webhook-check" in run.argv


def test_regression_smoke_feed_check_mode():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["regression-smoke"], "feed-check", "dev",
                          full_base_env(), full_identities(cfg), cfg)
    assert "--feed-check" in run.argv


def test_reset_smoke_env_google_mode_env():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["reset-smoke-env"], "google", "dev",
                          full_base_env(), full_identities(cfg), cfg)
    assert run.env["SCHEDULER_BEARER"] == "bearA"
    assert run.env["EXPECTED_TEST_ACCOUNT"] == "a@example.com"
    assert_target_triple(run, "dev")  # D1_DATABASE_ID passed even though optional for this harness


def test_reset_smoke_env_microsoft_mode_env():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["reset-smoke-env"], "microsoft", MICROSOFT_TARGET,
                          full_base_env(), full_identities(cfg), cfg)
    assert run.env["SCHEDULER_BEARER"] == "bearMSA"
    assert_target_triple(run, MICROSOFT_TARGET)


def test_multiuser_smoke_env():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["multiuser-smoke"], "default", "dev",
                          full_base_env(), full_identities(cfg), cfg)
    assert run.env["A_BEARER"] == "bearA"
    assert run.env["A_REFRESH"] == "refrA"
    assert run.env["A_EXPECTED_EMAIL"] == "a@example.com"
    assert run.env["B_BEARER"] == "bearB"
    assert run.env["B_EXPECTED_EMAIL"] == "b@example.com"
    assert "A_CLIENT_ID" not in run.env
    assert "B_CLIENT_ID" not in run.env
    assert_target_triple(run, "dev")


def test_meeting_smoke_2account_env():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["meeting-smoke"], "2-account", "dev",
                          full_base_env(), full_identities(cfg), cfg)
    assert run.env["B_BEARER"] == "bearB"
    assert run.env["C_BEARER"] == "bearC"
    assert "A_BEARER" not in run.env
    assert "--accounts" in run.argv and "2" in run.argv
    assert_target_triple(run, "dev")


def test_meeting_smoke_3account_env():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["meeting-smoke"], "3-account", "dev",
                          full_base_env(), full_identities(cfg), cfg)
    assert run.env["A_BEARER"] == "bearA"
    assert run.env["B_BEARER"] == "bearB"
    assert run.env["C_BEARER"] == "bearC"
    assert "--accounts" in run.argv and "3" in run.argv


def test_booking_smoke_base_env():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["booking-smoke"], "base", "dev",
                          full_base_env(), full_identities(cfg), cfg)
    assert run.env["A_BEARER"] == "bearA"
    assert "C_BEARER" not in run.env
    assert "--mode" in run.argv and "base" in run.argv
    assert_target_triple(run, "dev")


def test_booking_smoke_decline_env():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["booking-smoke"], "decline", "dev",
                          full_base_env(), full_identities(cfg), cfg)
    assert run.env["A_BEARER"] == "bearA"
    assert run.env["C_BEARER"] == "bearC"
    assert "--mode" in run.argv and "decline" in run.argv


def test_config_smoke_env():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["config-smoke"], "default", "dev",
                          full_base_env(), full_identities(cfg), cfg)
    assert run.env["A_BEARER"] == "bearA"
    assert run.env["A_EXPECTED_EMAIL"] == "a@example.com"


def test_engine_smoke_auto_mode_is_first_and_passes_no_phase():
    # The harness detects the deployed SOLVER_ENGINE posture itself (Workers
    # settings API) — the runner must not pin a phase that the deployment
    # may not match (the 2026-09-02 "shadow" default failed S1 against a
    # fallback-deployed dev).
    h = reg.HARNESSES["engine-smoke"]
    assert [m.name for m in h.modes] == ["auto", "fanout", "microsoft"]
    cfg = full_config()
    run = reg.compose_env(h, "auto", "dev", full_base_env(), full_identities(cfg), cfg)
    assert run.env["A_BEARER"] == "bearA"
    assert "--phase" not in run.argv
    assert_target_triple(run, "dev")


def test_engine_smoke_fanout_mode_is_explicit():
    # fanout needs a crowded week (its summary line is required) so it can't
    # be inferred from the posture — it stays an explicit, dev-only choice.
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["engine-smoke"], "fanout", "dev",
                          full_base_env(), full_identities(cfg), cfg)
    assert run.argv[-2:] == ("--phase", "fanout")
    assert_target_triple(run, "dev")


def test_feed_smoke_env():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["feed-smoke"], "default", "dev",
                          full_base_env(), full_identities(cfg), cfg)
    assert run.env["A_BEARER"] == "bearA"
    assert run.env["A_EXPECTED_EMAIL"] == "a@example.com"


def test_poll_smoke_env_includes_invitee_emails():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["poll-smoke"], "default", "dev",
                          full_base_env(), full_identities(cfg), cfg)
    assert run.env["A_BEARER"] == "bearA"
    assert run.env["INVITEE_A_EMAIL"] == cfg.poll_invitee_a
    assert run.env["INVITEE_B_EMAIL"] == cfg.poll_invitee_b


def test_poll_smoke_no_token_overrides_are_ever_set():
    # The 14 *_TOKEN overrides and NUDGE_INVITEE_EMAIL/EDIT_C_EMAIL are
    # deliberately NOT set by the runner (interactive/mailbox relay path,
    # out of scope v1) — they must never appear in composed output.
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["poll-smoke"], "default", "dev",
                          full_base_env(), full_identities(cfg), cfg)
    for name in ("INVITEE_A_TOKEN", "INVITEE_B_TOKEN", "NUDGE_TOKEN", "EDIT_A_TOKEN",
                 "NUDGE_INVITEE_EMAIL", "EDIT_C_EMAIL"):
        assert name not in run.env


def test_ms_smoke_env_includes_attendee_email_by_default():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["ms-smoke"], "default", MICROSOFT_TARGET,
                          full_base_env(), full_identities(cfg), cfg)
    assert run.env["SCHEDULER_BEARER"] == "bearMSA"
    assert run.env["MS2_ATTENDEE_EMAIL"] == cfg.microsoft_attendee


def test_ms_smoke_env_omits_attendee_email_when_level_6_not_selected():
    cfg = full_config(microsoft_attendee="")
    run = reg.compose_env(reg.HARNESSES["ms-smoke"], "default", MICROSOFT_TARGET,
                          full_base_env(), full_identities(cfg), cfg, levels=["1", "2"])
    assert "MS2_ATTENDEE_EMAIL" not in run.env


# =============================================================================
# stale-var scrub — a poisoned base env never leaks a smoke var through;
# unrelated/secret vars pass through untouched.
# =============================================================================


def test_stale_smoke_vars_never_leak_into_composed_env():
    cfg = full_config()
    poisoned = full_base_env(
        SMOKE_WRANGLER_ENV="stale-env",
        B_BEARER="stale-bearer-should-not-leak",
        INVITEE_A_TOKEN="stale-token-should-not-leak",
        EXPECTED_TEST_ACCOUNT="stale@example.com",
        MY_CUSTOM_VAR="keep-me",
        # A stale MS_<L>_* leftover (from a prior Microsoft-mode run in the
        # same shell) must be scrubbed too, even though config-smoke's own
        # identities are Google — same end-to-end proof as the plain-letter
        # vars above, for the distinct env family Microsoft letters seed from.
        MS_A_BEARER="stale-ms-bearer-should-not-leak",
        MS_B_MINTED_AT="2020-01-01T00:00:00+00:00",
    )
    run = reg.compose_env(reg.HARNESSES["config-smoke"], "default", "dev",
                          poisoned, full_identities(cfg), cfg)
    assert run.env["SMOKE_WRANGLER_ENV"] == "dev"  # overwritten by the target triple, not the stale value
    assert "B_BEARER" not in run.env
    assert "INVITEE_A_TOKEN" not in run.env
    assert "EXPECTED_TEST_ACCOUNT" not in run.env  # config-smoke doesn't use SCHEDULER_*/EXPECTED_TEST_ACCOUNT at all
    assert "MS_A_BEARER" not in run.env
    assert "MS_B_MINTED_AT" not in run.env
    assert run.env["MY_CUSTOM_VAR"] == "keep-me"
    assert run.env["CLOUDFLARE_API_TOKEN"] == "cf-tok-abc"
    assert run.env["TURNSTILE_SECRET_DEV"] == "ts-secret-abc"


# =============================================================================
# Blocked — the pre-spawn refusal paths.
# =============================================================================


def test_blocked_missing_identity_reason_contains_login_command():
    cfg = full_config()
    identities = full_identities(cfg)
    del identities["google:c"]
    reason = expect_blocked("meeting-smoke", "3-account", "dev", full_base_env(), identities, cfg)
    assert "mu-smoke-login.py C" in reason


def test_blocked_missing_microsoft_identity_reason_contains_login_command():
    # The old microsoft:primary -> mint-token.py branch is gone: every
    # Microsoft letter (including the one the "primary" sentinel resolves
    # to) now logs in via mu-smoke-login.py, same shape as Google.
    cfg = full_config()
    identities = full_identities(cfg)
    del identities["microsoft:a"]
    reason = expect_blocked("ms-smoke", "default", MICROSOFT_TARGET, full_base_env(), identities, cfg)
    assert "mu-smoke-login.py A" in reason
    assert "--provider microsoft" in reason
    assert "mint-token.py" not in reason


def test_blocked_missing_cloudflare_api_token_for_d1_harness():
    cfg = full_config()
    env = full_base_env()
    del env["CLOUDFLARE_API_TOKEN"]
    reason = expect_blocked("multiuser-smoke", "default", "dev", env, full_identities(cfg), cfg)
    assert "CLOUDFLARE_API_TOKEN" in reason


def test_blocked_missing_cloudflare_api_token_for_booking_decline_mode():
    cfg = full_config()
    env = full_base_env()
    del env["CLOUDFLARE_API_TOKEN"]
    reason = expect_blocked("booking-smoke", "decline", "dev", env, full_identities(cfg), cfg)
    assert "CLOUDFLARE_API_TOKEN" in reason


def test_booking_base_mode_does_not_require_cloudflare_api_token():
    # base mode uses D1 for cleanup only — CLOUDFLARE_API_TOKEN absent must
    # not block it (only decline mode's Mode.needs adds "d1").
    cfg = full_config()
    env = full_base_env()
    del env["CLOUDFLARE_API_TOKEN"]
    run = reg.compose_env(reg.HARNESSES["booking-smoke"], "base", "dev", env, full_identities(cfg), cfg)
    assert run.env["A_BEARER"] == "bearA"


def test_blocked_missing_turnstile_secret_for_booking():
    cfg = full_config()
    env = full_base_env()
    del env["TURNSTILE_SECRET_DEV"]
    reason = expect_blocked("booking-smoke", "base", "dev", env, full_identities(cfg), cfg)
    assert "TURNSTILE_SECRET_DEV" in reason


def test_blocked_ms_smoke_level5_without_cloudflare_api_token():
    cfg = full_config()
    env = full_base_env()
    del env["CLOUDFLARE_API_TOKEN"]
    reason = expect_blocked("ms-smoke", "default", MICROSOFT_TARGET, env, full_identities(cfg), cfg, levels=["5"])
    assert "CLOUDFLARE_API_TOKEN" in reason


def test_ms_smoke_without_level5_or_6_does_not_require_cloudflare_api_token():
    cfg = full_config()
    env = full_base_env()
    del env["CLOUDFLARE_API_TOKEN"]
    run = reg.compose_env(reg.HARNESSES["ms-smoke"], "default", MICROSOFT_TARGET, env, full_identities(cfg), cfg,
                          levels=["1", "2", "3", "4"])
    assert run.env["SCHEDULER_BEARER"] == "bearMSA"


def test_blocked_ms_smoke_level6_without_attendee_email():
    cfg = full_config(microsoft_attendee="")
    reason = expect_blocked("ms-smoke", "default", MICROSOFT_TARGET, full_base_env(), full_identities(cfg), cfg,
                            levels=["6"])
    assert "MS2_ATTENDEE_EMAIL" in reason


def test_blocked_poll_smoke_missing_invitee_emails():
    cfg = full_config(poll_invitee_a="")
    reason = expect_blocked("poll-smoke", "default", "dev", full_base_env(), full_identities(cfg), cfg)
    assert "INVITEE" in reason


def test_blocked_wrong_target(google_only_target):
    cfg = full_config()
    reason = expect_blocked("ms-smoke", "default", google_only_target, full_base_env(),
                            full_identities(cfg), cfg)
    assert "does not support target" in reason and google_only_target in reason




def test_booking_smoke_modes_span_both_providers():
    """2026-09-17: bin/booking-smoke.py takes --provider and --wrangler-env
    (TURNSTILE_SECRET_<ENV>, env-pinned D1 cleanup, provider clients, whoami
    preflight, Graph Sent Items for the decline emails)."""
    h = reg.HARNESSES["booking-smoke"]
    assert h.provider_flag == "--provider"
    assert [m.name for m in h.modes] == ["base", "decline", "microsoft-base", "microsoft-decline"]
    assert reg._find_mode(h, "base").targets == SHARED_TARGETS
    assert reg._find_mode(h, "decline").targets == ("dev",)
    mb = reg._find_mode(h, "microsoft-base")
    assert (mb.provider, mb.identities, mb.targets) == ("microsoft", {"A": "microsoft:a"}, (MICROSOFT_TARGET,))
    md = reg._find_mode(h, "microsoft-decline")
    assert (md.provider, md.identities, md.targets) == (
        "microsoft", {"A": "microsoft:a", "C": "microsoft:c"}, (MICROSOFT_TARGET,))
    assert "d1" in md.needs
    assert any("Mail.Read" in a for a in md.advisories)


def test_booking_microsoft_decline_projects_the_microsoft_cast():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["booking-smoke"], "microsoft-decline", MICROSOFT_TARGET,
                          full_base_env(), full_identities(cfg), cfg)
    assert run.env["A_BEARER"] == "bearMSA" and run.env["C_BEARER"] == "bearMSC"
    assert run.env[MICROSOFT_TURNSTILE_VAR]
    assert run.argv[run.argv.index("--provider") + 1] == "microsoft"
    assert_target_triple(run, MICROSOFT_TARGET)




def test_blocked_poll_smoke_mon_thu_advisory(monkeypatch):
    monkeypatch.setattr(reg, "_today", lambda: date(2024, 1, 6))  # Saturday
    cfg = full_config()
    reason = expect_blocked("poll-smoke", "default", "dev", full_base_env(), full_identities(cfg), cfg)
    assert "mon" in reason.lower() or "thu" in reason.lower()


def test_poll_smoke_mon_thu_override_sets_allow_any_day(monkeypatch):
    monkeypatch.setattr(reg, "_today", lambda: date(2024, 1, 6))  # Saturday
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["poll-smoke"], "default", "dev",
                          full_base_env(), full_identities(cfg), cfg, override_run_day=True)
    assert run.env["POLL_SMOKE_ALLOW_ANY_DAY"] == "true"


def test_poll_smoke_no_advisory_needed_on_a_mon_thu_day(monkeypatch):
    monkeypatch.setattr(reg, "_today", lambda: date(2024, 1, 4))  # Thursday
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["poll-smoke"], "default", "dev",
                          full_base_env(), full_identities(cfg), cfg)
    assert "POLL_SMOKE_ALLOW_ANY_DAY" not in run.env


def test_blocked_reason_convenience_wrapper_returns_none_when_not_blocked():
    cfg = full_config()
    assert reg.blocked_reason(reg.HARNESSES["config-smoke"], "default", "dev",
                              full_base_env(), full_identities(cfg), cfg) is None


def test_blocked_reason_convenience_wrapper_returns_the_reason():
    cfg = full_config()
    env = full_base_env()
    del env["TURNSTILE_SECRET_DEV"]
    reason = reg.blocked_reason(reg.HARNESSES["booking-smoke"], "base", "dev",
                                env, full_identities(cfg), cfg)
    assert reason is not None
    assert "TURNSTILE_SECRET_DEV" in reason


# =============================================================================
# argv — level subset joins correctly; the flag is passed iff the caller's
# subset differs from the harness/mode's own default set.
# =============================================================================


def test_argv_omits_levels_flag_when_levels_is_none():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["regression-smoke"], "google", "dev",
                          full_base_env(), full_identities(cfg), cfg, levels=None)
    assert "--levels" not in run.argv


def test_argv_omits_levels_flag_when_full_default_set_selected():
    cfg = full_config()
    h = reg.HARNESSES["regression-smoke"]
    run = reg.compose_env(h, "google", "dev", full_base_env(), full_identities(cfg), cfg,
                          levels=list(h.default_levels))
    assert "--levels" not in run.argv


def test_argv_includes_levels_flag_when_owned_meetings_added_to_the_default():
    # owned-meetings is selectable (h.levels) but not part of h.default_levels
    # — asking for the default set PLUS it must emit --levels.
    cfg = full_config()
    h = reg.HARNESSES["regression-smoke"]
    run = reg.compose_env(h, "google", "dev", full_base_env(), full_identities(cfg), cfg,
                          levels=list(h.default_levels) + ["owned-meetings"])
    assert "--levels" in run.argv
    assert "owned-meetings" in run.argv[run.argv.index("--levels") + 1]


def test_argv_includes_levels_flag_for_a_subset():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["regression-smoke"], "google", "dev",
                          full_base_env(), full_identities(cfg), cfg, levels=["1", "2"])
    assert "--levels" in run.argv
    idx = run.argv.index("--levels")
    assert run.argv[idx + 1] == "1,2"


def test_argv_levels_flag_uses_mode_level_default_for_meeting_smoke():
    cfg = full_config()
    h = reg.HARNESSES["meeting-smoke"]
    mode = next(m for m in h.modes if m.name == "2-account")
    run_default = reg.compose_env(h, "2-account", "dev", full_base_env(), full_identities(cfg), cfg,
                                  levels=list(mode.levels))
    assert "--levels" not in run_default.argv
    run_subset = reg.compose_env(h, "2-account", "dev", full_base_env(), full_identities(cfg), cfg,
                                 levels=["2A", "2B"])
    assert "--levels" in run_subset.argv
    idx = run_subset.argv.index("--levels")
    assert run_subset.argv[idx + 1] == "2A,2B"


# MINOR-3: never emit --levels for a harness/mode with no level concept at
# all, and never emit it for an explicitly empty selection — both are
# silently dropped (documented choice: WP4 may carry a stale level selection
# across a harness switch, and crashing env composition over it would be
# more disruptive than just not passing the flag).


def test_argv_omits_levels_flag_for_a_harness_with_no_level_selection():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["config-smoke"], "default", "dev",
                          full_base_env(), full_identities(cfg), cfg, levels=["C1"])
    assert "--levels" not in run.argv
    # The rest of the run still composes normally — this is a silent drop,
    # not a Blocked/exception.
    assert run.env["A_BEARER"] == "bearA"


def test_argv_omits_levels_flag_for_an_empty_selection():
    cfg = full_config()
    h = reg.HARNESSES["regression-smoke"]
    run = reg.compose_env(h, "google", "dev", full_base_env(), full_identities(cfg), cfg, levels=[])
    assert "--levels" not in run.argv


# =============================================================================
# MINOR-4: target-allowed-for-mode is checked BEFORE identity projection, so
# a wrong-target Blocked never computes (or shows) a login command built
# against the wrong host.
# =============================================================================


def test_target_checked_before_identity_projection(google_only_target):
    cfg = full_config()
    # Deliberately empty identities: if compose_env checked identity presence
    # first this would ALSO be Blocked, but with a login-command reason.
    for name, mode in (("ms-smoke", "default"), ("regression-smoke", "microsoft")):
        reason = expect_blocked(name, mode, google_only_target, full_base_env(), {}, cfg)
        assert "does not support target" in reason
        assert "mu-smoke-login.py" not in reason and "mint-token.py" not in reason




# =============================================================================
# MINOR-5: _resolve_slot validates google_primary names a real letter.
# =============================================================================


def test_blocked_google_primary_typo_names_config_as_the_cause():
    cfg = full_config(google_primary="d")
    reason = expect_blocked("regression-smoke", "google", "dev", full_base_env(), full_identities(cfg), cfg)
    assert "google_primary" in reason
    assert "config.toml" in reason
    assert "'d'" in reason


def test_google_primary_valid_letter_still_works():
    cfg = full_config(google_primary="c")
    run = reg.compose_env(reg.HARNESSES["regression-smoke"], "google", "dev",
                          full_base_env(), full_identities(cfg), cfg)
    assert run.env["SCHEDULER_BEARER"] == "bearC"


def test_blocked_microsoft_primary_typo_names_config_as_the_cause():
    cfg = full_config(microsoft_primary="d")
    reason = expect_blocked("regression-smoke", "microsoft", MICROSOFT_TARGET, full_base_env(), full_identities(cfg), cfg)
    assert "microsoft_primary" in reason
    assert "config.toml" in reason
    assert "'d'" in reason


def test_microsoft_primary_valid_letter_still_works():
    cfg = full_config(microsoft_primary="b")
    run = reg.compose_env(reg.HARNESSES["regression-smoke"], "microsoft", MICROSOFT_TARGET,
                          full_base_env(), full_identities(cfg), cfg)
    assert run.env["SCHEDULER_BEARER"] == "bearMSB"


# =============================================================================
# Provider axis: Mode.provider, Target.providers, and the target-hosts-
# provider gate — internal design notes Decision 1/8, WP1.3.
# =============================================================================


def test_targets_declare_hosted_providers():
    assert {name: t.providers for name, t in reg.TARGETS.items()} == EXPECTED_PROVIDERS


def test_provider_gate_blocks_a_target_that_does_not_host_the_mode_provider(google_only_target):
    # Synthetic harness: its mode's own `targets` tuple names a target wider
    # than what actually hosts the provider (the real registry never does
    # this — every microsoft mode targets only Microsoft-hosting targets —
    # but the gate has to catch it independently of the targets check, since
    # a future mode could widen `targets` without the provider actually being
    # hosted there yet).
    cfg = full_config()
    harness = reg.Harness(
        name="synthetic-ms-mode",
        script="bin/synthetic.py",
        modes=(reg.Mode(name="only", identities={"A": "microsoft:a"},
                        targets=(google_only_target, MICROSOFT_TARGET), provider="microsoft"),),
    )
    with pytest.raises(reg.Blocked) as ei:
        reg.compose_env(harness, "only", google_only_target, full_base_env(), full_identities(cfg), cfg)
    assert "does not host provider" in ei.value.reason
    assert "microsoft" in ei.value.reason
    # No login command computed — the gate fires before identity projection.
    assert "mu-smoke-login.py" not in ei.value.reason
    assert ei.value.advisory is False


def test_provider_gate_allows_a_target_that_hosts_the_provider(google_only_target):
    cfg = full_config()
    harness = reg.Harness(
        name="synthetic-ms-mode",
        script="bin/synthetic.py",
        modes=(reg.Mode(name="only", identities={"A": "microsoft:a"},
                        targets=(google_only_target, MICROSOFT_TARGET), provider="microsoft"),),
    )
    run = reg.compose_env(harness, "only", MICROSOFT_TARGET, full_base_env(), full_identities(cfg), cfg)
    assert run.env["A_BEARER"] == "bearMSA"


def test_provider_agnostic_mode_never_hits_the_provider_gate():
    # Mode.provider=None stays a supported shape (no registered harness
    # uses it since 2026-09-17, when config/engine-smoke gained providers)
    # — the gate must not apply even though dev doesn't "host" None.
    cfg = full_config()
    agnostic = reg.Harness(name="agnostic", script="bin/agnostic.py", modes=(
        reg.Mode(name="default", identities={"A": "google:a"}, targets=("dev",)),
    ))
    run = reg.compose_env(agnostic, "default", "dev", full_base_env(), full_identities(cfg), cfg)
    assert run.env["A_BEARER"] == "bearA"


# =============================================================================
# provider_flag — compose_env appends [provider_flag, mode.provider] to argv
# for harnesses that declare one; regression-smoke/reset-smoke-env keep their
# explicit --provider in Mode.args and provider_flag=None.
# =============================================================================


def test_poll_smoke_microsoft_mode_argv_carries_provider_flag():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["poll-smoke"], "microsoft", MICROSOFT_TARGET,
                          full_base_env(), full_identities(cfg), cfg)
    assert run.argv.count("--provider") == 1
    assert run.argv[run.argv.index("--provider") + 1] == "microsoft"


def test_feed_smoke_modes_carry_provider_flag_and_default_runs_where_microsoft_does():
    """2026-09-17: bin/feed-smoke.py takes --provider (the busy feed reads
    the owner's calendar through the worker's provider abstraction, and the
    F2 hold is created through the matching client), so the registry
    appends it, adds a microsoft mode, and lets the google mode run on the
    Microsoft target too (which hosts google and has CALENDAR_FEED_ENABLED)."""
    h = reg.HARNESSES["feed-smoke"]
    assert h.provider_flag == "--provider"
    assert [m.name for m in h.modes] == ["default", "microsoft"]
    assert reg._find_mode(h, "default").targets == SHARED_TARGETS
    ms = reg._find_mode(h, "microsoft")
    assert ms.provider == "microsoft" and ms.identities == {"A": "microsoft:a"} and ms.targets == (MICROSOFT_TARGET,)
    cfg = full_config()
    run = reg.compose_env(h, "microsoft", MICROSOFT_TARGET, full_base_env(), full_identities(cfg), cfg)
    assert run.env["A_BEARER"] == "bearMSA"
    assert run.argv[run.argv.index("--provider") + 1] == "microsoft"
    run = reg.compose_env(h, "default", MICROSOFT_TARGET, full_base_env(), full_identities(cfg), cfg)
    assert run.env["A_BEARER"] == "bearA"
    assert run.argv[run.argv.index("--provider") + 1] == "google"


def test_poll_smoke_default_mode_argv_carries_google_provider_flag():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["poll-smoke"], "default", "dev",
                          full_base_env(), full_identities(cfg), cfg)
    assert run.argv.count("--provider") == 1
    assert run.argv[run.argv.index("--provider") + 1] == "google"


def test_multiuser_smoke_microsoft_mode_argv_carries_provider_flag():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["multiuser-smoke"], "microsoft", MICROSOFT_TARGET,
                          full_base_env(), full_identities(cfg), cfg)
    assert run.argv.count("--provider") == 1
    assert run.argv[run.argv.index("--provider") + 1] == "microsoft"
    assert run.env["A_BEARER"] == "bearMSA"
    assert run.env["B_BEARER"] == "bearMSB"


def test_meeting_smoke_microsoft_2_account_mode_argv_and_env():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["meeting-smoke"], "microsoft-2-account", MICROSOFT_TARGET,
                          full_base_env(), full_identities(cfg), cfg)
    # WP4: bin/meeting-smoke.py now accepts --provider — see
    # test_meeting_smoke_provider_flag_is_set below.
    assert run.argv.count("--provider") == 1
    assert run.argv[run.argv.index("--provider") + 1] == "microsoft"
    assert run.env["B_BEARER"] == "bearMSB"
    assert run.env["C_BEARER"] == "bearMSC"
    assert "A_BEARER" not in run.env
    assert "--accounts" in run.argv and "2" in run.argv


def test_meeting_smoke_microsoft_3_account_mode_argv_and_env():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["meeting-smoke"], "microsoft-3-account", MICROSOFT_TARGET,
                          full_base_env(), full_identities(cfg), cfg)
    assert run.argv.count("--provider") == 1
    assert run.argv[run.argv.index("--provider") + 1] == "microsoft"
    assert run.env["A_BEARER"] == "bearMSA"
    assert run.env["B_BEARER"] == "bearMSB"
    assert run.env["C_BEARER"] == "bearMSC"
    assert "--accounts" in run.argv and "3" in run.argv


def test_meeting_smoke_provider_flag_is_set():
    # WP4: bin/meeting-smoke.py now accepts --provider, so provider_flag is
    # set (previously None pending this wave — see the fix-pass commit
    # history for the prior "pending WP4" test this replaces).
    assert reg.HARNESSES["meeting-smoke"].provider_flag == "--provider"


def test_meeting_smoke_google_modes_argv_has_provider_flag():
    cfg = full_config()
    for mode_name, target in (("2-account", "dev"), ("3-account", "dev")):
        run = reg.compose_env(reg.HARNESSES["meeting-smoke"], mode_name, target,
                              full_base_env(), full_identities(cfg), cfg)
        assert run.argv.count("--provider") == 1, (mode_name, run.argv)
        assert run.argv[run.argv.index("--provider") + 1] == "google", (mode_name, run.argv)


def test_multiuser_and_poll_smoke_still_carry_provider_flag_in_argv():
    # Contrast with meeting-smoke above: multiuser-smoke and poll-smoke's
    # scripts DO already accept --provider (WP3/WP2 respectively, landed
    # elsewhere on this integration branch), so their provider_flag stays set.
    cfg = full_config()
    run_mu = reg.compose_env(reg.HARNESSES["multiuser-smoke"], "microsoft", MICROSOFT_TARGET,
                             full_base_env(), full_identities(cfg), cfg)
    assert "--provider" in run_mu.argv
    run_poll = reg.compose_env(reg.HARNESSES["poll-smoke"], "microsoft", MICROSOFT_TARGET,
                               full_base_env(), full_identities(cfg), cfg)
    assert "--provider" in run_poll.argv


def test_meeting_smoke_microsoft_modes_carry_the_work_tenant_advisory():
    h = reg.HARNESSES["meeting-smoke"]
    for mode_name in ("microsoft-2-account", "microsoft-3-account"):
        mode = next(m for m in h.modes if m.name == mode_name)
        assert any("work tenant" in a.lower() for a in mode.advisories), mode_name
        assert any("freebusy" in a.lower() for a in mode.advisories), mode_name


def test_meeting_smoke_google_modes_carry_no_advisory():
    h = reg.HARNESSES["meeting-smoke"]
    for mode_name in ("2-account", "3-account"):
        mode = next(m for m in h.modes if m.name == mode_name)
        assert mode.advisories == ()


def test_multiuser_smoke_microsoft_mode_carries_m6_advisory():
    # M6 (accept/multiplan) is gated on ms-smoke step 4 being green — the
    # microsoft mode should carry an advisory to deselect it until that's
    # confirmed. The default (google) mode carries no such advisory.
    h = reg.HARNESSES["multiuser-smoke"]
    ms_mode = next(m for m in h.modes if m.name == "microsoft")
    assert any("m6" in a.lower() and "step 4" in a.lower() for a in ms_mode.advisories)
    default_mode = next(m for m in h.modes if m.name == "default")
    assert default_mode.advisories == ()


def test_regression_and_reset_keep_explicit_provider_arg_no_flag_duplication():
    # These two harnesses put --provider in Mode.args directly (unchanged);
    # provider_flag stays None so compose_env never adds a second one.
    cfg = full_config()
    for harness_name, mode_name, target in (
        ("regression-smoke", "google", "dev"),
        ("regression-smoke", "microsoft", MICROSOFT_TARGET),
        ("reset-smoke-env", "google", "dev"),
        ("reset-smoke-env", "microsoft", MICROSOFT_TARGET),
    ):
        run = reg.compose_env(reg.HARNESSES[harness_name], mode_name, target,
                              full_base_env(), full_identities(cfg), cfg)
        assert run.argv.count("--provider") == 1, (harness_name, mode_name, run.argv)


def test_provider_flag_never_appears_for_a_provider_agnostic_mode(monkeypatch):
    # Belt-and-braces over the whole registry: no harness/mode should ever
    # emit --provider when its Mode.provider is None, and no harness/mode
    # should ever emit it more than once.
    monkeypatch.setattr(reg, "_today", lambda: date(2024, 1, 4))  # Thursday — poll-smoke's gate
    cfg = full_config()
    identities = full_identities(cfg)
    for harness in reg.HARNESSES.values():
        for mode in harness.modes:
            target = mode.targets[0]
            run = reg.compose_env(harness, mode.name, target, full_base_env(), identities, cfg)
            count = run.argv.count("--provider")
            assert count <= 1, (harness.name, mode.name, run.argv)
            if mode.provider is None:
                assert count == 0, (harness.name, mode.name, run.argv)


# =============================================================================
# Registry invariants — data tests over every harness/mode, like the audited-
# facts tests above (internal design notes WP1.3 point 9).
# =============================================================================


def test_invariant_mode_provider_matches_all_its_identity_slots():
    # A sentinel (reg._GOOGLE_PRIMARY_SENTINEL / reg._MICROSOFT_PRIMARY_SENTINEL)
    # counts as its own provider too — both are already formatted
    # "<provider>:primary", so splitting on ":" yields the right provider for
    # a sentinel with no special-casing, same as any concrete letter slot.
    assert reg._GOOGLE_PRIMARY_SENTINEL.split(":", 1)[0] == "google"
    assert reg._MICROSOFT_PRIMARY_SENTINEL.split(":", 1)[0] == "microsoft"
    for harness in reg.HARNESSES.values():
        for mode in harness.modes:
            if mode.provider is None:
                continue
            for prefix, slot_spec in mode.identities.items():
                provider_of_slot = slot_spec.split(":", 1)[0]
                assert provider_of_slot == mode.provider, (
                    harness.name, mode.name, prefix, slot_spec, mode.provider
                )


def test_invariant_microsoft_modes_target_only_microsoft_hosting_targets():
    hosting = {name for name, t in reg.TARGETS.items() if "microsoft" in t.providers}
    for harness in reg.HARNESSES.values():
        for mode in harness.modes:
            if mode.provider == "microsoft":
                assert set(mode.targets) <= hosting, (harness.name, mode.name, mode.targets)


def test_config_and_engine_smoke_modes_name_their_provider_and_carry_a_microsoft_mode():
    """Decision 8 amended 2026-09-17 (ruling: "anything that touches the
    provider at all should be able to run for either"): config-smoke and
    engine-smoke resolve, and a resolve writes chunk events onto the
    signed-in calendar — they DO touch the provider, they just never read
    it back. So every mode names its provider, the Google modes also run
    on the Microsoft target (which hosts google), and each harness gains a
    `microsoft` mode (microsoft:a there). Neither harness takes --provider: the bearer
    alone selects the calendar, so provider_flag stays None and argv is
    unchanged."""
    cfg = full_config()
    for name, google_modes in (("config-smoke", ("default",)), ("engine-smoke", ("auto", "fanout"))):
        h = reg.HARNESSES[name]
        assert h.provider_flag is None
        for mode in h.modes:
            assert mode.provider in ("google", "microsoft"), (name, mode.name)
        for mode_name in google_modes:
            m = reg._find_mode(h, mode_name)
            assert m.provider == "google"
            assert m.identities == {"A": "google:a"}
        ms = reg._find_mode(h, "microsoft")
        assert ms.provider == "microsoft"
        assert ms.identities == {"A": "microsoft:a"}
        assert ms.targets == (MICROSOFT_TARGET,)
        run = reg.compose_env(h, "microsoft", MICROSOFT_TARGET, full_base_env(), full_identities(cfg), cfg)
        assert run.env["A_BEARER"] == "bearMSA"
        assert run.env["A_EXPECTED_EMAIL"] == cfg.microsoft["a"]
        assert "--provider" not in run.argv
        assert_target_triple(run, MICROSOFT_TARGET)
    # The Google modes run on the Microsoft target too — except engine-smoke's
    # fanout, which needs SOLVER_ENGINE_FANOUT_MIN_CHUNKS="1" (dev-only override).
    assert reg._find_mode(reg.HARNESSES["config-smoke"], "default").targets == SHARED_TARGETS
    assert reg._find_mode(reg.HARNESSES["engine-smoke"], "auto").targets == SHARED_TARGETS
    assert reg._find_mode(reg.HARNESSES["engine-smoke"], "fanout").targets == ("dev",)
    run = reg.compose_env(reg.HARNESSES["config-smoke"], "default", MICROSOFT_TARGET,
                          full_base_env(), full_identities(cfg), cfg)
    assert run.env["A_BEARER"] == "bearA"


def test_invariant_every_harness_mode_declares_a_provider():
    for name, harness in reg.HARNESSES.items():
        for mode in harness.modes:
            assert mode.provider is not None, (name, mode.name)


# =============================================================================
# MINOR-6: advisories — the design's remaining two, plus poll's run_days.
# =============================================================================


def test_regression_smoke_advisory_recommends_reset_first():
    h = reg.HARNESSES["regression-smoke"]
    assert any("reset recommended" in a.lower() for a in h.advisories)


def test_multiuser_smoke_advisories_include_reset_and_m7_last():
    h = reg.HARNESSES["multiuser-smoke"]
    assert any("reset recommended" in a.lower() for a in h.advisories)
    assert any("m7" in a.lower() and "last" in a.lower() for a in h.advisories)


def test_poll_smoke_run_days_is_mon_thu():
    assert reg.HARNESSES["poll-smoke"].run_days == "mon-thu"


# =============================================================================
# Supplementary: Blocked.advisory — a typed marker WP4 can branch on instead
# of matching substrings of the free-form reason text.
# =============================================================================


def test_blocked_advisory_flag_true_for_the_mon_thu_gate(monkeypatch):
    monkeypatch.setattr(reg, "_today", lambda: date(2024, 1, 6))  # Saturday
    cfg = full_config()
    harness = reg.HARNESSES["poll-smoke"]
    with pytest.raises(reg.Blocked) as ei:
        reg.compose_env(harness, "default", "dev", full_base_env(), full_identities(cfg), cfg)
    assert ei.value.advisory is True


def test_blocked_advisory_flag_false_for_missing_identity():
    cfg = full_config()
    identities = full_identities(cfg)
    del identities["google:c"]
    harness = reg.HARNESSES["meeting-smoke"]
    with pytest.raises(reg.Blocked) as ei:
        reg.compose_env(harness, "3-account", "dev", full_base_env(), identities, cfg)
    assert ei.value.advisory is False


def test_blocked_advisory_flag_false_for_missing_secret():
    cfg = full_config()
    env = full_base_env()
    del env["TURNSTILE_SECRET_DEV"]
    harness = reg.HARNESSES["booking-smoke"]
    with pytest.raises(reg.Blocked) as ei:
        reg.compose_env(harness, "base", "dev", env, full_identities(cfg), cfg)
    assert ei.value.advisory is False


def test_blocked_advisory_flag_false_for_wrong_target(google_only_target):
    cfg = full_config()
    harness = reg.HARNESSES["ms-smoke"]
    with pytest.raises(reg.Blocked) as ei:
        reg.compose_env(harness, "default", google_only_target, full_base_env(), full_identities(cfg), cfg)
    assert ei.value.advisory is False


def test_poll_smoke_mon_thu_override_composes_without_advisory_block(monkeypatch):
    # Sanity: overriding the advisory produces a normal ComposedRun, not a
    # Blocked at all (advisory=True only ever appears on the raised path).
    monkeypatch.setattr(reg, "_today", lambda: date(2024, 1, 6))  # Saturday
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["poll-smoke"], "default", "dev",
                          full_base_env(), full_identities(cfg), cfg, override_run_day=True)
    assert run.env["POLL_SMOKE_ALLOW_ANY_DAY"] == "true"


# =============================================================================
# MINOR-10: the full hand-maintained required-env table, one entry per
# harness x mode (19 combos — every mode of every registered harness).
# Values come straight from each harness's own Env.from_environ/req() calls
# in source (audited during the WP1 review round), not from this registry's
# own code, so this test can't rubber-stamp a registry bug.
# =============================================================================

_REQUIRED_ENV_TABLE = [
    ("regression-smoke", "google", "dev",
     {"SCHEDULER_URL", "SCHEDULER_BEARER", "SCHEDULER_REFRESH_TOKEN", "D1_DATABASE_ID", "EXPECTED_TEST_ACCOUNT"}),
    ("regression-smoke", "microsoft", MICROSOFT_TARGET,
     {"SCHEDULER_URL", "SCHEDULER_BEARER", "SCHEDULER_REFRESH_TOKEN", "D1_DATABASE_ID", "EXPECTED_TEST_ACCOUNT"}),
    ("regression-smoke", "webhook-check", "dev",
     {"SCHEDULER_URL", "SCHEDULER_BEARER", "SCHEDULER_REFRESH_TOKEN", "D1_DATABASE_ID", "EXPECTED_TEST_ACCOUNT"}),
    ("regression-smoke", "feed-check", "dev",
     {"SCHEDULER_URL", "SCHEDULER_BEARER", "SCHEDULER_REFRESH_TOKEN", "D1_DATABASE_ID", "EXPECTED_TEST_ACCOUNT"}),
    ("reset-smoke-env", "google", "dev",
     {"SCHEDULER_URL", "EXPECTED_TEST_ACCOUNT", "SCHEDULER_BEARER", "SCHEDULER_REFRESH_TOKEN"}),
    ("reset-smoke-env", "microsoft", MICROSOFT_TARGET,
     {"SCHEDULER_URL", "EXPECTED_TEST_ACCOUNT", "SCHEDULER_BEARER", "SCHEDULER_REFRESH_TOKEN"}),
    ("multiuser-smoke", "default", "dev",
     {"SCHEDULER_URL", "D1_DATABASE_ID", "A_BEARER", "A_REFRESH", "A_EXPECTED_EMAIL",
      "B_BEARER", "B_REFRESH", "B_EXPECTED_EMAIL"}),
    ("multiuser-smoke", "microsoft", MICROSOFT_TARGET,
     # Same env-var shape as "default" — project_identity is provider-
     # agnostic, only the identity SOURCE (microsoft:a/b) differs.
     {"SCHEDULER_URL", "D1_DATABASE_ID", "A_BEARER", "A_REFRESH", "A_EXPECTED_EMAIL",
      "B_BEARER", "B_REFRESH", "B_EXPECTED_EMAIL"}),
    ("meeting-smoke", "2-account", "dev",
     {"SCHEDULER_URL", "D1_DATABASE_ID", "B_BEARER", "B_REFRESH", "B_EXPECTED_EMAIL",
      "C_BEARER", "C_REFRESH", "C_EXPECTED_EMAIL"}),
    ("meeting-smoke", "3-account", "dev",
     {"SCHEDULER_URL", "D1_DATABASE_ID", "A_BEARER", "A_REFRESH", "A_EXPECTED_EMAIL",
      "B_BEARER", "B_REFRESH", "B_EXPECTED_EMAIL", "C_BEARER", "C_REFRESH", "C_EXPECTED_EMAIL"}),
    ("meeting-smoke", "microsoft-2-account", MICROSOFT_TARGET,
     {"SCHEDULER_URL", "D1_DATABASE_ID", "B_BEARER", "B_REFRESH", "B_EXPECTED_EMAIL",
      "C_BEARER", "C_REFRESH", "C_EXPECTED_EMAIL"}),
    ("meeting-smoke", "microsoft-3-account", MICROSOFT_TARGET,
     {"SCHEDULER_URL", "D1_DATABASE_ID", "A_BEARER", "A_REFRESH", "A_EXPECTED_EMAIL",
      "B_BEARER", "B_REFRESH", "B_EXPECTED_EMAIL", "C_BEARER", "C_REFRESH", "C_EXPECTED_EMAIL"}),
    ("booking-smoke", "base", "dev",
     {"SCHEDULER_URL", "TURNSTILE_SECRET_DEV", "A_BEARER", "A_REFRESH", "A_EXPECTED_EMAIL"}),
    ("booking-smoke", "decline", "dev",
     {"SCHEDULER_URL", "TURNSTILE_SECRET_DEV", "D1_DATABASE_ID",
      "A_BEARER", "A_REFRESH", "A_EXPECTED_EMAIL", "C_BEARER", "C_REFRESH", "C_EXPECTED_EMAIL"}),
    ("booking-smoke", "microsoft-base", MICROSOFT_TARGET,
     {"SCHEDULER_URL", MICROSOFT_TURNSTILE_VAR, "A_BEARER", "A_REFRESH", "A_EXPECTED_EMAIL"}),
    ("booking-smoke", "microsoft-decline", MICROSOFT_TARGET,
     {"SCHEDULER_URL", MICROSOFT_TURNSTILE_VAR, "D1_DATABASE_ID",
      "A_BEARER", "A_REFRESH", "A_EXPECTED_EMAIL", "C_BEARER", "C_REFRESH", "C_EXPECTED_EMAIL"}),
    ("config-smoke", "default", "dev",
     {"SCHEDULER_URL", "A_BEARER", "A_REFRESH", "A_EXPECTED_EMAIL"}),
    ("config-smoke", "microsoft", MICROSOFT_TARGET,
     {"SCHEDULER_URL", "A_BEARER", "A_REFRESH", "A_EXPECTED_EMAIL"}),
    ("engine-smoke", "auto", "dev",
     {"SCHEDULER_URL", "D1_DATABASE_ID", "A_BEARER", "A_REFRESH", "A_EXPECTED_EMAIL"}),
    ("engine-smoke", "fanout", "dev",
     {"SCHEDULER_URL", "D1_DATABASE_ID", "A_BEARER", "A_REFRESH", "A_EXPECTED_EMAIL"}),
    ("engine-smoke", "microsoft", MICROSOFT_TARGET,
     {"SCHEDULER_URL", "D1_DATABASE_ID", "A_BEARER", "A_REFRESH", "A_EXPECTED_EMAIL"}),
    ("feed-smoke", "default", "dev",
     {"SCHEDULER_URL", "A_BEARER", "A_REFRESH", "A_EXPECTED_EMAIL"}),
    ("feed-smoke", "microsoft", MICROSOFT_TARGET,
     {"SCHEDULER_URL", "A_BEARER", "A_REFRESH", "A_EXPECTED_EMAIL"}),
    ("poll-smoke", "default", "dev",
     {"SCHEDULER_URL", "A_BEARER", "A_REFRESH", "A_EXPECTED_EMAIL", "INVITEE_A_EMAIL", "INVITEE_B_EMAIL"}),
    ("poll-smoke", "microsoft", MICROSOFT_TARGET,
     # [poll].invitee_a/b stay Gmail-mailbox emails for both modes — unchanged.
     {"SCHEDULER_URL", "A_BEARER", "A_REFRESH", "A_EXPECTED_EMAIL", "INVITEE_A_EMAIL", "INVITEE_B_EMAIL"}),
    ("ms-smoke", "default", MICROSOFT_TARGET,
     # Default levels "1,2,3,4,5,6" include 5 and 6, so D1_DATABASE_ID and
     # MS2_ATTENDEE_EMAIL are both effectively required for the default run.
     {"SCHEDULER_URL", "SCHEDULER_BEARER", "SCHEDULER_REFRESH_TOKEN", "EXPECTED_TEST_ACCOUNT",
      "D1_DATABASE_ID", "MS2_ATTENDEE_EMAIL"}),
]


def test_required_env_table_covers_every_harness_mode_combo():
    # 26 harness x mode combos — one per registered Mode across all ten
    # harnesses (regression x4, reset x2, multiuser x2, meeting x4,
    # booking x4, config x2, engine x3, feed x2, poll x2, ms-smoke x1). The
    # provider axis (WP1.3) added multiuser's "microsoft" and meeting's
    # "microsoft-2-account"/"microsoft-3-account" and poll's "microsoft";
    # 2026-09-17 added config's, engine's and feed's "microsoft" and
    # booking's "microsoft-base"/"microsoft-decline".
    all_combos = {(h.name, m.name) for h in reg.HARNESSES.values() for m in h.modes}
    table_combos = {(name, mode) for name, mode, _target, _req in _REQUIRED_ENV_TABLE}
    assert table_combos == all_combos
    assert len(_REQUIRED_ENV_TABLE) == 26


@pytest.mark.parametrize("harness_name,mode_name,target,required", _REQUIRED_ENV_TABLE)
def test_composed_env_contains_the_complete_required_set(harness_name, mode_name, target, required):
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES[harness_name], mode_name, target,
                          full_base_env(), full_identities(cfg), cfg)
    missing = required - set(run.env)
    assert not missing, f"{harness_name}/{mode_name}: missing {missing}"
    for key in required:
        assert run.env[key], f"{harness_name}/{mode_name}: {key} is present but empty"


# =============================================================================
# Ruling (c): login-command drift guard. Loads bin/_smoke_identity.py IN THE
# TEST ONLY (the layering rule that forbids _smoke_registry.py from importing
# it does not apply to tests) and asserts _login_command_for_slot produces
# byte-identical output to the real login_command across every valid slot,
# both targets, and a sparse-config case.
# =============================================================================

_identity_spec = importlib.util.spec_from_file_location("_smoke_identity", BIN / "_smoke_identity.py")
assert _identity_spec and _identity_spec.loader, "could not load _smoke_identity module"
identity_mod = importlib.util.module_from_spec(_identity_spec)
sys.modules[_identity_spec.name] = identity_mod
_identity_spec.loader.exec_module(identity_mod)

_ALL_SLOTS = ("google:a", "google:b", "google:c", "microsoft:a", "microsoft:b", "microsoft:c")
_ALL_TARGET_NAMES = SHARED_TARGETS


@pytest.mark.parametrize("slot", _ALL_SLOTS)
@pytest.mark.parametrize("target_name", _ALL_TARGET_NAMES)
def test_login_command_matches_smoke_identity_full_cast(slot, target_name):
    cfg = identity_mod.RunnerConfig(
        google={"a": "a@example.com", "b": "b@example.com", "c": "c@example.com"},
        google_primary="a",
        microsoft={"a": "msa@example.com", "b": "msb@example.com", "c": "msc@example.com"},
        microsoft_primary="a",
    )
    target_url = reg.TARGETS[target_name].scheduler_url
    assert reg._login_command_for_slot(slot, cfg, target_url) == identity_mod.login_command(slot, cfg, target_url)


@pytest.mark.parametrize("slot", ("google:a", "google:b", "google:c"))
def test_login_command_matches_smoke_identity_sparse_cast(slot):
    # Only letter "a" configured — exercises the flag-omission branch both
    # implementations share.
    cfg = identity_mod.RunnerConfig(google={"a": "a@example.com"}, google_primary="a")
    target_url = reg.TARGETS["dev"].scheduler_url
    assert reg._login_command_for_slot(slot, cfg, target_url) == identity_mod.login_command(slot, cfg, target_url)


@pytest.mark.parametrize("slot", ("microsoft:a", "microsoft:b", "microsoft:c"))
def test_login_command_matches_smoke_identity_microsoft_sparse_cast(slot):
    # Only letter "a" configured on the microsoft side — same flag-omission
    # branch as the Google sparse-cast test above, mirrored for Microsoft.
    cfg = identity_mod.RunnerConfig(microsoft={"a": "msa@example.com"}, microsoft_primary="a")
    target_url = reg.TARGETS[MICROSOFT_TARGET].scheduler_url
    assert reg._login_command_for_slot(slot, cfg, target_url) == identity_mod.login_command(slot, cfg, target_url)


def test_login_command_matches_smoke_identity_for_resolved_microsoft_primary_sentinel():
    # End-to-end: _resolve_slot("microsoft:primary", ...) picks the
    # configured letter, and the resulting slot's login command still
    # matches _smoke_identity's real implementation.
    cfg_registry = full_config(microsoft_primary="a")
    identity_cfg = identity_mod.RunnerConfig(microsoft={"a": "msa@example.com"}, microsoft_primary="a")
    resolved = reg._resolve_slot("microsoft:primary", cfg_registry)
    assert resolved == "microsoft:a"
    target_url = reg.TARGETS[MICROSOFT_TARGET].scheduler_url
    assert (reg._login_command_for_slot(resolved, identity_cfg, target_url)
            == identity_mod.login_command(resolved, identity_cfg, target_url))


# =============================================================================
# Review fix #2: _login_command_for_slot must letter-validate BOTH the
# google: and microsoft: branches, not just prefix-match — an UNRESOLVED
# sentinel ("google:primary"/"microsoft:primary" reaching this function
# directly, rather than through _resolve_slot first) must raise ValueError,
# which smoke-runner.py relies on catching (~1453/1466/1851). Mirrors
# wp1a's _smoke_identity.login_command exactly.
# =============================================================================


@pytest.mark.parametrize("slot", ("google:primary", "microsoft:primary"))
def test_login_command_for_slot_rejects_an_unresolved_primary_sentinel(slot):
    cfg = full_config()
    with pytest.raises(ValueError):
        reg._login_command_for_slot(slot, cfg, reg.TARGETS[MICROSOFT_TARGET].scheduler_url)


@pytest.mark.parametrize("slot", ("google:d", "microsoft:d", "google:", "microsoft:", "google:AB"))
def test_login_command_for_slot_rejects_a_non_letter_suffix(slot):
    cfg = full_config()
    with pytest.raises(ValueError):
        reg._login_command_for_slot(slot, cfg, reg.TARGETS[MICROSOFT_TARGET].scheduler_url)


@pytest.mark.parametrize("slot", ("google:primary", "microsoft:primary"))
def test_login_command_matches_smoke_identity_both_raise_on_unresolved_sentinel(slot):
    # Drift-guard parity: both implementations must refuse the SAME inputs,
    # not just agree on the ones that succeed.
    cfg = identity_mod.RunnerConfig(
        google={"a": "a@example.com", "b": "b@example.com", "c": "c@example.com"},
        google_primary="a",
        microsoft={"a": "msa@example.com", "b": "msb@example.com", "c": "msc@example.com"},
        microsoft_primary="a",
    )
    target_url = reg.TARGETS[MICROSOFT_TARGET].scheduler_url
    with pytest.raises(ValueError):
        reg._login_command_for_slot(slot, cfg, target_url)
    with pytest.raises(ValueError):
        identity_mod.login_command(slot, cfg, target_url)


# =============================================================================
# NIT-5 (for WP4): compose_env's extra_args, appended to argv after mode
# args — reset-smoke-env's flag-picker (--clear-all/--l6-current-week/
# --dry-run) rides this rather than Mode.args.
# =============================================================================


def test_extra_args_appended_after_mode_args():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["reset-smoke-env"], "google", "dev",
                          full_base_env(), full_identities(cfg), cfg,
                          extra_args=("--clear-all", "--dry-run"))
    assert run.argv == ("uv", "run", "bin/reset-smoke-env.py", "--provider", "google",
                        "--clear-all", "--dry-run")


def test_extra_args_defaults_to_empty():
    cfg = full_config()
    run = reg.compose_env(reg.HARNESSES["config-smoke"], "default", "dev",
                          full_base_env(), full_identities(cfg), cfg)
    assert run.argv == ("uv", "run", "bin/config-smoke.py")


# =============================================================================
# Token-destructive levels — metadata + split_token_destructive
# =============================================================================


def test_multiuser_m7_is_flagged_token_destructive():
    # M7 offboards B, which revokes B's OAuth tokens server-side — every
    # later run projecting B_* dies in preflight with a 400 on /oauth/token
    # until B is re-minted. The registry must say so declaratively.
    assert reg.HARNESSES["multiuser-smoke"].token_destructive_levels == ("7",)


def test_no_other_harness_flags_token_destructive_levels():
    # ms-smoke's level 5 is done-category (restores state), not an offboard;
    # nothing else revokes a token. If a new offboarding level appears, it
    # must be flagged — this test is the reminder to make that a decision.
    for name, harness in reg.HARNESSES.items():
        if name != "multiuser-smoke":
            assert harness.token_destructive_levels == (), name


def test_every_token_destructive_level_is_a_real_level():
    for name, harness in reg.HARNESSES.items():
        for lvl in harness.token_destructive_levels:
            assert lvl in harness.levels, f"{name}: {lvl!r} not in levels"


def test_split_default_levels_separates_m7():
    safe, destructive = reg.split_token_destructive(
        reg.HARNESSES["multiuser-smoke"], "default", None)
    assert safe == ("1", "2", "3", "4", "5", "6", "8")
    assert destructive == ("7",)


def test_split_explicit_subset_without_the_destructive_level():
    safe, destructive = reg.split_token_destructive(
        reg.HARNESSES["multiuser-smoke"], "default", ("1", "2"))
    assert safe == ("1", "2")
    assert destructive == ()


def test_split_destructive_only_selection():
    safe, destructive = reg.split_token_destructive(
        reg.HARNESSES["multiuser-smoke"], "default", ("7",))
    assert safe == ()
    assert destructive == ("7",)


def test_split_harness_without_level_concept_is_all_safe():
    safe, destructive = reg.split_token_destructive(
        reg.HARNESSES["config-smoke"], "default", None)
    assert safe == ()
    assert destructive == ()


def test_multiuser_advisory_mentions_token_destruction():
    h = reg.HARNESSES["multiuser-smoke"]
    assert any("token" in a.lower() for a in h.advisories)


def test_multiuser_advisory_does_not_hardcode_google_wording():
    # Review fix #3: the old text ("re-mint B after it runs") reads as
    # Google-specific even though the microsoft mode also destroys a B
    # identity's token (microsoft:b). The advisory text must stay provider-
    # neutral; the concrete slot comes from token_destructive_slots().
    h = reg.HARNESSES["multiuser-smoke"]
    m7_advisory = next(a for a in h.advisories if "m7" in a.lower())
    assert "re-mint b " not in m7_advisory.lower()
    assert "token_destructive_slots" in m7_advisory


# =============================================================================
# Review fix #3: token_destructive_prefixes + token_destructive_slots — the
# PUBLIC helper that maps a harness/mode's destructive identity PREFIXES
# (e.g. multiuser-smoke's "B") through that mode's own identities +
# _resolve_slot to the concrete slot(s) actually at risk. Nothing rendered
# the old comment's promise ("the runner substitutes the right slot") —
# this IS that substitution, for the TUI (WP1.5) to call.
# =============================================================================


def test_multiuser_smoke_token_destructive_prefix_is_b():
    assert reg.HARNESSES["multiuser-smoke"].token_destructive_prefixes == ("B",)


def test_no_other_harness_flags_token_destructive_prefixes():
    for name, harness in reg.HARNESSES.items():
        if name != "multiuser-smoke":
            assert harness.token_destructive_prefixes == (), name


def test_token_destructive_slots_multiuser_default_mode_is_google_b():
    cfg = full_config()
    h = reg.HARNESSES["multiuser-smoke"]
    assert reg.token_destructive_slots(h, "default", cfg) == ("google:b",)


def test_token_destructive_slots_multiuser_microsoft_mode_is_microsoft_b():
    cfg = full_config()
    h = reg.HARNESSES["multiuser-smoke"]
    assert reg.token_destructive_slots(h, "microsoft", cfg) == ("microsoft:b",)


def test_token_destructive_slots_empty_for_a_harness_with_no_destructive_prefixes():
    cfg = full_config()
    h = reg.HARNESSES["config-smoke"]
    assert reg.token_destructive_slots(h, "default", cfg) == ()


# =============================================================================
# Review fix #4: Mode.advisories is not purely inert — a missing-identity
# Blocked reason is prefixed with the mode's own advisories, so an
# operator hitting a Microsoft meeting-smoke mode with no work tenant sees
# WHY the identity is missing, not just a bare login-command hint.
# =============================================================================


def test_mode_advisories_prefix_a_missing_identity_blocked_reason():
    cfg = full_config()
    identities = full_identities(cfg)
    del identities["microsoft:c"]
    reason = expect_blocked("meeting-smoke", "microsoft-3-account", MICROSOFT_TARGET, full_base_env(), identities, cfg)
    assert "needs a work tenant" in reason
    assert "microsoft:c identity required" in reason


def test_mode_without_advisories_blocked_reason_is_unprefixed():
    # Sanity: a mode with no advisories (2-account's "() default) gets the
    # plain missing-identity message, same as before this fix.
    cfg = full_config()
    identities = full_identities(cfg)
    del identities["google:c"]
    reason = expect_blocked("meeting-smoke", "2-account", "dev", full_base_env(), identities, cfg)
    assert not reason.startswith("needs")
    assert reason.startswith("google:c identity required")


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))


# =============================================================================
# Target gating: harnesses whose behaviour touches email (meeting, poll,
# multiuser) run against the Microsoft target too — Google identities minted
# against that host, not Microsoft ones.
# =============================================================================

@pytest.mark.parametrize("name,mode", [
    ("multiuser-smoke", "default"),
    ("meeting-smoke", "2-account"),
    ("meeting-smoke", "3-account"),
    ("poll-smoke", "default"),
])
def test_email_harnesses_allow_the_microsoft_target(name, mode):
    h = reg.HARNESSES[name]
    mode_obj = next(m for m in h.modes if m.name == mode)
    assert mode_obj.targets == SHARED_TARGETS
    cfg = full_config()
    run = reg.compose_env(h, mode, MICROSOFT_TARGET, full_base_env(), full_identities(cfg), cfg)
    assert_target_triple(run, MICROSOFT_TARGET)
    # Still Google identities — projected as-is; the target's host is what
    # they were minted against, which the identity probe checks (smoke-runner).
    assert run.env.get("A_BEARER") == "bearA" or run.env.get("B_BEARER") == "bearB"


def test_every_harness_runs_on_the_microsoft_target_and_carries_a_microsoft_mode():
    """The 2026-09-17 ruling (operator): anything that touches the provider
    at all must run for either. Every registered harness now has at least
    one mode allowed on the Microsoft target and at least one mode naming
    microsoft — the list of dev-only harnesses this test used to pin is
    empty."""
    for name, h in reg.HARNESSES.items():
        assert any(MICROSOFT_TARGET in m.targets for m in h.modes), name
        assert any(m.provider == "microsoft" for m in h.modes), name
