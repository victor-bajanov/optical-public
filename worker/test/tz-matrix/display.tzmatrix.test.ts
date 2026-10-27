// tz-matrix mirror of test/diff/format-local.test.ts and
// test/admin/dev-ui-week.test.ts (extended from its 7 zones to the matrix,
// plus each zone's 2026 DST-transition instants).
import { describe, it, expect } from "vitest";
import { formatLocalTime, formatLocalDate, localDayKey } from "../../src/diff/format-local";
import { devUiLocalYmd, devUiMondayYmd, devUiLocalMidnightIso } from "../../src/admin/dev-ui-week";
import { localWeekWindow } from "../../src/planning/datetime";
import { MATRIX_ZONES, MIDNIGHT_GAP_ZONES, local, transitions, wallIso, weekContaining } from "./zones";

const ALL_ZONES = [...new Set([...MATRIX_ZONES, ...MIDNIGHT_GAP_ZONES])];

describe.each(ALL_ZONES)("format-local in %s", (tz) => {
  it("14:45 / 11:30 local render as 12-hour clock, date and day key are local", () => {
    expect(formatLocalTime(wallIso("2026-06-15", "14:45", tz), tz)).toBe("2:45 PM");
    expect(formatLocalTime(wallIso("2026-06-15", "11:30", tz), tz)).toBe("11:30 AM");
    expect(formatLocalDate(wallIso("2026-06-15", "11:30", tz), tz)).toBe("Mon 15 June");
    expect(localDayKey(wallIso("2026-06-15", "09:00", tz), tz)).toBe("2026-06-15");
  });
});

describe.each(ALL_ZONES)("dev UI week helpers in %s", (tz) => {
  it("this/next week match the oracle and localWeekWindow at ordinary and DST-transition instants", () => {
    const instants = ["2026-05-17T15:00:00.000Z", "2026-05-20T03:00:00.000Z", ...transitions(tz, 2026).map((t) => new Date(t.atMs).toISOString())];
    for (const now of instants) {
      const today = devUiLocalYmd(Date.parse(now), tz);
      expect(today).toBe(local(Date.parse(now), tz).date);
      const want = weekContaining(Date.parse(now), tz);
      expect(localWeekWindow(now, tz), now).toEqual(want);
      expect(devUiLocalMidnightIso(devUiMondayYmd(today, 0), tz), now).toBe(want.start);
      expect(devUiLocalMidnightIso(devUiMondayYmd(today, 1), tz), now).toBe(want.end);
    }
  });
});
