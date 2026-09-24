// Corpus tests for parseIcsBusy, driven by real .ics fixture files rather than
// hand-built three-line strings.
//
// WHY THIS FILE EXISTS: a booker loaded a genuine Google export and every slot
// greyed out. The parser read only DTSTART/DTEND/RRULE, so seven all-day
// TRANSP:TRANSPARENT markers ("Home" working-location entries and a "... due"
// reminder) each became a 24-hour busy block; consecutive days merged into a
// single 107-hour wall. Every existing parseIcsBusy test used a minimal
// hand-written VEVENT, so nothing in the suite had ever seen the shape of a
// real export. These fixtures close that gap.
//
// Fixtures and their intended semantics are catalogued in fixtures/README.md.
// Cases the parser deliberately does NOT handle are pinned here as
// known-gap tests asserting CURRENT behaviour, so closing a gap fails loudly
// and on purpose rather than silently changing what bookers see.
import { describe, it, expect } from "vitest";
import { parseIcsBusy, warnings } from "../../src/booking/booking.client.js";

import transparentAllday from "./fixtures/transparent-allday.ics?raw";
import transparentTimed from "./fixtures/transparent-timed.ics?raw";
import opaqueAllday from "./fixtures/opaque-allday.ics?raw";
import noTransp from "./fixtures/no-transp.ics?raw";
import cancelledEvent from "./fixtures/cancelled-event.ics?raw";
import exdateDeleted from "./fixtures/exdate-deleted.ics?raw";
import exdateTzid from "./fixtures/exdate-tzid.ics?raw";
import exdateMulti from "./fixtures/exdate-multi.ics?raw";
import recurrenceIdMove from "./fixtures/recurrence-id-move.ics?raw";
import monthlyByday from "./fixtures/monthly-byday.ics?raw";
import yearlyBirthday from "./fixtures/yearly-birthday.ics?raw";
import dstSpringForward from "./fixtures/dst-spring-forward.ics?raw";
import foldedLines from "./fixtures/folded-lines.ics?raw";
import windowsTzid from "./fixtures/windows-tzid.ics?raw";
import noDtend from "./fixtures/no-dtend.ics?raw";
import malformedMixed from "./fixtures/malformed-mixed.ics?raw";
import googleExport from "./fixtures/google-export-synthetic.ics?raw";

// Wide enough to contain every fixture, including the October DST case and the
// monthly series that runs to December. Fixtures are authored against
// Australia/Sydney, so the default zone is pinned rather than left to the
// runtime's own zone.
const W = {
  fromMs: Date.parse("2026-07-01T00:00:00Z"),
  toMs: Date.parse("2027-01-31T00:00:00Z"),
  defaultTz: "Australia/Sydney",
};

/** Busy intervals as ISO pairs — far easier to read in a failure diff than
 *  epoch milliseconds. */
function iso(text: string): Array<[string, string]> {
  return parseIcsBusy(text, W).map((b: { s: number; e: number }) => [
    new Date(b.s).toISOString(),
    new Date(b.e).toISOString(),
  ]);
}

describe("parseIcsBusy fixtures — free/busy transparency", () => {
  it("ignores an all-day TRANSP:TRANSPARENT marker (the working-location bug)", () => {
    // The exact shape that greyed out a real booker's whole week.
    expect(iso(transparentAllday)).toEqual([]);
  });

  it("ignores a timed TRANSP:TRANSPARENT event", () => {
    expect(iso(transparentTimed)).toEqual([]);
  });

  it("keeps an all-day TRANSP:OPAQUE event as a full day of busy", () => {
    expect(iso(opaqueAllday)).toEqual([["2026-08-11T14:00:00.000Z", "2026-08-12T14:00:00.000Z"]]);
  });

  it("treats a missing TRANSP as OPAQUE, per RFC 5545's default", () => {
    expect(iso(noTransp)).toEqual([["2026-08-12T00:00:00.000Z", "2026-08-12T01:00:00.000Z"]]);
  });
});

describe("parseIcsBusy fixtures — cancelled events", () => {
  it("ignores a STATUS:CANCELLED event", () => {
    expect(iso(cancelledEvent)).toEqual([]);
  });
});

describe("parseIcsBusy fixtures — EXDATE", () => {
  it("drops the excluded occurrence of a weekly series", () => {
    // COUNT=4 from Mon 3 Aug 09:00 Sydney, with Mon 10 Aug excluded.
    expect(iso(exdateDeleted)).toEqual([
      ["2026-08-02T23:00:00.000Z", "2026-08-02T23:30:00.000Z"],
      ["2026-08-16T23:00:00.000Z", "2026-08-16T23:30:00.000Z"],
      ["2026-08-23T23:00:00.000Z", "2026-08-23T23:30:00.000Z"],
    ]);
  });

  it("matches an EXDATE on the resolved instant, not the literal string", () => {
    // DTSTART is TZID-bound Sydney; the EXDATE is written as a UTC Z literal
    // for the same instant. String comparison would miss it.
    expect(iso(exdateTzid)).toEqual([
      ["2026-08-03T23:30:00.000Z", "2026-08-04T00:00:00.000Z"],
      ["2026-08-17T23:30:00.000Z", "2026-08-18T00:00:00.000Z"],
      ["2026-08-24T23:30:00.000Z", "2026-08-25T00:00:00.000Z"],
    ]);
  });

  it("honours several comma-separated dates in one EXDATE property", () => {
    expect(iso(exdateMulti)).toEqual([
      ["2026-08-02T22:00:00.000Z", "2026-08-02T22:30:00.000Z"],
      ["2026-08-04T22:00:00.000Z", "2026-08-04T22:30:00.000Z"],
      ["2026-08-06T22:00:00.000Z", "2026-08-06T22:30:00.000Z"],
      ["2026-08-07T22:00:00.000Z", "2026-08-07T22:30:00.000Z"],
    ]);
  });
});

describe("parseIcsBusy fixtures — unchanged paths (regression guard)", () => {
  it("holds local wall-clock across Sydney's spring-forward", () => {
    const got = iso(dstSpringForward);
    expect(got).toHaveLength(6);
    // 09:00 Sydney is 23:00Z before the transition and 22:00Z after it.
    expect(got[0]![0]).toBe("2026-09-30T23:00:00.000Z");
    expect(got[3]![0]).toBe("2026-10-03T22:00:00.000Z");
  });

  it("reads properties folded with both space and tab continuations", () => {
    expect(iso(foldedLines)).toEqual([["2026-08-02T23:00:00.000Z", "2026-08-03T00:00:00.000Z"]]);
  });

  it("falls back to the default zone for a Windows TZID, warning once", () => {
    expect(iso(windowsTzid)).toEqual([["2026-08-20T00:00:00.000Z", "2026-08-20T01:00:00.000Z"]]);
    // DTSTART and DTEND both carry the unknown zone; the warn-once set means
    // one warning, not two.
    expect(warnings.filter((w) => w.includes("AUS Eastern Standard Time"))).toHaveLength(1);
  });

  it("defaults a missing DTEND to +1h timed and +24h all-day", () => {
    expect(iso(noDtend)).toEqual([
      ["2026-08-21T03:00:00.000Z", "2026-08-21T04:00:00.000Z"],
      ["2026-08-21T14:00:00.000Z", "2026-08-22T14:00:00.000Z"],
    ]);
  });

  it("keeps the readable events in a file that also contains broken ones", () => {
    expect(iso(malformedMixed)).toEqual([
      ["2026-08-24T23:00:00.000Z", "2026-08-25T00:00:00.000Z"],
      ["2026-08-26T23:00:00.000Z", "2026-08-27T00:00:00.000Z"],
      ["2026-08-27T23:00:00.000Z", "2026-08-28T00:00:00.000Z"],
    ]);
    expect(warnings).toHaveLength(3);
  });
});

describe("parseIcsBusy fixtures — Google-export-shaped calendar (the reported bug)", () => {
  // A synthetic 32-event file reproducing the structure of the real-world
  // Google export that exposed the bug: Google's property ordering, a
  // VTIMEZONE block, folded ATTENDEE lines, six all-day TRANSP:TRANSPARENT
  // markers (two of them weekly), eleven RRULEs, thirteen EXDATEs and six
  // RECURRENCE-ID overrides. Every previous parseIcsBusy test built a
  // three-line VEVENT by hand, which is exactly why none of them caught this.
  const WEEK = {
    fromMs: Date.parse("2027-01-11T00:00:00Z"),
    toMs: Date.parse("2027-01-18T00:00:00Z"),
    defaultTz: "Australia/Sydney",
  };

  it("still reproduces the wall when TRANSP is ignored (the fixture discriminates)", () => {
    // Drop every TRANSP line, so each event falls back to RFC 5545's OPAQUE
    // default: that is what the pre-fix parser saw. The fixture is only a
    // regression guard if this turns the week into a wall.
    const opaque = googleExport.replace(/^TRANSP:[^\r\n]*\r?\n/gm, "");
    const busy = parseIcsBusy(opaque, WEEK);
    const longestHours = Math.max(...busy.map((b: { s: number; e: number }) => b.e - b.s)) / 3_600_000;
    expect(longestHours).toBeGreaterThanOrEqual(48);
  });

  it("does not wall off the week with all-day transparent markers", () => {
    const busy = parseIcsBusy(googleExport, WEEK);
    const longestHours = Math.max(...busy.map((b: { s: number; e: number }) => b.e - b.s)) / 3_600_000;
    // Before TRANSP was honoured this same fixture produced a 48-hour block
    // covering 46.6% of the week (the real export: 48 hours, 45.5%). A booker
    // saw every slot greyed out.
    expect(longestHours).toBeLessThan(8);
  });

  it("reports a plausible share of a working week as busy", () => {
    const busy = parseIcsBusy(googleExport, WEEK);
    const covered = busy.reduce((a: number, b: { s: number; e: number }) => a + (b.e - b.s), 0);
    const pct = (covered / (WEEK.toMs - WEEK.fromMs)) * 100;
    // 46.6% before the fix, 7.1% after. The upper bound is the regression
    // guard; the lower bound catches the opposite failure, a parser that
    // quietly reads nothing and reports the booker as free all week.
    expect(pct).toBeGreaterThan(1);
    expect(pct).toBeLessThan(15);
  });

  it("still surfaces the unsupported monthly rules rather than hiding them", () => {
    parseIcsBusy(googleExport, WEEK);
    expect(warnings.filter((w) => w.includes("FREQ=MONTHLY"))).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Known gaps. These assert what the parser does TODAY, not what RFC 5545 says.
// Each is documented in fixtures/README.md. If you close one of these gaps,
// these tests SHOULD fail — update them deliberately.
// ---------------------------------------------------------------------------
describe("parseIcsBusy fixtures — known gaps", () => {
  it("KNOWN GAP: double-counts a RECURRENCE-ID move (old and new time both busy)", () => {
    const got = iso(recurrenceIdMove);
    // Correct would be 4: the parent's 9 Aug occurrence replaced by the 10 Aug
    // override. The parent rule is expanded without consulting the override, so
    // the vacated 2026-08-09T23:00Z slot is reported busy as well.
    expect(got).toHaveLength(5);
    expect(got.map((g) => g[0])).toContain("2026-08-09T23:00:00.000Z"); // vacated
    expect(got.map((g) => g[0])).toContain("2026-08-10T04:00:00.000Z"); // moved-to
  });

  it("KNOWN GAP: collapses FREQ=MONTHLY to its first occurrence, and says so", () => {
    expect(iso(monthlyByday)).toEqual([["2026-08-18T00:00:00.000Z", "2026-08-18T01:00:00.000Z"]]);
    expect(warnings.some((w) => w.includes("FREQ=MONTHLY"))).toBe(true);
  });

  it("skips a TRANSPARENT yearly birthday outright, so FREQ=YEARLY never matters", () => {
    // Google exports birthdays as all-day + TRANSPARENT. Transparency is
    // checked before expansion, so the unsupported FREQ=YEARLY is never
    // reached and no warning is raised — the booker sees neither a phantom
    // busy day nor a confusing warning.
    expect(iso(yearlyBirthday)).toEqual([]);
    expect(warnings.some((w) => w.includes("FREQ=YEARLY"))).toBe(false);
  });
});
