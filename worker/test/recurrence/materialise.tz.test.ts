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
      "2026-01-12T00:00:00Z",
      "2026-01-19T00:00:00Z",
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

  it("DST spring-forward gap throws", () => {
    // 2026-10-04 Sunday is AEDT begin in Sydney; 02:00–03:00 local doesn't exist.
    // Pin a template to 02:30 on that Sunday → fromLocalNaive throws.
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
    expect(() =>
      materialiseTemplate(
        tpl,
        "2026-10-04T00:00:00Z",
        "2026-10-05T00:00:00Z",
        new Set(),
        "Australia/Sydney",
      ),
    ).toThrow(/DST gap|does not exist/);
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
