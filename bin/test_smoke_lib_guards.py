# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27", "python-dateutil>=2.9", "rich>=13.7"]
# ///
"""Guards for bin/_smoke_lib.py's prod-safety primitives, and (D4-D7) for
bin/ms-smoke.py's env-derivation and gate-probe classification.

D1 (R#14): _smoke_lib.py used to define `assert_dev_url` TWICE — once near
the top keyed on DEV_HOST/PROD_HOST, and again lower down (shadowing the
first) keyed on _DEV_HOST/_PROD_HOST, and the shadowing copy's narrower
allow-list refused smoke hosts bin/ms-smoke.py (a dedicated Microsoft-only
harness, not a `--provider` flag) is documented to run against. Fixed to a
single definition whose allow-list is the one _SMOKE_HOSTS constant sitting
next to SMOKE_DB_IDS.

D2 (R#15): bin/reset-smoke-env.py's poll wipe built `DevD1(repo_root=...)`
with no env, so it always hit the `dev` wrangler env's D1 binding regardless
of which D1_DATABASE_ID was actually targeted — a run against another smoke
env would wipe polls from scheduler-dev and leave its own D1 untouched/dirty.
Fixed to derive env_name from the db id (the env that owns it, else "dev"),
with an explicit SMOKE_WRANGLER_ENV still taking precedence.

D3: `DoneMarking.for_provider` applied SMOKE_DONE_COLOR_ID verbatim
regardless of provider, so a stale Google value (e.g. "11") left over in the
shell from a Google run would silently pass through on a later
`--provider microsoft` run and break done-marking with a misleading error
far from the actual cause. For provider "microsoft", an override that is
neither the Optical Done category nor "" (clear) is now ignored — with a
one-line stderr warning — and the provider default is used instead; a valid
override (the category name, or "") still applies.

D4: `GraphCalendarClient._PREFER` (bin/_smoke_lib.py) was missing
`IdType="ImmutableId"` — the worker's own Graph client always sends it
(microsoft-calendar-provider.ts PREFER), since default Graph event ids can
change when an event moves folders; the harness's recorded ids need the
same immutability guarantee the worker relies on.

D5: bin/ms-smoke.py's `step1_gate_probe` only explicitly handled
`err == "unknown_provider"` (gate closed -> fail); every other outcome,
INCLUDING a 400 response whose body doesn't parse as JSON or carries no
"error" key, fell through to the bottom and was reported as "gate open,
pass" — an unjustified inference. Reclassified: unknown_provider -> fail
(unchanged); a different, parseable 400 error -> pass (per the route's own
check order, reaching client/redirect_uri validation proves the provider
gate already passed); an unparseable/keyless 400 body -> fail, showing the
raw body (ambiguous, not evidence the gate is open); any non-400 status
(302 to Microsoft, chooser HTML, etc.) -> pass (unchanged).

D6: `main()` parsed `--url`/`--client-id` but never passed them to
`MsEnv.from_environ(levels)`, which read `SCHEDULER_URL`/`SCHEDULER_CLIENT_ID`
straight from `os.environ` — so the documented CLI flags were silently
ignored for both fields. `from_environ` now takes optional `url`/`client_id`
overrides (CLI wins over env, matching argparse's own env-default
behaviour for these two flags).

D7: `run_live`'s per-level dispatch for "5" and "6" carried `_skip` branches
for `d1 is None` / `not env.ms2_attendee_email` that can no longer trigger —
`MsEnv.from_environ` already `SystemExit`s during startup if level "5" is
requested without `D1_DATABASE_ID`, or level "6" without
`MS2_ATTENDEE_EMAIL`, using the SAME `levels` list `run_live` dispatches
over. Removed the dead branches (no new test: nothing exercises them).

D8 (adversarial review fix round): M1 corrects an inverted precondition in
D5's own fix — worker/src/auth/oauth-provider.ts actually checks
client_id/redirect_uri BEFORE the provider gate, so only unknown_provider
is evidence of anything; every other 400 now fails, showing the error,
instead of being read as "gate open". M2 adds a shared
`_smoke_lib.d1_for_db_id` helper (SMOKE_WRANGLER_ENV > the db id's own env >
"dev") and fixes ms-smoke.py's run_live, which had the SAME
unparameterised-DevD1 bug D2 fixed only in reset-smoke-env.py. M3 makes
GraphCalendarClient send its Prefer (IdType=ImmutableId) header on every
request, not just the two GETs — create_event/move_event/set_categories/
delete_event previously went out with no Prefer at all, so a created
event's id could be the mutable one. M4 adds the assert_dev_url call
reset-smoke-env.py's main() was missing entirely. m1 refuses PROD's own
workers.dev subdomain (worker name "weekly-scheduling-assistant") under the
*.workers.dev allow-list. m2 deletes the now-fully-unused DEV_HOST/
PROD_HOST public pair. m3 was investigated and is NOT a bug: ms-smoke.py's
local GraphClient already overrides list_events to return raw (un-
normalised) events specifically so "subject" reads correctly — a lock-in
regression test was added, no code changed. m4 drops the dead ""-override
case from D3's microsoft guard (unreachable — an empty override already
reads as unset earlier in for_provider) and reframes the test that
exercised it. m5 adds `assert_env_consistent(url, db_id)` (each smoke host
<-> its own db; *.workers.dev hosts skip it) at both harnesses' startup. n3
corrects D1's rationale text, which wrongly implied meeting-smoke.py has a
--provider flag — it doesn't; ms-smoke.py is the actual beneficiary of the
allow-list fix.
"""
from __future__ import annotations

import ast
import importlib.util
import pathlib
import sys

import pytest

BIN = pathlib.Path(__file__).parent


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, BIN / filename)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


lib = _load("smoke_lib_guards_test_lib", "_smoke_lib.py")
ms_smoke = _load("ms_smoke_guards_test", "ms-smoke.py")


# =============================================================================
# The smoke-env registry — which D1s/hosts a harness may touch
# =============================================================================

EXPECTED_SMOKE_DB_IDS = {lib.DEV_DB_ID}
EXPECTED_MS_CONSTANTS: set[str] = set()


def test_smoke_db_ids():
    assert lib.SMOKE_DB_IDS == EXPECTED_SMOKE_DB_IDS
    assert lib.PROD_DB_ID not in lib.SMOKE_DB_IDS


def test_ms_constants():
    # Publicly the smoke envs are dev alone: no MS_* constants at all.
    assert {n for n in vars(lib) if n.startswith("MS_")} == EXPECTED_MS_CONSTANTS


def test_assert_dev_db_allows_every_smoke_db_and_refuses_prod():
    for db_id in EXPECTED_SMOKE_DB_IDS:
        lib.assert_dev_db(db_id)  # no raise
    with pytest.raises(SystemExit):
        lib.assert_dev_db(lib.PROD_DB_ID)
    with pytest.raises(SystemExit):
        lib.assert_dev_db("not-a-smoke-db")


# =============================================================================
# D1 — single assert_dev_url definition, every smoke host allow-listed
# =============================================================================

def test_smoke_lib_defines_assert_dev_url_exactly_once():
    """The old file had two `def assert_dev_url` — the second silently shadowed
    the first. Parse the source with ast and assert there is exactly one, so a
    future edit can't reintroduce the shadowing bug undetected."""
    tree = ast.parse((BIN / "_smoke_lib.py").read_text())
    names = [
        node.name for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == "assert_dev_url"
    ]
    assert names == ["assert_dev_url"], (
        f"expected exactly one assert_dev_url def, found {len(names)}"
    )


def test_assert_dev_url_allows_dev_custom_domain():
    lib.assert_dev_url("https://scheduler-dev.example.com")  # no raise


def test_assert_dev_url_allows_workers_dev():
    lib.assert_dev_url("https://weekly-scheduling-assistant-dev.someacct.workers.dev")  # no raise




def test_assert_dev_url_refuses_prod():
    with pytest.raises(SystemExit):
        lib.assert_dev_url("https://scheduler.example.com")


def test_assert_dev_url_refuses_unknown_host():
    with pytest.raises(SystemExit):
        lib.assert_dev_url("https://example.com")


# =============================================================================
# D8/m1 — the blanket *.workers.dev allow-list must not admit PROD's own
# workers.dev subdomain if it's ever live (worker name "weekly-scheduling-
# assistant", per worker/wrangler.toml top-level `name`)
# =============================================================================

def test_assert_dev_url_refuses_prod_workers_dev_subdomain():
    with pytest.raises(SystemExit):
        lib.assert_dev_url("https://weekly-scheduling-assistant.someacct.workers.dev")


def test_assert_dev_url_still_allows_smoke_workers_dev_subdomains():
    # Sanity: the refusal is scoped to the EXACT prod worker name as the
    # first label, not to "*workers.dev" broadly — the smoke envs' own
    # workers.dev subdomains (different, suffixed worker names) stay allowed.
    lib.assert_dev_url("https://weekly-scheduling-assistant-dev.someacct.workers.dev")


# =============================================================================
# D8/m2 — _smoke_lib.py defines the dev/prod host constants exactly once
# (only the underscore-prefixed pair; the old duplicate public DEV_HOST/
# PROD_HOST pair — dead since only the underscore pair was ever read — is
# gone entirely)
# =============================================================================

def test_smoke_lib_defines_host_constants_exactly_once():
    tree = ast.parse((BIN / "_smoke_lib.py").read_text())
    assigned_names = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    assigned_names.append(target.id)
    assert assigned_names.count("_DEV_HOST") == 1
    assert assigned_names.count("_PROD_HOST") == 1
    assert "DEV_HOST" not in assigned_names
    assert "PROD_HOST" not in assigned_names


# =============================================================================
# D2 — reset-smoke-env.py's poll wipe derives env_name from the db id
# =============================================================================

reset_env = _load("reset_smoke_env_guards_test", "reset-smoke-env.py")


class _RecorderDevD1:
    """Stand-in for _smoke_lib.DevD1 that records its constructor args instead
    of shelling out to wrangler. `env_name` mirrors the real dataclass field
    (default_factory reading SMOKE_WRANGLER_ENV), but the test always passes
    it explicitly so the default never fires."""

    last_kwargs: dict | None = None

    def __init__(self, **kwargs):
        type(self).last_kwargs = kwargs

    def query(self, sql: str) -> list[dict]:
        return []

    def execute(self, sql: str) -> None:
        pass




def test_wipe_harness_polls_derives_dev_env_from_dev_db_id(monkeypatch):
    # D8/M2: wipe_harness_polls now routes through the shared
    # _smoke_lib.d1_for_db_id helper, which calls DevD1 inside ITS OWN
    # module namespace — patch it there, not the (now-unused for this path)
    # `reset_env.DevD1` alias.
    monkeypatch.setattr(reset_env._smoke_lib, "DevD1", _RecorderDevD1)
    monkeypatch.delenv("SMOKE_WRANGLER_ENV", raising=False)
    _RecorderDevD1.last_kwargs = None

    reset_env.wipe_harness_polls(
        db_id=reset_env._smoke_lib.DEV_DB_ID,
        repo_root=pathlib.Path("/tmp/does-not-matter"),
        dry_run=False,
    )

    assert _RecorderDevD1.last_kwargs is not None
    assert _RecorderDevD1.last_kwargs.get("env_name") == "dev"


def test_wipe_harness_polls_explicit_smoke_wrangler_env_wins(monkeypatch):
    # D8/M2: wipe_harness_polls now routes through the shared
    # _smoke_lib.d1_for_db_id helper, which calls DevD1 inside ITS OWN
    # module namespace — patch it there, not the (now-unused for this path)
    # `reset_env.DevD1` alias.
    monkeypatch.setattr(reset_env._smoke_lib, "DevD1", _RecorderDevD1)
    monkeypatch.setenv("SMOKE_WRANGLER_ENV", "custom-env")
    _RecorderDevD1.last_kwargs = None

    reset_env.wipe_harness_polls(
        db_id=reset_env._smoke_lib.DEV_DB_ID,
        repo_root=pathlib.Path("/tmp/does-not-matter"),
        dry_run=False,
    )

    assert _RecorderDevD1.last_kwargs is not None
    assert _RecorderDevD1.last_kwargs.get("env_name") == "custom-env"


# =============================================================================
# D3 — DoneMarking.for_provider ignores a nonsensical SMOKE_DONE_COLOR_ID on
# the microsoft provider, with a warning, rather than passing it through
# =============================================================================

def test_done_marking_microsoft_ignores_stale_google_override_with_warning(monkeypatch, capsys):
    # A Google colorId like "11" left in the shell must not silently pass
    # through to a Microsoft run: it isn't the Optical Done category and
    # isn't "", so it's meaningless on Graph (see GraphCalendarClient.recolor_
    # event, which would otherwise raise a confusing ValueError far from the
    # real cause — a stale env var).
    monkeypatch.setenv("SMOKE_DONE_COLOR_ID", "11")
    m = lib.DoneMarking.for_provider("microsoft")
    assert (m.done, m.undone) == (lib.OPTICAL_DONE_CATEGORY, "")
    err = capsys.readouterr().err
    assert "SMOKE_DONE_COLOR_ID" in err and "11" in err


def test_done_marking_microsoft_accepts_valid_category_override(monkeypatch, capsys):
    # D8/m4: the ONLY value that means anything on Graph as a non-empty
    # override is the Optical Done category itself (a no-op override, but
    # must not warn). "" is NOT a second valid value here — an empty
    # SMOKE_DONE_COLOR_ID reads as unset via `if not override: return base`
    # earlier in for_provider, so it can never reach this guard at all; see
    # test_done_marking_empty_string_override_reads_as_unset below, which
    # tests THAT short-circuit instead of a (dead) "valid override" path.
    monkeypatch.setenv("SMOKE_DONE_COLOR_ID", lib.OPTICAL_DONE_CATEGORY)
    m = lib.DoneMarking.for_provider("microsoft")
    assert (m.done, m.undone) == (lib.OPTICAL_DONE_CATEGORY, "")
    assert capsys.readouterr().err == ""


def test_done_marking_empty_string_override_reads_as_unset(monkeypatch, capsys):
    # D8/m4: previously named ..._accepts_empty_string_override and framed as
    # exercising the microsoft-guard's "" acceptance — but "" is unreachable
    # there (an empty env var IS "not override", so for_provider returns
    # `base` before the guard runs at all). Renamed/reframed to test the
    # actual, reachable behaviour: empty reads as unset, no warning either.
    monkeypatch.setenv("SMOKE_DONE_COLOR_ID", "")
    m = lib.DoneMarking.for_provider("microsoft")
    assert m.done == lib.OPTICAL_DONE_CATEGORY
    assert capsys.readouterr().err == ""


def test_done_marking_google_override_unaffected_by_microsoft_guard(monkeypatch, capsys):
    # The google branch must keep accepting any override verbatim — the new
    # validation is microsoft-only.
    monkeypatch.setenv("SMOKE_DONE_COLOR_ID", "7")
    g = lib.DoneMarking.for_provider("google")
    assert (g.done, g.undone) == ("7", "5")
    assert capsys.readouterr().err == ""


# =============================================================================
# D4 — GraphCalendarClient's Prefer header carries IdType="ImmutableId"
# =============================================================================

def test_graph_calendar_client_prefer_requests_immutable_ids():
    # Default Graph event ids can change when an event moves folders (e.g. a
    # delete-to-Deleted-Items then restore); IdType="ImmutableId" pins the id
    # the harness records so a later GET/PATCH by that id keeps resolving.
    # worker/src/providers/microsoft-calendar-provider.ts's own Graph client
    # always sends this — the harness needs the same guarantee.
    assert 'IdType="ImmutableId"' in lib.GraphCalendarClient._PREFER
    # The existing UTC-timezone preference (relied on by _graph_instant) must
    # still be present alongside it.
    assert 'outlook.timezone="UTC"' in lib.GraphCalendarClient._PREFER


# =============================================================================
# D5 — ms-smoke.py's step1_gate_probe classifies every 400 outcome, not just
# the exact "unknown_provider" one
# =============================================================================

_UNSET = object()


class _FakeResponse:
    def __init__(self, status_code: int, json_body=_UNSET, text: str = ""):
        self.status_code = status_code
        self._json_body = json_body
        self.text = text

    def json(self):
        if self._json_body is _UNSET:
            raise ValueError("no JSON body")
        return self._json_body


def test_step1_fails_on_unknown_provider(monkeypatch):
    resp = _FakeResponse(400, json_body={"error": "unknown_provider"})
    monkeypatch.setattr(ms_smoke.httpx, "get", lambda *a, **k: resp)
    result = ms_smoke.step1_gate_probe("https://example-dev.workers.dev", "smoke-cli")
    assert result.passed is False
    assert "MS_PROVIDER_ENABLED" in result.notes


def test_step1_fails_on_a_pre_gate_400(monkeypatch):
    # D8/M1 correction: worker/src/auth/oauth-provider.ts checks client_id
    # (:113, unknown_client) and the redirect_uri allow-list (:115,
    # redirect_uri_not_allowed) BEFORE the provider gate (:118,
    # unknown_provider). So a 400 with a DIFFERENT error means the request
    # never reached the gate at all — it's NOT evidence the gate is open,
    # and usually means the harness/client is misconfigured (e.g.
    # register-pkce-client.sh was never run against this env).
    resp = _FakeResponse(400, json_body={"error": "invalid_client"})
    monkeypatch.setattr(ms_smoke.httpx, "get", lambda *a, **k: resp)
    result = ms_smoke.step1_gate_probe("https://example-dev.workers.dev", "smoke-cli")
    assert result.passed is False
    assert "invalid_client" in result.notes


def test_step1_fails_on_unparseable_400_body(monkeypatch):
    # Previously misclassified as "gate open, pass" — a 400 we can't parse is
    # not evidence the gate is open, and swallowing it hid a genuine
    # unexpected-response case.
    resp = _FakeResponse(400, json_body=_UNSET, text="<html>502-ish garbage</html>")
    monkeypatch.setattr(ms_smoke.httpx, "get", lambda *a, **k: resp)
    result = ms_smoke.step1_gate_probe("https://example-dev.workers.dev", "smoke-cli")
    assert result.passed is False
    assert "400" in result.notes


def test_step1_fails_on_400_with_no_error_key(monkeypatch):
    resp = _FakeResponse(400, json_body={"message": "something else"})
    monkeypatch.setattr(ms_smoke.httpx, "get", lambda *a, **k: resp)
    result = ms_smoke.step1_gate_probe("https://example-dev.workers.dev", "smoke-cli")
    assert result.passed is False


def test_step1_passes_on_a_redirect_to_microsoft(monkeypatch):
    resp = _FakeResponse(302, json_body=_UNSET)
    monkeypatch.setattr(ms_smoke.httpx, "get", lambda *a, **k: resp)
    result = ms_smoke.step1_gate_probe("https://example-dev.workers.dev", "smoke-cli")
    assert result.passed is True


# =============================================================================
# D6 — MsEnv.from_environ threads --url / --client-id through (CLI wins)
# =============================================================================

def test_from_environ_uses_cli_url_and_client_id_over_env(monkeypatch):
    monkeypatch.setenv("SCHEDULER_URL", "https://env-value.workers.dev")
    monkeypatch.setenv("SCHEDULER_CLIENT_ID", "env-client")
    monkeypatch.setenv("EXPECTED_TEST_ACCOUNT", "smoke@example.com")
    monkeypatch.setenv("SCHEDULER_BEARER", "bearer-token")
    monkeypatch.setenv("SCHEDULER_REFRESH_TOKEN", "refresh-token")

    env = ms_smoke.MsEnv.from_environ(
        ["1"], url="https://cli-value.workers.dev", client_id="cli-client",
    )
    assert env.scheduler_url == "https://cli-value.workers.dev"
    assert env.client_id == "cli-client"


def test_from_environ_falls_back_to_env_when_cli_omitted(monkeypatch):
    monkeypatch.setenv("SCHEDULER_URL", "https://env-value.workers.dev")
    monkeypatch.setenv("SCHEDULER_CLIENT_ID", "env-client")
    monkeypatch.setenv("EXPECTED_TEST_ACCOUNT", "smoke@example.com")
    monkeypatch.setenv("SCHEDULER_BEARER", "bearer-token")
    monkeypatch.setenv("SCHEDULER_REFRESH_TOKEN", "refresh-token")

    env = ms_smoke.MsEnv.from_environ(["1"], url=None, client_id=None)
    assert env.scheduler_url == "https://env-value.workers.dev"
    assert env.client_id == "env-client"


# =============================================================================
# D8/M2 — a single _smoke_lib.d1_for_db_id(db_id, repo_root) helper, used by
# BOTH reset-smoke-env.py's poll wipe and ms-smoke.py's run_live — the D2 fix
# only patched reset-smoke-env.py; ms-smoke.py's own DevD1(repo_root=...)
# construction (step 5, users.done_color_id seeding) had the identical bug.
# =============================================================================



def test_d1_for_db_id_unknown_db_falls_back_to_dev(monkeypatch):
    monkeypatch.delenv("SMOKE_WRANGLER_ENV", raising=False)
    monkeypatch.setattr(lib, "DevD1", _RecorderDevD1)
    _RecorderDevD1.last_kwargs = None
    lib.d1_for_db_id("not-a-smoke-db", pathlib.Path("/tmp/repo"))
    assert _RecorderDevD1.last_kwargs.get("env_name") == "dev"


def test_d1_for_db_id_dev(monkeypatch):
    monkeypatch.delenv("SMOKE_WRANGLER_ENV", raising=False)
    monkeypatch.setattr(lib, "DevD1", _RecorderDevD1)
    _RecorderDevD1.last_kwargs = None
    lib.d1_for_db_id(lib.DEV_DB_ID, pathlib.Path("/tmp/repo"))
    assert _RecorderDevD1.last_kwargs.get("env_name") == "dev"


def test_d1_for_db_id_explicit_smoke_wrangler_env_wins(monkeypatch):
    monkeypatch.setenv("SMOKE_WRANGLER_ENV", "custom-env")
    monkeypatch.setattr(lib, "DevD1", _RecorderDevD1)
    _RecorderDevD1.last_kwargs = None
    lib.d1_for_db_id(lib.DEV_DB_ID, pathlib.Path("/tmp/repo"))
    assert _RecorderDevD1.last_kwargs.get("env_name") == "custom-env"


def test_reset_smoke_env_wipe_polls_uses_shared_helper(monkeypatch):
    # Call site 1/2: reset-smoke-env.py must route through the shared helper
    # rather than re-deriving env_name itself (the D2 fix's own logic, now
    # centralised so it can't drift out of sync between call sites).
    calls = []

    def fake_helper(db_id, repo_root):
        calls.append((db_id, repo_root))
        return _RecorderDevD1(repo_root=repo_root, env_name="dev")

    monkeypatch.setattr(reset_env._smoke_lib, "d1_for_db_id", fake_helper)
    reset_env.wipe_harness_polls(
        db_id=reset_env._smoke_lib.DEV_DB_ID,
        repo_root=pathlib.Path("/tmp/does-not-matter"),
        dry_run=False,
    )
    assert calls == [(reset_env._smoke_lib.DEV_DB_ID, pathlib.Path("/tmp/does-not-matter"))]


class _FakeSchedGraphForRunLive:
    """Stand-in for both SchedulerClient and GraphClient in a run_live() smoke
    test — run_live only needs .request()/.close() from the first and
    .close() from the second before dispatching any level."""

    def __init__(self, *args, **kwargs):
        pass

    def request(self, method, path, **kwargs):
        class _R:
            def raise_for_status(self):
                pass

            def json(self):
                return {"email": "smoke@example.com"}

        return _R()

    def close(self):
        pass


def test_run_live_constructs_d1_via_shared_helper(monkeypatch):
    # Call site 2/2: ms-smoke.py's run_live must route through the shared
    # helper too (it once built an unparameterised DevD1(repo_root=...), so
    # step 5's done-category seeding could land in the wrong env's D1).
    calls = []

    def fake_helper(db_id, repo_root):
        calls.append(db_id)
        return _RecorderDevD1(repo_root=repo_root, env_name="dev")

    monkeypatch.delenv("SMOKE_WRANGLER_ENV", raising=False)
    monkeypatch.setattr(ms_smoke, "SchedulerClient", _FakeSchedGraphForRunLive)
    monkeypatch.setattr(ms_smoke, "GraphClient", _FakeSchedGraphForRunLive)
    monkeypatch.setattr(ms_smoke._smoke_lib, "d1_for_db_id", fake_helper)

    env = ms_smoke.MsEnv(
        scheduler_url="https://scheduler-dev.example.com",
        scheduler_bearer="b", scheduler_refresh_token="r",
        expected_test_account="smoke@example.com",
        d1_database_id=ms_smoke._smoke_lib.DEV_DB_ID,
    )
    console = ms_smoke.Console(stderr=True)
    ms_smoke.run_live(env, [], console)  # no levels: exercises only the setup path

    assert calls == [ms_smoke._smoke_lib.DEV_DB_ID]




# =============================================================================
# D8/M3 — GraphCalendarClient sends the Prefer header on EVERY request, not
# just the two GETs. create_event previously returned a MUTABLE Graph id
# while the harness (and the worker) compare against an IMMUTABLE one
# elsewhere, so e.g. ms-smoke step 6's find_meeting_task_id / the harness's
# own event-sweep keep-set could never match the id it just created.
# =============================================================================

class _FakeTokenScheduler:
    def request(self, method, path, **kwargs):
        class _R:
            def raise_for_status(self):
                pass

            def json(self):
                return {"access_token": "tok-123"}

        return _R()


class _RecordingGraphHttpClient:
    def __init__(self):
        self.calls = []

    def request(self, method, url, headers=None, **kwargs):
        self.calls.append({"method": method, "url": url, "headers": dict(headers or {})})

        class _R:
            status_code = 201

            def raise_for_status(self):
                pass

            def json(self):
                return {"id": "evt-created"}

        return _R()


def _graph_client_with_recorder():
    client = lib.GraphCalendarClient(_FakeTokenScheduler())
    recorder = _RecordingGraphHttpClient()
    client._client = recorder
    return client, recorder


def test_graph_create_event_sends_prefer_header():
    client, recorder = _graph_client_with_recorder()
    client.create_event("Test", "2026-07-06T09:00:00+00:00", "2026-07-06T10:00:00+00:00")
    assert recorder.calls
    assert recorder.calls[-1]["headers"].get("Prefer") == lib.GraphCalendarClient._PREFER


def test_graph_move_event_sends_prefer_header():
    client, recorder = _graph_client_with_recorder()
    client.move_event("evt1", "2026-07-06T09:00:00+00:00", "2026-07-06T10:00:00+00:00")
    assert recorder.calls[-1]["headers"].get("Prefer") == lib.GraphCalendarClient._PREFER


def test_graph_set_categories_sends_prefer_header():
    client, recorder = _graph_client_with_recorder()
    client.set_categories("evt1", [lib.OPTICAL_DONE_CATEGORY])
    assert recorder.calls[-1]["headers"].get("Prefer") == lib.GraphCalendarClient._PREFER


def test_graph_delete_event_sends_prefer_header():
    client, recorder = _graph_client_with_recorder()
    client.delete_event("evt1")
    assert recorder.calls[-1]["headers"].get("Prefer") == lib.GraphCalendarClient._PREFER


# =============================================================================
# D8/m3 (investigated, not a bug) — sweep_ms_smoke_events reads ev["subject"].
# ms-smoke.py's local GraphClient OVERRIDES list_events to return
# list_events_raw (raw Graph dicts, native "subject" field) specifically so
# this file can inspect un-normalised events — normalize_graph_event's
# "summary" translation never runs in this path. Empirically confirmed
# (uv run against a stub graph client) the sweep already matches and deletes
# correctly. No code change; this test locks the (already-correct) behaviour
# in so a future refactor of GraphClient.list_events can't silently regress
# it back to the base class's normalised shape.
# =============================================================================

class _StubGraphForSweep:
    def __init__(self, events):
        self._events = events
        self.deleted: list[str] = []

    def list_events(self, time_min, time_max):
        return self._events

    def delete_event(self, event_id):
        self.deleted.append(event_id)


def test_sweep_ms_smoke_events_matches_raw_subject_field():
    from datetime import date
    stub = _StubGraphForSweep([
        {"id": "keep1", "subject": "Some other meeting"},
        {"id": "del1", "subject": f"{ms_smoke._MS_EVENT_PREFIX} chunk"},
    ])
    ms_smoke.sweep_ms_smoke_events(stub, date(2026, 7, 6))
    assert stub.deleted == ["del1"]


# =============================================================================
# D8/M4 — reset-smoke-env.py's main() never called assert_dev_url; it built
# a SchedulerClient straight from the (unchecked) SCHEDULER_URL env var, so
# --clear-all against a mistyped/prod URL had no guard at all (unlike every
# other harness's main()).
# =============================================================================

def test_reset_smoke_env_main_calls_assert_dev_url(monkeypatch):
    # main() previously never called assert_dev_url at all, so --clear-all
    # against a mistyped/prod SCHEDULER_URL had no guard. Spy on
    # assert_dev_url and make it raise (mirroring its real prod-refusal
    # behaviour) to prove main() calls it — and calls it with the actual
    # SCHEDULER_URL — BEFORE constructing a SchedulerClient, decoupled from
    # SCHEDULER_BEARER/SCHEDULER_REFRESH_TOKEN/etc, which are module-level
    # constants captured once at import time and can't be monkeypatched via
    # os.environ after the fact.
    monkeypatch.setattr(sys, "argv", ["reset-smoke-env.py"])
    calls: list[str] = []

    def fake_assert_dev_url(url: str) -> None:
        calls.append(url)
        raise SystemExit("REFUSING TO RUN: stopped by test spy")

    monkeypatch.setattr(reset_env, "assert_dev_url", fake_assert_dev_url)
    monkeypatch.setattr(reset_env, "SCHEDULER_URL", "https://scheduler.example.com")
    monkeypatch.setenv("SCHEDULER_URL", "https://scheduler.example.com")
    monkeypatch.setenv("EXPECTED_TEST_ACCOUNT", "smoke@example.com")
    monkeypatch.setenv("SCHEDULER_BEARER", "bearer-token")
    monkeypatch.setenv("SCHEDULER_REFRESH_TOKEN", "refresh-token")

    with pytest.raises(SystemExit):
        reset_env.main()
    assert calls == ["https://scheduler.example.com"]


# =============================================================================
# D8/m5 — assert_env_consistent(url, db_id) cross-checks SCHEDULER_URL and
# D1_DATABASE_ID name the SAME env, so a mismatched pair (one env's URL with
# another db id) can't quietly read/write the wrong database.
# =============================================================================

def test_assert_env_consistent_dev_host_with_dev_db_ok():
    lib.assert_env_consistent("https://scheduler-dev.example.com", lib.DEV_DB_ID)  # no raise


def test_assert_env_consistent_dev_host_with_other_db_refused():
    with pytest.raises(SystemExit):
        lib.assert_env_consistent("https://scheduler-dev.example.com", "some-other-db")


def test_assert_env_consistent_skips_workers_dev_hosts():
    # *.workers.dev serves every smoke worker — the host alone can't
    # disambiguate, so this check steps aside there (assert_dev_url/
    # assert_dev_db already independently allow-list only known-safe values).
    lib.assert_env_consistent("https://weekly-scheduling-assistant-dev.acct.workers.dev", "some-other-db")


def test_assert_env_consistent_skips_when_db_id_is_none():
    lib.assert_env_consistent("https://scheduler-dev.example.com", None)  # no raise


def test_assert_url_matches_env_dev():
    lib.assert_url_matches_env("https://scheduler-dev.example.com", "dev")  # no raise
    with pytest.raises(SystemExit):
        lib.assert_url_matches_env("https://scheduler-dev.example.com", "other")
    lib.assert_url_matches_env("https://weekly-scheduling-assistant-dev.acct.workers.dev", "other")




# =============================================================================
# rsvp_invite — PATCH-request mechanics (moved from bin/test_booking_smoke_
# turnstile.py, 2026-09-17 review round 3: booking-smoke.py's own production
# code no longer calls rsvp_invite directly — see rsvp_as_attendee below and
# bin/booking-smoke.py's _decline_invite/_accept_invite — so these tests
# belong against the shared primitive itself, not a booking-smoke.py binding
# that no longer exists.
# =============================================================================


class _FakeGetResponse:
    def __init__(self, status_code: int, body: dict | None = None):
        self.status_code = status_code
        self._body = body or {}
        self.text = str(self._body)

    def json(self):
        return self._body


class _FakePatchResponse:
    def __init__(self, status_code: int = 200):
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class _FakeCalendarClient:
    """Minimal stand-in for _smoke_lib.CalendarClient — only the surface
    rsvp_invite touches (BASE, _calendar_id, _authed). No network."""

    BASE = "https://www.googleapis.com/calendar/v3"

    def __init__(self, get_sequence: list):
        self._calendar_id = "primary"
        self._get_sequence = list(get_sequence)
        self.patch_calls: list[dict] = []

    def _authed(self, method: str, url: str, **kwargs):
        if method == "GET":
            return self._get_sequence.pop(0)
        if method == "PATCH":
            self.patch_calls.append({"url": url, "params": kwargs.get("params"), "json": kwargs.get("json")})
            return _FakePatchResponse()
        raise AssertionError(f"unexpected method {method!r}")


def test_rsvp_invite_declined_pins_the_patch_request_shape():
    attendees = [
        {"email": "owner@x", "organizer": True, "self": True, "responseStatus": "accepted"},
        {"email": "attendee@x", "responseStatus": "needsAction"},
    ]
    cal = _FakeCalendarClient(get_sequence=[_FakeGetResponse(200, {"attendees": attendees})])

    lib.rsvp_invite(cal, "evt-123", "attendee@x", "declined")

    assert len(cal.patch_calls) == 1
    call = cal.patch_calls[0]
    assert call["url"] == f"{_FakeCalendarClient.BASE}/calendars/primary/events/evt-123"
    # sendUpdates='none': no Google email — this harness is exercising the
    # worker's own detection/notification paths, not Google's RSVP mail.
    assert call["params"] == {"sendUpdates": "none"}
    patched = {a["email"]: a for a in call["json"]["attendees"]}
    assert patched["attendee@x"]["responseStatus"] == "declined"
    # Other attendees (here, the organiser's own self=True entry) are
    # preserved verbatim — only the named self_email's entry changes.
    assert patched["owner@x"]["responseStatus"] == "accepted"


def test_rsvp_invite_polls_past_a_404_before_the_invite_propagates(monkeypatch):
    # 404 = the invited copy hasn't landed on the attendee's calendar yet
    # (see rsvp_invite's docstring in bin/_smoke_lib.py) — confirms the
    # polling behaviour survives the response='declined' generalisation,
    # not just the response='accepted' path meeting-smoke's self-test covers.
    monkeypatch.setattr(lib.time, "sleep", lambda seconds: None)
    attendees = [{"email": "attendee@x", "responseStatus": "needsAction"}]
    cal = _FakeCalendarClient(get_sequence=[
        _FakeGetResponse(404),
        _FakeGetResponse(200, {"attendees": attendees}),
    ])

    lib.rsvp_invite(cal, "evt-123", "attendee@x", "declined")

    assert len(cal.patch_calls) == 1
    assert cal.patch_calls[0]["json"]["attendees"][0]["responseStatus"] == "declined"


# -- RefreshRejected: a revoked refresh token is a clean "re-mint" exit ------

class _RefreshResp:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body
        self.text = str(body)

    def raise_for_status(self):
        assert self.status_code < 400, "success-path fake only"

    def json(self):
        return self._body


class _RefreshHttp:
    def __init__(self, resp):
        self.resp = resp
        self.posted = []

    def post(self, url, data=None):
        self.posted.append((url, data))
        return self.resp


def _client_with_refresh_response(status, body):
    ident = lib.Identity(scheduler_url="https://scheduler-dev.example.com",
                         bearer="stale", refresh_token="revoked", expected_email="b@x.example",
                         client_id="smoke-cli")
    c = lib.SchedulerClient(ident)
    c._client = _RefreshHttp(_RefreshResp(status, body))
    return c


def test_do_refresh_raises_refresh_rejected_on_a_4xx_from_oauth_token():
    c = _client_with_refresh_response(400, {"error": "invalid_grant"})
    with pytest.raises(lib.RefreshRejected) as ei:
        c._do_refresh()
    e = ei.value
    assert e.status == 400 and e.error == "invalid_grant"
    assert e.expected_email == "b@x.example"
    assert "revoked" not in str(e)   # never leaks the refresh token value


def test_do_refresh_still_applies_a_successful_refresh():
    c = _client_with_refresh_response(200, {"access_token": "fresh", "refresh_token": "next", "expires_in": 60})
    c._do_refresh()
    assert c._bearer == "fresh" and c._refresh == "next"


def test_refresh_rejected_message_names_label_email_status_and_the_remint_command():
    e = lib.RefreshRejected(expected_email="b@x.example", status=400, error="invalid_grant")
    msg = lib.refresh_rejected_message(e, "B", "microsoft")
    assert msg.startswith("identity B (b@x.example): refresh token rejected")
    assert "400 invalid_grant" in msg
    assert 'eval "$(bin/mu-smoke-login.py B --provider microsoft)"' in msg
    assert "re-mint" in msg


class _RejectingSched:
    def __init__(self):
        self.closed = False

    def request(self, method, path, **kw):
        raise lib.RefreshRejected(expected_email="c@x.example", status=400, error="invalid_grant")

    def close(self):
        self.closed = True


def test_preflight_whoami_turns_a_refresh_rejection_into_a_clean_exit():
    sched = _RejectingSched()
    with pytest.raises(SystemExit) as ei:
        lib.preflight_whoami(sched, "c@x.example", "google", "C")
    msg = str(ei.value)
    assert msg.startswith("identity C (c@x.example): refresh token rejected")
    assert "mu-smoke-login.py C --provider google" in msg
    assert sched.closed


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
