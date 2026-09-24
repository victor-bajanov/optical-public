#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""Live smoke for per-user cost-curve & weights customisation
(internal design notes). Runs against dev or ms with
either provider's bearer — the resolve lands on whichever calendar the
bearer belongs to; nothing here is provider-specific.

Exercises the full GET/PATCH/DELETE contract for `/v1/contexts` and
`/v1/weights` end to end against a deployed dev environment, structured like
bin/booking-smoke.py / bin/poll-smoke.py: PEP 723 + uv, _smoke_lib's bearer
client, secrets injected externally (never `op` inside this script):

    op run --env-file=.env -- uv run bin/config-smoke.py > /tmp/config-smoke.out 2>&1

Flow (Card E of the plan):
  C1  GET /v1/contexts baseline — 5 contexts, all source:"default".
  C2  GET /v1/weights baseline — source:"default".
  C3  PATCH /v1/contexts/deep with an extreme (but valid) fit_curve + caps.
  C4  PATCH /v1/weights with an extreme churn_per_15min_moved value.
  C5  GET /v1/contexts — deep flips to source:"custom" with the merged
      values; the other four contexts stay source:"default".
  C6  GET /v1/weights — source:"custom", churn matches, the other five
      weights are untouched defaults.
  C7  POST /v1/resolve over a blank near-future week — proves the solver
      accepts the customised contexts/weights payload live (round-trip
      only; no placement assertions). A 422 (unsat) is also treated as a
      pass — see post_resolve's call site for why.
  N1  Negative probe: a fractional weight PATCH -> 400 validation_failed
      (the solver types every weight int = Field(ge=0); pins the
      poisoning defence live, not just in worker/test/handlers/weights.test.ts).
  N2  Negative probe: a bad fit_curve ordering PATCH (peak_end < peak_start)
      -> 400 invalid_fit_curve.
  C8  DELETE every context row + DELETE /v1/weights.
  C9  GET both again — back to source:"default".

Validation values are integers throughout (worker/src/handlers/contexts.ts,
worker/src/handlers/weights.ts): weights/penalties are non-negative INTEGERS
— the solver types every weight/penalty `int = Field(ge=0)`, so `12.5` 400s
but `12` (or `12.0` from a JSON client, which decodes to the int 12) is fine.
This corrects the plan doc's original "number >= 0" wording (fixed
2026-08-18 after a Card C review blocker).

CLEANUP ALWAYS RUNS, BUT IS BEST-EFFORT: DELETE of every context row and
DELETE /v1/weights run in a `finally` block so a failed assertion mid-run
still triggers a reset attempt, and every individual DELETE is itself
exception-guarded (a transport failure during cleanup must not replace an
in-flight AssertionError from the main flow — see reset_config). Both
endpoints are idempotent (a DELETE on an already-default row is still 200).
The run ALSO resets at startup (in case a previous run crashed before
reaching its own cleanup, or a human customised something by hand /
dev-ui), covering all five contexts, not just the one this harness writes —
so a residual "admin" or "meeting" customisation from outside this harness
can't fail C1's all-default baseline assertion.

Requires:
  SCHEDULER_URL, A_BEARER, A_REFRESH, A_EXPECTED_EMAIL
Optional:
  A_CLIENT_ID (default "smoke-cli")

No D1 access is used or required: unlike bin/booking-smoke.py / bin/poll-
smoke.py, both resources this harness touches have real DELETE endpoints, so
cleanup never needs a direct database write.
"""

from __future__ import annotations

import importlib.util
import os
import sys
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
req = _smoke_lib.req
_safe_json = _smoke_lib.safe_json_body

# The 5 known contexts (worker/src/db/context-config.ts KNOWN_CONTEXTS).
# Hardcoded here rather than imported: this is a standalone Python script
# with no access to the worker's TS module graph.
CONTEXTS_TO_RESET = ("deep", "admin", "physical", "family", "meeting")

# The extreme-but-valid test fixtures. Values are deliberately far from the
# migration-seeded defaults (deep: 12:00-16:00-17:00 / 240 / 90 / 25 / 25;
# churn_per_15min_moved: 10 — see worker/test/handlers/contexts.test.ts and
# weights.test.ts) so a merge bug (e.g. reading the wrong owner's row, or the
# wholesale-fallback regression the plan's Card A guards against) can't hide
# behind a coincidental match.
EXTREME_DEEP_CURVE = {"peak_start": "00:00", "peak_end": "00:15", "falloff_end": "23:45"}
EXTREME_DEEP_CAPS = {
    "max_minutes_per_day": 480,
    "max_contiguous_minutes": 480,
    "over_daily_cap_penalty_per_15min": 999,
    "over_streak_cap_penalty_per_15min": 999,
}
EXTREME_CHURN = 777

def _trunc(obj) -> str:
    """Caps an interpolated response body/payload at 400 chars for failure
    messages. A 422 resolve response can carry a full unsat core — the exact
    "overflow terminal/pipe buffers" failure mode bin/regression-smoke.py's
    module docstring warns about — and this harness's own output is meant to
    stay modest (redirected to a file, per house convention)."""
    return repr(obj)[:400]


def get_contexts(sched: SchedulerClient) -> tuple[int, dict]:
    r = sched.request("GET", "/v1/contexts")
    return r.status_code, _safe_json(r)


def patch_context(sched: SchedulerClient, context: str, body: dict) -> tuple[int, dict]:
    r = sched.request("PATCH", f"/v1/contexts/{context}", json=body)
    return r.status_code, _safe_json(r)


def delete_context(sched: SchedulerClient, context: str) -> tuple[int, dict]:
    r = sched.request("DELETE", f"/v1/contexts/{context}")
    return r.status_code, _safe_json(r)


def get_weights(sched: SchedulerClient) -> tuple[int, dict]:
    r = sched.request("GET", "/v1/weights")
    return r.status_code, _safe_json(r)


def patch_weights(sched: SchedulerClient, body: dict) -> tuple[int, dict]:
    r = sched.request("PATCH", "/v1/weights", json=body)
    return r.status_code, _safe_json(r)


def delete_weights(sched: SchedulerClient) -> tuple[int, dict]:
    r = sched.request("DELETE", "/v1/weights")
    return r.status_code, _safe_json(r)


def post_resolve(sched: SchedulerClient, monday: date) -> tuple[int, dict]:
    body = {
        "window_start": f"{monday.isoformat()}T00:00",
        "window_end": f"{(monday + timedelta(days=7)).isoformat()}T00:00",
    }
    r = sched.request("POST", "/v1/resolve", json=body)
    return r.status_code, _safe_json(r)

def next_blank_monday(today: date) -> date:
    """The first Monday at least 21 days out from `today`. This is plain
    date math, NOT a live-calendar blank-week check like
    bin/regression-smoke.py's find_blank_monday — C7 only needs a week the
    resolve can run over without colliding with anything, and this harness
    never writes to the calendar itself, so a generous fixed offset clear
    of the current week's live traffic is enough."""
    candidate = today + timedelta(days=21)
    candidate += timedelta(days=(7 - candidate.weekday()) % 7)
    return candidate


def deep_context_entry(contexts: list[dict]) -> dict:
    entry = next((c for c in contexts if c.get("context") == "deep"), None)
    if entry is None:
        raise AssertionError(f"no 'deep' entry in contexts response: {_trunc(contexts)}")
    return entry


def reset_config(sched: SchedulerClient, label: str) -> bool:
    """Idempotent DELETE of every context row + the weights row. Used both at
    startup (clean up residue from a previous crashed run, or from hand-
    testing / the dev-ui touching a context this harness doesn't otherwise
    write) and in the `finally` cleanup block.

    Never raises: a transport-level failure here must not replace an
    in-flight AssertionError from the caller's main flow, so every DELETE is
    individually exception-guarded and reported as a warning rather than
    propagated. Returns True iff every DELETE both completed and returned
    200 — callers use this to decide whether it's honest to report cleanup
    as fully successful."""
    ok = True
    for context in CONTEXTS_TO_RESET:
        try:
            status, body = delete_context(sched, context)
        except Exception as e:
            print(f"{label}: WARNING — DELETE /v1/contexts/{context} raised {e!r}", file=sys.stderr)
            ok = False
            continue
        if status != 200:
            print(
                f"{label}: WARNING — DELETE /v1/contexts/{context} returned {status} {_trunc(body)}",
                file=sys.stderr,
            )
            ok = False
    try:
        status, body = delete_weights(sched)
    except Exception as e:
        print(f"{label}: WARNING — DELETE /v1/weights raised {e!r}", file=sys.stderr)
        ok = False
    else:
        if status != 200:
            print(f"{label}: WARNING — DELETE /v1/weights returned {status} {_trunc(body)}", file=sys.stderr)
            ok = False
    return ok


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)
    url = req("SCHEDULER_URL").rstrip("/")
    assert_dev_url(url)
    ident = Identity(
        scheduler_url=url,
        bearer=req("A_BEARER"),
        refresh_token=req("A_REFRESH"),
        expected_email=req("A_EXPECTED_EMAIL"),
        client_id=os.environ.get("A_CLIENT_ID", "smoke-cli"),
    )
    sched = SchedulerClient(ident)

    try:
        r = sched.request("GET", "/v1/whoami")
        r.raise_for_status()
        active = r.json()
        if active.get("email") != ident.expected_email:
            sys.exit(
                f"active account {active.get('email')!r} != A_EXPECTED_EMAIL "
                f"{ident.expected_email!r}; refusing to run"
            )
        print(f"active account: {active.get('email')}")

        # Startup reset: clear any residue from a previous crashed run (or
        # hand-testing / the dev-ui) before baselining anything below.
        reset_config(sched, "STARTUP")

        try:
            # C1 — baseline contexts: 5 entries, all default.
            status, body = get_contexts(sched)
            assert status == 200, f"C1: GET /v1/contexts: {status} {_trunc(body)}"
            contexts = body.get("contexts", [])
            assert len(contexts) == 5, f"C1: expected 5 contexts, got {len(contexts)}: {_trunc(contexts)}"
            non_default = [c["context"] for c in contexts if c.get("source") != "default"]
            assert not non_default, f"C1: expected all-default baseline, custom: {non_default!r}"
            print(f"C1 PASS — 5 contexts, all source:default ({[c['context'] for c in contexts]})")

            # C2 — baseline weights: default.
            status, body = get_weights(sched)
            assert status == 200, f"C2: GET /v1/weights: {status} {_trunc(body)}"
            assert body.get("source") == "default", f"C2: expected source:default, got {_trunc(body)}"
            baseline_weights = dict(body["weights"])
            print(f"C2 PASS — weights source:default (churn={baseline_weights['churn_per_15min_moved']})")

            # C3 — PATCH deep with an extreme curve + caps. fit_curve nests
            # under its own key (ContextConfigBody.strict()) — the caps are
            # flat top-level fields alongside it.
            patch_body = {"fit_curve": EXTREME_DEEP_CURVE, **EXTREME_DEEP_CAPS}
            status, body = patch_context(sched, "deep", patch_body)
            assert status == 200, f"C3: PATCH /v1/contexts/deep: {status} {_trunc(body)}"
            assert body.get("source") == "custom", f"C3: expected source:custom, got {_trunc(body)}"
            assert body["body"]["fit_curve"] == EXTREME_DEEP_CURVE, (
                f"C3: fit_curve not reflected: {_trunc(body)}"
            )
            print("C3 PASS — PATCH /v1/contexts/deep applied the extreme curve + caps")

            # C4 — PATCH weights with an extreme churn value.
            status, body = patch_weights(sched, {"churn_per_15min_moved": EXTREME_CHURN})
            assert status == 200, f"C4: PATCH /v1/weights: {status} {_trunc(body)}"
            assert body.get("source") == "custom", f"C4: expected source:custom, got {_trunc(body)}"
            assert body["weights"]["churn_per_15min_moved"] == EXTREME_CHURN, (
                f"C4: churn not reflected: {_trunc(body)}"
            )
            print(f"C4 PASS — PATCH /v1/weights applied churn_per_15min_moved={EXTREME_CHURN}")

            # C5 — re-GET contexts: deep custom + merged, others still default.
            status, body = get_contexts(sched)
            assert status == 200, f"C5: GET /v1/contexts: {status} {_trunc(body)}"
            contexts = body.get("contexts", [])
            deep = deep_context_entry(contexts)
            assert deep["source"] == "custom", f"C5: deep not custom: {_trunc(deep)}"
            assert deep["body"]["fit_curve"] == EXTREME_DEEP_CURVE, f"C5: deep curve mismatch: {_trunc(deep)}"
            for key, val in EXTREME_DEEP_CAPS.items():
                assert deep["body"][key] == val, f"C5: deep {key} mismatch: {_trunc(deep)}"
            others = [c for c in contexts if c["context"] != "deep"]
            still_default = [c["context"] for c in others if c.get("source") != "default"]
            assert not still_default, f"C5: non-deep contexts unexpectedly custom: {still_default!r}"
            print(
                f"C5 PASS — deep is source:custom with the merged values; "
                f"other 4 ({[c['context'] for c in others]}) still source:default"
            )

            # C6 — re-GET weights: custom, churn matches, other 5 untouched.
            status, body = get_weights(sched)
            assert status == 200, f"C6: GET /v1/weights: {status} {_trunc(body)}"
            assert body.get("source") == "custom", f"C6: expected source:custom, got {_trunc(body)}"
            weights = body["weights"]
            assert weights["churn_per_15min_moved"] == EXTREME_CHURN, f"C6: churn mismatch: {_trunc(weights)}"
            for key, val in baseline_weights.items():
                if key == "churn_per_15min_moved":
                    continue
                assert weights[key] == val, f"C6: {key} drifted from default: {_trunc(weights)}"
            print("C6 PASS — weights source:custom, churn set, other 5 weights untouched")

            # C7 — resolve round-trip with the customised payload live. A 200
            # is the expected happy path (empty week -> empty schedule). A
            # 422 (unsat) is ALSO an acceptable pass: reaching unsat means
            # the solver's Pydantic layer accepted the customised contexts/
            # weights payload and actually ran the search — a payload the
            # solver REJECTS (the failure this step actually guards against)
            # surfaces as 502 solver_failed, not 422, so unsat still proves
            # the round trip succeeded. A single retry tolerates a cold
            # solver on a 502; only a still-failing status after that retry
            # is treated as a real failure.
            monday = next_blank_monday(datetime.now(timezone.utc).date())
            status, body = post_resolve(sched, monday)
            if status == 502:
                print(f"C7 NOTE — first resolve attempt 502 (cold solver?): {_trunc(body)} — retrying once")
                status, body = post_resolve(sched, monday)
            assert status in (200, 422), (
                f"C7: POST /v1/resolve ({monday}): expected 200 or 422, got {status} {_trunc(body)}"
            )
            if status == 422:
                print(
                    f"C7 PASS (note: unsat) — solver parsed the customised payload but found no "
                    f"feasible schedule for the blank week of {monday}"
                )
            else:
                print(f"C7 PASS — resolve accepted the customised contexts/weights payload (week of {monday})")

            # N1 — negative probe: fractional weight -> 400 validation_failed.
            status, body = patch_weights(sched, {"churn_per_15min_moved": 2.5})
            assert status == 400, f"N1: fractional weight PATCH: expected 400, got {status} {_trunc(body)}"
            assert body.get("error") == "validation_failed", (
                f"N1: expected error:validation_failed, got {_trunc(body)}"
            )
            print("N1 PASS — fractional weight PATCH rejected 400 validation_failed")

            # N2 — negative probe: bad fit_curve ordering -> 400 invalid_fit_curve.
            status, body = patch_context(
                sched, "deep",
                {"fit_curve": {"peak_start": "12:00", "peak_end": "11:00", "falloff_end": "15:00"}},
            )
            assert status == 400, f"N2: bad fit_curve ordering PATCH: expected 400, got {status} {_trunc(body)}"
            assert body.get("error") == "invalid_fit_curve", (
                f"N2: expected error:invalid_fit_curve, got {_trunc(body)}"
            )
            print("N2 PASS — out-of-order fit_curve PATCH rejected 400 invalid_fit_curve")

        finally:
            # C8 — cleanup: always attempted, even on a mid-flow assertion
            # failure, so a failed run at least tries to leave this
            # identity's config back at defaults for a later smoke run.
            # reset_config never raises (see its docstring), so this can't
            # mask an exception from the block above; only report success
            # when cleanup actually reported success.
            cleanup_ok = reset_config(sched, "CLEANUP")
            if cleanup_ok:
                print("C8 PASS — DELETE /v1/contexts/* + DELETE /v1/weights (cleanup)")
            else:
                print("C8 WARNING — cleanup did not fully succeed; see warnings above", file=sys.stderr)

        # C9 — verify the reset actually took (a clean cleanup gets its own
        # explicit verification here rather than being merely assumed).
        status, body = get_contexts(sched)
        assert status == 200, f"C9: GET /v1/contexts: {status} {_trunc(body)}"
        deep = deep_context_entry(body.get("contexts", []))
        assert deep["source"] == "default", f"C9: deep did not reset to default: {_trunc(deep)}"

        status, body = get_weights(sched)
        assert status == 200, f"C9: GET /v1/weights: {status} {_trunc(body)}"
        assert body.get("source") == "default", f"C9: weights did not reset to default: {_trunc(body)}"
        print("C9 PASS — both resources back to source:default after DELETE")

        print("ALL PASS")

    finally:
        sched.close()


if __name__ == "__main__":
    main()
