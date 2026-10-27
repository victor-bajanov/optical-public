import { describe, it, expect } from "vitest";
import { materialiseTemplate, type TemplateRow } from "../../src/recurrence/materialise";

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

describe("materialiseTemplate — timezone handling", () => {
  it("AEST winter: 09:30 Sydney → 23:30 UTC previous day", () => {
    // 2026-07-13 is Monday in southern hemisphere winter → AEST (UTC+10).
    // 09:30 Sydney = 23:30 UTC the day before.
    const out = materialiseTemplate(
      template({}),
      "2026-07-12T00:00:00Z",
      "2026-07-19T00:00:00Z",
      new Set(),
      "Australia/Sydney",
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.body.pinned_at).toBe("2026-07-12T23:30:00.000Z");
  });

  it("AEDT summer: 09:30 Sydney → 22:30 UTC previous day", () => {
    // 2026-01-12 is Monday in southern summer → AEDT (UTC+11).
    const out = materialiseTemplate(
      template({}),
      "2026-01-12T00:00:00+11:00",
      "2026-01-19T00:00:00+11:00",
      new Set(),
      "Australia/Sydney",
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.body.pinned_at).toBe("2026-01-11T22:30:00.000Z");
  });

  it("cross-tz: pinned_tz overrides homeTz", () => {
    // 09:00 New York EDT (UTC-4) on 2026-07-13 = 13:00 UTC.
    // homeTz is Sydney; pinned_tz must win.
    const out = materialiseTemplate(
      template({ pinned_time: "09:00", pinned_tz: "America/New_York" }),
      "2026-07-12T00:00:00Z",
      "2026-07-19T00:00:00Z",
      new Set(),
      "Australia/Sydney",
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.body.pinned_at).toBe("2026-07-13T13:00:00.000Z");
  });

  it("a pin inside the DST spring-forward gap shifts forward by the gap (decision 1)", () => {
    // 2026-10-04 Sunday is AEDT begin in Sydney; 02:00–03:00 local doesn't exist.
    // A template pinned to 02:30 that Sunday lands at 03:30 AEDT (16:30Z on
    // 10-03) instead of throwing the whole sweep.
    const tpl: TemplateRow = {
      id: "tpl-gap",
      body: {
        title: "Edge",
        context: "admin",
        rrule: "FREQ=WEEKLY;BYDAY=SU",
        pinned_time: "02:30",
        duration_minutes: 15,
        active_from: "2026-10-01",
      },
    };
    const out = materialiseTemplate(
      tpl,
      "2026-10-04T00:00:00+10:00",
      "2026-10-05T00:00:00+11:00",
      new Set(),
      "Australia/Sydney",
    );
    expect(out.map((o) => o.occurrence_date)).toEqual(["2026-10-04"]);
    expect(out[0]!.body.pinned_at).toBe("2026-10-03T16:30:00.000Z");
  });

  it("west of UTC, the local week yields its own Monday and not next Monday", () => {
    // Los Angeles week of Mon 2026-07-13: local Mon 00:00 PDT = 07:00Z, so the
    // window's UTC dates run Mon 07:00Z .. next Mon 07:00Z. Occurrences are
    // local dates: this Monday is in, next Monday (07-20) is not.
    const LA = "America/Los_Angeles";
    const weekly = materialiseTemplate(
      template({ pinned_time: null }),
      "2026-07-13T07:00:00.000Z",
      "2026-07-20T07:00:00.000Z",
      new Set(),
      LA,
    );
    expect(weekly.map((o) => o.occurrence_date)).toEqual(["2026-07-13"]);
    expect(weekly[0]!.body.earliest_start).toBe("2026-07-13T07:00:00.000Z");
    const daily = materialiseTemplate(
      template({ pinned_time: null, rrule: "FREQ=DAILY" }),
      "2026-07-13T07:00:00.000Z",
      "2026-07-20T07:00:00.000Z",
      new Set(),
      LA,
    );
    expect(daily.map((o) => o.occurrence_date)).toEqual([
      "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-18", "2026-07-19",
    ]);
  });

  it("a pinned_tz far ahead of home: the occurrence is the pinned-zone date whose pin falls in the home window", () => {
    // Home Los Angeles week of Mon 2026-07-13 (07:00Z .. 07:00Z). Sydney Mon
    // 07-13 09:00 AEST is 07-12T23:00Z, in the PREVIOUS LA week; Sydney Mon
    // 07-20 09:00 is 07-19T23:00Z, inside this one.
    const out = materialiseTemplate(
      template({ pinned_time: "09:00", pinned_tz: "Australia/Sydney" }),
      "2026-07-13T07:00:00.000Z",
      "2026-07-20T07:00:00.000Z",
      new Set(),
      "America/Los_Angeles",
    );
    expect(out.map((o) => [o.occurrence_date, o.body.pinned_at])).toEqual([["2026-07-20", "2026-07-19T23:00:00.000Z"]]);
  });

  it("a window ending just before midnight keeps its partial last day", () => {
    const out = materialiseTemplate(
      template({ pinned_time: null, rrule: "FREQ=DAILY" }),
      "2026-07-13T00:00:00+10:00",
      "2026-07-13T23:59:59+10:00",
      new Set(),
      "Australia/Sydney",
    );
    expect(out.map((o) => o.occurrence_date)).toEqual(["2026-07-13"]);
  });

  it("absent pinned_tz falls back to homeTz (AEST)", () => {
    const out = materialiseTemplate(
      template({ pinned_time: "09:30" }), // no pinned_tz
      "2026-07-12T00:00:00Z",
      "2026-07-19T00:00:00Z",
      new Set(),
      "Australia/Sydney",
    );
    expect(out[0]!.body.pinned_at).toBe("2026-07-12T23:30:00.000Z");
  });

  it("earliest_start (unpinned) uses homeTz midnight, not UTC midnight", () => {
    const out = materialiseTemplate(
      template({ pinned_time: null, rrule: "FREQ=WEEKLY;BYDAY=MO" }),
      "2026-07-12T00:00:00Z",
      "2026-07-19T00:00:00Z",
      new Set(),
      "Australia/Sydney",
    );
    expect(out[0]!.body.pinned_at).toBeNull();
    // Midnight Sydney 2026-07-13 = 14:00 UTC 2026-07-12 (AEST = UTC+10).
    expect(out[0]!.body.earliest_start).toBe("2026-07-12T14:00:00.000Z");
  });
});

// Card E (internal design notes): a pinned_tz template's windows are in
// that zone; an untimezoned template's windows follow the user's tz.
describe("materialiseTemplate — preferred-window tz", () => {
  const win = { days: ["mon"], start: "09:00", end: "11:00", hard: true };
  const run = (overrides: Partial<TemplateRow["body"]>) =>
    materialiseTemplate(
      template({ pinned_time: null, ...overrides }),
      "2026-07-12T00:00:00Z",
      "2026-07-19T00:00:00Z",
      new Set(),
      "Australia/Sydney",
    );

  it("stamps pinned_tz onto untimezoned windows, keeping explicit ones", () => {
    const out = run({
      pinned_tz: "America/New_York",
      task_body: { preferred_windows: [win, { ...win, days: ["tue"], tz: "Asia/Tokyo" }] },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.body.preferred_windows).toEqual([
      { ...win, tz: "America/New_York" },
      { ...win, days: ["tue"], tz: "Asia/Tokyo" },
    ]);
  });

  it("leaves windows of a template without pinned_tz unstamped", () => {
    const out = run({ task_body: { preferred_windows: [win] } });
    expect(out[0]!.body.preferred_windows).toEqual([win]);
  });

  it("does not mutate the template's own task_body", () => {
    const task_body = { preferred_windows: [win] };
    run({ pinned_tz: "America/New_York", task_body });
    expect(task_body.preferred_windows[0]).not.toHaveProperty("tz");
  });
});
