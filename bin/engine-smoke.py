#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""Live smoke for the bespoke solver engine (`SOLVER_ENGINE`, runbook §P,
internal design notes card H). Any smoke env (`SMOKE_WRANGLER_ENV`,
default dev, picks the worker for the settings API and `wrangler tail`); either provider's
bearer — the resolve lands on whichever calendar the bearer belongs to.

RUNS IN THE OPERATOR'S SHELL. An agent session cannot run this: it needs the
persistent smoke credentials (A_BEARER/A_REFRESH) and a `CLOUDFLARE_API_TOKEN`
for `wrangler tail` / `wrangler d1`, both of which live only in the operator's
environment and are injected externally — never by this script:

    op run --env-file=.env -- uv run bin/engine-smoke.py --phase shadow \\
      > /tmp/engine-smoke-shadow.out 2>&1

ONE PHASE PER RUN, DETECTED FROM THE DEPLOYMENT. Each phase asserts the
observable consequences of one deployed `SOLVER_ENGINE` value, and flipping
that value means editing `worker/wrangler.toml` and redeploying — something
this script deliberately does NOT do (a smoke harness that redeploys the
environment it is measuring can't tell a real failure from its own deploy).
With no `--phase`, the script reads the deployed posture itself — the Workers
settings API (`GET /accounts/{id}/workers/scripts/{name}/settings`) lists
every plain-text var as a binding, `SOLVER_ENGINE` included — and runs the
matching phase (P0 line names what it found):

    # asserts whatever dev is deployed with (container/shadow/fallback/worker):
    op run --env-file=.env -- uv run bin/engine-smoke.py
    # (dev only) with SOLVER_ENGINE = "worker" (or a certifying "fallback")
    # AND SOLVER_ENGINE_FANOUT = "true" + SOLVER_ENGINE_FANOUT_MIN_CHUNKS = "1"
    # deployed — fanout is never inferred (it needs a crowded week, below):
    op run --env-file=.env -- uv run bin/engine-smoke.py --phase fanout

`--phase <p>` still pins a phase explicitly (the detection is then skipped
entirely — no API call); a pinned phase the deployment doesn't match fails
with that named as the first thing to check. Detection needs
`CLOUDFLARE_API_TOKEN` (the same token `wrangler tail`/`d1` already need)
and the account id (`CLOUDFLARE_ACCOUNT_ID`, default: the optical account).

WHAT EACH PHASE CHECKS
  container         D1: engine='container' with a real HTTP call behind it.
                    LOG: no engine line at all (the engine never ran).
  --phase shadow    D1: the resolve's `solver_calls` row has engine='container'
                        (shadow never changes who serves) with a real HTTP
                        call behind it (attempts + http_status non-NULL).
                    LOG: a `solver_shadow` line with sat_agree true and NO
                        `engine_error` field — the two soak criteria that can
                        be observed from a single resolve.
  --phase fallback  D1: engine='worker', status='OPTIMAL', attempts and
                        http_status NULL (the engine served; no HTTP hop).
                    LOG: NO `solver_fallback` and NO
                        `solver_engine_disagreement` line — the happy path.
  --phase worker    HTTP 200 (the plan lands) and D1 engine='worker'.
                    LOG: no `solver_engine_error` line.
  --phase fanout    D1: engine='worker' (the engine served). LOG: no
                        `engine_fanout_degraded`, no `solver_engine_error`,
                        and the one `engine_fanout {subsolves, batches,
                        wall_ms}` summary line — REQUIRED whatever the served
                        status says (OPTIMAL is not a root-certified signal:
                        the phase can certify after fanning out, and a root
                        shortcut can serve FEASIBLE). A run with no summary
                        line validated nothing and fails with the fix: seed a
                        week crowded enough to leave the root gap open. This
                        phase is what validates the two things no test can:
                        deploy-time acceptance of the self-referential
                        ENGINE_RPC binding, and the platform's real
                        same-worker invocation ceiling (runbook §P).
  every phase       LOG: no `solver_engine_unknown` line (that would mean the
                        deployed flag value is a typo and the worker fell back
                        to "container" — which would ALSO make the phase's own
                        assertions fail, confusingly, without this check).

MECHANICAL vs INSTRUCTED. The D1 assertions are unconditional and exact. The
log assertions need a live log stream: by default the script spawns its own
`npx wrangler tail --env dev --format json` around the resolve. Pass
`--tail-log <path>` to point it at a capture you started yourself, or
`--no-tail` to skip the log half entirely — a skipped check prints SKIP and is
never folded into a pass.

The tail correlates by TIME, not by id: `solver_shadow` and `solver_fallback`
carry no call_id (only `solver_engine_disagreement` does), so a line is
attributed to this run because it was captured inside this run's tail window.
Dev's own cron and webhook replans can therefore contribute lines. The script
prints every matched line so a surprising one is visible rather than silently
asserted over, and it asserts against the LAST `solver_shadow` line captured.

Requires:
  SCHEDULER_URL, A_BEARER, A_REFRESH, A_EXPECTED_EMAIL, D1_DATABASE_ID
Optional:
  A_CLIENT_ID (default "smoke-cli"), SMOKE_WRANGLER_ENV (default "dev"),
  CLOUDFLARE_API_TOKEN (needed by wrangler for both tail and d1 — normally
  already in the environment via `op run`)

Read-only against the account: it triggers one `POST /v1/resolve` over a blank
future week and never commits, so nothing reaches the calendar and there is
nothing to clean up. It does leave one `solver_calls` row per run (the point).
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "_smoke_lib", str(Path(__file__).resolve().parent / "_smoke_lib.py")
)
_smoke_lib = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _smoke_lib
_spec.loader.exec_module(_smoke_lib)
Identity = _smoke_lib.Identity
SchedulerClient = _smoke_lib.SchedulerClient
assert_dev_url = _smoke_lib.assert_dev_url
assert_dev_db = _smoke_lib.assert_dev_db
assert_env_consistent = _smoke_lib.assert_env_consistent
d1_for_db_id = _smoke_lib.d1_for_db_id
post_resolve = _smoke_lib.post_resolve
req = _smoke_lib.req
sql_str = _smoke_lib.sql_str

REPO_ROOT = Path(__file__).resolve().parent.parent

# Every engine log line name (resolve-internal.ts). Parsed out of the tail
# capture; runbook §P documents each shape.
ENGINE_EVENTS = (
    "solver_shadow",
    "solver_fallback",
    "solver_engine_disagreement",
    "solver_engine_unknown",
    "solver_engine_error",
    "engine_fanout",
    "engine_fanout_degraded",
    "engine_fanout_gate",
)

# With `--format json`, wrangler prints NOTHING on attach — both banners are
# gated on `format === "pretty"` (wrangler 4.92, cli.js) — so a quiet worker
# gives a silent tail forever and a banner regex can never fire. Readiness is
# therefore proven end-to-end instead: the capture actively probes the worker
# (a cheap GET /) until the first event RECORD lands in the log. The banner
# match is kept only as a fallback for a pretty-mode capture.
TAIL_READY_RE = re.compile(r"waiting for logs|Successfully created tail", re.I)
TAIL_READY_TIMEOUT_S = 45.0


def tail_attached(text: str) -> bool:
    """Whether a tail capture shows evidence of a live, delivering tail: a
    complete event record, or the pretty-mode banner. wrangler 4.92's json
    mode PRETTY-PRINTS each record across many lines, so this decodes from
    each '{' rather than per line — a bare '{' line is not a record, and an
    object still being flushed is not yet one either."""
    if TAIL_READY_RE.search(text):
        return True
    decoder = json.JSONDecoder()
    idx = text.find("{")
    while idx >= 0:
        try:
            obj, _end = decoder.raw_decode(text, idx)
        except ValueError:
            pass
        else:
            if isinstance(obj, dict):
                return True
        idx = text.find("{", idx + 1)
    return False


def wait_for_attach(
    *,
    read,
    probe,
    still_running,
    describe: str,
    timeout_s: float = TAIL_READY_TIMEOUT_S,
    sleep=time.sleep,
) -> None:
    """Block until `read()` shows an attached tail (`tail_attached`), firing
    `probe()` each pass to generate the event a silent json-mode tail needs.
    A probe failure is swallowed — the timeout is what surfaces a genuinely
    unreachable worker, with `describe` naming the capture file."""
    deadline = time.monotonic() + timeout_s
    while True:
        if not still_running():
            raise RuntimeError(f"wrangler tail exited early — {describe}")
        if tail_attached(read()):
            return
        if time.monotonic() >= deadline:
            raise RuntimeError(
                f"wrangler tail did not attach within {timeout_s:.0f}s — "
                f"{describe} (re-run with --no-tail to skip the log checks)"
            )
        if probe is not None:
            try:
                probe()
            except Exception:
                pass
        sleep(1.0)


def _trunc(obj) -> str:
    """Caps an interpolated body at 400 chars for failure messages — a 422
    resolve response can carry a full unsat core (the buffer-overflow failure
    mode bin/regression-smoke.py's docstring warns about)."""
    return repr(obj)[:400]


def js_iso(dt: datetime) -> str:
    """`new Date().toISOString()`'s exact format, which is what
    `solver_calls.at` holds — Python's own isoformat() writes "+00:00" where
    JS writes "Z", and these values are compared as TEXT in SQLite."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def next_blank_monday(today: date) -> date:
    """The first Monday at least 21 days out. Plain date math, not a live
    calendar check (as bin/config-smoke.py does): this harness only needs a
    week far enough from live traffic that the resolve is uneventful."""
    candidate = today + timedelta(days=21)
    candidate += timedelta(days=(7 - candidate.weekday()) % 7)
    return candidate


# =============================================================================
# Log capture
# =============================================================================

class TailCapture:
    """`npx wrangler tail --env <env> --format json`, spawned around the
    resolve and torn down afterwards.

    stdout+stderr go to a temp FILE, not a pipe: wrangler's own chatter can
    exceed the ~64KB OS pipe buffer and deadlock a reader that isn't draining
    it (the same trap bin/booking-smoke.py's force_scheduled_cron documents).
    Credential injection is external — this spawns wrangler directly and never
    wraps it in its own `op run`."""

    def __init__(self, wrangler_env: str):
        self._env = wrangler_env
        self._file = tempfile.NamedTemporaryFile(
            mode="w+", prefix="engine-smoke-tail-", suffix=".log", delete=False
        )
        self.path = Path(self._file.name)
        self._proc: subprocess.Popen | None = None

    def start(self, probe=None) -> None:
        """`probe` is a zero-arg callable that generates one worker event (a
        cheap GET /); required in practice for json-mode readiness — see
        `wait_for_attach`. Once an event record lands, the tail is proven
        attached AND delivering, so no extra settle is needed."""
        cmd = ["npx", "wrangler", "tail", "--env", self._env, "--format", "json"]
        self._proc = subprocess.Popen(
            cmd, cwd=str(REPO_ROOT / "worker"),
            stdin=subprocess.DEVNULL, stdout=self._file, stderr=subprocess.STDOUT, text=True,
        )
        try:
            wait_for_attach(
                read=lambda: self.path.read_text(errors="replace"),
                probe=probe,
                still_running=lambda: self._proc.poll() is None,
                describe=f"output: {self.path}",
            )
        except RuntimeError:
            self._file.flush()
            raise

    def stop(self) -> None:
        if self._proc is None:
            return
        self._proc.terminate()
        try:
            self._proc.wait(timeout=10.0)
        except subprocess.TimeoutExpired:
            self._proc.kill()
            self._proc.wait(timeout=10.0)
        self._file.flush()
        self._file.close()
        self._proc = None


def _strings_in(node) -> list[str]:
    """Every string inside a decoded tail record — the log message we want sits
    in logs[].message[], but wrangler's exact nesting has changed between
    majors, so walk rather than index."""
    if isinstance(node, str):
        return [node]
    if isinstance(node, list):
        return [s for item in node for s in _strings_in(item)]
    if isinstance(node, dict):
        return [s for value in node.values() for s in _strings_in(value)]
    return []


def _payload_after(text: str, start: int) -> dict | None:
    """The balanced-brace JSON object following `start`, decoded. The engine
    lines are `console.<level>(\"<name> <json>\")`, and a disagreement line
    nests a whole unsat core, so a non-greedy regex would truncate it."""
    open_at = text.find("{", start)
    if open_at < 0:
        return None
    depth, in_str, escaped = 0, False, False
    for i in range(open_at, len(text)):
        ch = text[i]
        if in_str:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[open_at:i + 1])
                except ValueError:
                    return None
    return None


def parse_events(path: Path) -> list[tuple[str, dict]]:
    """Every engine log line in a tail capture, in order, as (name, payload).

    Each tail record is one JSON line; the payload we want is a JSON object
    embedded in the message TEXT (worker/src/log.ts — the log pipeline drops
    structured console.* arguments, which is why the worker embeds rather than
    passes them). Lines that aren't JSON (wrangler's banner) are searched as
    raw text so a format change degrades to a weaker match rather than to
    silence."""
    found: list[tuple[str, dict]] = []
    for line in path.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        candidates: list[str]
        try:
            candidates = _strings_in(json.loads(line))
        except ValueError:
            candidates = [line]
        for text in candidates:
            for name in ENGINE_EVENTS:
                at = text.find(name)
                if at < 0:
                    continue
                # Word boundary: `engine_fanout` is a prefix of
                # `engine_fanout_degraded`, and a prefix match there would
                # fabricate a summary event out of a degrade line.
                end = at + len(name)
                if end < len(text) and (text[end].isalnum() or text[end] == "_"):
                    continue
                payload = _payload_after(text, end)
                if payload is not None:
                    found.append((name, payload))
    return found


def events_named(events: list[tuple[str, dict]], name: str) -> list[dict]:
    return [payload for n, payload in events if n == name]


# =============================================================================
# D1
# =============================================================================

# Read-after-write on a remote D1 through the external wrangler CLI is not
# instant (see the M7 offboard flake in runbook §D) — poll rather than assume.
D1_POLL_ATTEMPTS = 6
D1_POLL_INTERVAL_S = 5.0


def fetch_solver_call(d1, window_start: str, since: str) -> dict | None:
    """The newest `solver_calls` row for this resolve's window, if it has
    landed. Keyed on the exact `window_start` string the request sent (the
    worker stores it verbatim — resolve.ts passes `parsed.window_start`
    straight through) plus a lower bound on `at`, so a row from an earlier run
    over the same week can't be mistaken for this one."""
    rows = d1.query(
        "SELECT id, at, engine, status, attempts, http_status, round_trip_ms, "
        "pass1_ms, pass2_ms, n_tasks, n_chunks, n_external, n_dropped "
        f"FROM solver_calls WHERE window_start = {sql_str(window_start)} "
        f"AND at >= {sql_str(since)} ORDER BY at DESC LIMIT 1"
    )
    return rows[0] if rows else None


def await_solver_call(d1, window_start: str, since: str) -> dict:
    for attempt in range(1, D1_POLL_ATTEMPTS + 1):
        row = fetch_solver_call(d1, window_start, since)
        if row is not None:
            return row
        if attempt < D1_POLL_ATTEMPTS:
            time.sleep(D1_POLL_INTERVAL_S)
    raise AssertionError(
        f"no solver_calls row for window_start={window_start} at>={since} after "
        f"{D1_POLL_ATTEMPTS} attempts — the resolve returned but recorded nothing "
        f"(is migration 0039 applied to this env? an unmigrated D1 fails every "
        f"insert with `solver_calls insert failed`)"
    )


# =============================================================================
# Phases
# =============================================================================

def _flag_hint(phase: str) -> str:
    return (
        f'is scheduler-dev deployed with SOLVER_ENGINE = "{phase}"? '
        f"(worker/wrangler.toml [env.dev] vars, then `npx wrangler deploy --env dev`)"
    )


def check_unknown_mode(events: list[tuple[str, dict]] | None) -> None:
    """E0, every phase: the deployed SOLVER_ENGINE value is a recognised mode.

    A typo makes the worker fall back to "container", which would fail the
    phase's own assertions in a confusing way — this names the real cause. It
    announces its own SKIP under --no-tail for the same reason the phase
    checks do: a check that prints nothing reads as a check that passed."""
    if events is None:
        print("E0 SKIP — log assertions skipped (--no-tail); `solver_engine_unknown` was NOT checked")
        return
    unknown = events_named(events, "solver_engine_unknown")
    for line in unknown:
        print(f"  solver_engine_unknown {json.dumps(line, sort_keys=True)}")
    assert not unknown, (
        f"E0: solver_engine_unknown — the deployed SOLVER_ENGINE value is not a "
        f"recognised mode, so the worker fell back to \"container\": "
        f"{[u.get('value') for u in unknown]}"
    )
    print(f"E0 PASS — no solver_engine_unknown line ({len(events)} engine log line(s) captured)")


def check_shadow(row: dict, events: list[tuple[str, dict]] | None) -> None:
    assert row["engine"] == "container", (
        f"S1: shadow must not change who serves: expected engine='container', "
        f"got {_trunc(row)}"
    )
    assert row["attempts"] is not None and row["http_status"] is not None, (
        f"S1: a container-served row must record its HTTP call: {_trunc(row)}"
    )
    print(f"S1 PASS — solver_calls row served by the container (status={row['status']}, "
          f"attempts={row['attempts']}, http_status={row['http_status']})")

    if events is None:
        print("S2 SKIP — log assertions skipped (--no-tail); the `solver_shadow` line was NOT checked")
        return
    shadows = events_named(events, "solver_shadow")
    assert shadows, f"S2: no `solver_shadow` line captured for this resolve — {_flag_hint('shadow')}"
    for line in shadows:
        print(f"  solver_shadow {json.dumps(line, sort_keys=True)}")
    last = shadows[-1]
    assert "engine_error" not in last, (
        f"S2: the engine threw during the shadow solve (a swallowed exception — "
        f"the soak's hard stop): {_trunc(last)}"
    )
    assert last.get("sat_agree") is True, (
        f"S2: engine and container disagreed on plan-vs-422: {_trunc(last)}"
    )
    print(f"S2 PASS — solver_shadow sat_agree=true, no engine_error "
          f"(engine {last.get('engine_status')} {last.get('engine_wall_ms')}ms vs "
          f"container {last.get('container_status')} {last.get('container_wall_ms')}ms)")
    if last.get("status_agree") is not True:
        print(
            f"S2 NOTE — exact statuses differ ({last.get('engine_status')} vs "
            f"{last.get('container_status')}): legal, and exactly what the soak is "
            f"measuring, but not parity",
            file=sys.stderr,
        )
    if last.get("objective_agree") is False:
        print(
            f"S2 NOTE — objective totals differ ({last.get('engine_objective_total')} vs "
            f"{last.get('container_objective_total')}); gate this only where both "
            f"sides say OPTIMAL (runbook §P)",
            file=sys.stderr,
        )


def check_fallback(row: dict, events: list[tuple[str, dict]] | None) -> None:
    assert row["engine"] == "worker", (
        f"F1: the engine did not serve this resolve (engine={row['engine']!r}) — either it "
        f"failed to certify (a legal outcome: check the solver_fallback reason below) or "
        f"{_flag_hint('fallback')}; row: {_trunc(row)}"
    )
    assert row["status"] == "OPTIMAL", (
        f"F1: fallback mode may only serve a certified answer: {_trunc(row)}"
    )
    assert row["attempts"] is None and row["http_status"] is None, (
        f"F1: an engine-served row must have no HTTP call behind it "
        f"(attempts/http_status NULL): {_trunc(row)}"
    )
    print(f"F1 PASS — engine served, certified: engine='worker' status=OPTIMAL, "
          f"no HTTP call (round_trip_ms={row['round_trip_ms']} = engine wall)")

    if events is None:
        print("F2 SKIP — log assertions skipped (--no-tail); `solver_fallback` was NOT checked")
        return
    fallbacks = events_named(events, "solver_fallback")
    for line in fallbacks:
        print(f"  solver_fallback {json.dumps(line, sort_keys=True)}")
    assert not fallbacks, (
        f"F2: the happy path fires no solver_fallback line; got {len(fallbacks)} "
        f"(reasons: {[f.get('reason') for f in fallbacks]})"
    )
    disagreements = events_named(events, "solver_engine_disagreement")
    for line in disagreements:
        print(f"  solver_engine_disagreement {json.dumps(line, sort_keys=True)}")
    assert not disagreements, (
        "F2: solver_engine_disagreement — the two solvers reached contradictory "
        "verdicts, which falsifies the parity claim. STOP and investigate before "
        "promoting anything."
    )
    print("F2 PASS — no solver_fallback and no solver_engine_disagreement line")


def check_worker(row: dict, events: list[tuple[str, dict]] | None) -> None:
    assert row["engine"] == "worker", (
        f"W1: expected the engine to serve (engine='worker'), got {_trunc(row)} — {_flag_hint('worker')}"
    )
    print(f"W1 PASS — plan landed, served in-process: engine='worker' status={row['status']} "
          f"({row['n_tasks']} tasks / {row['n_chunks']} chunks, {row['round_trip_ms']}ms)")
    if row["status"] != "OPTIMAL":
        print(
            f"W1 NOTE — status {row['status']!r}, not OPTIMAL. Legal in worker mode "
            f"(it serves whatever the engine returns, certificate or not) but worth "
            f"knowing for a prod-shaped week — see runbook §P proof states.",
            file=sys.stderr,
        )
    if events is None:
        print("W2 SKIP — log assertions skipped (--no-tail); `solver_engine_error` was NOT checked")
        return
    errors = events_named(events, "solver_engine_error")
    for line in errors:
        print(f"  solver_engine_error {json.dumps(line, sort_keys=True)}")
    assert not errors, "W2: solver_engine_error — the engine threw; worker mode has no fallback"
    print("W2 PASS — no solver_engine_error line")


def check_fanout(row: dict, events: list[tuple[str, dict]] | None) -> None:
    """Card H: SOLVER_ENGINE_FANOUT="true" + SOLVER_ENGINE_FANOUT_MIN_CHUNKS="1"
    deployed on dev (dev only). Asserts a served engine plan, no degrade, and
    the one `engine_fanout {subsolves, batches, wall_ms}` summary line
    REGARDLESS of served status (final-review correction: OPTIMAL is not a
    root-certified signal — the phase can certify after fanning out, and a
    root shortcut can serve FEASIBLE, so a run with no line validated nothing
    and fails with seed-a-crowded-week guidance rather than passing)."""
    assert row["engine"] == "worker", (
        f"FN1: the engine did not serve this resolve (engine={row['engine']!r}) — is dev "
        f'deployed with SOLVER_ENGINE = "worker" (or "fallback" with a certifying week), '
        f'SOLVER_ENGINE_FANOUT = "true" and SOLVER_ENGINE_FANOUT_MIN_CHUNKS = "1"? '
        f"row: {_trunc(row)}"
    )
    print(f"FN1 PASS — engine-served plan (status={row['status']}, "
          f"{row['n_tasks']} tasks / {row['n_chunks']} chunks, {row['round_trip_ms']}ms)")

    if events is None:
        print("FN2 SKIP — log assertions skipped (--no-tail); engine_fanout lines NOT checked")
        return
    degraded = events_named(events, "engine_fanout_degraded")
    for line in degraded:
        print(f"  engine_fanout_degraded {json.dumps(line, sort_keys=True)}")
    assert not degraded, (
        f"FN2: fan-out degraded to sequential — the RPC path is broken on this "
        f"deployment (reason(s): {[d.get('reason') for d in degraded]}); "
        f"batches >= 1 means it engaged and fell over, 0 batches means the cap "
        f"refused up front"
    )
    errors = events_named(events, "solver_engine_error")
    assert not errors, f"FN2: solver_engine_error during the fan-out solve: {_trunc(errors[-1])}"
    print("FN2 PASS — no engine_fanout_degraded, no solver_engine_error")

    summaries = events_named(events, "engine_fanout")
    for line in summaries:
        print(f"  engine_fanout {json.dumps(line, sort_keys=True)}")
    # Served status is NOT a root-certified signal in either direction: the
    # phase can certify OPTIMAL after fanning out (deadline_soft-style, cost
    # reaches the root bound), and a root shortcut can serve FEASIBLE when
    # pass 1 is the uncertified half. So the contract is simply: this phase
    # exists to validate the RPC path, and a run where fan-out never engaged
    # has validated nothing — fail with the operational fix, whatever the
    # status says.
    assert summaries, (
        f"FN3: fan-out never engaged (status={row['status']!r}) — either the solve "
        "certified at the root before the improvement phase could run, or the "
        "flag/binding/threshold gate is not open on this deployment. If FN1/FN2 "
        "passed, re-run against a week crowded enough to leave the root gap open "
        "(seed more tasks) so the RPC path is actually exercised"
    )
    last = summaries[-1]
    assert isinstance(last.get("subsolves"), int) and last["subsolves"] >= 1, (
        f"FN3: engine_fanout line with no sub-solves: {_trunc(last)}"
    )
    assert isinstance(last.get("batches"), int) and last["batches"] >= 1, (
        f"FN3: engine_fanout line with no batches: {_trunc(last)}"
    )
    print(f"FN3 PASS — fan-out engaged: {last['subsolves']} sub-solve(s) in "
          f"{last['batches']} batch(es), wall {last.get('wall_ms')}ms")

    # This phase deploys SOLVER_ENGINE_FANOUT="true" on a worker-mode env —
    # exactly the configuration that emits the flag-gated eligibility line
    # (worker and fallback modes only; shadow and container never reach the
    # gate, runbook §P).
    gates = events_named(events, "engine_fanout_gate")
    for line in gates:
        print(f"  engine_fanout_gate {json.dumps(line, sort_keys=True)}")
    assert gates, (
        "FN4: no engine_fanout_gate line — the flag-gated eligibility line is "
        'emitted whenever SOLVER_ENGINE_FANOUT is "true" on a worker/fallback '
        "resolve, so its absence means the deployed flag or SOLVER_ENGINE mode "
        "is not what this phase assumes"
    )
    gate = gates[-1]
    assert gate.get("eligible") is True, (
        f"FN4: gate says ineligible — check binding_bound and chunk_count vs "
        f"min_chunks in the line itself: {_trunc(gate)}"
    )
    print(f"FN4 PASS — gate open (chunks {gate.get('chunk_count')} >= "
          f"min {gate.get('min_chunks')}, binding bound)")


def check_container(row: dict, events: list[tuple[str, dict]] | None) -> None:
    """Posture "container" (the flag absent or literally "container"): the
    engine is dark. Nothing engine-specific to prove, but the harness still
    pins the two things that would silently change if it weren't: who served
    (with an HTTP call behind it) and the absence of any engine line."""
    assert row["engine"] == "container", (
        f"C1: expected the container to serve (engine='container'), got {_trunc(row)} — "
        f"the deployed SOLVER_ENGINE says the engine is dark, yet something else answered"
    )
    assert row["attempts"] is not None and row["http_status"] is not None, (
        f"C1: a container-served row must record its HTTP call: {_trunc(row)}"
    )
    print(f"C1 PASS — container served (status={row['status']}, attempts={row['attempts']}, "
          f"http_status={row['http_status']})")
    if events is None:
        print("C2 SKIP — log assertions skipped (--no-tail); engine lines NOT checked")
        return
    engine_lines = [(n, p) for n, p in events if n != "solver_engine_unknown"]
    for name, line in engine_lines:
        print(f"  {name} {json.dumps(line, sort_keys=True)}")
    assert not engine_lines, (
        f"C2: engine log line(s) on a container-posture deployment "
        f"({sorted({n for n, _ in engine_lines})}) — e.g. a solver_shadow line means the "
        f"engine ran; is the settings API reading a different deployment than the one "
        f"SCHEDULER_URL points at?"
    )
    print("C2 PASS — no engine line captured")


PHASES = {
    "container": check_container,
    "shadow": check_shadow,
    "fallback": check_fallback,
    "worker": check_worker,
    "fanout": check_fanout,
}


# =============================================================================
# Posture detection — the deployed SOLVER_ENGINE, off the Workers settings API
# =============================================================================

# worker/wrangler.toml top-level `name`; wrangler names an env deployment
# `<name>-<env>` (e.g. weekly-scheduling-assistant-dev).
WORKER_NAME = _smoke_lib._PROD_WORKERS_DEV_LABEL
DEFAULT_ACCOUNT_ID = "REPLACE_WITH_YOUR_CLOUDFLARE_ACCOUNT_ID"  # same constant as bin/container-usage.py
# The runtime's own default when the var is unset (worker/src/env.ts).
DEFAULT_SOLVER_ENGINE = "container"
POSTURE_PHASES = ("container", "shadow", "fallback", "worker")


def script_name_for(wrangler_env: str) -> str:
    return f"{WORKER_NAME}-{wrangler_env}"


def _http_get_json(url: str, headers: dict[str, str]) -> tuple[int, dict]:
    import httpx
    r = httpx.get(url, headers=headers, timeout=30.0)
    try:
        body = r.json()
    except ValueError:
        body = {}
    return r.status_code, body if isinstance(body, dict) else {}


def fetch_deployed_vars(account_id: str, script_name: str, api_token: str, *, http_get=_http_get_json) -> dict[str, str]:
    """Every plain-text var on the deployed script, as {name: value}. Secrets
    come back as `secret_text` bindings WITHOUT a value and are dropped here
    (never printed, never needed). Fails closed on any API error — a posture
    that couldn't be read must not default to anything."""
    url = (
        f"https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts/"
        f"{script_name}/settings"
    )
    status, body = http_get(url, {"Authorization": f"Bearer {api_token}", "Accept": "application/json"})
    if status != 200 or not body.get("success"):
        errors = body.get("errors") or []
        messages = "; ".join(str(e.get("message", e)) for e in errors) if errors else f"HTTP {status}"
        raise RuntimeError(
            f"could not read the deployed settings for {script_name}: {messages} "
            f"(CLOUDFLARE_API_TOKEN needs Workers Scripts read; or pin --phase to skip detection)"
        )
    out: dict[str, str] = {}
    for b in (body.get("result") or {}).get("bindings") or []:
        if b.get("type") == "plain_text" and isinstance(b.get("name"), str) and isinstance(b.get("text"), str):
            out[b["name"]] = b["text"]
    return out


def phase_for_posture(deployed_vars: dict[str, str]) -> str:
    """The phase whose assertions match the deployed SOLVER_ENGINE (absent ->
    the runtime default "container"). An unrecognised value is the typo case
    E0 exists for — refuse rather than guess (the worker would fall back to
    "container" and the container phase would then pass, masking it)."""
    value = deployed_vars.get("SOLVER_ENGINE", DEFAULT_SOLVER_ENGINE)
    assert value in POSTURE_PHASES, (
        f"P0: deployed SOLVER_ENGINE={value!r} is not a recognised mode "
        f"({'/'.join(POSTURE_PHASES)}) — the worker falls back to \"container\" on a typo; "
        f"fix worker/wrangler.toml and redeploy"
    )
    return value


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)
    parser = argparse.ArgumentParser(
        description="Live smoke for SOLVER_ENGINE (runbook §P). One phase per run.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Without --phase the deployed SOLVER_ENGINE is read off the Workers "
            "settings API and its phase asserted; with it, the deployment must "
            "already match. This script never edits wrangler.toml and never deploys."
        ),
    )
    parser.add_argument(
        "--phase", choices=sorted(PHASES),
        help="pin the phase to assert (skips posture detection); default: read the "
             "deployed SOLVER_ENGINE off the Workers settings API and assert that phase "
             "(fanout is never inferred — pass it explicitly)",
    )
    parser.add_argument(
        "--account-id", default=os.environ.get("CLOUDFLARE_ACCOUNT_ID", DEFAULT_ACCOUNT_ID),
        help="Cloudflare account for posture detection (default: $CLOUDFLARE_ACCOUNT_ID or the optical account)",
    )
    parser.add_argument(
        "--tail-log", metavar="PATH",
        help="read log lines from an existing `wrangler tail --format json` capture "
             "instead of spawning one",
    )
    parser.add_argument(
        "--no-tail", action="store_true",
        help="skip every log assertion (D1 assertions still run, and each skipped "
             "check prints SKIP)",
    )
    parser.add_argument(
        "--settle-seconds", type=float, default=10.0,
        help="how long to keep tailing after the resolve returns, so the log "
             "pipeline can deliver (default: 10)",
    )
    parser.add_argument(
        "--wrangler-env", default=os.environ.get("SMOKE_WRANGLER_ENV", "dev"),
        help="wrangler env for tail/d1 (default: $SMOKE_WRANGLER_ENV or dev)",
    )
    parser.add_argument(
        "--monday", metavar="YYYY-MM-DD",
        help="resolve this week instead of the first Monday 21+ days out",
    )
    args = parser.parse_args()

    if args.tail_log and args.no_tail:
        parser.error("--tail-log and --no-tail are mutually exclusive")

    url = req("SCHEDULER_URL").rstrip("/")
    assert_dev_url(url)
    db_id = req("D1_DATABASE_ID")
    assert_dev_db(db_id)
    assert_env_consistent(url, db_id)
    ident = Identity(
        scheduler_url=url,
        bearer=req("A_BEARER"),
        refresh_token=req("A_REFRESH"),
        expected_email=req("A_EXPECTED_EMAIL"),
        client_id=os.environ.get("A_CLIENT_ID", "smoke-cli"),
    )
    sched = SchedulerClient(ident)
    d1 = d1_for_db_id(db_id, REPO_ROOT)

    phase = args.phase
    if phase is None:
        deployed = fetch_deployed_vars(
            args.account_id, script_name_for(args.wrangler_env), req("CLOUDFLARE_API_TOKEN"),
        )
        phase = phase_for_posture(deployed)
        fanout = deployed.get("SOLVER_ENGINE_FANOUT", "false")
        min_chunks = deployed.get("SOLVER_ENGINE_FANOUT_MIN_CHUNKS", "24")
        print(
            f"P0 PASS — deployed posture: SOLVER_ENGINE={deployed.get('SOLVER_ENGINE', DEFAULT_SOLVER_ENGINE)!r} "
            f"SOLVER_ENGINE_FANOUT={fanout!r} SOLVER_ENGINE_FANOUT_MIN_CHUNKS={min_chunks!r} "
            f"-> phase {phase}"
        )
        if fanout == "true" and phase in ("worker", "fallback"):
            print(
                "P0 NOTE — fan-out is deployed but never inferred: `--phase fanout` exercises "
                "the RPC path (needs a week crowded enough to leave the root gap open)",
                file=sys.stderr,
            )

    tail: TailCapture | None = None
    try:
        r = sched.request("GET", "/v1/whoami")
        r.raise_for_status()
        active = r.json()
        if active.get("email") != ident.expected_email:
            sys.exit(
                f"active account {active.get('email')!r} != A_EXPECTED_EMAIL "
                f"{ident.expected_email!r}; refusing to run"
            )
        print(f"phase: {phase} · active account: {active.get('email')} · env: {args.wrangler_env}")

        monday = date.fromisoformat(args.monday) if args.monday else next_blank_monday(
            datetime.now(timezone.utc).date()
        )
        window_start = f"{monday.isoformat()}T00:00"

        if args.tail_log:
            print(f"log source: {args.tail_log} (pre-captured)")
        elif args.no_tail:
            print("log source: none (--no-tail) — log assertions will be SKIPped, not passed")
        else:
            tail = TailCapture(args.wrangler_env)
            # The probe generates the event a silent json-mode tail needs
            # before it can be declared ready (GET / is the worker's health
            # route — unauthenticated, no side effects).
            tail.start(probe=lambda: sched.request("GET", "/"))
            print(f"log source: wrangler tail --env {args.wrangler_env} -> {tail.path}")

        # A minute of slack on the lower bound absorbs clock skew between this
        # machine and the edge; `window_start` is what actually identifies the
        # row, and nothing else resolves a week three weeks out.
        since = js_iso(datetime.now(timezone.utc) - timedelta(minutes=1))

        status, body = post_resolve(sched, monday)
        if status == 502:
            print(f"NOTE — first resolve attempt 502 (cold solver?): {_trunc(body)} — retrying once")
            status, body = post_resolve(sched, monday)
        assert status == 200, (
            f"R1: POST /v1/resolve (week of {monday}): expected 200, got {status} {_trunc(body)}"
            + (
                " — a 422 over a blank future week means the week is not actually blank "
                "(a live backlog competing for capacity: clear tasks/task_templates in "
                "dev D1, runbook §D) rather than an engine fault"
                if status == 422 else ""
            )
        )
        print(f"R1 PASS — POST /v1/resolve 200 for the week of {monday}")

        if tail is not None:
            time.sleep(args.settle_seconds)
            tail.stop()

        events: list[tuple[str, dict]] | None
        if args.no_tail:
            events = None
        else:
            events = parse_events(Path(args.tail_log) if args.tail_log else tail.path)

        check_unknown_mode(events)

        row = await_solver_call(d1, window_start, since)
        PHASES[phase](row, events)
        print("ALL PASS")

    finally:
        if tail is not None:
            tail.stop()
        sched.close()


if __name__ == "__main__":
    main()
