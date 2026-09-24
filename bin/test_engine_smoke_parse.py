# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx>=0.27"]
# ///
"""Guard for bin/engine-smoke.py's pure log-parsing logic — the part of that
harness that runs without a live env, and the part most likely to fail
silently (a parser that finds nothing looks exactly like a clean run until an
assertion asks for a line that was there all along).

Covers the engine log-line shapes runbook §P documents: the normal
`solver_shadow` line, its crash variant (`engine_error`, and NONE of the
agreement fields), `solver_fallback`, the nested unsat cores a
`solver_engine_disagreement` line carries — which is why the payload scan is
brace-balanced rather than a non-greedy regex — plus `at` formatting, which is
compared as TEXT in SQLite against JS's `toISOString()`.

Run: uv run bin/test_engine_smoke_parse.py
"""
from __future__ import annotations

import importlib.util
import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "engine_smoke", Path(__file__).parent / "engine-smoke.py"
)
assert _spec and _spec.loader, "could not load engine-smoke module"
engine_smoke = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = engine_smoke
_spec.loader.exec_module(engine_smoke)


def tail_record(message: str, level: str = "info", indent: int | None = None) -> str:
    """One `wrangler tail --format json` record, in the shape the worker's logs
    reach it: the payload is embedded in the message TEXT (worker/src/log.ts —
    the pipeline drops structured console.* arguments). `indent` mirrors what
    wrangler 4.92 actually emits — PRETTY-PRINTED multi-line records, one per
    event, not one JSON object per line."""
    return json.dumps({
        "outcome": "ok",
        "scriptName": "weekly-scheduling-assistant-dev",
        "logs": [{"level": level, "timestamp": 1_756_000_000_000, "message": [message]}],
        "eventTimestamp": 1_756_000_000_000,
    }, indent=indent)


SHADOW_OK = (
    'solver_shadow {"engine_status":"OPTIMAL","engine_objective_total":150,'
    '"container_status":"OPTIMAL","container_objective_total":150,'
    '"container_wall_ms":42,"engine_wall_ms":3,"status_agree":true,'
    '"sat_agree":true,"objective_agree":true}'
)
SHADOW_CRASH = (
    'solver_shadow {"container_status":"OPTIMAL","container_objective_total":150,'
    '"container_wall_ms":42,"engine_wall_ms":1,"engine_error":"Error: boom"}'
)
FALLBACK = (
    'solver_fallback {"reason":"engine_uncertified","engine_status":"FEASIBLE",'
    '"container_status":"OPTIMAL","engine_wall_ms":20001,"container_wall_ms":88}'
)
DISAGREEMENT = (
    'solver_engine_disagreement {"owner":"sub-1","window_start":"2026-09-14T00:00",'
    '"call_id":"abc","engine_status":"UNSAT","container_status":"OPTIMAL",'
    '"engine_unsat_core":{"unsat_core":[{"kind":"task_present","task_id":"t1"},'
    '{"kind":"must_include","task_id":"t2"}]}}'
)


def write_tail(tmp_path: Path, messages: list[str], name: str = "tail.log") -> Path:
    path = tmp_path / name
    path.write_text(
        "\n".join([
            " ⛅️ wrangler 4.0.0",
            "Successfully created tail, expires at 2026-08-25T00:00:00Z",
            "Connected to weekly-scheduling-assistant-dev, waiting for logs...",
            *[tail_record(m) for m in messages],
        ]) + "\n"
    )
    return path


# =============================================================================
# parse_events
# =============================================================================

def test_parses_a_normal_shadow_line(tmp_path):
    events = engine_smoke.parse_events(write_tail(tmp_path, [SHADOW_OK]))
    assert [name for name, _ in events] == ["solver_shadow"]
    payload = events[0][1]
    assert payload["sat_agree"] is True
    assert payload["engine_status"] == "OPTIMAL"
    assert "engine_error" not in payload


def test_parses_the_shadow_crash_variant(tmp_path):
    """The crash line carries engine_error and NONE of the agreement fields —
    "zero swallowed exceptions" is exactly "no line has engine_error"."""
    events = engine_smoke.parse_events(write_tail(tmp_path, [SHADOW_CRASH]))
    payload = engine_smoke.events_named(events, "solver_shadow")[0]
    assert payload["engine_error"] == "Error: boom"
    for absent in ("engine_status", "status_agree", "sat_agree", "objective_agree"):
        assert absent not in payload


def test_parses_nested_unsat_cores_whole(tmp_path):
    """A disagreement line nests a whole core: a non-greedy `\\{.*?\\}` scan
    would truncate at the first inner brace and decode nothing."""
    events = engine_smoke.parse_events(write_tail(tmp_path, [DISAGREEMENT]))
    payload = engine_smoke.events_named(events, "solver_engine_disagreement")[0]
    assert payload["call_id"] == "abc"
    assert len(payload["engine_unsat_core"]["unsat_core"]) == 2


def test_keeps_order_and_separates_names(tmp_path):
    events = engine_smoke.parse_events(write_tail(tmp_path, [SHADOW_OK, FALLBACK, SHADOW_CRASH]))
    assert [name for name, _ in events] == ["solver_shadow", "solver_fallback", "solver_shadow"]
    # The harness asserts against the LAST shadow line captured.
    assert "engine_error" in engine_smoke.events_named(events, "solver_shadow")[-1]
    assert engine_smoke.events_named(events, "solver_fallback")[0]["reason"] == "engine_uncertified"


def test_ignores_unrelated_lines(tmp_path):
    """Dev's stream is full of other events; none of them may be mistaken for
    an engine line, and the banner must not crash the parser."""
    path = write_tail(tmp_path, [
        'solver_diagnostics {"status":"OPTIMAL","engine":"container","round_trip_ms":42}',
        'solver_fetch {"attempt":1,"ms":40,"status":200}',
        "dbg_resolve_start plain text, no json at all",
    ])
    assert engine_smoke.parse_events(path) == []


def test_reads_a_raw_non_json_capture(tmp_path):
    """`--tail-log` may point at a pretty-format capture. The scan degrades to
    raw text rather than to silence."""
    path = tmp_path / "raw.log"
    path.write_text(f"GET /v1/resolve - Ok @ 24/08/2026\n  (log) {SHADOW_OK}\n")
    payload = engine_smoke.events_named(engine_smoke.parse_events(path), "solver_shadow")[0]
    assert payload["sat_agree"] is True


def test_unknown_mode_line(tmp_path):
    events = engine_smoke.parse_events(
        write_tail(tmp_path, ['solver_engine_unknown {"value":"shdow","using":"container"}'])
    )
    assert engine_smoke.events_named(events, "solver_engine_unknown")[0]["value"] == "shdow"


# =============================================================================
# js_iso / next_blank_monday
# =============================================================================

def test_js_iso_matches_javascript_toisostring(tmp_path):
    """solver_calls.at holds `new Date().toISOString()`; Python's isoformat()
    writes "+00:00" where JS writes "Z", and SQLite compares these as text."""
    dt = datetime(2026, 8, 24, 7, 5, 3, 123_456, tzinfo=timezone.utc)
    assert engine_smoke.js_iso(dt) == "2026-08-24T07:05:03.123Z"


def test_js_iso_normalises_to_utc():
    from datetime import timedelta as _td
    aware = datetime(2026, 8, 24, 17, 0, 0, tzinfo=timezone(_td(hours=10)))
    assert engine_smoke.js_iso(aware) == "2026-08-24T07:00:00.000Z"


@pytest.mark.parametrize("today", [date(2026, 8, 24), date(2026, 8, 30), date(2026, 9, 1)])
def test_next_blank_monday_is_a_monday_at_least_21_days_out(today):
    monday = engine_smoke.next_blank_monday(today)
    assert monday.weekday() == 0
    assert (monday - today).days >= 21


# =============================================================================
# phase checks over synthetic rows
# =============================================================================

def d1_row(**overrides) -> dict:
    row = {
        "id": "call-1", "at": "2026-08-24T07:00:00.000Z", "engine": "worker",
        "status": "OPTIMAL", "attempts": None, "http_status": None,
        "round_trip_ms": 3, "pass1_ms": 1, "pass2_ms": 2,
        "n_tasks": 2, "n_chunks": 3, "n_external": 20, "n_dropped": 0,
    }
    row.update(overrides)
    return row


def test_fallback_rejects_a_container_served_row():
    with pytest.raises(AssertionError, match="did not serve"):
        engine_smoke.check_fallback(d1_row(engine="container", attempts=1, http_status=200), [])


def test_fallback_rejects_an_uncertified_engine_row():
    with pytest.raises(AssertionError, match="certified"):
        engine_smoke.check_fallback(d1_row(status="FEASIBLE"), [])


def test_fallback_rejects_a_fallback_line_on_the_happy_path():
    events = [("solver_fallback", {"reason": "engine_uncertified"})]
    with pytest.raises(AssertionError, match="solver_fallback"):
        engine_smoke.check_fallback(d1_row(), events)


def test_fallback_happy_path_passes():
    engine_smoke.check_fallback(d1_row(), [])


def test_shadow_rejects_an_engine_served_row():
    with pytest.raises(AssertionError, match="engine='container'"):
        engine_smoke.check_shadow(d1_row(), [])


def test_shadow_rejects_a_swallowed_exception():
    row = d1_row(engine="container", attempts=1, http_status=200)
    events = [("solver_shadow", json.loads(SHADOW_CRASH.split(" ", 1)[1]))]
    with pytest.raises(AssertionError, match="swallowed exception"):
        engine_smoke.check_shadow(row, events)


def test_shadow_rejects_sat_disagreement():
    row = d1_row(engine="container", attempts=1, http_status=200)
    payload = json.loads(SHADOW_OK.split(" ", 1)[1])
    payload["sat_agree"] = False
    with pytest.raises(AssertionError, match="plan-vs-422"):
        engine_smoke.check_shadow(row, [("solver_shadow", payload)])


def test_shadow_requires_a_line_at_all():
    """No line is the flag-not-flipped case, and must fail rather than pass
    vacuously."""
    row = d1_row(engine="container", attempts=1, http_status=200)
    with pytest.raises(AssertionError, match="SOLVER_ENGINE"):
        engine_smoke.check_shadow(row, [])


def test_shadow_happy_path_passes():
    row = d1_row(engine="container", attempts=1, http_status=200)
    engine_smoke.check_shadow(row, [("solver_shadow", json.loads(SHADOW_OK.split(" ", 1)[1]))])


def test_no_tail_skips_log_checks_without_passing_them(capsys):
    """--no-tail must print SKIP, not silently satisfy the log half."""
    row = d1_row(engine="container", attempts=1, http_status=200)
    engine_smoke.check_shadow(row, None)
    assert "S2 SKIP" in capsys.readouterr().out


def test_every_log_check_announces_its_skip_under_no_tail(capsys):
    """All FOUR log checks, E0 included. A check that prints nothing at all
    reads as a pass to whoever scans the output — which is the single thing
    the SKIP convention exists to prevent."""
    engine_smoke.check_unknown_mode(None)
    engine_smoke.check_shadow(d1_row(engine="container", attempts=1, http_status=200), None)
    engine_smoke.check_fallback(d1_row(), None)
    engine_smoke.check_worker(d1_row(), None)
    out = capsys.readouterr().out
    for label in ("E0 SKIP", "S2 SKIP", "F2 SKIP", "W2 SKIP"):
        assert label in out, f"{label} missing from:\n{out}"


def test_unknown_mode_check_passes_on_a_clean_capture(capsys):
    engine_smoke.check_unknown_mode([("solver_shadow", {"sat_agree": True})])
    assert "E0 PASS" in capsys.readouterr().out


def test_unknown_mode_check_rejects_a_typo_flag():
    events = [("solver_engine_unknown", {"value": "shdow", "using": "container"})]
    with pytest.raises(AssertionError, match="shdow"):
        engine_smoke.check_unknown_mode(events)


def test_worker_phase_accepts_an_uncertified_status(capsys):
    """Worker mode serves whatever the engine returns — FEASIBLE is legal
    there, and is a NOTE, not a failure."""
    engine_smoke.check_worker(d1_row(status="FEASIBLE"), [])
    assert "W1 PASS" in capsys.readouterr().out


def test_worker_phase_rejects_an_engine_error_line():
    with pytest.raises(AssertionError, match="solver_engine_error"):
        engine_smoke.check_worker(d1_row(), [("solver_engine_error", {"error": "boom", "wall_ms": 1})])


#
# --- tail attach detection -------------------------------------------------
#
# wrangler `--format json` prints NOTHING on attach (both banners are gated
# on `format === "pretty"` in wrangler 4.92) — the only observable sign of a
# live tail is an actual event record arriving. Readiness therefore has to be
# proven end-to-end: probe the worker to generate an event, and call the tail
# attached when the first record lands in the capture.


def test_tail_attached_on_a_json_event_line():
    """The json-mode reality: no banner ever, only event records."""
    assert engine_smoke.tail_attached(tail_record("GET / 200") + "\n")


def test_tail_attached_on_a_pretty_printed_record():
    """wrangler 4.92's json mode emits each record pretty-printed across many
    lines — a per-line parse sees only a bare '{' and never fires."""
    assert engine_smoke.tail_attached(tail_record("GET / 200", indent=4) + "\n")


def test_tail_attached_false_on_an_incomplete_record():
    """A record still being written (tail mid-flush) is not yet evidence of a
    delivering tail."""
    assert not engine_smoke.tail_attached(tail_record("GET / 200", indent=4)[:40])


def test_parse_events_reads_pretty_printed_records(tmp_path):
    """The real 4.92 capture shape end-to-end: the solver_shadow payload is an
    ESCAPED string inside a multi-line record; a raw line-scan would try to
    json-parse the escaped text and find nothing."""
    p = tmp_path / "tail.log"
    p.write_text(
        tail_record("GET / 200", indent=4) + "\n"
        + tail_record(SHADOW_OK, indent=4) + "\n"
    )
    events = engine_smoke.parse_events(p)
    assert [n for n, _ in events] == ["solver_shadow"]
    assert events[0][1]["sat_agree"] is True


def test_parse_events_keeps_order_across_pretty_and_compact_records(tmp_path):
    p = tmp_path / "tail.log"
    p.write_text(
        tail_record(SHADOW_OK, indent=4) + "\n"
        + tail_record(FALLBACK) + "\n"
    )
    assert [n for n, _ in engine_smoke.parse_events(p)] == [
        "solver_shadow", "solver_fallback",
    ]


def test_tail_attached_on_the_pretty_banner():
    assert engine_smoke.tail_attached(
        "Successfully created tail, expires at 25/08/2026, 6:00:00 am\n"
    )


def test_tail_attached_false_on_silence_and_chatter():
    assert not engine_smoke.tail_attached("")
    assert not engine_smoke.tail_attached(
        "npm warn exec The following package was not found\n{not json\n"
    )


def test_wait_for_attach_probes_until_an_event_arrives():
    reads = ["", "", tail_record("GET / 200")]
    probes = []
    engine_smoke.wait_for_attach(
        read=lambda: reads[min(len(probes), len(reads) - 1)],
        probe=lambda: probes.append(1),
        still_running=lambda: True,
        describe="output: /tmp/x.log",
        sleep=lambda _s: None,
    )
    assert len(probes) >= 1


def test_wait_for_attach_survives_a_failing_probe():
    reads = iter(["", tail_record("GET / 200"), tail_record("GET / 200")])

    def bad_probe():
        raise OSError("transient network blip")

    engine_smoke.wait_for_attach(
        read=lambda: next(reads),
        probe=bad_probe,
        still_running=lambda: True,
        describe="output: /tmp/x.log",
        sleep=lambda _s: None,
    )


def test_wait_for_attach_times_out_with_the_no_tail_hint():
    with pytest.raises(RuntimeError, match=r"--no-tail"):
        engine_smoke.wait_for_attach(
            read=lambda: "",
            probe=lambda: None,
            still_running=lambda: True,
            describe="output: /tmp/x.log",
            timeout_s=0.0,
            sleep=lambda _s: None,
        )


def test_wait_for_attach_reports_an_early_exit():
    with pytest.raises(RuntimeError, match=r"exited early"):
        engine_smoke.wait_for_attach(
            read=lambda: "",
            probe=lambda: None,
            still_running=lambda: False,
            describe="output: /tmp/x.log",
            sleep=lambda _s: None,
        )


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))


# ---------------------------------------------------------------------------
# Card H — fan-out phase (engine_fanout / engine_fanout_degraded)
# ---------------------------------------------------------------------------


def test_parse_events_separates_fanout_from_its_degraded_sibling(tmp_path):
    """`engine_fanout` is a PREFIX of `engine_fanout_degraded`: a degraded
    line must parse as exactly one degraded event, never additionally as a
    plain engine_fanout event (the smoke's no-degrade assertion depends on
    the distinction, and so does the summary-line assertion)."""
    log = tmp_path / "tail.log"
    log.write_text(
        tail_record('engine_fanout_degraded {"reason":"rpc_error","subsolves":2,"batches":1}')
        + "\n"
        + tail_record('engine_fanout {"subsolves":5,"batches":1,"wall_ms":42}')
        + "\n"
    )
    events = engine_smoke.parse_events(log)
    assert [n for n, _ in events] == ["engine_fanout_degraded", "engine_fanout"]
    assert engine_smoke.events_named(events, "engine_fanout") == [
        {"subsolves": 5, "batches": 1, "wall_ms": 42}
    ]


def _row(status="FEASIBLE", engine="worker"):
    return {
        "engine": engine,
        "status": status,
        "n_tasks": 3,
        "n_chunks": 5,
        "round_trip_ms": 120,
        "attempts": None,
        "http_status": None,
    }


def _ev(name, payload):
    return [(name, payload)]


def test_check_fanout_passes_on_a_fanned_out_uncertified_solve():
    # A flag-true worker-mode deployment always emits the gate line too (FN4).
    events = [_gate()] + _ev(
        "engine_fanout", {"subsolves": 4, "batches": 1, "wall_ms": 10}
    )
    engine_smoke.check_fanout(_row(status="FEASIBLE"), events)


def test_check_fanout_requires_the_summary_line_when_uncertified():
    with pytest.raises(AssertionError, match="never engaged"):
        engine_smoke.check_fanout(_row(status="FEASIBLE"), [])


def test_check_fanout_accepts_a_phase_certified_optimal_with_the_line():
    # OPTIMAL does NOT mean root-certified: the phase can certify by reaching
    # the root bound (deadline_soft-style), in which case fan-out DID run and
    # the summary line is present and welcome (code-review finding: the old
    # check false-failed exactly this healthy run).
    events = [_gate()] + _ev(
        "engine_fanout", {"subsolves": 3, "batches": 1, "wall_ms": 7}
    )
    engine_smoke.check_fanout(_row(status="OPTIMAL"), events)


def test_check_fanout_fails_without_the_line_regardless_of_status():
    # No summary line means the deploy gate validated NOTHING (the RPC path
    # never fired) — whatever the status says. The failure names the fix:
    # exercise a week crowded enough to engage the phase.
    with pytest.raises(AssertionError, match="never engaged"):
        engine_smoke.check_fanout(_row(status="OPTIMAL"), [])


def test_check_fanout_fails_on_a_degraded_session():
    events = _ev(
        "engine_fanout_degraded", {"reason": "rpc_error", "subsolves": 0, "batches": 1}
    )
    with pytest.raises(AssertionError, match="degraded"):
        engine_smoke.check_fanout(_row(status="FEASIBLE"), events)


def test_check_fanout_fails_when_the_engine_did_not_serve():
    with pytest.raises(AssertionError, match="engine"):
        engine_smoke.check_fanout(_row(engine="container"), [])


# ---------------------------------------------------------------------------
# Engine-findings fix pass card F — the flag-gated eligibility line
# (engine_fanout_gate; worker and fallback modes only, runbook §P)
# ---------------------------------------------------------------------------


def _gate(eligible=True):
    return (
        "engine_fanout_gate",
        {
            "call_id": "call-1",
            "eligible": eligible,
            "chunk_count": 5,
            "min_chunks": 1,
            "binding_bound": True,
        },
    )


def test_parse_events_captures_the_gate_line_as_its_own_event(tmp_path):
    """`engine_fanout` is also a PREFIX of `engine_fanout_gate`: the gate line
    must parse as exactly one gate event, never additionally as a summary
    event (FN3 would otherwise pass on a resolve that never fanned out)."""
    log = tmp_path / "tail.log"
    log.write_text(
        tail_record(
            'engine_fanout_gate {"call_id":"c1","eligible":true,'
            '"chunk_count":7,"min_chunks":1,"binding_bound":true}'
        )
        + "\n"
        + tail_record('engine_fanout {"subsolves":5,"batches":1,"wall_ms":42}')
        + "\n"
    )
    events = engine_smoke.parse_events(log)
    assert [n for n, _ in events] == ["engine_fanout_gate", "engine_fanout"]
    assert engine_smoke.events_named(events, "engine_fanout_gate") == [
        {
            "call_id": "c1",
            "eligible": True,
            "chunk_count": 7,
            "min_chunks": 1,
            "binding_bound": True,
        }
    ]


def test_check_fanout_requires_the_gate_line():
    # The fanout phase deploys SOLVER_ENGINE_FANOUT="true", exactly the
    # configuration that emits the gate line — its absence means the flag (or
    # the mode) is not what the phase assumes.
    events = _ev("engine_fanout", {"subsolves": 4, "batches": 1, "wall_ms": 10})
    with pytest.raises(AssertionError, match="FN4"):
        engine_smoke.check_fanout(_row(status="FEASIBLE"), events)


def test_check_fanout_fails_on_an_ineligible_gate():
    events = [_gate(eligible=False)] + _ev(
        "engine_fanout", {"subsolves": 4, "batches": 1, "wall_ms": 10}
    )
    with pytest.raises(AssertionError, match="FN4"):
        engine_smoke.check_fanout(_row(status="FEASIBLE"), events)


# =============================================================================
# 2026-09-02: posture detection. The deployed SOLVER_ENGINE value IS readable
# — the Workers settings API lists plain_text vars as bindings — so the
# harness derives the phase from the deployment instead of being told one.
# =============================================================================

def test_script_name_for_env_follows_wrangler_naming():
    assert engine_smoke.script_name_for("dev") == "weekly-scheduling-assistant-dev"


def test_fetch_deployed_vars_reads_plain_text_bindings_only():
    captured = {}

    def fake_get(url, headers):
        captured["url"] = url
        captured["headers"] = headers
        return 200, {"success": True, "errors": [], "result": {"bindings": [
            {"type": "plain_text", "name": "SOLVER_ENGINE", "text": "fallback"},
            {"type": "plain_text", "name": "SOLVER_ENGINE_FANOUT", "text": "true"},
            {"type": "secret_text", "name": "HMAC_KEY"},
            {"type": "d1", "name": "DB", "id": "x"},
        ]}}

    vars_ = engine_smoke.fetch_deployed_vars("acct123", "weekly-scheduling-assistant-dev", "cf-tok", http_get=fake_get)
    assert vars_ == {"SOLVER_ENGINE": "fallback", "SOLVER_ENGINE_FANOUT": "true"}
    assert captured["url"] == (
        "https://api.cloudflare.com/client/v4/accounts/acct123/workers/scripts/"
        "weekly-scheduling-assistant-dev/settings"
    )
    assert captured["headers"]["Authorization"] == "Bearer cf-tok"


def test_fetch_deployed_vars_fails_closed_on_an_api_error():
    def fake_get(url, headers):
        return 403, {"success": False, "errors": [{"code": 10000, "message": "Authentication error"}]}

    with pytest.raises(RuntimeError, match="Authentication error"):
        engine_smoke.fetch_deployed_vars("acct", "script", "tok", http_get=fake_get)


@pytest.mark.parametrize("value,phase", [
    ("shadow", "shadow"), ("fallback", "fallback"), ("worker", "worker"),
    ("container", "container"), (None, "container"),
])
def test_phase_for_posture_maps_the_deployed_flag(value, phase):
    vars_ = {} if value is None else {"SOLVER_ENGINE": value}
    assert engine_smoke.phase_for_posture(vars_) == phase


def test_phase_for_posture_rejects_an_unrecognised_flag_value():
    with pytest.raises(AssertionError, match="not a recognised"):
        engine_smoke.phase_for_posture({"SOLVER_ENGINE": "fallbak"})


def test_container_phase_requires_a_container_served_row_and_no_engine_lines():
    engine_smoke.check_container(d1_row(engine="container", attempts=1, http_status=200), [])
    with pytest.raises(AssertionError, match="engine='container'"):
        engine_smoke.check_container(d1_row(), [])
    with pytest.raises(AssertionError, match="solver_shadow"):
        engine_smoke.check_container(
            d1_row(engine="container", attempts=1, http_status=200),
            [("solver_shadow", {"sat_agree": True})],
        )


def test_container_phase_skips_the_log_half_under_no_tail(capsys):
    engine_smoke.check_container(d1_row(engine="container", attempts=1, http_status=200), None)
    assert "SKIP" in capsys.readouterr().out


def test_every_phase_has_a_check_including_container():
    assert set(engine_smoke.PHASES) == {"container", "shadow", "fallback", "worker", "fanout"}
