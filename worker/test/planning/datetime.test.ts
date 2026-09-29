import { describe, it, expect } from "vitest";
import {
  toLocalNaive,
  fromLocalNaive,
  localWeekWindow,
  upcomingLocalWeekWindow,
  ceilToQuarter,
  computePlacementFloor,
  isWeekFullyPast,
} from "../../src/planning/datetime";
import type { LocalNaive } from "../../src/planning/solver-contract";

const SYD = "Australia/Sydney";

describe("toLocalNaive", () => {
  it("converts ISO-Z to Sydney wall clock in AEST (UTC+10)", () => {
    // 2026-06-21T00:00:00Z (midwinter — Sydney is AEST, +10)
    expect(toLocalNaive("2026-06-21T00:00:00Z", SYD)).toBe("2026-06-21T10:00:00");
  });

  it("converts ISO-Z to Sydney wall clock in AEDT (UTC+11)", () => {
    // 2026-01-15T00:00:00Z (midsummer — Sydney is AEDT, +11)
    expect(toLocalNaive("2026-01-15T00:00:00Z", SYD)).toBe("2026-01-15T11:00:00");
  });

  it("throws when input is not aligned to 15-minute boundary", () => {
    expect(() => toLocalNaive("2026-05-18T09:07:00Z", SYD)).toThrow(/15.minute/);
  });

  it("throws when seconds are non-zero", () => {
    expect(() => toLocalNaive("2026-05-18T09:00:30Z", SYD)).toThrow(/15.minute/);
  });

  it("accepts an offset-suffixed ISO and treats it as the same instant", () => {
    // 23:00 UTC == 09:00 +10 in AEST
    expect(toLocalNaive("2026-06-20T23:00:00+00:00", SYD)).toBe("2026-06-21T09:00:00");
  });
});

describe("fromLocalNaive", () => {
  it("converts Sydney wall clock to ISO-Z (AEST)", () => {
    const local = "2026-06-21T10:00:00" as LocalNaive;
    expect(fromLocalNaive(local, SYD)).toBe("2026-06-21T00:00:00.000Z");
  });

  it("converts Sydney wall clock to ISO-Z (AEDT)", () => {
    const local = "2026-01-15T11:00:00" as LocalNaive;
    expect(fromLocalNaive(local, SYD)).toBe("2026-01-15T00:00:00.000Z");
  });

  it("roundtrips through toLocalNaive", () => {
    const original = "2026-05-21T03:30:00.000Z";
    const local = toLocalNaive(original, SYD);
    expect(fromLocalNaive(local, SYD)).toBe(original);
  });

  it("throws on the spring-forward gap (Sydney AEST→AEDT, 2026-10-04 02:00→03:00)", () => {
    const local = "2026-10-04T02:30:00" as LocalNaive;
    expect(() => fromLocalNaive(local, SYD)).toThrow(/DST gap|does not exist/);
  });

  it("prefers the earlier offset on the fall-back overlap (Sydney AEDT→AEST, 2026-04-05 03:00→02:00)", () => {
    // 02:30 local exists twice on 2026-04-05; pre-transition is +11 (UTC 15:30 prev day),
    // post-transition is +10 (UTC 16:30 prev day). We pick the earlier UTC instant.
    const local = "2026-04-05T02:30:00" as LocalNaive;
    expect(fromLocalNaive(local, SYD)).toBe("2026-04-04T15:30:00.000Z");
  });
});

describe("ceilToQuarter", () => {
  it("rounds an off-grid instant UP to the next 15-minute boundary", () => {
    expect(ceilToQuarter("2026-06-03T09:07:00.000Z")).toBe("2026-06-03T09:15:00.000Z");
  });

  it("leaves an already-aligned instant unchanged", () => {
    expect(ceilToQuarter("2026-06-03T09:15:00.000Z")).toBe("2026-06-03T09:15:00.000Z");
  });
});

describe("computePlacementFloor", () => {
  // Sydney Monday 2026-06-15 00:00 = 2026-06-14T14:00:00Z (AEST, +10).
  const weekStart = "2026-06-14T14:00:00.000Z";

  it("mid-week: floors at ceilToQuarter(now)", () => {
    // now is Wednesday of the week, off-grid → next quarter slot.
    const now = "2026-06-17T03:07:00.000Z";
    expect(computePlacementFloor(weekStart, now)).toBe("2026-06-17T03:15:00.000Z");
  });

  it("start-of-week: now <= weekStart → floor = weekStart (no narrowing)", () => {
    // now is exactly at (or just before) the week boundary.
    const now = "2026-06-14T14:00:00.000Z";
    expect(computePlacementFloor(weekStart, now)).toBe(weekStart);
    const before = "2026-06-14T12:00:00.000Z";
    expect(computePlacementFloor(weekStart, before)).toBe(weekStart);
  });

  it("future week: now < weekStart → floor = weekStart (no behavior change)", () => {
    const now = "2026-06-03T01:00:00.000Z"; // a week-and-a-half earlier
    expect(computePlacementFloor(weekStart, now)).toBe(weekStart);
  });
});

describe("isWeekFullyPast", () => {
  it("true when windowEnd is strictly before now", () => {
    expect(isWeekFullyPast("2026-06-01T00:00:00.000Z", "2026-06-03T00:00:00.000Z")).toBe(true);
  });

  it("true when windowEnd equals now (boundary is exclusive)", () => {
    expect(isWeekFullyPast("2026-06-03T00:00:00.000Z", "2026-06-03T00:00:00.000Z")).toBe(true);
  });

  it("false for the current week (now inside the window)", () => {
    expect(isWeekFullyPast("2026-06-08T00:00:00.000Z", "2026-06-03T00:00:00.000Z")).toBe(false);
  });

  it("false for a future week", () => {
    expect(isWeekFullyPast("2026-07-06T00:00:00.000Z", "2026-06-03T00:00:00.000Z")).toBe(false);
  });
});

describe("localWeekWindow", () => {
  // Sydney Monday 00:00 is 14:00Z the prior day (AEST, +10).
  const MON = "2026-06-14T14:00:00.000Z"; // Mon 2026-06-15 00:00 AEST
  const NEXT_MON = "2026-06-21T14:00:00.000Z"; // Mon 2026-06-22 00:00 AEST

  it("maps a Monday-morning local instant to that Monday's week", () => {
    // 01:30Z = 11:30 Mon 2026-06-15 AEST — matches the committed BAS chunk.
    expect(localWeekWindow("2026-06-15T01:30:00.000Z", SYD)).toEqual({ start: MON, end: NEXT_MON });
  });

  it("maps a mid-week local instant back to *this* Monday (week containing it)", () => {
    // 03:00Z = 13:00 Tue 2026-06-16 AEST → still the week of Mon 2026-06-15.
    expect(localWeekWindow("2026-06-16T03:00:00.000Z", SYD)).toEqual({ start: MON, end: NEXT_MON });
  });

  it("keeps a late-Sunday-local instant inside the same week (end is exclusive Mon 00:00 local)", () => {
    // 12:59Z = 22:59 Sun 2026-06-21 AEST → last moment of the week of Mon 2026-06-15.
    expect(localWeekWindow("2026-06-21T12:59:00.000Z", SYD)).toEqual({ start: MON, end: NEXT_MON });
  });

  it("anchors on the *local* Monday, not the UTC Monday (Mon-morning-AEST is Sun in UTC)", () => {
    // A chunk at 09:00 Mon 2026-06-15 AEST is 2026-06-14T23:00Z — a Sunday in UTC.
    // A UTC-anchored week [2026-06-15T00:00Z, …) would wrongly exclude it; the
    // local-anchored window must contain it.
    const w = localWeekWindow("2026-06-15T01:30:00.000Z", SYD);
    const chunk = Date.parse("2026-06-14T23:00:00.000Z");
    expect(Date.parse(w.start)).toBeLessThanOrEqual(chunk);
    expect(Date.parse(w.end)).toBeGreaterThan(chunk);
  });

  it("respects DST: a summer (AEDT, +11) week starts at 13:00Z the prior day", () => {
    // Tue 2026-01-13 (AEDT) → week of Mon 2026-01-12; Mon 00:00 AEDT = 2026-01-11T13:00Z.
    expect(localWeekWindow("2026-01-13T00:00:00.000Z", SYD)).toEqual({
      start: "2026-01-11T13:00:00.000Z",
      end: "2026-01-18T13:00:00.000Z",
    });
  });
});

describe("upcomingLocalWeekWindow", () => {
  // The Monday cron fires at Sun 15:00 UTC. That instant is Mon 01:00/02:00 in
  // Sydney but still Sunday anywhere west of about UTC+9, so "the week
  // containing now" would re-resolve the ENDING week there. The cron wants the
  // week starting on each user's nearest local Monday (plan decision 7).
  const CRON_BST = "2026-05-17T15:00:00.000Z"; // Sun 17 May; Sydney AEST, London BST
  const CRON_GMT = "2026-01-11T15:00:00.000Z"; // Sun 11 Jan; Sydney AEDT, London GMT

  it("Sydney (AEST): the week just starting, same as localWeekWindow(now)", () => {
    expect(upcomingLocalWeekWindow(CRON_BST, SYD)).toEqual({
      start: "2026-05-17T14:00:00.000Z", // Mon 18 May 00:00 AEST
      end: "2026-05-24T14:00:00.000Z",
    });
    expect(upcomingLocalWeekWindow(CRON_BST, SYD)).toEqual(localWeekWindow(CRON_BST, SYD));
  });

  it("Sydney (AEDT): the week just starting", () => {
    expect(upcomingLocalWeekWindow(CRON_GMT, SYD)).toEqual({
      start: "2026-01-11T13:00:00.000Z", // Mon 12 Jan 00:00 AEDT
      end: "2026-01-18T13:00:00.000Z",
    });
  });

  it("London (BST): next Monday's week, not the ending one", () => {
    // Sun 16:00 BST: localWeekWindow(now) would be the week of Mon 11 May.
    expect(localWeekWindow(CRON_BST, "Europe/London").start).toBe("2026-05-10T23:00:00.000Z");
    expect(upcomingLocalWeekWindow(CRON_BST, "Europe/London")).toEqual({
      start: "2026-05-17T23:00:00.000Z", // Mon 18 May 00:00 BST
      end: "2026-05-24T23:00:00.000Z",
    });
  });

  it("London (GMT): next Monday's week", () => {
    expect(upcomingLocalWeekWindow(CRON_GMT, "Europe/London")).toEqual({
      start: "2026-01-12T00:00:00.000Z", // Mon 12 Jan 00:00 GMT
      end: "2026-01-19T00:00:00.000Z",
    });
  });

  it("America/Los_Angeles (PDT): next Monday's week", () => {
    expect(upcomingLocalWeekWindow(CRON_BST, "America/Los_Angeles")).toEqual({
      start: "2026-05-18T07:00:00.000Z", // Mon 18 May 00:00 PDT
      end: "2026-05-25T07:00:00.000Z",
    });
  });

  it("Pacific/Kiritimati (UTC+14): the Monday that has just passed", () => {
    // Mon 18 May 05:00 local at fire time — the easternmost edge.
    expect(upcomingLocalWeekWindow(CRON_BST, "Pacific/Kiritimati")).toEqual({
      start: "2026-05-17T10:00:00.000Z", // Mon 18 May 00:00 +14
      end: "2026-05-24T10:00:00.000Z",
    });
  });

  it("Etc/GMT+12 (UTC-12): the coming Monday", () => {
    // Sun 17 May 03:00 local at fire time — the westernmost edge.
    expect(upcomingLocalWeekWindow(CRON_BST, "Etc/GMT+12")).toEqual({
      start: "2026-05-18T12:00:00.000Z", // Mon 18 May 00:00 -12
      end: "2026-05-25T12:00:00.000Z",
    });
  });

  it("throws on an unparseable instant, like localWeekWindow", () => {
    expect(() => upcomingLocalWeekWindow("not-a-date", SYD)).toThrow(/invalid ISO datetime/);
  });
});
