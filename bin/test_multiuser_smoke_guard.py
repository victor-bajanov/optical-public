#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27", "python-dateutil>=2.9", "rich>=13.7"]
# ///
"""Guard for bin/multiuser-smoke.py's env guards (2026-09-02): the harness
binds the SHARED _smoke_lib primitives — assert_dev_url (it had NO url guard
before: only the db was checked), assert_dev_db (prod denied),
assert_env_consistent, and the env-aware DevD1 via d1_for_db_id — instead of
its own dev-only copies with `wrangler d1 execute scheduler-dev --env dev`
hardcoded.

Run: uv run bin/test_multiuser_smoke_guard.py
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


mu = _load("multiuser_smoke_guard_test", "multiuser-smoke.py")
smoke_lib = mu._smoke_lib


def test_binds_the_shared_guards():
    assert smoke_lib.__file__ == str((BIN / "_smoke_lib.py").resolve())
    assert mu.assert_dev_url is smoke_lib.assert_dev_url
    assert mu.assert_dev_db is smoke_lib.assert_dev_db
    assert mu.assert_env_consistent is smoke_lib.assert_env_consistent
    assert mu.DevD1 is smoke_lib.DevD1
    assert mu.d1_for_db_id is smoke_lib.d1_for_db_id


def _set_env(monkeypatch, url: str, db_id: str) -> None:
    for k in ("SCHEDULER_URL", "A_BEARER", "A_REFRESH", "A_EXPECTED_EMAIL",
              "B_BEARER", "B_REFRESH", "B_EXPECTED_EMAIL", "D1_DATABASE_ID", "SMOKE_WRANGLER_ENV"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("SCHEDULER_URL", url)
    for k in ("A_BEARER", "A_REFRESH", "B_BEARER", "B_REFRESH"):
        monkeypatch.setenv(k, "x")
    monkeypatch.setenv("A_EXPECTED_EMAIL", "a@x.example")
    monkeypatch.setenv("B_EXPECTED_EMAIL", "b@x.example")
    monkeypatch.setenv("D1_DATABASE_ID", db_id)


def test_env_refuses_the_prod_url(monkeypatch):
    _set_env(monkeypatch, "https://scheduler.example.com", smoke_lib.DEV_DB_ID)
    with pytest.raises(SystemExit):
        mu.MultiEnv.from_environ()


def test_env_refuses_the_prod_db(monkeypatch):
    _set_env(monkeypatch, "https://scheduler-dev.example.com", smoke_lib.PROD_DB_ID)
    with pytest.raises(SystemExit):
        mu.MultiEnv.from_environ()




def test_env_on_dev_routes_d1_to_the_dev_binding(monkeypatch):
    _set_env(monkeypatch, "https://scheduler-dev.example.com", smoke_lib.DEV_DB_ID)
    assert mu.MultiEnv.from_environ().d1().env_name == "dev"


def test_self_test_still_passes():
    assert mu.self_test() == 0


# --- --provider (WP3): whoami guard, argparse flag, calendar-client wiring --

def test_check_whoami_matching_email_and_provider_is_no_error_no_warning():
    body = {"email": "a@x.example", "provider": "microsoft"}
    assert mu.check_whoami(body, "a@x.example", "microsoft", "A") == (None, None)


def test_check_whoami_wrong_email_names_both():
    body = {"email": "wrong@x.example", "provider": "google"}
    err, warning = mu.check_whoami(body, "a@x.example", "google", "A")
    assert warning is None
    assert err is not None
    assert "wrong@x.example" in err and "a@x.example" in err


def test_check_whoami_provider_mismatch_names_both():
    body = {"email": "a@x.example", "provider": "google"}
    err, warning = mu.check_whoami(body, "a@x.example", "microsoft", "A")
    assert warning is None
    assert err is not None
    assert "google" in err and "microsoft" in err


def test_check_whoami_body_without_provider_is_a_warning_not_an_error():
    # Old worker, pre WP0 (no `provider` field on whoami yet) — can't tell,
    # so surface it as a non-fatal warning instead of blocking the run.
    body = {"email": "a@x.example"}
    err, warning = mu.check_whoami(body, "a@x.example", "microsoft", "A")
    assert err is None
    assert warning is not None and "provider" in warning


def test_check_whoami_case_only_email_difference_is_a_specific_failure():
    # expected_email is used VERBATIM as a D1 subject key elsewhere in this
    # harness — M4's business-hours/home_tz rows, M7's precondition counts,
    # offboard payload, audit-actor compare and reactivation UPDATE, M8's
    # calendar_sync query — and SQLite `=` on TEXT is case-sensitive. A
    # case-only difference between whoami's email and expected_email (e.g. a
    # mixed-case Entra UPN) must therefore FAIL preflight with a message
    # naming the exact env var to fix, not silently pass as before: passing
    # it here would let M7 fail deep inside with "B has no tasks to purge",
    # or worse, leave B deactivated when the reactivation UPDATE in the
    # finally block matches zero rows.
    # The message must name BOTH ways that casing is actually sourced under
    # the runner: config.toml's [google]/[microsoft].<l> (which the runner
    # projects onto <L>_EXPECTED_EMAIL, so telling the operator to edit the
    # env var directly would be overwritten on the next run) and the env var
    # itself, for anyone running the harness directly without the runner.
    body = {"email": "A@X.EXAMPLE", "provider": "google"}
    err, warning = mu.check_whoami(body, "a@x.example", "google", "B")
    assert warning is None
    assert err is not None
    assert "A@X.EXAMPLE" in err
    assert "config.toml" in err
    assert "[google]" in err or "[microsoft]" in err
    assert "B_EXPECTED_EMAIL" in err


def test_check_whoami_exact_case_match_is_fine():
    body = {"email": "a@x.example", "provider": "google"}
    assert mu.check_whoami(body, "a@x.example", "google", "A") == (None, None)


def test_parse_args_provider_defaults_to_google(monkeypatch):
    monkeypatch.delenv("SMOKE_PROVIDER", raising=False)
    args = mu.parse_args(["--levels", "1"])
    assert args.provider == "google"


def test_parse_args_provider_honours_smoke_provider_env(monkeypatch):
    monkeypatch.setenv("SMOKE_PROVIDER", "microsoft")
    args = mu.parse_args([])
    assert args.provider == "microsoft"


def test_parse_args_provider_falls_back_to_google_when_smoke_provider_is_empty(monkeypatch):
    # An exported-but-empty SMOKE_PROVIDER (e.g. `export SMOKE_PROVIDER=`)
    # must not bypass argparse's choices= validation by handing it "" as the
    # default straight from os.environ.get.
    monkeypatch.setenv("SMOKE_PROVIDER", "")
    args = mu.parse_args([])
    assert args.provider == "google"


def test_parse_args_provider_rejects_unknown_value(monkeypatch, capsys):
    monkeypatch.delenv("SMOKE_PROVIDER", raising=False)
    with pytest.raises(SystemExit):
        mu.parse_args(["--provider", "yahoo"])


def test_parse_args_provider_flag_overrides_env(monkeypatch):
    monkeypatch.setenv("SMOKE_PROVIDER", "google")
    args = mu.parse_args(["--provider", "microsoft"])
    assert args.provider == "microsoft"


def test_calendar_client_module_binding_removed():
    # The Google-only `CalendarClient = _smoke_lib.CalendarClient` module
    # binding is gone; run_live now goes through _smoke_lib.make_calendar_
    # client(sched, provider) so it can hand back either client.
    assert not hasattr(mu, "CalendarClient")


def test_run_live_builds_calendar_clients_via_make_calendar_client(monkeypatch, capsys):
    _set_env(monkeypatch, "https://scheduler-dev.example.com", smoke_lib.DEV_DB_ID)
    monkeypatch.setattr(mu, "preflight", lambda *a, **k: None)
    calls: list[str] = []
    real = smoke_lib.make_calendar_client

    def spy(sched, provider):
        calls.append(provider)
        return real(sched, provider)

    monkeypatch.setattr(smoke_lib, "make_calendar_client", spy)
    args = mu.parse_args(["--levels", "1", "--dry-run", "--provider", "microsoft"])
    rc = mu.run_live(args)
    assert rc == 0
    assert calls == ["microsoft", "microsoft"]


def test_dry_run_prints_the_provider(monkeypatch, capsys):
    _set_env(monkeypatch, "https://scheduler-dev.example.com", smoke_lib.DEV_DB_ID)
    monkeypatch.setattr(mu, "preflight", lambda *a, **k: None)
    args = mu.parse_args(["--levels", "1", "--dry-run", "--provider", "microsoft"])
    rc = mu.run_live(args)
    assert rc == 0
    err = capsys.readouterr().err
    assert "microsoft" in err


class _FakeResp:
    def __init__(self, body: dict):
        self._body = body

    def raise_for_status(self):
        return None

    def json(self):
        return self._body


class _FakeSched:
    def __init__(self, body: dict):
        self._body = body

    def request(self, method, path):
        return _FakeResp(self._body)


def test_preflight_raises_on_provider_mismatch(monkeypatch):
    _set_env(monkeypatch, "https://scheduler-dev.example.com", smoke_lib.DEV_DB_ID)
    menv = mu.MultiEnv.from_environ()

    # A matches; only B is on the wrong provider — a preflight that checked
    # just one identity (e.g. only A, or always the last-seen response)
    # would incorrectly pass this.
    sched_a = _FakeSched({"email": menv.a.expected_email, "provider": "microsoft"})
    sched_b = _FakeSched({"email": menv.b.expected_email, "provider": "google"})
    with pytest.raises(SystemExit) as exc_info:
        mu.preflight(menv, sched_a, sched_b, "microsoft")
    assert "identity B" in str(exc_info.value)


def test_preflight_passes_when_both_identities_match(monkeypatch):
    _set_env(monkeypatch, "https://scheduler-dev.example.com", smoke_lib.DEV_DB_ID)
    menv = mu.MultiEnv.from_environ()
    sched_a = _FakeSched({"email": menv.a.expected_email, "provider": "microsoft"})
    sched_b = _FakeSched({"email": menv.b.expected_email, "provider": "microsoft"})
    mu.preflight(menv, sched_a, sched_b, "microsoft")  # must not raise


def test_preflight_prints_one_warning_line_per_identity_when_provider_is_absent(
    monkeypatch, capsys
):
    _set_env(monkeypatch, "https://scheduler-dev.example.com", smoke_lib.DEV_DB_ID)
    menv = mu.MultiEnv.from_environ()
    sched_a = _FakeSched({"email": menv.a.expected_email})
    sched_b = _FakeSched({"email": menv.b.expected_email})
    mu.preflight(menv, sched_a, sched_b, "google")
    err = capsys.readouterr().err
    assert err.count("provider field") == 2
    assert "identity A" in err and "identity B" in err


# -- M8 renewal verdict: provider-aware (Google rotates, Graph renews in place) --

from datetime import datetime, timedelta, timezone as _tz

_THU = datetime(2026, 9, 17, 7, 0, tzinfo=_tz.utc)   # a weekday
_SUN = datetime(2026, 9, 20, 7, 0, tzinfo=_tz.utc)   # UTC Sunday (forced rotate)
_FUTURE = _THU + timedelta(days=2)


def test_multienv_carries_the_provider_defaulting_to_google(monkeypatch):
    _set_env(monkeypatch, "https://scheduler-dev.example.com", smoke_lib.DEV_DB_ID)
    assert mu.MultiEnv.from_environ().provider == "google"
    assert mu.MultiEnv.from_environ(provider="microsoft").provider == "microsoft"


def test_run_live_threads_the_cli_provider_into_multienv(monkeypatch):
    _set_env(monkeypatch, "https://scheduler-dev.example.com", smoke_lib.DEV_DB_ID)
    seen: list[str] = []

    def spy(menv, sa, sb, provider):
        seen.append(menv.provider)

    monkeypatch.setattr(mu, "preflight", spy)
    args = mu.parse_args(["--levels", "1", "--dry-run", "--provider", "microsoft"])
    assert mu.run_live(args) == 0
    assert seen == ["microsoft"]


def test_m8_renewal_verdict_google_requires_rotation():
    assert mu.m8_renewal_verdict("google", "old", "new", _FUTURE, now=_THU) is None
    msg = mu.m8_renewal_verdict("google", "old", "old", _FUTURE, now=_THU)
    assert msg and "not rotated" in msg


def test_m8_renewal_verdict_microsoft_weekday_renews_in_place():
    assert mu.m8_renewal_verdict("microsoft", "old", "old", _FUTURE, now=_THU) is None
    msg = mu.m8_renewal_verdict("microsoft", "old", "new", _FUTURE, now=_THU)
    assert msg and "in place" in msg and "rotated" in msg


def test_m8_renewal_verdict_microsoft_utc_sunday_forces_rotation():
    assert mu.m8_renewal_verdict("microsoft", "old", "new", _SUN + timedelta(days=2), now=_SUN) is None
    msg = mu.m8_renewal_verdict("microsoft", "old", "old", _SUN + timedelta(days=2), now=_SUN)
    assert msg and "Sunday" in msg and "not rotated" in msg


def test_m8_renewal_verdict_rejects_a_stale_expiry_for_either_provider():
    stale = _THU - timedelta(minutes=5)
    for provider, new in (("google", "new"), ("microsoft", "old")):
        msg = mu.m8_renewal_verdict(provider, "old", new, stale, now=_THU)
        assert msg and "expired" in msg, (provider, msg)


class _M8D1:
    """calendar_sync rows for B: channel id fixed (in-place renew), expiry refreshed."""

    def __init__(self, channel_after: str):
        self.channel_after = channel_after
        self.executed: list[str] = []
        self._queries = 0

    def query(self, sql):
        self._queries += 1
        cid = "chan-old" if self._queries == 1 else self.channel_after
        return [{"channel_id": cid,
                 "channel_expires_at": (datetime.now(tz=_tz.utc) + timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%S.000Z")}]

    def execute(self, sql):
        self.executed.append(sql)


class _M8Resp:
    status_code = 200
    text = ""

    def raise_for_status(self):
        pass

    def json(self):
        return {"ok": True, "renewed": 1}


class _M8Sched:
    def request(self, *a, **k):
        return _M8Resp()


def _menv_with_provider(monkeypatch, provider):
    _set_env(monkeypatch, "https://scheduler-dev.example.com", smoke_lib.DEV_DB_ID)
    return mu.MultiEnv.from_environ(provider=provider)


def test_run_m8_accepts_an_in_place_renewal_when_the_provider_is_microsoft(monkeypatch):
    menv = _menv_with_provider(monkeypatch, "microsoft")
    if datetime.now(tz=_tz.utc).weekday() == 6:
        pytest.skip("UTC Sunday: the sweep forces a rotate, in-place is not expected")
    d1 = _M8D1(channel_after="chan-old")
    mu.run_m8(menv, d1, _M8Sched(), _M8Sched(), None, None)   # no AssertionError
    assert any("channel_expires_at" in q for q in d1.executed)


def test_run_m8_still_demands_rotation_when_the_provider_is_google(monkeypatch):
    menv = _menv_with_provider(monkeypatch, "google")
    d1 = _M8D1(channel_after="chan-old")
    with pytest.raises(AssertionError, match="not rotated"):
        mu.run_m8(menv, d1, _M8Sched(), _M8Sched(), None, None)


class _RejectingSched:
    def request(self, method, path):
        raise smoke_lib.RefreshRejected(expected_email="b@x.example", status=400, error="invalid_grant")


def test_preflight_turns_a_refresh_rejection_into_a_clean_exit_naming_the_label(monkeypatch):
    _set_env(monkeypatch, "https://scheduler-dev.example.com", smoke_lib.DEV_DB_ID)
    menv = mu.MultiEnv.from_environ()
    sched_a = _FakeSched({"email": menv.a.expected_email, "provider": "microsoft"})
    with pytest.raises(SystemExit) as ei:
        mu.preflight(menv, sched_a, _RejectingSched(), "microsoft")
    msg = str(ei.value)
    assert msg.startswith("identity B (b@x.example): refresh token rejected")
    assert "mu-smoke-login.py B --provider microsoft" in msg


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, *sys.argv[1:]]))
