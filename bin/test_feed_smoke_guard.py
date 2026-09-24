#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27"]
# ///
"""Guard for bin/feed-smoke.py's dev-url/req guard: proves it binds the
SHARED _smoke_lib primitives rather than re-declaring its own drifted copy.

Before this fix, feed-smoke.py carried a local assert_dev_url/req pair
(bin/feed-smoke.py:53-76) that was fail-open on prod's own workers.dev
subdomain (weekly-scheduling-assistant.*.workers.dev) — the exact drift class
_smoke_lib.assert_dev_url's own docstring warns about (see D1/m1 in
bin/test_smoke_lib_guards.py). Behaviour gained by switching to the shared
import: prod's own workers.dev subdomain becomes REFUSED.

Run: uv run bin/test_feed_smoke_guard.py
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


feed_smoke = _load("feed_smoke_guard_test", "feed-smoke.py")
# feed-smoke.py loads _smoke_lib.py itself via importlib (module name
# "_smoke_lib") and stores that exact module instance as its own
# `_smoke_lib` global — reuse THAT instance rather than loading a second,
# separate copy, or the `is` identity checks below would compare two
# different exec'd modules and never pass regardless of what feed-smoke.py
# binds its functions to.
smoke_lib = feed_smoke._smoke_lib


# =============================================================================
# feed-smoke binds the shared _smoke_lib primitives — not local copies
# =============================================================================


def test_feed_smoke_assert_dev_url_is_smoke_lib_assert_dev_url():
    assert feed_smoke.assert_dev_url is smoke_lib.assert_dev_url
    # `is` alone proves same-instance, not that the instance IS the repo's
    # shared lib — a decoy module assigned to feed_smoke._smoke_lib would
    # pass the check above too. Pin the file path as well.
    assert smoke_lib.__file__ == str((BIN / "_smoke_lib.py").resolve())


def test_feed_smoke_req_is_smoke_lib_req():
    assert feed_smoke.req is smoke_lib.req
    assert smoke_lib.__file__ == str((BIN / "_smoke_lib.py").resolve())


# =============================================================================
# Behavioural spot-checks through the feed-smoke binding (proves the identity
# check above actually buys the fixed behaviour, not just object equality)
# =============================================================================


def test_dev_host_accepted():
    feed_smoke.assert_dev_url("https://scheduler-dev.example.com")  # no raise




def test_prod_host_refused():
    with pytest.raises(SystemExit):
        feed_smoke.assert_dev_url("https://scheduler.example.com")


def test_prod_own_workers_dev_subdomain_refused():
    # Behaviour fix: the local copy's blanket "*.workers.dev" rule was
    # fail-open on prod's own workers.dev subdomain — the shared guard
    # refuses this exact worker name.
    with pytest.raises(SystemExit):
        feed_smoke.assert_dev_url("https://weekly-scheduling-assistant.someacct.workers.dev")


def test_other_workers_dev_subdomain_accepted():
    feed_smoke.assert_dev_url("https://weekly-scheduling-assistant-dev.someacct.workers.dev")  # no raise


# =============================================================================
# Loading feed-smoke.py via importlib must execute only defs — main() stays
# __main__-guarded (no network call, no sys.exit from module-level code).
# =============================================================================


def test_loading_feed_smoke_module_has_no_side_effects():
    # If import execution reached anything beyond function/class defs (e.g.
    # an unguarded main() call), _load() above would already have raised or
    # exited before this test file finished collecting. Assert main is
    # present but was NOT invoked as a side effect of the import.
    assert callable(feed_smoke.main)


# =============================================================================
# --provider (2026-09-17): feed-smoke runs on either provider — the busy feed
# reads the owner's calendar through the worker's provider abstraction, so
# the harness creates its F2 hold through the matching client and guards the
# bearer's provider in preflight, exactly like poll/multiuser/meeting-smoke.
# =============================================================================


def test_feed_smoke_binds_the_shared_provider_primitives():
    assert feed_smoke.make_calendar_client is smoke_lib.make_calendar_client
    # 2026-09-17 review fix: the preflight itself (not just check_whoami_body)
    # is now shared with bin/booking-smoke.py, which used to carry a verbatim
    # duplicate. main() calls preflight_whoami directly now, so the old
    # check_whoami/safe_json_body bindings (never used elsewhere) are gone.
    assert feed_smoke.preflight_whoami is smoke_lib.preflight_whoami
    assert not hasattr(feed_smoke, "check_whoami")
    assert not hasattr(feed_smoke, "safe_json_body")


def test_parse_args_provider_defaults_to_google_and_honours_smoke_provider(monkeypatch):
    monkeypatch.delenv("SMOKE_PROVIDER", raising=False)
    assert feed_smoke.parse_args([]).provider == "google"
    # SMOKE_PROVIDER="" (a common shell artifact) must not bypass `choices`
    monkeypatch.setenv("SMOKE_PROVIDER", "")
    assert feed_smoke.parse_args([]).provider == "google"
    monkeypatch.setenv("SMOKE_PROVIDER", "microsoft")
    assert feed_smoke.parse_args([]).provider == "microsoft"
    assert feed_smoke.parse_args(["--provider", "google"]).provider == "google"
    with pytest.raises(SystemExit):
        feed_smoke.parse_args(["--provider", "outlook"])


class _FakeResponse:
    def __init__(self, status_code: int, body: dict):
        self.status_code = status_code
        self._body = body
        self.text = __import__("json").dumps(body)

    def json(self):
        return self._body


class _FakeScheduler:
    """Answers only GET /v1/whoami; anything else is a test failure — the
    preflight must abort before the harness issues its first real call."""
    instances: list["_FakeScheduler"] = []

    def __init__(self, ident, whoami_body: dict):
        self.ident = ident
        self.whoami_body = whoami_body
        self.calls: list[tuple[str, str]] = []
        self.closed = False
        _FakeScheduler.instances.append(self)

    def request(self, method: str, path: str, **kw):
        self.calls.append((method, path))
        assert (method, path) == ("GET", "/v1/whoami"), f"unexpected call {method} {path}"
        return _FakeResponse(200, self.whoami_body)

    def close(self):
        self.closed = True


def _preflight_env(monkeypatch):
    monkeypatch.setenv("SCHEDULER_URL", "https://scheduler-dev.example.com")
    monkeypatch.setenv("A_BEARER", "A" * 43)
    monkeypatch.setenv("A_REFRESH", "a" * 43)
    monkeypatch.setenv("A_EXPECTED_EMAIL", "a@example.com")
    monkeypatch.delenv("SMOKE_PROVIDER", raising=False)


def test_main_aborts_in_preflight_when_the_bearer_is_the_other_provider(monkeypatch):
    _preflight_env(monkeypatch)
    _FakeScheduler.instances.clear()
    monkeypatch.setattr(feed_smoke, "SchedulerClient",
                        lambda ident: _FakeScheduler(ident, {"email": "a@example.com", "provider": "google"}))

    def _never(*a, **k):
        raise AssertionError("make_calendar_client must not be reached after a failed preflight")
    monkeypatch.setattr(feed_smoke, "make_calendar_client", _never)

    with pytest.raises(SystemExit) as exc:
        feed_smoke.main(["--provider", "microsoft"])
    assert "google" in str(exc.value) and "microsoft" in str(exc.value)
    assert _FakeScheduler.instances[0].calls == [("GET", "/v1/whoami")]


def test_main_aborts_in_preflight_on_wrong_account(monkeypatch):
    _preflight_env(monkeypatch)
    _FakeScheduler.instances.clear()
    monkeypatch.setattr(feed_smoke, "SchedulerClient",
                        lambda ident: _FakeScheduler(ident, {"email": "someone-else@example.com", "provider": "google"}))
    monkeypatch.setattr(feed_smoke, "make_calendar_client",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("unreachable")))
    with pytest.raises(SystemExit) as exc:
        feed_smoke.main([])
    assert "someone-else@example.com" in str(exc.value)


def test_main_builds_the_calendar_client_for_the_requested_provider(monkeypatch):
    """Preflight passes -> the F2 hold goes through the provider's client.
    Stops the run right there (the fake client raises) so nothing past F1's
    first request is exercised."""
    _preflight_env(monkeypatch)
    _FakeScheduler.instances.clear()
    monkeypatch.setattr(feed_smoke, "SchedulerClient",
                        lambda ident: _FakeScheduler(ident, {"email": "a@example.com", "provider": "microsoft"}))
    seen: list[str] = []

    class _Stop(Exception):
        pass

    def _factory(sched, provider):
        seen.append(provider)
        raise _Stop()
    monkeypatch.setattr(feed_smoke, "make_calendar_client", _factory)
    with pytest.raises(_Stop):
        feed_smoke.main(["--provider", "microsoft"])
    assert seen == ["microsoft"]


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))
