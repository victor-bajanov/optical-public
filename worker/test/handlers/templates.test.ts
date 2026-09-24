import { describe, it, expect } from "vitest";
import { TemplateCreate } from "../../src/schema/template";

describe("TemplateCreate.pinned_tz validation", () => {
  it("accepts a valid IANA zone", () => {
    const r = TemplateCreate.safeParse({
      title: "NYC Sync",
      context: "meeting",
      rrule: "FREQ=WEEKLY;BYDAY=TU",
      pinned_time: "09:00",
      pinned_tz: "America/New_York",
      duration_minutes: 30,
      active_from: "2026-01-01",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an invalid IANA zone with a clear error", () => {
    const r = TemplateCreate.safeParse({
      title: "Mars Sync",
      context: "meeting",
      rrule: "FREQ=WEEKLY;BYDAY=TU",
      pinned_time: "09:00",
      pinned_tz: "Mars/Olympus",
      duration_minutes: 30,
      active_from: "2026-01-01",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toMatch(/invalid.*timezone|IANA/i);
    }
  });

  it("accepts absent pinned_tz", () => {
    const r = TemplateCreate.safeParse({
      title: "Standup",
      context: "meeting",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      pinned_time: "09:30",
      duration_minutes: 15,
      active_from: "2026-01-01",
    });
    expect(r.success).toBe(true);
  });
});
