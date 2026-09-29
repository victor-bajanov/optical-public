import { describe, it, expect } from "vitest";
import { devUiLocalYmd, devUiMondayYmd, devUiLocalMidnightIso } from "../../src/admin/dev-ui-week";
import { DEV_UI_HTML } from "../../src/admin/dev-ui-route";
import { localWeekWindow } from "../../src/planning/datetime";

// The dev UI's week picker builds /v1/resolve windows in the browser. They
// must be the caller's local Mon 00:00 in their effective tz (whoami.home_tz),
// the same week the server buckets in: a UTC-midnight window is Sunday
// afternoon/evening in the Americas and buckets into the PREVIOUS local week.
describe("dev UI week helpers", () => {
  const ZONES = ["Australia/Sydney", "Europe/London", "America/Los_Angeles", "America/New_York", "Pacific/Kiritimati", "Etc/GMT+12", "UTC"];
  const INSTANTS = [
    "2026-05-17T15:00:00.000Z", // Sun afternoon UTC
    "2026-05-20T03:00:00.000Z", // mid-week
    "2026-10-04T12:00:00.000Z", // Sydney DST start weekend
    "2026-11-01T09:30:00.000Z", // US DST end day
    "2026-03-29T00:30:00.000Z", // UK DST start day
  ];

  for (const tz of ZONES) {
    for (const now of INSTANTS) {
      it(`this week and next week match localWeekWindow in ${tz} at ${now}`, () => {
        const today = devUiLocalYmd(Date.parse(now), tz);
        const thisWeek = localWeekWindow(now, tz);
        expect(devUiLocalMidnightIso(devUiMondayYmd(today, 0), tz)).toBe(thisWeek.start);
        expect(devUiLocalMidnightIso(devUiMondayYmd(today, 1), tz)).toBe(thisWeek.end);
        const nextWeek = localWeekWindow(thisWeek.end, tz);
        expect(devUiLocalMidnightIso(devUiMondayYmd(today, 2), tz)).toBe(nextWeek.end);
      });
    }
  }

  it("a picked date is the local midnight in the given tz, not UTC midnight", () => {
    expect(devUiLocalMidnightIso("2026-05-18", "America/Los_Angeles")).toBe("2026-05-18T07:00:00.000Z");
    expect(devUiLocalMidnightIso("2026-05-18", "Australia/Sydney")).toBe("2026-05-17T14:00:00.000Z");
    expect(devUiLocalMidnightIso("2026-05-18", "UTC")).toBe("2026-05-18T00:00:00.000Z");
  });

  it("the page inlines the helpers and no longer builds UTC-midnight windows", () => {
    for (const fn of [devUiLocalYmd, devUiMondayYmd, devUiLocalMidnightIso]) {
      const src = fn.toString();
      expect(DEV_UI_HTML).toContain(src);
      // Inlined verbatim into the browser: no bundler helper references.
      expect(src).not.toContain("__name");
    }
    expect(DEV_UI_HTML).not.toContain('ws + "T00:00:00Z"');
    expect(DEV_UI_HTML).not.toContain('we + "T00:00:00Z"');
    expect(DEV_UI_HTML).toContain("devUiLocalMidnightIso(ws, homeTz)");
  });
});
