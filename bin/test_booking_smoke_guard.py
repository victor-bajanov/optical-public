#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27"]
# ///
"""Guard for bin/booking-smoke.py's dev-url/req guard: proves it binds the
SHARED _smoke_lib primitives rather than re-declaring its own drifted copy.

Same drift class bin/test_feed_smoke_guard.py fixed for feed-smoke.py: the
local assert_dev_url was fail-open on prod's own workers.dev subdomain
(weekly-scheduling-assistant.*.workers.dev). Behaviour gained by switching
to the shared import: prod's own workers.dev subdomain becomes REFUSED.

The db guard is NOT the shared one: booking-smoke's direct-D1 cleanup must
hit exactly the db its wrangler env owns (assert_smoke_db(db_id, env) —
dev<->scheduler-dev), which is TIGHTER than _smoke_lib.assert_dev_db. A
test below pins that so a future "switch everything" pass can't silently
widen it.

Run: uv run bin/test_booking_smoke_guard.py
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


booking_smoke = _load("booking_smoke_guard_test", "booking-smoke.py")
# booking-smoke.py loads _smoke_lib.py itself via importlib and stores that
# exact module instance as its own `_smoke_lib` global — reuse THAT instance
# for the `is` identity checks, and pin its file path so a decoy module
# can't satisfy them (same rationale as test_feed_smoke_guard.py).
smoke_lib = booking_smoke._smoke_lib


# =============================================================================
# booking-smoke binds the shared _smoke_lib primitives — not local copies
# =============================================================================


def test_booking_smoke_assert_dev_url_is_smoke_lib_assert_dev_url():
    assert booking_smoke.assert_dev_url is smoke_lib.assert_dev_url
    assert smoke_lib.__file__ == str((BIN / "_smoke_lib.py").resolve())


def test_booking_smoke_req_is_smoke_lib_req():
    assert booking_smoke.req is smoke_lib.req
    assert smoke_lib.__file__ == str((BIN / "_smoke_lib.py").resolve())


def test_booking_smoke_db_ids_come_from_smoke_lib():
    assert booking_smoke.DEV_DB_ID == smoke_lib.DEV_DB_ID
    assert booking_smoke.PROD_DB_ID == smoke_lib.PROD_DB_ID


# =============================================================================
# Behavioural spot-checks through the booking-smoke binding
# =============================================================================


def test_dev_host_accepted():
    booking_smoke.assert_dev_url("https://scheduler-dev.example.com")  # no raise




def test_prod_host_refused():
    with pytest.raises(SystemExit):
        booking_smoke.assert_dev_url("https://scheduler.example.com")


def test_prod_own_workers_dev_subdomain_refused():
    # Behaviour fix: the local copy's blanket "*.workers.dev" rule was
    # fail-open on prod's own workers.dev subdomain.
    with pytest.raises(SystemExit):
        booking_smoke.assert_dev_url("https://weekly-scheduling-assistant.someacct.workers.dev")


def test_other_workers_dev_subdomain_accepted():
    booking_smoke.assert_dev_url("https://weekly-scheduling-assistant-dev.someacct.workers.dev")  # no raise


# =============================================================================
# assert_smoke_db stays LOCAL — an env-consistency pin deliberately tighter
# than the shared guard. Pin it so it can't widen silently.
# =============================================================================


def test_assert_smoke_db_pins_the_db_to_the_wrangler_env():
    """The direct-D1 cleanup must hit exactly the db the target env owns,
    never another db and never prod."""
    booking_smoke.assert_smoke_db(smoke_lib.DEV_DB_ID, "dev")  # no raise
    for db_id, env in (
        (smoke_lib.PROD_DB_ID, "dev"),
        ("not-a-known-db", "dev"), (smoke_lib.DEV_DB_ID, "prod"),
    ):
        with pytest.raises(SystemExit):
            booking_smoke.assert_smoke_db(db_id, env)
    assert not hasattr(booking_smoke, "assert_dev_db")


def test_wrangler_envs_are_the_known_smoke_deployments():
    expected = ("dev",)
    assert booking_smoke.WRANGLER_ENVS == expected




# =============================================================================
# assert_url_matches_env (2026-09-17 final review, MUST-FIX): cross-checks
# SCHEDULER_URL against --wrangler-env before any Turnstile secret is
# swapped, so a mismatched pair can't swap one env's secret while probing
# another env's live booking page. Same shape as _smoke_lib's own
# assert_env_consistent (db_id <-> host), generalised to wrangler_env.
# =============================================================================


def test_assert_url_matches_env_accepts_the_dev_pair():
    booking_smoke.assert_url_matches_env("https://scheduler-dev.example.com", "dev")  # no raise


def test_assert_url_matches_env_skips_workers_dev_hosts_for_dev():
    booking_smoke.assert_url_matches_env(
        "https://weekly-scheduling-assistant-dev.someacct.workers.dev", "dev")  # no raise


def test_assert_url_matches_env_is_smoke_lib_assert_url_matches_env():
    assert booking_smoke.assert_url_matches_env is smoke_lib.assert_url_matches_env




# =============================================================================
# --provider / --wrangler-env (2026-09-17): booking-smoke on either provider.
# The Turnstile secret it restores is per env
# (TURNSTILE_SECRET_<ENV>), the D1 cleanup is pinned to that env's db, the
# calendar clients come from the provider factory, and preflight checks the
# bearer's provider — same shape as feed/poll/multiuser/meeting-smoke.
# =============================================================================


def test_booking_smoke_binds_the_shared_provider_primitives():
    assert booking_smoke.make_calendar_client is smoke_lib.make_calendar_client
    assert booking_smoke.preflight_whoami is smoke_lib.preflight_whoami
    # 2026-09-17 review fix: run_base_mode/run_decline_mode call
    # preflight_whoami directly now, so the old check_whoami/safe_json_body
    # bindings (never used elsewhere in this file) are gone.
    assert not hasattr(booking_smoke, "check_whoami")
    assert not hasattr(booking_smoke, "safe_json_body")


def test_booking_smoke_rsvps_through_the_provider_neutral_primitive():
    # 2026-09-17 review fix: decline mode's rsvp_invite binding (Google-only —
    # AttributeErrors on a GraphCalendarClient, and Graph gives each
    # attendee's copy a different event id from the organiser's anyway) is
    # gone; rsvp_as_attendee (bin/_smoke_lib.py) resolves that per provider.
    assert booking_smoke.rsvp_as_attendee is smoke_lib.rsvp_as_attendee
    assert not hasattr(booking_smoke, "rsvp_invite")


def test_turnstile_secret_var_follows_the_wrangler_env():
    assert booking_smoke.turnstile_secret_var("dev") == "TURNSTILE_SECRET_DEV"


def test_parse_args_provider_and_wrangler_env_defaults(monkeypatch):
    monkeypatch.delenv("SMOKE_PROVIDER", raising=False)
    monkeypatch.delenv("SMOKE_WRANGLER_ENV", raising=False)
    a = booking_smoke.parse_args([])
    assert (a.mode, a.provider, a.wrangler_env) == ("base", "google", "dev")
    monkeypatch.setenv("SMOKE_PROVIDER", "")          # shell artifact -> still google
    monkeypatch.setenv("SMOKE_WRANGLER_ENV", "")
    a = booking_smoke.parse_args([])
    assert (a.provider, a.wrangler_env) == ("google", "dev")
    # Microsoft runs against the same dev deployment as Google.
    monkeypatch.setenv("SMOKE_PROVIDER", "microsoft")
    a = booking_smoke.parse_args(["--mode", "decline"])
    assert (a.mode, a.provider, a.wrangler_env) == ("decline", "microsoft", "dev")
    a = booking_smoke.parse_args(["--provider", "google", "--wrangler-env", "dev"])
    assert (a.provider, a.wrangler_env) == ("google", "dev")
    with pytest.raises(SystemExit):
        booking_smoke.parse_args(["--provider", "outlook"])
    for env in ("prod", "staging"):
        with pytest.raises(SystemExit):
            booking_smoke.parse_args(["--wrangler-env", env])




def test_graph_sent_matches_filters_on_recipient_and_subject():
    """Graph's Sent Items read (GraphMailClient.list_sent_since) filters only
    on sentDateTime server-side; recipient + subject matching is the
    caller's, exactly as for poll-smoke's GraphReader. Recipient match is
    case-insensitive (Exchange returns addresses as the directory has them),
    subject is a substring match like the Gmail query's subject:"..."."""
    msgs = [
        {"subject": "Cancelled: your booking with Victor",
         "toRecipients": [{"emailAddress": {"address": "Bob@Example.com"}}]},
        {"subject": "Booking cancelled: Alice declined",
         "toRecipients": [{"emailAddress": {"address": "owner@example.com"}}]},
        {"subject": "unrelated", "toRecipients": []},
    ]
    assert booking_smoke.graph_sent_matches(msgs, "bob@example.com", "Cancelled: your")
    assert booking_smoke.graph_sent_matches(msgs, "owner@example.com", "Alice declined")
    assert not booking_smoke.graph_sent_matches(msgs, "owner@example.com", "Cancelled: your")
    assert not booking_smoke.graph_sent_matches(msgs, "nobody@example.com", "Cancelled")
    assert not booking_smoke.graph_sent_matches([], "bob@example.com", "Cancelled")


def test_cleanup_booking_row_manual_command_names_the_env(monkeypatch):
    monkeypatch.delenv("D1_DATABASE_ID", raising=False)
    did, msg = booking_smoke.cleanup_booking_row(Path("/repo"), "bk-1", "dev")
    assert did is False
    assert "--env dev" in msg and "d1 execute DB" in msg and "bk-1" in msg


def test_cleanup_booking_row_refuses_a_db_the_env_does_not_own(monkeypatch):
    for db_id in (smoke_lib.PROD_DB_ID, "not-a-known-db"):
        monkeypatch.setenv("D1_DATABASE_ID", db_id)
        with pytest.raises(SystemExit):
            booking_smoke.cleanup_booking_row(Path("/repo"), "bk-1", "dev")


def _fake_d1(seen: dict):
    class FakeD1:
        def __init__(self, repo_root, env_name="dev"):
            seen["env_name"] = env_name

        def execute(self, sql):
            seen["sql"] = sql
    return FakeD1


def test_cleanup_booking_row_hits_the_envs_binding(monkeypatch):
    monkeypatch.setenv("D1_DATABASE_ID", smoke_lib.DEV_DB_ID)
    seen: dict = {}
    monkeypatch.setattr(booking_smoke, "DevD1", _fake_d1(seen))
    did, msg = booking_smoke.cleanup_booking_row(Path("/repo"), "bk-1", "dev")
    assert did is True
    assert seen["env_name"] == "dev" and "bk-1" in seen["sql"]
    assert "(dev)" in msg




# =============================================================================
# Loading booking-smoke.py via importlib must execute only defs — main()
# stays __main__-guarded.
# =============================================================================


def test_loading_booking_smoke_module_has_no_side_effects():
    assert callable(booking_smoke.main)


# =============================================================================
# make_sent_reader / find_sent — Gmail (Google) vs Graph (Microsoft) readers
# for the decline mode's owner-Sent-folder detection, mirroring poll-smoke's
# make_mail_reader/GmailReader/GraphReader split (same purpose, narrowed to
# find_sent's boolean "did I see it" contract instead of a full message-body
# relay).
# =============================================================================


class _FakeGmailClientForReader:
    def __init__(self, results_by_query: dict):
        self._results = results_by_query
        self.queries: list[str] = []
        self.closed = False

    def list_messages(self, query):
        self.queries.append(query)
        return self._results.get(query, [])

    def close(self):
        self.closed = True


def test_gmail_sent_reader_find_sent_delegates_to_gmail_sent_query_and_list_messages():
    query = booking_smoke.gmail_sent_query("bob@example.com", "Cancelled: your", 1700000000)
    fake = _FakeGmailClientForReader({query: [{"id": "m1"}]})
    reader = booking_smoke.GmailSentReader(fake)

    assert reader.find_sent("bob@example.com", "Cancelled: your", 1700000000) is True
    assert fake.queries == [query]
    assert reader.find_sent("nobody@example.com", "Cancelled: your", 1700000000) is False
    reader.close()
    assert fake.closed is True


class _FakeGraphClientForReader:
    def __init__(self, messages: list):
        self._messages = messages
        self.calls: list[int] = []
        self.closed = False

    def list_sent_since(self, after_epoch):
        self.calls.append(after_epoch)
        return self._messages

    def close(self):
        self.closed = True


def test_graph_sent_reader_find_sent_delegates_to_list_sent_since_and_graph_sent_matches():
    messages = [{"subject": "Cancelled: your booking with Victor",
                 "toRecipients": [{"emailAddress": {"address": "Bob@Example.com"}}]}]
    fake = _FakeGraphClientForReader(messages)
    reader = booking_smoke.GraphSentReader(fake)

    assert reader.find_sent("bob@example.com", "Cancelled: your", 1700000000) is True
    assert fake.calls == [1700000000]
    assert reader.find_sent("nobody@example.com", "Cancelled: your", 1700000000) is False
    reader.close()
    assert fake.closed is True


def test_make_sent_reader_dispatches_on_provider():
    assert isinstance(booking_smoke.make_sent_reader(object(), "google"), booking_smoke.GmailSentReader)
    assert isinstance(booking_smoke.make_sent_reader(object(), "microsoft"), booking_smoke.GraphSentReader)
    with pytest.raises(ValueError):
        booking_smoke.make_sent_reader(object(), "outlook")


# =============================================================================
# _event_location: B8 reads the live calendar event's location text back.
# normalize_graph_event emits "location": None (never ""), so a bare
# .get("location", "") default never fires and `BOOKER_PHONE in None` raised
# TypeError on Microsoft. _event_location must coalesce None to "".
# =============================================================================


def test_event_location_coalesces_none_to_empty_string():
    assert booking_smoke._event_location({"location": None}) == ""


def test_event_location_returns_missing_key_as_empty_string():
    assert booking_smoke._event_location({}) == ""


def test_event_location_returns_the_real_string_unchanged():
    assert booking_smoke._event_location({"location": "+61 4 9876 5432"}) == "+61 4 9876 5432"


# =============================================================================
# run_base_mode / run_decline_mode: preflight GET /v1/whoami must abort
# (SystemExit) BEFORE install_turnstile_secret is ever called — there is
# nothing to restore yet at that point, so a wrong-provider/wrong-account
# bearer must never touch the target env's live TURNSTILE_SECRET. Same fake
# SchedulerClient shape as bin/test_feed_smoke_guard.py's preflight tests.
# =============================================================================


class _FakeResponseForPreflight:
    def __init__(self, status_code: int, body: dict):
        self.status_code = status_code
        self._body = body
        self.text = str(body)

    def json(self):
        return self._body


class _FakeSchedulerForPreflight:
    """Answers only GET /v1/whoami; anything else is a test failure — the
    preflight must abort before the harness issues its first real call."""
    instances: list["_FakeSchedulerForPreflight"] = []

    def __init__(self, ident, whoami_body: dict):
        self.ident = ident
        self.whoami_body = whoami_body
        self.calls: list[tuple[str, str]] = []
        self.closed = False
        _FakeSchedulerForPreflight.instances.append(self)

    def request(self, method: str, path: str, **kw):
        self.calls.append((method, path))
        assert (method, path) == ("GET", "/v1/whoami"), f"unexpected call {method} {path}"
        return _FakeResponseForPreflight(200, self.whoami_body)

    def close(self):
        self.closed = True


def _base_mode_env(monkeypatch):
    monkeypatch.setenv("SCHEDULER_URL", "https://scheduler-dev.example.com")
    monkeypatch.setenv("A_BEARER", "A" * 43)
    monkeypatch.setenv("A_REFRESH", "a" * 43)
    monkeypatch.setenv("A_EXPECTED_EMAIL", "a@example.com")
    monkeypatch.setenv("TURNSTILE_SECRET_DEV", "ts-secret")
    monkeypatch.delenv("D1_DATABASE_ID", raising=False)


def test_run_base_mode_aborts_in_preflight_before_installing_turnstile(monkeypatch):
    _base_mode_env(monkeypatch)
    _FakeSchedulerForPreflight.instances.clear()
    monkeypatch.setattr(
        booking_smoke, "SchedulerClient",
        lambda ident: _FakeSchedulerForPreflight(ident, {"email": "a@example.com", "provider": "google"}),
    )

    def _never(*a, **k):
        raise AssertionError("install_turnstile_secret must not run after a failed preflight")
    monkeypatch.setattr(booking_smoke, "install_turnstile_secret", _never)

    with pytest.raises(SystemExit) as exc:
        booking_smoke.run_base_mode("microsoft", "dev")
    assert "google" in str(exc.value) and "microsoft" in str(exc.value)
    assert _FakeSchedulerForPreflight.instances[0].calls == [("GET", "/v1/whoami")]
    assert _FakeSchedulerForPreflight.instances[0].closed is True


def test_run_base_mode_aborts_in_preflight_on_wrong_account(monkeypatch):
    _base_mode_env(monkeypatch)
    _FakeSchedulerForPreflight.instances.clear()
    monkeypatch.setattr(
        booking_smoke, "SchedulerClient",
        lambda ident: _FakeSchedulerForPreflight(ident, {"email": "someone-else@example.com", "provider": "google"}),
    )
    monkeypatch.setattr(
        booking_smoke, "install_turnstile_secret",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("unreachable")),
    )
    with pytest.raises(SystemExit) as exc:
        booking_smoke.run_base_mode("google", "dev")
    assert "someone-else@example.com" in str(exc.value)


def test_run_base_mode_validates_d1_database_id_before_the_preflight_and_turnstile_swap(monkeypatch):
    """2026-09-17 review fix: assert_smoke_db used to run only INSIDE
    cleanup_booking_row, called from the `finally` block — a mismatched db id
    then SystemExited OUT of that finally, skipping the rest of cleanup (the
    booking page left enabled, the CLEANUP summary never printed). It must be
    validated up front instead, before anything else runs at all."""
    _base_mode_env(monkeypatch)
    wrong_db = "not-a-known-db"
    monkeypatch.setenv("D1_DATABASE_ID", wrong_db)  # wrong for wrangler_env="dev"

    def _never(*a, **k):
        raise AssertionError("nothing past the D1 guard should run")
    monkeypatch.setattr(booking_smoke, "SchedulerClient", _never)
    monkeypatch.setattr(booking_smoke, "install_turnstile_secret", _never)

    with pytest.raises(SystemExit):
        booking_smoke.run_base_mode("google", "dev")


def test_run_base_mode_with_no_d1_database_id_set_reaches_preflight(monkeypatch):
    # D1_DATABASE_ID is optional for base mode — its absence must not block
    # the run at the new up-front guard.
    _base_mode_env(monkeypatch)
    _FakeSchedulerForPreflight.instances.clear()
    monkeypatch.setattr(
        booking_smoke, "SchedulerClient",
        lambda ident: _FakeSchedulerForPreflight(ident, {"email": "a@example.com", "provider": "google"}),
    )
    monkeypatch.setattr(
        booking_smoke, "install_turnstile_secret",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("stop right after a successful preflight")),
    )
    with pytest.raises(AssertionError):
        booking_smoke.run_base_mode("google", "dev")
    # The preflight's GET happened (and succeeded) before anything else —
    # cleanup's own best-effort PUT attempt in `finally` may append further
    # calls after the fact, so only the first call is pinned here.
    assert _FakeSchedulerForPreflight.instances[0].calls[0] == ("GET", "/v1/whoami")


def test_run_decline_mode_preflights_both_a_and_c_before_installing_turnstile(monkeypatch):
    monkeypatch.setenv("SCHEDULER_URL", "https://scheduler-dev.example.com")
    monkeypatch.setenv("D1_DATABASE_ID", smoke_lib.DEV_DB_ID)
    monkeypatch.setenv("A_BEARER", "A" * 43)
    monkeypatch.setenv("A_REFRESH", "a" * 43)
    monkeypatch.setenv("A_EXPECTED_EMAIL", "a@example.com")
    monkeypatch.setenv("C_BEARER", "C" * 43)
    monkeypatch.setenv("C_REFRESH", "c" * 43)
    monkeypatch.setenv("C_EXPECTED_EMAIL", "c@example.com")
    monkeypatch.setenv("TURNSTILE_SECRET_DEV", "ts-secret")

    instances: list[_FakeSchedulerForPreflight] = []

    def _make(ident):
        # A passes; C's whoami reports a DIFFERENT email than C_EXPECTED_EMAIL.
        body = {"email": ident.expected_email, "provider": "google"}
        if ident.expected_email == "c@example.com":
            body = {"email": "someone-else@example.com", "provider": "google"}
        fake = _FakeSchedulerForPreflight(ident, body)
        instances.append(fake)
        return fake
    monkeypatch.setattr(booking_smoke, "SchedulerClient", _make)

    def _never(*a, **k):
        raise AssertionError("install_turnstile_secret must not run after a failed preflight")
    monkeypatch.setattr(booking_smoke, "install_turnstile_secret", _never)

    with pytest.raises(SystemExit) as exc:
        booking_smoke.run_decline_mode("google", "dev")
    assert "someone-else@example.com" in str(exc.value)
    # Both A and C were constructed and preflighted — A passed, C caught the
    # mismatch.
    assert len(instances) == 2
    # 2026-09-17 review fix: A's SchedulerClient (owner_sched) must not leak
    # when C's preflight fails after A's already succeeded — both fakes are
    # closed, not just the one preflight_whoami closed on its own failure
    # path (C's).
    owner_fake, c_fake = instances
    assert owner_fake.closed is True
    assert c_fake.closed is True


# -- cleanup summary: no empty "NOT cleaned" header ----------------------------

def test_print_cleanup_summary_omits_the_not_cleaned_header_when_nothing_was_left(capsys):
    booking_smoke.print_cleanup_summary(["secret restored", "row deleted"], [])
    out = capsys.readouterr().out
    assert "CLEANUP — cleaned:" in out
    assert "  - secret restored" in out and "  - row deleted" in out
    assert "NOT cleaned" not in out


def test_print_cleanup_summary_lists_leftovers_under_the_not_cleaned_header(capsys):
    booking_smoke.print_cleanup_summary(["secret restored"], ["event still on calendar"])
    out = capsys.readouterr().out
    assert "CLEANUP — NOT cleaned:" in out
    assert "  - event still on calendar" in out


def test_both_modes_print_cleanup_through_the_shared_summary():
    src = (BIN / "booking-smoke.py").read_text()
    assert src.count("print_cleanup_summary(cleaned, not_cleaned)") == 2
    # The literal header lives only inside the helper, never inline in a mode.
    assert src.count('print("CLEANUP — NOT cleaned:")') == 1


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))
