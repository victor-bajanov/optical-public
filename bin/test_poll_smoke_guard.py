#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27"]
# ///
"""Guard for bin/poll-smoke.py's dev-url/req guard: proves it binds the
SHARED _smoke_lib primitives rather than re-declaring its own drifted copy.

Same drift class bin/test_feed_smoke_guard.py fixed for feed-smoke.py: the
local assert_dev_url was fail-open on prod's own workers.dev subdomain
(weekly-scheduling-assistant.*.workers.dev). Behaviour gained by switching
to the shared import: prod's own workers.dev subdomain becomes REFUSED.

assert_dev_db is switched too (2026-09-02): the D1 cleanup routes through
the shared, env-aware `d1_for_db_id`, and the db guard is the shared one
(prod hard-denied), cross-checked against the URL by `assert_env_consistent`.

Run: uv run bin/test_poll_smoke_guard.py
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

BIN = Path(__file__).parent


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, BIN / filename)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


poll_smoke = _load("poll_smoke_guard_test", "poll-smoke.py")
# poll-smoke.py loads _smoke_lib.py itself via importlib and stores that
# exact module instance as its own `_smoke_lib` global — reuse THAT instance
# for the `is` identity checks, and pin its file path so a decoy module
# can't satisfy them (same rationale as test_feed_smoke_guard.py).
smoke_lib = poll_smoke._smoke_lib


# =============================================================================
# poll-smoke binds the shared _smoke_lib primitives — not local copies
# =============================================================================


def test_poll_smoke_assert_dev_url_is_smoke_lib_assert_dev_url():
    assert poll_smoke.assert_dev_url is smoke_lib.assert_dev_url
    assert smoke_lib.__file__ == str((BIN / "_smoke_lib.py").resolve())


def test_poll_smoke_req_is_smoke_lib_req():
    assert poll_smoke.req is smoke_lib.req
    assert smoke_lib.__file__ == str((BIN / "_smoke_lib.py").resolve())


def test_poll_smoke_db_ids_come_from_smoke_lib():
    assert poll_smoke.DEV_DB_ID == smoke_lib.DEV_DB_ID
    assert poll_smoke.PROD_DB_ID == smoke_lib.PROD_DB_ID


# =============================================================================
# Behavioural spot-checks through the poll-smoke binding
# =============================================================================


def test_dev_host_accepted():
    poll_smoke.assert_dev_url("https://scheduler-dev.example.com")  # no raise




def test_prod_host_refused():
    with pytest.raises(SystemExit):
        poll_smoke.assert_dev_url("https://scheduler.example.com")


def test_prod_own_workers_dev_subdomain_refused():
    # Behaviour fix: the local copy's blanket "*.workers.dev" rule was
    # fail-open on prod's own workers.dev subdomain.
    with pytest.raises(SystemExit):
        poll_smoke.assert_dev_url("https://weekly-scheduling-assistant.someacct.workers.dev")


def test_other_workers_dev_subdomain_accepted():
    poll_smoke.assert_dev_url("https://weekly-scheduling-assistant-dev.someacct.workers.dev")  # no raise


# =============================================================================
# assert_dev_db is the SHARED guard (prod denied), and D1 access is
# env-aware — a run's cleanup only ever touches its own env's db.
# =============================================================================


def test_poll_smoke_assert_dev_db_is_smoke_lib_assert_dev_db():
    assert poll_smoke.assert_dev_db is smoke_lib.assert_dev_db
    poll_smoke.assert_dev_db(smoke_lib.DEV_DB_ID)  # no raise
    with pytest.raises(SystemExit):
        poll_smoke.assert_dev_db(smoke_lib.PROD_DB_ID)


def test_poll_smoke_d1_routes_through_the_env_aware_helper():
    assert poll_smoke.d1_for_db_id is smoke_lib.d1_for_db_id
    assert poll_smoke.assert_env_consistent is smoke_lib.assert_env_consistent


def test_manual_cleanup_hint_names_the_target_env():
    assert "--env dev" in poll_smoke.manual_poll_cleanup_hint("dev")


def _set_poll_env(monkeypatch, url: str, db_id: str) -> None:
    for k in ("SCHEDULER_URL", "A_BEARER", "A_REFRESH", "A_EXPECTED_EMAIL",
              "INVITEE_A_EMAIL", "INVITEE_B_EMAIL", "D1_DATABASE_ID", "SMOKE_WRANGLER_ENV"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("SCHEDULER_URL", url)
    for k in ("A_BEARER", "A_REFRESH"):
        monkeypatch.setenv(k, "x")
    monkeypatch.setenv("A_EXPECTED_EMAIL", "a@x.example")
    monkeypatch.setenv("INVITEE_A_EMAIL", "b@x.example")
    monkeypatch.setenv("INVITEE_B_EMAIL", "c@x.example")
    monkeypatch.setenv("D1_DATABASE_ID", db_id)


def test_env_targets_dev_for_the_dev_pair(monkeypatch):
    _set_poll_env(monkeypatch, "https://scheduler-dev.example.com", smoke_lib.DEV_DB_ID)
    env = poll_smoke.PollSmokeEnv.from_environ()
    assert env.d1_database_id == smoke_lib.DEV_DB_ID
    assert env.wrangler_env == "dev"


def test_env_refuses_the_prod_db(monkeypatch):
    _set_poll_env(monkeypatch, "https://scheduler-dev.example.com", smoke_lib.PROD_DB_ID)
    with pytest.raises(SystemExit):
        poll_smoke.PollSmokeEnv.from_environ()


def test_wrangler_env_for_defaults_to_dev_without_a_db(monkeypatch):
    monkeypatch.delenv("SMOKE_WRANGLER_ENV", raising=False)
    assert poll_smoke.wrangler_env_for("https://scheduler-dev.example.com", None) == "dev"
    assert poll_smoke.wrangler_env_for(
        "https://weekly-scheduling-assistant-dev.someacct.workers.dev", None) == "dev"




# =============================================================================
# Loading poll-smoke.py via importlib must execute only defs — main() stays
# __main__-guarded.
# =============================================================================


def test_loading_poll_smoke_module_has_no_side_effects():
    assert callable(poll_smoke.main)


# =============================================================================
# --provider {google,microsoft} (WP2.4) — same convention as
# bin/regression-smoke.py's parse_args (bin/regression-smoke.py:3093-3098).
# =============================================================================


def test_parse_args_defaults_to_google(monkeypatch):
    monkeypatch.delenv("SMOKE_PROVIDER", raising=False)
    assert poll_smoke.parse_args([]).provider == "google"


def test_parse_args_accepts_microsoft_flag(monkeypatch):
    monkeypatch.delenv("SMOKE_PROVIDER", raising=False)
    assert poll_smoke.parse_args(["--provider", "microsoft"]).provider == "microsoft"


def test_parse_args_honours_smoke_provider_env_var(monkeypatch):
    monkeypatch.setenv("SMOKE_PROVIDER", "microsoft")
    assert poll_smoke.parse_args([]).provider == "microsoft"


def test_parse_args_empty_smoke_provider_env_var_falls_back_to_google(monkeypatch):
    # WP2 review finding 6: os.environ.get("SMOKE_PROVIDER", "google") only
    # substitutes "google" when the var is entirely UNSET — SMOKE_PROVIDER=""
    # (a common shell artifact, e.g. `export SMOKE_PROVIDER=` with nothing
    # after it) would otherwise become argparse's literal --provider default
    # and bypass `choices` validation entirely.
    monkeypatch.setenv("SMOKE_PROVIDER", "")
    assert poll_smoke.parse_args([]).provider == "google"


def test_parse_args_rejects_unknown_provider():
    with pytest.raises(SystemExit):
        poll_smoke.parse_args(["--provider", "icloud"])


# =============================================================================
# check_whoami — pure predicate behind the new preflight GET /v1/whoami guard
# (poll-smoke had no preflight at all before WP2.4).
# =============================================================================


def test_check_whoami_ok_when_email_matches_and_no_provider_field():
    # Body without 'provider' = an old worker (whoami's provider field is
    # additive, WP0) — the provider half of the check is skipped, not failed.
    assert poll_smoke.check_whoami({"email": "A@Example.com"}, "a@example.com", "google") is None


def test_check_whoami_is_case_insensitive_on_email():
    assert poll_smoke.check_whoami({"email": "a@example.com"}, "A@EXAMPLE.COM", "google") is None


def test_check_whoami_fails_on_wrong_email():
    err = poll_smoke.check_whoami({"email": "wrong@example.com"}, "a@example.com", "google")
    assert err is not None and "wrong@example.com" in err and "a@example.com" in err


def test_check_whoami_ok_when_provider_field_matches():
    assert poll_smoke.check_whoami({"email": "a@example.com", "provider": "microsoft"}, "a@example.com", "microsoft") is None


def test_check_whoami_fails_when_provider_field_disagrees():
    err = poll_smoke.check_whoami({"email": "a@example.com", "provider": "google"}, "a@example.com", "microsoft")
    assert err is not None and "google" in err and "microsoft" in err


def test_check_whoami_fails_email_before_checking_provider():
    err = poll_smoke.check_whoami({"email": "wrong@example.com", "provider": "google"}, "a@example.com", "microsoft")
    assert err is not None and "wrong@example.com" in err


# =============================================================================
# whoami_provider_warning — WP2 review finding 3: check_whoami silently
# SKIPS the provider half when the worker's response has no 'provider' key
# (pre-WP0, additive field). That's correct for check_whoami's pass/fail
# contract, but the operator should still be told a mismatched --provider
# will only surface later as a confusing Graph 401, not here.
# =============================================================================


def test_whoami_provider_warning_present_when_provider_field_missing():
    warning = poll_smoke.whoami_provider_warning({"email": "a@example.com"})
    assert warning is not None
    assert "provider" in warning.lower()
    assert "Graph 401" in warning


def test_whoami_provider_warning_absent_when_provider_field_present():
    # Present whether it matches or not — check_whoami is what fails a
    # mismatch; this warning is only about the field being ABSENT.
    assert poll_smoke.whoami_provider_warning({"email": "a@example.com", "provider": "google"}) is None
    assert poll_smoke.whoami_provider_warning({"email": "a@example.com", "provider": "microsoft"}) is None


# =============================================================================
# edit_create_location — EDIT mode's Poll-1 create location kind (Decision 7:
# addMeet 400s on an MSA without Teams, so Microsoft uses 'phone' not 'meet').
# =============================================================================


def test_edit_create_location_google_is_meet_with_no_detail():
    loc = poll_smoke.edit_create_location("google")
    assert loc["kind"] == "meet"
    assert not loc.get("detail")


def test_edit_create_location_microsoft_is_phone_with_a_detail():
    loc = poll_smoke.edit_create_location("microsoft")
    assert loc["kind"] == "phone"
    assert loc.get("detail")


def test_edit_create_location_rejects_unknown_provider():
    with pytest.raises(ValueError):
        poll_smoke.edit_create_location("icloud")


# =============================================================================
# CalendarLike — the run_* functions' cal parameter is duck-typed across
# CalendarClient (Google) and GraphCalendarClient (Microsoft), not pinned to
# CalendarClient's own type.
# =============================================================================


def test_calendar_like_alias_covers_both_calendar_clients():
    import typing
    args = typing.get_args(poll_smoke.CalendarLike)
    assert smoke_lib.CalendarClient in args
    assert smoke_lib.GraphCalendarClient in args


# =============================================================================
# main() builds cal/reader via the provider-generic factories, not the
# Google-only names baked in at import time.
# =============================================================================


def _clear_poll_smoke_env(monkeypatch):
    for k in ("SCHEDULER_URL", "A_BEARER", "A_REFRESH", "A_EXPECTED_EMAIL",
              "INVITEE_A_EMAIL", "INVITEE_B_EMAIL", "D1_DATABASE_ID", "SMOKE_WRANGLER_ENV",
              "POLL_SMOKE_ALLOW_ANY_DAY", "SMOKE_PROVIDER"):
        monkeypatch.delenv(k, raising=False)


class _FakeSchedForMain:
    """Stands in for SchedulerClient: answers exactly the one call main()
    makes before handing off to the (also-stubbed) run_* functions —
    GET /v1/whoami — and nothing else."""

    def __init__(self, identity):
        self.identity = identity

    def request(self, method, path, **kw):
        import httpx as _httpx
        if (method, path) == ("GET", "/v1/whoami"):
            return _httpx.Response(
                200, json={"email": self.identity.expected_email, "provider": "microsoft"},
                request=_httpx.Request("GET", "https://x/v1/whoami"),
            )
        raise AssertionError(f"unexpected request {method} {path}")

    def close(self) -> None:
        pass


class _FakeCalForMain:
    def delete_event(self, event_id):
        pass

    def close(self) -> None:
        pass


class _FakeReaderForMain:
    def close(self) -> None:
        pass


def test_main_calls_make_calendar_client_and_make_mail_reader_with_the_parsed_provider(monkeypatch):
    # WP2 review finding 8: replace the source-grep with a real spy proving
    # main() actually DRIVES make_calendar_client/make_mail_reader with
    # --provider's parsed value — not just that the names appear somewhere
    # in main()'s source text.
    _clear_poll_smoke_env(monkeypatch)
    monkeypatch.setenv("SCHEDULER_URL", "https://scheduler-dev.example.com")
    monkeypatch.setenv("A_BEARER", "tok")
    monkeypatch.setenv("A_REFRESH", "refresh")
    monkeypatch.setenv("A_EXPECTED_EMAIL", "a@example.com")
    monkeypatch.setenv("INVITEE_A_EMAIL", "b@example.com")
    monkeypatch.setenv("INVITEE_B_EMAIL", "c@example.com")
    monkeypatch.setenv("POLL_SMOKE_ALLOW_ANY_DAY", "true")
    monkeypatch.setattr(sys, "argv", ["poll-smoke.py", "--provider", "microsoft"])

    calls: dict[str, str] = {}

    def fake_make_calendar_client(sched, provider):
        calls["cal_provider"] = provider
        return _FakeCalForMain()

    def fake_make_mail_reader(sched, provider):
        calls["reader_provider"] = provider
        return _FakeReaderForMain()

    monkeypatch.setattr(poll_smoke, "SchedulerClient", _FakeSchedForMain)
    monkeypatch.setattr(poll_smoke, "make_calendar_client", fake_make_calendar_client)
    monkeypatch.setattr(poll_smoke, "make_mail_reader", fake_make_mail_reader)
    for fn in ("run_happy_path", "run_nudge_check", "run_unhappy_mode",
               "run_hidden_invitee_mode", "run_guestwait_mode",
               "run_bookbest_mode", "run_edit_mode"):
        monkeypatch.setattr(poll_smoke, fn, lambda *a, **k: None)

    try:
        poll_smoke.main()
    finally:
        poll_smoke.configure_mail_reader(None)  # don't leak the fake reader into other tests

    assert calls["cal_provider"] == "microsoft"
    assert calls["reader_provider"] == "microsoft"


def test_parse_args_runs_before_the_weekend_gate(monkeypatch, capsys):
    # WP2 review finding 5: parse_args() must run BEFORE the Mon-Thu run-day
    # gate, so --help or an invalid --provider gets argparse's own error on
    # a Fri-Sun instead of a "REFUSING TO RUN" weekend message that has
    # nothing to do with what the operator actually got wrong.
    import datetime as _datetime

    class FakeDate:
        @staticmethod
        def today():
            return _datetime.date(2026, 9, 5)  # a Saturday

    _clear_poll_smoke_env(monkeypatch)
    monkeypatch.setattr(poll_smoke, "date", FakeDate)
    monkeypatch.setattr(sys, "argv", ["poll-smoke.py", "--provider", "not-a-real-provider"])

    with pytest.raises(SystemExit) as exc_info:
        poll_smoke.main()

    # argparse's own SystemExit carries an int code (2 for a bad argument);
    # the weekend gate's SystemExit carries a STRING message as its code —
    # an int here proves parse_args ran (and raised) before the weekend
    # gate got a chance to fire at all.
    assert exc_info.value.code == 2
    err = capsys.readouterr().err
    assert "invalid choice" in err
    assert "REFUSING TO RUN" not in err


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))
