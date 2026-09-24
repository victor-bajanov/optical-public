import { describe, it, expect } from "vitest";
import { expandRRule, UnsupportedRRuleError } from "../../src/recurrence/rrule";

describe("expandRRule", () => {
  it("expands weekly Friday rule over a 7-day window", () => {
    // dtstart Friday 2026-05-15; window Mon 2026-05-18 → Sun 2026-05-24.
    // Next Friday in window: 2026-05-22.
    const dates = expandRRule(
      "FREQ=WEEKLY;BYDAY=FR",
      "2026-05-15",
      "2026-05-18T00:00:00Z",
      "2026-05-25T00:00:00Z",
    );
    expect(dates).toEqual(["2026-05-22"]);
  });

  it("expands daily rule over a 3-day window", () => {
    const dates = expandRRule(
      "FREQ=DAILY",
      "2026-05-15",
      "2026-05-18T00:00:00Z",
      "2026-05-21T00:00:00Z",
    );
    expect(dates).toEqual(["2026-05-18", "2026-05-19", "2026-05-20"]);
  });

  it("honours COUNT", () => {
    // 3 weekly occurrences from 2026-05-15 (Fri): 2026-05-15, 2026-05-22, 2026-05-29.
    // Window covers 2026-05-22 onwards.
    const dates = expandRRule(
      "FREQ=WEEKLY;BYDAY=FR;COUNT=3",
      "2026-05-15",
      "2026-05-20T00:00:00Z",
      "2026-06-05T00:00:00Z",
    );
    expect(dates).toEqual(["2026-05-22", "2026-05-29"]);
  });

  it("honours UNTIL", () => {
    const dates = expandRRule(
      "FREQ=WEEKLY;BYDAY=FR;UNTIL=20260523T000000Z",
      "2026-05-15",
      "2026-05-18T00:00:00Z",
      "2026-06-30T00:00:00Z",
    );
    expect(dates).toEqual(["2026-05-22"]);
  });

  it("honours INTERVAL=2 (every other week)", () => {
    const dates = expandRRule(
      "FREQ=WEEKLY;BYDAY=FR;INTERVAL=2",
      "2026-05-15",
      "2026-05-15T00:00:00Z",
      "2026-06-13T00:00:00Z",
    );
    expect(dates).toEqual(["2026-05-15", "2026-05-29", "2026-06-12"]);
  });

  it("supports multi-day BYDAY (Mon,Wed,Fri)", () => {
    const dates = expandRRule(
      "FREQ=WEEKLY;BYDAY=MO,WE,FR",
      "2026-05-15",
      "2026-05-18T00:00:00Z",
      "2026-05-25T00:00:00Z",
    );
    expect(dates).toEqual(["2026-05-18", "2026-05-20", "2026-05-22"]);
  });

  it("rejects unsupported FREQ", () => {
    expect(() => expandRRule("FREQ=MONTHLY", "2026-05-15", "2026-05-18T00:00:00Z", "2026-06-18T00:00:00Z"))
      .toThrow(UnsupportedRRuleError);
  });

  it("rejects unknown rule parts", () => {
    expect(() => expandRRule("FREQ=WEEKLY;BYSETPOS=1", "2026-05-15", "2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z"))
      .toThrow(UnsupportedRRuleError);
  });
});
