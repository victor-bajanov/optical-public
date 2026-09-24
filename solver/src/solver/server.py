"""FastAPI HTTP shell around the solver.

Single endpoint: POST /solve
- 200 + Solution JSON on success
- 422 + {unsat_core: [...]} on hard infeasibility
- 400 + {error: ...} on malformed input
"""

from __future__ import annotations

import json
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from solver.schema import Problem
from solver.two_pass import solve

# Configure the root logger so INFO records from this module reach stdout. Without
# this, Python's last-resort handler only emits WARNING+, so startup/shutdown
# markers would be invisible. uvicorn's own loggers set propagate=False, so this
# does not double-log access lines. Cloudflare Containers forward stdout/stderr to
# Workers Logs when the worker has `[observability] enabled = true` (it does), so
# these lines show up in the dashboard log stream and `wrangler tail`.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("solver.server")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # A clean "ready" on boot and "shutting down" on stop let an operator tell a
    # graceful sleepAfter/SIGTERM stop (shutdown logged) apart from a hard VM kill
    # — OOM/segfault/platform — which leaves no shutdown line at all.
    log.info("solver server ready (port 8080)")
    yield
    log.info("solver server shutting down")


app = FastAPI(title="solver", version="0.1.0", lifespan=lifespan)

# Process boot reference for the X-Solver-Uptime-Ms header. Module import runs
# once per container process, so a small value at request receipt means the
# request paid a cold start; the worker logs it (solver_fetch line) so cold and
# warm solve latencies can be separated in Workers Observability.
_BOOT_MONOTONIC = time.monotonic()


@app.middleware("http")
async def stamp_uptime(request: Request, call_next):
    # Sampled at receipt (not response) so a long solve does not inflate the
    # cold/warm signal. Stamped on every response, including 4xx/5xx.
    uptime_ms = (time.monotonic() - _BOOT_MONOTONIC) * 1000.0
    response = await call_next(request)
    response.headers["X-Solver-Uptime-Ms"] = f"{uptime_ms:.0f}"
    return response


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


@app.post("/solve")
async def solve_endpoint(request: Request) -> JSONResponse:
    t0 = time.perf_counter()
    try:
        body = await request.json()
    except Exception as exc:  # malformed body
        return JSONResponse(status_code=400, content={"error": f"invalid JSON: {exc}"})

    try:
        problem = Problem.model_validate(body)
    except ValidationError as exc:
        # Pydantic v2 embeds the original ValueError in each error's "ctx", which
        # plain json.dumps cannot serialise (TypeError -> opaque 500). Route the
        # errors through jsonable_encoder so the ValueError is stringified and the
        # rejection returns a clean 400.
        return JSONResponse(
            status_code=400,
            content={"error": "validation", "details": jsonable_encoder(exc.errors())},
        )

    try:
        result = solve(problem)
    except Exception as exc:
        log.exception("solver crashed")
        return JSONResponse(status_code=500, content={"error": f"solver: {exc}"})

    # `solve_timing` is the permanent per-request timing event (JSON embedded in
    # the message text — the log pipeline drops structured arguments, see
    # worker/src/log.ts). pass1 = candidate search, pass2 = optimality proof;
    # status FEASIBLE (vs OPTIMAL) means pass 2 was abandoned by the stall/time
    # limit. The unsat path has no pass diagnostics, only the total.
    total_ms = round((time.perf_counter() - t0) * 1000.0, 1)
    if result.unsat_core is not None:
        log.info("solve_timing " + json.dumps({"outcome": "unsat", "total_ms": total_ms}))
        return JSONResponse(
            status_code=422,
            content={"unsat_core": [item.model_dump() for item in result.unsat_core]},
        )
    assert result.solution is not None
    diag = result.solution.diagnostics
    log.info(
        "solve_timing "
        + json.dumps(
            {
                "outcome": "ok",
                "total_ms": total_ms,
                "pass1_wall_seconds": diag.pass1_wall_seconds,
                "pass2_wall_seconds": diag.pass2_wall_seconds,
                "status": diag.status,
            }
        )
    )
    return JSONResponse(status_code=200, content=result.solution.model_dump(mode="json"))
