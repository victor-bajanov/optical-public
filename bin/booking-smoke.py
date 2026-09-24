#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""Live smoke for the per-user public booking page (either provider).

Exercises the full public flow end to end against a deployed environment
(internal design notes):

B1  PUT /v1/booking-page — configure slug `smoke-book`, one 30-min duration,
    zero notice, a single phone location mode (never Meet, so no conference
    is created).
B2  GET /book/smoke-book — the public page loads, pulls in the static client
    module, and serves its CSP + X-Frame-Options through the edge.
B3  GET /book/smoke-book/slots — a non-empty set of bookable starts.
B4  POST /book/smoke-book with location_kind "meet" (not offered by this
    page) — rejected 400 location_unavailable.
B5  POST /book/smoke-book with location_kind "phone" and no
    location_detail — rejected 400 invalid_body.
B6  POST /book/smoke-book — an anonymous booker claims the first slot with
    location_kind "phone" and their own number.
B7  POST the same slot again — rejected 409 slot_unavailable (no double-book).
B8  GET /v1/bookings — the claim is listed confirmed with a real calendar
    event carrying the booker's location choice; the calendar event itself is
    fetched directly and checked to hold the booker's number, never an
    owner-supplied one (the property the whole feature exists for — the old
    code mailed the owner's own configured number to every booker).
B9  GET .../slots again — the claimed start is no longer offered.
B10 Paging: B1 sets horizon_days 7 / max_horizon_days 14, so page 0 reports
    has_more and page 1 is a distinct, later window whose starts all lie past
    page 0's end; page 2 is 400 page_out_of_range and page=abc is 400
    invalid_page — each refused without a calendar read.

Cleanup (always, in finally): delete the calendar event, delete the `bookings`
row (direct D1 against the target env — no DELETE endpoint exists for it),
and disable the page. Prints exactly what it did and did not clean up.

Requires:
  SCHEDULER_URL, A_BEARER, A_REFRESH, A_EXPECTED_EMAIL, TURNSTILE_SECRET_<ENV>
Optional (enables automatic D1 row cleanup instead of a printed manual step):
  D1_DATABASE_ID (must be the target env's own db — scheduler-dev for
  --wrangler-env dev), CLOUDFLARE_API_TOKEN

Provider / env (2026-09-17): --provider {google,microsoft} (default
$SMOKE_PROVIDER or google) names the provider A_BEARER was minted for — it
picks the calendar client the flow runs through (_smoke_lib.make_calendar_client)
and is checked against GET /v1/whoami in preflight, before the Turnstile
secret is ever swapped (same shape as feed/poll/multiuser/meeting-smoke).
--wrangler-env (default $SMOKE_WRANGLER_ENV or dev) picks the deployment:
TURNSTILE_SECRET_<ENV> is the secret restored in cleanup, and the direct-D1
cleanup is pinned to that env's own database (assert_smoke_db — tighter
than _smoke_lib.assert_dev_db). Both providers run against dev.

Brackets the whole run: swaps the target env's TURNSTILE_SECRET to
Cloudflare's published test secret before B1, then restores the real secret
(TURNSTILE_SECRET_<ENV>) first thing in cleanup. That restore runs on any
exception, assertion failure, or Ctrl-C — including a Ctrl-C landing during
the restore call itself, which prints the CRITICAL warning and aborts the
remaining cleanup rather than being silently swallowed — but NOT if the
process is SIGKILL'd/SIGTERM'd or the terminal closes; in that case the
target env is left on the test secret and TURNSTILE_SECRET must be checked
and restored by hand. See
internal design notes.

--mode decline (internal design notes, docs/runbook.md §M):
exercises the decline auto-cancel flow instead of B1-B9. Books via the
public page using a second, real account (the "harness attendee") so its
RSVP is real; declines on the attendee's own event copy; waits for the
webhook to stamp `bookings.cancel_pending_at`; force-fires the */5 * * * *
sweep via the cookie-free cron trigger (`wrangler dev --env <env>
--test-scheduled` + `curl /__scheduled`, docs/runbook.md §E); asserts the
event is deleted, the row is `'cancelled'` (direct D1), and both the
booker's and owner's cancellation emails landed in the OWNER's own Sent
folder/Sent Items. On Google both emails are sent FROM the owner's Gmail
account (see booking-decline-sweep.ts) and are read back over Gmail
(GOOGLE_GMAIL_READ_SCOPE_ENABLED on the target env). On Microsoft
(--provider microsoft) the same two emails are read back from the owner's
Sent Items over Graph (_smoke_lib.GraphMailClient.list_sent_since +
graph_sent_matches), needing MICROSOFT_MAIL_READ_SCOPE_ENABLED live on the
target env with the owner (microsoft:a) re-consented.
Also exercises the abort path on a second booking: decline,
then re-accept before the (grace-shortened) grace elapses. The target env's
REAL */5 * * * * cron is also live (BOOKING_PAGE_ENABLED is "true"), so this
can legitimately race the re-accept — if the real cron wins, the abort-path
assertions are SKIPPED (printed as such) rather than failed, since that
outcome proves nothing wrong with the harness or the feature. Requires, in
addition to the above: C_BEARER, C_REFRESH, C_EXPECTED_EMAIL (the harness
attendee account), D1_DATABASE_ID + CLOUDFLARE_API_TOKEN (no longer optional
in this mode — the D1 assertions and cron-forcing subprocess both need
them). See docs/runbook.md §M's "Live smoke" subsection for the full
prerequisite list, including that the target env must be deployed from a
branch carrying BOOKING_DECLINE_GRACE_MINUTES="1" for the grace-shortening
to be live.
Do not run --mode base and --mode decline concurrently against the same
owner (one booking-page config row per owner_subject — see runbook §M).

Usage:
  op run --env-file=.env -- uv run bin/booking-smoke.py > /tmp/booking-smoke.out 2>&1
  op run --env-file=.env -- uv run bin/booking-smoke.py --mode decline > /tmp/booking-smoke-decline.out 2>&1
  op run --env-file=.env -- uv run bin/booking-smoke.py --provider microsoft > /tmp/booking-smoke-microsoft.out 2>&1
  op run --env-file=.env -- uv run bin/booking-smoke.py --mode decline --provider microsoft > /tmp/booking-smoke-decline-microsoft.out 2>&1
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

_spec = importlib.util.spec_from_file_location(
    "_smoke_lib", str(Path(__file__).resolve().parent / "_smoke_lib.py")
)
_smoke_lib = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _smoke_lib
_spec.loader.exec_module(_smoke_lib)
Identity = _smoke_lib.Identity
SchedulerClient = _smoke_lib.SchedulerClient
GmailClient = _smoke_lib.GmailClient
GraphMailClient = _smoke_lib.GraphMailClient
DevD1 = _smoke_lib.DevD1
sql_str = _smoke_lib.sql_str
rsvp_as_attendee = _smoke_lib.rsvp_as_attendee
make_calendar_client = _smoke_lib.make_calendar_client
preflight_whoami = _smoke_lib.preflight_whoami

_ct_spec = importlib.util.spec_from_file_location(
    "_create_turnstile_widget",
    str(Path(__file__).resolve().parent / "create-turnstile-widget.py"),
)
_ct = importlib.util.module_from_spec(_ct_spec)
sys.modules[_ct_spec.name] = _ct
_ct_spec.loader.exec_module(_ct)

# URL guard and required-env helper come from _smoke_lib — the canonical
# definitions (guarded by bin/test_smoke_lib_guards.py). A local copy here
# previously drifted: it was fail-open on prod's own workers.dev subdomain
# (see bin/test_booking_smoke_guard.py).
assert_dev_url = _smoke_lib.assert_dev_url
# 2026-09-17 final review MUST-FIX: cross-check SCHEDULER_URL against
# --wrangler-env, so a mismatched pair can't sail through preflight and then
# swap the WRONG env's TURNSTILE_SECRET while probing the OTHER env's live
# booking page.
assert_url_matches_env = _smoke_lib.assert_url_matches_env
req = _smoke_lib.req

# D1 database ids, from the same canonical source. Only consulted if the
# caller opts into direct-D1 row cleanup by setting D1_DATABASE_ID.
DEV_DB_ID = _smoke_lib.DEV_DB_ID     # scheduler-dev
PROD_DB_ID = _smoke_lib.PROD_DB_ID   # scheduler (prod) — NEVER

# The deployments --wrangler-env may target, each with its own D1 db (the
# direct-D1 cleanup is pinned to it — assert_smoke_db) and Turnstile pair.
WRANGLER_ENVS: tuple[str, ...] = ("dev",)
_ENV_DB_IDS: dict[str, str] = {"dev": DEV_DB_ID}

SLUG = "smoke-book"
BOOKER_NAME = "Booking Smoke Tester"
BOOKER_EMAIL = "smoke-booker@example.com"
# The BOOKER's own number, supplied at claim time. Deliberately a different
# shape (mobile) from LEGACY_OWNER_PHONE_SENTINEL below, so the two can never
# be confused in an assertion.
BOOKER_PHONE = "+61 4 9876 5432"
# What the OLD config schema let an owner hardcode as the page's one phone
# number (`{"location": {"mode": "phone", "detail": "..."}}`), which then went
# out on every booker's calendar invite via `notifyAttendees: true`. The new
# schema has no way to attach a detail to a "phone" mode (worker/src/booking/
# location.ts OWNER_DETAIL is `custom`-only), so this value is never written
# to config here — it exists purely as a sentinel B8 checks is absent from the
# created event, proving the booker's number, not some owner-configured one,
# is what reached the calendar.
LEGACY_OWNER_PHONE_SENTINEL = "+61 2 5550 1234"
# Cloudflare's documented dummy token: accepted by the "always passes" test
# secret key regardless of content, so this never touches a real challenge.
DUMMY_TURNSTILE_TOKEN = "XXXX.DUMMY.TOKEN.XXXX"
# Cloudflare's published always-passes secret. This harness installs it on
# the target env's TURNSTILE_SECRET for the duration of one run (main()
# restores the real secret in finally) — see
# internal design notes.
TEST_TURNSTILE_SECRET = "1x0000000000000000000000000000000AA"
# The booking page's client module is served under a content-hashed filename
# (bin/build-client-js.sh derives it from booking.client.js), so match the
# shape rather than a literal — the hash changes on every client edit. B2 used
# to assert the flat "/book/_static/booking.js"; that path stopped existing
# when the hashing landed, and worker/test/booking/static.test.ts now asserts
# it is ABSENT.
BOOKING_CLIENT_SRC_RE = re.compile(r'src="/book/_static/booking\.[0-9a-f]+\.js"')
# `wrangler secret put` returns when Cloudflare accepts the write, not when
# every isolate serving the worker sees it, so the first token-bearing request
# after the swap can still meet the OLD secret and 403. Poll until it doesn't.
TURNSTILE_SWAP_POLL_SECONDS = 3.0
TURNSTILE_SWAP_TIMEOUT_SECONDS = 90.0


def _event_location(event: dict) -> str:
    """B8's calendar-event location text, coalesced to "" for both a missing
    key AND an explicit None — GraphCalendarClient's normalize_graph_event
    always emits a "location" key, but its value is None when Graph's event
    carries no location, never "". A bare `.get("location", "")` default
    never fires in that case, so `BOOKER_PHONE in None` raised TypeError on
    Microsoft."""
    return event.get("location") or ""


def turnstile_secret_var(wrangler_env: str) -> str:
    """The env var holding the wrangler env's own real Turnstile secret —
    TURNSTILE_SECRET_<ENV>, e.g. TURNSTILE_SECRET_DEV. Each env has its own
    Turnstile widget/secret pair (see bin/create-turnstile-widget.py)."""
    return f"TURNSTILE_SECRET_{wrangler_env.upper()}"


def assert_smoke_db(db_id: str, wrangler_env: str) -> None:
    """Deliberately TIGHTER than _smoke_lib.assert_dev_db: this harness's
    direct-D1 cleanup must hit exactly the db the target wrangler_env owns
    — never another db and never prod. Pinned by
    bin/test_booking_smoke_guard.py."""
    if db_id == PROD_DB_ID:
        raise SystemExit("REFUSING TO RUN: D1_DATABASE_ID is the PROD database.")
    expected = _ENV_DB_IDS.get(wrangler_env)
    if expected is None or db_id != expected:
        raise SystemExit(
            f"D1_DATABASE_ID {db_id!r} is not the known db {expected!r} for "
            f"wrangler env {wrangler_env!r}; refusing."
        )


def install_turnstile_secret(repo_root: Path, secret: str, wrangler_env: str = "dev") -> None:
    """Install `secret` as wrangler_env's TURNSTILE_SECRET. Never logs or
    raises with the secret value itself — only the wrangler command and its
    exit code.

    Doesn't reuse `_ct.install_secret`: that one raises `TurnstileError` with
    a "re-run with --force" message written for the widget-minting flow,
    which is actively misleading here — this failure path is printed to the
    operator as a CRITICAL restore failure, not a first-time setup problem.
    `repo_root` is unused here; the parameter only keeps this signature
    uniform with `cleanup_booking_row` below, the other main()-called helper
    in this file, which genuinely needs it for direct D1 access."""
    cmd = _ct.secret_put_command(wrangler_env)
    code = _ct.subprocess_runner(cmd, secret)
    if code != 0:
        raise RuntimeError(f"`{' '.join(cmd)}` exited {code}")


def restore_turnstile_secret(
    repo_root: Path, secret: str, cleaned: list[str], not_cleaned: list[str],
    wrangler_env: str = "dev",
) -> None:
    """Restore wrangler_env's real TURNSTILE_SECRET, recording the outcome in
    the caller's cleanup lists. Catches BaseException, not Exception: a
    Ctrl-C landing in this call would otherwise skip both the CRITICAL
    warning and the CLEANUP summary that prints it, leaving the target env on
    the always-passes test secret with nothing said. An interrupt is
    re-raised after the warning is printed directly — the summary below never
    runs on that path, so this is the only chance to say it."""
    try:
        install_turnstile_secret(repo_root, secret, wrangler_env)
        cleaned.append(f"TURNSTILE_SECRET restored to the real {wrangler_env} secret")
    except BaseException as e:
        cmd = " ".join(_ct.secret_put_command(wrangler_env))
        hint = (
            "'Turnstile Secret - Dev'" if wrangler_env == "dev"
            else f"the item {turnstile_secret_var(wrangler_env)} in .env points at"
        )
        msg = (
            f"CRITICAL: TURNSTILE_SECRET NOT restored to the real {wrangler_env} secret: {e} "
            f"— {wrangler_env}'s booking page now accepts unchallenged claims from any "
            f"public caller. Restore by hand: cd worker && {cmd} (paste the real secret "
            f"from 1Password: {hint})"
        )
        not_cleaned.append(msg)
        if not isinstance(e, Exception):
            print(msg)
            raise


def wait_for_turnstile_swap(probe, sleep, deadline_s: float) -> float:
    """Block until the target env verifies tokens against the swapped-in
    test secret, returning the seconds spent waiting.

    `probe` issues a claim whose location kind the page does not offer and
    returns its status code. The worker checks Turnstile *before* it validates
    the kind, so 403 (challenge_failed) means the swap has not reached this
    isolate yet and 400 (location_unavailable) means it has. That probe is free
    to repeat: neither outcome writes a bookings row, and the rate limiters
    count rows rather than attempts, so polling cannot burn the claim budget.
    """
    waited = 0.0
    while probe() == 403:
        if waited >= deadline_s:
            raise RuntimeError(
                f"TURNSTILE_SECRET swap did not take effect within {deadline_s:.0f}s "
                f"— the booking endpoint still answers challenge_failed against the "
                f"test secret. Aborting before B4 so this isn't mistaken for a real "
                f"B4 failure."
            )
        sleep(TURNSTILE_SWAP_POLL_SECONDS)
        waited += TURNSTILE_SWAP_POLL_SECONDS
    return waited


def cleanup_booking_row(
    repo_root: Path, booking_id: str, wrangler_env: str = "dev",
) -> tuple[bool, str]:
    """Delete the booking's D1 row directly. There is no DELETE endpoint for a
    single booking (the management API only offers GET/PUT booking-page and GET
    bookings), so this is direct D1 access against the target wrangler_env's
    own database, gated the same way bin/meeting-smoke.py gates its D1
    writes. Returns (did_delete, message)."""
    db_id = os.environ.get("D1_DATABASE_ID")
    if not db_id:
        return False, (
            f"D1_DATABASE_ID not set — booking row {booking_id} NOT deleted "
            f"automatically. Clean it up manually:\n"
            f"    cd worker && npx wrangler d1 execute DB --env {wrangler_env} --remote "
            f'--command "DELETE FROM bookings WHERE id = {sql_str(booking_id)}"'
        )
    assert_smoke_db(db_id, wrangler_env)
    DevD1(repo_root=repo_root, env_name=wrangler_env).execute(
        f"DELETE FROM bookings WHERE id = {sql_str(booking_id)}"
    )
    return True, f"booking row {booking_id} deleted from D1 ({wrangler_env})"


def print_cleanup_summary(cleaned: list[str], not_cleaned: list[str]) -> None:
    """The end-of-run CLEANUP block shared by both modes. The "NOT cleaned"
    header is printed only when something was actually left behind — an
    empty header at the very end of a green run read as a failure in the
    runner's log pane (live 2026-09-17, microsoft-base)."""
    print("CLEANUP — cleaned:")
    for c in cleaned:
        print(f"  - {c}")
    if not_cleaned:
        print("CLEANUP — NOT cleaned:")
        for n in not_cleaned:
            print(f"  - {n}")


def run_base_mode(provider: str, wrangler_env: str) -> None:
    """The original B1-B9 full public-flow smoke (see module docstring), now
    provider- and env-aware (2026-09-17). Reads its own env."""
    url = req("SCHEDULER_URL").rstrip("/")
    assert_dev_url(url)
    assert_url_matches_env(url, wrangler_env)
    # D1_DATABASE_ID is optional here (only used for the cleanup-row D1
    # delete), but if it IS set it must be validated up front — before the
    # preflight/Turnstile swap — not merely inside cleanup_booking_row's
    # `finally` call. Validating it only there means a mismatched db id
    # SystemExits OUT of the finally block, skipping the rest of cleanup
    # (the booking page is left enabled and the CLEANUP summary never
    # prints) instead of failing before anything was ever touched.
    early_db_id = os.environ.get("D1_DATABASE_ID")
    if early_db_id:
        assert_smoke_db(early_db_id, wrangler_env)
    real_turnstile_secret = req(turnstile_secret_var(wrangler_env))
    ident = Identity(
        scheduler_url=url,
        bearer=req("A_BEARER"),
        refresh_token=req("A_REFRESH"),
        expected_email=req("A_EXPECTED_EMAIL"),
        client_id=os.environ.get("A_CLIENT_ID", "smoke-cli"),
    )
    sched = SchedulerClient(ident)
    # Preflight: the bearer is who (and which provider) we think it is —
    # before the Turnstile secret is ever swapped, so a wrong cast fails
    # here (nothing to restore yet) rather than mid-run or as a confusing
    # Graph/Google 401.
    preflight_whoami(sched, ident.expected_email, provider, "A")

    cal = make_calendar_client(sched, provider)
    repo_root = Path(__file__).resolve().parent.parent
    public = httpx.Client(timeout=30.0)  # unauthenticated, as a real booker sees it

    booking_id: str | None = None
    google_event_id: str | None = None
    try:
        # Before anything else touches the booking API: swap to the test
        # secret so DUMMY_TURNSTILE_TOKEN keeps working through B1-B9. This
        # has to be inside `try` rather than ahead of it: `wrangler secret
        # put` POSTs to Cloudflare and waits for the ack, so a nonzero exit
        # doesn't prove the write never landed — if it commits on Cloudflare's
        # side but the ack is lost, the target env is left on the test secret
        # with no indication. Only `finally` running unconditionally
        # afterwards catches that case.
        install_turnstile_secret(repo_root, TEST_TURNSTILE_SECRET, wrangler_env)
        print("SETUP — TURNSTILE_SECRET swapped to Cloudflare's test secret for this run")

        # B1 — configure the page
        r = sched.request("PUT", "/v1/booking-page", json={
            "slug": SLUG,
            "enabled": True,
            "durations_minutes": [30],
            "min_notice_minutes": 0,
            "horizon_days": 7,
            # Two pages of 7: B10 pages to the second and expects no third.
            "max_horizon_days": 14,
            "bookable_over_movable_meetings": False,
            "location": {"modes": [{"kind": "phone"}]},
        })
        assert r.status_code == 200, f"B1: configure booking page: {r.status_code} {r.text[:500]!r}"
        assert r.json().get("slug") == SLUG, f"B1: slug not reflected: {r.text[:500]!r}"
        assert r.json().get("max_horizon_days") == 14, f"B1: max_horizon_days not reflected: {r.text[:500]!r}"
        print("B1 PASS — booking page configured (slug=smoke-book, 30-min, phone location, 2 pages of 7 days)")

        # B2 — the public page loads, with its security headers intact
        r = public.get(f"{url}/book/{SLUG}")
        assert r.status_code == 200, f"B2: GET /book/{SLUG}: {r.status_code} {r.text[:500]!r}"
        assert BOOKING_CLIENT_SRC_RE.search(r.text), (
            f"B2: page did not reference the hashed static client module: {r.text[:500]!r}"
        )
        # Only a live deployment proves these survive the edge. The page is an
        # unauthenticated form whose success sends an invitation from the
        # owner's account, so being frameable is a real clickjacking surface.
        csp = r.headers.get("content-security-policy", "")
        for directive in (
            "default-src 'none'",
            "frame-ancestors 'none'",
            # These keep the page WORKING; a CSP that breaks the booking flow is
            # worse than no CSP at all (runbook §K).
            "script-src 'self' https://challenges.cloudflare.com",
            "style-src 'unsafe-inline'",
            "frame-src https://challenges.cloudflare.com",
            # Full directive, not the "connect-src 'self'" prefix: that prefix
            # stayed true when the Turnstile source was added, so it passed
            # while silently no longer checking the source the widget needs.
            "connect-src 'self' https://challenges.cloudflare.com",
        ):
            assert directive in csp, f"B2: CSP missing {directive!r}: {csp!r}"
        xfo = r.headers.get("x-frame-options")
        assert xfo == "DENY", f"B2: X-Frame-Options not DENY: {xfo!r}"
        print("B2 PASS — page loads, references the hashed client module, "
              "CSP + X-Frame-Options served")

        # B3 — bookable slots
        r = public.get(f"{url}/book/{SLUG}/slots", params={"duration": 30})
        assert r.status_code == 200, f"B3: GET slots: {r.status_code} {r.text[:500]!r}"
        slots = r.json().get("slots") or []
        assert slots, f"B3: no bookable slots offered: {r.text[:500]!r}"
        first_slot = slots[0]
        # No `page` param is page 0 — the pre-paging request shape must keep
        # working — and with a 14-day reach over 7-day pages it has a successor.
        page0 = r.json()
        assert page0.get("page") == 0 and page0.get("has_more") is True, (
            f"B3: expected page 0 with has_more: {r.text[:500]!r}"
        )
        print(f"B3 PASS — {len(slots)} bookable slot(s) on page 0 (has_more); first is {first_slot}")

        # B4 — a kind this page does not offer (only "phone" is configured)
        # is refused before any reservation is taken.
        not_offered_body = {
            "start": first_slot,
            "duration_minutes": 30,
            "name": BOOKER_NAME,
            "email": BOOKER_EMAIL,
            "location_kind": "meet",
            "location_detail": None,
            "turnstile_token": DUMMY_TURNSTILE_TOKEN,
        }
        # B1-B3 need no token, so B4 is the first request the swapped secret has
        # to be live for. Wait it out here rather than letting a propagation lag
        # surface as a bogus B4 failure.
        waited = wait_for_turnstile_swap(
            probe=lambda: public.post(f"{url}/book/{SLUG}", json=not_offered_body).status_code,
            sleep=time.sleep,
            deadline_s=TURNSTILE_SWAP_TIMEOUT_SECONDS,
        )
        if waited:
            print(f"SETUP — waited {waited:.0f}s for the TURNSTILE_SECRET swap to reach the edge")

        r = public.post(f"{url}/book/{SLUG}", json=not_offered_body)
        assert r.status_code == 400, f"B4: expected 400 for unoffered kind: {r.status_code} {r.text[:500]!r}"
        assert r.json().get("error") == "location_unavailable", (
            f"B4: expected error=location_unavailable: {r.text[:500]!r}"
        )
        print("B4 PASS — claiming an unoffered location kind rejected 400 location_unavailable")

        # B5 — "phone" is offered but requires a detail; omitting it is refused.
        missing_detail_body = {
            "start": first_slot,
            "duration_minutes": 30,
            "name": BOOKER_NAME,
            "email": BOOKER_EMAIL,
            "location_kind": "phone",
            "location_detail": None,
            "turnstile_token": DUMMY_TURNSTILE_TOKEN,
        }
        r = public.post(f"{url}/book/{SLUG}", json=missing_detail_body)
        assert r.status_code == 400, f"B5: expected 400 for missing detail: {r.status_code} {r.text[:500]!r}"
        assert r.json().get("error") == "invalid_body", (
            f"B5: expected error=invalid_body: {r.text[:500]!r}"
        )
        print("B5 PASS — phone claim missing location_detail rejected 400 invalid_body")

        # B6 — claim the first slot, choosing "phone" and giving the booker's
        # own number
        claim_body = {
            "start": first_slot,
            "duration_minutes": 30,
            "name": BOOKER_NAME,
            "email": BOOKER_EMAIL,
            "location_kind": "phone",
            "location_detail": BOOKER_PHONE,
            "turnstile_token": DUMMY_TURNSTILE_TOKEN,
        }
        r = public.post(f"{url}/book/{SLUG}", json=claim_body)
        assert r.status_code == 201, f"B6: claim slot: {r.status_code} {r.text[:500]!r}"
        booking_id = r.json().get("booking_id")
        assert booking_id, f"B6: no booking_id in response: {r.text[:500]!r}"
        print(f"B6 PASS — claimed {first_slot} as booking {booking_id} (location_kind=phone)")

        # B7 — the same slot is no longer claimable
        r = public.post(f"{url}/book/{SLUG}", json=claim_body)
        assert r.status_code == 409, f"B7: expected 409 on double-claim: {r.status_code} {r.text[:500]!r}"
        assert r.json().get("error") == "slot_unavailable", (
            f"B7: expected error=slot_unavailable: {r.text[:500]!r}"
        )
        print("B7 PASS — double-claim rejected 409 slot_unavailable")

        # B8 — the booking is listed, confirmed, with a real calendar event
        # that carries the booker's own number and not any owner-supplied one
        window_from = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        window_to = (datetime.now(timezone.utc) + timedelta(days=8)).isoformat()
        r = sched.request("GET", "/v1/bookings", params={"from": window_from, "to": window_to})
        assert r.status_code == 200, f"B8: GET /v1/bookings: {r.status_code} {r.text[:500]!r}"
        rows = [b for b in r.json().get("bookings", []) if b.get("id") == booking_id]
        assert rows, f"B8: booking {booking_id} not listed: {r.text[:500]!r}"
        row = rows[0]
        assert row.get("status") == "confirmed", f"B8: expected confirmed, got {row!r}"
        assert row.get("location_kind") == "phone", f"B8: expected location_kind=phone, got {row!r}"
        assert row.get("location_detail") == BOOKER_PHONE, (
            f"B8: booking row location_detail does not match the booker's number: {row!r}"
        )
        google_event_id = row.get("google_event_id")
        assert google_event_id, f"B8: google_event_id is null: {row!r}"

        # The row alone doesn't prove the calendar event was actually built
        # from it — read the live event back and check its location text.
        events = cal.list_events(window_from, window_to)
        matches = [e for e in events if e.get("id") == google_event_id]
        assert matches, f"B8: calendar event {google_event_id} not found via events.list"
        event_location = _event_location(matches[0])
        assert BOOKER_PHONE in event_location, (
            f"B8: booker's number missing from calendar event location: {event_location!r}"
        )
        assert LEGACY_OWNER_PHONE_SENTINEL not in event_location, (
            f"B8: an owner-supplied number leaked onto the calendar event: {event_location!r}"
        )
        print(
            f"B8 PASS — booking confirmed with calendar event {google_event_id}, "
            f"location carries the booker's number only"
        )

        # B9 — the claimed start is no longer offered
        r = public.get(f"{url}/book/{SLUG}/slots", params={"duration": 30})
        assert r.status_code == 200, f"B9: GET slots: {r.status_code} {r.text[:500]!r}"
        remaining = r.json().get("slots") or []
        assert first_slot not in remaining, (
            f"B9: claimed start {first_slot} was still offered: {r.text[:500]!r}"
        )
        print("B9 PASS — claimed start no longer offered")

        # B10 — paging: page 1 is a distinct, later window; nothing past the
        # reach, and junk page values, are refused before any calendar read.
        r = public.get(f"{url}/book/{SLUG}/slots", params={"duration": 30, "page": 1})
        assert r.status_code == 200, f"B10: GET slots page 1: {r.status_code} {r.text[:500]!r}"
        page1 = r.json()
        assert page1.get("page") == 1 and page1.get("has_more") is False, (
            f"B10: expected the last page (page 1, no more): {r.text[:500]!r}"
        )
        page0_end = page0["window"]["end"]
        page1_starts = page1.get("slots") or []
        # A weekday must fall inside any 7-day window, so page 1 is never
        # legitimately empty for a Mon-Fri owner.
        assert page1_starts, f"B10: page 1 offered nothing: {r.text[:500]!r}"
        # ISO-8601 UTC strings compare chronologically. Page 1's window starts
        # where page 0's ended (to within the ms of clock drift between the two
        # requests), and starts sit on a :00/:30 grid, so every start on it
        # lies past page 0's end.
        assert all(s >= page0_end for s in page1_starts), (
            f"B10: page 1 start before page 0's end {page0_end}: {page1_starts[:3]!r}"
        )
        assert first_slot not in page1_starts, "B10: page 0's first slot leaked onto page 1"
        r = public.get(f"{url}/book/{SLUG}/slots", params={"duration": 30, "page": 2})
        assert r.status_code == 400 and r.json().get("error") == "page_out_of_range", (
            f"B10: page 2 past the 14-day reach: {r.status_code} {r.text[:500]!r}"
        )
        r = public.get(f"{url}/book/{SLUG}/slots", params={"duration": 30, "page": "abc"})
        assert r.status_code == 400 and r.json().get("error") == "invalid_page", (
            f"B10: page=abc: {r.status_code} {r.text[:500]!r}"
        )
        print(f"B10 PASS — page 1 holds {len(page1_starts)} later slot(s), page 2 out of range, junk page rejected")
        print("ALL PASS")
    finally:
        cleaned: list[str] = []
        not_cleaned: list[str] = []

        # Runs first, ahead of the calendar/D1/page-disable cleanup below: of
        # everything in this block, a stuck test secret is the one with a live
        # security consequence (the target env's booking page would accept
        # unchallenged claims from a public host, on the operator's real connected
        # calendar account, until manually fixed), so a failure here is
        # called out as CRITICAL rather than folded into the ordinary
        # "NOT cleaned" list.
        restore_turnstile_secret(
            repo_root, real_turnstile_secret, cleaned, not_cleaned, wrangler_env
        )

        if google_event_id:
            try:
                cal.delete_event(google_event_id)
                cleaned.append(f"calendar event {google_event_id} deleted")
            except Exception as e:
                not_cleaned.append(f"calendar event {google_event_id} NOT deleted: {e}")
        else:
            not_cleaned.append("no google_event_id captured — nothing to delete on the calendar")

        if booking_id:
            did_delete, message = cleanup_booking_row(repo_root, booking_id, wrangler_env)
            (cleaned if did_delete else not_cleaned).append(message)
        else:
            not_cleaned.append("no booking_id captured — no bookings row to delete")

        try:
            r = sched.request("PUT", "/v1/booking-page", json={"enabled": False})
            if r.status_code == 200:
                cleaned.append("booking page set enabled=false")
            else:
                not_cleaned.append(
                    f"could not disable booking page: {r.status_code} {r.text[:200]!r}"
                )
        except Exception as e:
            not_cleaned.append(f"could not disable booking page: {e}")

        print_cleanup_summary(cleaned, not_cleaned)

        sched.close()
        cal.close()
        public.close()


# =============================================================================
# --mode decline: booking-page decline auto-cancel (docs/runbook.md §M)
# =============================================================================

DECLINE_SLUG = "smoke-book-decline"
ATTENDEE_BOOKER_NAME = "Booking Decline Smoke Attendee"
ATTENDEE_PHONE = "+61 4 1111 2222"
# The claimed slot's start has to stay in the FUTURE through detection
# (webhook/change-notification push latency), the forced sweep's wrangler
# boot, and the (env-shortened) grace period — a few minutes, worst case.
# min_notice=0 (as base mode uses) can return a slot starting momentarily,
# which the sweep's own future-start check would then treat as "already
# started" and abort instead of cancel. Base mode is intentionally left
# alone — it never waits this long between claiming and checking.
DECLINE_MIN_NOTICE_MINUTES = 90

# The webhook-side detection stamp (Card C) fires off a real push
# notification reaching the OWNER's calendar (a Google push channel or a
# Graph change notification, depending on provider) after the attendee's
# RSVP change propagates — not instant. Generous but bounded.
CANCEL_PENDING_POLL_TIMEOUT_S = 180.0
CANCEL_PENDING_POLL_INTERVAL_S = 5.0
# Email delivery (Gmail or Graph Sent Items, depending on provider) is async
# relative to the worker's own HTTP response.
EMAIL_POLL_TIMEOUT_S = 90.0
EMAIL_POLL_INTERVAL_S = 5.0
# How long to give `wrangler dev --test-scheduled` to start serving.
WRANGLER_DEV_READY_TIMEOUT_S = 90.0
WRANGLER_DEV_PORT = 8787
# /__scheduled blocks until the WHOLE forced cron branch finishes — remote D1
# reads/writes, a live calendar getEvent + deleteEvent, and two notification
# sends — not just until the request is accepted. This has to be generous,
# and deliberately separate from the readiness-probe timeout above (see
# force_scheduled_cron's docstring).
WRANGLER_SCHEDULED_TIMEOUT_S = 180.0
# Must match BOOKING_DECLINE_GRACE_MINUTES under every smoke env's vars in
# worker/wrangler.toml ([env.dev]): the sweep applies the grace cutoff
# ITSELF (listCancelPendingDue only returns rows with cancel_pending_at <=
# now - grace), so force-firing the cron does not bypass it — the harness has
# to wait the stamp out first (seconds_until_sweep_due) or the forced fire
# finds zero due rows and D8 times out.
SMOKE_GRACE_MINUTES = 1
# Covers clock skew between the worker's stamp and this machine's clock.
SWEEP_DUE_BUFFER_S = 10.0


def seconds_until_sweep_due(
    cancel_pending_at_iso: str, now_epoch: float,
    grace_minutes: int, buffer_s: float = SWEEP_DUE_BUFFER_S,
) -> float:
    """Seconds to wait before a force-fired sweep will consider the stamp due."""
    stamp = datetime.fromisoformat(
        cancel_pending_at_iso.replace("Z", "+00:00")
    ).timestamp()
    return max(0.0, stamp + grace_minutes * 60.0 + buffer_s - now_epoch)


def _booking_row(d1: "_smoke_lib.DevD1", booking_id: str) -> dict | None:
    rows = d1.query(f"SELECT * FROM bookings WHERE id = {sql_str(booking_id)}")
    return rows[0] if rows else None


def wait_for_booking_row(
    d1: "_smoke_lib.DevD1", booking_id: str, predicate, description: str,
    timeout: float, interval: float = 5.0,
) -> dict:
    """Poll the `bookings` row for `booking_id` until `predicate(row)` is
    true. Returns the matching row. Raises AssertionError (with the
    last-seen row) on timeout."""
    deadline = time.monotonic() + timeout
    last_row: dict | None = None
    while time.monotonic() < deadline:
        last_row = _booking_row(d1, booking_id)
        if last_row is not None and predicate(last_row):
            return last_row
        time.sleep(interval)
    raise AssertionError(
        f"timed out after {timeout:.0f}s waiting for {description} on "
        f"booking {booking_id}; last row seen: {last_row!r}"
    )


def gmail_sent_query(to_email: str, subject_substring: str, after_epoch: int) -> str:
    """Gmail search-syntax query for a message the OWNER's own Gmail account
    sent (both decline-cancel emails are sent FROM the owner's account —
    booking-decline-sweep.ts builds its NotificationProvider off the owner
    subject for both the booker and the owner recipient, so both land in the
    OWNER's Sent folder — same infra bin/poll-smoke.py's mailbox read relies
    on, just read from Sent instead of inferred from it) to `to_email`,
    subject containing `subject_substring`, at/after `after_epoch` (unix
    seconds, same convention as poll-smoke's gmail_query)."""
    return f'in:sent to:{to_email} subject:"{subject_substring}" after:{after_epoch}'


def graph_sent_matches(messages: list[dict], to_email: str, subject_substring: str) -> bool:
    """True if any Graph message resource (as returned by
    _smoke_lib.GraphMailClient.list_sent_since, which filters only on
    sentDateTime server-side) has `subject_substring` in its subject and
    `to_email` among its toRecipients — the client-side half of the match,
    mirroring poll-smoke's GraphReader split (Graph rejects filtering and
    sorting on different properties, so recipient/subject matching happens
    here instead of server-side). Recipient match is case-insensitive
    (Exchange returns addresses as the directory has them); subject is a
    plain substring match, like the Gmail query's subject:"..."."""
    target = to_email.casefold()
    for m in messages:
        subject = m.get("subject") or ""
        if subject_substring not in subject:
            continue
        recipients = {
            ((r.get("emailAddress") or {}).get("address") or "").casefold()
            for r in (m.get("toRecipients") or [])
        }
        if target in recipients:
            return True
    return False


class GmailSentReader:
    """Wraps _smoke_lib.GmailClient behind the find_sent(to_email,
    subject_substring, after_epoch) -> bool protocol shared with
    GraphSentReader — gmail_sent_query does the recipient/subject match
    server-side, so find_sent is just "did the query return anything"."""

    def __init__(self, client: "_smoke_lib.GmailClient"):
        self._client = client

    def find_sent(self, to_email: str, subject_substring: str, after_epoch: int) -> bool:
        query = gmail_sent_query(to_email, subject_substring, after_epoch)
        return bool(self._client.list_messages(query))

    def close(self) -> None:
        self._client.close()


class GraphSentReader:
    """Wraps _smoke_lib.GraphMailClient behind the same find_sent protocol.
    list_sent_since filters only on sentDateTime server-side; graph_sent_matches
    does the recipient/subject match client-side — same division of labour as
    GmailSentReader, opposite property."""

    def __init__(self, client: "_smoke_lib.GraphMailClient"):
        self._client = client

    def find_sent(self, to_email: str, subject_substring: str, after_epoch: int) -> bool:
        messages = self._client.list_sent_since(after_epoch)
        return graph_sent_matches(messages, to_email, subject_substring)

    def close(self) -> None:
        self._client.close()


def make_sent_reader(scheduler: "_smoke_lib.SchedulerClient", provider: str):
    """GmailSentReader (Google) or GraphSentReader (Microsoft) — the decline
    mode's owner-Sent-folder provider factory, mirroring
    _smoke_lib.make_calendar_client / poll-smoke's make_mail_reader."""
    if provider == "google":
        return GmailSentReader(GmailClient(scheduler))
    if provider == "microsoft":
        return GraphSentReader(GraphMailClient(scheduler))
    raise ValueError(f"unknown mail provider {provider!r}; expected one of {_smoke_lib.PROVIDERS}")


def wait_for_sent_email(
    reader, to_email: str, subject_substring: str,
    after_epoch: int, label: str, timeout: float = EMAIL_POLL_TIMEOUT_S,
    interval: float = EMAIL_POLL_INTERVAL_S,
) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if reader.find_sent(to_email, subject_substring, after_epoch):
            return
        time.sleep(interval)
    raise AssertionError(
        f"{label} email not found within {timeout:.0f}s "
        f"(to={to_email!r}, subject contains {subject_substring!r})"
    )


def force_scheduled_cron(
    repo_root: Path, cron_expr: str, wrangler_env: str = "dev",
    port: int = WRANGLER_DEV_PORT, ready_timeout: float = WRANGLER_DEV_READY_TIMEOUT_S,
    scheduled_timeout: float = WRANGLER_SCHEDULED_TIMEOUT_S,
) -> httpx.Response:
    """Force a specific cron branch to run for real, against live remote
    bindings (live D1 + deployed secrets) — the cookie-free alternative
    (docs/runbook.md §E "Cookie-free alternative"): spawn `npx wrangler dev
    --env <wrangler_env> --remote --test-scheduled --port <port>
    --inspector-port 0`, wait for it to start serving, GET
    /__scheduled?cron=<cron_expr>, then always tear the subprocess down
    (SIGTERM, escalating to kill() if it doesn't exit).

    Two DELIBERATELY DIFFERENT timeouts: `ready_timeout` bounds only the
    readiness poll (cheap GET /), while `scheduled_timeout` bounds the
    /__scheduled call itself — that request blocks until the WHOLE forced
    cron branch finishes (remote D1 reads/writes, a live calendar getEvent +
    deleteEvent, two notification sends for the booking-decline sweep), not
    until it's merely accepted. Sharing one short timeout between the two would
    let a ReadTimeout on /__scheduled tear wrangler down mid-sweep, which
    can leave a booking's event deleted with the D1 CAS never applied.

    `--port` pins the port explicitly: without it, an already-running
    `wrangler dev` elsewhere on the machine holds 8787 and this fresh
    instance silently falls back to 8788, so the readiness probe below
    would hit the STALE instance while the fresh one never gets its
    /__scheduled hit. `--inspector-port 0` disables the devtools inspector
    (an unused port this harness doesn't need). `stdin=DEVNULL`: wrangler's
    interactive hotkey UI otherwise grabs the tty and can leave it in raw
    mode when this subprocess is killed. stdout goes to a temp file, not
    `PIPE` — wrangler's own boot chatter can exceed the OS pipe buffer
    (~64KB), which would deadlock the readiness-poll loop below waiting on
    a pipe nothing is draining; the early-exit error path below still
    quotes the tail of it.

    Credential injection is external (this harness must already be running
    under `op run`, same as every other wrangler/D1 call in this file) —
    this helper does not wrap the command in its own `op run`.

    The target env's real */5 * * * * cron is ALSO live, so this forced run
    races it; both are idempotent against the same D1 state, so a race is
    harmless."""
    cmd = [
        "npx", "wrangler", "dev", "--env", wrangler_env, "--remote", "--test-scheduled",
        "--port", str(port), "--inspector-port", "0",
    ]
    log_file = tempfile.NamedTemporaryFile(
        mode="w+", prefix="booking-smoke-wrangler-dev-", suffix=".log", delete=False,
    )
    proc = subprocess.Popen(
        cmd, cwd=str(repo_root / "worker"),
        stdin=subprocess.DEVNULL, stdout=log_file, stderr=subprocess.STDOUT, text=True,
    )
    base = f"http://localhost:{port}"
    client = httpx.Client(timeout=10.0)
    try:
        deadline = time.monotonic() + ready_timeout
        while True:
            if proc.poll() is not None:
                log_file.flush()
                raise RuntimeError(
                    f"`{' '.join(cmd)}` exited early (code {proc.returncode}) "
                    f"before serving — full output: {log_file.name}"
                )
            try:
                r = client.get(base + "/")
                if r.status_code < 500:
                    break
            except httpx.TransportError:
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError(
                    f"wrangler dev --test-scheduled did not start serving on "
                    f"{base} within {ready_timeout:.0f}s — output: {log_file.name}"
                )
            time.sleep(1.0)
        return client.get(
            f"{base}/__scheduled", params={"cron": cron_expr}, timeout=scheduled_timeout,
        )
    finally:
        client.close()
        proc.terminate()
        try:
            proc.wait(timeout=10.0)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10.0)
        log_file.close()


def _claim_decline_slot(
    public: httpx.Client, url: str, slug: str, start: str, name: str, email: str,
) -> httpx.Response:
    return public.post(f"{url}/book/{slug}", json={
        "start": start,
        "duration_minutes": 30,
        "name": name,
        "email": email,
        "location_kind": "phone",
        "location_detail": ATTENDEE_PHONE,
        "turnstile_token": DUMMY_TURNSTILE_TOKEN,
    })


def _decline_invite(organiser_cal, attendee_cal, event_id: str, self_email: str) -> None:
    """Thin wrapper over the shared, provider-neutral `rsvp_as_attendee`
    (bin/_smoke_lib.py), pinned to response='declined' for this file's D5
    and abort-path decline steps. Provider-neutral (2026-09-17 review fix):
    the harness used to call rsvp_invite directly, which is Google-only (it
    builds a Google REST URL off attendee_cal.BASE/_calendar_id and PATCHes a
    Google attendees array) — AttributeError on a GraphCalendarClient, and
    Graph gives each attendee's copy a DIFFERENT event id from the
    organiser's anyway, so the organiser's id wouldn't even locate the right
    copy there. rsvp_as_attendee resolves whichever identifier attendee_cal's
    provider needs without this call site branching on provider itself —
    same shape as bin/meeting-smoke.py's accept_invite."""
    rsvp_as_attendee(organiser_cal, attendee_cal, event_id, self_email, "declined")


def _accept_invite(organiser_cal, attendee_cal, event_id: str, self_email: str) -> None:
    """Thin wrapper over the shared `rsvp_as_attendee`, pinned to
    response='accepted' for the abort path's re-accept step."""
    rsvp_as_attendee(organiser_cal, attendee_cal, event_id, self_email, "accepted")


def run_decline_mode(provider: str, wrangler_env: str) -> None:
    """Decline-triggered auto-cancel smoke (docs/runbook.md §M). See the
    module docstring's "--mode decline" section for the full flow and env
    requirements."""
    url = req("SCHEDULER_URL").rstrip("/")
    assert_dev_url(url)
    assert_url_matches_env(url, wrangler_env)
    db_id = req("D1_DATABASE_ID")
    assert_smoke_db(db_id, wrangler_env)
    real_turnstile_secret = req(turnstile_secret_var(wrangler_env))
    owner_ident = Identity(
        scheduler_url=url,
        bearer=req("A_BEARER"),
        refresh_token=req("A_REFRESH"),
        expected_email=req("A_EXPECTED_EMAIL"),
        client_id=os.environ.get("A_CLIENT_ID", "smoke-cli"),
    )
    attendee_ident = Identity(
        scheduler_url=url,
        bearer=req("C_BEARER"),
        refresh_token=req("C_REFRESH"),
        expected_email=req("C_EXPECTED_EMAIL"),
        client_id=os.environ.get("C_CLIENT_ID", "smoke-cli"),
    )
    attendee_email = attendee_ident.expected_email

    owner_sched = SchedulerClient(owner_ident)
    preflight_whoami(owner_sched, owner_ident.expected_email, provider, "A")
    attendee_sched = SchedulerClient(attendee_ident)
    # If C's preflight fails, owner_sched must not leak: preflight_whoami
    # already closes attendee_sched itself on this failure path, but it has
    # no way to know about owner_sched (already-successful A), so this
    # caller closes it explicitly before re-raising.
    try:
        preflight_whoami(attendee_sched, attendee_ident.expected_email, provider, "C")
    except SystemExit:
        owner_sched.close()
        raise

    owner_cal = make_calendar_client(owner_sched, provider)
    owner_mail = make_sent_reader(owner_sched, provider)
    attendee_cal = make_calendar_client(attendee_sched, provider)
    repo_root = Path(__file__).resolve().parent.parent
    public = httpx.Client(timeout=30.0)
    d1 = DevD1(repo_root=repo_root, env_name=wrangler_env)

    run_start_epoch = int(time.time())
    booking_id: str | None = None
    google_event_id: str | None = None
    abort_booking_id: str | None = None
    abort_google_event_id: str | None = None
    try:
        install_turnstile_secret(repo_root, TEST_TURNSTILE_SECRET, wrangler_env)
        print("SETUP — TURNSTILE_SECRET swapped to Cloudflare's test secret for this run")

        # D1 — configure the page (same shape as B1, but a distinct slug —
        # for keeping this mode's rows/events identifiable, NOT for
        # concurrency: config_booking_page is one row per owner_subject, so
        # a concurrently-run --mode base would still overwrite this PUT
        # wholesale, 404-ing whichever mode ran first. Don't run base and
        # decline modes at the same time against the same owner — see
        # docs/runbook.md §M).
        r = owner_sched.request("PUT", "/v1/booking-page", json={
            "slug": DECLINE_SLUG,
            "enabled": True,
            "durations_minutes": [30],
            "min_notice_minutes": DECLINE_MIN_NOTICE_MINUTES,
            "horizon_days": 14,
            "bookable_over_movable_meetings": False,
            "location": {"modes": [{"kind": "phone"}]},
        })
        assert r.status_code == 200, f"D1: configure booking page: {r.status_code} {r.text[:500]!r}"
        print(f"D1 PASS — booking page configured (slug={DECLINE_SLUG})")

        # Probe with an unoffered kind ("meet" — this page only offers
        # "phone"), same shape as base mode's B4: `locationForEvent` rejects
        # it with 400 before any D1/calendar work, so polling this in a loop
        # is cheap and never touches computeAvailability or the rate
        # limiters (unlike probing with a real, offered kind would).
        probe_body = {
            "start": "2099-01-01T00:00:00Z",
            "duration_minutes": 30,
            "name": ATTENDEE_BOOKER_NAME,
            "email": attendee_email,
            "location_kind": "meet",
            "location_detail": None,
            "turnstile_token": DUMMY_TURNSTILE_TOKEN,
        }
        waited = wait_for_turnstile_swap(
            probe=lambda: public.post(f"{url}/book/{DECLINE_SLUG}", json=probe_body).status_code,
            sleep=time.sleep,
            deadline_s=TURNSTILE_SWAP_TIMEOUT_SECONDS,
        )
        if waited:
            print(f"SETUP — waited {waited:.0f}s for the TURNSTILE_SECRET swap to reach the edge")

        def next_slot() -> str:
            r = public.get(f"{url}/book/{DECLINE_SLUG}/slots", params={"duration": 30})
            assert r.status_code == 200, f"D2: GET slots: {r.status_code} {r.text[:500]!r}"
            slots = r.json().get("slots") or []
            assert slots, f"D2: no bookable slots offered: {r.text[:500]!r}"
            return slots[0]

        # D2/D3 — the attendee claims a slot with their own real email, so
        # its notification delivery — and its RSVP — are both real.
        first_slot = next_slot()
        r = _claim_decline_slot(public, url, DECLINE_SLUG, first_slot, ATTENDEE_BOOKER_NAME, attendee_email)
        assert r.status_code == 201, f"D3: claim slot: {r.status_code} {r.text[:500]!r}"
        booking_id = r.json().get("booking_id")
        assert booking_id, f"D3: no booking_id in response: {r.text[:500]!r}"
        print(f"D3 PASS — claimed {first_slot} as booking {booking_id} for {attendee_email}")

        # D4 — wait for the claim to confirm (calendar write + confirmBooking)
        # and capture the real google_event_id.
        row = wait_for_booking_row(
            d1, booking_id, lambda r: r.get("status") == "confirmed",
            "status='confirmed'", timeout=60.0, interval=3.0,
        )
        google_event_id = row["google_event_id"]
        assert google_event_id, f"D4: confirmed row has no google_event_id: {row!r}"
        print(f"D4 PASS — booking confirmed, calendar event {google_event_id}")

        # D5 — decline on the ATTENDEE's own copy of the event.
        _decline_invite(owner_cal, attendee_cal, google_event_id, attendee_email)
        print(f"D5 PASS — {attendee_email} declined the invite")

        # D6 — the webhook-side detector (booking/decline-cancel.ts) stamps
        # cancel_pending_at once the provider's push/change notification
        # reaches the owner's calendar and runWebhookReplan sees the decline.
        stamped = wait_for_booking_row(
            d1, booking_id, lambda r: r.get("cancel_pending_at") is not None,
            "cancel_pending_at stamped (webhook detection)",
            timeout=CANCEL_PENDING_POLL_TIMEOUT_S, interval=CANCEL_PENDING_POLL_INTERVAL_S,
        )
        print("D6 PASS — cancel_pending_at stamped")

        # D7 — force the */5 * * * * sweep so this run doesn't have to wait
        # for the real cron's own cadence. Forcing does NOT bypass the grace
        # cutoff (the sweep computes due-ness itself), so wait the stamp out
        # first — with the target env's 1-minute grace this is at most ~70s.
        due_wait = seconds_until_sweep_due(
            stamped["cancel_pending_at"], time.time(), SMOKE_GRACE_MINUTES,
        )
        if due_wait > 0:
            print(f"D7 — waiting {due_wait:.0f}s for the {SMOKE_GRACE_MINUTES}-min grace to elapse")
            time.sleep(due_wait)
        resp = force_scheduled_cron(repo_root, "*/5 * * * *", wrangler_env=wrangler_env)
        assert resp.status_code == 200, (
            f"D7: /__scheduled?cron=*/5+*+*+*+*: {resp.status_code} {resp.text[:500]!r}"
        )
        print("D7 PASS — forced the booking-decline sweep")

        # D8 — the sweep re-verified (still all-declined, still future),
        # deleted the event, and CAS'd the row to 'cancelled'.
        wait_for_booking_row(
            d1, booking_id, lambda r: r.get("status") == "cancelled",
            "status='cancelled'", timeout=30.0, interval=3.0,
        )
        print("D8 PASS — booking row cancelled")

        events = owner_cal.list_events(
            (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(),
            (datetime.now(timezone.utc) + timedelta(days=15)).isoformat(),
        )
        assert not any(e.get("id") == google_event_id for e in events), (
            f"D9: calendar event {google_event_id} still present after the sweep"
        )
        print("D9 PASS — calendar event deleted")

        # D10 — both notification emails landed in the OWNER's Sent folder/
        # Sent Items (both are sent from the owner's own mailbox — Gmail on
        # Google, Graph Sent Items on Microsoft).
        wait_for_sent_email(
            owner_mail, attendee_email, "Cancelled: your", run_start_epoch, "booker cancellation",
        )
        print("D10a PASS — booker cancellation email found in owner's Sent folder")
        wait_for_sent_email(
            owner_mail, owner_ident.expected_email,
            f"Booking cancelled: {ATTENDEE_BOOKER_NAME} declined",
            run_start_epoch, "owner heads-up",
        )
        print("D10b PASS — owner heads-up email found in owner's Sent folder")
        print("DECLINE PASS")

        # --- Abort path: decline, then re-accept before the (dev-shortened)
        # grace elapses. A second, independent booking so the already-fired
        # cancellation above can't interfere. ---
        second_slot = next_slot()
        r = _claim_decline_slot(public, url, DECLINE_SLUG, second_slot, ATTENDEE_BOOKER_NAME, attendee_email)
        assert r.status_code == 201, f"A1: claim slot: {r.status_code} {r.text[:500]!r}"
        abort_booking_id = r.json().get("booking_id")
        assert abort_booking_id, f"A1: no booking_id in response: {r.text[:500]!r}"
        print(f"A1 PASS — claimed {second_slot} as booking {abort_booking_id}")

        row = wait_for_booking_row(
            d1, abort_booking_id, lambda r: r.get("status") == "confirmed",
            "status='confirmed'", timeout=60.0, interval=3.0,
        )
        abort_google_event_id = row["google_event_id"]
        assert abort_google_event_id, f"A1: confirmed row has no google_event_id: {row!r}"

        _decline_invite(owner_cal, attendee_cal, abort_google_event_id, attendee_email)
        wait_for_booking_row(
            d1, abort_booking_id, lambda r: r.get("cancel_pending_at") is not None,
            "cancel_pending_at stamped (webhook detection)",
            timeout=CANCEL_PENDING_POLL_TIMEOUT_S, interval=CANCEL_PENDING_POLL_INTERVAL_S,
        )
        print("A2 PASS — declined and cancel_pending_at stamped")

        # Re-accept promptly — the whole point is to beat the grace period
        # (the target env sets BOOKING_DECLINE_GRACE_MINUTES="1"). But its
        # REAL */5 * * * * cron is also live and can legitimately win this race:
        # the stamp can sit due-and-uncleared for up to ~4 minutes (grace +
        # cron cadence) before our re-accept's clearCancelPending fires, and
        # if the real sweep beats it, the row flips to 'cancelled' — a
        # status markCancelled never clears cancel_pending_at from, so
        # waiting for that column to go NULL would hang for the full
        # timeout on this path instead of failing fast. Wait for EITHER
        # outcome and branch: a clean abort passes A3/A4 for real; the real
        # cron winning is a documented, harmless race (see the module
        # docstring), not a harness bug — skip A3/A4 rather than fail on it.
        _accept_invite(owner_cal, attendee_cal, abort_google_event_id, attendee_email)
        row = wait_for_booking_row(
            d1, abort_booking_id,
            lambda r: r.get("cancel_pending_at") is None or r.get("status") == "cancelled",
            "cancel_pending_at cleared (un-decline abort) OR row cancelled "
            "(real cron won the race)",
            timeout=CANCEL_PENDING_POLL_TIMEOUT_S, interval=CANCEL_PENDING_POLL_INTERVAL_S,
        )

        if row.get("status") == "cancelled":
            print(
                "A3/A4 SKIPPED — the real */5 * * * * cron won the race against "
                "the re-accept before cancel_pending_at could clear; this is a "
                "documented, harmless race (the target env's grace is only 1 "
                "minute), not a harness failure — see the module docstring's race note"
            )
        else:
            print("A3 PASS — re-accepted; cancel_pending_at cleared")
            assert row.get("status") == "confirmed", (
                f"A4: abort-path booking is neither 'confirmed' nor 'cancelled': {row!r}"
            )
            events = owner_cal.list_events(
                (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(),
                (datetime.now(timezone.utc) + timedelta(days=15)).isoformat(),
            )
            assert any(e.get("id") == abort_google_event_id for e in events), (
                f"A4: abort-path calendar event {abort_google_event_id} is missing "
                f"despite the row reading 'confirmed' — this is a real failure, not "
                f"the documented race (that path is already handled above)"
            )
            print("A4 PASS — abort path held: event survives, row still confirmed")
        print("ALL PASS")
    finally:
        cleaned: list[str] = []
        not_cleaned: list[str] = []

        restore_turnstile_secret(repo_root, real_turnstile_secret, cleaned, not_cleaned, wrangler_env)

        for label, event_id in (("decline", google_event_id), ("abort-path", abort_google_event_id)):
            if event_id:
                try:
                    owner_cal.delete_event(event_id)
                    cleaned.append(f"{label} calendar event {event_id} deleted")
                except Exception as e:
                    not_cleaned.append(f"{label} calendar event {event_id} NOT deleted: {e}")
            else:
                # Never captured means never created (the run died earlier) —
                # that's "nothing to clean", not a cleanup failure.
                cleaned.append(f"{label} calendar event never created — nothing to delete")

        for label, bid in (("decline", booking_id), ("abort-path", abort_booking_id)):
            if bid:
                try:
                    d1.execute(f"DELETE FROM bookings WHERE id = {sql_str(bid)}")
                    cleaned.append(f"{label} booking row {bid} deleted from D1 ({wrangler_env})")
                except Exception as e:
                    not_cleaned.append(f"{label} booking row {bid} NOT deleted: {e}")
            else:
                cleaned.append(f"{label} booking row never created — nothing to delete")

        try:
            r = owner_sched.request("PUT", "/v1/booking-page", json={"enabled": False})
            if r.status_code == 200:
                cleaned.append("booking page set enabled=false")
            else:
                not_cleaned.append(
                    f"could not disable booking page: {r.status_code} {r.text[:200]!r}"
                )
        except Exception as e:
            not_cleaned.append(f"could not disable booking page: {e}")

        print_cleanup_summary(cleaned, not_cleaned)

        owner_sched.close()
        owner_cal.close()
        owner_mail.close()
        attendee_sched.close()
        attendee_cal.close()
        public.close()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode", choices=["base", "decline"], default="base",
        help="'base' (default): B1-B9 full public-flow smoke. 'decline': "
             "decline-triggered auto-cancel smoke (docs/runbook.md §M).",
    )
    parser.add_argument(
        "--provider", choices=list(_smoke_lib.PROVIDERS),
        # `or "google"`, not a default= of the env value: SMOKE_PROVIDER=""
        # (a common shell artifact) would otherwise become argparse's literal
        # default and bypass `choices` (poll-smoke WP2 finding 6).
        default=os.environ.get("SMOKE_PROVIDER") or "google",
        help="Calendar provider A_BEARER was minted for (default: $SMOKE_PROVIDER "
             "or google). Picks the client the flow runs through and is checked "
             "against GET /v1/whoami in preflight, before the Turnstile secret "
             "is ever swapped.",
    )
    parser.add_argument(
        "--wrangler-env", choices=list(WRANGLER_ENVS), dest="wrangler_env",
        default=os.environ.get("SMOKE_WRANGLER_ENV") or "dev",
        help="Deployment to run against (default: $SMOKE_WRANGLER_ENV or dev). "
             "Picks the Turnstile secret restored in cleanup (TURNSTILE_SECRET_"
             "<ENV>) and pins the direct-D1 cleanup to that env's own database.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    # Line-buffer our own stdout: wrangler writes straight to the terminal while
    # this process's prints sit in a block buffer when piped, so the swap/restore
    # subprocess output otherwise lands ahead of the step lines that explain it —
    # and the wait below would show nothing at all until the run ended.
    sys.stdout.reconfigure(line_buffering=True)
    args = parse_args(argv)
    if args.mode == "decline":
        run_decline_mode(args.provider, args.wrangler_env)
    else:
        run_base_mode(args.provider, args.wrangler_env)


if __name__ == "__main__":
    main()
