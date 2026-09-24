# ICS parser fixtures

`.ics` files for testing `parseIcsBusy` (and its helpers `unfoldLines`,
`toUtcMs`, `expandRRule`) in
`worker/src/booking/booking.client.js`, driven by
`worker/test/booking/ics-fixtures.test.ts`. Each fixture is valid RFC 5545: CRLF
line endings, wrapped in `BEGIN:VCALENDAR`/`VERSION:2.0`/`PRODID`/.../`END:VCALENDAR`,
each event in `BEGIN:VEVENT`/`END:VEVENT` with a `UID` and `DTSTAMP`.

All but one pin a single semantic each. `google-export-synthetic.ics` is the
exception and the important one: a synthetic 32-event calendar that reproduces
the *structure* of the real-world Google export that exposed the bug (property
ordering, `VTIMEZONE`, folded lines, weekly all-day transparent markers, mixed
recurrences with deletions and overrides). Every date, title, address and
timestamp in it is made up; no real calendar data is kept. Every `parseIcsBusy`
test that existed before this corpus built its input as a hand-written
three-line VEVENT, and not one asserted that an event should be *excluded*,
which is precisely why the whole suite missed a bug that greyed out a booker's
entire week. Keep an export-shaped sample here, and when changing it keep the
"TRANSP stripped" test in `ics-fixtures.test.ts` green: it proves the file
still walls off the week on a parser that ignores `TRANSP`.

**Assumed test setup.** All fixtures that use `TZID=Australia/Sydney` or
`VALUE=DATE` (all-day) values assume the test calls `parseIcsBusy(text, {
fromMs, toMs, defaultTz: "Australia/Sydney" })` — i.e. the *booker's* browser
timezone is Sydney. Times below are given in that zone and converted to UTC for
precision. Pick `fromMs`/`toMs` generously (e.g. all of 2026) so nothing is
clipped by the window unless a row says otherwise. Sydney is UTC+10 (AEST)
through 2026-10-03 and UTC+11 (AEDT) from 2026-10-04 02:00 local.

**Where "current parser" still disagrees with "correct".** The module carries a
deliberate over-reporting bias — better to show a booker as busy than to wrongly
offer a slot — so `RDATE`, `VTIMEZONE` overrides and BYDAY/BYMONTH-heavy
`RRULE`s are still ignored or collapsed to the first instance with a warning.
Two rows below pin that: `recurrence-id-move.ics` and `monthly-byday.ics`.

That bias does **not** extend to properties that state availability outright.
`TRANSP:TRANSPARENT` ("does not consume time"), `STATUS:CANCELLED` and `EXDATE`
are all honoured, checked *before* any date or recurrence work — so an
unsupported `FREQ` on a transparent event never even warns. `TRANSP` used to be
ignored entirely, which is the bug this corpus was written for: Google emits
working-location markers, birthdays and due-date reminders as all-day
`TRANSP:TRANSPARENT` events, and counting seven of them as 24-hour blocks merged
into one 107-hour wall.

The remaining "Mismatch" rows are **known, accepted gaps**, not defects to fix
in passing. They are asserted in `ics-fixtures.test.ts` as *current* behaviour,
so closing one fails a test on purpose rather than silently changing what a
booker sees.

| Fixture | Semantic pinned | Correct busy result | Current parser result |
|---|---|---|---|
| `transparent-allday.ics` | All-day `TRANSP:TRANSPARENT` (Google "working location" shape) | No busy interval | Matches — TRANSP is honoured; the event contributes nothing. **This is the fixture for the reported bug.** |
| `transparent-timed.ics` | Timed event, `TRANSP:TRANSPARENT` | No busy interval | Matches — TRANSP is honoured |
| `opaque-allday.ics` | All-day, `TRANSP:OPAQUE` | Busy `2026-08-11T14:00Z`–`2026-08-12T14:00Z` (full 24h) | Matches — same interval |
| `no-transp.ics` | Timed event, no `TRANSP` property (RFC 5545 default is OPAQUE) | Busy `2026-08-12T00:00Z`–`01:00Z` | Matches — same interval |
| `cancelled-event.ics` | Timed event, `STATUS:CANCELLED` | No busy interval | Matches — STATUS:CANCELLED is honoured |
| `exdate-deleted.ics` | Weekly series, `EXDATE` (local `TZID` form) removes the 2nd occurrence | 3 busy instances: `2026-08-02T23:00Z`, `08-16T23:00Z`, `08-23T23:00Z` (each 30 min); `08-09T23:00Z` (the excluded Aug-10 local occurrence) absent | Matches — EXDATE is honoured |
| `exdate-tzid.ics` | Weekly series, `EXDATE` given as a bare UTC `Z` literal (`20260810T233000Z`) that is the *same instant* as the local (`Australia/Sydney`) 2nd occurrence — pins that exclusion must match on resolved instant, not raw string | 3 busy instances: `2026-08-03T23:30Z`, `08-17T23:30Z`, `08-24T23:30Z` (each 30 min); `08-10T23:30Z` absent | Matches — EXDATE matches on the resolved instant, so the `Z` literal cancels the TZID-bound occurrence |
| `exdate-multi.ics` | Daily series, ONE `EXDATE` property with two comma-separated dates | 4 busy instances: `2026-08-02T22:00Z` (Aug 3), `08-04T22:00Z` (Aug 5), `08-06T22:00Z` (Aug 7), `08-07T22:00Z` (Aug 8), each 30 min; Aug 4 and Aug 6 absent | Matches — both comma-separated dates are excluded |
| `recurrence-id-move.ics` | Weekly parent series (same `UID`) plus a second `VEVENT` with a `RECURRENCE-ID` moving the 2nd occurrence to a different time | 4 busy instances: `2026-08-02T23:00Z`, `08-10T04:00Z` (moved, 14:00 local), `08-16T23:00Z`, `08-23T23:00Z` | **Mismatch (documents the known double-count gap)** — 5 busy instances: the parent's un-suppressed original `08-09T23:00Z` (09:00 local) slot AND the override's `08-10T04:00Z` slot both appear, double-booking Aug 10 |
| `monthly-byday.ics` | `RRULE:FREQ=MONTHLY;BYDAY=3TU` (third Tuesday), `UNTIL=2026-12-31` | 5 busy instances (3rd Tuesday of each month, 1h each): `2026-08-18T00:00Z`, `09-15T00:00Z`, `10-19T23:00Z`, `11-16T23:00Z`, `12-14T23:00Z` (Oct/Nov/Dec shifted an hour earlier in UTC — AEDT) | **Mismatch** — `FREQ=MONTHLY` is unsupported; collapses to a single instance at literal `DTSTART`: only `2026-08-18T00:00Z`–`01:00Z` |
| `yearly-birthday.ics` | All-day `RRULE:FREQ=YEARLY`, `TRANSP:TRANSPARENT` (Google birthday shape) | Never busy, any year | Matches — transparency is checked *before* recurrence, so the event is skipped outright and the unsupported `FREQ=YEARLY` is never reached (no warning either) |
| `dst-spring-forward.ics` | Daily `TZID=Australia/Sydney` series spanning the 2026-10-04 spring-forward (02:00→03:00) | 6 busy instances, local 09:00–09:30 every day: `09-30T23:00Z`, `10-01T23:00Z`, `10-02T23:00Z`, `10-03T22:00Z` (Oct 4, now AEDT), `10-04T22:00Z`, `10-05T22:00Z` — note the 1-hour UTC shift at the boundary while local wall-clock stays fixed | Matches — this is the one recurrence case the parser handles correctly (wall-clock stepping, no drift) |
| `folded-lines.ics` | Long `SUMMARY` folded with a space-continuation; `DESCRIPTION` folded with a TAB-continuation | Busy `2026-08-02T23:00Z`–`2026-08-03T00:00Z`; folding must not corrupt the following `DTEND`/other properties | Matches — `unfoldLines` handles both space and tab continuation lines |
| `windows-tzid.ics` | `DTSTART;TZID=AUS Eastern Standard Time:...` (non-IANA Windows zone name) | Busy `2026-08-20T00:00Z`–`01:00Z` (event must not be silently dropped) | Matches by coincidence — `resolveTz` rejects the unknown name and falls back to `defaultTz` (`Australia/Sydney` in this test setup), which happens to be the true zone here; a warning is emitted (`Unknown timezone "AUS Eastern Standard Time"...`). If `defaultTz` were anything other than Sydney the fallback would silently skew the time — the mechanism doesn't actually understand Windows zone names, it just borrows whatever zone the test passed in |
| `no-dtend.ics` | Two events with no `DTEND`: one timed, one all-day | Timed event busy `2026-08-21T03:00Z`–`04:00Z` (DTSTART +1h); all-day event busy `2026-08-21T14:00Z`–`2026-08-22T14:00Z` (DTSTART +24h) | Matches — this is exactly the documented default-handling behaviour |
| `malformed-mixed.ics` | Mix of valid events with: a `VEVENT` missing `DTSTART`; a `VEVENT` whose `DTEND` is before its `DTSTART`; a property line with no colon inside an otherwise-valid event | 3 busy instances from the valid events: `2026-08-24T23:00Z`–`2026-08-25T00:00Z` (Aug 25), `08-26T23:00Z`–`08-27T00:00Z` (Aug 27, survives the garbage property line), `08-27T23:00Z`–`08-28T00:00Z` (Aug 28); the no-DTSTART and DTEND-before-DTSTART events are dropped entirely (each triggers a warning) | Matches — this pins the parser's designed error-resilience: one bad property or one bad event doesn't take down the rest of the file |
| `google-export-synthetic.ics` | A **synthetic** 32-event calendar with the structure of a real Google export: Google's property ordering, a `VTIMEZONE` block, folded `ATTENDEE`/`DESCRIPTION` lines, 6 all-day `TRANSP:TRANSPARENT` markers (weekly Thu + Fri "working location", one-off reminders, a yearly birthday), 11 `RRULE`s (weekly incl. `BYDAY=MO,WE` and fortnightly `UNTIL`, daily `COUNT`, 4 monthly), 13 `EXDATE`s (one deleting an in-week occurrence), 6 `RECURRENCE-ID` overrides. All data made up (`@example.com` people, generic titles, 2026–27 dates) | Over the week `2027-01-11`–`01-18`: a plausible working week — 11 busy blocks, longest 2.5h, ~7.1% of the window; 4 `FREQ=MONTHLY` warnings | Matches. **With `TRANSP` ignored (the pre-fix parser) this file produces a 48-hour block covering 46.6% of the week**, the same symptom the real export showed (48 hours, 45.5%). Every other fixture here pins one semantic; this one exists because hand-built three-line ICS never caught the bug |

## Notes for anyone extending these tests

- Every remaining "Mismatch" row is a **known, accepted gap** — the test asserts
  the *current* (imperfect) behaviour and links back to this table. If you close
  a gap, those tests should fail; update them deliberately.
- `exdate-tzid.ics` is the one that matters if you touch EXDATE handling: its
  `EXDATE` is a bare `Z` literal against a `TZID`-bound `DTSTART`. Matching on
  the raw string passes `exdate-deleted.ics` and silently fails this one, so
  keep the comparison on the resolved instant.
- `monthly-byday.ics` logs `Unsupported RRULE FREQ=MONTHLY` via the `warnings`
  export — worth asserting the warning fires, not just the busy result.
  `yearly-birthday.ics` deliberately does **not** warn: it is `TRANSPARENT`, and
  transparency is checked before recurrence, so the unsupported `FREQ` is never
  reached.
- Ground truth is cheap to get without vitest: `booking.client.js` is
  dependency-free ESM, so `node` can import it and run a fixture directly. For
  before/after comparisons, `git show <ref>:worker/src/booking/booking.client.js`
  into a scratch `.mjs` and import that instead.
- `windows-tzid.ics` will log a warning (`Unknown timezone "AUS Eastern
  Standard Time"...`) exactly once even though the property appears twice
  (DTSTART and DTEND) — `unknownTzids` warns once per distinct zone per parse.
