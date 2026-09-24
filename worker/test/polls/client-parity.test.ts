// Anti-drift lock for the ICS parser duplicated into poll.client.js.
//
// Per internal design notes §2.6,
// poll.client.js is a self-contained browser module with no cross-file
// imports, so it cannot import booking.client.js's parseIcsBusy. The parser
// (and its RFC 5545 helpers) are instead copied verbatim, which means the two
// copies can silently drift apart on the next edit to either file. This test
// runs the SAME fixture corpus booking's ics-fixtures.test.ts uses through
// BOTH copies of parseIcsBusy and asserts byte-identical output, so any
// divergence fails loudly here rather than showing up as a booker/invitee
// seeing different busy time for the same calendar.
import { describe, it, expect } from "vitest";
import {
  parseIcsBusy as bookingParseIcsBusy,
  warnings as bookingWarnings,
  stats as bookingStats,
} from "../../src/booking/booking.client.js";
import {
  parseIcsBusy as pollParseIcsBusy,
  warnings as pollWarnings,
  stats as pollStats,
} from "../../src/polls/poll.client.js";

import transparentAllday from "../booking/fixtures/transparent-allday.ics?raw";
import transparentTimed from "../booking/fixtures/transparent-timed.ics?raw";
import opaqueAllday from "../booking/fixtures/opaque-allday.ics?raw";
import noTransp from "../booking/fixtures/no-transp.ics?raw";
import cancelledEvent from "../booking/fixtures/cancelled-event.ics?raw";
import exdateDeleted from "../booking/fixtures/exdate-deleted.ics?raw";
import exdateTzid from "../booking/fixtures/exdate-tzid.ics?raw";
import exdateMulti from "../booking/fixtures/exdate-multi.ics?raw";
import recurrenceIdMove from "../booking/fixtures/recurrence-id-move.ics?raw";
import monthlyByday from "../booking/fixtures/monthly-byday.ics?raw";
import yearlyBirthday from "../booking/fixtures/yearly-birthday.ics?raw";
import dstSpringForward from "../booking/fixtures/dst-spring-forward.ics?raw";
import foldedLines from "../booking/fixtures/folded-lines.ics?raw";
import windowsTzid from "../booking/fixtures/windows-tzid.ics?raw";
import noDtend from "../booking/fixtures/no-dtend.ics?raw";
import malformedMixed from "../booking/fixtures/malformed-mixed.ics?raw";
import googleExport from "../booking/fixtures/google-export-synthetic.ics?raw";

// Poll-local fixtures (worker/test/polls/fixtures/, NOT the booking corpus —
// see the correction card: keeping these on this side of the fence removes
// any temptation to touch booking's golden-output test). Each closes a gap
// the booking corpus never exercised: a mutation sweep of poll.client.js
// found 14/28 mutations survived the original parity test because (a) no
// fixture exercised these code paths at all, and (b) only the return value
// was compared, never `warnings`/`stats`.
import foldDtstart from "./fixtures/fold-dtstart.ics?raw";
import exdateTzidReal from "./fixtures/exdate-tzid-real.ics?raw";
import rruleUntilInterval from "./fixtures/rrule-until-interval.ics?raw";
import zeroDuration from "./fixtures/zero-duration.ics?raw";
import lowercaseProps from "./fixtures/lowercase-props.ics?raw";
import crossWindow from "./fixtures/cross-window.ics?raw";

const FIXTURES: Record<string, string> = {
  "transparent-allday": transparentAllday,
  "transparent-timed": transparentTimed,
  "opaque-allday": opaqueAllday,
  "no-transp": noTransp,
  "cancelled-event": cancelledEvent,
  "exdate-deleted": exdateDeleted,
  "exdate-tzid": exdateTzid,
  "exdate-multi": exdateMulti,
  "recurrence-id-move": recurrenceIdMove,
  "monthly-byday": monthlyByday,
  "yearly-birthday": yearlyBirthday,
  "dst-spring-forward": dstSpringForward,
  "folded-lines": foldedLines,
  "windows-tzid": windowsTzid,
  "no-dtend": noDtend,
  "malformed-mixed": malformedMixed,
  "google-export-synthetic": googleExport,
  // Poll-local additions (Fix 2):
  "fold-dtstart": foldDtstart, // DTSTART folded with a leading space, DTEND with a leading tab
  "exdate-tzid-real": exdateTzidReal, // EXDATE genuinely carrying ;TZID=…, not a bare UTC literal
  "rrule-until-interval": rruleUntilInterval, // RRULE with both UNTIL and INTERVAL=2
  "zero-duration": zeroDuration, // DTSTART == DTEND -> warning, no busy interval
  "lowercase-props": lowercaseProps, // begin:vevent/dtstart:/end:vevent in lower case
  "cross-window": crossWindow, // one event straddles fromMs, one straddles toMs
};

// Wide enough to contain every fixture (matches booking's ics-fixtures.test.ts).
const W = {
  fromMs: Date.parse("2026-07-01T00:00:00Z"),
  toMs: Date.parse("2027-01-31T00:00:00Z"),
  defaultTz: "Australia/Sydney",
};

/** `warnings` and `stats` are module-level exports that `parseIcsBusy` resets
 *  and repopulates on every call — both are observable behaviour, not just
 *  the return value, so a mutation that only changes a warning message or a
 *  count (and leaves the busy array itself untouched) must still fail this
 *  lock. Read immediately after the call that produced them and snapshotted
 *  into plain values, since `warnings`/`stats` are mutated in place on the
 *  NEXT call (each module has its own pair, so booking's and poll's never
 *  cross-contaminate each other — only a same-module double-call would, and
 *  this file never does that). */
function snapshot(busy: unknown, warn: string[], st: { events: number; blocks: number }) {
  return { busy, warnings: warn.slice(), stats: { events: st.events, blocks: st.blocks } };
}

describe("poll.client.js parseIcsBusy parity with booking.client.js", () => {
  for (const [name, text] of Object.entries(FIXTURES)) {
    it(`matches booking's busy/warnings/stats triple for fixture: ${name}`, () => {
      const bookingBusy = bookingParseIcsBusy(text, W);
      const bookingSnap = snapshot(bookingBusy, bookingWarnings, bookingStats);
      const pollBusy = pollParseIcsBusy(text, W);
      const pollSnap = snapshot(pollBusy, pollWarnings, pollStats);
      expect(pollSnap).toEqual(bookingSnap);
    });
  }

  it("matches on a hand-built RRULE + TZID case too", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "DTSTART;TZID=Australia/Sydney:20260803T100000",
      "DTEND;TZID=Australia/Sydney:20260803T110000",
      "RRULE:FREQ=WEEKLY;COUNT=3",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(pollParseIcsBusy(ics, W)).toEqual(bookingParseIcsBusy(ics, W));
  });

  it("would catch a drifted copy (sanity check on the lock itself)", () => {
    // Prove the assertion actually discriminates: a deliberately WRONG
    // expectation must fail, confirming toEqual is not vacuously true.
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "DTSTART:20260803T000000Z",
      "DTEND:20260803T010000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const pollResult = pollParseIcsBusy(ics, W);
    const wrong = [{ s: pollResult[0]!.s, e: pollResult[0]!.e + 1 }];
    expect(pollResult).not.toEqual(wrong);
  });
});
