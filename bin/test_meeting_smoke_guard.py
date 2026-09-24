#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27", "python-dateutil>=2.9", "rich>=13.7"]
# ///
"""Guard for bin/meeting-smoke.py's provider axis (WP4,
internal design notes): the harness gains --provider
{google,microsoft}, a whoami preflight guard shared with bin/multiuser-
smoke.py, and calendar clients built via _smoke_lib.make_calendar_client so
level code never sees a provider. Modelled on bin/test_multiuser_smoke_guard.py.

Run: uv run bin/test_meeting_smoke_guard.py
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import httpx
import pytest

BIN = Path(__file__).parent


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, BIN / filename)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


ms = _load("meeting_smoke_guard_test", "meeting-smoke.py")
smoke_lib = ms._smoke_lib


def test_binds_the_shared_guards():
    assert smoke_lib.__file__ == str((BIN / "_smoke_lib.py").resolve())
    assert ms.assert_dev_url is smoke_lib.assert_dev_url
    assert ms.assert_dev_db is smoke_lib.assert_dev_db


def test_self_test_still_passes():
    assert ms.self_test() == 0


# --- --provider (WP4): argparse flag, whoami guard, calendar-client wiring --

def test_calendar_client_module_binding_removed():
    # The Google-only `CalendarClient = _smoke_lib.CalendarClient` module
    # binding is gone (mirrors bin/multiuser-smoke.py's WP3 change): run_live
    # now goes through _smoke_lib.make_calendar_client(sched, provider), so
    # level code's type hints use a duck-typed alias instead.
    assert not hasattr(ms, "CalendarClient")
    assert ms.CalendarClientLike == (smoke_lib.CalendarClient | smoke_lib.GraphCalendarClient)


def test_check_whoami_is_the_shared_helper():
    # WP4's suggested refactor: bin/multiuser-smoke.py's check_whoami became
    # a thin binding to _smoke_lib.check_whoami_body; bin/meeting-smoke.py
    # uses the SAME shared helper directly rather than re-implementing it.
    assert ms.check_whoami is smoke_lib.check_whoami_body


def test_check_whoami_matching_email_and_provider_is_no_error_no_warning():
    body = {"email": "c@x.example", "provider": "microsoft"}
    assert ms.check_whoami(body, "c@x.example", "microsoft", "C") == (None, None)


def test_check_whoami_provider_mismatch_names_both():
    body = {"email": "c@x.example", "provider": "google"}
    err, warning = ms.check_whoami(body, "c@x.example", "microsoft", "C")
    assert warning is None
    assert err is not None and "google" in err and "microsoft" in err


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


def _menv(labels_and_emails: dict[str, str]) -> "ms.MeetingEnv":
    identities = {
        l: smoke_lib.Identity(
            scheduler_url="https://scheduler-dev.example.com",
            bearer="x", refresh_token="x", expected_email=email,
        )
        for l, email in labels_and_emails.items()
    }
    return ms.MeetingEnv(identities=identities, d1_database_id=smoke_lib.DEV_DB_ID,
                         repo_root=BIN.parent)


def test_preflight_passes_when_all_identities_match():
    menv = _menv({"B": "b@x.example", "C": "c@x.example"})
    sched = {
        "B": _FakeSched({"email": "b@x.example", "provider": "microsoft"}),
        "C": _FakeSched({"email": "c@x.example", "provider": "microsoft"}),
    }
    ms.preflight(menv, sched, "microsoft")  # must not raise


def test_preflight_raises_on_provider_mismatch():
    menv = _menv({"B": "b@x.example", "C": "c@x.example"})
    sched = {
        "B": _FakeSched({"email": "b@x.example", "provider": "microsoft"}),
        "C": _FakeSched({"email": "c@x.example", "provider": "google"}),
    }
    with pytest.raises(SystemExit) as exc_info:
        ms.preflight(menv, sched, "microsoft")
    assert "identity C" in str(exc_info.value)


def test_preflight_prints_one_warning_line_per_identity_when_provider_is_absent(capsys):
    menv = _menv({"B": "b@x.example", "C": "c@x.example"})
    sched = {
        "B": _FakeSched({"email": "b@x.example"}),
        "C": _FakeSched({"email": "c@x.example"}),
    }
    ms.preflight(menv, sched, "google")
    err = capsys.readouterr().err
    assert err.count("provider field") == 2
    assert "identity B" in err and "identity C" in err


def test_argparse_provider_flag_defaults_to_google(monkeypatch):
    monkeypatch.delenv("SMOKE_PROVIDER", raising=False)
    parser_args = _parse(["--accounts", "2"])
    assert parser_args.provider == "google"


def test_argparse_provider_honours_smoke_provider_env(monkeypatch):
    monkeypatch.setenv("SMOKE_PROVIDER", "microsoft")
    parser_args = _parse([])
    assert parser_args.provider == "microsoft"


def test_argparse_provider_flag_overrides_env(monkeypatch):
    monkeypatch.setenv("SMOKE_PROVIDER", "google")
    parser_args = _parse(["--provider", "microsoft"])
    assert parser_args.provider == "microsoft"


def test_argparse_provider_rejects_unknown_value(monkeypatch):
    monkeypatch.delenv("SMOKE_PROVIDER", raising=False)
    with pytest.raises(SystemExit):
        _parse(["--provider", "yahoo"])


def _parse(argv: list[str]):
    return ms.build_parser().parse_args(argv)


def _build_parser():
    return ms.build_parser()


def test_dry_run_prints_the_provider(monkeypatch, capsys):
    for k in ("SCHEDULER_URL", "B_BEARER", "B_REFRESH", "B_EXPECTED_EMAIL",
              "C_BEARER", "C_REFRESH", "C_EXPECTED_EMAIL", "D1_DATABASE_ID"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("SCHEDULER_URL", "https://scheduler-dev.example.com")
    for l in ("B", "C"):
        monkeypatch.setenv(f"{l}_BEARER", "x")
        monkeypatch.setenv(f"{l}_REFRESH", "x")
        monkeypatch.setenv(f"{l}_EXPECTED_EMAIL", f"{l.lower()}@x.example")
    monkeypatch.setenv("D1_DATABASE_ID", smoke_lib.DEV_DB_ID)
    monkeypatch.setattr(ms, "preflight", lambda *a, **k: None)
    args = _build_parser().parse_args(["--accounts", "2", "--dry-run", "--provider", "microsoft"])
    rc = ms.run_live(args)
    assert rc == 0
    err = capsys.readouterr().err
    assert "microsoft" in err


def test_run_live_builds_calendar_clients_via_make_calendar_client(monkeypatch):
    for k in ("SCHEDULER_URL", "B_BEARER", "B_REFRESH", "B_EXPECTED_EMAIL",
              "C_BEARER", "C_REFRESH", "C_EXPECTED_EMAIL", "D1_DATABASE_ID"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("SCHEDULER_URL", "https://scheduler-dev.example.com")
    for l in ("B", "C"):
        monkeypatch.setenv(f"{l}_BEARER", "x")
        monkeypatch.setenv(f"{l}_REFRESH", "x")
        monkeypatch.setenv(f"{l}_EXPECTED_EMAIL", f"{l.lower()}@x.example")
    monkeypatch.setenv("D1_DATABASE_ID", smoke_lib.DEV_DB_ID)
    monkeypatch.setattr(ms, "preflight", lambda *a, **k: None)
    calls: list[str] = []
    real = smoke_lib.make_calendar_client

    def spy(sched, provider):
        calls.append(provider)
        return real(sched, provider)

    monkeypatch.setattr(smoke_lib, "make_calendar_client", spy)
    args = _build_parser().parse_args(["--accounts", "2", "--dry-run", "--provider", "microsoft"])
    rc = ms.run_live(args)
    assert rc == 0
    assert calls == ["microsoft", "microsoft"]


# --- visibility capture/restore sequence (WP4 review fix #6) ----------------
# hermetic_setup must snapshot each owner's Graph visibility BEFORE its own
# startup_sweep runs (which unconditionally sets it to "none" to clear a
# crashed prior run's stray state), and hermetic_teardown must restore
# exactly that snapshot — otherwise one run permanently narrows a tenant's
# real sharing default. Exercised over a real GraphCalendarClient on an
# httpx.MockTransport, not just spies, to prove the actual HTTP round trip.

class _FakeTaskSched:
    """Just enough of SchedulerClient for startup_sweep's delete_mtgsmoke_
    tasks call (GET /v1/tasks) and GraphCalendarClient's token fetch
    (GET /v1/calendar-access-token)."""

    def request(self, method, path, **kw):
        if path == "/v1/calendar-access-token":
            body = {"access_token": "graph-tok"}
        elif path == "/v1/tasks":
            body = {"tasks": []}
        else:
            body = {}
        return httpx.Response(200, json=body, request=httpx.Request(method, f"https://sched{path}"))


def test_startup_sweep_then_restore_round_trips_graph_visibility_via_mocktransport():
    permissions_state = {"role": "limitedRead"}

    def handler(req: httpx.Request):
        if req.url.path.endswith("/v1/tasks"):
            return httpx.Response(200, json={"tasks": []})
        if req.url.path.endswith("/me/calendar/calendarPermissions") and req.method == "GET":
            return httpx.Response(200, json={"value": [
                {"id": "perm-org-default", "role": permissions_state["role"],
                 "isInsideOrganization": True, "isRemovable": False,
                 "emailAddress": {"name": "My Organization"}},
            ]})
        if req.url.path.endswith("/calendarPermissions/perm-org-default") and req.method == "PATCH":
            permissions_state["role"] = json.loads(req.content)["role"]
            return httpx.Response(200, json={})
        raise AssertionError(f"unexpected request {req.method} {req.url.path}")

    fake_sched = _FakeTaskSched()
    graph_cal = smoke_lib.GraphCalendarClient(fake_sched)
    graph_cal._client = httpx.Client(transport=httpx.MockTransport(handler))

    menv = _menv({"B": "b@x.example"})
    sched = {"B": fake_sched}
    cal = {"B": graph_cal}

    # 1. hermetic_setup's capture, BEFORE startup_sweep runs.
    baseline = {l: cal[l].snapshot_visibility() for l in menv.labels}
    assert baseline["B"] == "limitedRead"

    # 2. startup_sweep (Graph's list_freebusy_grantees always returns the
    #    "<org-default>" sentinel when role != "none", so this unconditionally
    #    clears it — the exact behaviour review fix #6 is about).
    ms.startup_sweep(menv, sched, cal)
    assert permissions_state["role"] == "none"

    # 3. hermetic_teardown's restore — must put back the EXACT original role,
    #    not a coarser "freeBusyRead" stand-in.
    for label, snapshot in baseline.items():
        cal[label].restore_visibility(snapshot)
    assert permissions_state["role"] == "limitedRead"


class _RejectingSched:
    def request(self, method, path):
        raise smoke_lib.RefreshRejected(expected_email="c@x.example", status=400, error="invalid_grant")


def test_preflight_turns_a_refresh_rejection_into_a_clean_exit_naming_the_label():
    menv = _menv({"B": "b@x.example", "C": "c@x.example"})
    sched = {
        "B": _FakeSched({"email": "b@x.example", "provider": "microsoft"}),
        "C": _RejectingSched(),
    }
    with pytest.raises(SystemExit) as ei:
        ms.preflight(menv, sched, "microsoft")
    msg = str(ei.value)
    assert msg.startswith("identity C (c@x.example): refresh token rejected")
    assert "mu-smoke-login.py C --provider microsoft" in msg


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, *sys.argv[1:]]))
