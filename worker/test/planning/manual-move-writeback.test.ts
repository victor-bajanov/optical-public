import { describe, it, expect } from "vitest";
import { computeMovedPlanPatch } from "../../src/planning/manual-move-writeback";
import { SCHEDULER_CHUNK_ID_KEY, type CalendarEvent } from "../../src/providers/types";

function schedEvent(chunkId: string, start: string, end: string): CalendarEvent {
  return {
    id: `ev-${chunkId}`,
    summary: "Deep work",
    start,
    end,
    extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: chunkId } },
  } as CalendarEvent;
}

const baseBody = () => ({
  schedule: [
    { task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z", context: "deep" },
  ],
  dropped: [],
  window: { start: "2026-05-18T00:00:00.000Z", end: "2026-05-25T00:00:00.000Z" },
});

describe("computeMovedPlanPatch", () => {
  it("patches start/end when the calendar event moved", () => {
    const body = baseBody();
    const res = computeMovedPlanPatch(body, [schedEvent("t1#0", "2026-05-19T11:00:00.000Z", "2026-05-19T12:30:00.000Z")]);
    expect(res.changed).toBe(true);
    expect(res.body.schedule[0]!.start).toBe("2026-05-19T11:00:00.000Z");
    expect(res.body.schedule[0]!.end).toBe("2026-05-19T12:30:00.000Z");
    expect(body.schedule[0]!.start).toBe("2026-05-19T09:00:00.000Z");
  });

  it("no change when the calendar start matches the plan (our own commit echo)", () => {
    const res = computeMovedPlanPatch(baseBody(), [schedEvent("t1#0", "2026-05-19T09:00:00.000Z", "2026-05-19T10:30:00.000Z")]);
    expect(res.changed).toBe(false);
  });

  it("ignores a chunk not present in the committed plan", () => {
    const res = computeMovedPlanPatch(baseBody(), [schedEvent("t9#0", "2026-05-19T11:00:00.000Z", "2026-05-19T12:30:00.000Z")]);
    expect(res.changed).toBe(false);
  });

  it("treats an offset-form start equal to the plan's ISO-Z start as no move", () => {
    const res = computeMovedPlanPatch(baseBody(), [schedEvent("t1#0", "2026-05-19T19:00:00+10:00", "2026-05-19T20:30:00+10:00")]);
    expect(res.changed).toBe(false);
  });

  it("reports movedTaskIds for patched entries and [] when unchanged", () => {
    const body = {
      schedule: [
        { task_id: "tA", chunk_id: "tA#0", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z", context: "deep" },
        { task_id: "tB", chunk_id: "tB#0", start: "2026-05-20T09:00:00.000Z", end: "2026-05-20T10:00:00.000Z", context: "deep" },
      ],
      dropped: [],
    } as unknown as Parameters<typeof computeMovedPlanPatch>[0];
    const movedEvent = {
      id: "e1",
      summary: "x",
      start: "2026-05-19T13:00:00Z",
      end: "2026-05-19T14:30:00Z",
      extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "tA#0" } },
    };
    const res = computeMovedPlanPatch(body, [movedEvent]);
    expect(res.changed).toBe(true);
    expect(res.movedTaskIds).toEqual(["tA"]);

    const echo = { ...movedEvent, start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z" };
    const res2 = computeMovedPlanPatch(body, [echo]);
    expect(res2.changed).toBe(false);
    expect(res2.movedTaskIds).toEqual([]);
  });
});

import { reconcileMovedTask } from "../../src/planning/manual-move-writeback";

describe("reconcileMovedTask", () => {
  const NEW_START = "2026-05-19T13:00:00.000Z";

  it("no constraints → null bodyPatch, scheduledFor = newStart", () => {
    const res = reconcileMovedTask({ title: "Deep work", duration_minutes: 90 }, NEW_START);
    expect(res.scheduledFor).toBe(NEW_START);
    expect(res.bodyPatch).toBeNull();
  });

  it("drag earlier than earliest_start → lowers earliest_start to the drop (X6)", () => {
    const res = reconcileMovedTask({ earliest_start: "2026-05-19T15:00:00.000Z" }, NEW_START);
    expect(res.bodyPatch).toEqual({ earliest_start: NEW_START });
  });

  it("drag later than earliest_start → floor untouched", () => {
    const res = reconcileMovedTask({ earliest_start: "2026-05-19T09:00:00.000Z" }, NEW_START);
    expect(res.bodyPatch).toBeNull();
  });

  it("pinned task dragged → moves pinned_at to the drop (L6)", () => {
    const res = reconcileMovedTask({ pinned_at: "2026-05-19T09:00:00.000Z" }, NEW_START);
    expect(res.bodyPatch).toEqual({ pinned_at: NEW_START });
  });

  it("pin + floor-violating drag → both fields rewritten in one patch", () => {
    const res = reconcileMovedTask(
      { pinned_at: "2026-05-19T09:00:00.000Z", earliest_start: "2026-05-19T15:00:00.000Z" },
      NEW_START,
    );
    expect(res.bodyPatch).toEqual({ earliest_start: NEW_START, pinned_at: NEW_START });
  });

  it("is idempotent: feeding a reconciled body back yields null", () => {
    const once = reconcileMovedTask({ pinned_at: "2026-05-19T09:00:00.000Z" }, NEW_START);
    const merged = { pinned_at: "2026-05-19T09:00:00.000Z", ...once.bodyPatch };
    expect(reconcileMovedTask(merged, NEW_START).bodyPatch).toBeNull();
  });

  it("treats an offset-form pin equal to the drop instant as no move", () => {
    // 23:00+10:00 == 13:00Z → same instant, no patch despite different string
    const res = reconcileMovedTask({ pinned_at: "2026-05-19T23:00:00+10:00" }, NEW_START);
    expect(res.bodyPatch).toBeNull();
  });

  it("preserves untouched body fields (caller merges; function only returns the delta)", () => {
    const res = reconcileMovedTask(
      { earliest_start: "2026-05-19T15:00:00.000Z", preferred_windows: [{ a: 1 }], deadline: "2026-06-01" },
      NEW_START,
    );
    expect(res.bodyPatch).toEqual({ earliest_start: NEW_START });
    // preferred_windows/deadline are NOT in the patch (shell merges over existing body)
  });
});
