// IanaZone must reject UTC-offset identifiers ("+10:00"). Current ECMA-402
// accepts them as Intl timeZone values, but they are not IANA zones: they carry
// no DST rules and Python's ZoneInfo (bin/ harnesses) can't load them. It also
// rejects bare legacy names ("EST" → America/Panama, no DST) unless they are
// UTC aliases, and every accepted zone is stored in its canonical spelling.
import { describe, it, expect } from "vitest";
import { IanaZone } from "../../src/schema/common";
import { TaskCreate } from "../../src/schema/task";
import { TemplateCreate, TemplatePatch } from "../../src/schema/template";
import { canonicalIanaZone } from "../../src/db/users";

const OFFSETS = ["+10:00", "-05:30", "+1000", "+10", "-00:00"];
const NAMED = ["UTC", "Etc/GMT-10", "Etc/UTC", "Australia/Sydney", "europe/london", "GMT", "Zulu", "US/Eastern", "Etc/GMT+5"];
const BARE = ["EST", "MST", "HST", "CET", "EST5EDT", "PST8PDT", "Japan", "NZ"];

describe("IanaZone rejects UTC-offset identifiers", () => {
  it.each(OFFSETS)("rejects %s", (tz) => {
    expect(IanaZone.safeParse(tz).success).toBe(false);
  });

  it.each(NAMED)("still accepts %s", (tz) => {
    expect(IanaZone.safeParse(tz).success).toBe(true);
  });

  it("rejects an offset as a task window tz", () => {
    const task = (tz: string) => ({
      title: "T", context: "deep", priority: 50, duration_minutes: 60,
      preferred_windows: [{ days: ["tue"], start: "14:00", end: "16:00", hard: true, tz }],
    });
    expect(TaskCreate.safeParse(task("Australia/Sydney")).success).toBe(true);
    expect(TaskCreate.safeParse(task("+10:00")).success).toBe(false);
  });

  it("rejects an offset as a template pinned_tz", () => {
    const tpl = {
      title: "NYC Sync", context: "meeting", rrule: "FREQ=WEEKLY;BYDAY=TU",
      pinned_time: "09:00", duration_minutes: 30, active_from: "2026-01-01",
    };
    expect(TemplateCreate.safeParse({ ...tpl, pinned_tz: "Australia/Sydney" }).success).toBe(true);
    const r = TemplateCreate.safeParse({ ...tpl, pinned_tz: "+10:00" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes("pinned_tz"))).toBe(true);
  });
});

describe("canonicalIanaZone rejects UTC-offset identifiers", () => {
  it.each(OFFSETS)("throws RangeError for %s", (tz) => {
    expect(() => canonicalIanaZone(tz)).toThrow(RangeError);
  });

  it("still canonicalises named zones", () => {
    expect(canonicalIanaZone("europe/london")).toBe("Europe/London");
    expect(canonicalIanaZone("Etc/GMT-10")).toBe("Etc/GMT-10");
  });
});

describe("IanaZone rejects bare legacy names that aren't UTC aliases", () => {
  it.each(BARE)("rejects %s", (tz) => {
    expect(IanaZone.safeParse(tz).success).toBe(false);
    expect(() => canonicalIanaZone(tz)).toThrow(RangeError);
  });
});

describe("IanaZone stores the canonical spelling", () => {
  it.each([
    ["europe/london", "Europe/London"],
    ["GMT", "UTC"],
    ["US/Eastern", "America/New_York"],
  ])("%s → %s", (input, canonical) => {
    const r = IanaZone.safeParse(input);
    expect(r.success && r.data).toBe(canonical);
  });

  it("canonicalises a task window tz and a template pinned_tz", () => {
    const t = TaskCreate.safeParse({
      title: "T", context: "deep", priority: 50, duration_minutes: 60,
      preferred_windows: [{ days: ["tue"], start: "14:00", end: "16:00", hard: true, tz: "US/Eastern" }],
    });
    expect(t.success && t.data.preferred_windows?.[0]?.tz).toBe("America/New_York");
    const tpl = TemplateCreate.safeParse({
      title: "NYC Sync", context: "meeting", rrule: "FREQ=WEEKLY;BYDAY=TU",
      pinned_time: "09:00", duration_minutes: 30, active_from: "2026-01-01", pinned_tz: "GMT",
    });
    expect(tpl.success && tpl.data.pinned_tz).toBe("UTC");
  });
});

describe("TemplateCreate validates task_body.preferred_windows up front", () => {
  const tpl = (task_body: Record<string, unknown>) => ({
    title: "NYC Sync", context: "meeting", rrule: "FREQ=WEEKLY;BYDAY=TU",
    duration_minutes: 30, active_from: "2026-01-01", task_body,
  });
  const win = { days: ["tue"], start: "14:00", end: "16:00", hard: true };

  it("accepts a valid window, keeps other task_body keys, canonicalises its tz", () => {
    const r = TemplateCreate.safeParse(tpl({ priority: 70, preferred_windows: [{ ...win, tz: "europe/london" }] }));
    expect(r.success).toBe(true);
    expect(r.success && r.data.task_body).toEqual({ priority: 70, preferred_windows: [{ ...win, tz: "Europe/London" }] });
  });

  it.each(["+10:00", "EST", "Not/AZone"])("rejects window tz %s (the sweep would skip every occurrence)", (tz) => {
    expect(TemplateCreate.safeParse(tpl({ preferred_windows: [{ ...win, tz }] })).success).toBe(false);
    expect(TemplatePatch.safeParse({ task_body: { preferred_windows: [{ ...win, tz }] } }).success).toBe(false);
  });

  it("rejects a malformed window", () => {
    expect(TemplateCreate.safeParse(tpl({ preferred_windows: [{ days: ["tue"], start: "14:00" }] })).success).toBe(false);
  });
});
