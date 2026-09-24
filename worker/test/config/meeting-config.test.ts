import { describe, it, expect } from "vitest";
import { readMeetingConfig } from "../../src/meetings/config";

describe("readMeetingConfig", () => {
  it("defaults: disabled, 1440 min notice, cap 20", () => {
    const c = readMeetingConfig({} as any);
    expect(c.enabled).toBe(false);
    expect(c.minNoticeMinutes).toBe(1440);
    expect(c.churnMultiplierCap).toBe(20);
  });
  it("falls back to defaults when a var is set to a garbage string", () => {
    const c = readMeetingConfig({
      MEETING_MIN_NOTICE_MINUTES: "soon",
      MEETING_CHURN_MULTIPLIER_CAP: "lots",
    } as any);
    expect(c.minNoticeMinutes).toBe(1440);
    expect(c.churnMultiplierCap).toBe(20);
  });
  it("reads overrides from env", () => {
    const c = readMeetingConfig({
      OWNED_MEETINGS_ENABLED: "true",
      MEETING_MIN_NOTICE_MINUTES: "120",
      MEETING_CHURN_MULTIPLIER_CAP: "8",
    } as any);
    expect(c.enabled).toBe(true);
    expect(c.minNoticeMinutes).toBe(120);
    expect(c.churnMultiplierCap).toBe(8);
  });
});
