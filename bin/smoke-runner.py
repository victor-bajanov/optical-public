#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["textual>=0.80", "httpx>=0.27"]
# ///
"""Unified smoke runner — a Textual TUI over bin/_smoke_registry.py (WP1) and
bin/_smoke_identity.py (WP2). See internal design notes (design) and
internal design notes (WP4 section, the mechanical
contract this file implements).

Two layers, deliberately separated so the orchestration is testable without a
real terminal or a real subprocess (bin/test_smoke_runner_tui.py):

  RunnerCore    UI-free: queue, env composition (via _smoke_registry), spawn
                (via an injectable `execute`/`interactive_execute`), log tee +
                scrub, runs.jsonl, pruning, post-run identity re-probe.
                Every I/O boundary (execute, clock, state_dir, environ, probe)
                is a constructor parameter — default_execute/probe_whoami are
                just the production defaults.

  SmokeRunnerApp  Textual App: renders RunnerCore's state, drives the queue
                  from a background thread (`run_worker(thread=True)`), and
                  is the only place App.suspend() is ever called (an
                  interactive harness hands the real TTY to the child — see
                  _run_interactive_locked; no registered harness is
                  interactive today — and the log viewer's $PAGER hand-off,
                  open_log_in_pager).

The runner never imports harness code — harnesses are spawned as
subprocesses, exactly as the shell does today (_smoke_registry.compose_env
builds their argv/env; nothing here parses or interprets what a harness
does).
"""
from __future__ import annotations

import dataclasses
import importlib.util
import json
import os
import re
import subprocess
import sys
from collections import deque
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Mapping, Sequence

_BIN_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _BIN_DIR.parent


def _load_sibling(name: str):
    """Load bin/<name>.py by path, under sys.modules[name] — the same
    pattern _smoke_registry.py itself uses for _smoke_lib, and every
    bin/test_*.py uses for its subject module. Robust regardless of how
    THIS file is loaded (as __main__, or sibling-loaded by a test via
    spec_from_file_location, which does not put bin/ on sys.path)."""
    spec = importlib.util.spec_from_file_location(name, _BIN_DIR / f"{name}.py")
    assert spec and spec.loader, f"could not load {name} module"
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


_smoke_registry = _load_sibling("_smoke_registry")
_smoke_identity = _load_sibling("_smoke_identity")


# =============================================================================
# RunnerCore — UI-free orchestration
# =============================================================================

DEFAULT_LOG_PRUNE_N = 200


@dataclass(frozen=True)
class QueuedRun:
    harness: str
    mode: str
    target: str
    levels: tuple[str, ...] | None = None
    override_run_day: bool = False
    # WP4-level flag-picker args (reset-smoke-env's --clear-all/--l6-current-
    # week/--dry-run) that aren't part of the registry Mode.args — see the
    # implementation plan's WP1 notes on why they live here, not in the
    # registry. Appended verbatim after compose_env's own argv.
    extra_args: tuple[str, ...] = ()


@dataclass(frozen=True)
class CompletedRun:
    queued: QueuedRun
    outcome: "_smoke_registry.RunOutcome | None"  # None iff blocked_reason is set
    blocked_reason: str | None
    # Mirrors _smoke_registry.Blocked.advisory (typed, not a substring match
    # on blocked_reason): True only for the overridable run-day gate; False
    # for every other Blocked reason, and for a non-blocked run.
    advisory: bool
    exit_code: int | None
    log_path: Path | None
    duration_s: float
    started_at: datetime


def plan_queue(runs: Sequence[QueuedRun]) -> list[QueuedRun]:
    """Order a prospective batch of runs so that token-destructive levels
    (Harness.token_destructive_levels — multiuser-smoke's M7 offboard, which
    revokes B's OAuth tokens) execute AFTER every other run in the batch: a
    run carrying such a level is split into a safe part (kept in place) and
    a destructive part (deferred to the end of the batch), each an explicit
    --levels subset. One exemption avoids a pointless split: when exactly
    one run carries destructive levels, it is the last run of the batch, and
    those levels already sit at the tail of its own level order (true for
    the registry default and for any drawer selection, which preserves
    universe order), the run is left intact — nothing would execute after
    the destruction anyway, and a second uv spawn buys nothing.

    Applied to the batch action_run_selected enqueues; a run appended later
    (another 'r' press mid-drain, the reset modal, the day-gate override)
    joins the tail of the live queue as always and is NOT re-planned against
    runs already queued — the queue-reorder keys can still move it."""
    safe_out: list[QueuedRun] = []
    # (origin index, effective levels, safe half, destructive half)
    deferred: list[tuple[int, tuple[str, ...], tuple[str, ...], tuple[str, ...]]] = []
    for i, run in enumerate(runs):
        harness = _smoke_registry.HARNESSES[run.harness]
        mode_obj = _smoke_registry._find_mode(harness, run.mode)
        effective = (tuple(run.levels) if run.levels is not None
                     else _smoke_registry._default_levels(harness, mode_obj))
        safe, destructive = _smoke_registry.split_token_destructive(harness, run.mode, run.levels)
        if not destructive:
            safe_out.append(run)
            continue
        if safe:
            safe_out.append(dataclasses.replace(run, levels=safe))
        deferred.append((i, effective, safe, destructive))
    if not deferred:
        return safe_out
    if len(deferred) == 1:
        origin_idx, effective, safe, destructive = deferred[0]
        if origin_idx == len(runs) - 1 and effective == safe + destructive:
            return list(runs)
    return safe_out + [
        dataclasses.replace(runs[i], levels=destructive)
        for i, _effective, _safe, destructive in deferred
    ]


def default_execute(argv: Sequence[str], env: Mapping[str, str], cwd: str,
                     line_sink: Callable[[str], None]) -> int:
    """subprocess.Popen, stderr merged into stdout, line-buffered tee — every
    line reaches `line_sink` as soon as the child writes it (design doc:
    "stdout+stderr stream to the per-run log file (unbuffered tee)")."""
    # stdin detached: the TUI owns the terminal, so a child that would
    # prompt (poll-smoke's mailbox-miss fallback) must see "not a TTY" and
    # exit with its own message rather than block on keystrokes the TUI is
    # also reading.
    proc = subprocess.Popen(
        list(argv), cwd=cwd, env=dict(env),
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, bufsize=1, errors="replace",
    )
    assert proc.stdout is not None
    for raw_line in proc.stdout:
        line_sink(raw_line.rstrip("\n"))
    return proc.wait()


def default_interactive_execute(argv: Sequence[str], env: Mapping[str, str], cwd: str) -> int:
    """No pipes at all — the child inherits the real stdio. Only correct to
    call while the terminal has been handed over via App.suspend() (see
    SmokeRunnerApp._run_interactive_locked); RunnerCore itself never calls
    suspend — it just doesn't capture output for an interactive harness."""
    proc = subprocess.Popen(list(argv), cwd=cwd, env=dict(env))
    return proc.wait()


def pager_argv(pager: str | None, log_path: Path) -> list[str]:
    """$PAGER split shell-style (it may carry flags, e.g. "less -R"), the
    log path appended. Default `less -R` keeps the harness's ANSI colour."""
    import shlex
    base = shlex.split(pager) if pager and pager.strip() else ["less", "-R"]
    return [*base, str(log_path)]


def default_pager_execute(argv: Sequence[str]) -> int:
    """Real stdio inherited — only correct inside App.suspend()."""
    return subprocess.call(list(argv))


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


class RunnerCore:
    """UI-free orchestration: queue, executor, log tee, runs.jsonl, pruning,
    identity seeding/re-probe. Every I/O seam is injectable so tests never
    touch a real subprocess, the real filesystem outside tmp_path, or the
    network."""

    def __init__(
        self,
        *,
        execute: Callable[[Sequence[str], Mapping[str, str], str, Callable[[str], None]], int] = default_execute,
        interactive_execute: Callable[[Sequence[str], Mapping[str, str], str], int] = default_interactive_execute,
        state_dir: Path | None = None,
        clock: Callable[[], datetime] = _utc_now,
        environ: Mapping[str, str] | None = None,
        cfg: "_smoke_identity.RunnerConfig | None" = None,
        config_path: Path | None = None,
        probe: Callable[[str, str], "_smoke_identity.ProbeResult"] | None = _smoke_identity.probe_whoami,
        log_prune_n: int = DEFAULT_LOG_PRUNE_N,
        repo_root: Path | None = None,
    ) -> None:
        self.execute = execute
        self.interactive_execute = interactive_execute
        self.state_dir = Path(state_dir) if state_dir is not None else _smoke_identity.state_dir()
        self.clock = clock
        self.environ: dict[str, str] = dict(environ) if environ is not None else dict(os.environ)
        # config_path anchors where rescan() (below) re-reads from — kept
        # distinct from the `cfg` this constructor was handed, so passing an
        # explicit `cfg` still boots with exactly that snapshot (existing
        # callers/tests are unaffected); only an explicit rescan() call
        # reloads from disk.
        self.config_path = config_path if config_path is not None else _smoke_identity.CONFIG_PATH
        self.cfg = cfg if cfg is not None else _smoke_identity.load_config(self.config_path)
        self.probe = probe
        self.log_prune_n = log_prune_n
        self.repo_root = Path(repo_root) if repo_root is not None else _REPO_ROOT

        self.queue: list[QueuedRun] = []
        self.identities: dict[str, _smoke_identity.IdentityTokens] = {}
        self.identity_statuses: dict[str, _smoke_identity.IdentityStatus] = {}
        self.seed_warnings: tuple[str, ...] = ()
        # slot -> "missing X, Y" for a half-exported letter (SeedReport.partial)
        # — computed by seed_identities and, before this round, dropped on
        # the floor; the identity pane now shows these too (a typo'd export
        # must never be invisible).
        self.seed_partial: dict[str, str] = {}
        self._reseed()

    # -- identities -----------------------------------------------------

    def _reseed(self) -> "_smoke_identity.SeedReport":
        report = _smoke_identity.seed_identities(self.environ, self.cfg)
        self.identities = report.identities
        self.seed_warnings = report.warnings
        self.seed_partial = dict(report.partial)
        return report

    def rescan(self) -> "_smoke_identity.SeedReport":
        """Re-read self.environ (NOT necessarily the real process env — see
        the `environ` ctor param — this can never see exports a shell made
        in its OWN environment after this process started; the UI is what
        says so, not this method) AND config.toml, via self.config_path —
        an on-disk edit (hand-editing, or the settings modal's apply) must
        take effect on rescan, not sit ignored behind the boot-time cfg
        snapshot."""
        self.cfg = _smoke_identity.load_config(self.config_path)
        return self._reseed()

    def _probe_url_for_slot(self, slot: str) -> str:
        """A bearer is minted against one host, so probe each slot where it
        will actually be used: a microsoft:<letter> slot always against the
        target hosting provider "microsoft" (see _target_name_for_slot,
        which derives this from Target.providers rather than a hardcoded
        literal); Google letters against the CURRENT target —
        meeting/poll/multiuser run on several targets, with A/B/C tokens
        minted against the current host (`mu-smoke-login.py <L> --url
        <host>`)."""
        return _target_url_for_slot(self.cfg, slot)

    def probe_all(self) -> dict[str, "_smoke_identity.IdentityStatus"]:
        """GET /v1/whoami for every currently-seeded identity. Side-effect-
        free per _smoke_identity.probe_whoami; a probe exception (a fake in
        tests raising, or a genuinely broken injected probe) degrades to
        PROBE_ERROR rather than propagating — a probe hiccup must never take
        the whole pane down."""
        now = self.clock()
        statuses: dict[str, _smoke_identity.IdentityStatus] = {}
        for slot, tokens in self.identities.items():
            result = None
            if self.probe is not None:
                try:
                    result = self.probe(self._probe_url_for_slot(slot), tokens.bearer)
                except Exception:
                    result = _smoke_identity.ProbeResult(status=None, body={})
            statuses[slot] = _smoke_identity.classify(tokens, result, now)
        self.identity_statuses = statuses
        return statuses

    # -- queue ------------------------------------------------------------

    def enqueue(self, run: QueuedRun) -> None:
        self.queue.append(run)

    def reorder(self, new_order: Sequence[int]) -> None:
        """Reorder the still-pending queue by index permutation — the design
        doc requires the queue be "visible and reorderable before start"."""
        self.queue = [self.queue[i] for i in new_order]

    # -- log naming / pruning / runs.jsonl ---------------------------------

    def _log_path_for(self, run: QueuedRun, started: datetime) -> Path:
        ts = started.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        suffix = f"-{run.mode}" if run.mode != "default" else ""
        base = self.state_dir / "logs" / f"{ts}-{run.harness}{suffix}"
        candidate = base.with_suffix(".log")
        n = 2
        # N1: two runs completing within the same wall-clock second (a fast
        # harness, or several Blocked-then-real runs in quick succession)
        # would otherwise collide on this 1-second-resolution filename and
        # the second run's open("w", ...) would silently truncate the
        # first's log — dedupe with a numeric suffix instead.
        while candidate.exists():
            candidate = base.parent / f"{base.name}-{n}.log"
            n += 1
        return candidate

    def _prune_logs(self) -> None:
        logs_dir = self.state_dir / "logs"
        if not logs_dir.is_dir():
            return
        # Filename timestamps are yyyymmddThhmmssZ prefixes -> lexicographic
        # sort is chronological sort.
        files = sorted(logs_dir.glob("*.log"))
        excess = len(files) - self.log_prune_n
        for f in files[:max(excess, 0)]:
            f.unlink(missing_ok=True)

    def _append_run_record(self, run: QueuedRun, exit_code: int | None,
                            outcome: "_smoke_registry.RunOutcome",
                            log_path: Path | None, duration: float, started: datetime) -> None:
        runs_path = self.state_dir / "runs.jsonl"
        runs_path.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "ts": started.astimezone(timezone.utc).isoformat(),
            "harness": run.harness,
            "mode": run.mode,
            "target": run.target,
            "levels": list(run.levels) if run.levels is not None else None,
            "exit_code": exit_code,
            "status": outcome.status,
            "levels_detail": [
                {"label": lv.label, "status": lv.status, "notes": lv.notes} for lv in outcome.levels
            ],
            "log_path": str(log_path) if log_path is not None else None,
            "duration_s": duration,
        }
        with runs_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")

    # -- run ----------------------------------------------------------------

    def compose_for(
        self, run: QueuedRun,
    ) -> "tuple[_smoke_registry.ComposedRun, None] | tuple[None, _smoke_registry.Blocked]":
        """Compose env for `run` (or determine why it's Blocked) WITHOUT
        popping it off the queue — a pure peek. run_next() accepts the
        result back via `precomposed` so a caller that needs to know the
        verdict ahead of time (SmokeRunnerApp: is this interactive run
        actually going to spawn, before deciding whether to hand over the
        TTY) and the actual spawn share the exact same compose_env call
        rather than two — closing the window for a concurrent rescan() to
        produce a different verdict between the pre-check and the spawn."""
        harness = _smoke_registry.HARNESSES[run.harness]
        try:
            composed = _smoke_registry.compose_env(
                harness, run.mode, run.target, self.environ, self.identities, self.cfg,
                levels=run.levels, override_run_day=run.override_run_day,
                extra_args=run.extra_args,
            )
            return composed, None
        except _smoke_registry.Blocked as e:
            return None, e

    def run_next(
        self,
        *,
        on_start: Callable[[QueuedRun, Path | None], None] | None = None,
        precomposed: "tuple | None" = None,
    ) -> CompletedRun:
        """Compose env, spawn (or, for a Blocked run, don't), tee+scrub to
        the log file, parse, record, re-probe. Synchronous and blocking by
        design — the caller (SmokeRunnerApp's worker thread) is what makes
        the overall queue sequential by calling this in a loop.

        `on_start(run, log_path)` fires exactly once, right after the
        Blocked-check passes and the log path (None for an interactive
        harness) is known — but strictly BEFORE the child is actually
        spawned, so a caller can flip a "running" UI state at the right
        moment (SmokeRunnerApp._mark_row_running) — never for a Blocked run,
        which never spawns.

        `precomposed`: an (composed, blocked) pair already produced by
        compose_for(run) for this exact run — pass it to skip recomposing
        (see compose_for's docstring, N2). Composed fresh via compose_for()
        when omitted (every existing direct caller/test)."""
        if not self.queue:
            raise IndexError("run_next() called on an empty queue")
        run = self.queue.pop(0)
        harness = _smoke_registry.HARNESSES[run.harness]
        started = self.clock()

        composed, blocked = precomposed if precomposed is not None else self.compose_for(run)

        if blocked is not None:
            return CompletedRun(
                queued=run, outcome=None, blocked_reason=blocked.reason, advisory=blocked.advisory,
                exit_code=None, log_path=None, duration_s=0.0, started_at=started,
            )

        argv = composed.argv  # extra_args already appended by compose_env

        if harness.interactive:
            log_path = None
            if on_start is not None:
                on_start(run, log_path)
            try:
                exit_code = self.interactive_execute(argv, composed.env, str(self.repo_root))
            except Exception as e:
                return self._spawn_failure(run, started, None, e)
            outcome = _smoke_registry.classify_run(run.harness, exit_code, "", output_unavailable=True)
        else:
            log_path = self._log_path_for(run, started)
            log_path.parent.mkdir(parents=True, exist_ok=True)
            if on_start is not None:
                on_start(run, log_path)
            lines: list[str] = []
            try:
                with log_path.open("w", encoding="utf-8") as f:
                    def line_sink(line: str, _f=f, _lines=lines) -> None:
                        scrubbed = _smoke_identity.scrub_secrets(line)
                        _f.write(scrubbed + "\n")
                        _f.flush()
                        _lines.append(scrubbed)
                    exit_code = self.execute(argv, composed.env, str(self.repo_root), line_sink)
            except Exception as e:
                self._prune_logs()
                return self._spawn_failure(run, started, log_path, e)
            text = "\n".join(lines)
            outcome = _smoke_registry.classify_run(run.harness, exit_code, text)
            self._prune_logs()

        finished = self.clock()
        duration = (finished - started).total_seconds()
        self._append_run_record(run, exit_code, outcome, log_path, duration, started)
        if self.probe is not None:
            self.probe_all()

        return CompletedRun(
            queued=run, outcome=outcome, blocked_reason=None, advisory=False,
            exit_code=exit_code, log_path=log_path, duration_s=duration, started_at=started,
        )

    def _spawn_failure(self, run: QueuedRun, started: datetime, log_path: Path | None,
                        exc: Exception) -> CompletedRun:
        """SECURITY (B1): an exception escaping the actual spawn — a Popen
        failure (e.g. `uv` missing -> FileNotFoundError), a mid-stream
        decode error, anything else — must NEVER propagate out of run_next.
        An uncaught exception reaches Textual's default crash handler, whose
        rich.traceback.Traceback(show_locals=True) prints this frame's
        locals — including `composed.env`, which holds REAL bearer/refresh
        tokens — to the terminal. scrub_secrets() belt-and-braces the
        message text too, in case str(exc) itself echoed a token shape back
        (e.g. a URL or header an OS error message happened to quote)."""
        finished = self.clock()
        duration = (finished - started).total_seconds()
        detail = f"spawn failed — {_smoke_identity.scrub_secrets(str(exc))}"
        outcome = _smoke_registry.RunOutcome("FAIL", (), detail)
        self._append_run_record(run, None, outcome, log_path, duration, started)
        return CompletedRun(
            queued=run, outcome=outcome, blocked_reason=None, advisory=False,
            exit_code=None, log_path=log_path, duration_s=duration, started_at=started,
        )


# =============================================================================
# SmokeRunnerApp — Textual UI
# =============================================================================

# Deferred textual imports: RunnerCore above has zero Textual dependency, so
# any test that only exercises RunnerCore never needs Textual to import
# cleanly. (In practice textual is always installed per this file's own PEP
# 723 header, but keeping the import boundary honest documents the layering.)
from textual.app import App, ComposeResult  # noqa: E402
from textual.binding import Binding  # noqa: E402
from textual.containers import Horizontal, Vertical, VerticalScroll  # noqa: E402
from textual.message import Message  # noqa: E402
from textual.screen import ModalScreen, Screen  # noqa: E402
from textual.widgets import (  # noqa: E402
    Checkbox, DataTable, Footer, Input, Label, RadioButton, RadioSet, SelectionList, Static,
)
from rich.text import Text  # noqa: E402


_STATUS_SYMBOL = {
    "PASS": "✓",       # ✓
    "FAIL": "✗",       # ✗
    "SUSPECT": "?",
    "ALL_SKIPPED": "ALL-SKIPPED",
}
_STATUS_CLASS = {
    "PASS": "status-pass",
    "FAIL": "status-fail",
    "SUSPECT": "status-suspect",
    "ALL_SKIPPED": "status-all-skipped",
}
_LEVEL_SYMBOL = {"PASS": "✓", "FAIL": "✗", "SKIP": "–"}  # ✓ ✗ –


class QueueRow(Static):
    """A single result-pane row. Focusable so the queue-reorder bindings
    ('[' / ']') have something to act on — Tab/Shift+Tab or a click moves
    focus onto one of these; a completed row is harmlessly focusable too
    (only a row still carrying "status-queued" is eligible to move)."""

    can_focus = True


@dataclass(frozen=True)
class HarnessSelection:
    """The operator's persisted (mode, levels) choice for one harness row —
    set by the mode/level drawer (design doc: "per-harness mode/level
    pickers in a drawer (enter)"), read by action_run_selected. `levels`
    mirrors QueuedRun.levels: None means "the default set" (compose_env
    omits --levels for that case; see the implementation plan's WP1
    section) — a customised-but-equal-to-default selection is deliberately
    collapsed back to None so that behaviour holds."""

    mode: str
    levels: tuple[str, ...] | None = None


@dataclass
class _RowInfo:
    """Mutable per-row bookkeeping the results pane needs beyond what's on
    the widget itself: which QueuedRun this row is, its log file (known
    once the run actually starts — None while queued or if it was Blocked),
    and whether it's the run currently executing (M2: open with
    follow=True) or already finished (open as a static read)."""

    run: QueuedRun
    log_path: Path | None = None
    running: bool = False


def _find_mode(harness: "_smoke_registry.Harness", mode_name: str) -> "_smoke_registry.Mode":
    for m in harness.modes:
        if m.name == mode_name:
            return m
    return harness.modes[0]


def _default_mode_for(harness: "_smoke_registry.Harness", provider: str) -> "_smoke_registry.Mode":
    """The mode a harness row starts on when the operator hasn't picked one
    in the drawer — chosen off the campaign provider (RunnerConfig.provider,
    2026-09-17), not blindly modes[0]. modes[0] is always the Google mode,
    which at the Microsoft target left regression/reset BLOCKED (their
    google modes are dev-only) and multiuser/meeting/poll silently running
    their GOOGLE modes there, so a "Microsoft campaign" looked like
    ms-smoke alone.

    Precedence: the first mode naming `provider` exactly; else the first
    provider-agnostic mode (provider=None — config-smoke/engine-smoke's
    resolve-only modes, which apply to either campaign); else modes[0] (a
    harness with only the OTHER provider's modes, e.g. ms-smoke under a
    google campaign — it then shows as whatever compose_env says, loudly).
    Target validity is deliberately NOT considered here: M3's rule is that
    a target mismatch renders as a BLOCKED row, never as a silent switch to
    whatever mode happens to fit."""
    for m in harness.modes:
        if m.provider == provider:
            return m
    for m in harness.modes:
        if m.provider is None:
            return m
    return harness.modes[0]


def _levels_universe(harness: "_smoke_registry.Harness", mode_obj: "_smoke_registry.Mode") -> tuple[str, ...]:
    """Every selectable label for this harness/mode (harness.levels
    includes e.g. regression's "owned-meetings", which default_levels
    excludes) — the exact contract compose_env's own argv construction relies on."""
    return mode_obj.levels if mode_obj.levels is not None else harness.levels


def _level_widget_id(lvl: str) -> str:
    """Textual widget ids allow only letters/numbers/underscore/hyphen — a
    level label like regression-smoke's "5.1"/"5.2" contains a literal '.'
    and would otherwise raise BadIdentifier at mount time. '.' -> '_' is
    injective over this registry's actual level labels (no label collides
    with another's post-substitution form), so it round-trips safely
    without needing a separate id<->label table."""
    return "drawer-level-" + lvl.replace(".", "_")


def _default_level_set(harness: "_smoke_registry.Harness", mode_obj: "_smoke_registry.Mode") -> tuple[str, ...]:
    """The subset that runs when levels=None/omitted — delegates to the
    registry's own _default_levels rather than re-deriving the mode.levels
    / harness.default_levels / harness.levels fallback chain a second time,
    so WP4 can never drift from the exact algorithm compose_env's
    omit-the-flag-when-default decision (step 8) already uses."""
    return _smoke_registry._default_levels(harness, mode_obj)


def _all_config_slots(cfg: "_smoke_identity.RunnerConfig",
                       partial_slots: "Sequence[str]" = ()) -> list[str]:
    """Every slot the identity pane should show a row for: config-known
    letters on BOTH providers — six slots total, never the collapsed
    "microsoft:primary" sentinel (internal design notes,
    Decision 2: Microsoft gets signed-in letters mirroring Google) — plus
    any slot with a half-exported env attempt (SeedReport.partial) even
    when config doesn't name that letter at all — a typo'd export must
    never be invisible just because the operator never got as far as
    adding its email to config.toml. "microsoft.attendee" (email-only,
    never logs in) is included too, when configured, as a purely
    informational row — see _render_identity_pane's special-case for it."""
    slots = {f"google:{L}" for L in ("a", "b", "c") if cfg.google.get(L)}
    slots |= {f"microsoft:{L}" for L in ("a", "b", "c") if cfg.microsoft.get(L)}
    if (cfg.microsoft_attendee or "").strip():
        slots.add("microsoft.attendee")
    slots.update(partial_slots)
    return sorted(slots, key=_slot_sort_key)


def _slot_sort_key(slot: str) -> tuple[int, str]:
    """NIT (review round 2): a plain string sort put "microsoft.attendee"
    ('.' < ':') ahead of every real identity slot, including google:* rows
    (also "microsoft.attendee" < "microsoft:a" alphabetically) — every real
    "provider:letter" identity slot sorts first, alphabetically; a purely
    informational dotted slot (today: only microsoft.attendee) always sorts
    after all of them, matching the docs sketch."""
    return (0 if ":" in slot else 1, slot)


def _target_name_for_slot(slot: str, current_target: str) -> str:
    """Which target's host a slot's bearer should be probed/logged in
    against: a google letter follows the app's CURRENT target (meeting/
    poll/multiuser run on several targets, with A/B/C tokens minted against
    whichever host is current); any other provider is pinned to the first
    target that actually hosts it — derived from Target.providers rather
    than a hardcoded literal, so moving a provider between targets needs no
    runner change. Falls back to "dev" when nothing hosts the provider
    (should never happen given the registry, but must never raise from a
    render path)."""
    # NIT (review round 2): a dotted slot ("microsoft.attendee") is not a
    # "provider:letter" identity slot at all — it never logs in and is
    # never probed, so it has no real target. Guard for it EXPLICITLY
    # (rather than letting slot_provider() read the whole dotted string as
    # a bogus "provider" that then accidentally falls through to the "dev"
    # fallback below) — "dev" here is a documented placeholder no caller
    # may actually dereference for this slot, not an inferred answer.
    if ":" not in slot:
        return "dev"
    provider = _smoke_identity.slot_provider(slot)
    if provider == "google":
        return current_target if current_target in _smoke_registry.TARGETS else "dev"
    for name, tgt in _smoke_registry.TARGETS.items():
        if provider in tgt.providers:
            return name
    return "dev"


def _target_url_for_slot(cfg: "_smoke_identity.RunnerConfig", slot: str) -> str:
    return _smoke_registry.TARGETS[_target_name_for_slot(slot, cfg.target)].scheduler_url


def _slot_widget_id(slot: str) -> str:
    """":' and '.' aren't valid Textual widget-id characters (same class of
    issue as _level_widget_id's '.') — "google:a" -> "google-a",
    "microsoft.attendee" -> "microsoft_attendee". NIT (review round 2):
    ':' and '.' must map to DISTINCT replacement characters — mapping both
    to '-' made "microsoft.attendee" and a hypothetical "microsoft:attendee"
    collide on the same widget id."""
    return "identity-" + slot.replace(":", "-").replace(".", "_")


_BEARER_MINUTES_RE = re.compile(r"bearer (\d+)m")


def _identity_row_class(state_label: str, detail: str) -> str:
    """Design doc colour table: FRESH green, VALID cyan, BEARER_EXPIRED
    yellow, STALE/WRONG_ACCOUNT red, ABSENT dim — plus "countdown dims to
    yellow when bearer <10 min" for an otherwise-green FRESH row. PROBE_ERROR
    and the pane's own UNPROBED (not an _smoke_identity.IdentityState —
    "seeded but no probe result yet") aren't in the design's table; both get
    the same dim treatment as ABSENT (neither is a "you must act" state)."""
    if state_label == "FRESH":
        m = _BEARER_MINUTES_RE.search(detail)
        if m and int(m.group(1)) < 10:
            return "identity-fresh-dimming"
        return "identity-fresh"
    if state_label == "VALID":
        return "identity-valid"
    if state_label == "BEARER_EXPIRED":
        return "identity-bearer-expired"
    if state_label == "STALE":
        return "identity-stale"
    if state_label == "WRONG_ACCOUNT":
        return "identity-wrong-account"
    if state_label == "ABSENT":
        return "identity-absent"
    return "identity-unprobed"  # PROBE_ERROR, and the pane's own "UNPROBED"


class LogViewerScreen(Screen):
    """Full-screen overlay reading a run's log file: search (/, submit to
    jump to the first match, n/N to step through the rest), follow-tail
    while the log's run is still executing (poll_for_new_lines — wired to a
    timer here, called directly by tests), and jump-to-first-FAIL (f)."""

    BINDINGS = [
        Binding("escape", "dismiss_viewer", "close"),
        Binding("slash", "start_search", "search", show=False),
        Binding("n", "next_match", "next match", show=False),
        Binding("N", "prev_match", "prev match", show=False),
        Binding("f", "jump_first_fail", "first FAIL", show=False),
        # Textual owns the mouse, so native drag-select needs the terminal's
        # bypass modifier (Shift in WezTerm/kitty/Ghostty, Option in iTerm2)
        # or Textual's own click-drag + ctrl+c (OSC 52). 'o' sidesteps both:
        # the log opens in $PAGER on the real terminal.
        Binding("o", "open_in_pager", "open in $PAGER"),
    ]

    def __init__(self, log_path: Path, title: str, *, follow: bool = False,
                 poll_interval: float = 0.5) -> None:
        super().__init__()
        self.log_path = log_path
        self._title = title
        self._follow = follow
        self._poll_interval = poll_interval
        self._lines: list[str] = []
        self._read_pos = 0  # byte offset already consumed from log_path — follow-tail resumes from here
        self._matches: list[int] = []
        self._match_idx = -1

    def compose(self) -> ComposeResult:
        yield Static(self._title, id="log-title")
        # disabled=True (not just the "hidden" CSS class) so it's excluded
        # from the initial focus chain — otherwise Textual auto-focuses the
        # first focusable widget on mount and this Input (invisible but
        # still focused) would silently swallow every subsequent keypress
        # ('/', 'f', 'n'...) as literal text instead of letting the
        # screen-level bindings fire.
        yield Input(placeholder="search log…", id="log-search", classes="hidden", disabled=True)
        yield VerticalScroll(Static(id="log-body"), id="log-scroll")
        yield Footer()

    def on_mount(self) -> None:
        self._load_full()
        if self._follow:
            self.set_interval(self._poll_interval, self.poll_for_new_lines)

    def _render_body(self) -> None:
        """N3: build a rich.text.Text with style SPANS applied only to the
        FAIL/ERROR/current-match lines, rather than converting every line to
        a markup string. A per-line [red]...[/red]/escape pass used to cost
        something on every single line regardless of whether it needed
        styling — exactly the "no per-line markup cost" a huge unsat-core
        dump must avoid (design doc). Text.append with no `style` never
        parses its argument as markup, so a literal '[' in raw harness
        output (JSON, an "[INFO]" prefix) needs no escaping at all here."""
        body = self.query_one("#log-body", Static)
        current = self._matches[self._match_idx] if 0 <= self._match_idx < len(self._matches) else None
        text = Text()
        for i, line in enumerate(self._lines):
            if i:
                text.append("\n")
            if i == current:
                text.append(line, style="reverse")
            elif "FAIL" in line or "ERROR" in line:
                text.append(line, style="red")
            else:
                text.append(line)
        body.update(text)

    def _load_full(self) -> None:
        try:
            data = self.log_path.read_bytes()
        except OSError as e:
            self._lines = [f"(could not read log: {e})"]
            self._read_pos = 0
            self._render_body()
            return
        self._read_pos = len(data)
        self._lines = data.decode("utf-8", errors="replace").splitlines()
        self._render_body()

    def poll_for_new_lines(self) -> int:
        """Re-read the log file from where the last read left off and append
        any newly-written lines (the follow-tail mechanism for a run that's
        still executing). Returns the count of new lines appended — a plain
        synchronous value, deliberately not gated on `self._follow`, so a
        test can call this directly instead of waiting on the timer that
        wires it in production (on_mount, when follow=True)."""
        try:
            data = self.log_path.read_bytes()
        except OSError:
            return 0
        if len(data) <= self._read_pos:
            return 0
        new_text = data[self._read_pos:].decode("utf-8", errors="replace")
        self._read_pos = len(data)
        new_lines = new_text.splitlines()
        if not new_lines:
            return 0
        scroll = self.query_one("#log-scroll", VerticalScroll)
        # N4: only follow the tail if the viewer was already at the bottom —
        # a viewer who scrolled up to inspect earlier output must not get
        # yanked back down every time the still-running child writes another
        # line.
        was_at_bottom = scroll.scroll_y >= scroll.max_scroll_y
        self._lines.extend(new_lines)
        self._render_body()
        if was_at_bottom:
            scroll.scroll_end(animate=False)
        return len(new_lines)

    def _scroll_to_line(self, i: int) -> None:
        self.query_one("#log-scroll", VerticalScroll).scroll_to(y=i, animate=False)

    def action_dismiss_viewer(self) -> None:
        self.dismiss()

    def action_open_in_pager(self) -> None:
        self.app.open_log_in_pager(self.log_path)

    def action_jump_first_fail(self) -> None:
        for i, line in enumerate(self._lines):
            if "FAIL" in line:
                self._scroll_to_line(i)
                return

    def action_start_search(self) -> None:
        search = self.query_one("#log-search", Input)
        search.disabled = False
        search.remove_class("hidden")
        search.value = ""
        search.focus()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "log-search":
            return
        query = event.value
        event.input.add_class("hidden")
        event.input.disabled = True
        self.set_focus(None)
        if not query:
            self._matches = []
            self._match_idx = -1
            return
        self._matches = [i for i, line in enumerate(self._lines) if query in line]
        self._match_idx = 0 if self._matches else -1
        self._render_body()
        if self._matches:
            self._scroll_to_line(self._matches[0])

    def action_next_match(self) -> None:
        if not self._matches:
            return
        self._match_idx = (self._match_idx + 1) % len(self._matches)
        self._render_body()
        self._scroll_to_line(self._matches[self._match_idx])

    def action_prev_match(self) -> None:
        if not self._matches:
            return
        self._match_idx = (self._match_idx - 1) % len(self._matches)
        self._render_body()
        self._scroll_to_line(self._matches[self._match_idx])


class HistoryScreen(Screen):
    """Lists runs.jsonl entries (newest first) and opens their logs."""

    BINDINGS = [Binding("escape", "dismiss_history", "close")]

    def __init__(self, state_dir: Path) -> None:
        super().__init__()
        self.state_dir = state_dir
        self._records: list[dict] = []

    def compose(self) -> ComposeResult:
        yield Static("HISTORY", id="history-title")
        # cursor_type="row": the default is "cell", which fires CellSelected
        # on Enter, not the RowSelected on_data_table_row_selected listens
        # for — selecting anywhere in a row must open that run's log.
        yield DataTable(id="history-table", cursor_type="row")
        yield Footer()

    def on_mount(self) -> None:
        table = self.query_one("#history-table", DataTable)
        table.add_columns("ts", "harness", "mode", "target", "status", "log")
        runs_path = self.state_dir / "runs.jsonl"
        records: list[dict] = []
        if runs_path.exists():
            for line in runs_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except ValueError:
                    continue
        records.reverse()
        self._records = records
        for rec in records:
            table.add_row(rec.get("ts", ""), rec.get("harness", ""), rec.get("mode", ""),
                          rec.get("target", ""), rec.get("status", ""), rec.get("log_path") or "-")

    def action_dismiss_history(self) -> None:
        self.dismiss()

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        idx = event.cursor_row
        if 0 <= idx < len(self._records):
            log_path = self._records[idx].get("log_path")
            if log_path:
                self.app.push_screen(LogViewerScreen(Path(log_path), f"log: {self._records[idx]['harness']}"))


class ResetEnvModal(ModalScreen[QueuedRun | None]):
    """The flag-picker for `reset-smoke-env` (design doc: "bound to the R
    action with a flag-picker modal, not a harness checkbox")."""

    # priority=True: RadioSet/RadioButton/Checkbox each bind bare Enter
    # themselves (toggle) — a plain `key_enter` handler here would never see
    # the keypress while any of those has focus, since the focused widget's
    # own binding wins first. A Screen-level *priority* binding is checked
    # before the focus chain, so Enter reliably submits regardless of which
    # control currently has focus (verified empirically against Textual's
    # binding resolution order).
    BINDINGS = [
        Binding("escape", "cancel", "cancel", priority=True),
        Binding("enter", "apply", "run", priority=True),
    ]

    def __init__(self, cfg: "_smoke_identity.RunnerConfig") -> None:
        super().__init__()
        self.cfg = cfg

    def compose(self) -> ComposeResult:
        with Vertical(id="reset-modal"):
            yield Label("reset-smoke-env")
            with RadioSet(id="reset-provider"):
                yield RadioButton("google", value=True, id="reset-google")
                yield RadioButton("microsoft", id="reset-microsoft")
            yield Checkbox("--clear-all", id="reset-clear-all")
            yield Checkbox("--l6-current-week", id="reset-l6")
            yield Checkbox("--dry-run", id="reset-dry-run")
            yield Label("[enter] run   [escape] cancel")

    def action_cancel(self) -> None:
        self.dismiss(None)

    def action_apply(self) -> None:
        provider_set = self.query_one("#reset-provider", RadioSet)
        pressed = provider_set.pressed_button
        mode = "microsoft" if pressed is not None and pressed.id == "reset-microsoft" else "google"
        # NIT (review round 2): derive the target from the resolved mode's
        # own Mode.targets (its first entry) rather than a hardcoded
        # per-provider literal, so this modal can never drift from the
        # registry's own target list for reset-smoke-env.
        reset_harness = _smoke_registry.HARNESSES["reset-smoke-env"]
        reset_mode_obj = _find_mode(reset_harness, mode)
        target = reset_mode_obj.targets[0] if reset_mode_obj.targets else "dev"
        extra_args: list[str] = []
        if self.query_one("#reset-clear-all", Checkbox).value:
            extra_args.append("--clear-all")
        if self.query_one("#reset-l6", Checkbox).value:
            extra_args.append("--l6-current-week")
        if self.query_one("#reset-dry-run", Checkbox).value:
            extra_args.append("--dry-run")
        self.dismiss(QueuedRun(harness="reset-smoke-env", mode=mode, target=target,
                                extra_args=tuple(extra_args)))


class SettingsModal(ModalScreen["_smoke_identity.RunnerConfig | None"]):
    """Pragmatic v1 of the design's settings screen: the account cast
    (design doc "TUI has a settings screen that edits this file") — target
    plus every RunnerConfig field save_config/load_config round-trip.
    Input fields only, apply/cancel — no live validation beyond what
    RunnerConfig's own constructor accepts. Applying writes through
    _smoke_identity.save_config (already covered by WP2's own test suite)
    and the caller re-seeds via RunnerCore.rescan()."""

    BINDINGS = [
        Binding("escape", "cancel", "cancel", priority=True),
        Binding("enter", "apply", "save", priority=True),
    ]

    _FIELDS: "tuple[tuple[str, str], ...]" = (
        ("settings-target", f"target ({'/'.join(_smoke_registry.TARGETS)})"),
        ("settings-provider", "provider (google/microsoft)"),
        ("settings-google-a", "google a"),
        ("settings-google-b", "google b"),
        ("settings-google-c", "google c"),
        ("settings-google-primary", "google primary (a/b/c)"),
        ("settings-ms-a", "microsoft a"),
        ("settings-ms-b", "microsoft b"),
        ("settings-ms-c", "microsoft c"),
        ("settings-ms-primary", "microsoft primary (a/b/c)"),
        ("settings-ms-attendee", "microsoft attendee"),
        ("settings-poll-a", "poll invitee a (blank = derive from google.b)"),
        ("settings-poll-b", "poll invitee b (blank = derive from google.c)"),
    )

    def __init__(self, cfg: "_smoke_identity.RunnerConfig") -> None:
        super().__init__()
        self.cfg = cfg

    def _initial_value(self, field_id: str) -> str:
        cfg = self.cfg
        return {
            "settings-target": cfg.target,
            "settings-provider": cfg.provider,
            "settings-google-a": cfg.google.get("a", ""),
            "settings-google-b": cfg.google.get("b", ""),
            "settings-google-c": cfg.google.get("c", ""),
            "settings-google-primary": cfg.google_primary,
            "settings-ms-a": cfg.microsoft.get("a", ""),
            "settings-ms-b": cfg.microsoft.get("b", ""),
            "settings-ms-c": cfg.microsoft.get("c", ""),
            "settings-ms-primary": cfg.microsoft_primary or "a",
            "settings-ms-attendee": cfg.microsoft_attendee,
            "settings-poll-a": cfg.poll_invitee_a_set,
            "settings-poll-b": cfg.poll_invitee_b_set,
        }[field_id]

    def compose(self) -> ComposeResult:
        with Vertical(id="settings-modal"):
            yield Label("settings — config.toml")
            for field_id, caption in self._FIELDS:
                yield Label(caption)
                yield Input(value=self._initial_value(field_id), id=field_id)
            yield Label("[enter] save   [escape] cancel")

    def action_cancel(self) -> None:
        self.dismiss(None)

    def _val(self, field_id: str) -> str:
        return self.query_one(f"#{field_id}", Input).value.strip()

    def action_apply(self) -> None:
        target = self._val("settings-target") or "dev"
        provider = self._val("settings-provider") or "google"
        google_primary = self._val("settings-google-primary") or "a"
        ms_primary = self._val("settings-ms-primary") or "a"

        # BLOCKING (review round 2): a junk value here ("d", "1", "prod")
        # used to reach RunnerConfig fine (they're plain str fields) and
        # only blow up as a ValueError inside save_config — raised from
        # push_screen's dismiss callback, which took the whole TUI down
        # with a traceback and orphaned any running harness child. Validate
        # BEFORE dismissing and keep the modal open (never dismiss) on
        # invalid input, notifying exactly why.
        errors: list[str] = []
        if target not in _smoke_registry.TARGETS:
            errors.append(f"target must be one of {', '.join(sorted(_smoke_registry.TARGETS))}, got {target!r}")
        if provider not in _smoke_identity.PROVIDERS:
            errors.append(f"provider must be one of {', '.join(_smoke_identity.PROVIDERS)}, got {provider!r}")
        if google_primary.lower() not in ("a", "b", "c"):
            errors.append(f"google primary must be a/b/c, got {google_primary!r}")
        if ms_primary.lower() not in ("a", "b", "c"):
            errors.append(f"microsoft primary must be a/b/c, got {ms_primary!r}")
        if errors:
            self.notify("; ".join(errors), severity="error")
            return

        google = {}
        for L in ("a", "b", "c"):
            v = self._val(f"settings-google-{L}")
            if v:
                google[L] = v
        # BLOCKING (identity review): this used to build RunnerConfig(...)
        # WITHOUT microsoft=, so applying — even unchanged — silently wiped
        # the [microsoft] letter cast from config.toml. Build it the same
        # way as google, above.
        microsoft = {}
        for L in ("a", "b", "c"):
            v = self._val(f"settings-ms-{L}")
            if v:
                microsoft[L] = v
        new_cfg = _smoke_identity.RunnerConfig(
            target=target,
            provider=provider,
            google=google,
            google_primary=google_primary,
            microsoft=microsoft,
            microsoft_primary=ms_primary,
            microsoft_attendee=self._val("settings-ms-attendee"),
            poll_invitee_a_set=self._val("settings-poll-a"),
            poll_invitee_b_set=self._val("settings-poll-b"),
        )
        self.dismiss(new_cfg)


class HarnessList(SelectionList):
    """The harness pane's SelectionList with 'enter' repurposed to open the
    mode/level drawer (design doc: "per-harness mode/level pickers in a
    drawer (enter)") instead of OptionList's inherited toggle-on-enter
    behaviour. 'space' is untouched (still toggles the run selection) — only
    the 'enter' binding is overridden, by redeclaring that one key in this
    subclass's own BINDINGS (verified empirically: a subclass BINDINGS entry
    for a key ancestor classes also bind wins outright, not additively)."""

    BINDINGS = [Binding("enter", "open_drawer", "mode/levels", show=False)]

    class OpenDrawer(Message):
        def __init__(self, index: int) -> None:
            self.index = index
            super().__init__()

    def action_open_drawer(self) -> None:
        if self.highlighted is not None:
            self.post_message(self.OpenDrawer(self.highlighted))


class HarnessDrawerScreen(ModalScreen[HarnessSelection | None]):
    """Per-harness mode + level picker (design doc: "Harness pane: checkbox
    selection; per-harness mode/level pickers in a drawer (enter)").

    Mode selection is a RadioSet when the harness has more than one mode
    (single-mode harnesses show a plain info line instead — nothing to
    pick); a mode whose `targets` doesn't include the app's current target,
    OR whose `provider` the current target doesn't host (Target.providers —
    internal design notes WP1.5 task 6; meeting-smoke's
    microsoft-* modes are the first case of this), renders disabled, with
    the reason in its own label (never silently unselectable). Level
    selection is a Checkbox per label in _levels_universe(harness, mode),
    pre-checked to `current.levels` if the mode matches what was already
    selected, else that mode's own _default_level_set — switching modes
    live-resets the level checkboxes to the newly-selected mode's defaults
    (meeting-smoke's 2-account vs 3-account levels are entirely different
    sets). Harness.advisories and the currently-selected Mode.advisories
    both render as info lines (#drawer-advisories), live-updating with the
    mode switch — see _populate_advisories."""

    # priority=True for the same reason as ResetEnvModal's BINDINGS: every
    # RadioSet/RadioButton/Checkbox in this drawer binds bare Enter itself
    # (toggle) — only a priority Screen-level binding is checked before that
    # focus-chain interception (see ResetEnvModal's comment).
    BINDINGS = [
        Binding("escape", "cancel", "cancel", priority=True),
        Binding("enter", "apply", "apply", priority=True),
    ]

    def __init__(self, harness: "_smoke_registry.Harness", current: HarnessSelection, target: str) -> None:
        super().__init__()
        self.harness = harness
        self.current = current
        self.target = target
        self._mode = current.mode

    def _disabled_reasons(self, m: "_smoke_registry.Mode") -> list[str]:
        """Every reason `m` can't be selected against self.target — a
        target-mismatch (Mode.targets) and/or a provider-hosting mismatch
        (Mode.provider not in Target.providers), checked independently
        since compose_env itself raises Blocked for either one on its own
        (steps 3 and 3b) — a mode can fail one, the other, or both."""
        reasons = []
        if m.targets and self.target not in m.targets:
            reasons.append(f"not valid for target {self.target!r}")
        tgt = _smoke_registry.TARGETS.get(self.target)
        if m.provider is not None and tgt is not None and m.provider not in tgt.providers:
            reasons.append(f"target {self.target!r} does not host provider {m.provider!r}")
        return reasons

    def compose(self) -> ComposeResult:
        with Vertical(id="drawer"):
            yield Label(f"{self.harness.name} — mode / levels")
            if len(self.harness.modes) > 1:
                with RadioSet(id="drawer-mode"):
                    for m in self.harness.modes:
                        reasons = self._disabled_reasons(m)
                        label = f"{m.name}  (targets: {', '.join(m.targets) or 'any'})"
                        if reasons:
                            label += "  — disabled: " + "; ".join(reasons)
                        yield RadioButton(label, id=f"drawer-mode-{m.name}",
                                           value=(m.name == self.current.mode), disabled=bool(reasons))
            else:
                only_mode = self.harness.modes[0]
                reasons = self._disabled_reasons(only_mode)
                text = f"mode: {only_mode.name}  (targets: {', '.join(only_mode.targets) or 'any'})"
                if reasons:
                    text += "  — BLOCKED: " + "; ".join(reasons)
                yield Label(text, id="drawer-mode-info")
            yield Vertical(id="drawer-advisories")
            yield Vertical(id="drawer-levels")
            yield Label("[enter] apply   [escape] cancel")

    async def on_mount(self) -> None:
        await self._populate_advisories()
        await self._populate_levels()

    async def _populate_advisories(self) -> None:
        """Harness.advisories (rendered nowhere before this — WP1.5 task 5)
        plus the currently-selected Mode.advisories (task 6) as plain info
        lines — purely informational, never a Blocked, so shown regardless
        of whether the mode is itself disabled."""
        container = self.query_one("#drawer-advisories", Vertical)
        await container.remove_children()
        mode_obj = _find_mode(self.harness, self._mode)
        for line in (*self.harness.advisories, *mode_obj.advisories):
            await container.mount(Label(f"· {line}", classes="drawer-advisory"))

    async def _populate_levels(self) -> None:
        container = self.query_one("#drawer-levels", Vertical)
        await container.remove_children()
        mode_obj = _find_mode(self.harness, self._mode)
        universe = _levels_universe(self.harness, mode_obj)
        default_set = _default_level_set(self.harness, mode_obj)
        checked = self.current.levels if (self.current.levels is not None and self._mode == self.current.mode) else default_set
        for lvl in universe:
            await container.mount(Checkbox(lvl, id=_level_widget_id(lvl), value=(lvl in checked)))

    async def on_radio_set_changed(self, event: RadioSet.Changed) -> None:
        if event.radio_set.id != "drawer-mode":
            return
        pressed = event.pressed
        if pressed is None or pressed.id is None:
            return
        self._mode = pressed.id[len("drawer-mode-"):]
        await self._populate_advisories()
        await self._populate_levels()

    def action_cancel(self) -> None:
        self.dismiss(None)

    def action_apply(self) -> None:
        mode_obj = _find_mode(self.harness, self._mode)
        if self._disabled_reasons(mode_obj):
            return  # defensive: a disabled mode must never be applied
        universe = _levels_universe(self.harness, mode_obj)
        levels: tuple[str, ...] | None
        if universe:
            selected = tuple(lvl for lvl in universe if self.query_one(f"#{_level_widget_id(lvl)}", Checkbox).value)
            levels = None if selected == _default_level_set(self.harness, mode_obj) else selected
        else:
            levels = None
        self.dismiss(HarnessSelection(mode=self._mode, levels=levels))


class SmokeRunnerApp(App):
    """Identity pane / harness pane / results pane / footer — see
    the internal design notes' TUI layout ASCII sketch. Colour is always
    paired with a word/symbol (never the sole channel) and uses Textual's
    semantic theme tokens rather than hard-coded hex."""

    CSS = """
    #header-bar {
        /* Horizontal defaults to height: 1fr — un-pinned, it split the
           terminal 50/50 with #main (M8). */
        height: 1;
        background: $panel;
        padding: 0 1;
    }
    #header-title, #target-badge, #provider-badge, #op-secrets-badge {
        /* Static has no default width, so each stretched to the full row and
           pushed the badges off-screen (M8). */
        width: auto;
    }
    #advisory-banner {
        background: $warning;
        color: $text;
        padding: 0 1;
    }
    #advisory-banner.hidden {
        display: none;
    }
    #log-search.hidden {
        display: none;
    }
    .run-result.hidden {
        display: none;
    }
    #main {
        height: 1fr;
    }
    #left-pane {
        width: 45%;
        border-right: solid $panel-lighten-1;
    }
    #right-pane {
        width: 1fr;
    }
    #seed-warnings {
        background: $warning;
        color: $text;
        padding: 0 1;
    }
    #seed-warnings.hidden {
        display: none;
    }
    #identity-rows {
        height: auto;
        max-height: 10;
    }
    .identity-row {
        padding: 0 1;
    }
    .identity-fresh {
        color: $success;
    }
    .identity-fresh-dimming {
        /* design doc: bearer countdown <10m dims FRESH to yellow */
        color: $warning;
    }
    .identity-valid {
        color: cyan;
    }
    .identity-bearer-expired {
        color: $warning;
    }
    .identity-stale, .identity-wrong-account {
        color: $error;
    }
    .identity-absent, .identity-probe-error, .identity-unprobed {
        color: $text-muted;
    }
    #harness-list {
        height: 1fr;
    }
    #results {
        height: 1fr;
    }
    .run-result {
        padding: 0 1;
        border-left: thick $panel;
    }
    .status-queued {
        color: $text-muted;
    }
    .status-pass {
        color: $success;
        border-left: thick $success;
    }
    .status-fail {
        color: $error;
        border-left: thick $error;
    }
    .status-running {
        color: $accent;
        border-left: thick $accent;
        text-style: bold;
    }
    .status-suspect {
        /* M6: $accent == $warning in the built-in themes, which made
           SUSPECT/ALL-SKIPPED/BLOCKED (and now status-running) render
           identically — $secondary keeps this a distinct semantic colour
           while staying a theme token, not a hard-coded hex. */
        color: $secondary;
        border-left: thick $secondary;
        text-style: bold;
    }
    .status-all-skipped {
        color: $warning;
        border-left: thick $warning;
    }
    .status-blocked {
        color: $warning;
        border-left: thick $warning;
    }
    #target-badge {
        padding: 0 1;
        text-style: bold;
    }
    .target-dev {
        background: $primary;
    }
    /* Any other target (.target-<name>): $accent == $warning in the
       built-in themes (same collision M6 fixed for status-suspect) —
       $secondary is a token that's actually visually distinct from dev's
       $primary badge, while staying loud enough for "a whole-campaign
       retarget must be unmissable". */
    #target-badge.target-other {
        background: $secondary;
    }
    #provider-badge {
        /* Same colour pairing as the target badge: $primary is the
           Google/dev default, $secondary the Microsoft side — a
           whole-campaign provider switch is as unmissable as a retarget. */
        padding: 0 1;
        text-style: bold;
    }
    .provider-google {
        background: $primary;
    }
    .provider-microsoft {
        background: $secondary;
    }
    #op-secrets-badge {
        padding: 0 1;
    }
    .op-secrets-ok {
        color: $success;
    }
    .op-secrets-missing {
        color: $warning;
    }
    #settings-modal, #reset-modal, #drawer {
        background: $panel;
        border: solid $panel-lighten-1;
        padding: 1 2;
        width: auto;
        height: auto;
        max-height: 90%;
    }
    """

    BINDINGS = [
        Binding("r", "run_selected", "run"),
        Binding("o", "override_and_run", "override & run", show=False),
        Binding("l", "show_login", "login"),
        Binding("R", "reset_env", "reset-env"),
        Binding("t", "change_target", "target"),
        Binding("P", "change_provider", "provider"),
        Binding("s", "show_settings", "settings"),
        Binding("h", "show_history", "history"),
        Binding("p", "probe_now", "probe"),
        Binding("e", "rescan_env", "rescan"),
        Binding("f", "toggle_failures_only", "failures only", show=False),
        Binding("[", "move_queue_up", "move up", show=False),
        Binding("]", "move_queue_down", "move down", show=False),
        # M2: only fires when the focused widget doesn't claim 'enter'
        # itself — HarnessList overrides 'enter' for its own drawer, so this
        # is reached only when a QueueRow (or nothing) has focus.
        Binding("enter", "open_log_for_focused_row", "open log", show=False),
    ]

    def __init__(self, core: RunnerCore, *, harness_names: Sequence[str] | None = None,
                 suspend_factory: Callable[[], "AbstractContextManager"] | None = None,
                 pager_execute: Callable[[Sequence[str]], int] | None = None) -> None:
        super().__init__()
        self.core = core
        # Test seam for open_log_in_pager (production: subprocess.call on
        # the real TTY, inside App.suspend()).
        self._pager_execute = pager_execute if pager_execute is not None else default_pager_execute
        self._harness_names = list(harness_names) if harness_names is not None else list(_smoke_registry.HARNESSES)
        self._run_counter = 0
        self._pending_widget_ids: deque[str] = deque()
        self._worker_active = False
        self._last_blocked_run: QueuedRun | None = None
        self._failures_only = False
        # Per-harness (mode, levels) choice made via the drawer (enter on a
        # harness row) — persists across drawer opens/rescans/target
        # changes; absent entries fall back to _selection_for's default
        # (the harness's first mode, the default level set).
        self._harness_selection: dict[str, HarnessSelection] = {}
        # widget_id -> _RowInfo, populated in _mount_queued_row, updated by
        # _mark_row_running (M2/M8) and _handle_completed.
        self._row_info: dict[str, _RowInfo] = {}
        # Test seam: production code leaves this None and gets the real
        # App.suspend() (see _run_interactive_locked) — a headless Pilot
        # test has no terminal to suspend, so it injects e.g.
        # contextlib.nullcontext instead. Never used for the compose/Blocked
        # decision itself (core.compose_for, in _drain_queue), only for the
        # actual TTY handoff.
        self._suspend_factory = suspend_factory

    # -- compose --------------------------------------------------------

    def _target_classes(self) -> str:
        """`target-<name>` for a known target, plus `target-other` for any
        target but dev (the loud badge colour); unknown names read as dev."""
        target = self.core.cfg.target
        if target == "dev" or target not in _smoke_registry.TARGETS:
            return "target-dev"
        return f"target-{target} target-other"

    def _op_secrets_missing(self) -> list[str]:
        """Both D1 (CLOUDFLARE_API_TOKEN) and Turnstile (TURNSTILE_SECRET_<ENV>)
        harnesses exist — the indicator only means "everything's available"
        when both secrets are, not just the one D1 harnesses happen to need.
        The Turnstile var is the CURRENT target's own (booking-smoke restores
        TURNSTILE_SECRET_<ENV> for its --wrangler-env, 2026-09-17) — a shell
        with only TURNSTILE_SECRET_DEV is not "everything available" once
        the target is another env."""
        missing = []
        if not (self.core.environ.get("CLOUDFLARE_API_TOKEN") or "").strip():
            missing.append("CLOUDFLARE_API_TOKEN")
        turnstile_var = f"TURNSTILE_SECRET_{_smoke_registry.TARGETS[self.core.cfg.target].wrangler_env.upper()}"
        if not (self.core.environ.get(turnstile_var) or "").strip():
            missing.append(turnstile_var)
        return missing

    def _op_secrets_ok(self) -> bool:
        return not self._op_secrets_missing()

    def _op_secrets_text(self) -> str:
        return f"op-secrets: {'✓' if self._op_secrets_ok() else '✗'}"

    def _op_secrets_class(self) -> str:
        return "op-secrets-ok" if self._op_secrets_ok() else "op-secrets-missing"

    def _op_secrets_tooltip(self) -> str | None:
        missing = self._op_secrets_missing()
        return f"missing: {', '.join(missing)}" if missing else None

    def _selection_for(self, name: str) -> HarnessSelection:
        sel = self._harness_selection.get(name)
        if sel is not None:
            return sel
        harness = _smoke_registry.HARNESSES[name]
        return HarnessSelection(mode=_default_mode_for(harness, self.core.cfg.provider).name, levels=None)

    def _harness_options(self):
        opts = []
        for name in self._harness_names:
            harness = _smoke_registry.HARNESSES[name]
            sel = self._selection_for(name)
            # M3: don't auto-correct the target to
            # whatever the mode happens to support — pass the app's actual
            # current target straight through and let compose_env's own
            # target check produce Blocked. A silent auto-correction is how
            # "header says one target, run went to dev" happens; a loud BLOCKED row
            # is what the design's "a whole-campaign retarget must be
            # unmissable" actually calls for.
            target = self.core.cfg.target
            reason = _smoke_registry.blocked_reason(
                harness, sel.mode, target,
                self.core.environ, self.core.identities, self.core.cfg,
                levels=sel.levels,
            )
            label = f"{name}  ({sel.mode})"
            if sel.levels is not None:
                label += f"  levels:{','.join(sel.levels)}"
            if reason:
                label += f"  BLOCKED: {reason}"
            opts.append((label, name))
        return opts

    def compose(self) -> ComposeResult:
        # M7: the target badge and op-secrets indicator are real widgets
        # carrying .target-<name>/.op-secrets-ok/.op-secrets-missing — those
        # CSS classes were dead (never applied to anything) when the header
        # was one plain Static. The loud non-dev badge in particular is an
        # explicit design requirement ("a whole-campaign retarget must be
        # unmissable").
        with Horizontal(id="header-bar"):
            yield Static("optical smoke", id="header-title")
            yield Static(f"target: {self.core.cfg.target}", id="target-badge", classes=self._target_classes())
            yield Static(f"provider: {self.core.cfg.provider}", id="provider-badge",
                         classes=self._provider_class())
            op_secrets_badge = Static(self._op_secrets_text(), id="op-secrets-badge", classes=self._op_secrets_class())
            op_secrets_badge.tooltip = self._op_secrets_tooltip()
            yield op_secrets_badge
        yield Static("", id="advisory-banner", classes="hidden")
        with Horizontal(id="main"):
            with Vertical(id="left-pane"):
                # markup=False: Label parses console markup by default and
                # ate [p]/[e] as style tags ("IDENTITIES  robe scan").
                yield Label("IDENTITIES  [p]robe [e]scan", id="identities-title", markup=False)
                yield Static("", id="seed-warnings", classes="hidden")
                yield Vertical(id="identity-rows")
                yield Label(
                    "rescan re-reads THIS process's env — it cannot see "
                    "exports made in your shell after launch",
                    id="rescan-caption",
                )
                yield Label("HARNESSES (space=select, enter=mode/levels, r=run, R=reset-env)")
                yield HarnessList(*self._harness_options(), id="harness-list")
            with Vertical(id="right-pane"):
                yield Label("RESULTS  (enter=open log, f=failures only, h=history)")
                yield VerticalScroll(id="results")
        yield Footer()

    async def on_mount(self) -> None:
        await self._render_identity_pane()  # first paint: whatever's seeded, unprobed — never blocks on the network
        if self.core.probe is not None:
            # Off the UI thread — a dead network must not freeze the whole
            # app (including this very first paint) for ~10s per identity
            # while probe_whoami's timeout ticks down serially.
            # exit_on_error=False here too, same posture as the queue
            # worker: an exception through call_from_thread otherwise
            # reaches the fatal show_locals renderer with an IdentityTokens
            # (bearer/refresh) in frame locals — _probe_and_render's own
            # try/except is the inner guard, this is the outer one.
            self.run_worker(self._probe_and_render, thread=True, exclusive=True, group="probe", exit_on_error=False)

    def _probe_and_render(self) -> None:
        try:
            self.core.probe_all()
        except Exception as e:
            # Same B1(c) posture as the queue worker's own guard: an
            # uncaught exception here would reach Textual's default crash
            # handler with an IdentityTokens (bearer/refresh) in this
            # frame's locals — exit_on_error=False on the run_worker() calls
            # below is the outer guard; this is belt-and-braces for the
            # inner body, matching _drain_queue's pattern exactly.
            msg = _smoke_identity.scrub_secrets(str(e))
            self.call_from_thread(self.notify, f"smoke runner: probe error — {msg}", severity="error")
            return
        self.call_from_thread(self._refresh_identity_pane)

    def _refresh_identity_pane(self) -> None:
        """Fire-and-forget scheduling of the async identity-pane render — it
        needs to await remove_children()/mount() on the per-row container,
        so this is the sync-context entry point every non-async caller uses
        (on_mount is itself async and awaits _render_identity_pane directly)."""
        self.run_worker(self._render_identity_pane(), exclusive=True, group="identity-render")

    # -- identity pane ----------------------------------------------------

    def _render_seed_warnings(self) -> None:
        banner = self.query_one("#seed-warnings", Static)
        warnings = self.core.seed_warnings
        if not warnings:
            banner.add_class("hidden")
            return
        banner.update("⚠ " + " · ".join(warnings))
        banner.remove_class("hidden")

    async def _render_identity_pane(self) -> None:
        self._render_seed_warnings()
        container = self.query_one("#identity-rows", Vertical)
        await container.remove_children()
        cfg = self.core.cfg
        slots = sorted(set(_all_config_slots(cfg, self.core.seed_partial)) | set(self.core.identities),
                       key=_slot_sort_key)
        for slot in slots:
            # microsoft.attendee is informational only — email-only,
            # never logs in, never seeded/probed — a slot in name only.
            if slot == "microsoft.attendee":
                row_text = f"{slot}  {cfg.microsoft_attendee}  N/A  never logs in"
                await container.mount(
                    Static(row_text, id=_slot_widget_id(slot), classes="identity-row identity-absent")
                )
                continue
            status = self.core.identity_statuses.get(slot)
            tokens = self.core.identities.get(slot)
            partial_reason = self.core.seed_partial.get(slot)
            if tokens is not None:
                email = tokens.email
            elif slot.startswith("google:"):
                email = cfg.google.get(slot.split(":", 1)[1], "")
            elif slot.startswith("microsoft:"):
                email = cfg.microsoft.get(slot.split(":", 1)[1], "")
            else:
                email = ""
            if status is not None:
                state = status.state.value
                detail = status.detail
                # M4: ABSENT/STALE/WRONG_ACCOUNT must carry the copy-ready
                # login command IN THE TABLE (design promise), not only in
                # the 'l' notify toast — classify()'s own detail text for
                # these states never includes it.
                if status.state in (
                    _smoke_identity.IdentityState.ABSENT,
                    _smoke_identity.IdentityState.STALE,
                    _smoke_identity.IdentityState.WRONG_ACCOUNT,
                ):
                    target_url = _target_url_for_slot(cfg, slot)
                    try:
                        detail = f"{detail} — {_smoke_identity.login_command(slot, cfg, target_url)}"
                    except ValueError:
                        pass
            elif tokens is None:
                state = "ABSENT"
                # A half-exported letter (SeedReport.partial) shows its own
                # "missing X, Y" reason instead of the generic "not seeded" —
                # a typo'd export must never be invisible, even when the
                # slot's email isn't in config.toml at all (_all_config_slots
                # includes it anyway).
                detail = partial_reason if partial_reason else "not seeded"
                target_url = _target_url_for_slot(cfg, slot)
                try:
                    detail = f"{detail} — {_smoke_identity.login_command(slot, cfg, target_url)}"
                except ValueError:
                    pass
            else:
                state = "UNPROBED"
                detail = "not probed yet"
            row_text = f"{slot}  {email}  {state}  {detail}"
            css_class = _identity_row_class(state, detail)
            await container.mount(
                Static(row_text, id=_slot_widget_id(slot), classes=f"identity-row {css_class}")
            )

    # -- results pane -------------------------------------------------------

    def _token_destructive_note(self, run: QueuedRun) -> str | None:
        """WP1.5 task 5: the M7 re-mint advisory, resolved to the CONCRETE
        slot(s) this run's effective levels will actually destroy — never
        the generic Harness.advisories prose ("re-mint the slot named by
        token_destructive_slots"). None when this run carries no
        token-destructive level at all (split_token_destructive resolves
        run.levels=None against the harness/mode default the same way
        compose_env does, so a non-split, default-level multiuser run that
        happens to include M7 is caught too, not just an explicit split).

        NIT (review round 2): this reads self.core.cfg — whatever it is
        AT CALL TIME, not a snapshot taken when the run was queued — so a
        config edit (settings modal, or a hand-edit picked up by 'e'
        rescan) between queueing and this call could in principle change
        the slot named here, including at completion time (the widest
        window: _handle_completed calls this well after the run was
        queued, potentially after a whole harness run's wall-clock time).
        Harmless today: every registered token-destructive mode
        (multiuser-smoke's "default"/"microsoft") maps its destroyed
        prefix ("B") to a concrete slot directly in Mode.identities, never
        through the google:primary/microsoft:primary config sentinels
        _resolve_slot() would re-read — so the note is stable across a cfg
        edit in practice. Would need re-examining if a future
        token-destructive mode ever destroyed a sentinel-resolved slot."""
        harness = _smoke_registry.HARNESSES.get(run.harness)
        if harness is None or not harness.token_destructive_prefixes:
            return None
        _safe, destructive = _smoke_registry.split_token_destructive(harness, run.mode, run.levels)
        if not destructive:
            return None
        slots = _smoke_registry.token_destructive_slots(harness, run.mode, self.core.cfg)
        if not slots:
            return None
        return f"re-mint {', '.join(slots)} after it runs"

    async def _mount_queued_row(self, run: QueuedRun) -> str:
        widget_id = f"result-{self._run_counter}"
        self._run_counter += 1
        label = f"{run.harness} ({run.mode})"
        # An explicit level subset in the row label keeps a plan_queue split
        # legible — two otherwise-identical multiuser rows must be tellable
        # apart (which is the safe half, which is the deferred M7).
        if run.levels is not None:
            label += f" levels:{','.join(run.levels)}"
        note = self._token_destructive_note(run)
        if note:
            label += f"  [{note}]"
        widget = QueueRow(f"{label} — queued",
                           id=widget_id, classes="run-result status-queued")
        await self.query_one("#results", VerticalScroll).mount(widget)
        self._pending_widget_ids.append(widget_id)
        self._row_info[widget_id] = _RowInfo(run=run)
        return widget_id

    def action_open_log_for_focused_row(self) -> None:
        """M2: 'enter' on a results-pane row opens its log — a completed
        row opens a static read; a still-running row (info.running, its
        log_path known since _mark_row_running) opens with follow=True so
        the viewer picks up lines as the child keeps writing them."""
        focused = self.focused
        if not isinstance(focused, QueueRow) or focused.id is None:
            return
        info = self._row_info.get(focused.id)
        if info is None or info.log_path is None:
            return
        self.push_screen(LogViewerScreen(info.log_path, f"log: {info.run.harness}", follow=info.running))

    def _mark_row_running(self, log_path: Path | None) -> None:
        """M2/M8: the row about to execute flips queued -> running, right
        before its child actually spawns (called from run_next's on_start —
        never for a Blocked run, which never reaches on_start at all)."""
        if not self._pending_widget_ids:
            return
        widget_id = self._pending_widget_ids[0]
        info = self._row_info.get(widget_id)
        if info is not None:
            info.running = True
            info.log_path = log_path
        try:
            row = self.query_one(f"#{widget_id}", Static)
        except Exception:
            return
        row.remove_class("status-queued")
        row.add_class("status-running")
        harness_name = info.run.harness if info is not None else ""
        text = f"{harness_name} ⏳ running…"
        # NIT (review round 2): the queued -> running rewrite used to drop
        # the M7 re-mint note the queued row carried — carry it through.
        if info is not None:
            note = self._token_destructive_note(info.run)
            if note:
                text += f"  [{note}]"
        row.update(text)

    def _handle_completed(self, completed: CompletedRun) -> None:
        if not self._pending_widget_ids:
            # N6: a completed run with no matching queued row is internal
            # state drift, not something to swallow silently.
            msg = "smoke runner: a completed run had no matching queued row (internal state drift)"
            self.notify(msg, severity="warning")
            self.log.warning(msg)
            return
        widget_id = self._pending_widget_ids.popleft()
        info = self._row_info.get(widget_id)
        if info is not None:
            info.running = False
            info.log_path = completed.log_path
        try:
            row = self.query_one(f"#{widget_id}", Static)
        except Exception:
            return
        row.remove_class("status-queued")
        row.remove_class("status-running")

        if completed.outcome is None:
            row.add_class("status-blocked")
            row.update(f"{completed.queued.harness} BLOCKED — {completed.blocked_reason}")
            # Typed flag (_smoke_registry.Blocked.advisory), not a substring
            # match on the free-form reason text.
            if completed.advisory:
                self._last_blocked_run = completed.queued
                self._show_advisory_banner(completed.blocked_reason or "")
        else:
            status = completed.outcome.status
            row.add_class(_STATUS_CLASS[status])
            symbol = _STATUS_SYMBOL[status]
            chips = " ".join(
                f"{lv.label}{_LEVEL_SYMBOL.get(lv.status, '?')}" for lv in completed.outcome.levels
            )
            text = f"{completed.queued.harness} {symbol}"
            if chips:
                text += f"  {chips}"
            text += f" — {completed.outcome.detail}"
            if completed.log_path is not None:
                text += f"  · log: {completed.log_path.name}"
            note = self._token_destructive_note(completed.queued)
            if note:
                text += f"  [{note}]"
            row.update(text)
            self._hide_advisory_banner()

        self._refresh_identity_pane()
        self._apply_failures_only()

    def _queued_widget_ids(self) -> list[str]:
        """Row ids still in core.queue (status-queued, not yet started), in
        queue order — equals list(_pending_widget_ids) exactly whenever the
        worker is idle (nothing has been popped off core.queue without its
        _handle_completed having already run), which is the only state
        _move_queue_item allows reordering in."""
        ids: list[str] = []
        for wid in self._pending_widget_ids:
            try:
                row = self.query_one(f"#{wid}", Static)
            except Exception:
                continue
            if "status-queued" in row.classes:
                ids.append(wid)
        return ids

    def action_move_queue_up(self) -> None:
        self._move_queue_item(-1)

    def action_move_queue_down(self) -> None:
        self._move_queue_item(1)

    def _move_queue_item(self, direction: int) -> None:
        """Swap the focused still-queued row with its neighbour, in both
        core.queue and the visible results list. Design doc: "the queue is
        visible and reorderable before start" — deliberately a no-op once
        the worker is draining it (see _queued_widget_ids's docstring for
        why the queue/rows correspondence isn't safe to mutate mid-drain)."""
        if self._worker_active:
            return
        focused = self.focused
        if focused is None or focused.id is None:
            return
        queued_ids = self._queued_widget_ids()
        if focused.id not in queued_ids:
            return
        idx = queued_ids.index(focused.id)
        new_idx = idx + direction
        if not (0 <= new_idx < len(queued_ids)):
            return

        order = list(range(len(queued_ids)))
        order[idx], order[new_idx] = order[new_idx], order[idx]
        self.core.reorder(order)

        neighbour_id = queued_ids[new_idx]
        queued_ids[idx], queued_ids[new_idx] = queued_ids[new_idx], queued_ids[idx]
        self._pending_widget_ids = deque(queued_ids)

        row_a = self.query_one(f"#{focused.id}", Static)
        row_b = self.query_one(f"#{neighbour_id}", Static)
        results = self.query_one("#results", VerticalScroll)
        if direction < 0:
            results.move_child(row_a, before=row_b)
        else:
            results.move_child(row_a, after=row_b)
        focused.focus()

    def _apply_failures_only(self) -> None:
        for row in self.query(".run-result"):
            hide = self._failures_only and "status-fail" not in row.classes and "status-suspect" not in row.classes
            row.set_class(hide, "hidden")

    # -- advisory banner ------------------------------------------------

    def _show_advisory_banner(self, reason: str) -> None:
        banner = self.query_one("#advisory-banner", Static)
        banner.update(f"⚠ {reason}  [o]verride")
        banner.remove_class("hidden")

    def _hide_advisory_banner(self) -> None:
        banner = self.query_one("#advisory-banner", Static)
        banner.add_class("hidden")

    # -- queue worker -------------------------------------------------------

    def _start_queue_worker(self) -> None:
        if self._worker_active:
            return
        self._worker_active = True
        # B1(c): exit_on_error=False — a worker exception must never reach
        # Textual's default crash handler (which would rich-traceback-print
        # this call stack's locals, including composed env/tokens, to the
        # terminal). Belt-and-braces on top of run_next()'s own try/except
        # around the actual spawn (_spawn_failure): _drain_queue's own
        # try/except below is the last line of defence for anything else
        # that might raise in this loop.
        self.run_worker(self._drain_queue, thread=True, exclusive=True, group="queue", exit_on_error=False)

    def _mark_worker_idle(self) -> None:
        self._worker_active = False
        # M1: an enqueue landing on the main thread during this exact
        # teardown window (after the loop saw an empty queue and returned,
        # before this callback ran) must not strand that run as "queued"
        # forever — restart the drain if something's there now.
        if self.core.queue:
            self._start_queue_worker()

    def _on_start_from_worker_thread(self, run: QueuedRun, log_path: Path | None) -> None:
        self.call_from_thread(self._mark_row_running, log_path)

    def _on_start_from_main_thread(self, run: QueuedRun, log_path: Path | None) -> None:
        # _run_interactive_locked already runs on the app's own thread (it
        # was itself dispatched via call_from_thread) — calling
        # call_from_thread again from here would raise ("must run in a
        # different thread from the app"), so this variant updates directly.
        self._mark_row_running(log_path)

    def _drain_queue(self) -> None:
        try:
            while True:
                if not self.core.queue:
                    return
                next_run = self.core.queue[0]
                harness = _smoke_registry.HARNESSES[next_run.harness]
                # N2: compose exactly once per run — this same (composed,
                # blocked) pair is what run_next() below actually executes
                # (via `precomposed`), so a concurrent rescan() can't produce
                # a different verdict between this pre-check and the spawn.
                precomposed = self.core.compose_for(next_run)
                will_spawn = precomposed[1] is None
                if harness.interactive and will_spawn:
                    self.call_from_thread(self._run_interactive_locked, precomposed)
                else:
                    completed = self.core.run_next(
                        on_start=self._on_start_from_worker_thread, precomposed=precomposed,
                    )
                    self.call_from_thread(self._handle_completed, completed)
        except Exception as e:
            # B1(c) belt-and-braces: run_next() already catches spawn
            # failures itself (_spawn_failure) — this is for anything else
            # in this loop (a bug in _handle_completed, a call_from_thread
            # failure, ...). Scrubbed the same way _spawn_failure is.
            msg = _smoke_identity.scrub_secrets(str(e))
            self.call_from_thread(self.notify, f"smoke runner: unexpected error — {msg}", severity="error")
        finally:
            self.call_from_thread(self._mark_worker_idle)

    def open_log_in_pager(self, log_path: Path) -> None:
        """Hand `log_path` to $PAGER (default `less -R`) on the real terminal
        — the one way to copy text out that needs nothing from the terminal
        emulator (Textual's mouse capture defeats native drag-select; its
        own ctrl+c copy needs OSC 52 support). Runs under App.suspend(),
        same hand-off as an interactive harness; resumes the TUI when the
        pager exits."""
        argv = pager_argv(os.environ.get("PAGER"), log_path)
        suspend_cm = self._suspend_factory() if self._suspend_factory is not None else self.suspend()
        with suspend_cm:
            try:
                self._pager_execute(argv)
            except Exception as e:
                self.notify(f"pager failed — {_smoke_identity.scrub_secrets(str(e))}", severity="error")

    def _run_interactive_locked(self, precomposed) -> None:
        """Called via call_from_thread, so this body runs on the app's own
        thread — the only place App.suspend() may be called from. Only
        reached when `precomposed` has already said this run will actually
        spawn (a Blocked interactive run takes the plain core.run_next()
        branch above instead, which never touches suspend)."""
        suspend_cm = self._suspend_factory() if self._suspend_factory is not None else self.suspend()
        with suspend_cm:
            completed = self.core.run_next(on_start=self._on_start_from_main_thread, precomposed=precomposed)
        self._handle_completed(completed)

    # -- actions ------------------------------------------------------------

    async def action_run_selected(self) -> None:
        sl = self.query_one("#harness-list", SelectionList)
        selected = list(sl.selected)
        runs = []
        for name in selected:
            sel = self._selection_for(name)
            # M3: the app's actual current target, unmodified — see
            # _harness_options's identical comment.
            runs.append(QueuedRun(harness=name, mode=sel.mode, target=self.core.cfg.target, levels=sel.levels))
        # Token-destructive levels (multiuser's M7 offboard) run after every
        # other run in this batch — see plan_queue.
        for run in plan_queue(runs):
            await self._mount_queued_row(run)
            self.core.enqueue(run)
        if selected:
            self._start_queue_worker()

    def on_harness_list_open_drawer(self, event: HarnessList.OpenDrawer) -> None:
        if not (0 <= event.index < len(self._harness_names)):
            return
        name = self._harness_names[event.index]
        harness = _smoke_registry.HARNESSES[name]
        current = self._selection_for(name)

        def _on_result(result: HarnessSelection | None) -> None:
            if result is None:
                return
            self._harness_selection[name] = result
            self._refresh_harness_options()

        self.push_screen(HarnessDrawerScreen(harness, current, self.core.cfg.target), _on_result)

    def action_override_and_run(self) -> None:
        if self._last_blocked_run is None:
            return
        run = dataclasses.replace(self._last_blocked_run, override_run_day=True)
        self._last_blocked_run = None
        self.run_worker(self._enqueue_and_start(run), exclusive=False)

    async def _enqueue_and_start(self, run: QueuedRun) -> None:
        await self._mount_queued_row(run)
        self.core.enqueue(run)
        self._start_queue_worker()

    def action_probe_now(self) -> None:
        # M5: off the UI thread, same as on_mount.
        self.run_worker(self._probe_and_render, thread=True, exclusive=True, group="probe", exit_on_error=False)

    def _provider_class(self) -> str:
        return f"provider-{self.core.cfg.provider}"

    def _refresh_provider_badge(self) -> None:
        badge = self.query_one("#provider-badge", Static)
        badge.update(f"provider: {self.core.cfg.provider}")
        for cls in list(badge.classes):
            if cls.startswith("provider-"):
                badge.remove_class(cls)
        badge.add_class(self._provider_class())

    def action_change_provider(self) -> None:
        """Toggle the campaign provider (google <-> microsoft). In-memory
        only, like action_change_target — `s` settings persists. Drawer
        selections whose mode names the OTHER provider are dropped so the
        row falls back to _default_mode_for under the new campaign; a
        selection whose mode already matches (or is provider-agnostic)
        keeps its levels."""
        cfg = self.core.cfg
        new_provider = "microsoft" if cfg.provider == "google" else "google"
        self.core.cfg = dataclasses.replace(cfg, provider=new_provider)
        for name in list(self._harness_selection):
            harness = _smoke_registry.HARNESSES.get(name)
            if harness is None:
                continue
            mode_obj = _find_mode(harness, self._harness_selection[name].mode)
            if mode_obj.provider is not None and mode_obj.provider != new_provider:
                del self._harness_selection[name]
        self._refresh_provider_badge()
        self._refresh_harness_options()

    def _refresh_target_badge(self) -> None:
        badge = self.query_one("#target-badge", Static)
        badge.update(f"target: {self.core.cfg.target}")
        badge.remove_class("target-dev", "target-other",
                           *(f"target-{name}" for name in _smoke_registry.TARGETS))
        badge.add_class(*self._target_classes().split())

    def _refresh_op_secrets_badge(self) -> None:
        badge = self.query_one("#op-secrets-badge", Static)
        badge.update(self._op_secrets_text())
        badge.remove_class("op-secrets-ok")
        badge.remove_class("op-secrets-missing")
        badge.add_class(self._op_secrets_class())
        badge.tooltip = self._op_secrets_tooltip()

    def action_rescan_env(self) -> None:
        self.core.rescan()  # re-reads self.environ AND config.toml (RunnerCore.rescan)
        self._refresh_identity_pane()  # freshly-seeded (UNPROBED) state, immediately
        self._refresh_harness_options()
        self._refresh_target_badge()    # config.toml may have changed either axis
        self._refresh_provider_badge()
        self._refresh_target_badge()  # config.toml's [defaults].target may have changed too
        self._refresh_op_secrets_badge()  # target may have changed which secret it asks for
        if self.core.probe is not None:
            self.run_worker(self._probe_and_render, thread=True, exclusive=True, group="probe", exit_on_error=False)

    def on_app_focus(self, event: object) -> None:
        # Settings, v1: config.toml can be hand-edited (or, now, edited via
        # the settings modal from a different session) while this one is
        # backgrounded — re-read it the same way 'e' does, the moment the
        # terminal reports focus back. A no-op cost if the terminal never
        # sends focus events at all (Textual simply never calls this).
        self.action_rescan_env()

    def _refresh_harness_options(self) -> None:
        sl = self.query_one("#harness-list", SelectionList)
        previously_selected = set(sl.selected)
        sl.clear_options()
        sl.add_options(self._harness_options())
        for value in previously_selected:
            try:
                sl.select(value)
            except Exception:
                pass

    def action_change_target(self) -> None:
        """Cycle to the next target in TARGETS order (a no-op with one)."""
        names = list(_smoke_registry.TARGETS)
        current = names.index(self.core.cfg.target) if self.core.cfg.target in names else -1
        new_target = names[(current + 1) % len(names)]
        self.core.cfg = dataclasses.replace(self.core.cfg, target=new_target)
        self._refresh_target_badge()
        self._refresh_op_secrets_badge()
        self._refresh_harness_options()

    def action_toggle_failures_only(self) -> None:
        self._failures_only = not self._failures_only
        self._apply_failures_only()

    def action_show_history(self) -> None:
        self.push_screen(HistoryScreen(self.core.state_dir))

    def action_show_login(self) -> None:
        cfg = self.core.cfg
        lines = []
        for slot in _all_config_slots(cfg):
            # microsoft.attendee never logs in — not a login-command target.
            if slot == "microsoft.attendee":
                continue
            status = self.core.identity_statuses.get(slot)
            needs_login = status is None or status.state in (
                _smoke_identity.IdentityState.ABSENT,
                _smoke_identity.IdentityState.STALE,
                _smoke_identity.IdentityState.WRONG_ACCOUNT,
            )
            if not needs_login:
                continue
            target_url = _target_url_for_slot(cfg, slot)
            try:
                lines.append(f"{slot}: {_smoke_identity.login_command(slot, cfg, target_url)}")
            except ValueError:
                continue
        self.notify("\n".join(lines) if lines else "every configured identity looks fine")

    def action_show_settings(self) -> None:
        def _on_result(new_cfg: "_smoke_identity.RunnerConfig | None") -> None:
            if new_cfg is None:
                return
            # Belt-and-braces (review round 2): SettingsModal.action_apply
            # already validates target/google_primary/microsoft_primary
            # before ever dismissing, so this should be unreachable in
            # practice — but a save_config ValueError must never propagate
            # out of a push_screen dismiss callback (that takes the whole
            # TUI down with a traceback, orphaning any running harness
            # child) regardless of how it got here.
            try:
                _smoke_identity.save_config(new_cfg, self.core.config_path)
            except ValueError as e:
                self.notify(f"settings not saved: {e}", severity="error")
                return
            self.core.rescan()  # reload + re-seed against what was just written
            self._refresh_identity_pane()
            self._refresh_harness_options()
            self._refresh_target_badge()
            self._refresh_provider_badge()
            self._refresh_op_secrets_badge()
        self.push_screen(SettingsModal(self.core.cfg), _on_result)

    def action_reset_env(self) -> None:
        def _on_result(result: QueuedRun | None) -> None:
            if result is None:
                return
            self.run_worker(self._enqueue_and_start(result), exclusive=False)
        self.push_screen(ResetEnvModal(self.core.cfg), _on_result)


if __name__ == "__main__":
    SmokeRunnerApp(RunnerCore()).run()
