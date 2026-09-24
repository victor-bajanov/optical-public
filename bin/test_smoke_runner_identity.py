# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest"]
# ///
"""Guard for bin/_smoke_identity.py: the env-seeded, in-memory identity model
that backs the unified smoke runner (internal design notes,
internal design notes WP2).

Covers: config load/save round-trips (incl. the poll-invitee derive-vs-set
distinction), env seeding (full/partial letter sets, SCHEDULER_* classification
and its collision-with-a-letter and unmatched-email cases), `*_MINTED_AT`
parsing, TTL countdown math at its edges, every `classify()` table row, the
`scrub_secrets` token-shape regexp, `probe_whoami`'s stdlib transport (network
seam monkeypatched — no live calls), and `login_command`'s exact copy-ready
strings.

Run: uv run bin/test_smoke_runner_identity.py
"""
from __future__ import annotations

import importlib.util
import io
import sys
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "smoke_identity", Path(__file__).parent / "_smoke_identity.py"
)
assert _spec and _spec.loader, "could not load _smoke_identity module"
ident = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = ident
_spec.loader.exec_module(ident)

# Bearer/refresh-shaped strings: exactly 43 chars of [A-Za-z0-9_-] (32 random
# bytes base64url, per worker/src/auth/tokens.ts:6-9).
TOKEN_A = "A" * 43
TOKEN_A_R = "a" * 43
TOKEN_B = "B" * 43
TOKEN_B_R = "b" * 43

NOW = datetime(2026, 9, 1, 12, 0, 0, tzinfo=timezone.utc)


def make_tokens(minted_at=None, email="a@example.com", slot="google:a"):
    return ident.IdentityTokens(
        slot=slot, bearer=TOKEN_A, refresh=TOKEN_A_R, email=email,
        client_id="smoke-cli", minted_at=minted_at,
    )


# =============================================================================
# Config paths — XDG_CONFIG_HOME / XDG_STATE_HOME with ~/.config, ~/.local/state
# fallbacks (design doc "Files on disk").
# =============================================================================


def test_config_path_respects_xdg_config_home(tmp_path):
    p = ident.config_path({"XDG_CONFIG_HOME": str(tmp_path)})
    assert p == tmp_path / "optical-smoke" / "config.toml"


def test_config_path_falls_back_to_home_config():
    p = ident.config_path({})
    assert p == Path.home() / ".config" / "optical-smoke" / "config.toml"


def test_state_dir_respects_xdg_state_home(tmp_path):
    d = ident.state_dir({"XDG_STATE_HOME": str(tmp_path)})
    assert d == tmp_path / "optical-smoke"


def test_state_dir_falls_back_to_home_local_state():
    d = ident.state_dir({})
    assert d == Path.home() / ".local" / "state" / "optical-smoke"


def test_module_level_config_path_and_state_dir_exist():
    # WP4 uses these directly (per the plan); confirm they're real Paths, not
    # None or strings.
    assert isinstance(ident.CONFIG_PATH, Path)
    assert isinstance(ident.STATE_DIR, Path)
    assert ident.CONFIG_PATH.name == "config.toml"


# =============================================================================
# Config: load / save / default / round-trip
# =============================================================================


def test_load_config_missing_file_returns_defaults(tmp_path):
    cfg = ident.load_config(tmp_path / "does-not-exist.toml")
    assert cfg == ident.default_config()


def test_default_config_values():
    cfg = ident.default_config()
    assert cfg.target == "dev"
    assert cfg.provider == "google"   # campaign provider axis (2026-09-17)
    assert cfg.google == {}
    assert cfg.google_primary == "a"
    assert cfg.microsoft == {}
    assert cfg.microsoft_primary == "a"   # a LETTER now, mirrors google_primary
    assert cfg.microsoft_attendee == ""
    assert cfg.poll_invitee_a_set == ""
    assert cfg.poll_invitee_b_set == ""
    assert cfg.poll_invitee_a == ""   # derived; google is empty too, so still ""
    assert cfg.poll_invitee_b == ""


def test_save_load_round_trip_full_config(tmp_path):
    path = tmp_path / "config.toml"
    cfg = ident.RunnerConfig(
        target="other-env",
        provider="microsoft",
        google={"a": "a@x.example", "b": "b@x.example", "c": "c@x.example"},
        google_primary="b",
        microsoft={"a": "ms.a@x.example", "b": "ms.b@x.example", "c": "ms.c@x.example"},
        microsoft_primary="b",
        microsoft_attendee="ms2@x.example",
        poll_invitee_a_set="b@x.example",
        poll_invitee_b_set="c@x.example",
    )
    ident.save_config(cfg, path)
    assert ident.load_config(path) == cfg


def test_save_load_round_trip_default_config(tmp_path):
    path = tmp_path / "config.toml"
    cfg = ident.default_config()
    ident.save_config(cfg, path)
    assert ident.load_config(path) == cfg


def test_save_load_round_trip_partial_google_letters(tmp_path):
    path = tmp_path / "config.toml"
    cfg = ident.RunnerConfig(google={"a": "a@x.example"})
    ident.save_config(cfg, path)
    loaded = ident.load_config(path)
    assert loaded == cfg
    assert loaded.google == {"a": "a@x.example"}


def test_save_config_emits_the_documented_toml_schema(tmp_path):
    """Full-text pin of the design doc's §Config file shape: every section,
    every key, in the exact order save_config writes them (not just a
    substring spot-check — a key silently dropped or reordered wouldn't have
    failed the old three-assertion version of this test)."""
    path = tmp_path / "config.toml"
    cfg = ident.RunnerConfig(
        target="dev",
        google={"a": "a@x.example", "b": "b@x.example", "c": "c@x.example"},
        google_primary="a",
        microsoft={"a": "ms.a@x.example", "b": "ms.b@x.example", "c": "ms.c@x.example"},
        microsoft_primary="a",
        microsoft_attendee="ms2@x.example",
        poll_invitee_a_set="b@x.example",
        poll_invitee_b_set="c@x.example",
    )
    ident.save_config(cfg, path)
    text = path.read_text()
    assert text == (
        '[defaults]\n'
        'target = "dev"\n'
        'provider = "google"\n'
        '\n'
        '[google]\n'
        'a = "a@x.example"\n'
        'b = "b@x.example"\n'
        'c = "c@x.example"\n'
        'primary = "a"\n'
        '\n'
        '[microsoft]\n'
        'a = "ms.a@x.example"\n'
        'b = "ms.b@x.example"\n'
        'c = "ms.c@x.example"\n'
        'primary = "a"\n'
        'attendee = "ms2@x.example"\n'
        '\n'
        '[poll]\n'
        'invitee_a = "b@x.example"\n'
        'invitee_b = "c@x.example"\n'
    )


def test_save_config_emits_partial_google_and_no_poll_section(tmp_path):
    """The other end of the shape: missing google letters absent, no [poll]
    section at all when neither invitee was explicitly set."""
    path = tmp_path / "config.toml"
    cfg = ident.RunnerConfig(google={"a": "a@x.example"})
    ident.save_config(cfg, path)
    text = path.read_text()
    assert text == (
        '[defaults]\n'
        'target = "dev"\n'
        'provider = "google"\n'
        '\n'
        '[google]\n'
        'a = "a@x.example"\n'
        'primary = "a"\n'
        '\n'
        '[microsoft]\n'
        'primary = "a"\n'
        'attendee = ""\n'
    )


def test_load_config_malformed_toml_raises_value_error_naming_path(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text("this is not [valid toml")
    with pytest.raises(ValueError) as exc:
        ident.load_config(path)
    assert str(path) in str(exc.value)


def test_load_config_non_string_google_value_raises_value_error_naming_path(tmp_path):
    # MINOR M4 (Opus review): hand-editing config.toml is a first-class flow
    # — a wrong-typed value (e.g. a bare number instead of a quoted email)
    # must fail the same way malformed TOML does, not crash somewhere deep
    # inside seed_identities/classify with an unhelpful AttributeError.
    path = tmp_path / "config.toml"
    path.write_text('[defaults]\ntarget = "dev"\n\n[google]\na = 5\n')
    with pytest.raises(ValueError) as exc:
        ident.load_config(path)
    assert str(path) in str(exc.value)


def test_load_config_non_string_microsoft_primary_raises_value_error(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text('[microsoft]\nprimary = 12345\n')
    with pytest.raises(ValueError) as exc:
        ident.load_config(path)
    assert str(path) in str(exc.value)


# --- legacy [microsoft].primary = "<email>" migration ----------------------
#
# Decision 2 (internal design notes): Microsoft grows
# letter-indexed accounts mirroring [google]. The pre-existing
# `[microsoft].primary = "<email>"` form (an @ value) stays READABLE:
# load_config maps it onto letter "a" and microsoft_primary == "a" — UNLESS
# [microsoft].a is ALSO explicitly set to a different value, in which case
# the explicit letter wins (RULING: explicit [microsoft].a beats a legacy
# email-shaped primary). save_config never WRITES the legacy form again.


def test_load_config_legacy_microsoft_primary_email_maps_to_letter_a(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text('[microsoft]\nprimary = "ms.test@dev-tenant.example"\n')
    cfg = ident.load_config(path)
    assert cfg.microsoft == {"a": "ms.test@dev-tenant.example"}
    assert cfg.microsoft_primary == "a"


def test_load_config_legacy_microsoft_primary_email_does_not_override_explicit_a(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text(
        '[microsoft]\na = "explicit@x.example"\nprimary = "legacy@x.example"\n'
    )
    cfg = ident.load_config(path)
    # RULING: the explicit [microsoft].a wins over the legacy email-shaped
    # primary — the legacy value is discarded, not merged in some other way.
    assert cfg.microsoft == {"a": "explicit@x.example"}
    assert cfg.microsoft_primary == "a"


def test_load_config_legacy_microsoft_primary_email_with_explicit_b_and_c(tmp_path):
    # NIT (Opus review): the legacy branch only ever touches letter "a" — b
    # and c, if explicitly configured, must survive untouched alongside the
    # legacy email landing on "a".
    path = tmp_path / "config.toml"
    path.write_text(
        '[microsoft]\nb = "b@x.example"\nc = "c@x.example"\nprimary = "legacy@x.example"\n'
    )
    cfg = ident.load_config(path)
    assert cfg.microsoft == {
        "a": "legacy@x.example", "b": "b@x.example", "c": "c@x.example",
    }
    assert cfg.microsoft_primary == "a"


def test_load_config_letter_shaped_microsoft_primary_is_unaffected_by_legacy_path(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text(
        '[microsoft]\na = "a@x.example"\nb = "b@x.example"\nprimary = "b"\n'
    )
    cfg = ident.load_config(path)
    assert cfg.microsoft == {"a": "a@x.example", "b": "b@x.example"}
    assert cfg.microsoft_primary == "b"


def test_load_config_blank_microsoft_primary_defaults_to_letter_a(tmp_path):
    # REVIEW FIX (Opus review): an explicit but blank `primary = ""` must
    # default to "a" like an absent primary key does — not load as the
    # empty string, which would later make mint-token's
    # resolve_expected_email(cfg, "microsoft") raise ValueError("expected
    # one of a/b/c") instead of quietly returning None.
    path = tmp_path / "config.toml"
    path.write_text('[microsoft]\nprimary = ""\n')
    cfg = ident.load_config(path)
    assert cfg.microsoft_primary == "a"


def test_save_config_never_writes_the_legacy_email_primary_form(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text('[microsoft]\nprimary = "ms.test@dev-tenant.example"\n')
    cfg = ident.load_config(path)
    resaved = tmp_path / "resaved.toml"
    ident.save_config(cfg, resaved)
    text = resaved.read_text()
    assert 'primary = "a"' in text
    assert 'a = "ms.test@dev-tenant.example"' in text
    # primary is always a bare letter now, never an email.
    assert 'primary = "ms.test@dev-tenant.example"' not in text


# --- save_config normalizes a HAND-BUILT (not load_config-produced)
# RunnerConfig, too --------------------------------------------------------
#
# SHOULD-FIX (Opus review): the letter invariant used to live only in
# load_config — save_config wrote cfg.microsoft_primary verbatim, so a
# hand-built RunnerConfig (constructed directly, never round-tripped
# through load_config) with an email-shaped primary would write the legacy
# form the docs promise is never written.


def test_save_config_normalizes_email_shaped_primary_when_a_is_empty(tmp_path):
    path = tmp_path / "config.toml"
    cfg = ident.RunnerConfig(microsoft_primary="hand.built@x.example")
    ident.save_config(cfg, path)
    text = path.read_text()
    assert 'primary = "a"' in text
    assert 'a = "hand.built@x.example"' in text
    assert 'primary = "hand.built@x.example"' not in text
    # Round-trips cleanly through load_config afterwards.
    loaded = ident.load_config(path)
    assert loaded.microsoft == {"a": "hand.built@x.example"}
    assert loaded.microsoft_primary == "a"


def test_save_config_email_shaped_primary_does_not_override_explicit_a(tmp_path):
    path = tmp_path / "config.toml"
    cfg = ident.RunnerConfig(
        microsoft={"a": "explicit@x.example"}, microsoft_primary="legacy@x.example",
    )
    ident.save_config(cfg, path)
    text = path.read_text()
    assert 'a = "explicit@x.example"' in text
    assert 'primary = "a"' in text
    assert "legacy@x.example" not in text


def test_save_config_raises_on_non_letter_non_email_primary(tmp_path):
    path = tmp_path / "config.toml"
    cfg = ident.RunnerConfig(microsoft_primary="not-a-letter-or-email")
    with pytest.raises(ValueError) as exc:
        ident.save_config(cfg, path)
    assert "microsoft_primary" in str(exc.value)


def test_save_config_letter_shaped_primary_passes_through_unchanged(tmp_path):
    path = tmp_path / "config.toml"
    cfg = ident.RunnerConfig(microsoft={"b": "b@x.example"}, microsoft_primary="b")
    ident.save_config(cfg, path)
    text = path.read_text()
    assert 'primary = "b"' in text


# --- poll invitees: derive-at-read vs baked-in-at-save ----------------------
#
# BLOCKING B1 (Opus review): the duck-type contract WP1 consumes is that
# cfg.poll_invitee_a/cfg.poll_invitee_b ARE the set-value-else-derived
# result — not a separately-named "effective_*" accessor. The raw stored
# value (what the operator actually typed, or "" if nothing) lives under
# poll_invitee_a_set/poll_invitee_b_set instead, which is what save_config
# reads to decide what to write.


def test_poll_invitee_a_is_the_derived_contract_attribute():
    # This is the exact case B1 flags: only [google] b/c configured, nothing
    # under [poll] — cfg.poll_invitee_a (the attribute WP1's compose_env
    # reads) must be google.b's email, not "".
    cfg = ident.RunnerConfig(google={"b": "b@x.example", "c": "c@x.example"})
    assert cfg.poll_invitee_a_set == ""  # nothing was explicitly set
    assert cfg.poll_invitee_a == "b@x.example"   # but the contract attribute IS derived
    assert cfg.poll_invitee_b == "c@x.example"


def test_poll_invitee_explicit_value_is_not_overridden_by_derivation():
    cfg = ident.RunnerConfig(google={"b": "b@x.example"}, poll_invitee_a_set="other@x.example")
    assert cfg.poll_invitee_a == "other@x.example"


def test_save_config_does_not_bake_in_derived_poll_invitees(tmp_path):
    path = tmp_path / "config.toml"
    cfg = ident.RunnerConfig(google={"b": "b@x.example", "c": "c@x.example"})  # poll unset
    ident.save_config(cfg, path)
    text = path.read_text()
    assert "[poll]" not in text  # derived values must not be written as if set
    loaded = ident.load_config(path)
    assert loaded.poll_invitee_a_set == ""
    assert loaded.poll_invitee_a == "b@x.example"  # still derives correctly on reload


def test_save_config_preserves_an_explicitly_set_poll_invitee(tmp_path):
    path = tmp_path / "config.toml"
    cfg = ident.RunnerConfig(
        google={"b": "b@x.example"}, poll_invitee_a_set="explicit@x.example",
    )
    ident.save_config(cfg, path)
    loaded = ident.load_config(path)
    assert loaded.poll_invitee_a_set == "explicit@x.example"
    assert loaded.poll_invitee_a == "explicit@x.example"


# =============================================================================
# parse_minted_at
# =============================================================================


def test_parse_minted_at_valid_iso_with_offset():
    dt = ident.parse_minted_at("2026-09-01T10:00:00+00:00")
    assert dt == datetime(2026, 9, 1, 10, 0, 0, tzinfo=timezone.utc)


def test_parse_minted_at_valid_iso_with_z_suffix():
    dt = ident.parse_minted_at("2026-09-01T10:00:00Z")
    assert dt == datetime(2026, 9, 1, 10, 0, 0, tzinfo=timezone.utc)


def test_parse_minted_at_none_returns_none():
    assert ident.parse_minted_at(None) is None


def test_parse_minted_at_empty_string_returns_none():
    assert ident.parse_minted_at("") is None


def test_parse_minted_at_garbage_returns_none_not_raise():
    assert ident.parse_minted_at("definitely-not-a-date") is None


# =============================================================================
# seed_identities
# =============================================================================


def test_seed_identities_empty_environ_returns_nothing():
    report = ident.seed_identities({}, ident.default_config())
    assert report.identities == {}
    assert report.partial == {}
    assert report.warnings == ()


def test_seed_identities_full_letter_set():
    environ = {
        "A_BEARER": TOKEN_A, "A_REFRESH": TOKEN_A_R, "A_EXPECTED_EMAIL": "a@x.example",
    }
    report = ident.seed_identities(environ, ident.default_config())
    assert set(report.identities) == {"google:a"}
    tok = report.identities["google:a"]
    assert tok.slot == "google:a"
    assert tok.bearer == TOKEN_A
    assert tok.refresh == TOKEN_A_R
    assert tok.email == "a@x.example"
    assert tok.client_id == "smoke-cli"
    assert tok.minted_at is None
    assert report.partial == {}


def test_seed_identities_full_letter_set_with_client_id_and_minted_at():
    environ = {
        "C_BEARER": TOKEN_A, "C_REFRESH": TOKEN_A_R, "C_EXPECTED_EMAIL": "c@x.example",
        "C_CLIENT_ID": "other-client", "C_MINTED_AT": "2026-09-01T10:00:00Z",
    }
    report = ident.seed_identities(environ, ident.default_config())
    tok = report.identities["google:c"]
    assert tok.client_id == "other-client"
    assert tok.minted_at == datetime(2026, 9, 1, 10, 0, 0, tzinfo=timezone.utc)


def test_seed_identities_partial_set_bearer_without_refresh_not_seeded():
    environ = {"B_BEARER": TOKEN_B, "B_EXPECTED_EMAIL": "b@x.example"}
    report = ident.seed_identities(environ, ident.default_config())
    assert report.identities == {}
    assert "google:b" in report.partial
    assert "B_REFRESH" in report.partial["google:b"]


def test_seed_identities_partial_set_refresh_without_bearer_not_seeded():
    environ = {"B_REFRESH": TOKEN_B_R, "B_EXPECTED_EMAIL": "b@x.example"}
    report = ident.seed_identities(environ, ident.default_config())
    assert report.identities == {}
    assert "B_BEARER" in report.partial["google:b"]


def test_seed_identities_partial_set_missing_email_not_seeded():
    environ = {"B_BEARER": TOKEN_B, "B_REFRESH": TOKEN_B_R}
    report = ident.seed_identities(environ, ident.default_config())
    assert report.identities == {}
    assert "B_EXPECTED_EMAIL" in report.partial["google:b"]


def test_seed_identities_config_known_letters_with_empty_env_never_land_in_partial():
    # BLOCKING B2 (Opus review): a letter whose email is only known via
    # config (no env var for it touched at all) must not be reported as a
    # "partial" set just because the merged email happens to be non-empty —
    # partial is about a HALF-FINISHED ENV EXPORT, and here there was no env
    # export attempt whatsoever.
    cfg = ident.RunnerConfig(google={"a": "a@x.example", "b": "b@x.example", "c": "c@x.example"})
    report = ident.seed_identities({}, cfg)
    assert report.identities == {}
    assert report.partial == {}


def test_seed_identities_scheduler_completed_slot_is_not_also_partial():
    # BLOCKING B2 (Opus review): letter env sets only B_BEARER (a genuine
    # partial export attempt — flagged correctly), but SCHEDULER_* then
    # completes that same slot via config-cast classification. The slot is
    # occupied; it must not simultaneously appear in `partial`.
    environ = {
        "B_BEARER": TOKEN_B,  # partial: no B_REFRESH, no B_EXPECTED_EMAIL
        "SCHEDULER_BEARER": TOKEN_A, "SCHEDULER_REFRESH_TOKEN": TOKEN_A_R,
        "EXPECTED_TEST_ACCOUNT": "b@x.example",
    }
    cfg = ident.RunnerConfig(google={"b": "b@x.example"})
    report = ident.seed_identities(environ, cfg)
    assert "google:b" in report.identities
    assert report.identities["google:b"].bearer == TOKEN_A  # SCHEDULER's pair
    assert "google:b" not in report.partial


def test_seed_identities_config_email_wins_over_env_expected_email():
    # RULING (arbitration): config is the WRONG_ACCOUNT comparison anchor —
    # a stale env export must not silently re-anchor it. Env only fills a
    # letter that config leaves empty (see the fallback test below).
    environ = {"A_BEARER": TOKEN_A, "A_REFRESH": TOKEN_A_R, "A_EXPECTED_EMAIL": "env@x.example"}
    cfg = ident.RunnerConfig(google={"a": "config@x.example"})
    report = ident.seed_identities(environ, cfg)
    assert report.identities["google:a"].email == "config@x.example"


def test_stale_env_expected_email_does_not_prevent_wrong_account_detection():
    """Arbitration's motivating case: config says a@x, env says b@x (a stale
    export left over from a prior account), whoami returns b@x. Because
    config wins, tokens.email anchors on a@x — so whoami's b@x is correctly
    flagged WRONG_ACCOUNT instead of being silently accepted because the
    stale env value happened to agree with whoami."""
    environ = {"A_BEARER": TOKEN_A, "A_REFRESH": TOKEN_A_R, "A_EXPECTED_EMAIL": "b@x.example"}
    cfg = ident.RunnerConfig(google={"a": "a@x.example"})
    report = ident.seed_identities(environ, cfg)
    tokens = report.identities["google:a"]
    assert tokens.email == "a@x.example"

    probe = ident.ProbeResult(status=200, body={"email": "b@x.example"})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.WRONG_ACCOUNT


def test_seed_identities_falls_back_to_config_email_when_env_email_absent():
    environ = {"A_BEARER": TOKEN_A, "A_REFRESH": TOKEN_A_R}
    cfg = ident.RunnerConfig(google={"a": "config@x.example"})
    report = ident.seed_identities(environ, cfg)
    assert report.identities["google:a"].email == "config@x.example"


def test_seed_identities_scheduler_triple_classified_as_google_letter():
    environ = {
        "SCHEDULER_BEARER": TOKEN_A, "SCHEDULER_REFRESH_TOKEN": TOKEN_A_R,
        "EXPECTED_TEST_ACCOUNT": "b@x.example",
    }
    cfg = ident.RunnerConfig(google={"b": "b@x.example"})
    report = ident.seed_identities(environ, cfg)
    assert set(report.identities) == {"google:b"}
    assert report.identities["google:b"].email == "b@x.example"
    assert report.warnings == ()


def test_seed_identities_scheduler_triple_classified_as_microsoft_letter_case_insensitive():
    # IdentityTokens.slot NEVER holds the "microsoft:primary" sentinel — a
    # SCHEDULER_* triple always classifies onto a concrete letter, exactly
    # like the Google branch.
    environ = {
        "SCHEDULER_BEARER": TOKEN_A, "SCHEDULER_REFRESH_TOKEN": TOKEN_A_R,
        "EXPECTED_TEST_ACCOUNT": "MS@X.EXAMPLE",
    }
    cfg = ident.RunnerConfig(microsoft={"a": "ms@x.example"})
    report = ident.seed_identities(environ, cfg)
    assert set(report.identities) == {"microsoft:a"}
    assert report.identities["microsoft:a"].email == "ms@x.example"
    assert report.warnings == ()


def test_seed_identities_scheduler_triple_classified_as_microsoft_non_primary_letter():
    environ = {
        "SCHEDULER_BEARER": TOKEN_A, "SCHEDULER_REFRESH_TOKEN": TOKEN_A_R,
        "EXPECTED_TEST_ACCOUNT": "ms.b@x.example",
    }
    cfg = ident.RunnerConfig(microsoft={"a": "ms.a@x.example", "b": "ms.b@x.example"})
    report = ident.seed_identities(environ, cfg)
    assert set(report.identities) == {"microsoft:b"}
    assert report.identities["microsoft:b"].email == "ms.b@x.example"


def test_classify_scheduler_slot_shared_email_prefers_google_deterministically():
    # NIT (Opus review): pin the classification order. When the SAME email
    # is configured under both casts (an odd but legal config —
    # e.g. re-testing a shared mailbox), _classify_scheduler_slot must be
    # deterministic: google checked first, so it always wins the tie.
    cfg = ident.RunnerConfig(
        google={"a": "shared@x.example"}, microsoft={"a": "shared@x.example"}
    )
    assert ident._classify_scheduler_slot("shared@x.example", cfg) == "google:a"


def test_seed_identities_shared_email_classifies_google_and_provider_check_catches_microsoft_bearer():
    # The deterministic tie-break above means a SCHEDULER_* triple with this
    # shared email always lands on google:a, never microsoft:a — but if the
    # bearer is ACTUALLY a Microsoft account (the probe reports
    # provider="microsoft"), classify()'s provider check still catches the
    # mismatch rather than silently accepting it as a matching Google
    # identity just because the email happened to line up.
    environ = {
        "SCHEDULER_BEARER": TOKEN_A, "SCHEDULER_REFRESH_TOKEN": TOKEN_A_R,
        "EXPECTED_TEST_ACCOUNT": "shared@x.example",
    }
    cfg = ident.RunnerConfig(
        google={"a": "shared@x.example"}, microsoft={"a": "shared@x.example"}
    )
    report = ident.seed_identities(environ, cfg)
    assert set(report.identities) == {"google:a"}
    tokens = report.identities["google:a"]

    probe = ident.ProbeResult(status=200, body={"email": "shared@x.example", "provider": "microsoft"})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.WRONG_ACCOUNT
    assert "provider" in status.detail.lower()


def test_seed_identities_scheduler_triple_unknown_email_not_seeded_with_warning():
    environ = {
        "SCHEDULER_BEARER": TOKEN_A, "SCHEDULER_REFRESH_TOKEN": TOKEN_A_R,
        "EXPECTED_TEST_ACCOUNT": "ghost@x.example",
    }
    cfg = ident.RunnerConfig(google={"a": "a@x.example"}, microsoft={"a": "ms@x.example"})
    report = ident.seed_identities(environ, cfg)
    assert report.identities == {}
    assert len(report.warnings) == 1
    assert "ghost@x.example" in report.warnings[0]
    assert "SCHEDULER" in report.warnings[0]


def test_seed_identities_letter_beats_scheduler_same_bearer_no_warning():
    environ = {
        "A_BEARER": TOKEN_A, "A_REFRESH": TOKEN_A_R, "A_EXPECTED_EMAIL": "a@x.example",
        "SCHEDULER_BEARER": TOKEN_A, "SCHEDULER_REFRESH_TOKEN": TOKEN_A_R,
        "EXPECTED_TEST_ACCOUNT": "a@x.example",
    }
    cfg = ident.RunnerConfig(google={"a": "a@x.example"})
    report = ident.seed_identities(environ, cfg)
    assert set(report.identities) == {"google:a"}
    assert report.identities["google:a"].bearer == TOKEN_A
    assert report.warnings == ()


def test_seed_identities_letter_beats_scheduler_different_bearer_warns():
    environ = {
        "A_BEARER": TOKEN_A, "A_REFRESH": TOKEN_A_R, "A_EXPECTED_EMAIL": "a@x.example",
        "SCHEDULER_BEARER": TOKEN_B, "SCHEDULER_REFRESH_TOKEN": TOKEN_B_R,
        "EXPECTED_TEST_ACCOUNT": "a@x.example",
    }
    cfg = ident.RunnerConfig(google={"a": "a@x.example"})
    report = ident.seed_identities(environ, cfg)
    # Letter triple still wins — the served identity is A's, not SCHEDULER's.
    assert report.identities["google:a"].bearer == TOKEN_A
    assert len(report.warnings) == 1
    assert "google:a" in report.warnings[0]


# =============================================================================
# seed_identities — Microsoft letters (MS_<L>_* family, Decision 3)
# =============================================================================


def test_seed_identities_full_microsoft_letter_set():
    environ = {
        "MS_A_BEARER": TOKEN_A, "MS_A_REFRESH": TOKEN_A_R,
        "MS_A_EXPECTED_EMAIL": "ms.a@x.example",
    }
    report = ident.seed_identities(environ, ident.default_config())
    assert set(report.identities) == {"microsoft:a"}
    tok = report.identities["microsoft:a"]
    assert tok.slot == "microsoft:a"
    assert tok.bearer == TOKEN_A
    assert tok.refresh == TOKEN_A_R
    assert tok.email == "ms.a@x.example"
    assert report.partial == {}


def test_seed_identities_microsoft_letter_with_client_id_and_minted_at():
    environ = {
        "MS_C_BEARER": TOKEN_A, "MS_C_REFRESH": TOKEN_A_R,
        "MS_C_EXPECTED_EMAIL": "ms.c@x.example",
        "MS_C_CLIENT_ID": "other-client", "MS_C_MINTED_AT": "2026-09-01T10:00:00Z",
    }
    report = ident.seed_identities(environ, ident.default_config())
    tok = report.identities["microsoft:c"]
    assert tok.client_id == "other-client"
    assert tok.minted_at == datetime(2026, 9, 1, 10, 0, 0, tzinfo=timezone.utc)


def test_seed_identities_microsoft_partial_set_bearer_without_refresh_not_seeded():
    environ = {"MS_B_BEARER": TOKEN_B, "MS_B_EXPECTED_EMAIL": "ms.b@x.example"}
    report = ident.seed_identities(environ, ident.default_config())
    assert report.identities == {}
    assert "microsoft:b" in report.partial
    assert "MS_B_REFRESH" in report.partial["microsoft:b"]


def test_seed_identities_microsoft_partial_set_missing_email_not_seeded():
    environ = {"MS_B_BEARER": TOKEN_B, "MS_B_REFRESH": TOKEN_B_R}
    report = ident.seed_identities(environ, ident.default_config())
    assert report.identities == {}
    assert "config microsoft.b (or MS_B_EXPECTED_EMAIL)" in report.partial["microsoft:b"]


def test_seed_identities_microsoft_config_known_letters_with_empty_env_never_land_in_partial():
    cfg = ident.RunnerConfig(microsoft={"a": "ms.a@x.example", "b": "ms.b@x.example"})
    report = ident.seed_identities({}, cfg)
    assert report.identities == {}
    assert report.partial == {}


def test_seed_identities_microsoft_config_email_wins_over_env_expected_email():
    environ = {
        "MS_A_BEARER": TOKEN_A, "MS_A_REFRESH": TOKEN_A_R,
        "MS_A_EXPECTED_EMAIL": "env@x.example",
    }
    cfg = ident.RunnerConfig(microsoft={"a": "config@x.example"})
    report = ident.seed_identities(environ, cfg)
    assert report.identities["microsoft:a"].email == "config@x.example"


def test_seed_identities_google_and_microsoft_letters_coexist():
    # The two families never collide: A_BEARER seeds google:a, MS_A_BEARER
    # seeds microsoft:a, independently, in the same environ.
    environ = {
        "A_BEARER": TOKEN_A, "A_REFRESH": TOKEN_A_R, "A_EXPECTED_EMAIL": "a@x.example",
        "MS_A_BEARER": TOKEN_B, "MS_A_REFRESH": TOKEN_B_R, "MS_A_EXPECTED_EMAIL": "ms.a@x.example",
    }
    report = ident.seed_identities(environ, ident.default_config())
    assert set(report.identities) == {"google:a", "microsoft:a"}
    assert report.identities["google:a"].bearer == TOKEN_A
    assert report.identities["microsoft:a"].bearer == TOKEN_B


def test_seed_identities_multiple_letters_and_scheduler_all_coexist():
    environ = {
        "A_BEARER": TOKEN_A, "A_REFRESH": TOKEN_A_R, "A_EXPECTED_EMAIL": "a@x.example",
        "B_BEARER": TOKEN_B, "B_REFRESH": TOKEN_B_R, "B_EXPECTED_EMAIL": "b@x.example",
        "SCHEDULER_BEARER": TOKEN_A, "SCHEDULER_REFRESH_TOKEN": TOKEN_A_R,
        "EXPECTED_TEST_ACCOUNT": "a@x.example",
    }
    cfg = ident.RunnerConfig(google={"a": "a@x.example", "b": "b@x.example"})
    report = ident.seed_identities(environ, cfg)
    assert set(report.identities) == {"google:a", "google:b"}


# =============================================================================
# TTL math (_ttl_remaining) — the FRESH countdown and its edges
# =============================================================================


def test_ttl_remaining_basic():
    minted = NOW - timedelta(seconds=10)
    bearer_s, refresh_s = ident._ttl_remaining(minted, NOW)
    assert bearer_s == ident.ACCESS_TTL_S - 10
    assert refresh_s == ident.REFRESH_TTL_DAYS * 86400 - 10


def test_ttl_remaining_refresh_90_day_edge_exact():
    minted = NOW - timedelta(days=90)
    _, refresh_s = ident._ttl_remaining(minted, NOW)
    assert refresh_s == 0


def test_ttl_remaining_refresh_90_day_edge_expired():
    minted = NOW - timedelta(days=90, seconds=1)
    _, refresh_s = ident._ttl_remaining(minted, NOW)
    assert refresh_s == -1


def test_ttl_remaining_naive_now_does_not_raise():
    # MINOR M1 (Opus review): a caller passing a naive `now` (e.g.
    # datetime.now() without tzinfo) must not TypeError on aware-minus-naive.
    minted = NOW - timedelta(seconds=100)
    naive_now = NOW.replace(tzinfo=None)
    bearer_s, refresh_s = ident._ttl_remaining(minted, naive_now)
    assert bearer_s == ident.ACCESS_TTL_S - 100
    assert refresh_s == ident.REFRESH_TTL_DAYS * 86400 - 100


def test_ttl_remaining_naive_minted_at_does_not_raise():
    naive_minted = (NOW - timedelta(seconds=100)).replace(tzinfo=None)
    bearer_s, refresh_s = ident._ttl_remaining(naive_minted, NOW)
    assert bearer_s == ident.ACCESS_TTL_S - 100


def test_classify_never_raises_with_naive_now():
    tokens = make_tokens(minted_at=NOW - timedelta(seconds=100))
    probe = ident.ProbeResult(status=200, body={"email": "a@example.com"})
    naive_now = NOW.replace(tzinfo=None)
    status = ident.classify(tokens, probe, naive_now)
    assert status.state == ident.IdentityState.FRESH


# =============================================================================
# classify() — every row of the WP2 table
# =============================================================================


def test_classify_tokens_none_is_absent():
    status = ident.classify(None, None, NOW)
    assert status.state == ident.IdentityState.ABSENT


def test_classify_probe_200_matching_email_with_minted_at_is_fresh():
    tokens = make_tokens(minted_at=NOW - timedelta(seconds=100))
    probe = ident.ProbeResult(status=200, body={"email": "a@example.com", "home_tz": "UTC"})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.FRESH
    assert status.detail == "bearer 58m · refresh 89d"


def test_classify_probe_200_email_match_is_case_insensitive():
    tokens = make_tokens(minted_at=NOW - timedelta(seconds=10), email="A@Example.com")
    probe = ident.ProbeResult(status=200, body={"email": "a@example.com"})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.FRESH


def test_classify_probe_200_no_minted_at_is_valid():
    tokens = make_tokens(minted_at=None)
    probe = ident.ProbeResult(status=200, body={"email": "a@example.com"})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.VALID


def test_classify_probe_200_with_no_usable_email_is_probe_error():
    # MINOR M2 (Opus review): a 200 whose body has no string email (e.g. an
    # HTML interstitial that probe_whoami couldn't parse as JSON, landing as
    # body={}) is not evidence of a wrong account — it's an unreadable probe.
    tokens = make_tokens()
    probe = ident.ProbeResult(status=200, body={})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.PROBE_ERROR


def test_classify_probe_200_with_non_string_email_is_probe_error():
    tokens = make_tokens()
    probe = ident.ProbeResult(status=200, body={"email": None})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.PROBE_ERROR


def test_classify_bearer_window_edge_3599_seconds_is_fresh():
    tokens = make_tokens(minted_at=NOW - timedelta(seconds=3599))
    probe = ident.ProbeResult(status=200, body={"email": "a@example.com"})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.FRESH


def test_classify_bearer_window_edge_3600_seconds_is_valid():
    tokens = make_tokens(minted_at=NOW - timedelta(seconds=3600))
    probe = ident.ProbeResult(status=200, body={"email": "a@example.com"})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.VALID


def test_classify_bearer_window_edge_3601_seconds_is_valid_with_note():
    # Probe truth wins over minted_at math: the server says 200, so this is
    # VALID (not ABSENT/STALE), but the detail notes the math disagreed.
    tokens = make_tokens(minted_at=NOW - timedelta(seconds=3601))
    probe = ident.ProbeResult(status=200, body={"email": "a@example.com"})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.VALID
    assert "expired" in status.detail.lower()


def test_classify_probe_200_email_mismatch_is_wrong_account():
    tokens = make_tokens(email="a@x.example")
    probe = ident.ProbeResult(status=200, body={"email": "someone-else@x.example"})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.WRONG_ACCOUNT
    assert "a@x.example" in status.detail
    assert "someone-else@x.example" in status.detail


def test_classify_probe_401_expired_token_is_bearer_expired():
    tokens = make_tokens()
    probe = ident.ProbeResult(status=401, body={"error": "expired_token"})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.BEARER_EXPIRED


def test_classify_probe_401_revoked_token_is_stale():
    tokens = make_tokens()
    probe = ident.ProbeResult(status=401, body={"error": "revoked_token"})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.STALE


def test_classify_probe_401_invalid_token_is_stale():
    tokens = make_tokens()
    probe = ident.ProbeResult(status=401, body={"error": "invalid_token"})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.STALE


def test_classify_probe_other_4xx_is_stale():
    tokens = make_tokens()
    probe = ident.ProbeResult(status=403, body={"error": "forbidden"})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.STALE


def test_classify_probe_204_is_probe_error_not_stale():
    # MINOR M3 (Opus review): only the named 401s and other 4xx are TOKEN
    # verdicts. A 204/302 (below 400) is neither a success this code
    # understands nor a token rejection — PROBE_ERROR, not STALE.
    tokens = make_tokens()
    probe = ident.ProbeResult(status=204, body={})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.PROBE_ERROR


def test_classify_probe_302_is_probe_error_not_stale():
    tokens = make_tokens()
    probe = ident.ProbeResult(status=302, body={})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.PROBE_ERROR


def test_classify_probe_500_is_probe_error_not_stale():
    # RULING (arbitration): a server fault is not a token verdict — must
    # never render "re-mint needed".
    tokens = make_tokens()
    probe = ident.ProbeResult(status=500, body={})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.PROBE_ERROR
    assert "re-mint" not in status.detail.lower()


def test_classify_probe_503_is_probe_error():
    tokens = make_tokens()
    probe = ident.ProbeResult(status=503, body={"error": "bad_gateway"})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.PROBE_ERROR


def test_classify_probe_transport_error_is_probe_error():
    tokens = make_tokens()
    probe = ident.ProbeResult(status=None, body={})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.PROBE_ERROR


def test_classify_missing_probe_never_raises():
    tokens = make_tokens()
    status = ident.classify(tokens, None, NOW)
    assert status.state == ident.IdentityState.PROBE_ERROR


# =============================================================================
# classify() — provider field (WP0 whoami addition): a probe body whose
# `provider` disagrees with the slot's own provider is WRONG_ACCOUNT even
# when the email matched; a body without the field (old worker) is unaffected.
# =============================================================================


def test_slot_provider_google():
    assert ident.slot_provider("google:a") == "google"


def test_slot_provider_microsoft():
    assert ident.slot_provider("microsoft:b") == "microsoft"


def test_classify_provider_mismatch_is_wrong_account_even_with_matching_email():
    tokens = make_tokens(email="a@example.com", slot="microsoft:a")
    probe = ident.ProbeResult(status=200, body={"email": "a@example.com", "provider": "google"})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.WRONG_ACCOUNT
    assert "google" in status.detail
    assert "microsoft" in status.detail


def test_classify_provider_match_is_not_wrong_account():
    tokens = make_tokens(minted_at=None, email="a@example.com", slot="google:a")
    probe = ident.ProbeResult(status=200, body={"email": "a@example.com", "provider": "google"})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.VALID


def test_classify_no_provider_field_keeps_todays_behaviour():
    # Old worker, pre-WP0: no `provider` key in the whoami body at all — must
    # not be treated as a mismatch.
    tokens = make_tokens(minted_at=None, email="a@example.com", slot="microsoft:a")
    probe = ident.ProbeResult(status=200, body={"email": "a@example.com"})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.VALID


def test_classify_provider_mismatch_wins_over_email_mismatch():
    # REVIEW FIX (Opus review): when BOTH the email and the provider
    # disagree, the provider check must fire first — a Google bearer landing
    # on a Microsoft slot should report the ROOT CAUSE (provider mismatch),
    # not the incidental email mismatch (a different Google account's
    # address happens to be configured for that slot too).
    tokens = make_tokens(email="ms.a@x.example", slot="microsoft:a")
    probe = ident.ProbeResult(
        status=200, body={"email": "someone-else@x.example", "provider": "google"}
    )
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.WRONG_ACCOUNT
    assert "provider" in status.detail.lower()
    assert "google" in status.detail
    assert "microsoft" in status.detail
    # The email-mismatch wording must NOT be what's reported here.
    assert "someone-else@x.example" not in status.detail


# =============================================================================
# scrub_secrets
# =============================================================================


def test_scrub_secrets_masks_43_char_token():
    token = "A" * 43
    assert ident.scrub_secrets(f"bearer={token}") == "bearer=[REDACTED-TOKEN]"


def test_scrub_secrets_leaves_42_char_run_untouched():
    token = "A" * 42
    text = f"x={token}"
    assert ident.scrub_secrets(text) == text


def test_scrub_secrets_leaves_44_char_run_untouched():
    token = "A" * 44
    text = f"x={token}"
    assert ident.scrub_secrets(text) == text


def test_scrub_secrets_leaves_50_char_run_untouched():
    token = "A" * 50
    text = f"x={token}"
    assert ident.scrub_secrets(text) == text


def test_scrub_secrets_multiple_tokens_one_line():
    t1, t2 = "A" * 43, "B" * 43
    assert ident.scrub_secrets(f"{t1} and {t2}") == "[REDACTED-TOKEN] and [REDACTED-TOKEN]"


def test_scrub_secrets_token_inside_authorization_bearer_header():
    token = "C" * 43
    text = f"Authorization: Bearer {token}"
    assert ident.scrub_secrets(text) == "Authorization: Bearer [REDACTED-TOKEN]"


def test_scrub_secrets_no_token_present_is_unchanged():
    text = "no secrets here, just prose"
    assert ident.scrub_secrets(text) == text


# =============================================================================
# probe_whoami — stdlib urllib, monkeypatched at the module seam
# =============================================================================


class _FakeResponse:
    def __init__(self, status: int, body: bytes):
        self.status = status
        self._body = body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_probe_whoami_200_sends_bearer_and_accept_headers(monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["auth"] = req.get_header("Authorization")
        captured["accept"] = req.get_header("Accept")
        captured["timeout"] = timeout
        captured["full_url"] = req.full_url
        return _FakeResponse(200, b'{"email":"a@x.example","home_tz":"UTC"}')

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    result = ident.probe_whoami("https://scheduler-dev.example", "tok123", timeout=5.0)
    assert result.status == 200
    assert result.body == {"email": "a@x.example", "home_tz": "UTC"}
    assert captured["auth"] == "Bearer tok123"
    assert captured["accept"] == "application/json"
    assert captured["timeout"] == 5.0
    # MINOR M5 (Opus review): pin the actual request target, not just headers.
    assert captured["full_url"] == "https://scheduler-dev.example/v1/whoami"


def test_probe_whoami_strips_a_trailing_slash_from_the_base_url(monkeypatch):
    # Pins the rstrip('/') behaviour: a trailing slash on `url` must not
    # produce a double slash in the request path.
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["full_url"] = req.full_url
        return _FakeResponse(200, b'{"email":"a@x.example","home_tz":"UTC"}')

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    ident.probe_whoami("https://scheduler-dev.example/", "tok123")
    assert captured["full_url"] == "https://scheduler-dev.example/v1/whoami"


def test_probe_whoami_401_reads_the_error_body(monkeypatch):
    def fake_urlopen(req, timeout=None):
        raise urllib.error.HTTPError(
            req.full_url, 401, "Unauthorized", None, io.BytesIO(b'{"error":"expired_token"}')
        )

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    result = ident.probe_whoami("https://scheduler-dev.example", "tok123")
    assert result.status == 401
    assert result.body == {"error": "expired_token"}


def test_probe_whoami_transport_error_returns_none_status(monkeypatch):
    def fake_urlopen(req, timeout=None):
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    result = ident.probe_whoami("https://scheduler-dev.example", "tok123")
    assert result.status is None
    assert result.body == {}


def test_probe_whoami_never_raises_on_non_json_401_body(monkeypatch):
    def fake_urlopen(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", None, io.BytesIO(b"not json"))

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    result = ident.probe_whoami("https://scheduler-dev.example", "tok123")
    assert result.status == 401
    assert result.body == {}


# =============================================================================
# login_command
# =============================================================================


def test_login_command_google_letter_includes_all_configured_emails():
    cfg = ident.RunnerConfig(google={"a": "a@x.example", "b": "b@x.example", "c": "c@x.example"})
    cmd = ident.login_command("google:b", cfg, "https://scheduler-dev.example")
    assert cmd == (
        'eval "$(bin/mu-smoke-login.py B --url https://scheduler-dev.example '
        '--email-a a@x.example --email-b b@x.example --email-c c@x.example)"'
    )


def test_login_command_google_letter_omits_unset_emails():
    cfg = ident.RunnerConfig(google={"a": "a@x.example"})
    cmd = ident.login_command("google:a", cfg, "https://scheduler-dev.example")
    assert cmd == (
        'eval "$(bin/mu-smoke-login.py A --url https://scheduler-dev.example '
        '--email-a a@x.example)"'
    )


def test_login_command_microsoft_letter_includes_all_configured_emails():
    cfg = ident.RunnerConfig(microsoft={"a": "ms.a@x.example", "b": "ms.b@x.example", "c": "ms.c@x.example"})
    cmd = ident.login_command("microsoft:b", cfg, "https://scheduler-dev.example")
    assert cmd == (
        'eval "$(bin/mu-smoke-login.py B --provider microsoft --url https://scheduler-dev.example '
        '--email-a ms.a@x.example --email-b ms.b@x.example --email-c ms.c@x.example)"'
    )


def test_login_command_microsoft_letter_omits_unset_emails():
    cfg = ident.RunnerConfig(microsoft={"a": "ms.a@x.example"})
    cmd = ident.login_command("microsoft:a", cfg, "https://scheduler-dev.example")
    assert cmd == (
        'eval "$(bin/mu-smoke-login.py A --provider microsoft --url https://scheduler-dev.example '
        '--email-a ms.a@x.example)"'
    )


def test_login_command_microsoft_primary_sentinel_raises():
    # The runner's registry resolves "microsoft:primary" to a concrete letter
    # via cfg.microsoft_primary BEFORE calling login_command — this function
    # must reject the sentinel outright, the same as any other unknown slot.
    with pytest.raises(ValueError):
        ident.login_command("microsoft:primary", ident.default_config(), "https://scheduler-dev.example")


def test_login_command_unknown_slot_raises():
    with pytest.raises(ValueError):
        ident.login_command("google:z", ident.default_config(), "https://x.example")


# -- campaign provider axis (2026-09-17) -------------------------------------


def test_load_config_missing_provider_defaults_to_google(tmp_path):
    """A config.toml written before the provider key existed keeps loading
    as a Google campaign — the pre-2026-09-17 behaviour, made explicit."""
    path = tmp_path / "config.toml"
    path.write_text('[defaults]\ntarget = "other-env"\n', encoding="utf-8")
    cfg = ident.load_config(path)
    assert cfg.target == "other-env"
    assert cfg.provider == "google"


def test_load_config_rejects_unknown_provider(tmp_path):
    """A junk provider must not load silently: every harness's default mode
    is chosen off this value, so a typo would quietly turn a whole campaign
    into "nothing matches, fall back to the first mode"."""
    path = tmp_path / "config.toml"
    path.write_text('[defaults]\nprovider = "outlook"\n', encoding="utf-8")
    with pytest.raises(ValueError, match="defaults.provider"):
        ident.load_config(path)


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))


# =============================================================================
# 2026-09-02: a Cloudflare-fronted smoke host answers Python-urllib's default
# User-Agent with a Cloudflare 1010 block — HTTP 403, text/plain "error code:
# 1010" — before the worker ever sees the request. The pane rendered that as
# STALE "re-mint needed" for a token the harnesses (httpx UA) use fine.
# =============================================================================

def test_probe_whoami_sends_its_own_user_agent(monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["ua"] = req.get_header("User-agent")
        return _FakeResponse(200, b'{"email":"a@x.example","home_tz":"UTC"}')

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    ident.probe_whoami("https://scheduler-dev.example", "tok123")
    assert captured["ua"] and not captured["ua"].lower().startswith("python-urllib")
    assert "optical-smoke" in captured["ua"]


def test_classify_probe_4xx_without_the_worker_error_body_is_probe_error_not_stale():
    # An edge block (Cloudflare BIC/WAF 1010, an Access page) is a 4xx with
    # no {"error": ...} body — not a token verdict, and never "re-mint".
    tokens = make_tokens()
    probe = ident.ProbeResult(status=403, body={})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.PROBE_ERROR
    assert "re-mint" not in status.detail.lower()
    assert "edge" in status.detail.lower()


def test_classify_probe_401_without_the_worker_error_body_is_probe_error_not_stale():
    tokens = make_tokens()
    probe = ident.ProbeResult(status=401, body={})
    status = ident.classify(tokens, probe, NOW)
    assert status.state == ident.IdentityState.PROBE_ERROR
