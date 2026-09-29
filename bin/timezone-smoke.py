#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27", "tzdata>=2024.1"]
# ///
"""Live smoke for the user-settable timezone (internal design notes,
Card D). Runs against dev or ms with either provider's bearer; nothing here
is provider-specific (the resolves land on whichever calendar the bearer
belongs to, and only ever propose — no calendar writes).

Structured like bin/config-smoke.py: PEP 723 + uv, _smoke_lib's bearer
client, secrets injected externally (never `op` inside this script):

    op run --env-file=.env -- uv run bin/timezone-smoke.py > /tmp/timezone-smoke.out 2>&1

Flow:
  STARTUP  DELETE /v1/timezone (must come back source "default") and delete
      any leftover tzsmoke tasks, so a crashed earlier run can't leave the
      account on a far zone or crowd the week.
  Z1  GET /v1/timezone baseline — source "default", superseded_plans 0,
      tz == whoami.home_tz.
  Z2  PATCH each invalid zone (unknown name, UTC offset, bare EST) -> 400; the stored
      zone is unchanged.
  Z3  Baseline behaviour leg: ~14 h of free-floating tasks, POST
      /v1/resolve over the user's local Mon 00:00 -> next Mon 00:00 in the
      baseline zone. The local time-of-day band (the placed chunks'
      envelope) is derived from THIS resolve, not hardcoded, so the smoke
      tracks whatever config_business_hours the account has. The fixtures
      are sized to fill most of a working week, so the envelope approaches
      the real business-hours hull. Weekdays are not checked: which days
      the solver picks is not a timezone property.
  Z4  PATCH a far zone, lower-cased (e.g. "europe/london" from
      Australia/Sydney) -> 200, tz canonical, source "user",
      superseded_plans >= 1 when Z3 left a pending plan; whoami.home_tz
      matches.
  Z5  Vacuity guard first: the round-the-clock gap between the two zones
      (at the new window's start) must be >= the band's width, or the band
      check could not tell old-zone hours from new-zone hours — that FAILS
      as "inconclusive", never passes silently. Then the same tasks are
      resolved over the user's local week in the NEW zone: every placed
      chunk, read in the new zone, sits inside the Z3 band (business hours
      followed the user), and the UTC instants differ from Z3's.
  Z6  DELETE /v1/timezone -> source "default", tz == the baseline;
      whoami.home_tz matches.
  Z7  Teardown (finally): delete this run's tasks and plans and DELETE
      /v1/timezone, then verify GET /v1/timezone is back at the default.

Scope: both resolves pass their window EXPLICITLY, so this smoke proves
business hours follow the user's zone within a given window. It does not
exercise week-identity derivation (which week the webhook replan, Monday
cron or accept path picks for a zone); that is covered by the worker's
vitest suite, not here.

The far zone maximises the ROUND-THE-CLOCK gap from the baseline (see
far_zone): a worker that still applied the old zone's business hours would
place chunks on the new zone's night, which the band check catches. A zone
that is 18 h behind (Sydney -> LA) is only 6 h round the clock, and would
leave half the old hours inside the new band.

A subject with no users row gets 404 {error:"no_user_row"} from PATCH/DELETE
(not expected for a minted smoke account); the failure message says so.

Requires:
  SCHEDULER_URL, A_BEARER, A_REFRESH, A_EXPECTED_EMAIL
Optional:
  A_CLIENT_ID (default "smoke-cli")

No D1 access: every write this harness makes has an API undo. The account
is left on the instance default zone (source "default"), whatever it had
before — the startup DELETE is the crash-residue reset, like config-smoke's
reset_config.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

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

# Candidate far zones, all canonical IANA names. far_zone picks whichever is
# furthest round the clock from the baseline at the time of the run.
FAR_ZONE_CANDIDATES = (
    "Europe/London",
    "America/Los_Angeles",
    "America/New_York",
    "Asia/Tokyo",
    "Asia/Kolkata",
    "Australia/Sydney",
)
# "+10:00" is a valid Intl timeZone under current ECMA-402 but not an IANA zone;
# "EST" resolves to America/Panama (no DST), so the server rejects bare names.
INVALID_ZONES = ("Not/AZone", "+10:00", "EST")
# How far out the resolved week sits: clear of the current week's live
# traffic, same idea as config-smoke's next_blank_monday.
MIN_DAYS_OUT = 21
# Free-floating fixtures: no pin, no deadline, no windows. earliest_start is
# set to the resolved window's start (a future window only admits an
# unanchored task whose earliest_start floor is inside it —
# worker/src/planning/task-window.ts).
# ~14 h in total: enough to fill most of a working week's business hours so
# the Z3 envelope approaches the real hull (bin/test_timezone_smoke.py pins
# 12-16 h).
_TASK_SHAPES = (
    ("deep", 120), ("admin", 90), ("deep", 120), ("admin", 90),
    ("deep", 120), ("admin", 90), ("deep", 90), ("admin", 120),
)
TITLE_PREFIX = "[tzsmoke]"  # also in bin/reset-smoke-env.py HARNESS_TITLE_PREFIXES
EXTERNAL_ID_PREFIX = "tzsmoke-"


# =============================================================================
# Pure logic (bin/test_timezone_smoke.py)
# =============================================================================


def is_tzsmoke_task(task: dict) -> bool:
    """A task this harness created (title prefix, or external_id prefix if
    the title was edited). Used by the startup leftover sweep."""
    title = task.get("title")
    if isinstance(title, str) and title.startswith(TITLE_PREFIX):
        return True
    src = task.get("source")
    ext = src.get("external_id") if isinstance(src, dict) else None
    return isinstance(ext, str) and ext.startswith(EXTERNAL_ID_PREFIX)


def tz_failure(label: str, method: str, status: int, body: dict) -> str:
    msg = f"{label}: {method} /v1/timezone: {status} {_trunc(body)}"
    if status == 404 and isinstance(body, dict) and body.get("error") == "no_user_row":
        msg += (" — the subject has no users row (no_user_row); sign in once "
                "(re-mint the smoke identity) so the worker provisions it")
    return msg


def utc_offset_minutes(tz: str, at: datetime) -> int:
    off = at.astimezone(ZoneInfo(tz)).utcoffset()
    assert off is not None
    return int(off.total_seconds() // 60)


def _circular_gap(a: int, b: int) -> int:
    d = abs(a - b) % 1440
    return min(d, 1440 - d)


def far_zone(baseline_tz: str, at: datetime) -> str:
    """The candidate furthest from `baseline_tz` round the clock at `at`
    (ties go to the earlier candidate)."""
    base = utc_offset_minutes(baseline_tz, at)
    best, best_gap = None, -1
    for z in FAR_ZONE_CANDIDATES:
        if z == baseline_tz:
            continue
        gap = _circular_gap(utc_offset_minutes(z, at), base)
        if gap > best_gap:
            best, best_gap = z, gap
    assert best is not None
    return best


def next_local_monday(now_utc: datetime, tz: str, min_days: int = MIN_DAYS_OUT) -> date:
    """The first Monday at least `min_days` after the user's LOCAL today."""
    local_today = now_utc.astimezone(ZoneInfo(tz)).date()
    cand = local_today + timedelta(days=min_days)
    return cand + timedelta(days=(7 - cand.weekday()) % 7)


def _utc_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def local_week_window(monday: date, tz: str) -> tuple[str, str]:
    """[local Mon 00:00, next local Mon 00:00) as UTC ISO-Z. Each end is
    localised separately, so a DST week is 167 or 169 h, not 168."""
    if monday.weekday() != 0:
        raise ValueError(f"{monday} is not a Monday")
    zone = ZoneInfo(tz)
    nxt = monday + timedelta(days=7)
    start = datetime(monday.year, monday.month, monday.day, tzinfo=zone)
    end = datetime(nxt.year, nxt.month, nxt.day, tzinfo=zone)
    return _utc_z(start), _utc_z(end)


def _parse_instant(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def chunk_local_span(chunk: dict, tz: str) -> tuple[int, int, int]:
    """(weekday Mon=0, start minute-of-day, end minute) in `tz`. The end is
    measured from the start day's midnight, so a chunk ending at local
    midnight is 1440 and one crossing it exceeds 1440."""
    zone = ZoneInfo(tz)
    s = _parse_instant(chunk["start"]).astimezone(zone)
    e = _parse_instant(chunk["end"]).astimezone(zone)
    start_min = s.hour * 60 + s.minute
    end_min = (e.date() - s.date()).days * 1440 + e.hour * 60 + e.minute
    return s.weekday(), start_min, end_min


@dataclass(frozen=True)
class Band:
    """A local time-of-day envelope, in minutes from local midnight. No
    weekday component: which days the solver uses is not a tz property."""
    start_min: int
    end_min: int

    @property
    def width_min(self) -> int:
        return self.end_min - self.start_min

    def describe(self) -> str:
        return (f"{self.start_min // 60:02d}:{self.start_min % 60:02d}-"
                f"{self.end_min // 60:02d}:{self.end_min % 60:02d}")


def derive_band(chunks: list[dict], tz: str) -> Band:
    """The local time-of-day envelope of the placed chunks, read in `tz`."""
    if not chunks:
        raise ValueError("cannot derive a band from zero placed chunks")
    spans = [chunk_local_span(c, tz) for c in chunks]
    return Band(start_min=min(s for _, s, _ in spans), end_min=max(e for _, _, e in spans))


def inconclusive_reason(base_tz: str, far_tz: str, at: datetime, band: Band) -> str | None:
    """None when the band check can discriminate: old-zone placements are
    shifted by the zones' round-the-clock gap, and miss a band of width w
    entirely only when that gap is >= w. Otherwise a reason string."""
    gap = _circular_gap(utc_offset_minutes(far_tz, at), utc_offset_minutes(base_tz, at))
    if gap >= band.width_min:
        return None
    return (f"inconclusive: {base_tz} and {far_tz} are {gap} min apart round the clock at {_utc_z(at)}, "
            f"narrower than the {band.width_min} min band {band.describe()} — old-zone placements "
            f"could still land inside it, so the band check proves nothing")


def band_violations(chunks: list[dict], tz: str, band: Band) -> list[str]:
    """One message per chunk whose local time of day in `tz` leaves `band`."""
    out = []
    for c in chunks:
        wd, s, e = chunk_local_span(c, tz)
        if not (s >= band.start_min and e <= band.end_min):
            out.append(
                f"task {c.get('task_id')} chunk {c.get('chunk_id')} at {c.get('start')}..{c.get('end')} "
                f"is weekday {wd} {s // 60:02d}:{s % 60:02d}-{e // 60:02d}:{e % 60:02d} in {tz}, "
                f"outside {band.describe()}"
            )
    return out


def start_instants(chunks: list[dict]) -> frozenset[datetime]:
    return frozenset(_parse_instant(c["start"]) for c in chunks)


def harness_chunks(schedule: list[dict], task_ids: set[str]) -> list[dict]:
    return [c for c in schedule if c.get("task_id") in task_ids]


def task_bodies(run_id: str, earliest_start: str) -> list[dict]:
    out = []
    for i, (ctx, minutes) in enumerate(_TASK_SHAPES):
        ext = f"{EXTERNAL_ID_PREFIX}{run_id}-{i}"
        out.append({
            "title": f"{TITLE_PREFIX} task {i}",
            "context": ctx,
            "priority": 70,
            "duration_minutes": minutes,
            "earliest_start": earliest_start,
            "deadline": None,
            "preferred_windows": [],
            "dependencies": [],
            "pinned_at": None,
            "source": {"kind": "mcp", "external_id": ext},
            "status": "pending",
        })
    return out


# =============================================================================
# HTTP
# =============================================================================


def _trunc(obj) -> str:
    return repr(obj)[:400]


def get_tz(sched: SchedulerClient) -> tuple[int, dict]:
    r = sched.request("GET", "/v1/timezone")
    return r.status_code, _safe_json(r)


def patch_tz(sched: SchedulerClient, tz: str) -> tuple[int, dict]:
    r = sched.request("PATCH", "/v1/timezone", json={"tz": tz})
    return r.status_code, _safe_json(r)


def delete_tz(sched: SchedulerClient) -> tuple[int, dict]:
    r = sched.request("DELETE", "/v1/timezone")
    return r.status_code, _safe_json(r)


def whoami_home_tz(sched: SchedulerClient) -> str | None:
    r = sched.request("GET", "/v1/whoami")
    r.raise_for_status()
    return r.json().get("home_tz")


def post_resolve(sched: SchedulerClient, window: tuple[str, str]) -> tuple[int, dict]:
    body = {"window_start": window[0], "window_end": window[1]}
    r = sched.request("POST", "/v1/resolve", json=body)
    status, out = r.status_code, _safe_json(r)
    if status == 502:
        print(f"NOTE — resolve 502 (cold solver?): {_trunc(out)} — retrying once")
        r = sched.request("POST", "/v1/resolve", json=body)
        status, out = r.status_code, _safe_json(r)
    return status, out


def check_tz_body(label: str, body: dict) -> None:
    assert isinstance(body.get("tz"), str) and body["tz"], f"{label}: no tz in {_trunc(body)}"
    assert body.get("source") in ("user", "default"), f"{label}: bad source in {_trunc(body)}"
    assert isinstance(body.get("superseded_plans"), int), f"{label}: bad superseded_plans in {_trunc(body)}"


def resolve_placed(label: str, sched: SchedulerClient, window: tuple[str, str],
                   task_ids: set[str], plan_hashes: set[str]) -> list[dict]:
    status, body = post_resolve(sched, window)
    assert status == 200, f"{label}: POST /v1/resolve {window}: expected 200, got {status} {_trunc(body)}"
    if body.get("plan_hash"):
        plan_hashes.add(body["plan_hash"])
    placed = harness_chunks(body.get("schedule", []), task_ids)
    assert placed, (
        f"{label}: none of this run's tasks were placed over {window} "
        f"(dropped={_trunc(body.get('dropped'))})"
    )
    return placed


def cleanup(sched: SchedulerClient, task_ids: list[str], plan_hashes: set[str]) -> bool:
    """Never raises (must not mask an in-flight AssertionError). A 404 on a
    plan is fine: the tz change already superseded it."""
    ok = True
    for tid in task_ids:
        try:
            r = sched.request("DELETE", f"/v1/tasks/{tid}")
            if r.status_code not in (200, 204, 404):
                print(f"CLEANUP: WARNING — DELETE /v1/tasks/{tid} returned {r.status_code}", file=sys.stderr)
                ok = False
        except Exception as e:
            print(f"CLEANUP: WARNING — DELETE /v1/tasks/{tid} raised {e!r}", file=sys.stderr)
            ok = False
    for h in plan_hashes:
        try:
            r = sched.request("DELETE", f"/v1/plans/{h}")
            if r.status_code not in (200, 204, 404):
                print(f"CLEANUP: WARNING — DELETE /v1/plans/{h} returned {r.status_code}", file=sys.stderr)
                ok = False
        except Exception as e:
            print(f"CLEANUP: WARNING — DELETE /v1/plans/{h} raised {e!r}", file=sys.stderr)
            ok = False
    return ok


def reset_tz(sched: SchedulerClient, label: str) -> bool:
    """DELETE /v1/timezone. Never raises; see cleanup."""
    try:
        status, body = delete_tz(sched)
    except Exception as e:
        print(f"{label}: WARNING — DELETE /v1/timezone raised {e!r}", file=sys.stderr)
        return False
    if status != 200 or body.get("source") != "default":
        print(f"{label}: WARNING — {tz_failure(label, 'DELETE', status, body)}", file=sys.stderr)
        return False
    return True


def sweep_leftovers(sched: SchedulerClient) -> int:
    """Delete tzsmoke tasks a crashed earlier run left behind."""
    r = sched.request("GET", "/v1/tasks")
    r.raise_for_status()
    n = 0
    for t in r.json().get("tasks", []):
        if is_tzsmoke_task(t) and isinstance(t.get("id"), str):
            dr = sched.request("DELETE", f"/v1/tasks/{t['id']}")
            assert dr.status_code in (200, 204, 404), (
                f"STARTUP: DELETE leftover task {t['id']}: {dr.status_code} {_trunc(_safe_json(dr))}"
            )
            n += 1
    return n


# =============================================================================
# Main
# =============================================================================


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

        # STARTUP — crash-residue reset: back to the instance default zone
        # (asserted, not best-effort: the baseline below must be "default")
        # and no leftover fixtures from an earlier run.
        status, body = delete_tz(sched)
        assert status == 200, tz_failure("STARTUP", "DELETE", status, body)
        assert body.get("source") == "default", f"STARTUP: DELETE did not reset to default: {_trunc(body)}"
        swept = sweep_leftovers(sched)
        print(f"STARTUP OK — timezone reset to default ({body.get('tz')}); {swept} leftover tzsmoke task(s) removed")

        # Z1 — baseline.
        status, baseline = get_tz(sched)
        assert status == 200, tz_failure("Z1", "GET", status, baseline)
        check_tz_body("Z1", baseline)
        assert baseline["source"] == "default", f"Z1: expected source:default after reset: {_trunc(baseline)}"
        assert baseline["superseded_plans"] == 0, f"Z1: GET must report superseded_plans 0: {_trunc(baseline)}"
        base_tz = baseline["tz"]
        home = whoami_home_tz(sched)
        assert home == base_tz, f"Z1: whoami.home_tz {home!r} != GET /v1/timezone tz {base_tz!r}"
        now = datetime.now(timezone.utc)
        far = far_zone(base_tz, now)
        print(f"Z1 PASS — baseline tz={base_tz} source=default; far zone {far}")

        run_id = uuid.uuid4().hex[:8]
        task_ids: list[str] = []
        plan_hashes: set[str] = set()
        try:
            # Z2 — each invalid zone is refused and changes nothing.
            for zone in INVALID_ZONES:
                status, body = patch_tz(sched, zone)
                assert status == 400, f"Z2: PATCH {zone!r}: expected 400, got {status} {_trunc(body)}"
                status, after = get_tz(sched)
                assert status == 200 and after.get("tz") == base_tz and after.get("source") == "default", (
                    f"Z2: invalid PATCH {zone!r} changed the stored zone: {_trunc(after)}"
                )
                print(f"Z2 PASS — PATCH {zone!r} rejected 400 ({body.get('error')}); zone unchanged")

            # Z3 — baseline resolve; derive the local band from it.
            monday_a = next_local_monday(now, base_tz)
            window_a = local_week_window(monday_a, base_tz)
            for b in task_bodies(run_id, window_a[0]):
                r = sched.request("POST", "/v1/tasks", json=b)
                assert r.status_code in (200, 201), f"Z3: POST /v1/tasks: {r.status_code} {_trunc(_safe_json(r))}"
                task_ids.append(r.json()["id"])
            ids = set(task_ids)
            placed_a = resolve_placed("Z3", sched, window_a, ids, plan_hashes)
            band = derive_band(placed_a, base_tz)
            print(f"Z3 PASS — {len(placed_a)} chunk(s) placed over local week of {monday_a} in {base_tz}; "
                  f"local band {band.describe()}")

            # Z4 — lower-cased far zone is canonicalised; whoami follows.
            status, body = patch_tz(sched, far.lower())
            assert status == 200, tz_failure("Z4", "PATCH", status, body)
            check_tz_body("Z4", body)
            assert body["tz"] == far, f"Z4: expected canonical {far!r}, got {_trunc(body)}"
            assert body["source"] == "user", f"Z4: expected source:user, got {_trunc(body)}"
            if plan_hashes:
                assert body["superseded_plans"] >= 1, (
                    f"Z4: Z3 left a pending plan but superseded_plans is {body['superseded_plans']}"
                )
            home = whoami_home_tz(sched)
            assert home == far, f"Z4: whoami.home_tz {home!r} != {far!r}"
            print(f"Z4 PASS — PATCH {far.lower()!r} -> tz={far} source=user "
                  f"superseded_plans={body['superseded_plans']}; whoami.home_tz={home}")

            # Z5 — vacuity guard, then the same tasks over the user's local
            # week in the new zone.
            monday_b = next_local_monday(now, far)
            window_b = local_week_window(monday_b, far)
            reason = inconclusive_reason(base_tz, far, _parse_instant(window_b[0]), band)
            assert reason is None, f"Z5: {reason}"
            for tid in task_ids:
                r = sched.request("PATCH", f"/v1/tasks/{tid}", json={"earliest_start": window_b[0]})
                assert r.status_code == 200, f"Z5: PATCH /v1/tasks/{tid}: {r.status_code} {_trunc(_safe_json(r))}"
            placed_b = resolve_placed("Z5", sched, window_b, ids, plan_hashes)
            bad = band_violations(placed_b, far, band)
            assert not bad, "Z5: chunks outside the baseline's local band:\n  " + "\n  ".join(bad)
            assert start_instants(placed_b) != start_instants(placed_a), (
                "Z5: placements have the same UTC instants under both zones — business hours did not move"
            )
            print(f"Z5 PASS — {len(placed_b)} chunk(s) over local week of {monday_b} in {far} all inside "
                  f"{band.describe()} local; UTC instants moved")

            # Z6 — DELETE falls back to the instance default.
            status, body = delete_tz(sched)
            assert status == 200, tz_failure("Z6", "DELETE", status, body)
            check_tz_body("Z6", body)
            assert body["source"] == "default", f"Z6: expected source:default, got {_trunc(body)}"
            assert body["tz"] == base_tz, f"Z6: default tz {body['tz']!r} != baseline default {base_tz!r}"
            home = whoami_home_tz(sched)
            assert home == base_tz, f"Z6: whoami.home_tz {home!r} != {base_tz!r}"
            print(f"Z6 PASS — DELETE -> tz={body['tz']} source=default; whoami.home_tz={home}")

        finally:
            # Always DELETE: the account ends on the instance default,
            # never a far zone, whatever happened above.
            tasks_ok = cleanup(sched, task_ids, plan_hashes)
            tz_ok = reset_tz(sched, "CLEANUP")
            if tasks_ok and tz_ok:
                print(f"CLEANUP OK — {len(task_ids)} task(s) and {len(plan_hashes)} plan(s) removed; "
                      f"timezone reset to default")
            else:
                print("CLEANUP WARNING — teardown did not fully succeed; see warnings above", file=sys.stderr)

        # Z7 — the teardown reset actually took.
        status, body = get_tz(sched)
        assert status == 200, tz_failure("Z7", "GET", status, body)
        assert body.get("tz") == base_tz and body.get("source") == "default", (
            f"Z7: expected tz={base_tz} source=default, got {_trunc(body)}"
        )
        print(f"Z7 PASS — back to tz={base_tz} source=default")

        print("ALL PASS")

    finally:
        sched.close()


if __name__ == "__main__":
    main()
