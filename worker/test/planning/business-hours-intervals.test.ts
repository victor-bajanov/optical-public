import { describe, it, expect } from "vitest";
import { businessHoursIntervals } from "../../src/planning/business-hours-intervals";
import type { BusinessHours } from "../../src/planning/solver-contract";

describe("businessHoursIntervals", () => {
  it("does not skip the local spring-forward day when sampled on fixed 24h UTC steps", () => {
    // Australia/Sydney DST starts 2026-10-04 02:00 AEST -> AEDT. A window that
    // starts late in the local day (23:30 Sydney) steps in fixed 24h-UTC hops
    // that straddle the transition and land on 10-02, 10-03, 10-05 — skipping
    // 10-04 entirely (the day the clock jumps forward).
    const bh: BusinessHours = {
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      start: "09:00",
      end: "17:00",
    };
    const windowStartMs = Date.parse("2026-10-01T13:30:00Z"); // 2026-10-01 23:30 AEST
    const windowEndMs = Date.parse("2026-10-08T13:30:00Z"); // 2026-10-09 00:30 AEDT

    const result = businessHoursIntervals(windowStartMs, windowEndMs, bh, "Australia/Sydney");

    // 2026-10-04 09:00-17:00 AEDT (UTC+11, post-transition).
    const oct4Start = Date.parse("2026-10-03T22:00:00Z");
    const oct4End = Date.parse("2026-10-04T06:00:00Z");
    expect(result).toContainEqual({ s: oct4Start, e: oct4End });

    // Every allowed local day between the two clipped ends (10-02 .. 10-08
    // inclusive) contributes exactly one interval — no day skipped, none
    // double-counted.
    expect(result).toHaveLength(7);
  });
});
