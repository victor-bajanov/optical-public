import { describe, it, expect } from "vitest";
import { recolorTaskChunks } from "../../src/planning/recolor-done";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { SCHEDULER_CHUNK_ID_KEY } from "../../src/providers/types";

const WIN_START = "2026-05-18T00:00:00Z";
const WIN_END = "2026-06-15T00:00:00Z";

function chunk(id: string, chunkId: string, colorId: string) {
  return {
    id,
    summary: "Deep work",
    start: "2026-05-19T09:00:00Z",
    end: "2026-05-19T10:00:00Z",
    colorId,
    extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: chunkId } },
  };
}

describe("recolorTaskChunks", () => {
  it("recolors every scheduler chunk of the task and reports each seen chunk's event id", async () => {
    const cal = new MockCalendarProvider({
      events: [
        chunk("e0", "t1#0", "5"),
        chunk("e1", "t1#1", "5"),
        chunk("e2", "t2#0", "5"), // other task — untouched
        { id: "ext", summary: "ext", start: "2026-05-19T11:00:00Z", end: "2026-05-19T12:00:00Z", extendedProperties: {} },
      ],
    });
    const r = await recolorTaskChunks(cal, "t1", "11", WIN_START, WIN_END);
    expect(r.recolored).toBe(2);
    expect([...r.seenEvents.entries()].sort()).toEqual([
      ["t1#0", "e0"],
      ["t1#1", "e1"],
    ]);
    const recoloured = cal.updated.map((u) => u.eventId).sort();
    expect(recoloured).toEqual(["e0", "e1"]);
    expect(cal.updated.every((u) => u.changes.colorId === "11")).toBe(true);
  });

  it("matches the bare-task-id chunk form (no '#')", async () => {
    const cal = new MockCalendarProvider({ events: [chunk("e0", "t1", "5")] });
    const r = await recolorTaskChunks(cal, "t1", "11", WIN_START, WIN_END);
    expect(r.recolored).toBe(1);
    expect(r.seenEvents.get("t1")).toBe("e0");
    expect(cal.updated[0]!.eventId).toBe("e0");
  });

  it("reports an already-target-color chunk as seen without repainting it", async () => {
    // A chunk already painted the target colour needs no PATCH, but it WAS
    // found and confirmed-by-inspection — callers may stamp it colour-confirmed.
    const cal = new MockCalendarProvider({ events: [chunk("e0", "t1#0", "11")] });
    const r = await recolorTaskChunks(cal, "t1", "11", WIN_START, WIN_END);
    expect(r.recolored).toBe(0);
    expect(r.seenEvents.get("t1#0")).toBe("e0");
    expect(cal.updated).toHaveLength(0);
  });

  it("reports nothing seen when the task has no chunks in the window", async () => {
    // The 2026-07-06 incident's arming step: the task's only event lay outside
    // the scan window, the recolor was a silent no-op, yet the caller stamped
    // the record colour-confirmed anyway. The empty seenEvents map is what lets
    // the caller tell "recolored/verified" apart from "found nothing".
    const cal = new MockCalendarProvider({ events: [chunk("e2", "t2#0", "5")] });
    const r = await recolorTaskChunks(cal, "t1", "11", WIN_START, WIN_END);
    expect(r.recolored).toBe(0);
    expect(r.seenEvents.size).toBe(0);
    expect(cal.updated).toHaveLength(0);
  });
});
