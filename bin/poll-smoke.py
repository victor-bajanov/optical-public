#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""Live smoke for the meeting-poll feature (scheduler-dev only).

Exercises the full poll lifecycle end to end against a deployed dev
environment: create -> invite -> paint -> the authenticated organiser status
page -> auto-book -> pinned import, plus the post-wave manual-nudge contract,
an unhappy (disjoint-paint -> needs_attention) path, and a hidden-invitee
variant (one invitee hides their name; asserts they're excluded from the
booked event's attendees). Structured like bin/booking-smoke.py /
bin/meeting-smoke.py: PEP 723 + uv, _smoke_lib's bearer/calendar clients,
secrets injected externally (`op run --env-file=.env -- uv run
bin/poll-smoke.py`), all output redirected to a file when run:

    op run --env-file=.env -- uv run bin/poll-smoke.py > /tmp/poll-smoke.out 2>&1

Written against the POST-WAVE-3 contract (this feature's stage-1 fan-out is
still landing across parallel worktrees as this harness is written):
  - manual nudge is valid on an OPEN poll only (409 invalid_status otherwise)
  - PUT /poll/:id/response's aggregate cells carry freeWho/ifNeededWho arrays
  - guest join returns 202 {sent:true} with no URL — NOT exercised here (the
    harness only ever needs per-invitee links, which guest join deliberately
    stopped returning)
  - the booked calendar event's attendees are the non-dropped, NON-HIDDEN
    invitees (hidden invitees get a private notice instead, out of scope for
    this harness — see T15's card)

2026-08-16 fix-pass contract (internal design notes, four bugs
fixed on top of the POST-WAVE-3 contract above; this harness now exercises
all four):
  - Card A: the status page's aggregate table renders availability as icon
    spans (av-free/av-ifneeded, a legend, a two-tier colspanned-date header)
    instead of literal "Free"/"If needed" text — hard-checked by the STATUS
    step once invitee A has painted.
  - Card B: a needs_attention (escalated) poll's grid UNLOCKS — GET/PUT
    /poll/:id/{grid,response} return the full payload, not {status:...}, and
    invitees can keep revising past the deadline. A save on a needs_attention
    poll never auto-books (that stays the organiser's manual
    resolveMeetingPoll{action:"book"} call) — exercised end to end by the
    UNHAPPY mode's extension (grid unlock -> overlapping revise -> held
    needs_attention -> nudge still refused -> organiser books via the API).
  - Card C: a guestLink:true poll never auto-books or escalates early, even
    once every named invitee is all-in with an overlapping paint — it waits
    for its deadline since a guest may still join. Exercised by the new
    GUESTWAIT mode (holds "open" across a window, no gcalEventId appears).
  - Card D: cancelling a poll now emails every non-dropped invitee a
    cancellation notice, and the cancel route is a real CAS: 409 on an
    already-booked poll (P7/UNHAPPY/HIDDEN's trailing cancels), 200->
    cancelled on an open one (NUDGE/GUESTWAIT's trailing cancels).

bookBest add-on (docs/runbook.md §L "resolveMeetingPoll{action:'bookBest'}"):
resolveMeetingPoll{action:"bookBest"} books the best slot right now for
whoever has responded, pre-deadline, without the organiser picking a slot —
exercised by the new BOOKBEST mode: only invitee A responds (so her one
painted cell is the only qualifying candidate), bookBest books it and B (who
never responded) still lands on the event's attendee list; a second,
zero-response poll asserts the failure shape (400 no_responders, poll left
open — bookBest never escalates, unlike bookAtDeadline).

Card D add-on (internal design notes, `PATCH /v1/polls/{id}` /
`updateMeetingPoll` — `extendDeadline`/`dropInvitee` moved OUT of
`resolveMeetingPoll` outright, no aliases): exercised by the new EDIT mode.
Poll 1 covers the roster+location edit arm in one PATCH (add invitee C,
remove invitee B, change location meet -> in_person) — B's captured link
dies, A's untouched pre-PATCH link (same URL) keeps working, C's roster row
appears via getMeetingPoll, and the PATCH response itself already carries
the new location; A+C then paint an overlap to auto-book, and the booked
event is checked for the PATCHed location and B's exclusion from attendees.
Poll 2 covers the deadline arm in isolation (rotates EVERY non-dropped
invitee's token, unlike every other PATCH field) and the resolve-slimming
guard: `resolveMeetingPoll{action:"extendDeadline"}` and
`{action:"dropInvitee"}` now 400 `validation_failed` even when given a body
shaped exactly as the OLD (pre-slimming) schema required — proving the
action literal itself is gone from the union, not just that some other
required field was missing.

KNOWN GAP (T3, dev only, gated) — token relay is automated when the
organiser's OAuth token carries gmail.readonly: GOOGLE_GMAIL_READ_SCOPE_ENABLED
must be "true" on the target env AND identity A must have re-consented since
it went live (`./bin/mint-token.py --url https://scheduler-dev.… --client-id
smoke-cli` — same drill as calendar.freebusy/calendar.acls; see
docs/runbook.md §L). Precedence in resolve_token is env var FIRST — a
pre-supplied *_TOKEN is the operator's explicit intent and short-circuits
everything below it unconditionally, not merely "skips a prompt" — THEN the
mailbox, THEN the interactive prompt. When the mailbox path is live,
resolve_token polls the organiser's Sent folder (every poll email goes out
via the organiser's own gmail.send) and returns each invitee's CURRENT
personal link with no operator involved, including after a nudge rotates
it — but "newest matching message" is scoped to "sent at/after a not_before
watermark", not "newest overall": a mailbox with only a stale (pre-rotation)
match landed is treated as no match yet, not as a valid-but-old one, and each
call site that can invalidate its own token mid-run (the nudge step) passes
its own watermark rather than relying on the default (see resolve_token /
newest_matching_link / run_nudge_check docstrings — this replaced an earlier,
buggier version of this same feature that could hand back a token guaranteed
dead on arrival).

The mailbox path degrades gracefully rather than ever crashing a run: a 403
(scope missing) disables it immediately; any other Gmail/transport error is
retried within the poll and disables it on persistent failure; a poll that
times out with nothing ever matching ALSO disables it (once, not on every one
of the ~11 call sites — that would be ~16 minutes of dead time). "Disabled"
means every later resolve_token call in the run skips straight past the
mailbox to the interactive prompt: run attached to a terminal, watch for the
"waiting for <label>" prompts, and paste the token (or the whole link — see
extract_poll_token) copied out of the corresponding email once it arrives, or
pre-set the matching *_TOKEN env var to skip both the mailbox and the prompt
for that one call site. This is the same "some steps stay manual" trade-off
the task card itself makes for the nudge step's true-browser-render check.

Still NOT closed by T3: no email CONTENT assertions anywhere (invite, nudge,
escalation, cancellation, the hidden-invitee ICS notice, both organiser
notifications) — the mailbox read exists now, but nothing yet asserts what's
IN a message beyond the one link it's mined for. That's the card's
"once the links are automatic" follow-up tail, out of scope here.

A true browser render of the grid (JS actually painting cells, not just the
static shell + asset check this script does) remains a separate manual step
— see internal design notes
"For T13" item 5.

Requires:
  SCHEDULER_URL, A_BEARER, A_REFRESH, A_EXPECTED_EMAIL  (organiser identity)
  INVITEE_A_EMAIL, INVITEE_B_EMAIL                       (real, checkable mailboxes)
Optional:
  D1_DATABASE_ID  (must be the scheduler-dev id) — enables automatic D1
                   cleanup of the poll/poll_invitees/poll_responses rows
                   this harness creates (no DELETE endpoint exists for
                   those tables); without it, cleanup prints the manual SQL.
  INVITEE_A_TOKEN, INVITEE_B_TOKEN, NUDGE_INVITEE_EMAIL, NUDGE_TOKEN,
  UNHAPPY_A_TOKEN, UNHAPPY_B_TOKEN, HIDDEN_A_TOKEN, HIDDEN_B_TOKEN,
  GUESTWAIT_A_TOKEN, GUESTWAIT_B_TOKEN, BOOKBEST_A_TOKEN (skip the matching prompt)
  EDIT_A_TOKEN, EDIT_B_TOKEN, EDIT_C_TOKEN, EDIT_D_TOKEN (skip the matching
                   prompt); EDIT_C_EMAIL (override invitee C's mailbox — see
                   edit_invitee_c_email's docstring for the default '+' tag)
  POLL_SMOKE_ALLOW_ANY_DAY=true  (bypass the Mon-Thu gate — see is_run_day_ok)

Weekend caveat: like bin/regression-smoke.py's L6, this harness assumes
Mon-Fri business-hours availability exists ahead in the week; run Mon-Thu
(refuses otherwise unless POLL_SMOKE_ALLOW_ANY_DAY=true).

Microsoft organiser (WP2, internal design notes): pass
--provider microsoft (or set SMOKE_PROVIDER=microsoft) to run the ORGANISER
identity (A) against a Microsoft account — its calendar reads/writes go
through Graph (_smoke_lib.GraphCalendarClient) and its poll-mail relay reads
Sent Items through Graph (GraphReader/GraphMailClient) instead of Gmail.
Invitee mailboxes (INVITEE_A_EMAIL/INVITEE_B_EMAIL) are ALWAYS Gmail —
providers are never mixed on the invitee side, only the organiser's. This
needs MICROSOFT_MAIL_READ_SCOPE_ENABLED="true" on the target env (the
Microsoft analogue of GOOGLE_GMAIL_READ_SCOPE_ENABLED) AND identity A
re-consented since it went live (same drill as
GOOGLE_GMAIL_READ_SCOPE_ENABLED — re-mint with `./bin/mint-token.py
--provider microsoft --url … --client-id smoke-cli`); without the scope, the
mailbox path 403s once and falls back to the interactive-prompt relay for
the rest of the run, same graceful degradation as Google. A new preflight
GET /v1/whoami checks A_BEARER's email against A_EXPECTED_EMAIL always, and
— once the target worker's whoami route carries the additive `provider`
field (WP0 of internal design notes) — also confirms
A_BEARER actually belongs to the provider named by --provider, so a
Google bearer run under --provider microsoft fails in the first second
rather than twenty minutes in against a confusing Graph 401. Against a
worker predating that field, the provider half is skipped (not failed) and
a one-line stderr warning says so. EDIT mode's
Poll-1 create location kind is 'phone' (not 'meet') on Microsoft: Graph's
addMeet path 400s on a personal Microsoft account without a Teams license
(see edit_create_location). Known cosmetic gap: organiser-side poll mail
arrives from the MSA's outlook_<hex>@outlook.com proxy alias rather than
its real address (runbook §O open item) — invitee mailboxes still receive
it correctly, and the harness reads the organiser's own Sent Items, so this
never affects what's asserted.
"""

from __future__ import annotations

import argparse
import base64
import html
import importlib.util
import json
import os
import re
import sys
import time as _time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse, parse_qs, unquote

import httpx

_spec = importlib.util.spec_from_file_location(
    "_smoke_lib", str(Path(__file__).resolve().parent / "_smoke_lib.py")
)
_smoke_lib = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _smoke_lib
_spec.loader.exec_module(_smoke_lib)
Identity = _smoke_lib.Identity
SchedulerClient = _smoke_lib.SchedulerClient
CalendarClient = _smoke_lib.CalendarClient
GraphCalendarClient = _smoke_lib.GraphCalendarClient
make_calendar_client = _smoke_lib.make_calendar_client
GmailClient = _smoke_lib.GmailClient
GraphMailClient = _smoke_lib.GraphMailClient
MailScopeError = _smoke_lib.MailScopeError
GmailScopeError = _smoke_lib.GmailScopeError  # provider-neutral alias of MailScopeError
DevD1 = _smoke_lib.DevD1
sql_str = _smoke_lib.sql_str

# Duck-typed alias for the run_* functions' `cal` parameter: either calendar
# client exposes the same verbs (list_events/create_event/delete_event/...),
# normalised to Google's wire shape by GraphCalendarClient — see
# _smoke_lib.normalize_graph_event. Level code never branches on provider.
CalendarLike = CalendarClient | GraphCalendarClient

# =============================================================================
# Constants
# =============================================================================

DEV_DB_ID = _smoke_lib.DEV_DB_ID     # scheduler-dev
PROD_DB_ID = _smoke_lib.PROD_DB_ID   # scheduler (prod) — NEVER

# Title prefix for every poll this harness creates. Title-based sledgehammer
# match (poll_title_is_harness), same idiom as reset-smoke-env.py's
# "[regsmoke" catch-all — polls have no source/external_id column to key a
# lineage match on, so the title prefix IS the lineage here.
HARNESS_TITLE_PREFIX = "[pollsmoke]"

CLIENT_ASSET_RE = re.compile(r'src="(/poll/_static/poll\.[0-9a-f]+\.js)"')


# =============================================================================
# Dev/prod guards
# =============================================================================

# URL guard and required-env helper come from _smoke_lib — the canonical
# definitions (guarded by bin/test_smoke_lib_guards.py). A local copy here
# previously drifted: it was fail-open on prod's own workers.dev subdomain
# (see bin/test_poll_smoke_guard.py).
assert_dev_url = _smoke_lib.assert_dev_url
req = _smoke_lib.req


# The shared db guard (prod hard-denied) since 2026-09-02: the [pollsmoke]
# cleanup routes through the env-aware d1_for_db_id, so a run only ever
# wipes its own env's rows. Cross-checked against SCHEDULER_URL by
# assert_env_consistent. Pinned by bin/test_poll_smoke_guard.py.
assert_dev_db = _smoke_lib.assert_dev_db
assert_env_consistent = _smoke_lib.assert_env_consistent
d1_for_db_id = _smoke_lib.d1_for_db_id


def wrangler_env_for(url: str, db_id: str | None) -> str:
    """Which [env.<name>] wrangler block this run targets — an explicit
    SMOKE_WRANGLER_ENV wins (the runner sets it as part of the target
    triple); else the db id's own env; else dev."""
    explicit = os.environ.get("SMOKE_WRANGLER_ENV")
    if explicit:
        return explicit
    if db_id:
        return d1_for_db_id(db_id, Path(__file__).resolve().parent.parent).env_name
    return "dev"


# =============================================================================
# Pure decision logic (guarded by bin/test_poll_smoke_predicate.py)
# =============================================================================


def is_run_day_ok(today: date) -> bool:
    """Mon-Thu only, mirrors bin/regression-smoke.py's L6 weekend caveat: the
    default poll range (poll_range) starts tomorrow — BOOKBEST's own range
    (bookbest_poll_range) starts further out (+3d) — and the grid needs
    several forward business days of availability to offer a meaningful set
    of paintable cells."""
    return today.weekday() in (0, 1, 2, 3)


def poll_title_is_harness(title: object) -> bool:
    """True iff `title` is a harness-created poll's title. Prefix match ONLY
    at the start (never mid-string — a poll that merely mentions "[pollsmoke]"
    in a forwarded/quoted title must not be swept up, same false-positive
    concern as regression-smoke's title-prefix catch-all)."""
    return isinstance(title, str) and title.startswith(HARNESS_TITLE_PREFIX)


def task_is_pollsmoke_meeting_import(task: dict, event_ids: set[str]) -> bool:
    """True iff `task` is a `context:"meeting"` row imported FOR one of this
    harness's booked poll events: source.kind == "meeting" AND
    source.external_id (the Google event id, per meetings/sync.ts) is one of
    `event_ids`. Used both for P6's assertion and as a cleanup safety net
    (harmless no-op today — see poll-smoke.py's P6 comment on why no such row
    is expected to exist yet)."""
    src = task.get("source") or {}
    return src.get("kind") == "meeting" and src.get("external_id") in event_ids


def booking_is_pollsmoke(booking: dict, poll_ids: set[str]) -> bool:
    """True iff `booking`'s poll_id is one of this harness's own polls. An
    ordinary booking-page claim never sets poll_id (NULL), so this can never
    match a real user's booking-page reservation."""
    return booking.get("poll_id") in poll_ids


def poll_booking_rows(bookings: list[dict], poll_id: str) -> list[dict]:
    """The subset of `bookings` (a GET /v1/bookings listing) belonging to
    `poll_id` — P5's row filter, wired onto booking_is_pollsmoke (the
    better-documented form of the same poll_id comparison; GET /v1/bookings
    now exposes poll_id (W2), which is what makes this usable here — it was
    previously dead code, kept alive only by cleanup's own unit tests)."""
    return [b for b in bookings if booking_is_pollsmoke(b, {poll_id})]


def booking_wait_outcome(rows: list[dict]) -> str:
    """Classifies P5's poll of poll_booking_rows' output for
    wait_for_confirmed_booking's retry loop: "missing" when no row has
    appeared yet, or the row's own `status` otherwise. "reserving" is the
    expected, transient, pre-confirm state — the worker publishes poll status
    "booked" (casSetBooked, polls/booking.ts:609) BEFORE confirmBooking flips
    the bookings row reserving->confirmed (:625), so a poll that already
    reports "booked" can briefly still carry a "reserving" row; "confirmed" is
    the terminal, expected state."""
    if not rows:
        return "missing"
    return rows[0].get("status", "missing")


def booking_wait_timeout_message(outcome: str, poll_id: str, elapsed_s: float, rows: list[dict]) -> str:
    """The FAIL text for wait_for_confirmed_booking's timeout, distinguishing
    a still-transient wedge from an outright regression so a human reading
    the run doesn't have to guess which:
      - "reserving": the documented, benign casSetBooked/confirmBooking
        ordering above just didn't resolve within the wait window — not proof
        of a bug on its own.
      - "missing": no row with this poll_id ever appeared at all — either the
        `poll_id` field regressed off GET /v1/bookings, or booking genuinely
        never happened despite the poll reporting "booked"."""
    if outcome == "reserving":
        return (
            f"row still reserving after {elapsed_s:.0f}s — possible confirmBooking wedge "
            f"(booked-with-reserving-row, documented edge): {rows!r}"
        )
    if outcome == "missing":
        return (
            f"no row with this poll_id ({poll_id}) at all after {elapsed_s:.0f}s "
            f"(field missing/regression): {rows!r}"
        )
    return f"unexpected bookings row status {outcome!r} after {elapsed_s:.0f}s: {rows!r}"


def bookings_disabled_by_flag(status: int, body: dict) -> bool:
    """True iff `status`/`body` is GET /v1/bookings' 403 for
    BOOKING_PAGE_ENABLED being off — a harness dependency the poll feature
    doesn't otherwise need, so this must read distinctly from an ordinary
    poll-side failure rather than as a poll bug (2026-08-17 adversarial-review
    finding 2)."""
    return status == 403 and body.get("error") == "feature_disabled"


def bookings_feature_disabled_message() -> str:
    """The FAIL text for the bookings_disabled_by_flag case — names the flag
    dependency explicitly rather than reading as a poll-code regression."""
    return (
        "GET /v1/bookings requires BOOKING_PAGE_ENABLED=true — dev has it on; "
        "this is a harness dependency, not a poll failure"
    )


def nudge_is_permitted(status: str) -> bool:
    """Post-wave contract (decision D4 / M5): manual nudge is valid on an OPEN
    poll only — a needs_attention poll is closed to invitees, so nudging it
    would open a closed page and rotate a token for nothing."""
    return status == "open"


def overlapping_choice(paintable: list[str], count: int = 2) -> list[str]:
    """Deterministic (sorted) selection of `count` cells from `paintable`,
    for two invitees to BOTH paint the same cells (guaranteeing an
    intersection so all-in auto-book fires). Raises if fewer than `count`
    distinct cells are on offer — a poll range/business-hours combination too
    narrow to exercise the happy path is a setup bug, not a silent skip."""
    uniq = sorted(set(paintable))
    if len(uniq) < count:
        raise ValueError(
            f"overlapping_choice: need {count} paintable cells, only {len(uniq)} on offer: {uniq!r}"
        )
    return uniq[:count]


def disjoint_choices(paintable: list[str]) -> tuple[list[str], list[str]]:
    """Two guaranteed-non-overlapping single-cell selections (earliest vs
    latest paintable cell) for the unhappy-mode disjoint-paint scenario.
    Raises if fewer than 2 distinct cells are on offer."""
    uniq = sorted(set(paintable))
    if len(uniq) < 2:
        raise ValueError(
            f"disjoint_choices: need at least 2 distinct paintable cells, got {uniq!r}"
        )
    return [uniq[0]], [uniq[-1]]


def edit_invitee_c_email(invitee_a_email: str) -> str:
    """EDIT mode's third invitee ('C') email, for the updateMeetingPoll
    add-a-third-invitee step (Card D, internal design notes).
    poll-smoke only has two REAL invitee mailboxes (INVITEE_A_EMAIL /
    INVITEE_B_EMAIL — see mu-smoke-login.py's docstring: they're accounts B
    and C of the identity-minting scheme, not a third one), the same
    constraint GUESTWAIT's guest-self-join gap documents. C reuses invitee
    A's mailbox via a '+' subaddress tag (widely supported, including by
    Gmail, which is what this harness's real dev mailboxes are): mail to
    `local+editc@domain` is delivered to `local@domain`'s inbox, so the
    existing mailbox-relay/interactive-prompt path for A still resolves C's
    token, while C is still a genuinely distinct invitee row in the DB (its
    own email string, id, pseudonym, token) since the addresses differ as
    literal strings. Override with EDIT_C_EMAIL if INVITEE_A_EMAIL's
    provider doesn't support '+' tags — or if Google Calendar collapses the
    tagged address onto the same account as the base address for RSVP/
    attendee purposes (Calendar attendee matching is not guaranteed to treat
    a '+' subaddress as distinct from its base): if EDIT-book's attendee-set
    assertion fails that way on a live run (A and C's cells apparently
    merging into one attendee), set EDIT_C_EMAIL to a genuinely distinct
    mailbox rather than a tagged variant of A's."""
    local, _, domain = invitee_a_email.partition("@")
    return f"{local}+editc@{domain}"


def edit_create_location(provider: str) -> dict:
    """EDIT mode's Poll-1 create location kind
    (internal design notes Decision 7): 'meet' (Google Meet, no detail — the org's
    default for this poll pre-WP2) on a Google organiser, 'phone' (with a
    detail) on a Microsoft one — createEvent's addMeet path 400s on a
    personal Microsoft account without a Teams license
    (worker/src/providers/microsoft-calendar-provider.ts), so 'meet' is not
    exercisable there today."""
    if provider == "google":
        return {"kind": "meet"}
    if provider == "microsoft":
        return {"kind": "phone", "detail": "+61 2 5550 1234"}
    raise ValueError(f"unknown calendar provider {provider!r}; expected one of {_smoke_lib.PROVIDERS}")


def client_asset_referenced(html: str) -> bool:
    """True iff `html` references the content-hashed poll client module
    (/poll/_static/poll.<hash>.js) — the shape changes on every client edit,
    same reasoning as booking-smoke.py's BOOKING_CLIENT_SRC_RE, so this
    matches the pattern rather than a literal path."""
    return bool(CLIENT_ASSET_RE.search(html))


def client_asset_src(html: str) -> str | None:
    """The referenced client asset's path (for fetching it directly to prove
    it is actually SERVED, not merely referenced), or None if absent."""
    m = CLIENT_ASSET_RE.search(html)
    return m.group(1) if m else None


def bootstrap_attrs_present(html: str, poll_id: str, token: str) -> bool:
    """True iff `html` bootstraps with EXACTLY this poll id and token via the
    data-poll-id/data-token attributes (poll/page.ts's pinned cross-card
    contract). Deliberately exact-match on the token: this is what catches
    "every automatic nudge emailed a dead link" (wave3-additions.md item 5) —
    a STALE (superseded) token in the bootstrap must read as absent, not as
    some other token being present."""
    return f'data-poll-id="{poll_id}"' in html and f'data-token="{token}"' in html


def grid_response_has_who_arrays(aggregate: dict) -> bool:
    """True iff every cell in a grid/response payload's `aggregate` carries
    freeWho/ifNeededWho arrays (decision D3 / M3 hover-who contract). False on
    an empty aggregate (nothing to prove the contract with) or the pre-T11
    shape (free/ifNeeded counts only, no *Who arrays)."""
    if not aggregate:
        return False
    for cell in aggregate.values():
        if not isinstance(cell.get("freeWho"), list) or not isinstance(cell.get("ifNeededWho"), list):
            return False
    return True


def expected_attendee_emails(invitees: list[dict]) -> set[str]:
    """The booked event's expected attendee set (decision D2): non-dropped AND
    non-hidden invitees. A poll where every invitee hid their name yields the
    empty set — that is the card's documented correct edge case, not a bug."""
    return {i["email"] for i in invitees if not i.get("dropped") and not i.get("hideName")}


def status_page_has_landmarks(html: str, poll_title: str, invitee_names: list[str]) -> bool:
    """HARD check for GET /poll/:id/status (T11's organiser status page —
    R4-M3): a real HTML page (not a requireOwner 401/403 JSON error body),
    carrying the poll's title and every given invitee's display name. Real
    names, not pseudonyms: the happy-path smoke never sets hideName, and the
    card's own rule is the organiser always sees real names regardless."""
    if "<html" not in html.lower():
        return False
    if poll_title not in html:
        return False
    return all(name in html for name in invitee_names)


def status_page_mentions(html: str, hints: tuple[str, ...]) -> bool:
    """SOFT, best-effort check: does `html` contain any of `hints`
    (case-insensitive)? Used for the roster/candidates-section wording the
    STATUS step cannot assert exactly — worker/src/web/poll-status-page.ts
    (T11) was not yet merged into this worktree when this harness was
    written, so its actual copy is unknown. A miss is reported as a NOTE by
    the STATUS step, not a FAIL — same reasoning as P6: failing on a guessed
    keyword would flag a wording choice as a code regression."""
    lowered = html.lower()
    return any(h in lowered for h in hints)


def grid_is_unlocked(payload: dict) -> bool:
    """True iff `payload` is a FULL grid/response payload (paintableCells +
    `you` present) — the shape GET /poll/:id/grid and PUT /poll/:id/response
    both return for an OPEN or NEEDS_ATTENTION poll, per the 2026-08-16
    fix-pass (worker/src/polls/route.ts:520/548 — Card B). False for the
    closed `{status: <status>}` shape a booked/cancelled poll still returns
    (and what a needs_attention poll used to return, pre-fix-pass). Mirrors
    the client's own (poll.client.js) "does this payload carry a status field
    with nothing else" check, rather than inventing a new rule."""
    return (
        isinstance(payload, dict)
        and isinstance(payload.get("paintableCells"), list)
        and "you" in payload
    )


def poll_status_stayed(observed: list[str], want: str) -> bool:
    """True iff every status in `observed` equals `want` — the pure decision
    hold_poll_status's live polling loop makes once its sampling window
    closes (2026-08-16 fix-pass: a needs_attention poll must NOT auto-book on
    an unlocked invitee edit, and a guestLink poll must NOT auto-book/
    escalate early — both asserted by holding a status across a window
    rather than a single point-in-time check, which could simply get lucky
    on timing). An EMPTY `observed` is deliberately False, never True: a hold
    that took zero samples proved nothing, and treating "nothing observed" as
    "nothing wrong observed" would silently pass a caller bug (e.g. a hold
    window shorter than one poll interval) as a real assertion."""
    if not observed:
        return False
    return all(status == want for status in observed)


_ICON_LEGEND_RE = re.compile(r'class="legend"')
_ICON_COLSPAN_RE = re.compile(r'colspan="\d+"')


def status_page_has_icon_aggregate(html: str) -> bool:
    """HARD check (Card A, 2026-08-16 fix-pass): the status page's aggregate
    table now renders per-cell availability as icon spans
    (`class="av av-free"`, `role="img"`) rather than the old literal "Free" /
    "If needed" cell text, plus a legend (`class="legend"`) and a two-tier
    header — a colspanned date `th` above time-only `th class="time"` cells
    (worker/src/web/poll-status-page.ts's aggregateTable/rosterRow). Only
    meaningful once at least one response has been painted: an empty
    aggregate renders the "No responses yet." paragraph instead of a table
    at all, so this correctly reads False there too — callers must gate on
    "has anyone painted" themselves before treating a miss as a regression."""
    if 'class="av av-free"' not in html:
        return False
    if 'role="img"' not in html:
        return False
    if not _ICON_LEGEND_RE.search(html):
        return False
    if not _ICON_COLSPAN_RE.search(html):
        return False
    if 'class="time"' not in html:
        return False
    return True


# --- mailbox-first token relay (T3) -----------------------------------------
# Every poll email goes out via the organiser's own gmail.send, so the
# invite/nudge/notice for ANY invitee lands in the ORGANISER's Sent folder —
# one account's read access (GOOGLE_GMAIL_READ_SCOPE_ENABLED, dev only) covers
# the whole harness. See resolve_token below for the impure retry/fallback
# wiring; these three are pure over already-fetched Gmail message dicts.


def gmail_query(invitee_email: str, after_epoch: int) -> str:
    """Gmail search query for this harness's poll emails to `invitee_email`,
    sent after `after_epoch` (unix seconds). Searches Sent (not Inbox/All
    Mail) because that's where the organiser's own sends land; the
    "[pollsmoke]" subject substring is the same title prefix
    poll_title_is_harness matches on, since renderInviteEmail/etc. build the
    subject straight from the poll title."""
    return f"in:sent to:{invitee_email} subject:[pollsmoke] after:{after_epoch}"


def _b64url_decode(data: str) -> str:
    if not data:
        return ""
    padded = data + "=" * (-len(data) % 4)
    try:
        return base64.urlsafe_b64decode(padded).decode("utf-8", errors="replace")
    except (ValueError, UnicodeDecodeError):
        return ""


def decode_message_bodies(message: dict) -> list[str]:
    """Every decoded text/* leaf body in a Gmail
    `users.messages.get(format="full")` payload — base64url in
    payload.body.data for a simple message, or nested under
    payload.parts[]/parts[].parts[]... for a multipart message (invite/nudge
    emails are multipart/alternative; the booked-confirmation email nests an
    ICS attachment alongside a multipart/alternative body). This includes
    text/calendar (the ICS attachment decodes too — harmless, it carries no
    `?t=` link for find_poll_link to match). Only genuinely non-text parts
    (e.g. application/octet-stream) are excluded from the result, though they
    are still walked for recursion in case a multipart container nests
    further parts beneath them."""
    bodies: list[str] = []

    def walk(part: dict) -> None:
        mime = part.get("mimeType") or ""
        body = part.get("body") or {}
        data = body.get("data")
        if mime.startswith("text/") and data:
            bodies.append(_b64url_decode(data))
        for sub in part.get("parts") or []:
            walk(sub)

    walk(message.get("payload") or {})
    return bodies


def find_poll_link(bodies: list[str], poll_id: str) -> str | None:
    """The `.../poll/<poll_id>?t=<token>` personal-link URL for THIS poll id
    among `bodies` (decode_message_bodies' output, or a Microsoft organiser's
    raw HTML message body — see GraphReader), or None. A run has many
    concurrent polls sharing one Sent folder — matching on the id (not just
    "the first poll link in the email") is what keeps a relay from crossing
    polls. Feed the result to extract_poll_token.

    The match is html.unescape()'d before returning (WP2 review finding 1,
    belt-and-braces): the token suffix's own character class already
    excludes '&' (so a trailing '&amp;otherParam=…' can never corrupt the
    token), but the URL's host/path segment before "/poll/" is
    unconstrained and could legitimately carry an escaped '&' — unescaping
    the whole match keeps that segment correct too, rather than depending
    on the exclusion set alone forever."""
    pattern = re.compile(
        r'https?://[^\s"\'<>]*/poll/' + re.escape(poll_id) + r'\?t=[^\s"\'<>&]+'
    )
    for body in bodies:
        m = pattern.search(body)
        if m:
            return html.unescape(m.group(0))
    return None


def newest_matching_link(
    messages: list[tuple[int, str]], poll_id: str, not_before_epoch: int = 0,
) -> str | None:
    """The poll link for `poll_id` from the NEWEST of `messages`
    ((sent_at_epoch_seconds, body_text) pairs — the mailbox-reader protocol's
    shape, see GmailReader/GraphReader below) that contains one AND was sent
    at/after `not_before_epoch` (unix seconds; default 0 keeps everything,
    for backward compatibility), or None if nothing qualifies.

    Provider-agnostic: GmailReader builds its tuples from Gmail's
    internalDate (ms -> s) and joins every decoded text/* body part with
    "\\n"; GraphReader builds them from Graph's sentDateTime and
    body.content. This function itself never touches a provider-specific
    message shape.

    Nudges rotate the invitee's token, so an older matching email's link is
    dead — scanning newest-first is what keeps this returning a LIVE token
    rather than whichever email happened to match first. But "newest among
    what HAS landed" is not the same as "newest overall": Gmail's own
    `after:` search operator is only day-level granular, so on the same day
    a stale pre-nudge invite can still satisfy the query while the fresher
    nudge email hasn't been indexed yet. The not_before_epoch cutoff is the
    actual (sub-day) gate — messages before it are excluded outright rather
    than merely sorted after fresher ones, so a stale-only Sent folder
    correctly yields None (caller retries/falls back) instead of a token
    that is guaranteed dead."""
    ordered = sorted(messages, key=lambda m: m[0], reverse=True)
    for sent_at, body in ordered:
        if sent_at < not_before_epoch:
            continue
        link = find_poll_link([body], poll_id)
        if link:
            return link
    return None


# =============================================================================
# Mailbox-reader protocol — GmailReader (Google) / GraphReader (Microsoft).
# Both expose messages_to(invitee_email, not_before) -> list[(sent_at_epoch,
# body_text)] and close(); _mailbox_token/newest_matching_link drive either
# one identically, so the rest of the token relay never branches on provider.
# =============================================================================


class GmailReader:
    """Wraps _smoke_lib.GmailClient's list_messages+get_message split behind
    the reader protocol. gmail_query (module-level, see above) builds the
    Sent-folder search; decode_message_bodies flattens each message's
    text/* parts, joined with "\\n" into the one body_text this protocol
    carries per message."""

    def __init__(self, client: "_smoke_lib.GmailClient"):
        self._client = client

    def messages_to(self, invitee_email: str, not_before: int) -> list[tuple[int, str]]:
        query = gmail_query(invitee_email, not_before)
        out: list[tuple[int, str]] = []
        for stub in self._client.list_messages(query):
            msg = self._client.get_message(stub["id"])
            sent_at = int(msg.get("internalDate") or "0") // 1000
            out.append((sent_at, "\n".join(decode_message_bodies(msg))))
        return out

    def close(self) -> None:
        self._client.close()


class GraphReader:
    """Wraps _smoke_lib.GraphMailClient behind the reader protocol. Graph
    rejects a request that filters and sorts on DIFFERENT properties, so
    GraphMailClient.list_sent_since only filters (and sorts) on sentDateTime
    server-side — the subject-prefix (HARNESS_TITLE_PREFIX, "[pollsmoke]")
    and to-recipient match happen here, client-side, mirroring GmailReader's
    own split (Gmail's query does the recipient/subject match, this one does
    the sentDateTime cutoff via the client — same division of labour,
    opposite property). The body carried through is whatever native format
    Graph returns (HTML for the worker's poll emails, which are HTML-only —
    see _smoke_lib.GraphMailClient's docstring); find_poll_link matches the
    raw markup directly."""

    def __init__(self, client: "_smoke_lib.GraphMailClient"):
        self._client = client

    def messages_to(self, invitee_email: str, not_before: int) -> list[tuple[int, str]]:
        target = invitee_email.casefold()
        out: list[tuple[int, str]] = []
        for m in self._client.list_sent_since(not_before):
            subject = m.get("subject") or ""
            if HARNESS_TITLE_PREFIX not in subject:
                continue
            recipients = {
                ((r.get("emailAddress") or {}).get("address") or "").casefold()
                for r in (m.get("toRecipients") or [])
            }
            if target not in recipients:
                continue
            sent_raw = m.get("sentDateTime") or ""
            try:
                # _smoke_lib.graph_datetime_to_epoch tolerates Graph's up-to-
                # 7-fractional-digit sentDateTime (WP2 review finding 4) —
                # the naive fromisoformat(sent_raw.replace("Z","+00:00")) this
                # replaced silently dropped every such message with no
                # diagnostic, which reads as a 90s mailbox timeout with no
                # clue why.
                sent_at = _smoke_lib.graph_datetime_to_epoch(sent_raw)
            except ValueError:
                print(
                    f"warning: GraphReader could not parse sentDateTime {sent_raw!r} on a "
                    f"[pollsmoke] message to {invitee_email} — skipping it",
                    file=sys.stderr,
                )
                continue
            body_text = (m.get("body") or {}).get("content") or ""
            out.append((sent_at, body_text))
        return out

    def close(self) -> None:
        self._client.close()


def make_mail_reader(scheduler: SchedulerClient, provider: str) -> "GmailReader | GraphReader":
    """GmailReader (Google) or GraphReader (Microsoft) — the mailbox-first
    token relay's provider factory, mirroring _smoke_lib.make_calendar_client."""
    if provider == "google":
        return GmailReader(GmailClient(scheduler))
    if provider == "microsoft":
        return GraphReader(GraphMailClient(scheduler))
    raise ValueError(f"unknown mail provider {provider!r}; expected one of {_smoke_lib.PROVIDERS}")


def safe_json_body(text: str) -> dict:
    """Best-effort JSON decode of an HTTP response body. Found live: a fake
    bearer against the real dev host got back a plain-text `404 Not Found`
    body (an edge/CDN response, not the worker's own JSON error shape), which
    crashed every naive `r.json()` call site with an unhandled
    JSONDecodeError before this existed. Empty body -> {}; non-JSON body ->
    {"_raw": <first 300 chars>} so the caller's normal status-code/body
    FAIL-reporting path still runs instead of the whole script crashing."""
    if not text:
        return {}
    try:
        return json.loads(text)
    except ValueError:
        return {"_raw": text[:300]}


def extract_poll_token(value: str) -> str:
    """Accepts either a raw capability token (payload.sig) or a full pasted
    personal-link URL (.../poll/<id>?t=<token>) — whichever an operator finds
    it easiest to copy out of the invite/nudge email — and returns the bare
    token. Raises ValueError on blank input or a URL with no `t` param."""
    v = value.strip()
    if not v:
        raise ValueError("extract_poll_token: empty token/link")
    if v.startswith("http://") or v.startswith("https://"):
        qs = parse_qs(urlparse(v).query)
        t = qs.get("t")
        if not t or not t[0]:
            raise ValueError(f"extract_poll_token: no t= param in URL: {v!r}")
        return unquote(t[0])
    return v


# =============================================================================
# Env / setup — `req` is the shared _smoke_lib.req, bound with the guards
# above.
# =============================================================================


@dataclass
class PollSmokeEnv:
    url: str
    organiser: Identity
    invitee_a_email: str
    invitee_b_email: str
    d1_database_id: str | None
    repo_root: Path
    wrangler_env: str = "dev"
    # Calendar provider of the organiser identity (--provider / SMOKE_PROVIDER,
    # see parse_args). Invitee mailboxes are always Gmail (module docstring) —
    # this names the ORGANISER's provider only. Read by run_edit_mode to pick
    # the EDIT-create location kind (edit_create_location) and by the
    # preflight whoami check (check_whoami).
    provider: str = "google"

    @classmethod
    def from_environ(cls, provider: str = "google") -> "PollSmokeEnv":
        url = req("SCHEDULER_URL").rstrip("/")
        assert_dev_url(url)
        organiser = Identity(
            scheduler_url=url,
            bearer=req("A_BEARER"),
            refresh_token=req("A_REFRESH"),
            expected_email=req("A_EXPECTED_EMAIL"),
            client_id=os.environ.get("A_CLIENT_ID", "smoke-cli"),
        )
        db_id = os.environ.get("D1_DATABASE_ID")
        if db_id:
            assert_dev_db(db_id)
            assert_env_consistent(url, db_id)
        return cls(
            url=url,
            organiser=organiser,
            invitee_a_email=req("INVITEE_A_EMAIL"),
            invitee_b_email=req("INVITEE_B_EMAIL"),
            d1_database_id=db_id,
            repo_root=Path(__file__).resolve().parent.parent,
            wrangler_env=wrangler_env_for(url, db_id),
            provider=provider,
        )


# Module-level so resolve_token's many call sites (one per harness mode) need
# no signature change to go mailbox-first — main() opts the whole run in once
# via configure_mail_reader (or its back-compat alias, configure_gmail_client).
# None (the default) keeps the pre-T3 behaviour.
_mail_reader: "GmailReader | GraphReader | None" = None
_mail_reader_warned = False
# Coarse "run start" watermark for gmail_query's after_epoch and resolve_token's
# default not_before: every poll email this harness will ever look for is sent
# AFTER the process started, so this is a safe default for the (common) case
# where a call site has no fresher watermark of its own. A call site whose
# token can be invalidated mid-run by another action of its own (the nudge
# step's re-issue) MUST pass its own not_before instead — see run_nudge_check.
_HARNESS_START_EPOCH = int(_time.time())

# Sending is async (the worker's response returns before the mail has actually
# delivered into Sent) — poll for up to this long, a few seconds apart.
_MAILBOX_POLL_TIMEOUT_S = 90.0
_MAILBOX_POLL_INTERVAL_S = 5.0


def configure_mail_reader(reader: "GmailReader | GraphReader | None") -> None:
    """Called once from main(). Makes resolve_token mailbox-first (poll the
    organiser's Sent mail via the reader protocol — messages_to) for the
    rest of the run. Pass None to keep resolve_token on its pre-T3
    env-var/interactive-prompt behaviour (e.g. a dev env where the mail-read
    scope isn't live for the active provider)."""
    global _mail_reader, _mail_reader_warned
    _mail_reader = reader
    _mail_reader_warned = False


def configure_gmail_client(client: "_smoke_lib.GmailClient | None") -> None:
    """Back-compat alias (pre-WP2 call contract, still used by this module's
    own tests): wraps a raw GmailClient — or anything duck-typing its
    list_messages/get_message pair — in a GmailReader before handing it to
    configure_mail_reader."""
    configure_mail_reader(GmailReader(client) if client is not None else None)


def _disable_mail_reader(reason: str) -> None:
    """Circuit breaker: permanently (for the rest of this run) turn off the
    mailbox path and warn exactly once. Used both for a persistent scope
    error (403 — the token will never gain the mail-read scope mid-run) and
    for a persistent/timed-out mailbox poll (a repeat of the same ~90s wait
    on every one of the ~11 resolve_token call sites would be ~16 minutes of
    dead time for a problem that isn't going to resolve itself)."""
    global _mail_reader, _mail_reader_warned
    if not _mail_reader_warned:
        print(
            f"warning: {reason} — falling back to the env-var/interactive token "
            f"relay for the rest of this run.",
            file=sys.stderr,
        )
        _mail_reader_warned = True
    _mail_reader = None


def _mailbox_token(poll_id: str, label: str, invitee_email: str, not_before: int) -> str | None:
    """Poll the organiser's Sent mail (via the configured reader) for
    `invitee_email`'s current link on `poll_id`, sent at/after `not_before`
    (unix seconds). Returns None (never raises) on timeout, a scope error,
    or a persistent transport/HTTP error, so the caller always has a
    fallback path — mirrors resolve_token's own "no path available ->
    SystemExit, otherwise degrade gracefully" contract, just one level up.

    - MailScopeError (403 — GmailScopeError is the same class, provider-
      neutral since WP2) disables the mailbox path immediately — the token
      will never gain the mail-read scope mid-run, so there's nothing to
      retry.
    - Any other httpx.HTTPError (5xx, 429, a second 401 past the client's
      own retry, a connection/timeout failure, ...) is treated as transient:
      retried within this same polling loop rather than propagating and
      killing a run pre-T3 would have simply prompted through. If the
      deadline passes without ever succeeding, the mailbox path is disabled
      for the rest of the run same as a scope error (see _disable_mail_reader).
    - A clean timeout (every call succeeded, nothing ever matched) ALSO
      disables the mailbox path for the rest of the run — see
      _disable_mail_reader's docstring for why one full timeout is enough
      to stop trying, rather than paying the ~90s cost again on every
      remaining call site."""
    global _mail_reader
    reader = _mail_reader
    if reader is None:
        return None
    deadline = _time.monotonic() + _MAILBOX_POLL_TIMEOUT_S
    while True:
        try:
            messages = reader.messages_to(invitee_email, not_before)
            link = newest_matching_link(messages, poll_id, not_before_epoch=not_before)
        except MailScopeError as e:
            _disable_mail_reader(f"mail read scope unavailable ({e})")
            return None
        except httpx.HTTPError as e:
            if _time.monotonic() >= deadline:
                _disable_mail_reader(f"mail requests kept failing ({e!r})")
                return None
            _time.sleep(_MAILBOX_POLL_INTERVAL_S)
            continue
        if link:
            return extract_poll_token(link)
        if _time.monotonic() >= deadline:
            _disable_mail_reader(
                f"no {label} ({invitee_email}) email for poll {poll_id} found in the "
                f"organiser's Sent mail within {_MAILBOX_POLL_TIMEOUT_S:.0f}s"
            )
            return None
        _time.sleep(_MAILBOX_POLL_INTERVAL_S)


def resolve_token(
    env_var: str, label: str, poll_id: str, invitee_email: str, not_before: int | None = None,
) -> str:
    """Env var first, THEN mailbox, then interactive prompt.

    A pre-supplied `env_var` is the operator's explicit intent (e.g. "I
    already know this token, don't waste 90s polling for it") and is honoured
    unconditionally before any mailbox poll is attempted — it is NOT merely a
    fallback reached after a mailbox miss/timeout.

    Absent that, and if a GmailClient was configured (configure_gmail_client),
    poll the organiser's Sent folder for a link sent at/after `not_before`
    (defaults to _HARNESS_START_EPOCH — the process's own start time; a call
    site whose token was invalidated mid-run by its OWN action, like the nudge
    step re-issuing it, must pass the moment just before that action instead,
    or a stale-but-already-landed match can be handed back as if it were
    live — see run_nudge_check and newest_matching_link's docstring) and
    return the token straight off the live link, no operator involved.

    Otherwise (no client configured, or the mailbox poll times out or hits a
    persistent error — see _mailbox_token) falls back to the pre-T3
    behaviour: an interactive stdin prompt (stdout may be redirected to a log
    file — see the module docstring — but stdin is not, so this still works
    when the whole run is piped to `> file 2>&1`). Raises SystemExit with a
    clear message if that isn't available either (e.g. a non-interactive/CI
    invocation with no env var set) rather than hanging forever on a read
    from a closed stdin."""
    pre = os.environ.get(env_var)
    if pre:
        return extract_poll_token(pre)
    effective_not_before = _HARNESS_START_EPOCH if not_before is None else not_before
    mailbox = _mailbox_token(poll_id, label, invitee_email, effective_not_before)
    if mailbox:
        return mailbox
    prompt = (
        f"\nwaiting for {label} ({invitee_email}) on poll {poll_id} — "
        f"check that inbox, then paste the personal link (or just the token) "
        f"here and press Enter (or set {env_var} and re-run):\n> "
    )
    if not sys.stdin.isatty():
        raise SystemExit(
            f"{env_var} not set and stdin is not a TTY — cannot prompt for {label}'s "
            f"token. Set {env_var} to the token (or the full personal link) copied "
            f"from {invitee_email}'s inbox."
        )
    print(prompt, end="", flush=True)
    raw = sys.stdin.readline()
    return extract_poll_token(raw)


# =============================================================================
# HTTP helpers (organiser bearer + public/anonymous)
# =============================================================================


def get_whoami(sched: SchedulerClient) -> tuple[int, dict]:
    r = sched.request("GET", "/v1/whoami")
    return r.status_code, safe_json_body(r.text)


def check_whoami(body: dict, expected_email: str, provider: str) -> str | None:
    """Pure predicate behind main()'s preflight GET /v1/whoami guard (WP2.4 —
    poll-smoke had no preflight at all before this): returns an error message
    if `body` (whoami's JSON) doesn't match, else None.

    - `email` must casefold-equal `expected_email` — a wrong A_BEARER should
      fail here, in the first second of the run, not mid-run against a
      confusing 403/404 on a poll it never created.
    - If `body` carries a 'provider' key (additive — worker/src/handlers/
      whoami.ts, WP0 of internal design notes) it must equal
      `provider`: the guard that stops a Google bearer running under
      --provider microsoft from failing twenty minutes in on a confusing
      Graph 401 instead of failing here. A body with no 'provider' key (an
      older worker, pre-WP0) skips that half silently rather than failing."""
    got_email = body.get("email") or ""
    if got_email.casefold() != expected_email.casefold():
        return (
            f"whoami email {got_email!r} does not match expected organiser "
            f"{expected_email!r} — wrong A_BEARER for this run?"
        )
    if "provider" in body:
        got_provider = body.get("provider")
        if got_provider != provider:
            return (
                f"whoami provider {got_provider!r} does not match --provider "
                f"{provider!r} — wrong bearer (or wrong --provider flag) for this run"
            )
    return None


def whoami_provider_warning(body: dict) -> str | None:
    """A one-line stderr warning for when `body` (whoami's JSON) has no
    'provider' key — check_whoami correctly treats that as "skip the
    provider check, don't fail" (an older, pre-WP0 worker), but the OPERATOR
    should still be told: a Google bearer run under --provider microsoft
    will only surface as a confusing Graph 401 later, not fail cleanly here.
    None when 'provider' IS present, whether it matches or not — a mismatch
    there is check_whoami's job, not this one's."""
    if "provider" in body:
        return None
    return (
        "whoami has no provider field — provider guard skipped; a Google "
        "bearer under --provider microsoft will fail later as a Graph 401"
    )


def post_poll(sched: SchedulerClient, body: dict) -> tuple[int, dict]:
    r = sched.request("POST", "/v1/polls", json=body)
    return r.status_code, safe_json_body(r.text)


def get_poll(sched: SchedulerClient, poll_id: str) -> tuple[int, dict]:
    r = sched.request("GET", f"/v1/polls/{poll_id}")
    return r.status_code, safe_json_body(r.text)


def patch_poll(sched: SchedulerClient, poll_id: str, body: dict) -> tuple[int, dict]:
    r = sched.request("PATCH", f"/v1/polls/{poll_id}", json=body)
    return r.status_code, safe_json_body(r.text)


def wait_for_poll_status(
    sched: SchedulerClient, poll_id: str, want: set[str], timeout: float = 60.0, interval: float = 2.0
) -> dict:
    """Poll GET /v1/polls/:id until status is one of `want`. The all-in ->
    book-or-escalate transition is fire-and-forget (waitUntil) behind the
    triggering PUT /response, so this closes that latency the same way
    meeting-smoke.py's wait_for_attendee_accept closes RSVP propagation."""
    deadline = _time.monotonic() + timeout
    last: dict = {}
    while _time.monotonic() < deadline:
        status, body = get_poll(sched, poll_id)
        if status != 200:
            raise AssertionError(f"wait_for_poll_status: GET poll {poll_id}: {status} {body!r}")
        last = body
        if body.get("status") in want:
            return body
        _time.sleep(interval)
    raise AssertionError(
        f"wait_for_poll_status: poll {poll_id} never reached {want!r} within "
        f"{timeout:.0f}s (last status {last.get('status')!r})"
    )


def hold_poll_status(
    sched: SchedulerClient, poll_id: str, want: str, hold_seconds: float = 25.0, interval: float = 3.0
) -> dict:
    """The negative-space counterpart to wait_for_poll_status: asserts the
    poll's status does NOT leave `want` for `hold_seconds` (2026-08-16
    fix-pass — the old all-in trigger booked/escalated within a couple of
    seconds, so this window is generous). Samples on `interval`, stops
    sampling the moment a divergence is seen (no point polling further once
    the assertion has already failed), and hands every observed status to
    poll_status_stayed for the actual pass/fail decision — this function is
    just the live loop around that pure predicate. Raises AssertionError with
    every observed status on failure, same "raise on unmet expectation"
    convention as wait_for_poll_status."""
    deadline = _time.monotonic() + hold_seconds
    observed: list[str] = []
    last_body: dict = {}
    while _time.monotonic() < deadline:
        status, body = get_poll(sched, poll_id)
        if status != 200:
            raise AssertionError(f"hold_poll_status: GET poll {poll_id}: {status} {body!r}")
        last_body = body
        observed.append(body.get("status", ""))
        if body.get("status") != want:
            break
        _time.sleep(interval)
    if not poll_status_stayed(observed, want):
        raise AssertionError(
            f"hold_poll_status: poll {poll_id} did not hold status {want!r} for {hold_seconds:.0f}s "
            f"(observed {observed!r}, last body {last_body!r})"
        )
    return last_body


def wait_for_confirmed_booking(
    sched: SchedulerClient, window_from: str, window_to: str, poll_id: str,
    timeout: float = 10.0, interval: float = 2.0,
) -> dict:
    """P5's confirm-wait: polls GET /v1/bookings until a row for `poll_id`
    reads "confirmed" (poll_booking_rows + booking_wait_outcome), or raises on
    timeout with a message that distinguishes the two failure shapes (see
    booking_wait_timeout_message) — 2026-08-17 adversarial-review finding 1.
    The worker publishes poll status "booked" (casSetBooked,
    polls/booking.ts:609) BEFORE confirmBooking flips the bookings row
    reserving->confirmed (:625), so a one-shot check right after
    wait_for_poll_status observes "booked" can catch a transient "reserving"
    row — this closes that race the same way wait_for_poll_status closes the
    all-in -> auto-book one.

    A 403 {"error":"feature_disabled"} (finding 2: GET /v1/bookings sits
    behind BOOKING_PAGE_ENABLED, which polls don't otherwise need) fails
    immediately with bookings_feature_disabled_message rather than being
    retried or read as a poll bug."""
    deadline = _time.monotonic() + timeout
    start = _time.monotonic()
    rows: list[dict] = []
    while True:
        r = sched.request("GET", "/v1/bookings", params={"from": window_from, "to": window_to})
        body = safe_json_body(r.text)
        if bookings_disabled_by_flag(r.status_code, body):
            raise AssertionError(bookings_feature_disabled_message())
        if r.status_code != 200:
            raise AssertionError(f"wait_for_confirmed_booking: GET /v1/bookings: {r.status_code} {body!r}")
        rows = poll_booking_rows(body.get("bookings", []), poll_id)
        outcome = booking_wait_outcome(rows)
        if outcome == "confirmed":
            return rows[0]
        if _time.monotonic() >= deadline:
            raise AssertionError(
                booking_wait_timeout_message(outcome, poll_id, _time.monotonic() - start, rows)
            )
        _time.sleep(interval)


def public_grid(public: httpx.Client, url: str, poll_id: str, token: str) -> tuple[int, dict]:
    r = public.get(f"{url}/poll/{poll_id}/grid", params={"t": token})
    return r.status_code, safe_json_body(r.text)


def public_put_response(
    public: httpx.Client, url: str, poll_id: str, token: str, cells: list[str], name: str, hide_name: bool = False
) -> tuple[int, dict]:
    r = public.put(
        f"{url}/poll/{poll_id}/response",
        params={"t": token},
        json={
            "cells": [{"cell": c, "state": "free"} for c in cells],
            "hideName": hide_name,
            "name": name,
        },
    )
    return r.status_code, safe_json_body(r.text)


# =============================================================================
# Poll body builders
# =============================================================================


def poll_range(now: datetime) -> tuple[str, str]:
    start = (now + timedelta(days=1)).date().isoformat()
    end = (now + timedelta(days=7)).date().isoformat()
    return start, end


def bookbest_poll_range(now: datetime) -> tuple[str, str]:
    """BOOKBEST's own range (+3 -> +9 days out), separate from the shared
    poll_range's +1 -> +7 used by every other mode. The two ranges DO
    overlap (days +3..+7) — the real separation from what
    HAPPY/UNHAPPY/HIDDEN/GUESTWAIT paint is selector DIRECTION, not range
    disjointness: overlapping_choice/disjoint_choices pick from the sorted
    EARLIEST offered cells, bookbest_cell_choice picks the LATEST qualifying
    one (see that function's docstring). The wider start (+3d, not +1d)
    exists so bookbest_cell_choice has room to find a slot well clear of the
    min-notice frontier."""
    start = (now + timedelta(days=3)).date().isoformat()
    end = (now + timedelta(days=9)).date().isoformat()
    return start, end


def bookbest_cell_choice(paintable: list[str], now: datetime) -> str:
    """Choose a BOOKBEST cell that is the structural opposite of the
    zero-slack lone hole that sank a live run (todo.md "poll-smoke BOOKBEST
    stakes its only candidate on a zero-slack slot": paintableCells[0] landed
    on a 30-minute hole with zero slack, and a boundary shift between the
    grid read and the booking engine's fresh re-validation deleted the only
    candidate). In order:
      1. keep only cells >= 48h out from `now` — clear of dev's
         MEETING_MIN_NOTICE_MINUTES and any near-now busy edge. Belt-and-
         braces: with BOOKBEST's own +3d range start (bookbest_poll_range)
         the earliest possible offered cell is already ~49h out, so this
         floor should never actually reject anything in practice — it's an
         explicit guard, not a load-bearing filter;
      2. of those, keep only cells whose BOTH 30-minute neighbours
         (cell -30min, cell +30min) are also in `paintable` — the middle of
         a contiguous >= 90-minute free run, so losing either boundary edge
         still leaves the cell bookable. Compared as INSTANTS, not string
         renderings: the worker's grid always emits millisecond-precision
         timestamps (`new Date(t).toISOString()`, worker/src/polls/grid.ts),
         so re-rendering a computed neighbour via Python's bare-second
         isoformat() would never match the worker's ".000Z" strings — same
         Z/offset/ms-precision trap _instants_equal guards against in
         bin/regression-smoke.py;
      3. pick the chronologically latest survivor (latest day, then latest
         time-of-day that day) — an afternoon-leaning pick, deliberately a
         different time-of-day band from overlapping_choice/disjoint_choices'
         sorted-earliest (morning) selections.
    Deterministic for a given (paintable, now). Raises AssertionError naming
    the full offered list if nothing survives step 2 — fail loudly at PAINT
    time, not as a 409 no_qualifying_slot at booking time."""
    uniq = sorted(set(paintable))
    parsed = {cell: datetime.fromisoformat(cell) for cell in uniq}
    have_instants = set(parsed.values())
    floor = now + timedelta(hours=48)

    def has_both_neighbours(cell: str) -> bool:
        dt = parsed[cell]
        return (dt - timedelta(minutes=30)) in have_instants and (dt + timedelta(minutes=30)) in have_instants

    candidates = [c for c in uniq if parsed[c] >= floor and has_both_neighbours(c)]
    if not candidates:
        raise AssertionError(
            f"bookbest_cell_choice: no cell >=48h out with both 30-min neighbours "
            f"also paintable, among {uniq!r}"
        )
    return max(candidates, key=lambda c: parsed[c])


def short_deadline(now: datetime, hours: float = 2.0) -> str:
    return (now + timedelta(hours=hours)).isoformat().replace("+00:00", "Z")


def deadline_extension_target(current_deadline_iso: str, range_end: str, extend_hours: float = 1.0) -> str:
    """EDIT mode's deadline-arm PATCH target: `current_deadline_iso` +
    `extend_hours`, capped so it never crosses validateDeadline's own ceiling
    (23:59:59 UTC on `range_end`, `worker/src/handlers/polls.ts:296`) — capped
    a minute short of that (23:59:00Z) as margin against the few-second gap
    between this computation and the PATCH actually landing.

    Deliberately derived from the poll's ACTUAL current deadline (read back
    via getMeetingPoll after creation), not an assumed/hardcoded value:
    POLL_SMOKE_DEADLINE_HOURS can widen create_poll_body's 2h default (see
    that env var's docstring) for operators relying on the slower
    interactive/manual token-relay path, and a fixed "+Nh from an assumed
    default" would silently stop tracking the real deadline once that env
    var is set.

    Raises AssertionError if there is no room left to extend into (the
    current deadline is already at/after the capped ceiling) — a setup bug
    (an operator-widened deadline eating the whole range), not something to
    silently paper over with a same-or-earlier "extension"."""
    current = datetime.fromisoformat(current_deadline_iso.replace("Z", "+00:00"))
    ceiling = datetime.fromisoformat(f"{range_end}T23:59:00+00:00")
    target = min(current + timedelta(hours=extend_hours), ceiling)
    if target <= current:
        raise AssertionError(
            f"deadline_extension_target: no room to extend past {current_deadline_iso!r} "
            f"within rangeEnd {range_end!r} (ceiling {ceiling.isoformat()!r})"
        )
    return target.isoformat().replace("+00:00", "Z")


def create_poll_body(
    title_suffix: str,
    invitees: list[dict],
    now: datetime,
    deadline_hours: float | None = None,
    range_fn: Callable[[datetime], tuple[str, str]] = poll_range,
) -> dict:
    # "Short deadline" per the task card, but tunable: token capture is
    # mailbox-first since the 2026-08-17 Gmail relay (resolve_token), but the
    # relay can be unavailable (scope not consented, circuit-broken mid-run),
    # dropping the operator back to the manual email-relay path, which can
    # take longer than a couple of hours in the worst case.
    # POLL_SMOKE_DEADLINE_HOURS lets an operator widen it for such a run
    # without editing the script; the 2h default stays short for unattended
    # runs with the relay active. The env-var default governs every
    # create_poll_body call that doesn't pass deadline_hours explicitly — the
    # main BOOKBEST poll pins its own 72h (run_bookbest_mode); the
    # BOOKBEST-zero poll keeps the default.
    if deadline_hours is None:
        deadline_hours = float(os.environ.get("POLL_SMOKE_DEADLINE_HOURS", "2"))
    rng_start, rng_end = range_fn(now)
    return {
        "title": f"{HARNESS_TITLE_PREFIX} {title_suffix}",
        "invitees": invitees,
        "durationMin": 30,
        "rangeStart": rng_start,
        "rangeEnd": rng_end,
        "deadlineUtc": short_deadline(now, deadline_hours),
        "location": {"kind": "phone", "detail": "+61 4 0000 0000"},
        "guestLink": False,
    }


# =============================================================================
# Cleanup — direct D1, lineage-robust (title-prefix match), mirrors
# booking-smoke.py's cleanup_booking_row / reset-smoke-env.py's title sweep
# =============================================================================


def wipe_harness_polls(d1: DevD1, dry_run: bool = False) -> int:
    """Delete every poll this harness created (title LIKE '[pollsmoke]%'),
    cascading through poll_responses -> poll_invitees -> bookings -> polls.
    Direct D1: there is no DELETE endpoint for any of these tables. Returns
    the number of poll rows deleted (0 in dry-run, which only reports)."""
    prefix = HARNESS_TITLE_PREFIX.replace("'", "''")
    like = f"{prefix}%"
    rows = d1.query(f"SELECT id FROM polls WHERE title LIKE {sql_str(like)}")
    poll_ids = [r["id"] for r in rows if isinstance(r.get("id"), str)]
    if dry_run or not poll_ids:
        return 0
    id_list = ",".join(sql_str(pid) for pid in poll_ids)
    d1.execute(
        f"DELETE FROM poll_responses WHERE invitee_id IN "
        f"(SELECT id FROM poll_invitees WHERE poll_id IN ({id_list}))"
    )
    d1.execute(f"DELETE FROM poll_invitees WHERE poll_id IN ({id_list})")
    d1.execute(f"DELETE FROM bookings WHERE poll_id IN ({id_list})")
    d1.execute(f"DELETE FROM polls WHERE id IN ({id_list})")
    return len(poll_ids)


def manual_poll_cleanup_hint(wrangler_env: str = "dev") -> str:
    return (
        "D1_DATABASE_ID not set — poll rows NOT deleted automatically. Clean up manually:\n"
        f"    cd worker && npx wrangler d1 execute DB --env {wrangler_env} --remote --command "
        f'"DELETE FROM poll_responses WHERE invitee_id IN (SELECT id FROM poll_invitees '
        f"WHERE poll_id IN (SELECT id FROM polls WHERE title LIKE '{HARNESS_TITLE_PREFIX}%')); "
        f"DELETE FROM poll_invitees WHERE poll_id IN (SELECT id FROM polls WHERE title LIKE "
        f"'{HARNESS_TITLE_PREFIX}%'); DELETE FROM bookings WHERE poll_id IN (SELECT id FROM polls "
        f"WHERE title LIKE '{HARNESS_TITLE_PREFIX}%'); DELETE FROM polls WHERE title LIKE "
        f"'{HARNESS_TITLE_PREFIX}%'\""
    )


# =============================================================================
# Steps
# =============================================================================


@dataclass
class StepResult:
    label: str
    passed: bool
    notes: str = ""


@dataclass
class RunState:
    results: list[StepResult] = field(default_factory=list)
    poll_ids: set[str] = field(default_factory=set)
    event_ids: set[str] = field(default_factory=set)

    def ok(self, label: str, notes: str = "") -> None:
        print(f"{label} PASS" + (f" — {notes}" if notes else ""))
        self.results.append(StepResult(label, True, notes))

    def fail(self, label: str, notes: str) -> None:
        print(f"{label} FAIL — {notes}")
        self.results.append(StepResult(label, False, notes))

    def soft_note(self, label: str, notes: str) -> None:
        # A step that is not a pass/fail against THIS harness's code — e.g. a
        # documented gap between the plan and the currently-merged behaviour
        # (see P6). Recorded but never fails the run.
        print(f"{label} NOTE — {notes}")


def run_happy_path(env: PollSmokeEnv, sched: SchedulerClient, cal: CalendarLike, public: httpx.Client, state: RunState) -> None:
    now = datetime.now(timezone.utc)
    invitees = [
        {"email": env.invitee_a_email, "name": "Poll Smoke A"},
        {"email": env.invitee_b_email, "name": "Poll Smoke B"},
    ]
    poll_body_req = create_poll_body("P1 happy", invitees, now)
    poll_title = poll_body_req["title"]
    status, body = post_poll(sched, poll_body_req)
    if status != 201:
        if status == 403 and body.get("error") == "feature_disabled":
            state.soft_note("P1", "MEETING_POLL_ENABLED is not on for this deployment — SKIPPING the whole run")
            raise SystemExit(2)
        state.fail("P1", f"create poll: {status} {body!r}")
        return
    poll_id = body["id"]
    state.poll_ids.add(poll_id)
    state.ok("P1", f"poll {poll_id} created")

    # P2 — delivery itself is not independently verifiable (see module
    # docstring's KNOWN GAP); assert what the API can prove: both invitees
    # are registered against the poll, unresponded.
    status, poll_body = get_poll(sched, poll_id)
    if status != 200:
        state.fail("P2", f"GET poll: {status} {poll_body!r}")
        return
    got_emails = {i["email"] for i in poll_body.get("invitees", [])}
    want_emails = {env.invitee_a_email, env.invitee_b_email}
    if got_emails != want_emails or any(i["responded"] for i in poll_body["invitees"]):
        state.fail("P2", f"invitees not registered as expected: {poll_body.get('invitees')!r}")
        return
    state.ok("P2", "both invitees registered, unresponded (email CONTENT not verified — see KNOWN GAP)")

    token_a = resolve_token("INVITEE_A_TOKEN", "invitee A", poll_id, env.invitee_a_email)
    token_b = resolve_token("INVITEE_B_TOKEN", "invitee B", poll_id, env.invitee_b_email)

    # P3 — invitee A
    status, grid_a = public_grid(public, env.url, poll_id, token_a)
    if status != 200 or "paintableCells" not in grid_a:
        state.fail("P3", f"GET grid (A): {status} {grid_a!r}")
        return
    try:
        cells = overlapping_choice(grid_a["paintableCells"], count=2)
    except ValueError as e:
        state.fail("P3", str(e))
        return
    status, resp_a = public_put_response(public, env.url, poll_id, token_a, cells, "Poll Smoke A")
    if status != 200:
        state.fail("P3", f"PUT response (A): {status} {resp_a!r}")
        return
    if not grid_response_has_who_arrays(resp_a.get("aggregate", {})):
        state.fail("P3", f"aggregate missing freeWho/ifNeededWho (decision D3/M3 contract): {resp_a.get('aggregate')!r}")
        return
    state.ok("P3", f"invitee A painted {cells!r}, aggregate carries freeWho/ifNeededWho")

    # STATUS — organiser status page (T11's worker/src/web/poll-status-page.ts,
    # R4-M3). Placed HERE deliberately: A has responded and B has not, so the
    # poll is definitely still "open" with real content to render (roster
    # showing a mixed responded/not state, non-empty candidates), and this is
    # BEFORE P4's PUT, which is what fires the all-in -> auto-book race — a
    # status-page check placed after P4 could lose that race and hit an
    # already-booked poll depending on timing. Authenticated: GET /poll/:id/
    # status is requireOwner (bearer), NOT a public/invitee-token link, so
    # this goes through `sched` (same auth the /v1 poll ops already use in
    # this smoke), not `public`.
    r = sched.request("GET", f"/poll/{poll_id}/status")
    if r.status_code != 200:
        state.fail("STATUS", f"GET status page: {r.status_code} {r.text[:300]!r}")
        return
    status_html = r.text
    if not status_page_has_landmarks(status_html, poll_title, ["Poll Smoke A", "Poll Smoke B"]):
        state.fail("STATUS", f"status page missing title/invitee-name landmarks: {status_html[:300]!r}")
        return
    # HARD check (Card A, 2026-08-16 fix-pass): invitee A has already painted
    # (P3, above), so the aggregate table exists — the icon markup is only
    # required once there's something to render.
    if not status_page_has_icon_aggregate(status_html):
        state.fail(
            "STATUS",
            f"aggregate table missing icon markup (av-free/legend/two-tier header — Card A "
            f"fix-pass): {status_html[:500]!r}",
        )
        return
    roster_ok = status_page_mentions(status_html, ("roster", "invitee", "respondent"))
    candidates_ok = status_page_mentions(status_html, ("candidate", "best time", "top time", "score"))
    if roster_ok and candidates_ok:
        state.ok(
            "STATUS",
            "status page 200s, carries title + both invitee names, icon aggregate markup present, "
            "roster + candidates wording present",
        )
    else:
        # Best-effort keyword guess (see status_page_mentions) — T11's file
        # was not in this worktree when this harness was written, so its
        # actual copy is unknown. A miss here is a wording mismatch OR a
        # genuine missing section; NOTE rather than FAIL either way (same
        # reasoning as P6), but call out which keyword set missed so a human
        # can tell the difference at a glance.
        state.soft_note(
            "STATUS",
            f"status page 200s with title/invitee-name landmarks, but best-effort keyword "
            f"check missed (roster_hint={roster_ok}, candidates_hint={candidates_ok}) — "
            f"either T11's actual wording differs from the guessed hints, or the section is "
            f"genuinely missing; worth a human look",
        )

    # P4 — invitee B, SAME cells (guarantees an intersection -> auto-book)
    status, grid_b = public_grid(public, env.url, poll_id, token_b)
    if status != 200:
        state.fail("P4", f"GET grid (B): {status} {grid_b!r}")
        return
    offered = set(grid_b.get("paintableCells", []))
    if not set(cells).issubset(offered):
        state.fail("P4", f"A's chosen cells {cells!r} not all offered to B: {sorted(offered)!r}")
        return
    status, resp_b = public_put_response(public, env.url, poll_id, token_b, cells, "Poll Smoke B")
    if status != 200:
        state.fail("P4", f"PUT response (B): {status} {resp_b!r}")
        return
    state.ok("P4", f"invitee B painted the same cells {cells!r} (overlapping)")

    # P5 — auto-book
    try:
        booked = wait_for_poll_status(sched, poll_id, {"booked", "needs_attention"})
    except AssertionError as e:
        state.fail("P5", str(e))
        return
    if booked["status"] != "booked":
        state.fail("P5", f"expected booked, got {booked['status']!r} (candidates may not actually intersect): {booked!r}")
        return
    event_id = booked.get("gcalEventId")
    if not event_id or not booked.get("bookedSlotUtc"):
        state.fail("P5", f"booked poll missing gcalEventId/bookedSlotUtc: {booked!r}")
        return
    state.event_ids.add(event_id)

    window_from = (now - timedelta(days=1)).isoformat()
    window_to = (now + timedelta(days=8)).isoformat()
    events = cal.list_events(window_from, window_to)
    matches = [e for e in events if e.get("id") == event_id]
    if not matches:
        state.fail("P5", f"calendar event {event_id} not found via events.list")
        return
    event = matches[0]
    attendee_emails = {a.get("email", "").lower() for a in (event.get("attendees") or [])}
    non_hidden_invitees = [
        {"email": env.invitee_a_email, "dropped": False, "hideName": False},
        {"email": env.invitee_b_email, "dropped": False, "hideName": False},
    ]
    want_attendees = {e.lower() for e in expected_attendee_emails(non_hidden_invitees)}
    if attendee_emails != want_attendees:
        state.fail("P5", f"event attendees {attendee_emails!r} != expected non-hidden invitees {want_attendees!r}")
        return
    tag = (event.get("extendedProperties") or {}).get("private", {}).get("optical_poll_id")
    if tag != poll_id:
        state.fail("P5", f"event missing optical_poll_id tag (got {tag!r})")
        return

    # Short retry loop, not a one-shot check: the worker publishes poll status
    # "booked" BEFORE confirmBooking flips the bookings row reserving->
    # confirmed, so we just arrived here off wait_for_poll_status seeing
    # "booked" and can legitimately still catch a transient "reserving" row —
    # see wait_for_confirmed_booking's docstring (2026-08-17 adversarial-
    # review finding 1).
    try:
        wait_for_confirmed_booking(sched, window_from, window_to, poll_id)
    except AssertionError as e:
        state.fail("P5", str(e))
        return
    state.ok("P5", f"poll booked, event {event_id} carries both non-hidden attendees + optical_poll_id, bookings row confirmed")

    # P6 — imported-task check (see the long comment: this currently should
    # NOT find a row — see the docstring note below and the final report).
    r = sched.request("GET", "/v1/tasks")
    if r.status_code != 200:
        state.fail("P6", f"GET /v1/tasks: {r.status_code} {r.text[:300]!r}")
        return
    matches = [t for t in r.json().get("tasks", []) if task_is_pollsmoke_meeting_import(t, {event_id})]
    if matches:
        task = matches[0]
        if task.get("pinned_at") and task.get("context") == "meeting":
            state.ok("P6", f"imported task {task.get('id')} is pinned_at={task['pinned_at']!r}, context=meeting")
        else:
            state.fail("P6", f"imported task found but not pinned+context=meeting: {task!r}")
    else:
        # See the T13 implementation report: as of the wave-2 code this
        # harness was written against, meetings/identify.ts's
        # isOwnedMovableMeeting EXCLUDES optical_poll_id-tagged events from
        # the owned-movable-meeting sync (meetings/sync.ts), and
        # polls/booking.ts's bookPollSlotInternal never inserts a `tasks`
        # row of its own — so "pinned" is currently delivered by the event
        # simply never being imported as a (movable) task at all, not by a
        # dedicated pinned task row. That satisfies spec decision 8's
        # immovability guarantee today, but does not match wave3-additions.md
        # item 4's literal "assert the resulting task row is pinned" wording.
        # Recorded as a NOTE, not a FAIL — failing would flag working-as-
        # designed code. Flagged prominently in the implementation report for
        # the orchestrator to confirm which is actually intended.
        state.soft_note(
            "P6",
            f"no /v1/tasks row for event {event_id} (source.kind=meeting) — consistent with "
            f"isOwnedMovableMeeting's optical_poll_id exclusion, NOT with a 'pinned task row' "
            f"reading of wave3-additions.md item 4; see implementation report",
        )

    # P7 — cancel on an already-booked poll must be refused. This is the CAS
    # guard in handlers/polls.ts's cancel handler (casSetPollStatus against
    # ["open","needs_attention"]) protecting a booked poll from being
    # clobbered back to cancelled — a real asserted step now, not a
    # fire-and-forget best-effort call (cleanup still happens via D1 below
    # regardless of this outcome).
    r = sched.request("POST", f"/v1/polls/{poll_id}/cancel")
    if r.status_code != 409:
        state.fail("P7", f"expected 409 cancelling an already-booked poll, got {r.status_code} {r.text[:300]!r}")
        return
    cancel_body = safe_json_body(r.text)
    if cancel_body.get("error") != "invalid_status":
        state.fail("P7", f"expected error=invalid_status cancelling a booked poll, got {cancel_body!r}")
        return
    state.ok("P7", "cancel on the booked poll correctly refused (409 invalid_status)")


def run_nudge_check(env: PollSmokeEnv, sched: SchedulerClient, public: httpx.Client, state: RunState) -> None:
    now = datetime.now(timezone.utc)
    nudge_email = os.environ.get("NUDGE_INVITEE_EMAIL", env.invitee_a_email)
    status, body = post_poll(
        sched, create_poll_body("NUDGE", [{"email": nudge_email, "name": "Poll Smoke Nudge Target"}], now)
    )
    if status != 201:
        state.fail("NUDGE", f"create poll: {status} {body!r}")
        return
    poll_id = body["id"]
    state.poll_ids.add(poll_id)

    status, poll_body = get_poll(sched, poll_id)
    if status != 200 or not nudge_is_permitted(poll_body.get("status", "")):
        state.fail("NUDGE", f"poll not open before nudge: {status} {poll_body!r}")
        return

    # Captured immediately BEFORE the nudge POST: the nudge rotates the
    # invitee's token, so the mailbox must only accept a link sent at/after
    # this moment — otherwise the still-landed pre-nudge INVITE email is a
    # valid (but dead-after-nudge) match, and resolve_token would hand back
    # a token guaranteed to 401 on the very next GET (see newest_matching_link
    # and resolve_token's not_before docstrings).
    nudge_not_before = int(_time.time())
    r = sched.request("POST", f"/v1/polls/{poll_id}/nudge")
    if r.status_code != 200:
        state.fail("NUDGE", f"POST nudge: {r.status_code} {r.text[:300]!r}")
        return
    nudge_body = r.json()
    if nudge_body.get("nudged") != [nudge_email] or nudge_body.get("totalCount") != 1:
        state.fail("NUDGE", f"unexpected nudge response: {nudge_body!r}")
        return
    state.ok("NUDGE-send", f"nudged {nudge_email!r} on open poll {poll_id}")

    fresh_token = resolve_token(
        "NUDGE_TOKEN", "the nudge target", poll_id, nudge_email, not_before=nudge_not_before,
    )

    r = public.get(f"{env.url}/poll/{poll_id}", params={"t": fresh_token})
    if r.status_code != 200:
        state.fail("NUDGE-resolve", f"GET nudged link: {r.status_code}")
        return
    html = r.text
    if not bootstrap_attrs_present(html, poll_id, fresh_token):
        state.fail("NUDGE-resolve", "page did not bootstrap with the freshly nudged data-poll-id/data-token")
        return
    asset_path = client_asset_src(html)
    if not asset_path:
        state.fail("NUDGE-resolve", f"page did not reference the hashed client module: {html[:300]!r}")
        return
    r = public.get(f"{env.url}{asset_path}")
    if r.status_code != 200 or "text/javascript" not in r.headers.get("content-type", ""):
        state.fail("NUDGE-resolve", f"client JS asset not served: {r.status_code} {r.headers.get('content-type')!r}")
        return
    state.ok(
        "NUDGE-resolve",
        f"nudged link resolves 200, bootstrap attrs present, client JS asset {asset_path} served "
        f"(a true browser render remains a MANUAL step — see module docstring)",
    )

    sched.request("POST", f"/v1/polls/{poll_id}/nudge")  # harmless re-nudge is fine; ignored either way

    # Trailing cancel: this poll never got painted, so it's still open —
    # cancel must succeed (200, status=cancelled). Cancellation EMAILS to the
    # invitee are not verified here (email-content assertions not implemented
    # — see the module docstring's KNOWN GAP); the operator can see it arrive
    # in the real inbox as a manual bonus check.
    r = sched.request("POST", f"/v1/polls/{poll_id}/cancel")
    if r.status_code != 200:
        state.fail("NUDGE-cancel", f"expected 200 cancelling an open poll, got {r.status_code} {r.text[:300]!r}")
        return
    cancel_body = safe_json_body(r.text)
    if cancel_body.get("status") != "cancelled":
        state.fail("NUDGE-cancel", f"unexpected cancel body: {cancel_body!r}")
        return
    state.ok(
        "NUDGE-cancel",
        "open poll cancelled (200, status=cancelled) — cancellation email content not verified, "
        "see module docstring KNOWN GAP",
    )


def run_unhappy_mode(env: PollSmokeEnv, sched: SchedulerClient, public: httpx.Client, state: RunState) -> None:
    now = datetime.now(timezone.utc)
    invitees = [
        {"email": env.invitee_a_email, "name": "Poll Smoke Unhappy A"},
        {"email": env.invitee_b_email, "name": "Poll Smoke Unhappy B"},
    ]
    status, body = post_poll(sched, create_poll_body("UNHAPPY", invitees, now))
    if status != 201:
        state.fail("UNHAPPY", f"create poll: {status} {body!r}")
        return
    poll_id = body["id"]
    state.poll_ids.add(poll_id)

    token_a = resolve_token("UNHAPPY_A_TOKEN", "unhappy invitee A", poll_id, env.invitee_a_email)
    token_b = resolve_token("UNHAPPY_B_TOKEN", "unhappy invitee B", poll_id, env.invitee_b_email)

    status, grid_a = public_grid(public, env.url, poll_id, token_a)
    if status != 200:
        state.fail("UNHAPPY", f"GET grid (A): {status} {grid_a!r}")
        return
    try:
        cell_a, cell_b = disjoint_choices(grid_a["paintableCells"])
    except ValueError as e:
        state.fail("UNHAPPY", str(e))
        return

    status, _ = public_put_response(public, env.url, poll_id, token_a, cell_a, "Unhappy A")
    if status != 200:
        state.fail("UNHAPPY", f"PUT response (A): {status}")
        return
    status, _ = public_put_response(public, env.url, poll_id, token_b, cell_b, "Unhappy B")
    if status != 200:
        state.fail("UNHAPPY", f"PUT response (B): {status}")
        return

    try:
        after = wait_for_poll_status(sched, poll_id, {"needs_attention", "booked"})
    except AssertionError as e:
        state.fail("UNHAPPY", str(e))
        return
    if after["status"] != "needs_attention":
        state.fail("UNHAPPY", f"expected needs_attention from disjoint paints, got {after['status']!r}: {after!r}")
        return
    if after.get("bookedSlotUtc") is not None or after.get("gcalEventId") is not None:
        state.fail("UNHAPPY", f"needs_attention poll unexpectedly carries a booked slot/event: {after!r}")
        return
    state.ok(
        "UNHAPPY",
        f"disjoint paints ({cell_a!r} vs {cell_b!r}) -> needs_attention "
        f"(escalation email CONTENT not verified — see KNOWN GAP)",
    )

    # UNHAPPY2a — needs_attention unlock (Card B, 2026-08-16 fix-pass): GET
    # /poll/:id/grid on an escalated poll now returns the FULL grid payload,
    # not the closed {status:...} shape it used to.
    status, grid_after = public_grid(public, env.url, poll_id, token_a)
    if status != 200:
        state.fail("UNHAPPY2a", f"GET grid on needs_attention poll: {status} {grid_after!r}")
        return
    if not grid_is_unlocked(grid_after):
        state.fail(
            "UNHAPPY2a",
            f"needs_attention poll's grid GET returned a closed/status-only payload: {grid_after!r}",
        )
        return
    state.ok("UNHAPPY2a", "needs_attention poll's GET grid returns a full unlocked payload, not {status:...}")

    # UNHAPPY2b — invitee A revises to ALSO paint B's cell (creating an
    # overlap) via PUT, which the fix-pass explicitly allows past the
    # deadline on a needs_attention poll (route.ts's deadline gate now only
    # applies to open polls). The save must succeed, but the poll must NOT
    # auto-book off the back of it — that stays the organiser's manual
    # resolveMeetingPoll call (booking.ts's maybeBookOnAllIn is never even
    # invoked here: route.ts only fires it when the FRESH poll status is
    # "open", and this poll is needs_attention both before and after the
    # PUT). Held across a window rather than checked once, in case the old
    # instant-fire behaviour regresses.
    status, put_after = public_put_response(public, env.url, poll_id, token_a, cell_a + cell_b, "Unhappy A")
    if status != 200:
        state.fail("UNHAPPY2b", f"PUT revise (A, now overlapping B): {status} {put_after!r}")
        return
    try:
        hold_poll_status(sched, poll_id, "needs_attention", hold_seconds=25.0, interval=3.0)
    except AssertionError as e:
        state.fail("UNHAPPY2b", f"needs_attention poll auto-booked after an unlocked invitee edit: {e}")
        return
    state.ok(
        "UNHAPPY2b",
        f"invitee A revised to overlap B's cell {cell_b!r}; poll held needs_attention "
        f"(no auto-book off an unlocked edit)",
    )

    # UNHAPPY2c — manual nudge stays refused on needs_attention (unchanged by
    # the fix-pass; nudge_is_permitted is still the correct predicate — see
    # its own docstring for why the gate remains even though the grid unlocked).
    r = sched.request("POST", f"/v1/polls/{poll_id}/nudge")
    if r.status_code != 409:
        state.fail("UNHAPPY2c", f"expected 409 nudging a needs_attention poll, got {r.status_code} {r.text[:300]!r}")
        return
    state.ok("UNHAPPY2c", "nudge still refused (409) on needs_attention — nudge_is_permitted(status) is False")

    # UNHAPPY2d — the organiser rescues the poll via the real API, booking
    # the now-overlapping slot both invitees actually share (cell_b). This is
    # "unlocked poll edited until booked via organiser API call" end to end.
    r = sched.request("POST", f"/v1/polls/{poll_id}/resolve", json={"action": "book", "slotStartUtc": cell_b[0]})
    if r.status_code != 200:
        state.fail("UNHAPPY2d", f"resolve(action=book) on needs_attention poll: {r.status_code} {r.text[:300]!r}")
        return
    resolve_body = safe_json_body(r.text)
    if resolve_body.get("status") != "booked" or not resolve_body.get("gcalEventId"):
        state.fail("UNHAPPY2d", f"resolve(action=book) did not report booked+gcalEventId: {resolve_body!r}")
        return
    state.event_ids.add(resolve_body["gcalEventId"])
    state.ok(
        "UNHAPPY2d",
        f"organiser booked the escalated poll via resolve(action=book) at {cell_b[0]!r}, "
        f"event {resolve_body['gcalEventId']}",
    )

    # Trailing cancel: the poll is now booked (via UNHAPPY2d), so the CAS
    # guard must refuse it — same assertion as P7's, exercised here against a
    # poll that reached "booked" via the manual resolve path instead of
    # all-in auto-book.
    r = sched.request("POST", f"/v1/polls/{poll_id}/cancel")
    if r.status_code != 409:
        state.fail("UNHAPPY-cancel", f"expected 409 cancelling an already-booked poll, got {r.status_code} {r.text[:300]!r}")
        return
    state.ok("UNHAPPY-cancel", "cancel on the booked poll correctly refused (409 invalid_status)")


def run_hidden_invitee_mode(
    env: PollSmokeEnv, sched: SchedulerClient, cal: CalendarLike, public: httpx.Client, state: RunState
) -> None:
    """R4-M4: the smoke's happy path hardcodes hideName:False, so the
    hidden-invitee system path (exclusion from the booked event's attendees,
    T15's card) was previously only exercised against mocks — yet it silently
    drops a person from a calendar invite, which is exactly the class of bug
    a live check earns its keep on. Invitee B here paints WITH hideName:True;
    invitee A paints normally (visible). Both paint the SAME cells so this
    still auto-books (same overlapping-choice mechanism as the happy path),
    then asserts the booked event's attendees include A and EXCLUDE B.

    NOT verified here (documented, not silently skipped — same honesty rule
    as the token-relay KNOWN GAP): whether a booking-notice email + ICS
    attachment was actually QUEUED to B. The Gmail relay (2026-08-17) reads
    the organiser's Sent mail for personal LINKS only; content assertions —
    including confirming this notice went out — are the documented follow-up
    (module docstring KNOWN GAP). Until they land this is a TODO, not a
    claim."""
    now = datetime.now(timezone.utc)
    invitees = [
        {"email": env.invitee_a_email, "name": "Poll Smoke Hidden A"},
        {"email": env.invitee_b_email, "name": "Poll Smoke Hidden B"},
    ]
    status, body = post_poll(sched, create_poll_body("HIDDEN", invitees, now))
    if status != 201:
        state.fail("HIDDEN", f"create poll: {status} {body!r}")
        return
    poll_id = body["id"]
    state.poll_ids.add(poll_id)

    token_a = resolve_token("HIDDEN_A_TOKEN", "hidden-mode invitee A (visible)", poll_id, env.invitee_a_email)
    token_b = resolve_token("HIDDEN_B_TOKEN", "hidden-mode invitee B (hides name)", poll_id, env.invitee_b_email)

    status, grid_a = public_grid(public, env.url, poll_id, token_a)
    if status != 200 or "paintableCells" not in grid_a:
        state.fail("HIDDEN", f"GET grid (A): {status} {grid_a!r}")
        return
    try:
        cells = overlapping_choice(grid_a["paintableCells"], count=2)
    except ValueError as e:
        state.fail("HIDDEN", str(e))
        return

    status, _ = public_put_response(public, env.url, poll_id, token_a, cells, "Hidden A", hide_name=False)
    if status != 200:
        state.fail("HIDDEN", f"PUT response (A, visible): {status}")
        return
    status, _ = public_put_response(public, env.url, poll_id, token_b, cells, "Hidden B", hide_name=True)
    if status != 200:
        state.fail("HIDDEN", f"PUT response (B, hideName=True): {status}")
        return

    try:
        booked = wait_for_poll_status(sched, poll_id, {"booked", "needs_attention"})
    except AssertionError as e:
        state.fail("HIDDEN", str(e))
        return
    if booked["status"] != "booked":
        state.fail("HIDDEN", f"expected booked, got {booked['status']!r}: {booked!r}")
        return
    event_id = booked.get("gcalEventId")
    if not event_id:
        state.fail("HIDDEN", f"booked poll missing gcalEventId: {booked!r}")
        return
    state.event_ids.add(event_id)

    window_from = (now - timedelta(days=1)).isoformat()
    window_to = (now + timedelta(days=8)).isoformat()
    events = cal.list_events(window_from, window_to)
    matches = [e for e in events if e.get("id") == event_id]
    if not matches:
        state.fail("HIDDEN", f"calendar event {event_id} not found via events.list")
        return
    attendee_emails = {a.get("email", "").lower() for a in (matches[0].get("attendees") or [])}
    mixed_invitees = [
        {"email": env.invitee_a_email, "dropped": False, "hideName": False},
        {"email": env.invitee_b_email, "dropped": False, "hideName": True},
    ]
    want_attendees = {e.lower() for e in expected_attendee_emails(mixed_invitees)}
    if attendee_emails != want_attendees:
        state.fail(
            "HIDDEN",
            f"event attendees {attendee_emails!r} != expected (hidden invitee excluded) {want_attendees!r} "
            f"— decision D2 (hidden invitees excluded from the booked event)",
        )
        return
    state.ok(
        "HIDDEN",
        f"booked event attendees exclude the hideName=True invitee ({env.invitee_b_email}) — "
        f"TODO: booking-notice email/ICS to the hidden invitee not verified — email-content "
        f"assertions not implemented (see module docstring KNOWN GAP)",
    )

    # Trailing cancel: the poll is already booked, so the CAS guard must
    # refuse it — same assertion as P7's/UNHAPPY's, exercised against the
    # hidden-invitee variant.
    r = sched.request("POST", f"/v1/polls/{poll_id}/cancel")
    if r.status_code != 409:
        state.fail("HIDDEN-cancel", f"expected 409 cancelling an already-booked poll, got {r.status_code} {r.text[:300]!r}")
        return
    state.ok("HIDDEN-cancel", "cancel on the booked poll correctly refused (409 invalid_status)")


def run_guestwait_mode(env: PollSmokeEnv, sched: SchedulerClient, public: httpx.Client, state: RunState) -> None:
    """Card C (2026-08-16 fix-pass): a poll created with guestLink:true must
    NOT auto-book (or escalate) early, even once every NAMED invitee has
    responded and their responses overlap — it waits for its deadline,
    because a guest may still join. Both invitees paint the SAME cells here
    (the old pre-fix-pass all-in trigger would have booked this instantly);
    the fix-pass contract is asserted by holding "open" across a window and
    confirming no gcalEventId ever appears, then exercising the cancel
    success path (item 3b) on the still-open poll.

    NOT exercised here: guest self-join itself (worker/src/polls/route.ts's
    POST /poll/:id/join, requiring the guestUrl from create) — that needs a
    THIRD mailbox this harness's env vars don't provide (INVITEE_A_EMAIL/
    INVITEE_B_EMAIL only), and is out of scope for this pass; noted here the
    same way other deliberate gaps are, not silently skipped. This mode also
    deliberately does NOT wait out the real deadline (POLL_SMOKE_DEADLINE_HOURS
    is measured in hours) — only the early-book/escalate guard is asserted.
    """
    now = datetime.now(timezone.utc)
    invitees = [
        {"email": env.invitee_a_email, "name": "Poll Smoke Guestwait A"},
        {"email": env.invitee_b_email, "name": "Poll Smoke Guestwait B"},
    ]
    body_req = create_poll_body("GUESTWAIT", invitees, now)
    body_req["guestLink"] = True
    status, body = post_poll(sched, body_req)
    if status != 201:
        state.fail("GUESTWAIT", f"create poll: {status} {body!r}")
        return
    poll_id = body["id"]
    state.poll_ids.add(poll_id)
    if not body.get("guestUrl"):
        state.fail("GUESTWAIT", f"guestLink:true poll missing guestUrl in the create response: {body!r}")
        return
    state.ok("GUESTWAIT-create", f"poll {poll_id} created with guestLink:true, guestUrl present")

    token_a = resolve_token("GUESTWAIT_A_TOKEN", "guestwait invitee A", poll_id, env.invitee_a_email)
    token_b = resolve_token("GUESTWAIT_B_TOKEN", "guestwait invitee B", poll_id, env.invitee_b_email)

    status, grid_a = public_grid(public, env.url, poll_id, token_a)
    if status != 200 or "paintableCells" not in grid_a:
        state.fail("GUESTWAIT", f"GET grid (A): {status} {grid_a!r}")
        return
    try:
        cells = overlapping_choice(grid_a["paintableCells"], count=2)
    except ValueError as e:
        state.fail("GUESTWAIT", str(e))
        return

    status, _ = public_put_response(public, env.url, poll_id, token_a, cells, "Guestwait A")
    if status != 200:
        state.fail("GUESTWAIT", f"PUT response (A): {status}")
        return
    status, _ = public_put_response(public, env.url, poll_id, token_b, cells, "Guestwait B")
    if status != 200:
        state.fail("GUESTWAIT", f"PUT response (B): {status}")
        return

    # Both named invitees are all-in with an overlapping paint — pre-fix-pass
    # this booked (or escalated) within a couple of seconds. The guard is
    # booking.ts's maybeBookOnAllIn: `if (poll.guestTokenHash !== null &&
    # poll.status === "open") return;`.
    try:
        held = hold_poll_status(sched, poll_id, "open", hold_seconds=30.0, interval=3.0)
    except AssertionError as e:
        state.fail("GUESTWAIT", f"guest-link poll auto-booked/escalated early on an all-in overlapping paint: {e}")
        return
    if held.get("gcalEventId") is not None:
        state.fail("GUESTWAIT", f"guest-link poll carries a gcalEventId while still reporting open: {held!r}")
        return
    state.ok(
        "GUESTWAIT",
        "all-in overlapping paint on a guestLink poll stayed open for the hold window (no early "
        "auto-book/escalate); guest self-join itself NOT exercised here (needs a third mailbox, "
        "see this mode's docstring)",
    )

    # Cancel success path (item 3b): the poll is still open, so cancel must
    # succeed. Cancellation EMAILS to invitees are not verified here (email-
    # content assertions not implemented — see module docstring KNOWN GAP);
    # the operator can see them arrive in the real inboxes as a manual bonus check.
    r = sched.request("POST", f"/v1/polls/{poll_id}/cancel")
    if r.status_code != 200:
        state.fail(
            "GUESTWAIT-cancel", f"expected 200 cancelling an open guest-link poll, got {r.status_code} {r.text[:300]!r}"
        )
        return
    cancel_body = safe_json_body(r.text)
    if cancel_body.get("status") != "cancelled":
        state.fail("GUESTWAIT-cancel", f"unexpected cancel body: {cancel_body!r}")
        return
    status, after = get_poll(sched, poll_id)
    if status != 200 or after.get("status") != "cancelled":
        state.fail("GUESTWAIT-cancel", f"GET after cancel did not show cancelled: {status} {after!r}")
        return
    state.ok(
        "GUESTWAIT-cancel",
        "open guest-link poll cancelled (200, status=cancelled, confirmed on a follow-up GET) — "
        "cancellation email content not verified, see module docstring KNOWN GAP",
    )


def run_bookbest_mode(env: PollSmokeEnv, sched: SchedulerClient, cal: CalendarLike, public: httpx.Client, state: RunState) -> None:
    """resolveMeetingPoll{action:"bookBest"} (bookBest add-on to the 2026-08-16
    fix-pass): book the best slot right now for whoever has responded, without
    picking a slot and without waiting for all-in or the deadline. Only
    invitee A responds (paints exactly one free cell) — the required-set rule
    bookBest shares with bookAtDeadline (non-dropped invitees who have
    responded) — so that single cell is the only qualifying candidate,
    letting the booked slot be asserted exactly. B never responds but must
    still land on the booked event's attendee list (ranked out of the slot
    choice, never dropped from the invite — see CLAUDE.md's Meeting polls
    section). A second, separate poll with zero responses exercises the
    failure shape: 400 no_responders, poll left open — bookBest never
    escalates on failure (see "Booking semantics" in docs/runbook.md §L).

    T2 hardening (2026-08-17, todo.md "poll-smoke BOOKBEST stakes its only
    candidate on a zero-slack slot"): the earlier version painted exactly
    paintableCells[0] — the earliest offered cell, sitting right against the
    min-notice frontier, with no slack and no fallback if it stopped being
    feasible between the grid read and the booking engine's fresh
    re-validation. This mode now runs a long-dated poll (deadline_hours=72,
    range +3->+9 days via bookbest_poll_range — this mode never waits out the
    deadline, and the run's cleanup wipes the rows, so the longer window
    costs nothing) and picks its one painted cell via bookbest_cell_choice: a
    >=48h-out cell whose 30-minute neighbours are both also paintable (the
    middle of a >=90-minute free run, the opposite of a zero-slack lone
    hole). Every failure in the book path below carries the full
    paintableCells list for forensics, since the run this fix responds to
    needed a D1 dig for exactly that.

    CAUTION: the 72h deadline means a BOOKBEST poll abandoned mid-mode (the
    run killed between create and cleanup) stays live for up to 72h and
    WILL nudge/auto-book at its deadline like any other open poll — always
    run this harness with D1_DATABASE_ID set so wipe_harness_polls actually
    reaches it, rather than leaving it to the manual-SQL fallback.
    """
    now = datetime.now(timezone.utc)
    invitees = [
        {"email": env.invitee_a_email, "name": "Poll Smoke BookBest A"},
        {"email": env.invitee_b_email, "name": "Poll Smoke BookBest B"},
    ]
    poll_body_req = create_poll_body(
        "BOOKBEST", invitees, now, deadline_hours=72.0, range_fn=bookbest_poll_range
    )
    status, body = post_poll(sched, poll_body_req)
    if status != 201:
        state.fail("BOOKBEST", f"create poll: {status} {body!r}")
        return
    poll_id = body["id"]
    state.poll_ids.add(poll_id)

    token_a = resolve_token("BOOKBEST_A_TOKEN", "bookbest invitee A", poll_id, env.invitee_a_email)

    status, grid_a = public_grid(public, env.url, poll_id, token_a)
    if status != 200 or not grid_a.get("paintableCells"):
        state.fail("BOOKBEST", f"GET grid (A): {status} {grid_a!r}")
        return
    paintable = grid_a["paintableCells"]
    try:
        cell = bookbest_cell_choice(paintable, now)
    except AssertionError as e:
        state.fail("BOOKBEST", str(e))
        return

    status, _ = public_put_response(public, env.url, poll_id, token_a, [cell], "Bookbest A")
    if status != 200:
        state.fail("BOOKBEST", f"PUT response (A): {status} (chosen cell {cell!r}, paintableCells={paintable!r})")
        return
    state.ok("BOOKBEST", f"invitee A painted {cell!r}; invitee B left deliberately unresponded")

    r = sched.request("POST", f"/v1/polls/{poll_id}/resolve", json={"action": "bookBest"})
    if r.status_code != 200:
        state.fail(
            "BOOKBEST-book",
            f"resolve(action=bookBest): {r.status_code} {r.text[:300]!r} "
            f"(chosen cell {cell!r}, paintableCells={paintable!r})",
        )
        return
    resolve_body = safe_json_body(r.text)
    if resolve_body.get("status") != "booked" or not resolve_body.get("gcalEventId"):
        state.fail(
            "BOOKBEST-book",
            f"resolve(action=bookBest) did not report booked+gcalEventId: {resolve_body!r} "
            f"(chosen cell {cell!r}, paintableCells={paintable!r})",
        )
        return
    if resolve_body.get("bookedSlotUtc") != cell:
        state.fail(
            "BOOKBEST-book",
            f"booked slot {resolve_body.get('bookedSlotUtc')!r} != A's only painted cell {cell!r} "
            f"(A was the only responder, so it's the only qualifying candidate; paintableCells={paintable!r})",
        )
        return
    event_id = resolve_body["gcalEventId"]
    state.event_ids.add(event_id)

    # FIX 6 (adversarial review): a re-read, matching P5's rigor — the
    # resolve response reporting "booked" is not proof the poll ROW actually
    # persisted that way.
    status, after_book = get_poll(sched, poll_id)
    if status != 200 or after_book.get("status") != "booked" or after_book.get("bookedSlotUtc") != cell:
        state.fail(
            "BOOKBEST-book",
            f"GET poll after resolve(bookBest) didn't confirm booked at {cell!r}: {status} {after_book!r} "
            f"(paintableCells={paintable!r})",
        )
        return

    # BOOKBEST's range now runs +3 -> +9 days out (bookbest_poll_range), so
    # the calendar-events window has to cover that, not the old +8-day cap.
    window_from = (now - timedelta(days=1)).isoformat()
    window_to = (now + timedelta(days=10)).isoformat()
    events = cal.list_events(window_from, window_to)
    matches = [e for e in events if e.get("id") == event_id]
    if not matches:
        state.fail(
            "BOOKBEST-book",
            f"calendar event {event_id} not found via events.list (booked cell {cell!r}, paintableCells={paintable!r})",
        )
        return
    event = matches[0]
    attendee_emails = {a.get("email", "").lower() for a in (event.get("attendees") or [])}
    want_attendees = {env.invitee_a_email.lower(), env.invitee_b_email.lower()}
    if attendee_emails != want_attendees:
        state.fail(
            "BOOKBEST-book",
            f"event attendees {attendee_emails!r} != both invitees {want_attendees!r} — B (never "
            f"responded) must still be invited, only ranked out of the slot choice "
            f"(paintableCells={paintable!r})",
        )
        return
    # FIX 6: the optical_poll_id extended property is what keeps this event
    # out of the owned-movable-meeting import path (meetings/identify.ts) —
    # same tag P5 checks for the happy-path booking.
    tag = (event.get("extendedProperties") or {}).get("private", {}).get("optical_poll_id")
    if tag != poll_id:
        state.fail(
            "BOOKBEST-book",
            f"event missing optical_poll_id tag (got {tag!r}) (paintableCells={paintable!r})",
        )
        return
    state.ok(
        "BOOKBEST-book",
        f"resolve(action=bookBest) booked A's only painted slot {cell!r} pre-deadline (event "
        f"{event_id}), confirmed via a GET re-read; both invitees on the attendee list including "
        f"non-responder B; event carries optical_poll_id",
    )

    # BOOKBEST-zero — a second, freshly created poll with NO responses at
    # all: bookBest must 400 no_responders and leave the poll open, never
    # escalating (decisions 1/5 of the bookBest plan).
    status, zero_body = post_poll(sched, create_poll_body("BOOKBEST zero", invitees, now))
    if status != 201:
        state.fail("BOOKBEST-zero", f"create poll: {status} {zero_body!r}")
        return
    zero_poll_id = zero_body["id"]
    state.poll_ids.add(zero_poll_id)

    r = sched.request("POST", f"/v1/polls/{zero_poll_id}/resolve", json={"action": "bookBest"})
    if r.status_code != 400:
        state.fail(
            "BOOKBEST-zero",
            f"expected 400 no_responders on a zero-response poll, got {r.status_code} {r.text[:300]!r}",
        )
        return
    zero_error = safe_json_body(r.text)
    if zero_error.get("error") != "no_responders":
        state.fail("BOOKBEST-zero", f"expected error=no_responders, got {zero_error!r}")
        return
    status, after = get_poll(sched, zero_poll_id)
    if status != 200 or after.get("status") != "open":
        state.fail("BOOKBEST-zero", f"poll status after failed bookBest should stay open, got {status} {after!r}")
        return
    state.ok("BOOKBEST-zero", "bookBest on a zero-response poll 400s no_responders, poll left open (no escalation)")


def run_edit_mode(
    env: PollSmokeEnv, sched: SchedulerClient, cal: CalendarLike, public: httpx.Client, state: RunState
) -> None:
    """Card D / `updateMeetingPoll` (internal design notes): the
    new `PATCH /v1/polls/{id}` endpoint's least-email-principle contract, end
    to end.

    Poll 1 exercises the roster+location edit arm: create with invitees A + B
    (location kind 'meet'), then ONE PATCH that adds a third invitee C,
    removes B, and changes location to 'in_person' with a detail — asserting
    B's captured link goes dead, A's ORIGINAL link (captured before the
    PATCH, same URL) keeps working untouched (the least-disturb contract:
    only the touched invitees get emailed/rotated), C's roster row appears
    via a follow-up getMeetingPoll, and the PATCH response itself already
    carries the new location. A and C then paint an overlap to auto-book,
    and the booked calendar event is checked for both the PATCHed location
    and B's absence from the attendee list.

    Poll 2 exercises the deadline arm in isolation — unlike every other PATCH
    field, extending the deadline rotates EVERY non-dropped invitee's token
    (capability tokens expire at deadline+7d, so a new deadline needs
    re-minted ones) — and the resolve-slimming guard:
    `resolveMeetingPoll{action:"extendDeadline"}` must now 400, since Card C
    deletes both `extendDeadline` and `dropInvitee` from `ResolveBody`'s
    discriminated union (PATCH replaces them outright, no aliases).

    Invitee C reuses invitee A's mailbox via a '+' subaddress
    (edit_invitee_c_email) — see that function's docstring for why (poll-
    smoke only has two real invitee mailboxes, the same constraint
    GUESTWAIT's guest-self-join gap documents).

    Email CONTENT is not asserted anywhere here (the removal notice to B,
    the new invite to C, the deadline-extended re-issue to A) — same KNOWN
    GAP as every other mode; only links/tokens and API-visible state are
    checked.
    """
    now = datetime.now(timezone.utc)

    # --- Poll 1: roster + location edit -------------------------------------
    invitees = [
        {"email": env.invitee_a_email, "name": "Poll Smoke Edit A"},
        {"email": env.invitee_b_email, "name": "Poll Smoke Edit B"},
    ]
    body_req = create_poll_body("EDIT", invitees, now)
    body_req["location"] = edit_create_location(env.provider)
    status, body = post_poll(sched, body_req)
    if status != 201:
        state.fail("EDIT", f"create poll: {status} {body!r}")
        return
    poll_id = body["id"]
    state.poll_ids.add(poll_id)

    status, poll_body = get_poll(sched, poll_id)
    if status != 200:
        state.fail("EDIT", f"GET poll after create: {status} {poll_body!r}")
        return
    b_row = next((i for i in poll_body.get("invitees", []) if i["email"] == env.invitee_b_email), None)
    if not b_row:
        state.fail("EDIT", f"invitee B not registered on the just-created poll: {poll_body!r}")
        return
    b_invitee_id = b_row["id"]

    # Captured BEFORE the PATCH — this is the "untouched" URL the least-
    # disturb assertion below re-uses verbatim.
    token_a = resolve_token("EDIT_A_TOKEN", "edit invitee A", poll_id, env.invitee_a_email)
    token_b = resolve_token("EDIT_B_TOKEN", "edit invitee B (about to be removed)", poll_id, env.invitee_b_email)
    state.ok(
        "EDIT-create",
        f"poll {poll_id} created (location={body_req['location']['kind']}, invitees A+B), "
        f"both links captured",
    )

    c_email = os.environ.get("EDIT_C_EMAIL") or edit_invitee_c_email(env.invitee_a_email)
    edit_location_detail = "42 Test Ave, Sydney NSW"
    # Watermark for C's invite email: it is sent BY this PATCH call, so C's
    # token must only be accepted from a Sent message at/after this moment
    # (same reasoning as run_nudge_check's nudge_not_before).
    c_not_before = int(_time.time())
    patch_status, patch_body = patch_poll(
        sched,
        poll_id,
        {
            "addInvitees": [{"email": c_email, "name": "Poll Smoke Edit C"}],
            "removeInviteeIds": [b_invitee_id],
            "location": {"kind": "in_person", "detail": edit_location_detail},
        },
    )
    if patch_status != 200:
        state.fail("EDIT-patch", f"PATCH poll: {patch_status} {patch_body!r}")
        return
    patch_location = patch_body.get("location") or {}
    if patch_location.get("kind") != "in_person" or patch_location.get("detail") != edit_location_detail:
        state.fail("EDIT-patch", f"PATCH response location not updated as expected: {patch_location!r}")
        return
    state.ok("EDIT-patch", f"PATCH 200s; response location already reflects in_person/{edit_location_detail!r}")

    # B's captured link must now be dead (removed invitees are locked out —
    # resolveInvitee returns null for a dropped row, route.ts 401s
    # invalid_token, same as any other unresolvable token).
    status, grid_b_dead = public_grid(public, env.url, poll_id, token_b)
    if status != 401 or grid_b_dead.get("error") != "invalid_token":
        state.fail("EDIT-remove", f"removed invitee B's captured link still resolves: {status} {grid_b_dead!r}")
        return
    # A's link is untouched by this PATCH (only B and C are addressed by it) —
    # the SAME token/URL captured before the PATCH must still resolve.
    status, grid_a_after = public_grid(public, env.url, poll_id, token_a)
    if status != 200 or "paintableCells" not in grid_a_after:
        state.fail(
            "EDIT-remove",
            f"invitee A's untouched pre-PATCH link stopped working (least-disturb violated): "
            f"{status} {grid_a_after!r}",
        )
        return
    state.ok("EDIT-remove", "removed invitee B's link is dead; untouched invitee A's link (same URL) still works")

    status, poll_after = get_poll(sched, poll_id)
    if status != 200:
        state.fail("EDIT-roster", f"GET poll after PATCH: {status} {poll_after!r}")
        return
    c_row = next((i for i in poll_after.get("invitees", []) if i["email"] == c_email), None)
    b_row_after = next((i for i in poll_after.get("invitees", []) if i["email"] == env.invitee_b_email), None)
    if not c_row or c_row.get("dropped"):
        state.fail("EDIT-roster", f"invitee C's roster row missing/dropped via getMeetingPoll: {poll_after.get('invitees')!r}")
        return
    if not b_row_after or not b_row_after.get("dropped"):
        state.fail("EDIT-roster", f"invitee B's roster row not marked dropped via getMeetingPoll: {poll_after.get('invitees')!r}")
        return
    state.ok("EDIT-roster", "getMeetingPoll shows C's new roster row present and B's row marked dropped")

    token_c = resolve_token(
        "EDIT_C_TOKEN", "edit invitee C (newly added by the PATCH)", poll_id, c_email, not_before=c_not_before,
    )

    status, grid_a2 = public_grid(public, env.url, poll_id, token_a)
    if status != 200 or "paintableCells" not in grid_a2:
        state.fail("EDIT-book", f"GET grid (A, post-patch): {status} {grid_a2!r}")
        return
    try:
        cells = overlapping_choice(grid_a2["paintableCells"], count=2)
    except ValueError as e:
        state.fail("EDIT-book", str(e))
        return
    status, _ = public_put_response(public, env.url, poll_id, token_a, cells, "Edit A")
    if status != 200:
        state.fail("EDIT-book", f"PUT response (A): {status}")
        return
    status, _ = public_put_response(public, env.url, poll_id, token_c, cells, "Edit C")
    if status != 200:
        state.fail("EDIT-book", f"PUT response (C): {status}")
        return

    try:
        booked = wait_for_poll_status(sched, poll_id, {"booked", "needs_attention"})
    except AssertionError as e:
        state.fail("EDIT-book", str(e))
        return
    if booked["status"] != "booked":
        state.fail("EDIT-book", f"expected booked, got {booked['status']!r}: {booked!r}")
        return
    event_id = booked.get("gcalEventId")
    if not event_id:
        state.fail("EDIT-book", f"booked poll missing gcalEventId: {booked!r}")
        return
    state.event_ids.add(event_id)

    window_from = (now - timedelta(days=1)).isoformat()
    window_to = (now + timedelta(days=8)).isoformat()
    events = cal.list_events(window_from, window_to)
    matches = [e for e in events if e.get("id") == event_id]
    if not matches:
        state.fail("EDIT-book", f"calendar event {event_id} not found via events.list")
        return
    event = matches[0]
    if event.get("location") != edit_location_detail:
        state.fail(
            "EDIT-book",
            f"booked event location {event.get('location')!r} != PATCHed detail {edit_location_detail!r}",
        )
        return
    attendee_emails = {a.get("email", "").lower() for a in (event.get("attendees") or [])}
    mixed_invitees = [
        {"email": env.invitee_a_email, "dropped": False, "hideName": False},
        {"email": c_email, "dropped": False, "hideName": False},
    ]
    want_attendees = {e.lower() for e in expected_attendee_emails(mixed_invitees)}
    if attendee_emails != want_attendees or env.invitee_b_email.lower() in attendee_emails:
        state.fail(
            "EDIT-book",
            f"event attendees {attendee_emails!r} != expected (A+C, removed B excluded) {want_attendees!r}",
        )
        return
    state.ok(
        "EDIT-book",
        f"A+C's overlapping paint auto-booked; event {event_id} carries the PATCHed location and "
        f"excludes removed invitee B from attendees",
    )

    # Trailing guard: the poll is now booked, so cancel's CAS must refuse it —
    # same assertion as every other booked-poll mode (P7/UNHAPPY/HIDDEN).
    r = sched.request("POST", f"/v1/polls/{poll_id}/cancel")
    if r.status_code != 409:
        state.fail("EDIT-cancel", f"expected 409 cancelling an already-booked poll, got {r.status_code} {r.text[:300]!r}")
        return
    state.ok("EDIT-cancel", "cancel on the booked poll correctly refused (409 invalid_status)")

    # --- Poll 2: deadline arm + resolve-slimming guard -----------------------
    # No deadline_hours pin here (unlike BOOKBEST's own documented exception)
    # — create_poll_body falls back to POLL_SMOKE_DEADLINE_HOURS, and the
    # PATCH target below is derived from whatever deadline actually comes
    # back, not an assumed value.
    deadline_invitees = [{"email": env.invitee_a_email, "name": "Poll Smoke Edit Deadline"}]
    body_req2 = create_poll_body("EDIT deadline", deadline_invitees, now)
    status, body2 = post_poll(sched, body_req2)
    if status != 201:
        state.fail("EDIT-deadline", f"create poll: {status} {body2!r}")
        return
    poll_id2 = body2["id"]
    state.poll_ids.add(poll_id2)

    status, poll2_created = get_poll(sched, poll_id2)
    if status != 200:
        state.fail("EDIT-deadline", f"GET poll after create: {status} {poll2_created!r}")
        return
    current_deadline = poll2_created.get("deadlineUtc")
    range_end = poll2_created.get("rangeEnd")
    a_row_2 = next((i for i in poll2_created.get("invitees", []) if i["email"] == env.invitee_a_email), None)
    if not current_deadline or not range_end or not a_row_2:
        state.fail("EDIT-deadline", f"created poll missing deadlineUtc/rangeEnd/invitee A row: {poll2_created!r}")
        return
    a_invitee_id_2 = a_row_2["id"]

    # Captured BEFORE the deadline PATCH — unlike every other PATCH field,
    # extending the deadline rotates every non-dropped invitee's token
    # (capability tokens expire at deadline+7d), so this link must go dead.
    token_d = resolve_token("EDIT_D_TOKEN", "edit-deadline invitee", poll_id2, env.invitee_a_email)

    try:
        new_deadline = deadline_extension_target(current_deadline, range_end)
    except AssertionError as e:
        state.fail("EDIT-deadline", str(e))
        return
    patch_status, patch_body2 = patch_poll(sched, poll_id2, {"deadlineUtc": new_deadline})
    if patch_status != 200:
        state.fail("EDIT-deadline", f"PATCH deadlineUtc: {patch_status} {patch_body2!r}")
        return
    try:
        got_dt = datetime.fromisoformat((patch_body2.get("deadlineUtc") or "").replace("Z", "+00:00"))
        want_dt = datetime.fromisoformat(new_deadline.replace("Z", "+00:00"))
    except ValueError:
        state.fail("EDIT-deadline", f"PATCH response deadlineUtc not parseable: {patch_body2.get('deadlineUtc')!r}")
        return
    if abs((got_dt - want_dt).total_seconds()) > 1.0:
        state.fail(
            "EDIT-deadline",
            f"PATCH response deadlineUtc {patch_body2.get('deadlineUtc')!r} != requested {new_deadline!r}",
        )
        return

    status, grid_d_dead = public_grid(public, env.url, poll_id2, token_d)
    if status != 401 or grid_d_dead.get("error") != "invalid_token":
        state.fail(
            "EDIT-deadline",
            f"pre-PATCH invitee link still resolves after a deadline extension (should have rotated): "
            f"{status} {grid_d_dead!r}",
        )
        return

    status, poll2_after = get_poll(sched, poll_id2)
    if status != 200:
        state.fail("EDIT-deadline", f"GET poll after deadline PATCH: {status} {poll2_after!r}")
        return
    try:
        reread_dt = datetime.fromisoformat((poll2_after.get("deadlineUtc") or "").replace("Z", "+00:00"))
    except ValueError:
        state.fail("EDIT-deadline", f"re-read deadlineUtc not parseable: {poll2_after!r}")
        return
    if abs((reread_dt - want_dt).total_seconds()) > 1.0:
        state.fail(
            "EDIT-deadline",
            f"re-read poll deadlineUtc {poll2_after.get('deadlineUtc')!r} != requested {new_deadline!r}",
        )
        return
    state.ok(
        "EDIT-deadline",
        "PATCH deadlineUtc rotates the pre-PATCH link dead and the poll re-reads with the new "
        "deadline (email content not verified — see module docstring KNOWN GAP)",
    )

    # Resolve slimming (Card C): extendDeadline/dropInvitee are gone from
    # ResolveBody's discriminated union — this must now be a zod 400
    # (error=validation_failed, v1.ts's generic schema-rejection shape), not
    # the old 200-reopens-the-poll / 200-drops-and-rebooks behaviour.
    #
    # A body missing the arm's OTHER required field (e.g. bare
    # {"action":"extendDeadline"} with no deadlineUtc) would ALSO 400 under
    # the OLD schema — that 400 proves nothing about the slimming, since it
    # never reaches the discriminant check. Both bodies below are shaped
    # exactly as the pre-slimming schema required (extendDeadline needed a
    # valid deadlineUtc; dropInvitee needed a real inviteeId) so a stale,
    # un-slimmed resolve would 200 them — the 400 here can only come from the
    # action literal itself being gone from the union.
    try:
        extend_target = deadline_extension_target(new_deadline, range_end)
    except AssertionError as e:
        state.fail("EDIT-resolve-slim", str(e))
        return
    r = sched.request(
        "POST", f"/v1/polls/{poll_id2}/resolve", json={"action": "extendDeadline", "deadlineUtc": extend_target},
    )
    if r.status_code != 400:
        state.fail(
            "EDIT-resolve-slim-extend",
            f"expected 400 rejecting resolveMeetingPoll{{action:extendDeadline}} (moved to PATCH), "
            f"got {r.status_code} {r.text[:300]!r}",
        )
        return
    extend_slim_body = safe_json_body(r.text)
    if extend_slim_body.get("error") != "validation_failed":
        state.fail(
            "EDIT-resolve-slim-extend",
            f"expected error=validation_failed rejecting the removed extendDeadline action, got {extend_slim_body!r}",
        )
        return
    state.ok(
        "EDIT-resolve-slim-extend",
        "resolveMeetingPoll{action:'extendDeadline', deadlineUtc:<a value the OLD schema would have "
        "accepted>} now 400s validation_failed — moved to updateMeetingPoll",
    )

    r = sched.request(
        "POST", f"/v1/polls/{poll_id2}/resolve", json={"action": "dropInvitee", "inviteeId": a_invitee_id_2},
    )
    if r.status_code != 400:
        state.fail(
            "EDIT-resolve-slim-drop",
            f"expected 400 rejecting resolveMeetingPoll{{action:dropInvitee}} (moved to PATCH), "
            f"got {r.status_code} {r.text[:300]!r}",
        )
        return
    drop_slim_body = safe_json_body(r.text)
    if drop_slim_body.get("error") != "validation_failed":
        state.fail(
            "EDIT-resolve-slim-drop",
            f"expected error=validation_failed rejecting the removed dropInvitee action, got {drop_slim_body!r}",
        )
        return
    state.ok(
        "EDIT-resolve-slim-drop",
        "resolveMeetingPoll{action:'dropInvitee', inviteeId:<invitee A's real id>} now 400s "
        "validation_failed — moved to updateMeetingPoll",
    )

    # Trailing cleanup: this poll never got painted, so it's still open —
    # cancel must succeed.
    r = sched.request("POST", f"/v1/polls/{poll_id2}/cancel")
    if r.status_code != 200:
        state.fail("EDIT-deadline-cancel", f"expected 200 cancelling an open poll, got {r.status_code} {r.text[:300]!r}")
        return
    cancel_body = safe_json_body(r.text)
    if cancel_body.get("status") != "cancelled":
        state.fail("EDIT-deadline-cancel", f"unexpected cancel body: {cancel_body!r}")
        return
    state.ok("EDIT-deadline-cancel", "open deadline-arm poll cancelled (200, status=cancelled)")


# =============================================================================
# main
# =============================================================================


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Live smoke for the meeting-poll feature.")
    p.add_argument("--provider", choices=list(_smoke_lib.PROVIDERS),
                   # WP2 review finding 6: os.environ.get(..., "google") only
                   # substitutes "google" when SMOKE_PROVIDER is entirely
                   # UNSET — SMOKE_PROVIDER="" (a common shell artifact) would
                   # otherwise become argparse's literal default and bypass
                   # `choices` validation.
                   default=os.environ.get("SMOKE_PROVIDER") or "google",
                   help="Calendar provider of the ORGANISER identity (default: $SMOKE_PROVIDER "
                        "or google). Invitee mailboxes stay Gmail regardless (see module "
                        "docstring's Microsoft organiser section). microsoft drives Graph for "
                        "the organiser's calendar and Sent-mail relay, and switches EDIT "
                        "mode's Poll-1 create location kind from 'meet' to 'phone'.")
    return p.parse_args(argv)


def main() -> int:
    # WP2 review finding 5: parse_args() runs BEFORE the Mon-Thu run-day
    # gate, so --help or an invalid --provider surfaces argparse's own
    # error immediately — even on a Fri-Sun — instead of a "REFUSING TO
    # RUN" weekend message that has nothing to do with what was actually
    # wrong with the invocation.
    args = parse_args()
    provider = args.provider

    if os.environ.get("POLL_SMOKE_ALLOW_ANY_DAY", "").lower() != "true":
        today = date.today()
        if not is_run_day_ok(today):
            raise SystemExit(
                f"REFUSING TO RUN on {today} ({today.strftime('%A')}) — this harness needs "
                f"Mon-Thu business-hours availability ahead in the week (like L6's weekend "
                f"caveat). Set POLL_SMOKE_ALLOW_ANY_DAY=true to override."
            )

    env = PollSmokeEnv.from_environ(provider=provider)
    sched = SchedulerClient(env.organiser)

    # Preflight (WP2.4 — poll-smoke had none before this): a wrong A_BEARER
    # or a Google bearer run under --provider microsoft must fail here, in
    # the first second of the run, not mid-run against a confusing 403/404
    # or Graph 401 twenty minutes in.
    whoami_status, whoami_body = get_whoami(sched)
    if whoami_status != 200:
        raise SystemExit(f"preflight GET /v1/whoami failed: {whoami_status} {whoami_body!r}")
    whoami_err = check_whoami(whoami_body, env.organiser.expected_email, provider)
    if whoami_err:
        raise SystemExit(f"preflight whoami check failed: {whoami_err}")
    whoami_warning = whoami_provider_warning(whoami_body)
    if whoami_warning:
        print(f"warning: {whoami_warning}", file=sys.stderr)

    cal = make_calendar_client(sched, provider)
    # Mailbox-first token relay (T3, extended to Microsoft in WP2): unconditional
    # construction is safe and cheap — neither reader makes an API call until
    # first used, so if the organiser's token lacks the provider's mail-read
    # scope (GOOGLE_GMAIL_READ_SCOPE_ENABLED / MICROSOFT_MAIL_READ_SCOPE_ENABLED
    # not live on this env, or A hasn't re-consented) the first real call
    # 403s, resolve_token's fallback kicks in, and every prompt after that
    # behaves exactly as it did pre-T3.
    reader = make_mail_reader(sched, provider)
    configure_mail_reader(reader)
    public = httpx.Client(timeout=30.0)
    state = RunState()

    try:
        run_happy_path(env, sched, cal, public, state)
        run_nudge_check(env, sched, public, state)
        run_unhappy_mode(env, sched, public, state)
        run_hidden_invitee_mode(env, sched, cal, public, state)
        run_guestwait_mode(env, sched, public, state)
        run_bookbest_mode(env, sched, cal, public, state)
        run_edit_mode(env, sched, cal, public, state)
    finally:
        cleaned: list[str] = []
        not_cleaned: list[str] = []
        for eid in state.event_ids:
            try:
                cal.delete_event(eid)
                cleaned.append(f"calendar event {eid} deleted")
            except Exception as e:
                not_cleaned.append(f"calendar event {eid} NOT deleted: {e}")
        if env.d1_database_id:
            try:
                n = wipe_harness_polls(d1_for_db_id(env.d1_database_id, env.repo_root))
                cleaned.append(f"{n} poll row(s) + cascaded poll_invitees/poll_responses/bookings wiped from D1")
            except Exception as e:
                not_cleaned.append(f"D1 poll wipe failed: {e}")
        else:
            not_cleaned.append(manual_poll_cleanup_hint(env.wrangler_env))

        print("\nCLEANUP — cleaned:")
        for c in cleaned:
            print(f"  - {c}")
        print("CLEANUP — NOT cleaned:")
        for n in not_cleaned:
            print(f"  - {n}")

        sched.close()
        cal.close()
        reader.close()
        public.close()

    print("\n=== SUMMARY ===")
    for r in state.results:
        print(f"{'PASS' if r.passed else 'FAIL'}  {r.label}  {r.notes}")
    failures = [r for r in state.results if not r.passed]
    if failures:
        print(f"\n{len(failures)} step(s) FAILED")
        return 1
    if not state.results:
        print("\nnothing genuinely exercised")
        return 2
    print("\nALL PASS")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except KeyboardInterrupt:
        sys.exit("interrupted")
