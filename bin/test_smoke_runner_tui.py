#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "pytest-asyncio", "textual>=0.80", "httpx>=0.27"]
# ///
"""Guards for bin/smoke-runner.py (WP4): RunnerCore's UI-free orchestration
(queue, log tee + scrub, runs.jsonl, pruning, Blocked-never-spawns,
post-run re-probe, interactive-harness handling) and the Textual App's
Pilot-level behaviour (identity pane, select+run, result-chip presentation,
advisory banner + override). Per the internal design notes'
WP4 section — TDD per repo practice: written first, red against a module
that doesn't exist yet.

Built against WP1 (_smoke_registry.py) and WP2 (_smoke_identity.py)'s REAL
code, not stubs — this suite exercises the actual compose_env/classify_run/
seed_identities/classify/scrub_secrets it composes on top of.

Every RunnerCore/App in this file is constructed with an explicit tmp_path
state_dir, an explicit environ dict, and an explicit RunnerConfig — never the
real ~/.config or ~/.local/state, and no real subprocess is ever spawned
(execute/interactive_execute/probe are always fakes).

Run: uv run bin/test_smoke_runner_tui.py
"""
from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import importlib.util
import json
import sys
import threading
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest
from textual.widgets import Checkbox, Input, RadioButton, RadioSet, SelectionList, Static

BIN = Path(__file__).resolve().parent

_spec = importlib.util.spec_from_file_location("smoke_runner", BIN / "smoke-runner.py")
assert _spec and _spec.loader, "could not load smoke-runner module"
sr = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = sr
_spec.loader.exec_module(sr)

reg = sr._smoke_registry
ident = sr._smoke_identity

# The target hosting provider "microsoft" (where every Microsoft mode runs).
MICROSOFT_TARGET = "dev"


# =============================================================================
# Fixtures / helpers
# =============================================================================

START = datetime(2026, 9, 1, 12, 0, 0, tzinfo=timezone.utc)  # a Tuesday


class FakeClock:
    """Deterministic, monotonically-increasing clock — every call advances by
    one second so log-filename timestamps never collide within a test."""

    def __init__(self, start: datetime = START):
        self._t = start

    def __call__(self) -> datetime:
        t = self._t
        self._t = self._t + timedelta(seconds=1)
        return t


def token(seed: str) -> str:
    """A deterministic 43-char bearer/refresh-shaped string (the exact shape
    scrub_secrets targets: worker/src/auth/tokens.ts:6-9)."""
    return (seed * 43)[:43]


def make_cfg(**overrides) -> ident.RunnerConfig:
    base = dict(
        target="dev",
        google={"a": "a@example.com", "b": "b@example.com", "c": "c@example.com"},
        google_primary="a",
        microsoft={"a": "ms@example.com"},
        microsoft_primary="a",
        microsoft_attendee="",
        poll_invitee_a_set="",
        poll_invitee_b_set="",
    )
    base.update(overrides)
    return ident.RunnerConfig(**base)


def make_environ(cfg: ident.RunnerConfig, *, include_a: bool = True,
                  include_scheduler: bool = True, **extra) -> dict[str, str]:
    env: dict[str, str] = {
        "CLOUDFLARE_API_TOKEN": "op-injected-cf-token",
        "TURNSTILE_SECRET_DEV": "op-injected-turnstile-secret",
        "PATH": "/usr/bin:/bin",
    }
    if include_a:
        env["A_BEARER"] = token("qA")
        env["A_REFRESH"] = token("rA")
        env["A_EXPECTED_EMAIL"] = cfg.google["a"]
    if include_scheduler:
        env["SCHEDULER_BEARER"] = token("qS")
        env["SCHEDULER_REFRESH_TOKEN"] = token("rS")
        env["EXPECTED_TEST_ACCOUNT"] = cfg.microsoft.get(cfg.microsoft_primary, "")
    env.update(extra)
    return env


def make_environ_both_casts(cfg: ident.RunnerConfig, **extra) -> tuple[dict[str, str], dict[str, str]]:
    """Every letter of BOTH casts seeded (google:a/b/c via A_/B_/C_*,
    microsoft:a/b/c via MS_A_/MS_B_/MS_C_*) plus the SCHEDULER_* triple —
    returns (environ, email_by_bearer) so the caller can hand the second to
    make_probe. The shape a mixed campaign shell actually has."""
    env = make_environ(cfg, include_a=False, **extra)
    by_bearer: dict[str, str] = {env["SCHEDULER_BEARER"]: cfg.microsoft.get(cfg.microsoft_primary, "")}
    for L in ("a", "b", "c"):
        U = L.upper()
        if L in cfg.google:
            env[f"{U}_BEARER"] = token(f"q{U}"); env[f"{U}_REFRESH"] = token(f"r{U}")
            env[f"{U}_EXPECTED_EMAIL"] = cfg.google[L]
            by_bearer[env[f"{U}_BEARER"]] = cfg.google[L]
        if L in cfg.microsoft:
            env[f"MS_{U}_BEARER"] = token(f"mq{U}"); env[f"MS_{U}_REFRESH"] = token(f"mr{U}")
            env[f"MS_{U}_EXPECTED_EMAIL"] = cfg.microsoft[L]
            by_bearer[env[f"MS_{U}_BEARER"]] = cfg.microsoft[L]
    return env, by_bearer


def make_probe(email_by_bearer: dict[str, str], status: int = 200):
    """A fake probe_whoami: returns `status` with the email registered for
    the presented bearer (empty string if unregistered, which classify()
    will read as WRONG_ACCOUNT — never a crash)."""
    calls: list[tuple[str, str]] = []

    def probe(url: str, bearer: str, timeout: float = 10.0) -> ident.ProbeResult:
        calls.append((url, bearer))
        return ident.ProbeResult(status=status, body={"email": email_by_bearer.get(bearer, "")})

    probe.calls = calls  # type: ignore[attr-defined]
    return probe



@pytest.fixture
def dev_google_only(monkeypatch):
    """dev with provider "microsoft" switched off, so the drawer/M3 tests can
    pin how a Google-only current target renders a Microsoft mode whatever
    the real dev hosts."""
    monkeypatch.setitem(reg.TARGETS, "dev",
                        dataclasses.replace(reg.TARGETS["dev"], providers=("google",)))


@pytest.fixture
def staging_target(monkeypatch) -> str:
    """A second, Google-only target with its own host and wrangler env —
    for retarget/badge/secret tests that need somewhere other than dev to go."""
    monkeypatch.setitem(reg.TARGETS, "staging", reg.Target(
        name="staging",
        scheduler_url="https://weekly-scheduling-assistant-staging.example.workers.dev",
        db_id=reg._smoke_lib.DEV_DB_ID,
        wrangler_env="staging",
        providers=("google",),
    ))
    return "staging"


def interactive_poll_smoke(monkeypatch) -> None:
    """Re-flag poll-smoke as interactive=True for one test — the interactive
    machinery (App.suspend hand-off, no captured output) is kept for a future
    harness, but no registered harness uses it any more (poll-smoke is
    captured like everything else since 2026-09-02)."""
    monkeypatch.setitem(reg.HARNESSES, "poll-smoke",
                        dataclasses.replace(reg.HARNESSES["poll-smoke"], interactive=True))


def fail_execute(argv, env, cwd, line_sink):
    raise AssertionError(f"execute should not have been called: {argv!r}")


def fail_interactive_execute(argv, env, cwd):
    raise AssertionError(f"interactive_execute should not have been called: {argv!r}")


def make_core(tmp_path: Path, *, execute=fail_execute, interactive_execute=fail_interactive_execute,
              clock=None, environ=None, cfg=None, probe=None, log_prune_n=200,
              config_path=None) -> "sr.RunnerCore":
    cfg = cfg if cfg is not None else make_cfg()
    environ = environ if environ is not None else make_environ(cfg)
    probe = probe if probe is not None else make_probe({})
    # Always an explicit tmp config_path (never the real ~/.config default) —
    # and pre-write `cfg` to it, so that RunnerCore.rescan() (which reloads
    # from this path) reproduces the exact cfg this call constructed unless
    # a test deliberately edits the file afterward (the settings-round
    # tests do exactly that).
    config_path = config_path if config_path is not None else tmp_path / "config.toml"
    ident.save_config(cfg, config_path)
    return sr.RunnerCore(
        execute=execute,
        interactive_execute=interactive_execute,
        state_dir=tmp_path / "state",
        clock=clock or FakeClock(),
        environ=environ,
        cfg=cfg,
        config_path=config_path,
        probe=probe,
        log_prune_n=log_prune_n,
    )


async def wait_until(predicate, timeout: float = 5.0, interval: float = 0.02) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(interval)
    raise AssertionError("timed out waiting for condition")


def identity_pane_text(app) -> str:
    """The identity pane is a container of per-row Static widgets (round 5:
    no longer a DataTable — row classes are how M's colour-semantics test
    picks a row apart), joined for simple substring assertions."""
    rows = list(app.query("#identity-rows .identity-row"))
    return " | ".join(str(r.content) for r in rows)


def identity_row(app, slot: str):
    return app.query_one(f"#{sr._slot_widget_id(slot)}", Static)


# =============================================================================
# RunnerCore — pure orchestration, no Textual
# =============================================================================


def test_default_execute_streams_lines_and_returns_exit_code():
    lines: list[str] = []
    code = sr.default_execute(
        [sys.executable, "-c", "print('alpha'); print('beta')"],
        {}, str(BIN.parent), lines.append,
    )
    assert code == 0
    assert lines == ["alpha", "beta"]


def test_run_next_produces_scrubbed_log_and_runs_jsonl_record(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)
    leaked = token("LEAK")

    def fake_execute(argv, env, cwd, line_sink):
        assert argv[:3] == ("uv", "run", "bin/config-smoke.py")
        assert env["A_BEARER"] == environ["A_BEARER"]
        assert cwd == str(BIN.parent)
        line_sink(f"leaked token {leaked} in this line")
        line_sink("C1 PASS")
        line_sink("C7 PASS (note: unsat)")
        line_sink("ALL PASS")
        return 0

    core = make_core(tmp_path, execute=fake_execute, environ=environ, cfg=cfg,
                      probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    core.enqueue(sr.QueuedRun(harness="config-smoke", mode="default", target="dev"))
    completed = core.run_next()

    assert completed.blocked_reason is None
    assert completed.exit_code == 0
    assert completed.outcome.status == "PASS"
    assert [lv.label for lv in completed.outcome.levels] == ["C1", "C7"]

    assert completed.log_path is not None
    assert completed.log_path.parent == tmp_path / "state" / "logs"
    content = completed.log_path.read_text(encoding="utf-8")
    assert leaked not in content
    assert "[REDACTED-TOKEN]" in content
    assert "C1 PASS" in content

    runs_jsonl = tmp_path / "state" / "runs.jsonl"
    records = [json.loads(line) for line in runs_jsonl.read_text(encoding="utf-8").splitlines()]
    assert len(records) == 1
    rec = records[0]
    assert rec["harness"] == "config-smoke"
    assert rec["mode"] == "default"
    assert rec["target"] == "dev"
    assert rec["exit_code"] == 0
    assert rec["status"] == "PASS"
    assert rec["log_path"] == str(completed.log_path)
    assert rec["levels_detail"] == [
        {"label": "C1", "status": "PASS", "notes": ""},
        {"label": "C7", "status": "PASS", "notes": ""},
    ]
    assert rec["duration_s"] >= 0


def test_run_next_log_filename_shape(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)

    def fake_execute(argv, env, cwd, line_sink):
        line_sink("ALL PASS")
        return 0

    clock = FakeClock(datetime(2026, 3, 4, 5, 6, 7, tzinfo=timezone.utc))
    core = make_core(tmp_path, execute=fake_execute, environ=environ, cfg=cfg, clock=clock,
                      probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    core.enqueue(sr.QueuedRun(harness="config-smoke", mode="default", target="dev"))
    completed = core.run_next()
    assert completed.log_path.name == "20260304T050607Z-config-smoke.log"


def test_run_next_log_filename_includes_mode_suffix_for_non_default_mode(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)

    def fake_execute(argv, env, cwd, line_sink):
        line_sink("ALL PASS")
        return 0

    core = make_core(tmp_path, execute=fake_execute, environ=environ, cfg=cfg,
                      probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    core.enqueue(sr.QueuedRun(harness="regression-smoke", mode="google", target="dev"))
    completed = core.run_next()
    assert completed.log_path.name.endswith("-regression-smoke-google.log")


def test_run_next_strict_sequential_execution(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)
    events: list[str] = []
    in_progress = {"n": 0}
    max_concurrent = {"n": 0}

    def fake_execute(argv, env, cwd, line_sink):
        events.append(f"start:{argv[2]}")
        in_progress["n"] += 1
        max_concurrent["n"] = max(max_concurrent["n"], in_progress["n"])
        line_sink("ALL PASS")
        in_progress["n"] -= 1
        events.append(f"end:{argv[2]}")
        return 0

    core = make_core(tmp_path, execute=fake_execute, environ=environ, cfg=cfg,
                      probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    core.enqueue(sr.QueuedRun(harness="config-smoke", mode="default", target="dev"))
    core.enqueue(sr.QueuedRun(harness="feed-smoke", mode="default", target="dev"))

    core.run_next()
    core.run_next()

    assert max_concurrent["n"] == 1
    assert events == [
        "start:bin/config-smoke.py", "end:bin/config-smoke.py",
        "start:bin/feed-smoke.py", "end:bin/feed-smoke.py",
    ]


def test_run_next_prunes_logs_to_injected_n(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)

    def fake_execute(argv, env, cwd, line_sink):
        line_sink("ALL PASS")
        return 0

    core = make_core(tmp_path, execute=fake_execute, environ=environ, cfg=cfg, log_prune_n=2,
                      probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    log_paths = []
    for _ in range(3):
        core.enqueue(sr.QueuedRun(harness="config-smoke", mode="default", target="dev"))
        log_paths.append(core.run_next().log_path)

    logs_dir = tmp_path / "state" / "logs"
    remaining = sorted(p.name for p in logs_dir.glob("*.log"))
    assert len(remaining) == 2
    assert log_paths[0].name not in remaining
    assert log_paths[1].name in remaining
    assert log_paths[2].name in remaining


def test_run_next_blocked_run_never_spawns_and_is_not_recorded(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg, include_a=False)  # no A_* -> google:a unseeded
    core = make_core(tmp_path, execute=fail_execute, environ=environ, cfg=cfg,
                      probe=make_probe({}))
    core.enqueue(sr.QueuedRun(harness="config-smoke", mode="default", target="dev"))
    completed = core.run_next()

    assert completed.outcome is None
    assert completed.exit_code is None
    assert completed.log_path is None
    assert "google:a" in completed.blocked_reason
    assert "mu-smoke-login.py" in completed.blocked_reason  # copy-ready login command

    assert not (tmp_path / "state" / "logs").exists() or not list((tmp_path / "state" / "logs").glob("*"))
    assert not (tmp_path / "state" / "runs.jsonl").exists()


def test_run_next_blocked_missing_d1_secret(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)
    del environ["CLOUDFLARE_API_TOKEN"]
    core = make_core(tmp_path, execute=fail_execute, environ=environ, cfg=cfg, probe=make_probe({}))
    core.enqueue(sr.QueuedRun(harness="engine-smoke", mode="auto", target="dev"))
    completed = core.run_next()
    assert completed.outcome is None
    assert "CLOUDFLARE_API_TOKEN" in completed.blocked_reason


def test_run_next_reprobes_identities_after_run(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg, include_scheduler=False)  # only google:a seeded

    def fake_execute(argv, env, cwd, line_sink):
        line_sink("ALL PASS")
        return 0

    probe = make_probe({environ["A_BEARER"]: cfg.google["a"]})
    core = make_core(tmp_path, execute=fake_execute, environ=environ, cfg=cfg, probe=probe)
    assert core.identity_statuses == {}  # not probed at construction time

    core.enqueue(sr.QueuedRun(harness="config-smoke", mode="default", target="dev"))
    core.run_next()

    assert probe.calls == [(reg.TARGETS["dev"].scheduler_url, environ["A_BEARER"])]
    status = core.identity_statuses["google:a"]
    assert status.state == ident.IdentityState.VALID
    assert "expiry unknown" in status.detail


def test_run_next_interactive_harness_skips_tee_and_uses_interactive_execute(tmp_path, monkeypatch):
    interactive_poll_smoke(monkeypatch)
    cfg = make_cfg(poll_invitee_a_set="binv@example.com", poll_invitee_b_set="cinv@example.com")
    environ = make_environ(cfg)
    calls = []

    def fake_interactive_execute(argv, env, cwd):
        calls.append(argv)
        assert argv[:3] == ("uv", "run", "bin/poll-smoke.py")
        return 0

    core = make_core(tmp_path, execute=fail_execute, interactive_execute=fake_interactive_execute,
                      environ=environ, cfg=cfg, probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    core.enqueue(sr.QueuedRun(harness="poll-smoke", mode="default", target="dev"))
    completed = core.run_next()

    assert len(calls) == 1
    assert completed.log_path is None
    assert completed.exit_code == 0
    assert completed.outcome.status == "PASS"
    assert completed.outcome.detail == "interactive run — output not captured"
    assert completed.outcome.levels == ()

    runs_jsonl = tmp_path / "state" / "runs.jsonl"
    rec = json.loads(runs_jsonl.read_text(encoding="utf-8").splitlines()[0])
    assert rec["log_path"] is None


def test_run_next_interactive_harness_all_skipped_on_exit_2(tmp_path, monkeypatch):
    interactive_poll_smoke(monkeypatch)
    cfg = make_cfg(poll_invitee_a_set="binv@example.com", poll_invitee_b_set="cinv@example.com")
    environ = make_environ(cfg)

    def fake_interactive_execute(argv, env, cwd):
        return 2

    core = make_core(tmp_path, execute=fail_execute, interactive_execute=fake_interactive_execute,
                      environ=environ, cfg=cfg, probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    core.enqueue(sr.QueuedRun(harness="poll-smoke", mode="default", target="dev"))
    completed = core.run_next()
    assert completed.outcome.status == "ALL_SKIPPED"


def test_run_next_interactive_harness_fail_on_nonzero_exit(tmp_path, monkeypatch):
    interactive_poll_smoke(monkeypatch)
    cfg = make_cfg(poll_invitee_a_set="binv@example.com", poll_invitee_b_set="cinv@example.com")
    environ = make_environ(cfg)

    def fake_interactive_execute(argv, env, cwd):
        return 1

    core = make_core(tmp_path, execute=fail_execute, interactive_execute=fake_interactive_execute,
                      environ=environ, cfg=cfg, probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    core.enqueue(sr.QueuedRun(harness="poll-smoke", mode="default", target="dev"))
    completed = core.run_next()
    assert completed.outcome.status == "FAIL"


def test_run_next_appends_extra_args_to_argv(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)
    seen = {}

    def fake_execute(argv, env, cwd, line_sink):
        seen["argv"] = argv
        return 0

    core = make_core(tmp_path, execute=fake_execute, environ=environ, cfg=cfg,
                      probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    core.enqueue(sr.QueuedRun(harness="reset-smoke-env", mode="google", target="dev",
                              extra_args=("--dry-run",)))
    completed = core.run_next()
    assert seen["argv"][-1] == "--dry-run"
    assert completed.outcome.status == "PASS"  # parser "none": exit 0 -> PASS


def test_rescan_reseeds_from_environ(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg, include_a=False)
    core = make_core(tmp_path, environ=environ, cfg=cfg)
    assert "google:a" not in core.identities

    core.environ["A_BEARER"] = token("qA")
    core.environ["A_REFRESH"] = token("rA")
    core.environ["A_EXPECTED_EMAIL"] = cfg.google["a"]
    report = core.rescan()
    assert "google:a" in core.identities
    assert "google:a" in report.identities


# =============================================================================
# Pilot / App tests
# =============================================================================


@pytest.mark.asyncio
async def test_app_boot_shows_seeded_identity_states(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)
    probe = make_probe({
        environ["A_BEARER"]: cfg.google["a"],
        environ["SCHEDULER_BEARER"]: cfg.microsoft["a"],
    })
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=probe)
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        await wait_until(lambda: "VALID" in identity_pane_text(app))
        rows_text = identity_pane_text(app)
        assert "google:a" in rows_text
        assert cfg.google["a"] in rows_text
        assert "VALID" in rows_text
        # microsoft:primary is no longer a row — the SCHEDULER_* triple
        # classifies onto the concrete letter it matched (microsoft:a).
        assert "microsoft:a" in rows_text
        assert "microsoft:primary" not in rows_text
        # google:b/google:c are in the config cast but never seeded -> ABSENT
        assert "google:b" in rows_text
        assert "ABSENT" in rows_text


@pytest.mark.asyncio
async def test_identity_pane_lists_six_letter_slots_no_primary_sentinel(tmp_path):
    """WP1.5 task 1: the identity pane lists a row per configured letter
    slot on BOTH providers — no more single collapsed "microsoft:primary"
    row — plus an informational microsoft.attendee row (email-only, never
    logs in)."""
    cfg = make_cfg(
        google={"a": "a@example.com", "b": "b@example.com", "c": "c@example.com"},
        microsoft={"a": "msa@example.com", "b": "msb@example.com", "c": "msc@example.com"},
        microsoft_primary="a",
        microsoft_attendee="attendee@example.com",
    )
    environ = make_environ(cfg, include_scheduler=False)
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        rows_text = identity_pane_text(app)
        for slot in ("google:a", "google:b", "google:c", "microsoft:a", "microsoft:b", "microsoft:c"):
            assert slot in rows_text
        assert "microsoft:primary" not in rows_text
        assert "microsoft.attendee" in rows_text
        assert "attendee@example.com" in rows_text
        assert "N/A" in rows_text
        assert "never logs in" in rows_text


@pytest.mark.asyncio
async def test_select_harness_and_run_renders_pass_chip(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)
    calls = []

    def fake_execute(argv, env, cwd, line_sink):
        calls.append(argv)
        line_sink("C1 PASS")
        line_sink("ALL PASS")
        return 0

    core = make_core(tmp_path, execute=fake_execute, environ=environ, cfg=cfg,
                      probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        sl = app.query_one("#harness-list", SelectionList)
        sl.focus()
        await pilot.press("space")
        await pilot.press("r")
        await wait_until(lambda: len(calls) == 1 and not app._worker_active)
        await pilot.pause()

        rows = list(app.query(".run-result"))
        assert len(rows) == 1
        row = rows[0]
        assert "status-pass" in row.classes
        text = str(row.content)
        assert "✓" in text
        assert "C1" in text


@pytest.mark.asyncio
async def test_all_skipped_and_suspect_presentation_via_widget_classes(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()

        run1 = sr.QueuedRun(harness="config-smoke", mode="default", target="dev")
        await app._mount_queued_row(run1)
        app._handle_completed(sr.CompletedRun(
            queued=run1,
            outcome=reg.RunOutcome("ALL_SKIPPED", (), "harness reported all-skipped (exit 2) — not a pass"),
            blocked_reason=None, advisory=False, exit_code=2, log_path=None, duration_s=1.0, started_at=START,
        ))

        run2 = sr.QueuedRun(harness="config-smoke", mode="default", target="dev")
        await app._mount_queued_row(run2)
        app._handle_completed(sr.CompletedRun(
            queued=run2,
            outcome=reg.RunOutcome("SUSPECT", (), "parsed output disagrees with exit code"),
            blocked_reason=None, advisory=False, exit_code=0, log_path=None, duration_s=1.0, started_at=START,
        ))

        rows = list(app.query(".run-result"))
        skip_rows = [r for r in rows if "status-all-skipped" in r.classes]
        suspect_rows = [r for r in rows if "status-suspect" in r.classes]
        assert len(skip_rows) == 1
        assert len(suspect_rows) == 1
        assert "PASS" not in "status-all-skipped"  # sanity: distinct class name
        assert "ALL-SKIPPED" in str(skip_rows[0].content)
        assert "?" in str(suspect_rows[0].content)
        # SUSPECT must never render with the pass class (magenta, not green)
        assert "status-pass" not in suspect_rows[0].classes
        assert "status-pass" not in skip_rows[0].classes


@pytest.mark.asyncio
async def test_blocked_run_renders_blocked_class_with_reason(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg, include_a=False)
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        sl = app.query_one("#harness-list", SelectionList)
        sl.focus()
        await pilot.press("space")
        await pilot.press("r")
        await wait_until(lambda: not app._worker_active)
        await pilot.pause()
        rows = list(app.query(".run-result"))
        assert len(rows) == 1
        assert "status-blocked" in rows[0].classes
        assert "google:a" in str(rows[0].content)


@pytest.mark.asyncio
async def test_advisory_banner_shown_and_override_runs_it(tmp_path, monkeypatch):
    monkeypatch.setattr(reg, "_today", lambda: date(2024, 1, 6))  # Saturday
    cfg = make_cfg()
    environ = make_environ(cfg)
    calls = []

    def fake_execute(argv, env, cwd, line_sink):
        calls.append(argv)
        line_sink("ALL PASS")
        return 0

    core = make_core(tmp_path, execute=fake_execute, environ=environ, cfg=cfg,
                      probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    app = sr.SmokeRunnerApp(core, harness_names=["poll-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        sl = app.query_one("#harness-list", SelectionList)
        sl.focus()
        await pilot.press("space")
        await pilot.press("r")
        await wait_until(lambda: not app._worker_active)
        await pilot.pause()

        assert calls == []  # the day-gate Blocked run never spawned
        banner = app.query_one("#advisory-banner")
        assert "hidden" not in banner.classes
        banner_text = str(banner.content)
        assert "override" in banner_text

        await pilot.press("o")
        await wait_until(lambda: len(calls) == 1)
        await wait_until(lambda: not app._worker_active)
        await pilot.pause()

        assert len(calls) == 1
        banner_after = app.query_one("#advisory-banner")
        assert "hidden" in banner_after.classes

        rows = list(app.query(".run-result"))
        assert any("status-pass" in r.classes for r in rows)


# =============================================================================
# WP1 round 2 (bda3a3f): typed Blocked.advisory, compose_env extra_args,
# classify_run output_unavailable — RunnerCore-level pins.
# =============================================================================


def test_completed_run_advisory_true_only_for_the_day_gate(tmp_path, monkeypatch):
    monkeypatch.setattr(reg, "_today", lambda: date(2024, 1, 6))  # Saturday
    cfg = make_cfg()
    environ = make_environ(cfg)
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    core.enqueue(sr.QueuedRun(harness="poll-smoke", mode="default", target="dev"))
    completed = core.run_next()
    assert completed.outcome is None
    assert completed.advisory is True

    core2 = make_core(tmp_path, environ=make_environ(cfg, include_a=False), cfg=cfg, probe=make_probe({}))
    core2.enqueue(sr.QueuedRun(harness="config-smoke", mode="default", target="dev"))
    completed2 = core2.run_next()
    assert completed2.outcome is None
    assert completed2.advisory is False


def test_completed_run_advisory_false_for_a_successful_run(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)

    def fake_execute(argv, env, cwd, line_sink):
        line_sink("ALL PASS")
        return 0

    core = make_core(tmp_path, execute=fake_execute, environ=environ, cfg=cfg,
                      probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    core.enqueue(sr.QueuedRun(harness="config-smoke", mode="default", target="dev"))
    completed = core.run_next()
    assert completed.advisory is False


# =============================================================================
# Queue reorder (design doc: "visible and reorderable before start")
# =============================================================================


@pytest.mark.asyncio
async def test_queue_reorder_before_start_swaps_core_queue_and_visible_rows(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke", "feed-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()

        # Enqueue two runs directly (bypassing action_run_selected, which
        # would also start the worker — reordering is only meaningful/
        # supported before the worker starts draining, see _move_queue_item).
        run_a = sr.QueuedRun(harness="config-smoke", mode="default", target="dev")
        run_b = sr.QueuedRun(harness="feed-smoke", mode="default", target="dev")
        id_a = await app._mount_queued_row(run_a)
        core.enqueue(run_a)
        id_b = await app._mount_queued_row(run_b)
        core.enqueue(run_b)
        assert [r.harness for r in core.queue] == ["config-smoke", "feed-smoke"]
        assert not app._worker_active

        row_b = app.query_one(f"#{id_b}", Static)
        row_b.focus()
        await pilot.pause()
        await pilot.press("[")  # move the focused (second) row up one slot
        await pilot.pause()

        assert [r.harness for r in core.queue] == ["feed-smoke", "config-smoke"]
        results = app.query_one("#results")
        assert [w.id for w in results.children] == [id_b, id_a]

        # Moving the now-first row further up is a no-op (nothing above it).
        await pilot.press("[")
        await pilot.pause()
        assert [r.harness for r in core.queue] == ["feed-smoke", "config-smoke"]

        # "]" moves it back down.
        await pilot.press("]")
        await pilot.pause()
        assert [r.harness for r in core.queue] == ["config-smoke", "feed-smoke"]
        assert [w.id for w in results.children] == [id_a, id_b]


@pytest.mark.asyncio
async def test_queue_reorder_is_a_noop_once_worker_is_active(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke", "feed-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        run_a = sr.QueuedRun(harness="config-smoke", mode="default", target="dev")
        run_b = sr.QueuedRun(harness="feed-smoke", mode="default", target="dev")
        id_a = await app._mount_queued_row(run_a)
        core.enqueue(run_a)
        id_b = await app._mount_queued_row(run_b)
        core.enqueue(run_b)

        row_b = app.query_one(f"#{id_b}", Static)
        row_b.focus()
        await pilot.pause()

        app._worker_active = True  # simulate: the queue is currently draining
        await pilot.press("[")  # must not raise, must not touch a draining queue
        await pilot.pause()

        assert [r.harness for r in core.queue] == ["config-smoke", "feed-smoke"]
        results = app.query_one("#results")
        assert [w.id for w in results.children] == [id_a, id_b]


# =============================================================================
# Log viewer: search, follow-tail, jump-to-first-FAIL (design doc promises
# all three — bda3a3f review round: documented no-ops don't satisfy it).
# =============================================================================


@pytest.mark.asyncio
async def test_log_viewer_search_finds_and_highlights_the_match(tmp_path):
    log_path = tmp_path / "sample.log"
    log_path.write_text("L1 PASS\nspecial-marker-XYZ here\nL2 PASS\n", encoding="utf-8")
    core = make_core(tmp_path)
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        await app.push_screen(sr.LogViewerScreen(log_path, "t"))
        await pilot.pause()
        screen = app.screen
        assert isinstance(screen, sr.LogViewerScreen)

        await pilot.press("/")
        await pilot.pause()
        search = screen.query_one("#log-search", Input)
        assert "hidden" not in search.classes
        assert search.has_focus

        for ch in "special-marker-XYZ":
            await pilot.press(ch)
        await pilot.press("enter")
        await pilot.pause()

        assert screen._matches == [1]
        assert screen._match_idx == 0
        assert "hidden" in search.classes  # closes itself on submit

        body = screen.query_one("#log-body", Static)
        # N3: styling is a rich.text.Text style SPAN, not a markup string —
        # no per-line markup cost for the common (unstyled) case.
        assert any(style == "reverse" for _start, _end, style in body.content.spans)
        assert "special-marker-XYZ" in str(body.content)


@pytest.mark.asyncio
async def test_log_viewer_next_match_steps_through_multiple_hits(tmp_path):
    log_path = tmp_path / "sample.log"
    log_path.write_text("needle one\nplain\nneedle two\nplain\nneedle three\n", encoding="utf-8")
    core = make_core(tmp_path)
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        await app.push_screen(sr.LogViewerScreen(log_path, "t"))
        await pilot.pause()
        screen = app.screen

        await pilot.press("/")
        for ch in "needle":
            await pilot.press(ch)
        await pilot.press("enter")
        await pilot.pause()
        assert screen._matches == [0, 2, 4]
        assert screen._match_idx == 0

        await pilot.press("n")
        await pilot.pause()
        assert screen._match_idx == 1

        await pilot.press("n")
        await pilot.pause()
        assert screen._match_idx == 2

        await pilot.press("n")  # wraps back to the first match
        await pilot.pause()
        assert screen._match_idx == 0

        await pilot.press("N")
        await pilot.pause()
        assert screen._match_idx == 2


@pytest.mark.asyncio
async def test_log_viewer_follow_tail_picks_up_appended_lines(tmp_path):
    log_path = tmp_path / "live.log"
    log_path.write_text("L1 PASS\n", encoding="utf-8")
    core = make_core(tmp_path)
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        await app.push_screen(sr.LogViewerScreen(log_path, "t", follow=True))
        await pilot.pause()
        screen = app.screen
        assert screen._lines == ["L1 PASS"]

        with log_path.open("a", encoding="utf-8") as f:
            f.write("L2 PASS\nL3 FAIL\n")
        # The test calls the polling method directly rather than waiting on
        # the wall-clock timer that wires it in production (on_mount) — see
        # poll_for_new_lines's docstring.
        appended = screen.poll_for_new_lines()
        await pilot.pause()

        assert appended == 2
        assert screen._lines == ["L1 PASS", "L2 PASS", "L3 FAIL"]
        body = screen.query_one("#log-body", Static)
        assert "L2 PASS" in str(body.content)
        assert any(style == "red" for _start, _end, style in body.content.spans)  # the FAIL line is tinted

        # A second poll with nothing new appended is a true no-op.
        assert screen.poll_for_new_lines() == 0


@pytest.mark.asyncio
async def test_log_viewer_jump_first_fail_scrolls_to_it(tmp_path):
    lines = [f"L{i} PASS" for i in range(60)] + ["L60 FAIL"] + [f"L{i} PASS" for i in range(61, 100)]
    log_path = tmp_path / "big.log"
    log_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    core = make_core(tmp_path)
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        await app.push_screen(sr.LogViewerScreen(log_path, "t"))
        await pilot.pause()
        screen = app.screen

        await pilot.press("f")
        await pilot.pause()

        scroll = screen.query_one("#log-scroll")
        assert scroll.scroll_y == 60


# =============================================================================
# Mode/level drawer (design doc: "Harness pane: checkbox selection;
# per-harness mode/level pickers in a drawer (enter)" — round-3 gap).
# =============================================================================


@pytest.mark.asyncio
async def test_drawer_meeting_smoke_modes_and_level_universe_switches_with_mode(tmp_path, dev_google_only):
    cfg = make_cfg()
    environ = make_environ(cfg)
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["meeting-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        sl = app.query_one("#harness-list", SelectionList)
        sl.focus()
        await pilot.press("enter")
        await pilot.pause()

        screen = app.screen
        assert isinstance(screen, sr.HarnessDrawerScreen)

        radios = list(screen.query("RadioButton"))
        labels = [str(r.label) for r in radios]
        # meeting-smoke now has four modes: 2-account/3-account (google) and
        # microsoft-2-account/microsoft-3-account — the microsoft pair is
        # disabled on target=dev (make_cfg's default) when dev doesn't host
        # provider "microsoft" (Target.providers; dev_google_only), the same
        # way a wrong-target mode is disabled.
        assert len(radios) == 4
        assert any("2-account" in lbl and "microsoft" not in lbl for lbl in labels)
        assert any("3-account" in lbl and "microsoft" not in lbl for lbl in labels)
        ms2 = next(lbl for lbl in labels if "microsoft-2-account" in lbl)
        ms3 = next(lbl for lbl in labels if "microsoft-3-account" in lbl)
        assert "disabled" in ms2 and "disabled" in ms3

        # default mode is meeting-smoke's first mode (2-account) -> its own
        # levels, all pre-checked (2-account has no default_levels override).
        for lvl in ("2A", "2B", "2C", "2D", "2E", "2F"):
            assert screen.query_one(f"#drawer-level-{lvl}", Checkbox).value is True
        with pytest.raises(Exception):
            screen.query_one("#drawer-level-M1", Checkbox)

        await pilot.click("#drawer-mode-3-account")
        await pilot.pause()

        # switching mode live-resets the level universe to 3-account's own
        for lvl in ("M1", "M2", "M3"):
            assert screen.query_one(f"#drawer-level-{lvl}", Checkbox).value is True
        with pytest.raises(Exception):
            screen.query_one("#drawer-level-2A", Checkbox)


@pytest.mark.asyncio
async def test_drawer_shows_harness_and_mode_advisories_as_info_lines(tmp_path):
    """WP1.5 task 5/6: Harness.advisories (rendered nowhere before this)
    and the currently-selected Mode.advisories both show as info lines in
    the drawer — and the info lines live-update when the mode radio
    switches (meeting-smoke's microsoft-* modes carry their own "needs a
    work tenant" advisory that 2-account/3-account don't)."""
    cfg = make_cfg(target=MICROSOFT_TARGET)  # hosts microsoft too, so the mode isn't disabled
    environ = make_environ(cfg)
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["meeting-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        sl = app.query_one("#harness-list", SelectionList)
        sl.focus()
        await pilot.press("enter")
        await pilot.pause()
        screen = app.screen
        assert isinstance(screen, sr.HarnessDrawerScreen)

        def advisories_text() -> str:
            return " | ".join(str(lbl.content) for lbl in screen.query("#drawer-advisories Label"))

        # 2-account (the default mode) carries no Mode.advisories of its own.
        assert "work tenant" not in advisories_text()

        await pilot.click("#drawer-mode-microsoft-2-account")
        await pilot.pause()
        assert "work tenant" in advisories_text()


@pytest.mark.asyncio
async def test_drawer_shows_harness_level_advisories(tmp_path):
    """Harness-level advisories (multiuser-smoke's reset recommendation and
    M7 re-mint prose) render in the drawer regardless of which mode is
    selected — distinct from the per-mode Mode.advisories."""
    cfg = make_cfg()
    environ = make_environ(cfg)
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["multiuser-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        sl = app.query_one("#harness-list", SelectionList)
        sl.focus()
        await pilot.press("enter")
        await pilot.pause()
        screen = app.screen
        assert isinstance(screen, sr.HarnessDrawerScreen)
        text = " | ".join(str(lbl.content) for lbl in screen.query("#drawer-advisories Label"))
        assert "reset recommended" in text
        assert "M7 offboard" in text


@pytest.mark.asyncio
async def test_drawer_engine_smoke_phase_radio_with_no_levels(tmp_path, dev_google_only):
    cfg = make_cfg()
    environ = make_environ(cfg)
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["engine-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        sl = app.query_one("#harness-list", SelectionList)
        sl.focus()
        await pilot.press("enter")
        await pilot.pause()

        screen = app.screen
        assert isinstance(screen, sr.HarnessDrawerScreen)

        radios = list(screen.query("RadioButton"))
        labels = {str(r.label) for r in radios}
        assert len(radios) == 3
        for mode in ("auto", "fanout", "microsoft"):
            assert any(mode in lbl for lbl in labels)
        # a Google-only dev doesn't host microsoft — the microsoft mode is
        # rendered disabled, with the reason, at target dev
        ms_radio = screen.query_one("#drawer-mode-microsoft", RadioButton)
        assert ms_radio.disabled
        assert "disabled" in str(ms_radio.label)

        levels_container = screen.query_one("#drawer-levels")
        assert list(levels_container.children) == []


@pytest.mark.asyncio
async def test_drawer_deselecting_a_level_enqueues_the_explicit_tuple(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)
    calls = []

    def fake_execute(argv, env, cwd, line_sink):
        calls.append(argv)
        line_sink("ALL PASS")
        line_sink("TOTAL 1/1 wall=0.1s")
        return 0

    core = make_core(tmp_path, execute=fake_execute, environ=environ, cfg=cfg,
                      probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    app = sr.SmokeRunnerApp(core, harness_names=["regression-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        sl = app.query_one("#harness-list", SelectionList)
        sl.focus()
        await pilot.press("enter")  # open drawer
        await pilot.pause()

        screen = app.screen
        cb7 = screen.query_one("#drawer-level-7", Checkbox)
        assert cb7.value is True  # "7" is in default_levels
        # Toggle directly rather than via pilot.click: regression-smoke's
        # drawer has 10 level checkboxes and can run off the default 24-row
        # headless terminal, which pilot.click refuses to target
        # (OutOfBounds) — setting the reactive value is what a click would
        # ultimately do anyway.
        cb7.value = False
        await pilot.pause()
        assert cb7.value is False

        await pilot.press("enter")  # apply (screen-level priority binding)
        await pilot.pause()

        sel = app._harness_selection["regression-smoke"]
        assert sel.mode == "google"
        assert sel.levels == ("1", "2", "3", "4", "5.1", "5.2", "6", "8")
        # persisted selection is reflected on the harness row's own label
        assert any("levels:1,2,3,4,5.1,5.2,6,8" in opt_label for opt_label, _value in app._harness_options())

        # Select the harness directly via the widget API rather than a
        # 'space' keypress: _refresh_harness_options() (fired by the drawer
        # closing) rebuilds the option list and can leave the highlighted
        # index in a state a keypress can't reliably rely on.
        sl2 = app.query_one("#harness-list", SelectionList)
        sl2.select("regression-smoke")
        await pilot.pause()
        await pilot.press("r")
        await wait_until(lambda: not app._worker_active and len(calls) == 1)
        await pilot.pause()

        assert len(calls) == 1
        argv = calls[0]
        assert "--levels" in argv
        assert argv[argv.index("--levels") + 1] == "1,2,3,4,5.1,5.2,6,8"


@pytest.mark.asyncio
async def test_drawer_selection_equal_to_default_enqueues_levels_none(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)
    calls = []

    def fake_execute(argv, env, cwd, line_sink):
        calls.append(argv)
        line_sink("ALL PASS")
        line_sink("TOTAL 1/1 wall=0.1s")
        return 0

    core = make_core(tmp_path, execute=fake_execute, environ=environ, cfg=cfg,
                      probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    app = sr.SmokeRunnerApp(core, harness_names=["regression-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        sl = app.query_one("#harness-list", SelectionList)
        sl.focus()
        await pilot.press("enter")  # open drawer
        await pilot.pause()
        await pilot.press("enter")  # apply, unchanged -> matches the default set
        await pilot.pause()

        sel = app._harness_selection["regression-smoke"]
        assert sel.mode == "google"
        assert sel.levels is None

        sl2 = app.query_one("#harness-list", SelectionList)
        sl2.select("regression-smoke")  # see the previous test's comment on why not 'space'
        await pilot.pause()
        await pilot.press("r")
        await wait_until(lambda: not app._worker_active and len(calls) == 1)
        await pilot.pause()

        assert len(calls) == 1
        assert "--levels" not in calls[0]


@pytest.mark.asyncio
async def test_drawer_mode_incompatible_with_current_target_is_disabled(tmp_path, dev_google_only):
    cfg = make_cfg()  # cfg.target defaults to "dev"
    environ = make_environ(cfg)
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["regression-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app.core.cfg.target == "dev"
        sl = app.query_one("#harness-list", SelectionList)
        sl.focus()
        await pilot.press("enter")
        await pilot.pause()

        screen = app.screen
        ms_radio = screen.query_one("#drawer-mode-microsoft")
        assert ms_radio.disabled is True
        assert "disabled" in str(ms_radio.label)
        assert "'dev'" in str(ms_radio.label)

        google_radio = screen.query_one("#drawer-mode-google")
        assert google_radio.disabled is False


@pytest.mark.asyncio
async def test_drawer_single_mode_harness_shows_blocked_info_for_wrong_target(tmp_path, dev_google_only):
    cfg = make_cfg()  # cfg.target defaults to "dev", which can't run ms-smoke's only (microsoft) mode
    environ = make_environ(cfg)
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["ms-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        sl = app.query_one("#harness-list", SelectionList)
        sl.focus()
        await pilot.press("enter")
        await pilot.pause()

        screen = app.screen
        with pytest.raises(Exception):
            screen.query_one("#drawer-mode", RadioSet)  # single mode -> no RadioSet

        info = screen.query_one("#drawer-mode-info")
        text = str(info.content)
        assert "BLOCKED" in text
        assert "'dev'" in text


# =============================================================================
# Round 4 (Opus review, REQUEST-CHANGES) — B1 SECURITY blocker + M1-M9 + N1-N6.
# =============================================================================


# -- B1 (SECURITY): a spawn exception must never escape run_next/_drain_queue,
# and must never carry a raw token into any surfaced text ------------------


def test_default_execute_survives_a_non_utf8_byte_in_child_output():
    lines: list[str] = []
    code = sr.default_execute(
        [sys.executable, "-c",
         "import sys; sys.stdout.buffer.write(b'ok \\xff\\xfe end\\n'); sys.stdout.flush()"],
        {}, str(BIN.parent), lines.append,
    )
    assert code == 0
    assert len(lines) == 1
    assert "end" in lines[0]  # decoded with errors='replace', not raised


def test_run_next_execute_exception_is_caught_scrubbed_and_recorded(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)
    leaked_token = environ["A_BEARER"]

    def raising_execute(argv, env, cwd, line_sink):
        # A realistic Popen failure message might well echo argv/env-shaped
        # text back — scrub_secrets must catch a token-shaped substring
        # anywhere in str(exc), not just in a known-safe field.
        raise FileNotFoundError(f"[Errno 2] No such file or directory: 'uv' (bearer={leaked_token})")

    core = make_core(tmp_path, execute=raising_execute, environ=environ, cfg=cfg,
                      probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    core.enqueue(sr.QueuedRun(harness="config-smoke", mode="default", target="dev"))
    completed = core.run_next()  # must not raise

    assert completed.outcome is not None
    assert completed.outcome.status == "FAIL"
    assert leaked_token not in completed.outcome.detail
    assert "[REDACTED-TOKEN]" in completed.outcome.detail
    assert completed.exit_code is None

    runs_jsonl = tmp_path / "state" / "runs.jsonl"
    rec = json.loads(runs_jsonl.read_text(encoding="utf-8").splitlines()[0])
    assert rec["status"] == "FAIL"
    assert rec["exit_code"] is None
    assert leaked_token not in json.dumps(rec)


def test_run_next_interactive_execute_exception_is_caught_and_scrubbed(tmp_path, monkeypatch):
    interactive_poll_smoke(monkeypatch)
    cfg = make_cfg(poll_invitee_a_set="b@example.com", poll_invitee_b_set="c@example.com")
    environ = make_environ(cfg)
    leaked_token = environ["A_BEARER"]

    def raising_interactive(argv, env, cwd):
        raise RuntimeError(f"boom bearer={leaked_token}")

    core = make_core(tmp_path, interactive_execute=raising_interactive, environ=environ, cfg=cfg,
                      probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    core.enqueue(sr.QueuedRun(harness="poll-smoke", mode="default", target="dev"))
    completed = core.run_next()

    assert completed.outcome.status == "FAIL"
    assert leaked_token not in completed.outcome.detail
    assert completed.log_path is None


@pytest.mark.asyncio
async def test_drain_queue_survives_execute_exception_and_notifies_scrubbed(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)
    leaked_token = environ["A_BEARER"]

    def raising_execute(argv, env, cwd, line_sink):
        raise FileNotFoundError(f"No such file or directory: 'uv' (bearer={leaked_token})")

    core = make_core(tmp_path, execute=raising_execute, environ=environ, cfg=cfg,
                      probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:  # would raise WorkerFailed if this crashed the app
        await pilot.pause()
        sl = app.query_one("#harness-list", SelectionList)
        sl.focus()
        await pilot.press("space")
        await pilot.press("r")
        await wait_until(lambda: not app._worker_active)
        await pilot.pause()

        rows = list(app.query(".run-result"))
        assert any("status-fail" in r.classes for r in rows)
        for r in rows:
            assert leaked_token not in str(r.content)


# -- M1: an enqueue landing during worker teardown must not strand a run ----


def test_mark_worker_idle_restarts_drain_if_queue_is_non_empty(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    started = []

    def fake_start_queue_worker():
        started.append(True)

    app._start_queue_worker = fake_start_queue_worker  # observe restart without a real Textual loop
    app._worker_active = True

    # Simulate the exact race: something got enqueued in the window between
    # _drain_queue seeing an empty queue and _mark_worker_idle running.
    core.enqueue(sr.QueuedRun(harness="config-smoke", mode="default", target="dev"))
    app._mark_worker_idle()

    assert app._worker_active is False
    assert started == [True]  # M1: restarted, not stranded


def test_mark_worker_idle_does_not_restart_when_queue_is_empty(tmp_path):
    cfg = make_cfg()
    core = make_core(tmp_path, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    started = []
    app._start_queue_worker = lambda: started.append(True)
    app._worker_active = True

    app._mark_worker_idle()

    assert app._worker_active is False
    assert started == []


# -- M2: 'enter' on a results-pane row opens its log; a running row opens
# with follow=True ----------------------------------------------------------


@pytest.mark.asyncio
async def test_enter_on_completed_row_opens_log_viewer_without_follow(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)

    def fake_execute(argv, env, cwd, line_sink):
        line_sink("C1 PASS")
        line_sink("ALL PASS")
        return 0

    core = make_core(tmp_path, execute=fake_execute, environ=environ, cfg=cfg,
                      probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        sl = app.query_one("#harness-list", SelectionList)
        sl.focus()
        await pilot.press("space")
        await pilot.press("r")
        await wait_until(lambda: not app._worker_active)
        await pilot.pause()

        rows = list(app.query(".run-result"))
        assert len(rows) == 1
        rows[0].focus()
        await pilot.pause()
        await pilot.press("enter")
        await pilot.pause()

        assert isinstance(app.screen, sr.LogViewerScreen)
        assert app.screen._follow is False
        assert "C1 PASS" in "\n".join(app.screen._lines)


@pytest.mark.asyncio
async def test_enter_on_running_row_opens_log_viewer_with_follow(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)
    release = threading.Event()

    def blocking_execute(argv, env, cwd, line_sink):
        line_sink("C1 PASS")
        release.wait(timeout=5)  # held open until the test presses enter and checks state
        line_sink("ALL PASS")
        return 0

    core = make_core(tmp_path, execute=blocking_execute, environ=environ, cfg=cfg,
                      probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        sl = app.query_one("#harness-list", SelectionList)
        sl.focus()
        await pilot.press("space")
        await pilot.press("r")

        rows = None
        try:
            await wait_until(lambda: bool(list(app.query(".status-running"))), timeout=3.0)
            await pilot.pause()
            rows = list(app.query(".status-running"))
            assert len(rows) == 1
            rows[0].focus()
            await pilot.pause()
            await pilot.press("enter")
            await pilot.pause()

            assert isinstance(app.screen, sr.LogViewerScreen)
            assert app.screen._follow is True
        finally:
            release.set()
            await wait_until(lambda: not app._worker_active)


# -- M3: target no longer auto-corrected — a Blocked row + no spawn --------


@pytest.mark.asyncio
async def test_other_target_with_dev_only_mode_renders_blocked_and_never_spawns(tmp_path, staging_target):
    # engine-smoke's fanout mode is dev-only (it needs dev's
    # SOLVER_ENGINE_FANOUT_MIN_CHUNKS override).
    cfg = make_cfg(target=staging_target)
    environ = make_environ(cfg, TURNSTILE_SECRET_STAGING="op-injected-staging-secret")
    core = make_core(tmp_path, execute=fail_execute, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["engine-smoke"])
    app._harness_selection["engine-smoke"] = sr.HarnessSelection(mode="fanout", levels=None)
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app.core.cfg.target == staging_target

        label = next(lbl for lbl, name in app._harness_options() if name == "engine-smoke")
        assert "BLOCKED" in label
        assert f"'{staging_target}'" in label

        sl = app.query_one("#harness-list", SelectionList)
        sl.focus()
        await pilot.press("space")
        await pilot.press("r")
        await wait_until(lambda: not app._worker_active)
        await pilot.pause()

        rows = list(app.query(".run-result"))
        assert len(rows) == 1
        assert "status-blocked" in rows[0].classes
        assert f"'{staging_target}'" in str(rows[0].content)


@pytest.mark.asyncio
async def test_booking_smoke_microsoft_default_at_target_dev_renders_blocked_not_a_silent_google_run(
        tmp_path, dev_google_only):
    """2026-09-17 review nit: at target dev with provider=microsoft (`P`),
    _default_mode_for picks booking-smoke's microsoft-base (the first mode
    naming the campaign provider) — but a Google-only dev can't run
    microsoft-base. The M3 design rule applies here too: that mismatch must render as a loud
    BLOCKED row naming target 'dev', never silently fall back to running
    booking-smoke's Google `base` mode instead."""
    cfg = make_cfg(target="dev", provider="microsoft")
    environ = make_environ(cfg)
    core = make_core(tmp_path, execute=fail_execute, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["booking-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app.core.cfg.target == "dev"
        assert app.core.cfg.provider == "microsoft"

        label = next(lbl for lbl, name in app._harness_options() if name == "booking-smoke")
        assert label.startswith("booking-smoke  (microsoft-base)")
        assert "BLOCKED" in label
        assert "'dev'" in label

        sl = app.query_one("#harness-list", SelectionList)
        sl.focus()
        await pilot.press("space")
        await pilot.press("r")
        await wait_until(lambda: not app._worker_active)
        await pilot.pause()

        rows = list(app.query(".run-result"))
        assert len(rows) == 1
        assert "status-blocked" in rows[0].classes
        assert "'dev'" in str(rows[0].content)


# -- M4: STALE/WRONG_ACCOUNT identity rows carry the login command ---------


def test_stale_identity_status_reachable_via_core_probe_all(tmp_path):
    """Sanity precondition for the Pilot test below: classify() really does
    reach STALE for a 401 revoked_token, via the same probe_all() path the
    app uses — isolates a classify()/registry regression from an App bug."""
    cfg = make_cfg()
    environ = make_environ(cfg, include_scheduler=False)
    core = make_core(tmp_path, environ=environ, cfg=cfg,
                      probe=lambda url, bearer, timeout=10.0: ident.ProbeResult(
                          status=401, body={"error": "revoked_token"}))
    core.probe_all()
    assert core.identity_statuses["google:a"].state == ident.IdentityState.STALE


@pytest.mark.asyncio
async def test_identity_table_login_command_pilot(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg, include_scheduler=False)
    core = make_core(
        tmp_path, environ=environ, cfg=cfg,
        probe=lambda url, bearer, timeout=10.0: ident.ProbeResult(status=401, body={"error": "revoked_token"}),
    )
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        await wait_until(lambda: "STALE" in identity_pane_text(app))
        rows_text = identity_pane_text(app)
        assert "STALE" in rows_text
        assert "mu-smoke-login.py" in rows_text  # the copy-ready command, in the pane itself


@pytest.mark.asyncio
async def test_identity_pane_login_command_for_microsoft_letter_targets_its_host(tmp_path, staging_target):
    """WP1.5 task 4: a microsoft:<letter> row's login command/hint is built
    against the host of the target hosting provider "microsoft" even while
    the app's current target is a Google-only one — mirrors _probe_url_for_slot."""
    cfg = make_cfg(target=staging_target, microsoft={"a": "msa@example.com"}, microsoft_primary="a")
    environ = make_environ(cfg, include_scheduler=False)
    core = make_core(
        tmp_path, environ=environ, cfg=cfg,
        probe=lambda url, bearer, timeout=10.0: ident.ProbeResult(status=401, body={"error": "revoked_token"}),
    )
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        await wait_until(lambda: "microsoft:a" in identity_pane_text(app))
        row_text = str(identity_row(app, "microsoft:a").content)
        assert reg.TARGETS[MICROSOFT_TARGET].scheduler_url in row_text
        assert reg.TARGETS[staging_target].scheduler_url not in row_text
        assert "--provider microsoft" in row_text


# -- M5: probe_all runs off the UI thread ------------------------------------


@pytest.mark.asyncio
async def test_probe_runs_via_worker_and_first_paint_is_not_blocked(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg, include_scheduler=False)
    probe_started = threading.Event()
    probe_may_finish = threading.Event()

    def slow_probe(url, bearer, timeout=10.0):
        probe_started.set()
        probe_may_finish.wait(timeout=5)
        return ident.ProbeResult(status=200, body={"email": cfg.google["a"]})

    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=slow_probe)
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    try:
        async with app.run_test() as pilot:
            # If probe_all() ran synchronously in on_mount, run_test() itself
            # would already have blocked for the probe above — reaching here
            # at all, promptly, is the first half of the proof.
            await pilot.pause()
            rows_text = identity_pane_text(app)
            assert "UNPROBED" in rows_text  # first paint landed before the slow probe returned

            await wait_until(lambda: probe_started.is_set(), timeout=3.0)
            probe_may_finish.set()
            await wait_until(lambda: core.identity_statuses.get("google:a") is not None)
            await wait_until(lambda: "VALID" in identity_pane_text(app) or "FRESH" in identity_pane_text(app))
            rows_text2 = identity_pane_text(app)
            assert "VALID" in rows_text2 or "FRESH" in rows_text2
    finally:
        probe_may_finish.set()


# -- M6: SUSPECT no longer shares a colour token with ALL-SKIPPED/BLOCKED --


def test_suspect_css_uses_secondary_not_accent():
    assert "$secondary" in sr.SmokeRunnerApp.CSS
    # the .status-suspect rule specifically, not just $secondary appearing
    # somewhere unrelated in the stylesheet
    idx = sr.SmokeRunnerApp.CSS.index(".status-suspect")
    rule_body = sr.SmokeRunnerApp.CSS[idx:idx + 200]
    assert "$secondary" in rule_body
    assert "color: $accent" not in rule_body


# -- M7: target/op-secrets badges are real widgets carrying their classes --


@pytest.mark.asyncio
async def test_target_and_op_secrets_badges_render_with_classes(tmp_path, staging_target):
    cfg = make_cfg(target="dev")
    environ = make_environ(cfg)  # CLOUDFLARE_API_TOKEN present -> op-secrets-ok
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    next_target = list(reg.TARGETS)[1]  # `t` cycles TARGETS in order
    async with app.run_test() as pilot:
        await pilot.pause()
        target_badge = app.query_one("#target-badge")
        assert "target-dev" in target_badge.classes
        assert f"target-{next_target}" not in target_badge.classes
        op_badge = app.query_one("#op-secrets-badge")
        assert "op-secrets-ok" in op_badge.classes
        assert "✓" in str(op_badge.content)

        await pilot.press("t")
        await pilot.pause()

        target_badge2 = app.query_one("#target-badge")
        assert f"target-{next_target}" in target_badge2.classes
        assert "target-dev" not in target_badge2.classes
        assert next_target in str(target_badge2.content)
        # every non-dev target gets the loud badge colour, not just one name
        assert "target-other" in target_badge2.classes
        idx = sr.SmokeRunnerApp.CSS.index("#target-badge.target-other")
        assert "$secondary" in sr.SmokeRunnerApp.CSS[idx:idx + 80]


@pytest.mark.asyncio
async def test_op_secrets_badge_missing_class_without_cloudflare_token(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)
    del environ["CLOUDFLARE_API_TOKEN"]
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        op_badge = app.query_one("#op-secrets-badge")
        assert "op-secrets-missing" in op_badge.classes
        assert "✗" in str(op_badge.content)


# -- M8: a row shows a running state between queued and its final status --


@pytest.mark.asyncio
async def test_row_status_flips_queued_running_then_final(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)
    release = threading.Event()
    seen_running = threading.Event()

    def blocking_execute(argv, env, cwd, line_sink):
        release.wait(timeout=5)
        line_sink("ALL PASS")
        return 0

    core = make_core(tmp_path, execute=blocking_execute, environ=environ, cfg=cfg,
                      probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        sl = app.query_one("#harness-list", SelectionList)
        sl.focus()
        await pilot.press("space")
        await pilot.press("r")
        # Not asserting "status-queued" here: the background worker (and its
        # call_from_thread hop to _mark_row_running) can plausibly already
        # have flipped the row to "status-running" by the time this
        # coroutine resumes — the meaningful assertion is the transition
        # itself (queued was the row's class at creation; running is
        # observed next; the final status follows release.set()).
        try:
            await wait_until(lambda: "status-running" in list(app.query(".run-result"))[0].classes, timeout=3.0)
            seen_running.set()
            row = list(app.query(".run-result"))[0]
            assert "status-queued" not in row.classes
            assert "⏳" in str(row.content)
        finally:
            release.set()

        await wait_until(lambda: not app._worker_active)
        await pilot.pause()
        row_final = list(app.query(".run-result"))[0]
        assert "status-running" not in row_final.classes
        assert "status-pass" in row_final.classes
        assert seen_running.is_set()


# -- M9: additional test gaps -------------------------------------------------


def test_runs_jsonl_record_has_ts_and_levels_keys(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)

    def fake_execute(argv, env, cwd, line_sink):
        line_sink("ALL PASS")
        return 0

    core = make_core(tmp_path, execute=fake_execute, environ=environ, cfg=cfg,
                      probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    core.enqueue(sr.QueuedRun(harness="config-smoke", mode="default", target="dev", levels=("1", "2")))
    completed = core.run_next()
    assert completed.outcome.status in ("PASS", "SUSPECT")  # config-smoke has no level concept; just don't crash

    rec = json.loads((tmp_path / "state" / "runs.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert "ts" in rec and rec["ts"]
    assert "levels" in rec
    assert rec["levels"] == ["1", "2"]


@pytest.mark.asyncio
async def test_reset_env_modal_pilot_flow_provider_maps_to_target_and_flags_land_in_argv(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)
    calls = []

    def fake_execute(argv, env, cwd, line_sink):
        calls.append(argv)
        return 0

    core = make_core(tmp_path, execute=fake_execute, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("R")
        await pilot.pause()
        assert isinstance(app.screen, sr.ResetEnvModal)

        await pilot.click("#reset-microsoft")
        await pilot.click("#reset-dry-run")
        await pilot.pause()
        await pilot.press("enter")
        await wait_until(lambda: not app._worker_active)
        await pilot.pause()

        assert len(calls) == 1
        argv = calls[0]
        assert argv[2] == "bin/reset-smoke-env.py"
        assert "--provider" in argv and argv[argv.index("--provider") + 1] == "microsoft"
        assert "--dry-run" in argv

        rows = list(app.query(".run-result"))
        assert len(rows) == 1
        assert "(microsoft)" in str(rows[0].content) or "reset-smoke-env" in str(rows[0].content)


def test_meeting_3account_blocked_when_google_a_unseeded(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)  # only google:a's own letter set is present, and 3-account needs it too — remove it
    del environ["A_BEARER"], environ["A_REFRESH"], environ["A_EXPECTED_EMAIL"]
    core = make_core(tmp_path, execute=fail_execute, environ=environ, cfg=cfg, probe=make_probe({}))
    core.enqueue(sr.QueuedRun(harness="meeting-smoke", mode="3-account", target="dev"))
    completed = core.run_next()
    assert completed.outcome is None
    assert "google:a" in completed.blocked_reason
    assert "mu-smoke-login.py" in completed.blocked_reason


def test_meeting_3account_seeded_projects_argv_and_identities(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg, B_BEARER=token("qB"), B_REFRESH=token("rB"), B_EXPECTED_EMAIL=cfg.google["b"],
                            C_BEARER=token("qC"), C_REFRESH=token("rC"), C_EXPECTED_EMAIL=cfg.google["c"])
    seen = {}

    def fake_execute(argv, env, cwd, line_sink):
        seen["argv"] = argv
        seen["env"] = env
        line_sink("TOTAL pass=3 skipped=0 of 3")
        return 0

    core = make_core(tmp_path, execute=fake_execute, environ=environ, cfg=cfg,
                      probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    core.enqueue(sr.QueuedRun(harness="meeting-smoke", mode="3-account", target="dev"))
    completed = core.run_next()

    assert completed.blocked_reason is None
    assert "--accounts" in seen["argv"]
    assert seen["argv"][seen["argv"].index("--accounts") + 1] == "3"
    assert seen["env"]["A_BEARER"] == environ["A_BEARER"]
    assert seen["env"]["B_BEARER"] == environ["B_BEARER"]
    assert seen["env"]["C_BEARER"] == environ["C_BEARER"]


# -- N1: log filename dedupe within the same wall-clock second -------------


def test_log_filename_dedupes_within_the_same_second(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)

    def fake_execute(argv, env, cwd, line_sink):
        line_sink("ALL PASS")
        return 0

    # A clock that never advances -> both runs compute the identical
    # yyyymmddThhmmssZ prefix, forcing the collision N1 must dedupe.
    const_clock = lambda: START  # noqa: E731

    core = make_core(tmp_path, execute=fake_execute, environ=environ, cfg=cfg, clock=const_clock,
                      probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    core.enqueue(sr.QueuedRun(harness="config-smoke", mode="default", target="dev"))
    first = core.run_next()
    core.enqueue(sr.QueuedRun(harness="config-smoke", mode="default", target="dev"))
    second = core.run_next()

    assert first.log_path != second.log_path
    assert first.log_path.exists() and second.log_path.exists()
    assert second.log_path.name.endswith("-2.log")


# -- N4: follow-tail only autoscrolls when already at the bottom ------------


@pytest.mark.asyncio
async def test_follow_tail_does_not_autoscroll_when_scrolled_up(tmp_path):
    log_path = tmp_path / "live.log"
    initial = "\n".join(f"line {i}" for i in range(100)) + "\n"
    log_path.write_text(initial, encoding="utf-8")
    core = make_core(tmp_path)
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        await app.push_screen(sr.LogViewerScreen(log_path, "t", follow=True))
        await pilot.pause()
        screen = app.screen
        scroll = screen.query_one("#log-scroll")
        scroll.scroll_to(y=0, animate=False)  # scroll to the top, away from the bottom
        await pilot.pause()
        y_before = scroll.scroll_y
        assert y_before < scroll.max_scroll_y

        with log_path.open("a", encoding="utf-8") as f:
            f.write("new line A\nnew line B\n")
        screen.poll_for_new_lines()
        await pilot.pause()

        assert scroll.scroll_y == y_before  # did not get yanked to the bottom


# =============================================================================
# Round 5 (final clean-context review) — seed diagnostics, probe-worker crash
# guard everywhere, identity colour semantics, settings + rescan reload.
# =============================================================================


# -- item 1: seed diagnostics surfaced, not dropped -------------------------


@pytest.mark.asyncio
async def test_seed_warnings_rendered_in_identity_pane(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg, include_scheduler=False)
    # A SCHEDULER_* triple whose account matches nothing in the config cast
    # -> seed_identities surfaces a warning (SeedReport.warnings) instead of
    # silently dropping the triple.
    environ["SCHEDULER_BEARER"] = token("qS")
    environ["SCHEDULER_REFRESH_TOKEN"] = token("rS")
    environ["EXPECTED_TEST_ACCOUNT"] = "nobody@example.com"
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    assert core.seed_warnings  # precondition: RunnerCore really computed one

    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        banner = app.query_one("#seed-warnings")
        assert "hidden" not in banner.classes
        assert "nobody@example.com" in str(banner.content)
        assert "config cast" in str(banner.content)


@pytest.mark.asyncio
async def test_seed_warnings_banner_hidden_when_none(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    assert core.seed_warnings == ()
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        banner = app.query_one("#seed-warnings")
        assert "hidden" in banner.classes


def test_seed_partial_reported_by_core(tmp_path):
    cfg = make_cfg(google={"a": "a@example.com"})  # no 'b' letter in config at all
    environ = make_environ(cfg)
    environ["B_BEARER"] = token("qB")  # B_REFRESH deliberately missing -> a half-export
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    assert "google:b" in core.seed_partial
    assert "B_REFRESH" in core.seed_partial["google:b"]


@pytest.mark.asyncio
async def test_partial_seed_shown_as_absent_with_missing_detail(tmp_path):
    cfg = make_cfg(google={"a": "a@example.com"})  # 'b' has no configured email
    environ = make_environ(cfg)
    environ["B_BEARER"] = token("qB")  # B_REFRESH missing
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        row = identity_row(app, "google:b")
        text = str(row.content)
        assert "ABSENT" in text
        assert "missing B_REFRESH" in text
        assert "identity-absent" in row.classes


# -- item 2: B1(c) crash guard applied to the probe workers too -------------


def test_probe_workers_declare_exit_on_error_false():
    """Static-inspection guard (deliberately not a Pilot test that fakes a
    worker crash — Textual's own exit_on_error handling isn't something this
    suite should re-verify): every run_worker(...) call that dispatches
    _probe_and_render must carry exit_on_error=False, the same B1(c) posture
    _start_queue_worker's run_worker(_drain_queue, ...) call already has —
    an exception surfacing through call_from_thread here would otherwise
    reach Textual's fatal show_locals renderer with an IdentityTokens
    (bearer/refresh) in frame locals."""
    src = Path(sr.__file__).read_text(encoding="utf-8")
    calls = [
        line for line in src.splitlines()
        if "run_worker(self._probe_and_render" in line
    ]
    assert len(calls) == 3  # on_mount, action_probe_now, action_rescan_env
    for line in calls:
        assert "exit_on_error=False" in line, line


@pytest.mark.asyncio
async def test_probe_and_render_survives_probe_all_exception_and_notifies_scrubbed(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg)
    leaked_token = environ["A_BEARER"]
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))

    def raising_probe_all():
        raise RuntimeError(f"boom bearer={leaked_token}")

    core.probe_all = raising_probe_all  # simulate a bug reaching _probe_and_render's own try/except
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:  # would raise if this crashed the app
        await pilot.pause()
        await pilot.press("p")
        await pilot.pause()
        # No assertion needs the notify toast's exact text (Textual renders
        # notifications outside what query() sees by default) — surviving
        # to here, with the app still alive and no token anywhere in the
        # accessible DOM, is the proof.
        rendered = "".join(str(w.content) for w in app.query("Static") if hasattr(w, "content"))
        assert leaked_token not in rendered


# -- item 3: identity-pane colour semantics ----------------------------------


@pytest.mark.asyncio
async def test_identity_row_classes_for_fresh_stale_absent(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg, include_scheduler=False)
    minted_at = (START - timedelta(minutes=1)).isoformat()  # fresh, well over 10m left
    environ["A_MINTED_AT"] = minted_at
    core = make_core(tmp_path, environ=environ, cfg=cfg,
                      probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}),
                      clock=FakeClock(START))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        await wait_until(lambda: core.identity_statuses.get("google:a") is not None)
        await wait_until(lambda: "identity-fresh" in identity_row(app, "google:a").classes)

        fresh_row = identity_row(app, "google:a")
        assert "identity-fresh" in fresh_row.classes
        assert "identity-fresh-dimming" not in fresh_row.classes

        absent_row = identity_row(app, "google:b")  # in the config cast, never seeded
        assert "identity-absent" in absent_row.classes


@pytest.mark.asyncio
async def test_identity_row_stale_class(tmp_path):
    cfg = make_cfg()
    environ = make_environ(cfg, include_scheduler=False)
    core = make_core(tmp_path, environ=environ, cfg=cfg,
                      probe=lambda url, bearer, timeout=10.0: ident.ProbeResult(
                          status=401, body={"error": "revoked_token"}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        await wait_until(lambda: "identity-stale" in identity_row(app, "google:a").classes)
        assert "identity-stale" in identity_row(app, "google:a").classes


def test_identity_row_class_fresh_dims_under_ten_minutes():
    # 9 minutes remaining -> "bearer 9m" in the detail -> dims to yellow.
    assert sr._identity_row_class("FRESH", "bearer 9m · refresh 89d") == "identity-fresh-dimming"
    assert sr._identity_row_class("FRESH", "bearer 43m · refresh 89d") == "identity-fresh"
    assert sr._identity_row_class("VALID", "probe ok — expiry unknown") == "identity-valid"
    assert sr._identity_row_class("BEARER_EXPIRED", "x") == "identity-bearer-expired"
    assert sr._identity_row_class("STALE", "x") == "identity-stale"
    assert sr._identity_row_class("WRONG_ACCOUNT", "x") == "identity-wrong-account"
    assert sr._identity_row_class("ABSENT", "x") == "identity-absent"
    assert sr._identity_row_class("PROBE_ERROR", "x") == "identity-unprobed"


# -- item 4: settings — rescan reloads config.toml; a minimal settings modal -


def test_rescan_reloads_config_from_disk(tmp_path, staging_target):
    cfg = make_cfg(target="dev")
    core = make_core(tmp_path, cfg=cfg, probe=make_probe({}))
    assert core.cfg.target == "dev"

    edited = dataclasses.replace(cfg, target=staging_target, microsoft_attendee="new-attendee@example.com")
    ident.save_config(edited, core.config_path)

    core.rescan()

    assert core.cfg.target == staging_target
    assert core.cfg.microsoft_attendee == "new-attendee@example.com"


@pytest.mark.asyncio
async def test_app_focus_triggers_rescan(tmp_path, staging_target):
    cfg = make_cfg(target="dev")
    core = make_core(tmp_path, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        edited = dataclasses.replace(cfg, target=staging_target)
        ident.save_config(edited, core.config_path)

        app.on_app_focus(None)  # events.AppFocus.handler_name == "on_app_focus"
        await pilot.pause()

        assert core.cfg.target == staging_target
        badge = app.query_one("#target-badge")
        assert f"target-{staging_target}" in badge.classes


@pytest.mark.asyncio
async def test_settings_modal_apply_writes_file_and_updates_pane(tmp_path, staging_target):
    cfg = make_cfg(target="dev")
    environ = make_environ(cfg)
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("s")
        await pilot.pause()
        assert isinstance(app.screen, sr.SettingsModal)

        target_input = app.screen.query_one("#settings-target", Input)
        target_input.value = staging_target
        attendee_input = app.screen.query_one("#settings-ms-attendee", Input)
        attendee_input.value = "attendee2@example.com"

        await pilot.press("enter")
        await pilot.pause()

        on_disk = ident.load_config(core.config_path)
        assert on_disk.target == staging_target
        assert on_disk.microsoft_attendee == "attendee2@example.com"
        assert core.cfg.target == staging_target  # rescanned in

        badge = app.query_one("#target-badge")
        assert f"target-{staging_target}" in badge.classes
        assert staging_target in str(badge.content)


@pytest.mark.asyncio
async def test_settings_modal_apply_preserves_the_microsoft_letter_cast(tmp_path):
    """BLOCKING (identity review): SettingsModal.action_apply used to build
    RunnerConfig(...) WITHOUT microsoft=, so pressing enter silently wiped
    the [microsoft] letter cast from config.toml even when nothing about it
    was touched. Opening settings and applying unchanged must round-trip
    every configured Microsoft letter."""
    cfg = make_cfg(microsoft={"a": "msa@example.com", "b": "msb@example.com"}, microsoft_primary="b")
    environ = make_environ(cfg)
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("s")
        await pilot.pause()
        assert isinstance(app.screen, sr.SettingsModal)

        # Sanity: the modal actually loaded both letters into the form.
        assert app.screen.query_one("#settings-ms-a", Input).value == "msa@example.com"
        assert app.screen.query_one("#settings-ms-b", Input).value == "msb@example.com"
        assert app.screen.query_one("#settings-ms-primary", Input).value == "b"

        await pilot.press("enter")  # apply unchanged
        await pilot.pause()

        on_disk = ident.load_config(core.config_path)
        assert on_disk.microsoft == {"a": "msa@example.com", "b": "msb@example.com"}
        assert on_disk.microsoft_primary == "b"
        assert core.cfg.microsoft == {"a": "msa@example.com", "b": "msb@example.com"}


@pytest.mark.asyncio
async def test_settings_modal_rejects_invalid_microsoft_primary_and_stays_open(tmp_path):
    """BLOCKING (review round 2): a junk microsoft primary ("d") used to
    reach _smoke_identity.RunnerConfig fine (it's just a str field) and
    only blow up as a ValueError inside save_config, called from the
    push_screen dismiss callback — an uncaught exception there took the
    whole TUI down with a traceback, orphaning any running harness child.
    action_apply must validate BEFORE dismissing and keep the modal open
    on invalid input, notifying why."""
    cfg = make_cfg()
    core = make_core(tmp_path, environ=make_environ(cfg), cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    notified: list[tuple[tuple, dict]] = []
    app.notify = lambda *a, **k: notified.append((a, k))
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("s")
        await pilot.pause()
        assert isinstance(app.screen, sr.SettingsModal)

        app.screen.query_one("#settings-ms-primary", Input).value = "d"
        await pilot.press("enter")
        await pilot.pause()

        # The app must still be alive and the modal must still be open —
        # invalid input is rejected, not fatal.
        assert app.is_running
        assert isinstance(app.screen, sr.SettingsModal)
        assert notified
        assert any("a/b/c" in str(call[0]) for call in notified)

        # On disk, nothing was written — the original config is untouched.
        on_disk = ident.load_config(core.config_path)
        assert on_disk.microsoft_primary == cfg.microsoft_primary


@pytest.mark.asyncio
async def test_settings_modal_rejects_invalid_google_primary_and_stays_open(tmp_path):
    cfg = make_cfg()
    core = make_core(tmp_path, environ=make_environ(cfg), cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    notified: list[tuple[tuple, dict]] = []
    app.notify = lambda *a, **k: notified.append((a, k))
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("s")
        await pilot.pause()
        assert isinstance(app.screen, sr.SettingsModal)

        app.screen.query_one("#settings-google-primary", Input).value = "zz"
        await pilot.press("enter")
        await pilot.pause()

        assert app.is_running
        assert isinstance(app.screen, sr.SettingsModal)
        assert notified
        assert any("a/b/c" in str(call[0]) for call in notified)


@pytest.mark.asyncio
async def test_settings_modal_rejects_invalid_target_and_stays_open(tmp_path):
    cfg = make_cfg()
    core = make_core(tmp_path, environ=make_environ(cfg), cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    notified: list[tuple[tuple, dict]] = []
    app.notify = lambda *a, **k: notified.append((a, k))
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("s")
        await pilot.pause()
        assert isinstance(app.screen, sr.SettingsModal)

        app.screen.query_one("#settings-target", Input).value = "prod"
        await pilot.press("enter")
        await pilot.pause()

        assert app.is_running
        assert isinstance(app.screen, sr.SettingsModal)
        assert notified
        assert any(all(name in str(call[0]) for name in reg.TARGETS) for call in notified)


@pytest.mark.asyncio
async def test_settings_modal_save_config_value_error_notifies_instead_of_crashing(tmp_path, monkeypatch):
    """Belt-and-braces (review round 2): even with action_apply's own
    validation in place, _on_result wraps save_config in try/except
    ValueError -> notify, so a ValueError from any OTHER path through
    save_config can never propagate out of the push_screen callback."""
    cfg = make_cfg()
    core = make_core(tmp_path, environ=make_environ(cfg), cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    notified: list[tuple[tuple, dict]] = []
    app.notify = lambda *a, **k: notified.append((a, k))

    def raiser(*a, **k):
        raise ValueError("boom")
    monkeypatch.setattr(sr._smoke_identity, "save_config", raiser)

    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("s")
        await pilot.pause()
        assert isinstance(app.screen, sr.SettingsModal)

        await pilot.press("enter")  # apply unchanged — every field is valid
        await pilot.pause()

        assert app.is_running  # never crashed
        assert notified
        assert any("boom" in str(call[0]) for call in notified)


@pytest.mark.asyncio
async def test_settings_modal_cancel_writes_nothing(tmp_path):
    cfg = make_cfg(target="dev")
    core = make_core(tmp_path, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("s")
        await pilot.pause()
        await pilot.press("escape")
        await pilot.pause()

        assert not isinstance(app.screen, sr.SettingsModal)
        on_disk = ident.load_config(core.config_path)
        assert on_disk.target == "dev"


# -- NIT: one HistoryScreen Pilot test (row select -> log viewer opens) -----


@pytest.mark.asyncio
async def test_history_screen_row_select_opens_log_viewer(tmp_path):
    state_dir = tmp_path / "state"
    (state_dir / "logs").mkdir(parents=True)
    log_path = state_dir / "logs" / "20260101T000000Z-config-smoke.log"
    log_path.write_text("C1 PASS\n", encoding="utf-8")
    record = {
        "ts": "2026-01-01T00:00:00+00:00", "harness": "config-smoke", "mode": "default",
        "target": "dev", "levels": None, "exit_code": 0, "status": "PASS",
        "levels_detail": [], "log_path": str(log_path), "duration_s": 1.0,
    }
    (state_dir / "runs.jsonl").write_text(json.dumps(record) + "\n", encoding="utf-8")

    cfg = make_cfg()
    core = make_core(tmp_path, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("h")
        await pilot.pause()
        assert isinstance(app.screen, sr.HistoryScreen)

        table = app.screen.query_one("#history-table")
        table.focus()
        await pilot.pause()
        await pilot.press("enter")
        await pilot.pause()

        assert isinstance(app.screen, sr.LogViewerScreen)
        assert "C1 PASS" in "\n".join(app.screen._lines)


# =============================================================================
# Token-destructive queue planning — plan_queue + action_run_selected wiring
# =============================================================================


def _qr(harness: str, levels=None, mode: str = "default") -> "sr.QueuedRun":
    return sr.QueuedRun(harness=harness, mode=mode, target="dev", levels=levels)


def test_plan_queue_splits_multiuser_and_defers_m7_to_the_end():
    planned = sr.plan_queue([_qr("multiuser-smoke"), _qr("config-smoke")])
    assert [(r.harness, r.levels) for r in planned] == [
        ("multiuser-smoke", ("1", "2", "3", "4", "5", "6", "8")),
        ("config-smoke", None),
        ("multiuser-smoke", ("7",)),
    ]


def test_plan_queue_leaves_a_final_destructive_run_intact():
    # M7 is already last-in-batch AND last within the harness's own level
    # order — splitting it off would buy nothing but a second uv spawn.
    runs = [_qr("config-smoke"), _qr("multiuser-smoke")]
    assert sr.plan_queue(runs) == runs


def test_plan_queue_single_destructive_run_is_not_split():
    runs = [_qr("multiuser-smoke")]
    assert sr.plan_queue(runs) == runs


def test_plan_queue_destructive_only_selection_moves_whole_run_last():
    planned = sr.plan_queue([_qr("multiuser-smoke", levels=("7",)), _qr("config-smoke")])
    assert [(r.harness, r.levels) for r in planned] == [
        ("config-smoke", None),
        ("multiuser-smoke", ("7",)),
    ]


def test_plan_queue_non_destructive_selection_is_untouched():
    runs = [_qr("multiuser-smoke", levels=("1", "2")), _qr("config-smoke")]
    assert sr.plan_queue(runs) == runs


def test_plan_queue_final_run_still_split_when_destructive_not_at_its_tail():
    # A programmatic selection could order the destructive level first; the
    # last-in-batch exemption only holds when the destructive levels already
    # sit at the tail of the run's own level order.
    planned = sr.plan_queue([_qr("config-smoke"), _qr("multiuser-smoke", levels=("7", "1"))])
    assert [(r.harness, r.levels) for r in planned] == [
        ("config-smoke", None),
        ("multiuser-smoke", ("1",)),
        ("multiuser-smoke", ("7",)),
    ]


def test_plan_queue_empty_batch():
    assert sr.plan_queue([]) == []


@pytest.mark.asyncio
async def test_run_selected_defers_m7_behind_other_selected_harnesses(tmp_path):
    cfg = make_cfg()
    environ = make_environ(
        cfg,
        B_BEARER=token("qB"), B_REFRESH=token("rB"), B_EXPECTED_EMAIL=cfg.google["b"],
    )
    calls: list[tuple[str, ...]] = []

    def fake_execute(argv, env, cwd, line_sink):
        calls.append(tuple(argv))
        if "multiuser-smoke" in argv[2]:
            line_sink("  M1: PASS  (0.1s)  ")
            line_sink("TOTAL 1/1")
        else:
            line_sink("C1 PASS")
            line_sink("ALL PASS")
        return 0

    core = make_core(tmp_path, execute=fake_execute, environ=environ, cfg=cfg,
                      probe=make_probe({environ["A_BEARER"]: cfg.google["a"],
                                        environ["B_BEARER"]: cfg.google["b"]}))
    app = sr.SmokeRunnerApp(core, harness_names=["multiuser-smoke", "config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        sl = app.query_one("#harness-list", SelectionList)
        sl.focus()
        await pilot.press("space")        # select multiuser-smoke
        await pilot.press("down")
        await pilot.press("space")        # select config-smoke
        await pilot.press("r")
        await wait_until(lambda: len(calls) == 3 and not app._worker_active)
        await pilot.pause()

        assert [c[2] for c in calls] == [
            "bin/multiuser-smoke.py", "bin/config-smoke.py", "bin/multiuser-smoke.py",
        ]
        # multiuser-smoke's "default" mode is provider="google" and carries
        # provider_flag="--provider" (internal design notes
        # WP1) — compose_env appends [--provider, google] before --levels.
        assert calls[0][3:] == ("--provider", "google", "--levels", "1,2,3,4,5,6,8")
        assert calls[2][3:] == ("--provider", "google", "--levels", "7")
        # Three result rows — the split is visible, not silent.
        rows = list(app.query(".run-result"))
        assert len(rows) == 3
        # The deferred M7-only run (queue order: safe multiuser run,
        # config-smoke, destructive multiuser run) names the CONCRETE slot
        # it destroys — google:b for multiuser-smoke's "default" mode
        # (token_destructive_slots resolves the harness-level "B" prefix
        # through the mode actually selected).
        assert "google:b" in str(rows[2].content)


@pytest.mark.asyncio
async def test_queued_row_label_shows_explicit_levels(tmp_path):
    cfg = make_cfg()
    core = make_core(tmp_path, environ=make_environ(cfg), cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["multiuser-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        wid = await app._mount_queued_row(_qr("multiuser-smoke", levels=("7",)))
        row = app.query_one(f"#{wid}", Static)
        assert "levels:7" in str(row.content)


@pytest.mark.asyncio
async def test_queued_row_names_the_concrete_token_destructive_slot_per_mode(tmp_path):
    """WP1.5: the M7 re-mint advisory (Harness.advisories' generic "re-mint
    the slot named by token_destructive_slots" prose) is rendered as a
    CONCRETE slot per mode — google:b for multiuser-smoke's "default" mode,
    microsoft:b for its "microsoft" mode — computed via
    _smoke_registry.token_destructive_slots, not hardcoded."""
    cfg = make_cfg()
    core = make_core(tmp_path, environ=make_environ(cfg), cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["multiuser-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        wid_default = await app._mount_queued_row(_qr("multiuser-smoke", mode="default", levels=("7",)))
        row_default = app.query_one(f"#{wid_default}", Static)
        assert "google:b" in str(row_default.content)

        wid_ms = await app._mount_queued_row(_qr("multiuser-smoke", mode="microsoft", levels=("7",)))
        row_ms = app.query_one(f"#{wid_ms}", Static)
        assert "microsoft:b" in str(row_ms.content)

        # A run carrying only SAFE levels gets no such annotation.
        wid_safe = await app._mount_queued_row(_qr("multiuser-smoke", mode="default", levels=("1",)))
        row_safe = app.query_one(f"#{wid_safe}", Static)
        assert "google:b" not in str(row_safe.content)


@pytest.mark.asyncio
async def test_handle_completed_carries_the_token_destructive_note_completed_and_omits_it_when_safe(tmp_path):
    """SHOULD-FIX (review round 2): the completed-row M7 note (the row
    rewrite inside _handle_completed) is exercised directly here, the same
    style as the ALL_SKIPPED/SUSPECT presentation test above — not just
    indirectly via a full action_run_selected pilot flow."""
    cfg = make_cfg()
    core = make_core(tmp_path, environ=make_environ(cfg), cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["multiuser-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()

        destructive_run = _qr("multiuser-smoke", mode="default", levels=("7",))
        wid = await app._mount_queued_row(destructive_run)
        app._handle_completed(sr.CompletedRun(
            queued=destructive_run,
            outcome=reg.RunOutcome("PASS", (), "1/1"),
            blocked_reason=None, advisory=False, exit_code=0, log_path=None, duration_s=1.0, started_at=START,
        ))
        row = app.query_one(f"#{wid}", Static)
        assert "google:b" in str(row.content)

        safe_run = _qr("multiuser-smoke", mode="default", levels=("1",))
        wid_safe = await app._mount_queued_row(safe_run)
        app._handle_completed(sr.CompletedRun(
            queued=safe_run,
            outcome=reg.RunOutcome("PASS", (), "1/1"),
            blocked_reason=None, advisory=False, exit_code=0, log_path=None, duration_s=1.0, started_at=START,
        ))
        row_safe = app.query_one(f"#{wid_safe}", Static)
        assert "google:b" not in str(row_safe.content)


@pytest.mark.asyncio
async def test_mark_row_running_carries_the_token_destructive_note(tmp_path):
    """NIT (review round 2): _mark_row_running's "⏳ running…" rewrite used
    to drop the M7 re-mint note — a Ctrl-C or a crash mid-run would then
    lose the "which slot am I about to destroy" reminder the queued row
    had. The note must survive the queued -> running rewrite too."""
    cfg = make_cfg()
    core = make_core(tmp_path, environ=make_environ(cfg), cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["multiuser-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        run = _qr("multiuser-smoke", mode="default", levels=("7",))
        wid = await app._mount_queued_row(run)
        app._mark_row_running(None)
        row = app.query_one(f"#{wid}", Static)
        assert "⏳" in str(row.content)
        assert "google:b" in str(row.content)


# =============================================================================
# Header layout (M8): the header bar must be one row, and both badges must
# actually be on screen.
# =============================================================================


@pytest.mark.asyncio
async def test_header_bar_is_one_row_and_badges_are_on_screen(tmp_path):
    """Textual's `Horizontal` container defaults to `height: 1fr`, so an
    un-styled header bar splits the terminal 50/50 with #main — half the
    screen was a blank panel with a one-line title in its top row. And an
    un-sized `Static` inside it takes the full row width, so the target and
    op-secrets badges were laid out at x=131 and x=261 on a 132-col terminal:
    the "unmissable" target badge M7 added was never visible. Pin both, at
    the same 132x36 geometry the bug was observed at."""
    cfg = make_cfg(target=MICROSOFT_TARGET)
    core = make_core(tmp_path, environ=make_environ(cfg), cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test(size=(132, 36)) as pilot:
        await pilot.pause()
        header = app.query_one("#header-bar")
        assert header.region.height == 1, f"header bar is {header.region.height} rows tall"
        screen_width = app.size.width
        for wid in ("#header-title", "#target-badge", "#provider-badge", "#op-secrets-badge"):
            w = app.query_one(wid)
            r = w.region
            assert r.y == 0, f"{wid} not on the header row: {r}"
            assert r.width >= 1 and r.x + r.width <= screen_width, f"{wid} off-screen: {r}"
        badge = app.query_one("#target-badge")
        title = app.query_one("#header-title")
        assert badge.region.x >= title.region.x + len("optical smoke"), (
            f"badge overlaps title: title={title.region} badge={badge.region}"
        )
        main = app.query_one("#main")
        assert main.region.height >= 30, f"#main only got {main.region.height} rows"


# =============================================================================
# Campaign provider axis (2026-09-17): [defaults].provider picks each
# harness's default mode, toggled with P, shown as a header badge.
# =============================================================================


def _ms_campaign_cfg(**overrides):
    base = dict(
        target=MICROSOFT_TARGET,
        provider="microsoft",
        microsoft={"a": "ms.a@example.com", "b": "ms.b@example.com", "c": "ms.c@example.com"},
        microsoft_attendee="ms2@other.example",
    )
    base.update(overrides)
    return make_cfg(**base)


def test_default_mode_for_prefers_the_campaign_provider_then_agnostic_then_first():
    reg = sr._smoke_registry
    # A harness with both providers: the provider's own mode wins.
    assert sr._default_mode_for(reg.HARNESSES["regression-smoke"], "microsoft").name == "microsoft"
    assert sr._default_mode_for(reg.HARNESSES["regression-smoke"], "google").name == "google"
    assert sr._default_mode_for(reg.HARNESSES["meeting-smoke"], "microsoft").name == "microsoft-2-account"
    assert sr._default_mode_for(reg.HARNESSES["poll-smoke"], "microsoft").name == "microsoft"
    # Only a microsoft mode (ms-smoke): a google campaign still falls back
    # to the first mode rather than to nothing.
    assert sr._default_mode_for(reg.HARNESSES["ms-smoke"], "google").name == "default"
    # A provider-agnostic (provider=None) mode matches either campaign when
    # nothing names the provider exactly.
    agnostic = reg.Harness(name="x", script="x", modes=(
        reg.Mode(name="google-only", provider="google"),
        reg.Mode(name="any", provider=None),
    ))
    assert sr._default_mode_for(agnostic, "microsoft").name == "any"
    assert sr._default_mode_for(agnostic, "google").name == "google-only"


@pytest.mark.asyncio
async def test_microsoft_campaign_defaults_every_harness_with_a_microsoft_mode_to_it(tmp_path):
    """The bug (2026-09-17 screenshot): at the Microsoft target the runner
    defaulted every harness to modes[0] — the Google mode — so regression/
    reset showed BLOCKED (their google modes are dev-only) and multiuser/
    meeting/poll silently ran their GOOGLE modes there. Only ms-smoke looked
    like a Microsoft run. With provider=microsoft the matching mode must be
    the default, and runnable."""
    cfg = _ms_campaign_cfg()
    environ, by_bearer = make_environ_both_casts(cfg)
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe(by_bearer))
    app = sr.SmokeRunnerApp(core)
    async with app.run_test(size=(200, 50)) as pilot:
        await pilot.pause()
        labels = {name: str(lbl) for lbl, name in app._harness_options()}
        expected_mode = {
            "regression-smoke": "microsoft",
            "reset-smoke-env": "microsoft",
            "multiuser-smoke": "microsoft",
            "meeting-smoke": "microsoft-2-account",
            "poll-smoke": "microsoft",
            "ms-smoke": "default",
        }
        for name, mode in expected_mode.items():
            assert labels[name].startswith(f"{name}  ({mode})"), labels[name]
        for name in ("regression-smoke", "reset-smoke-env", "multiuser-smoke", "meeting-smoke", "ms-smoke"):
            assert "BLOCKED" not in labels[name], labels[name]
        # poll-smoke carries a weekday gate (run_days) — only its mode is
        # asserted so this test doesn't depend on the calendar.


@pytest.mark.asyncio
async def test_P_toggles_provider_refreshes_badge_and_drops_mismatched_selections(tmp_path):
    cfg = _ms_campaign_cfg(provider="google")
    environ, by_bearer = make_environ_both_casts(cfg)
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe(by_bearer))
    app = sr.SmokeRunnerApp(core, harness_names=["regression-smoke", "meeting-smoke", "ms-smoke"])
    async with app.run_test(size=(200, 50)) as pilot:
        await pilot.pause()
        badge = app.query_one("#provider-badge")
        assert "provider-google" in badge.classes and "google" in str(badge.content)
        assert dict((n, str(l)) for l, n in app._harness_options())["regression-smoke"].startswith(
            "regression-smoke  (google)")
        # An explicit drawer choice of a google mode, plus one that already
        # matches microsoft.
        app._harness_selection["meeting-smoke"] = sr.HarnessSelection(mode="3-account", levels=("M1",))
        app._harness_selection["ms-smoke"] = sr.HarnessSelection(mode="default", levels=("1", "2"))

        await pilot.press("P")
        await pilot.pause()

        assert app.core.cfg.provider == "microsoft"
        assert "provider-microsoft" in badge.classes and "provider-google" not in badge.classes
        assert "microsoft" in str(badge.content)
        labels = dict((n, str(l)) for l, n in app._harness_options())
        assert labels["regression-smoke"].startswith("regression-smoke  (microsoft)")
        # the google-mode selection was dropped (a whole-campaign switch
        # must not keep a stale mode pinned), the matching one survived
        assert "meeting-smoke" not in app._harness_selection
        assert labels["meeting-smoke"].startswith("meeting-smoke  (microsoft-2-account)")
        assert app._harness_selection["ms-smoke"].levels == ("1", "2")

        await pilot.press("P")
        await pilot.pause()
        assert app.core.cfg.provider == "google"
        assert "provider-google" in badge.classes


@pytest.mark.asyncio
async def test_settings_modal_provider_field_round_trips_and_rejects_junk(tmp_path):
    cfg = make_cfg(target=MICROSOFT_TARGET)
    core = make_core(tmp_path, environ=make_environ(cfg), cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    notified: list[tuple[tuple, dict]] = []
    app.notify = lambda *a, **k: notified.append((a, k))
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("s")
        await pilot.pause()
        assert isinstance(app.screen, sr.SettingsModal)
        field = app.screen.query_one("#settings-provider", Input)
        assert field.value == "google"

        field.value = "outlook"
        await pilot.press("enter")
        await pilot.pause()
        assert isinstance(app.screen, sr.SettingsModal)
        assert any("google" in str(call[0]) and "microsoft" in str(call[0]) for call in notified)

        field.value = "microsoft"
        await pilot.press("enter")
        await pilot.pause()
        assert not isinstance(app.screen, sr.SettingsModal)
        assert ident.load_config(core.config_path).provider == "microsoft"
        assert core.cfg.provider == "microsoft"
        assert "provider-microsoft" in app.query_one("#provider-badge").classes


@pytest.mark.asyncio
async def test_identity_pane_title_shows_the_probe_and_rescan_keys_literally(tmp_path):
    """"IDENTITIES  [p]robe [e]scan" rendered as "IDENTITIES  robe scan"
    (2026-09-17 screenshot): Label parses console markup by default, and
    [p]/[e] are eaten as style tags. The key hints must survive."""
    cfg = make_cfg()
    core = make_core(tmp_path, environ=make_environ(cfg), cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        title = app.query_one("#identities-title")
        assert "[p]robe [e]scan" in title.visual.plain


@pytest.mark.asyncio
async def test_op_secrets_badge_names_the_current_targets_turnstile_secret(tmp_path, staging_target):
    """booking-smoke restores TURNSTILE_SECRET_<ENV> (2026-09-17), so the
    op-secrets indicator must ask for the CURRENT target's secret — on
    another target a shell with only TURNSTILE_SECRET_DEV is not
    "everything available"."""
    cfg = make_cfg(target="dev")
    environ = make_environ(cfg)  # TURNSTILE_SECRET_DEV + CLOUDFLARE_API_TOKEN
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    next_target = list(reg.TARGETS)[1]  # `t` cycles TARGETS in order
    next_var = f"TURNSTILE_SECRET_{reg.TARGETS[next_target].wrangler_env.upper()}"
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app._op_secrets_missing() == []
        await pilot.press("t")
        await pilot.pause()
        assert app.core.cfg.target == next_target
        assert app._op_secrets_missing() == [next_var]
        badge = app.query_one("#op-secrets-badge")
        assert "op-secrets-missing" in badge.classes and "✗" in str(badge.content)
        core.environ[next_var] = "op-injected-next-secret"
        await pilot.press("e")  # rescan re-reads the runner's env
        await pilot.pause()
        assert app._op_secrets_missing() == []
        assert "op-secrets-ok" in app.query_one("#op-secrets-badge").classes
        for _ in range(len(reg.TARGETS)):  # cycle back round to dev
            if app.core.cfg.target == "dev":
                break
            await pilot.press("t")
            await pilot.pause()
        assert app.core.cfg.target == "dev"
        assert app._op_secrets_missing() == []


@pytest.mark.asyncio
async def test_settings_modal_apply_refreshes_the_op_secrets_badge(tmp_path, staging_target):
    """2026-09-17 review fix: _refresh_op_secrets_badge was wired into
    action_change_target and action_rescan_env but not into the
    settings-apply callback (action_show_settings's _on_result) — applying a
    target change through the settings modal left the badge showing the OLD
    target's secret status until the next 't'/'e'."""
    cfg = make_cfg(target="dev")
    environ = make_environ(cfg)  # TURNSTILE_SECRET_DEV present, TURNSTILE_SECRET_STAGING absent
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        assert app._op_secrets_missing() == []
        assert "op-secrets-ok" in app.query_one("#op-secrets-badge").classes

        await pilot.press("s")
        await pilot.pause()
        assert isinstance(app.screen, sr.SettingsModal)
        target_input = app.screen.query_one("#settings-target", Input)
        target_input.value = staging_target
        await pilot.press("enter")
        await pilot.pause()

        assert core.cfg.target == staging_target
        assert app._op_secrets_missing() == ["TURNSTILE_SECRET_STAGING"]
        badge = app.query_one("#op-secrets-badge")
        assert "op-secrets-missing" in badge.classes
        assert "✗" in str(badge.content)


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))


# =============================================================================
# 2026-09-02: poll-smoke is captured like every other harness; the child's
# stdin is detached so a harness that would prompt (poll-smoke's mailbox-miss
# fallback) sees "not a TTY" and exits with its own message instead of
# reading keystrokes the TUI is also reading.
# =============================================================================

def test_default_execute_detaches_the_child_stdin(tmp_path):
    import os
    lines = []
    script = "import sys; print(sys.stdin.isatty()); print(repr(sys.stdin.read()))"
    # Make fd 0 a pipe with content for the duration: an inherited stdin
    # would read the sentinel back; a detached one reads nothing.
    r, w = os.pipe()
    os.write(w, b"SHOULD_NOT_BE_READ"); os.close(w)
    saved = os.dup(0)
    try:
        os.dup2(r, 0); os.close(r)
        rc = sr.default_execute([sys.executable, "-c", script], {"PATH": os.environ.get("PATH", "")},
                                str(tmp_path), lines.append)
    finally:
        os.dup2(saved, 0); os.close(saved)
    assert rc == 0
    assert lines == ["False", "''"]


def test_run_next_poll_smoke_is_captured_like_every_other_harness(tmp_path):
    cfg = make_cfg(poll_invitee_a_set="binv@example.com", poll_invitee_b_set="cinv@example.com")
    environ = make_environ(cfg)
    calls = []

    def fake_execute(argv, env, cwd, line_sink):
        calls.append(argv)
        assert argv[:3] == ("uv", "run", "bin/poll-smoke.py")
        line_sink("T1 PASS — poll created")
        line_sink("T2 PASS — booked")
        line_sink("ALL PASS")
        return 0

    core = make_core(tmp_path, execute=fake_execute, interactive_execute=fail_interactive_execute,
                      environ=environ, cfg=cfg, probe=make_probe({environ["A_BEARER"]: cfg.google["a"]}))
    core.enqueue(sr.QueuedRun(harness="poll-smoke", mode="default", target="dev"))
    completed = core.run_next()

    assert len(calls) == 1
    assert completed.log_path is not None and completed.log_path.exists()
    assert completed.outcome.status == "PASS"
    assert [lv.label for lv in completed.outcome.levels] == ["T1", "T2"]
    rec = json.loads((tmp_path / "state" / "runs.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert rec["log_path"] == str(completed.log_path)


# =============================================================================
# Identity probe URL follows the target for Google slots (a token is minted
# against one host; with meeting/poll/multiuser runnable on several targets,
# the pane must check the A/B/C tokens against the host they'll actually be
# used on). A microsoft:<letter> slot is always probed against the target
# hosting provider "microsoft" (derived from Target.providers, not hardcoded).
# =============================================================================

def test_probe_url_follows_target_for_google_slots_and_pins_the_microsoft_host(tmp_path, staging_target):
    cfg = make_cfg(target=staging_target)
    environ = make_environ(cfg, include_scheduler=True)
    probe = make_probe({environ["A_BEARER"]: cfg.google["a"],
                        environ["SCHEDULER_BEARER"]: cfg.microsoft["a"]})
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=probe)
    core.probe_all()
    by_bearer = {bearer: url for url, bearer in probe.calls}
    assert by_bearer[environ["A_BEARER"]] == reg.TARGETS[staging_target].scheduler_url
    assert by_bearer[environ["SCHEDULER_BEARER"]] == reg.TARGETS[MICROSOFT_TARGET].scheduler_url


def test_probe_url_is_dev_for_google_slots_on_the_dev_target(tmp_path):
    cfg = make_cfg(target="dev")
    environ = make_environ(cfg, include_scheduler=False)
    probe = make_probe({environ["A_BEARER"]: cfg.google["a"]})
    core = make_core(tmp_path, environ=environ, cfg=cfg, probe=probe)
    core.probe_all()
    assert probe.calls == [(reg.TARGETS["dev"].scheduler_url, environ["A_BEARER"])]


# =============================================================================
# WP1.5 review round 2: pure-function NITs (widget-id collision, the
# dotted-slot target guard, and sort order).
# =============================================================================


def test_slot_widget_id_no_collision_between_dotted_and_colon_forms():
    """NIT: "microsoft.attendee" and a hypothetical "microsoft:attendee"
    used to collide on the same widget id (both '.' and ':' mapped to '-').
    Distinct replacement characters keep them apart."""
    assert sr._slot_widget_id("microsoft.attendee") != sr._slot_widget_id("microsoft:attendee")


def test_target_name_for_slot_explicit_guard_for_a_non_identity_slot():
    """NIT: "microsoft.attendee" is not a provider:letter identity slot (it
    never logs in, is never probed) — the guard for it must be an explicit
    early return, not an accidental fallback via slot_provider() reading the
    whole dotted string as a bogus "provider"."""
    assert sr._target_name_for_slot("microsoft.attendee", "staging") == "dev"
    assert sr._target_name_for_slot("microsoft.attendee", "dev") == "dev"


def test_all_config_slots_sorts_letters_before_the_attendee_row():
    """NIT: a plain string sort put "microsoft.attendee" ('.' < ':')
    ahead of every microsoft:<letter> row, and even ahead of google:*
    rows that sort after "microsoft" — the docs sketch (and plain
    legibility) wants every real identity slot first, the informational
    attendee row last."""
    cfg = make_cfg(
        google={"a": "a@example.com"},
        microsoft={"a": "msa@example.com", "b": "msb@example.com"},
        microsoft_attendee="attendee@example.com",
    )
    slots = sr._all_config_slots(cfg)
    assert slots[-1] == "microsoft.attendee"
    assert slots.index("google:a") < slots.index("microsoft.attendee")
    assert slots.index("microsoft:a") < slots.index("microsoft.attendee")
    assert slots.index("microsoft:b") < slots.index("microsoft.attendee")


@pytest.mark.asyncio
async def test_reset_env_modal_google_mode_targets_dev(tmp_path):
    """NIT: ResetEnvModal.action_apply now derives the target from the
    resolved mode's own Mode.targets[0] instead of a hardcoded per-provider
    target literal — exercise the default (google) radio,
    which the microsoft-radio pilot test above doesn't touch, and check the
    SCHEDULER_URL the composed env actually carries."""
    cfg = make_cfg()
    environ = make_environ(cfg)
    calls = []

    def fake_execute(argv, env, cwd, line_sink):
        calls.append((argv, env))
        return 0

    core = make_core(tmp_path, execute=fake_execute, environ=environ, cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, harness_names=["config-smoke"])
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("R")
        await pilot.pause()
        assert isinstance(app.screen, sr.ResetEnvModal)
        # Default RadioButton selection is "google" — press enter without
        # touching the radio set.
        await pilot.press("enter")
        await wait_until(lambda: not app._worker_active)
        await pilot.pause()

        assert len(calls) == 1
        argv, env = calls[0]
        assert "--provider" in argv and argv[argv.index("--provider") + 1] == "google"
        assert env["SCHEDULER_URL"] == reg.TARGETS["dev"].scheduler_url


# =============================================================================
# Copying out of the TUI: Textual owns the mouse, so the log viewer offers
# "o" to hand the log to $PAGER on the real terminal (App.suspend), where
# native selection works.
# =============================================================================

@pytest.mark.asyncio
async def test_log_viewer_o_opens_the_log_in_the_pager_under_suspend(tmp_path, monkeypatch):
    monkeypatch.setenv("PAGER", "my-pager --flag")
    log = tmp_path / "x.log"
    log.write_text("L1 PASS — hi\n", encoding="utf-8")
    events = []

    @contextlib.contextmanager
    def fake_suspend():
        events.append("suspend-enter")
        yield
        events.append("suspend-exit")

    def fake_pager(argv):
        events.append(("pager", tuple(argv)))
        return 0

    cfg = make_cfg()
    core = make_core(tmp_path, environ=make_environ(cfg), cfg=cfg, probe=make_probe({}))
    app = sr.SmokeRunnerApp(core, suspend_factory=fake_suspend, pager_execute=fake_pager)
    async with app.run_test() as pilot:
        await pilot.pause()
        app.push_screen(sr.LogViewerScreen(log, "log: x"))
        await pilot.pause()
        await pilot.press("o")
        await pilot.pause()
    assert events == ["suspend-enter", ("pager", ("my-pager", "--flag", str(log))), "suspend-exit"]
