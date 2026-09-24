import { describe, it, expect } from "vitest";
import { computeChurnBaseline } from "../../src/planning/churn-baseline";
import type { ScheduleEntry } from "../../src/diff/compute-diff";

// Wed 27 May 2026 00:00 → Sat 30 May 2026 00:00 (AEST), the shape of a
// mid-week-narrowed replan window.
const WINDOW_START = Date.parse("2026-05-26T14:00:00.000Z");
const WINDOW_END = Date.parse("2026-05-29T14:00:00.000Z");

const entry = (chunkId: string, start: string): ScheduleEntry => {
  const startMs = Date.parse(start);
  return {
    task_id: chunkId.slice(0, chunkId.lastIndexOf("#")),
    chunk_id: chunkId,
    start,
    end: Number.isFinite(startMs) ? new Date(startMs + 3_600_000).toISOString() : start,
    context: "deep",
  };
};

const MON = "2026-05-24T23:00:00.000Z"; // Mon 25 May 09:00 — before the window
const WED = "2026-05-26T23:00:00.000Z"; // Wed 27 May 09:00 — inside
const FRI = "2026-05-28T23:00:00.000Z"; // Fri 29 May 09:00 — inside

describe("computeChurnBaseline", () => {
  it("uses the week plan's in-window entries verbatim, ignoring the calendar", () => {
    const plan = [entry("t1#0", WED)];
    const got = computeChurnBaseline({
      weekPlanSchedule: plan,
      priorEvents: [entry("t1#0", FRI)], // disagrees; must not be consulted
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(got).toEqual(plan);
  });

  it("keeps a partially-overlapping week plan's surviving entries and never tops up from the calendar", () => {
    // The normal mid-week-replan shape: a Mon-anchored committed plan against a
    // Wed-narrowed window. The Wed/Fri entries are the baseline; the elapsed Mon
    // entry is dropped, and its task is NOT re-anchored from the calendar.
    const got = computeChurnBaseline({
      weekPlanSchedule: [entry("t1#0", MON), entry("t2#0", WED), entry("t3#0", FRI)],
      priorEvents: [entry("t1#0", WED)],
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(got.map((e) => e.chunk_id)).toEqual(["t2#0", "t3#0"]);
  });

  it("falls back to the calendar when there is no committed plan for the week", () => {
    const events = [entry("t1#0", WED)];
    const got = computeChurnBaseline({
      weekPlanSchedule: null,
      priorEvents: events,
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(got).toEqual(events);
  });

  it("falls back to the calendar when every week-plan entry is outside the window", () => {
    const events = [entry("t2#0", FRI)];
    const got = computeChurnBaseline({
      weekPlanSchedule: [entry("t1#0", MON)],
      priorEvents: events,
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(got).toEqual(events);
  });

  it("returns [] when both sources are empty (a truly first resolve)", () => {
    expect(
      computeChurnBaseline({
        weekPlanSchedule: [],
        priorEvents: [],
        windowStartMs: WINDOW_START,
        windowEndMs: WINDOW_END,
      }),
    ).toEqual([]);
  });

  it("filters out-of-window calendar entries too", () => {
    const got = computeChurnBaseline({
      weekPlanSchedule: null,
      priorEvents: [entry("t1#0", MON), entry("t2#0", WED)],
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(got.map((e) => e.chunk_id)).toEqual(["t2#0"]);
  });

  it("keeps an entry starting exactly at windowStart and drops one starting exactly at windowEnd", () => {
    const got = computeChurnBaseline({
      weekPlanSchedule: [
        entry("t1#0", new Date(WINDOW_START).toISOString()),
        entry("t2#0", new Date(WINDOW_END).toISOString()),
      ],
      priorEvents: [],
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(got.map((e) => e.chunk_id)).toEqual(["t1#0"]);
  });

  it("keeps exactly one entry per chunk_id, the earliest, when the calendar holds duplicates", () => {
    // Two events can carry the same scheduler_chunk_id (the 2026-07-06 stray-event
    // class — commit only heals chunks with NO in-window event). The solver's two
    // churn paths resolve duplicates oppositely and neither 422s, so the baseline
    // must be chunk-unique before it leaves here. Fetch order is not guaranteed,
    // so the survivor is chosen by start, not by position.
    const got = computeChurnBaseline({
      weekPlanSchedule: null,
      priorEvents: [entry("t1#0", FRI), entry("t1#0", WED), entry("t2#0", WED)],
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(got).toHaveLength(2);
    expect(got.find((e) => e.chunk_id === "t1#0")?.start).toBe(WED);
    expect(got.map((e) => e.chunk_id)).toEqual(["t1#0", "t2#0"]);
  });

  it("drops entries whose start does not parse, from either source", () => {
    const planOnly = computeChurnBaseline({
      weekPlanSchedule: [entry("t1#0", "not-a-date"), entry("t2#0", WED)],
      priorEvents: [],
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(planOnly.map((e) => e.chunk_id)).toEqual(["t2#0"]);

    // A plan whose only entry is unparseable yields nothing in-window, so the
    // calendar takes over — and is filtered on the same rule.
    const viaCalendar = computeChurnBaseline({
      weekPlanSchedule: [entry("t1#0", "not-a-date")],
      priorEvents: [entry("t2#0", "also-not-a-date"), entry("t3#0", FRI)],
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(viaCalendar.map((e) => e.chunk_id)).toEqual(["t3#0"]);
  });
});
