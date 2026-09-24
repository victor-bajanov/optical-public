import { describe, it, expect } from "vitest";
import { formatLocalTime, formatLocalDate, localDayKey } from "../../src/diff/format-local";

const TZ = "Australia/Sydney";

describe("format-local", () => {
  it("formats a time as a local 12-hour clock", () => {
    // 2026-06-15T04:45:00Z = 14:45 AEST
    expect(formatLocalTime("2026-06-15T04:45:00Z", TZ)).toBe("2:45 PM");
    // 2026-06-15T01:30:00Z = 11:30 AEST
    expect(formatLocalTime("2026-06-15T01:30:00Z", TZ)).toBe("11:30 AM");
  });

  it("formats a date as weekday + day + month", () => {
    expect(formatLocalDate("2026-06-15T01:30:00Z", TZ)).toBe("Mon 15 June");
  });

  it("derives the local calendar day key (YYYY-MM-DD)", () => {
    // 2026-06-14T23:00:00Z = Mon 2026-06-15 09:00 AEST
    expect(localDayKey("2026-06-14T23:00:00Z", TZ)).toBe("2026-06-15");
  });
});
