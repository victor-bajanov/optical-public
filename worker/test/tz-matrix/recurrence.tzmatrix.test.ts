// tz-matrix mirror of test/recurrence/materialise.tz.test.ts and the window
// semantics of test/recurrence/materialise.test.ts. The window handed to
// materialiseTemplate in production is the resolve's local week
// (resolve-internal.ts -> runRecurrenceSweep(windowStart, windowEnd, homeTz)),
// so the oracle builds exactly that window per zone.
import { describe, it, expect } from "vitest";
import { materialiseTemplate, type TemplateRow } from "../../src/recurrence/materialise";
import { MATRIX_ZONES, MIDNIGHT_GAP_ZONES, addDays, dayStartIso, midnightGapDate, wallIso } from "./zones";

const ALL_ZONES = [...new Set([...MATRIX_ZONES, ...MIDNIGHT_GAP_ZONES])];

function template(overrides: Partial<TemplateRow["body"]>): TemplateRow {
  return {
    id: "tpl-test",
    body: {
      title: "Standup",
      context: "meeting",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      pinned_time: "09:30",
      duration_minutes: 15,
      active_from: "2026-01-01",
      ...overrides,
    },
  };
}

const week = (mon: string, tz: string) => ({ start: dayStartIso(mon, tz), end: dayStartIso(addDays(mon, 7), tz) });
const MONDAYS = ["2026-01-12", "2026-07-13"]; // northern winter / southern winter

describe.each(ALL_ZONES)("materialiseTemplate over the local week in %s", (tz) => {
  it.each(MONDAYS)("weekly BYDAY=MO pinned 09:30: the week of %s yields that Monday at 09:30 local", (mon) => {
    const w = week(mon, tz);
    const out = materialiseTemplate(template({}), w.start, w.end, new Set(), tz);
    expect(out.map((o) => o.occurrence_date)).toEqual([mon]);
    expect(out[0]!.body.pinned_at).toBe(wallIso(mon, "09:30", tz));
  });

  it.each(MONDAYS)("weekly BYDAY=MO unpinned: earliest_start is local midnight of the week of %s's Monday", (mon) => {
    const w = week(mon, tz);
    const out = materialiseTemplate(template({ pinned_time: null }), w.start, w.end, new Set(), tz);
    expect(out.map((o) => o.occurrence_date)).toEqual([mon]);
    expect(out[0]!.body.earliest_start).toBe(dayStartIso(mon, tz));
  });

  it.each(MONDAYS)("DAILY unpinned: the week of %s yields its seven local dates Mon..Sun, no more, no fewer", (mon) => {
    const w = week(mon, tz);
    const out = materialiseTemplate(template({ pinned_time: null, rrule: "FREQ=DAILY" }), w.start, w.end, new Set(), tz);
    expect(out.map((o) => o.occurrence_date)).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => addDays(mon, i)));
  });

  it("every materialised earliest_start / pinned_at falls inside the week window that produced it", () => {
    for (const mon of MONDAYS) {
      const w = week(mon, tz);
      for (const rrule of ["FREQ=DAILY", "FREQ=WEEKLY;BYDAY=MO,FR,SU"]) {
        for (const pinned_time of [null, "09:30"]) {
          const out = materialiseTemplate(template({ pinned_time, rrule }), w.start, w.end, new Set(), tz);
          for (const o of out) {
            const at = Date.parse((o.body.pinned_at ?? o.body.earliest_start) as string);
            expect(at, `${rrule} ${pinned_time} ${o.occurrence_date}`).toBeGreaterThanOrEqual(Date.parse(w.start));
            expect(at, `${rrule} ${pinned_time} ${o.occurrence_date}`).toBeLessThan(Date.parse(w.end));
          }
        }
      }
    }
  });

  it("pinned_tz America/New_York overrides the home zone", () => {
    const w = week("2026-07-13", tz);
    // The occurrence date is the NY date whose pin falls in the home week.
    const out = materialiseTemplate(template({ pinned_time: "09:00", pinned_tz: "America/New_York" }), w.start, w.end, new Set(), tz);
    expect(out.map((o) => o.occurrence_date)).toEqual(["2026-07-13"]);
    expect(out[0]!.body.pinned_at).toBe(wallIso("2026-07-13", "09:00", "America/New_York"));
  });
});

describe.each(ALL_ZONES)("materialiseTemplate with a foreign pinned_tz, home %s", (tz) => {
  it.each(["Pacific/Kiritimati", "Australia/Sydney", "America/Los_Angeles", "Pacific/Pago_Pago"])(
    "WEEKLY MO 09:00 pinned in %s: three consecutive home weeks yield three instances, each pinned inside its own week",
    (pinTz) => {
      const existing = new Set<string>();
      const pins: string[] = [];
      for (const mon of ["2026-07-06", "2026-07-13", "2026-07-20"]) {
        const w = week(mon, tz);
        const out = materialiseTemplate(template({ pinned_time: "09:00", pinned_tz: pinTz }), w.start, w.end, existing, tz);
        for (const o of out) {
          existing.add(o.occurrence_date);
          const at = Date.parse(o.body.pinned_at as string);
          expect(at, `${mon} ${o.occurrence_date}`).toBeGreaterThanOrEqual(Date.parse(w.start));
          expect(at, `${mon} ${o.occurrence_date}`).toBeLessThan(Date.parse(w.end));
          pins.push(o.body.pinned_at as string);
        }
      }
      expect(pins).toHaveLength(3);
    },
  );
});

describe.each([...MIDNIGHT_GAP_ZONES])("materialiseTemplate across the midnight-gap date in %s", (tz) => {
  const gap = midnightGapDate(tz, 2026)!;
  // Monday on or before the gap date.
  const wd = new Date(`${gap}T12:00:00Z`).getUTCDay();
  const mon = addDays(gap, -((wd + 6) % 7));

  it("DAILY unpinned over the week containing the gap date does not throw", () => {
    const w = week(mon, tz);
    const run = () => materialiseTemplate(template({ pinned_time: null, rrule: "FREQ=DAILY" }), w.start, w.end, new Set(), tz);
    expect(run).not.toThrow();
  });

  it("the gap-date occurrence's earliest_start is the gap day's first instant (01:00 local)", () => {
    const w = week(mon, tz);
    let out: ReturnType<typeof materialiseTemplate> = [];
    try {
      out = materialiseTemplate(template({ pinned_time: null, rrule: "FREQ=DAILY" }), w.start, w.end, new Set(), tz);
    } catch (e) {
      throw new Error(`threw: ${(e as Error).message}`);
    }
    const g = out.find((o) => o.occurrence_date === gap);
    expect(g?.body.earliest_start).toBe(dayStartIso(gap, tz));
  });

  it("a template pinned at 00:30 on the gap date (a time that does not exist) does not throw the whole sweep", () => {
    const w = week(mon, tz);
    const run = () => materialiseTemplate(template({ pinned_time: "00:30", rrule: "FREQ=DAILY" }), w.start, w.end, new Set(), tz);
    expect(run).not.toThrow();
  });
});
