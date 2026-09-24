import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { selectBusyEvents, taskIdOfEvent, buildBusyIcs } from "../../src/calendar-feed/build-busy-ics";
import { guardOutput } from "../../src/calendar-feed/output-guard";
import { compileRevealRegexes } from "../../src/calendar-feed/reveal-rules";
import { SCHEDULER_CHUNK_ID_KEY } from "../../src/providers/types";
import type { CalendarEvent } from "../../src/providers/types";

function ev(partial: Partial<CalendarEvent> & { id: string; start: string; end: string }): CalendarEvent {
  return { summary: "x", extendedProperties: { private: {} }, ...partial } as CalendarEvent;
}
function taskEvent(taskId: string, start: string, end: string): CalendarEvent {
  return ev({ id: `g-${taskId}`, start, end, extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: `${taskId}#0` } } });
}

const MEETING = ev({ id: "ext-1", start: "2026-06-10T09:00:00Z", end: "2026-06-10T10:00:00Z" });
const PINNED = taskEvent("task-pinned", "2026-06-10T11:00:00Z", "2026-06-10T12:00:00Z");
const MOVABLE = taskEvent("task-movable", "2026-06-10T13:00:00Z", "2026-06-10T14:00:00Z");

describe("selectBusyEvents", () => {
  it("keeps meetings + pinned tasks, drops movable tasks", () => {
    const kept = selectBusyEvents([MEETING, PINNED, MOVABLE], new Set(["task-pinned"]));
    expect(kept.map((e) => e.id).sort()).toEqual(["ext-1", "g-task-pinned"].sort());
  });

  it("drops cancelled events", () => {
    const cancelled = ev({ id: "ext-2", start: "2026-06-10T09:00:00Z", end: "2026-06-10T10:00:00Z", status: "cancelled" });
    expect(selectBusyEvents([cancelled], new Set())).toEqual([]);
  });

  it("derives the task id from the chunk id", () => {
    expect(taskIdOfEvent(PINNED)).toBe("task-pinned");
    expect(taskIdOfEvent(MEETING)).toBeNull();
  });
});

describe("buildBusyIcs", () => {
  const NOW = new Date("2026-06-09T00:00:00Z");

  it("emits guard-clean SUMMARY:Busy blocks", async () => {
    const { ics } = await buildBusyIcs([MEETING, PINNED], NOW, env);
    expect(() => guardOutput(ics)).not.toThrow();
    expect(ics).toContain("SUMMARY:Busy");
    expect(ics).not.toContain("ext-1"); // raw id never leaks (UID is hashed)
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
  });

  it("renders all-day events as DATE values", async () => {
    const allDay = ev({ id: "ooo", start: "2026-06-11T00:00:00Z", end: "2026-06-12T00:00:00Z", isAllDay: true });
    const { ics } = await buildBusyIcs([allDay], NOW, env);
    expect(ics).toContain("DTSTART;VALUE=DATE:20260611");
    expect(ics).toContain("DTEND;VALUE=DATE:20260612");
    expect(() => guardOutput(ics)).not.toThrow();
  });
});

describe("buildBusyIcs title reveal", () => {
  const NOW = new Date("2026-06-09T00:00:00Z");
  const rx = compileRevealRegexes(["Northwinds hold .*"]);

  it("reveals a matching title and lists it in allowedSummaries", async () => {
    const { ics, allowedSummaries } = await buildBusyIcs(
      [ev({ id: "e1", start: "2026-06-10T09:00:00Z", end: "2026-06-10T10:00:00Z", summary: "Northwinds hold - 2026-07-21 11:00" })],
      NOW, env, rx,
    );
    expect(ics).toContain("SUMMARY:Northwinds hold - 2026-07-21 11:00");
    expect(allowedSummaries.has("Northwinds hold - 2026-07-21 11:00")).toBe(true);
  });

  it("emits Busy for non-matching titles", async () => {
    const { ics } = await buildBusyIcs(
      [ev({ id: "e2", start: "2026-06-10T09:00:00Z", end: "2026-06-10T10:00:00Z", summary: "Dentist" })],
      NOW, env, rx,
    );
    expect(ics).toContain("SUMMARY:Busy");
    expect(ics).not.toContain("Dentist");
  });

  it("falls back to Busy when a matched title trips the content screen", async () => {
    const leaky = "Northwinds hold - join zoom.us/j/123";
    const { ics, allowedSummaries } = await buildBusyIcs(
      [ev({ id: "e3", start: "2026-06-10T09:00:00Z", end: "2026-06-10T10:00:00Z", summary: leaky })],
      NOW, env, compileRevealRegexes(["Northwinds hold .*"]),
    );
    expect(ics).toContain("SUMMARY:Busy");
    expect(ics).not.toContain("zoom.us");
    expect(allowedSummaries.size).toBe(0);
  });

  it("ICS-escapes revealed titles and allowedSummaries holds the ESCAPED form", async () => {
    const { ics, allowedSummaries } = await buildBusyIcs(
      [ev({ id: "e4", start: "2026-06-10T09:00:00Z", end: "2026-06-10T10:00:00Z", summary: "Northwinds hold - a,b" })],
      NOW, env, compileRevealRegexes(["Northwinds hold .*"]),
    );
    expect(ics).toContain("SUMMARY:Northwinds hold - a\\,b");
    expect(allowedSummaries.has("Northwinds hold - a\\,b")).toBe(true);
  });

  it("guard passes on a feed with revealed titles", async () => {
    const { ics, allowedSummaries } = await buildBusyIcs(
      [
        ev({ id: "e5", start: "2026-06-10T09:00:00Z", end: "2026-06-10T10:00:00Z", summary: "Northwinds hold - x" }),
        ev({ id: "e6", start: "2026-06-10T11:00:00Z", end: "2026-06-10T12:00:00Z", summary: "Dentist" }),
      ],
      NOW, env, rx,
    );
    expect(() => guardOutput(ics, allowedSummaries)).not.toThrow();
  });

  it("folds a revealed title crossing the 75-octet line limit and still passes the guard", async () => {
    const longTitle = "Northwinds hold - quarterly board and executive committee review session";
    const { ics, allowedSummaries } = await buildBusyIcs(
      [ev({ id: "e8", start: "2026-06-10T09:00:00Z", end: "2026-06-10T10:00:00Z", summary: longTitle })],
      NOW, env, compileRevealRegexes(["Northwinds hold .*"]),
    );
    expect(allowedSummaries.has(longTitle)).toBe(true);
    const rawLines = ics.split("\r\n");
    expect(rawLines.some((l) => l.startsWith(" "))).toBe(true); // fold continuation line
    for (const l of rawLines) {
      expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    }
    expect(() => guardOutput(ics, allowedSummaries)).not.toThrow();
  });

  it("no regexes → pure busy feed (back-compat)", async () => {
    const { ics } = await buildBusyIcs(
      [ev({ id: "e7", start: "2026-06-10T09:00:00Z", end: "2026-06-10T10:00:00Z", summary: "Anything" })],
      NOW, env,
    );
    expect(ics).toContain("SUMMARY:Busy");
  });
});
