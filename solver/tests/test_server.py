"""HTTP server tests using FastAPI TestClient."""

from __future__ import annotations

import json
import logging

from fastapi.testclient import TestClient

from solver.server import app

client = TestClient(app)


def _timing_events(caplog) -> list[dict]:
    """Parse every `solve_timing {json}` record captured by caplog."""
    prefix = "solve_timing "
    return [
        json.loads(rec.getMessage()[len(prefix):])
        for rec in caplog.records
        if rec.getMessage().startswith(prefix)
    ]


def test_healthz_returns_ok():
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_solve_returns_200_with_solution(load_fixture):
    body = load_fixture("single_task.json")
    r = client.post("/solve", json=body)
    assert r.status_code == 200
    payload = r.json()
    assert "schedule" in payload
    assert "dropped" in payload
    assert "objective" in payload
    assert "diagnostics" in payload
    assert len(payload["schedule"]) == 1


def test_solve_returns_422_for_infeasible(load_fixture):
    # Contention among DROPPABLE tasks no longer 422s (hardness ⊥ droppability →
    # tasks drop). 422 now arises from (a) two IMMOVABLE external events that
    # overlap (this fixture), or (b) over-subscribed must_include tasks that are
    # each feasible in isolation (see tests/test_must_include.py). unsat_core is
    # present though it may be empty when the conflict is between unconditional
    # intervals rather than relaxable assumptions.
    body = load_fixture("infeasible_external_overlap.json")
    r = client.post("/solve", json=body)
    assert r.status_code == 422
    payload = r.json()
    assert "unsat_core" in payload
    assert isinstance(payload["unsat_core"], list)


def test_solve_200_emits_timing_log_and_uptime_header(load_fixture, caplog):
    """A successful solve must emit a `solve_timing` log line carrying the total
    handler duration plus the two-pass split (pass1 candidate / pass2 optimality
    proof) and the CP-SAT status, and every response must carry an
    X-Solver-Uptime-Ms header so the worker can tell cold from warm containers.
    """
    with caplog.at_level(logging.INFO, logger="solver.server"):
        r = client.post("/solve", json=load_fixture("single_task.json"))
    assert r.status_code == 200
    uptime_ms = float(r.headers["x-solver-uptime-ms"])
    assert uptime_ms >= 0
    events = _timing_events(caplog)
    assert len(events) == 1
    evt = events[0]
    assert evt["outcome"] == "ok"
    assert evt["total_ms"] >= 0
    diag = r.json()["diagnostics"]
    assert evt["pass1_wall_seconds"] == diag["pass1_wall_seconds"]
    assert evt["pass2_wall_seconds"] == diag["pass2_wall_seconds"]
    assert evt["status"] == diag["status"]


def test_solve_422_emits_timing_log_with_unsat_outcome(load_fixture, caplog):
    """Unsat solves ran the solver too — timing must still be logged (there are
    no pass diagnostics on the unsat path, so only outcome + total)."""
    with caplog.at_level(logging.INFO, logger="solver.server"):
        r = client.post("/solve", json=load_fixture("infeasible_external_overlap.json"))
    assert r.status_code == 422
    assert float(r.headers["x-solver-uptime-ms"]) >= 0
    events = _timing_events(caplog)
    assert len(events) == 1
    assert events[0]["outcome"] == "unsat"
    assert events[0]["total_ms"] >= 0


def test_healthz_carries_uptime_header():
    """The header is stamped by middleware on every response, not just /solve."""
    r = client.get("/healthz")
    assert float(r.headers["x-solver-uptime-ms"]) >= 0


def test_solve_returns_400_for_malformed_json():
    r = client.post("/solve", json={"window": {"start": "not-a-date"}})
    assert r.status_code == 400
    payload = r.json()
    assert "error" in payload


def test_solve_returns_clean_400_for_non_aligned_duration(load_fixture):
    """A non-15-multiple duration is rejected by the schema. The 400 branch must
    return a JSON-serialisable body, not crash into an opaque 500. In Pydantic v2,
    ValidationError.errors() embeds the original ValueError in ctx, which plain
    json.dumps cannot serialise; jsonable_encoder stringifies it.
    """
    body = load_fixture("single_task.json")
    body["tasks"][0]["chunks"][0]["duration_minutes"] = 20
    r = client.post("/solve", json=body)
    assert r.status_code == 400
    payload = r.json()  # must not raise
    assert payload["error"] == "validation"
    assert "details" in payload


def test_solve_aligned_duration_still_solves(load_fixture):
    """The same problem with an aligned duration (30) still returns 200, proving
    the round number continues to solve.
    """
    body = load_fixture("single_task.json")
    body["tasks"][0]["chunks"][0]["duration_minutes"] = 30
    r = client.post("/solve", json=body)
    assert r.status_code == 200
    payload = r.json()
    assert "schedule" in payload
