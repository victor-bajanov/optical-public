// Card A — substrate tests. Semantics pinned against the Python fast path
// (solver/src/solver/placements.py); the golden fixtures under fixtures/ are
// regenerated only by solver/bin/dump-domains.py.

import { describe, expect, it } from "vitest";
import { bakeProblem, datetimeToSlot, slotToDatetime } from "../../src/engine/substrate";
import type { Baked, Problem } from "../../src/engine/types";

import earliestStartFx from "./fixtures/problems/earliest_start-light.json";
import hardWindowFx from "./fixtures/problems/preferred_window_hard-light.json";
import availabilityFx from "./fixtures/problems/availability_windows-light.json";
import businessHoursFx from "./fixtures/problems/business_hours-light.json";
import fitCurveFx from "./fixtures/problems/fit_curve-light.json";
import churnFx from "./fixtures/problems/churn-light.json";
import pinnedAtFx from "./fixtures/problems/pinned_at-light.json";
import softWindowFx from "./fixtures/problems/preferred_window_soft-light.json";
import externalOverlapFx from "./fixtures/problems/infeasible_external_overlap.json";

import earliestStartDom from "./fixtures/domains/earliest_start-light.domains.json";
import hardWindowDom from "./fixtures/domains/preferred_window_hard-light.domains.json";
import availabilityDom from "./fixtures/domains/availability_windows-light.domains.json";
import businessHoursDom from "./fixtures/domains/business_hours-light.domains.json";
import fitCurveDom from "./fixtures/domains/fit_curve-light.domains.json";
import churnDom from "./fixtures/domains/churn-light.domains.json";
import pinnedAtDom from "./fixtures/domains/pinned_at-light.domains.json";
import softWindowDom from "./fixtures/domains/preferred_window_soft-light.domains.json";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const WINDOW = {
  start: "2026-05-18T00:00:00", // a Monday
  end: "2026-05-25T00:00:00",
  tz: "Australia/Sydney",
};
const SLOTS_PER_DAY = 96;

function slot(day: number, hour: number, minute = 0): number {
  return day * SLOTS_PER_DAY + hour * 4 + minute / 15;
}

type TaskOverrides = Partial<Problem["tasks"][number]>;

function makeTask(id: string, over: TaskOverrides = {}): Problem["tasks"][number] {
  return {
    id,
    title: id,
    context: "deep",
    priority: 50,
    chunks: [{ chunk_id: `${id}#0`, duration_minutes: 60 }],
    group_policy: { same_day: false, ordered: false },
    earliest_start: WINDOW.start as Problem["tasks"][number]["earliest_start"],
    preferred_windows: [],
    dependencies: [],
    previous_placement: [],
    must_include: false,
    ...over,
  };
}

function makeProblem(over: Partial<Problem> = {}): Problem {
  return {
    window: WINDOW as Problem["window"],
    weights: {
      time_of_day_fit_per_15min: 0,
      churn_per_15min_moved: 0,
      priority_unit: 1,
      base_drop_penalty: 200,
      preferred_day_miss: 0,
      preferred_time_miss_per_15min: 0,
    },
    contexts: [
      {
        context: "deep",
        fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "15:00" },
        max_minutes_per_day: null,
        max_contiguous_minutes: null,
        over_daily_cap_penalty_per_15min: 25,
        over_streak_cap_penalty_per_15min: 25,
      },
    ],
    tasks: [],
    external_pinned: [],
    business_hours: null,
    ...over,
  };
}

function chunk(baked: Baked, taskId: string, chunkId: string) {
  const idx = baked.chunkIndexByKey.get(`${taskId} ${chunkId}`);
  if (idx === undefined) throw new Error(`no chunk ${taskId}/${chunkId}`);
  return baked.chunks[idx]!;
}

function starts(baked: Baked, taskId: string, chunkId: string): number[] {
  return Array.from(chunk(baked, taskId, chunkId).allowedStarts);
}

// ---------------------------------------------------------------------------
// slot arithmetic
// ---------------------------------------------------------------------------

describe("slot arithmetic", () => {
  it("round-trips datetimes on the 15-min grid", () => {
    expect(datetimeToSlot("2026-05-18T00:00:00", WINDOW.start)).toBe(0);
    expect(datetimeToSlot("2026-05-18T10:15:00", WINDOW.start)).toBe(41);
    expect(datetimeToSlot("2026-05-19T00:00:00", WINDOW.start)).toBe(96);
    expect(datetimeToSlot("2026-05-25T00:00:00", WINDOW.start)).toBe(672);
    expect(slotToDatetime(41, WINDOW.start)).toBe("2026-05-18T10:15:00");
    expect(slotToDatetime(0, WINDOW.start)).toBe("2026-05-18T00:00:00");
  });

  it("supports negative slots (before the origin)", () => {
    expect(datetimeToSlot("2026-05-17T23:45:00", WINDOW.start)).toBe(-1);
  });

  it("throws on misaligned input (contract violation)", () => {
    expect(() => datetimeToSlot("2026-05-18T10:07:00", WINDOW.start)).toThrow();
    expect(() => datetimeToSlot("2026-05-18T10:00:30", WINDOW.start)).toThrow();
  });

  it("bakes slot tables (tod / weekday / day index)", () => {
    const baked = bakeProblem(makeProblem());
    expect(baked.horizon).toBe(672);
    expect(baked.slotTod[0]).toBe(0);
    expect(baked.slotTod[slot(0, 10, 15)]).toBe(615);
    expect(baked.slotWeekday[0]).toBe(0); // Monday
    expect(baked.slotWeekday[slot(5, 12)]).toBe(5); // Saturday
    expect(baked.slotDayIndex[slot(0, 23, 45)]).toBe(0);
    expect(baked.slotDayIndex[slot(1, 0, 0)]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// domain rules (unit, one per rule)
// ---------------------------------------------------------------------------

describe("allowed-start domains", () => {
  it("floors at earliest_start and ceils at horizon - duration", () => {
    const p = makeProblem({
      tasks: [makeTask("t", { earliest_start: "2026-05-18T10:00:00" as never })],
    });
    const s = starts(bakeProblem(p), "t", "t#0");
    expect(s[0]).toBe(slot(0, 10));
    expect(s[s.length - 1]).toBe(672 - 4);
    expect(s.length).toBe(672 - 4 - slot(0, 10) + 1);
  });

  it("collapses a pin to a single point (first chunk only)", () => {
    const p = makeProblem({
      tasks: [
        makeTask("t", {
          pinned_at: "2026-05-19T10:00:00" as never,
          chunks: [
            { chunk_id: "t#0", duration_minutes: 60 },
            { chunk_id: "t#1", duration_minutes: 60 },
          ],
        }),
      ],
    });
    const baked = bakeProblem(p);
    expect(starts(baked, "t", "t#0")).toEqual([slot(1, 10)]);
    // second chunk is unpinned: full domain
    expect(starts(baked, "t", "t#1").length).toBe(672 - 4 + 1);
  });

  it("pin outside the hard-deadline band ⇒ empty domain (droppable, not unsat)", () => {
    const p = makeProblem({
      tasks: [
        makeTask("t", {
          pinned_at: "2026-05-19T10:00:00" as never,
          deadline: { at: "2026-05-19T09:00:00", hard: true, penalty_per_15min: 0 } as never,
        }),
      ],
    });
    expect(starts(bakeProblem(p), "t", "t#0")).toEqual([]);
  });

  it("hard deadline bounds end ≤ deadline", () => {
    const p = makeProblem({
      tasks: [
        makeTask("t", {
          deadline: { at: "2026-05-18T12:00:00", hard: true, penalty_per_15min: 0 } as never,
        }),
      ],
    });
    const s = starts(bakeProblem(p), "t", "t#0");
    expect(s[s.length - 1]).toBe(slot(0, 11)); // 11:00 + 60min = 12:00
  });

  it("ANDs multiple hard windows", () => {
    const p = makeProblem({
      tasks: [
        makeTask("t", {
          preferred_windows: [
            { days: ["mon", "tue"], start: "09:00", end: "12:00", hard: true },
            { days: ["mon"], start: "10:00", end: "17:00", hard: true },
          ] as never,
        }),
      ],
    });
    // Intersection: Monday only, [10:00, 12:00) window for a 60-min chunk.
    expect(starts(bakeProblem(p), "t", "t#0")).toEqual([
      slot(0, 10),
      slot(0, 10, 15),
      slot(0, 10, 30),
      slot(0, 10, 45),
      slot(0, 11),
    ]);
  });

  it("unions availability windows (whole chunk inside one window)", () => {
    const p = makeProblem({
      tasks: [
        makeTask("t", {
          availability_windows: [
            { start: "2026-05-18T09:00:00", end: "2026-05-18T10:00:00" },
            { start: "2026-05-19T14:00:00", end: "2026-05-19T15:30:00" },
          ] as never,
        }),
      ],
    });
    expect(starts(bakeProblem(p), "t", "t#0")).toEqual([
      slot(0, 9),
      slot(1, 14),
      slot(1, 14, 15),
      slot(1, 14, 30),
    ]);
  });

  it("applies business hours to unexempt tasks", () => {
    const bh = { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" };
    const p = makeProblem({
      business_hours: bh as never,
      tasks: [makeTask("t")],
    });
    const baked = bakeProblem(p);
    const s = starts(baked, "t", "t#0");
    expect(s.length).toBe(5 * (slot(0, 16) - slot(0, 9) + 1));
    expect(s[0]).toBe(slot(0, 9));
    expect(baked.tasks[0]!.usedBusinessHours).toBe(true);
  });

  it("exempts pins, hard windows and availability masks from business hours — but NOT soft windows", () => {
    const bh = { days: ["mon"], start: "09:00", end: "10:00" };
    const base = { business_hours: bh as never };
    // pin outside BH survives
    const pinned = bakeProblem(
      makeProblem({ ...base, tasks: [makeTask("t", { pinned_at: "2026-05-20T20:00:00" as never })] }),
    );
    expect(starts(pinned, "t", "t#0")).toEqual([slot(2, 20)]);
    expect(pinned.tasks[0]!.usedBusinessHours).toBe(false);
    // hard own window outside BH survives
    const hardWin = bakeProblem(
      makeProblem({
        ...base,
        tasks: [
          makeTask("t", {
            preferred_windows: [{ days: ["sat"], start: "18:00", end: "20:00", hard: true }] as never,
          }),
        ],
      }),
    );
    expect(starts(hardWin, "t", "t#0")).toEqual([
      slot(5, 18),
      slot(5, 18, 15),
      slot(5, 18, 30),
      slot(5, 18, 45),
      slot(5, 19),
    ]);
    // availability mask outside BH survives
    const avail = bakeProblem(
      makeProblem({
        ...base,
        tasks: [
          makeTask("t", {
            availability_windows: [{ start: "2026-05-23T18:00:00", end: "2026-05-23T19:00:00" }] as never,
          }),
        ],
      }),
    );
    expect(starts(avail, "t", "t#0")).toEqual([slot(5, 18)]);
    // a SOFT window does not exempt: BH still clips
    const softWin = bakeProblem(
      makeProblem({
        ...base,
        tasks: [
          makeTask("t", {
            preferred_windows: [{ days: ["sat"], start: "18:00", end: "20:00", hard: false }] as never,
          }),
        ],
      }),
    );
    expect(starts(softWin, "t", "t#0")).toEqual([slot(0, 9)]);
    expect(softWin.tasks[0]!.usedBusinessHours).toBe(true);
  });

  it("allows midnight-crossing starts only without BH/windows, and flags them", () => {
    const free = bakeProblem(makeProblem({ tasks: [makeTask("t")] }));
    const c = chunk(free, "t", "t#0");
    expect(Array.from(c.allowedStarts)).toContain(slot(0, 23, 45));
    expect(c.canSpanMidnight).toBe(true);
    const bhBaked = bakeProblem(
      makeProblem({
        business_hours: { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "00:00", end: "23:45" } as never,
        tasks: [makeTask("t")],
      }),
    );
    const cb = chunk(bhBaked, "t", "t#0");
    expect(Array.from(cb.allowedStarts)).not.toContain(slot(0, 23, 45));
    expect(cb.canSpanMidnight).toBe(false);
  });

  it("keeps chunk ids distinct across tasks (chunk_id unique only within a task)", () => {
    const p = makeProblem({
      tasks: [
        makeTask("a", { chunks: [{ chunk_id: "c0", duration_minutes: 30 }] }),
        makeTask("b", {
          chunks: [{ chunk_id: "c0", duration_minutes: 60 }],
          earliest_start: "2026-05-19T00:00:00" as never,
        }),
      ],
    });
    const baked = bakeProblem(p);
    expect(chunk(baked, "a", "c0").durationSlots).toBe(2);
    expect(chunk(baked, "b", "c0").durationSlots).toBe(4);
    expect(starts(baked, "b", "c0")[0]).toBe(slot(1, 0));
  });
});

// ---------------------------------------------------------------------------
// cost vectors
// ---------------------------------------------------------------------------

describe("cost vectors", () => {
  function costAt(baked: Baked, taskId: string, chunkId: string, startSlot: number): number {
    const c = chunk(baked, taskId, chunkId);
    const i = c.allowedStarts.indexOf(startSlot);
    if (i < 0) throw new Error(`slot ${startSlot} not allowed`);
    return c.cost[i]!;
  }

  it("prices the fit curve at peak / ramp / flat boundaries (incl. trailing edge)", () => {
    const p = makeProblem({
      weights: {
        time_of_day_fit_per_15min: 1,
        churn_per_15min_moved: 0,
        priority_unit: 1,
        base_drop_penalty: 200,
        preferred_day_miss: 0,
        preferred_time_miss_per_15min: 0,
      },
      tasks: [makeTask("t", { chunks: [{ chunk_id: "t#0", duration_minutes: 15 }] })],
    });
    const baked = bakeProblem(p);
    // curve deep: peak 09:00–12:00, falloff_end 15:00 (span 180)
    expect(costAt(baked, "t", "t#0", slot(0, 9))).toBe(0); // inside peak, edge inside peak
    expect(costAt(baked, "t", "t#0", slot(0, 11, 45))).toBe(0); // ends exactly at peak_end
    // start 12:00: score(720)=0, trailing edge score(735)=round(15/180*100)=8
    expect(costAt(baked, "t", "t#0", slot(0, 12))).toBe(8);
    // start 15:00 or later: flat 100 + trailing 100
    expect(costAt(baked, "t", "t#0", slot(0, 15))).toBe(200);
    // pre-peak ramp at 00:00: score(0)=100, score(15)=round((540-15)/540*100)=97
    expect(costAt(baked, "t", "t#0", slot(0, 0))).toBe(197);
    // midnight-crossing start pays the max fit penalty per slot
    const p60 = makeProblem({
      weights: { ...p.weights },
      tasks: [makeTask("t", { chunks: [{ chunk_id: "t#0", duration_minutes: 60 }] })],
    });
    const baked60 = bakeProblem(p60);
    // 23:45 + 60min crosses midnight → fit table = 100 * (60/15) = 400
    expect(costAt(baked60, "t", "t#0", slot(0, 23, 45))).toBe(400);
  });

  it("prices churn as |Δslots| × weight × multiplier, zero for out-of-window previous placement", () => {
    const p = makeProblem({
      weights: {
        time_of_day_fit_per_15min: 0,
        churn_per_15min_moved: 3,
        priority_unit: 1,
        base_drop_penalty: 200,
        preferred_day_miss: 0,
        preferred_time_miss_per_15min: 0,
      },
      tasks: [
        makeTask("t", {
          churn_multiplier: 2 as never,
          previous_placement: [{ chunk_id: "t#0", start: "2026-05-18T10:00:00" }] as never,
        }),
        makeTask("u", {
          previous_placement: [{ chunk_id: "u#0", start: "2026-05-11T10:00:00" }] as never,
        }),
      ],
    });
    const baked = bakeProblem(p);
    expect(costAt(baked, "t", "t#0", slot(0, 10))).toBe(0);
    expect(costAt(baked, "t", "t#0", slot(0, 12))).toBe(8 * 3 * 2);
    expect(chunk(baked, "t", "t#0").prevSlot).toBe(slot(0, 10));
    // previous week's placement: no churn, no warm-start slot
    const u = chunk(baked, "u", "u#0");
    expect(u.prevSlot).toBe(-1);
    expect(Array.from(u.cost).every((v) => v === 0)).toBe(true);
  });

  it("prices soft-window misses as min over windows of day gap + time gap", () => {
    const p = makeProblem({
      weights: {
        time_of_day_fit_per_15min: 0,
        churn_per_15min_moved: 0,
        priority_unit: 1,
        base_drop_penalty: 200,
        preferred_day_miss: 40,
        preferred_time_miss_per_15min: 5,
      },
      tasks: [
        makeTask("t", {
          preferred_windows: [
            { days: ["tue"], start: "09:00", end: "11:00", hard: false },
            { days: ["fri"], start: "14:00", end: "16:00", hard: false },
          ] as never,
        }),
      ],
    });
    const baked = bakeProblem(p);
    // On Tuesday inside 09:00–11:00: 0
    expect(costAt(baked, "t", "t#0", slot(1, 9))).toBe(0);
    // Monday 09:00: day gap 1 to Tuesday (win 1), time gap 0 → 40; win 2 costs more
    expect(costAt(baked, "t", "t#0", slot(0, 9))).toBe(40);
    // Tuesday 12:00: day gap 0, time gap = start 12:00+60min end 13:00 vs win end 11:00 → 120min over → 8 units × 5 = 40
    expect(costAt(baked, "t", "t#0", slot(1, 12))).toBe(40);
    // Thursday 14:00: win2 day gap 1 (Fri), inside time → 40 beats win1's cost
    expect(costAt(baked, "t", "t#0", slot(3, 14))).toBe(40);
  });

  it("yields all-zero vectors when every soft weight is zero", () => {
    const p = makeProblem({
      tasks: [
        makeTask("t", {
          previous_placement: [{ chunk_id: "t#0", start: "2026-05-18T10:00:00" }] as never,
          preferred_windows: [{ days: ["tue"], start: "09:00", end: "11:00", hard: false }] as never,
        }),
      ],
    });
    const c = chunk(bakeProblem(p), "t", "t#0");
    expect(Array.from(c.cost).every((v) => v === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// task metadata
// ---------------------------------------------------------------------------

describe("task metadata", () => {
  it("bakes drop weight, must_include, group policy, deadline and dependencies", () => {
    const p = makeProblem({
      external_pinned: [
        { id: "ev", title: "ev", start: "2026-05-19T10:00:00", duration_minutes: 60, context: "meeting" },
      ] as never,
      tasks: [
        makeTask("a", {
          priority: 10,
          must_include: true,
          group_policy: { same_day: true, ordered: true },
          deadline: { at: "2026-05-20T00:00:00", hard: false, penalty_per_15min: 7 } as never,
        }),
        makeTask("b", {
          dependencies: [
            { type: "after_task", ref: "a", hard: true },
            { type: "before_event", ref: "ev", hard: true },
            { type: "after_task", ref: "a", hard: false }, // soft: ignored
            { type: "after_task", ref: "missing", hard: true }, // unresolvable: skipped
          ] as never,
        }),
      ],
    });
    const baked = bakeProblem(p);
    const a = baked.tasks[0]!;
    expect(a.dropWeight).toBe(200 + 10 * 1);
    expect(a.mustInclude).toBe(true);
    expect(a.sameDay).toBe(true);
    expect(a.ordered).toBe(true);
    expect(a.deadlineSlot).toBe(slot(2, 0));
    expect(a.deadlineHard).toBe(false);
    expect(a.deadlinePenaltyPer15).toBe(7);
    const b = baked.tasks[1]!;
    expect(b.deps).toHaveLength(2);
    expect(b.deps[0]).toMatchObject({ type: "after_task", taskIndex: 0 });
    expect(b.deps[1]).toMatchObject({
      type: "before_event",
      eventStartSlot: slot(1, 10),
      eventEndSlot: slot(1, 11),
    });
    expect(a.hasSoftDeadline).toBe(true);
  });

  it("bakes an already-passed soft deadline unclamped and flags its presence", () => {
    // A deadline before window.start is routine: task-window.ts anchors overdue
    // tasks into the current week and build-problem.ts passes `deadline.at`
    // through unclamped. It bakes to a NEGATIVE slot, which collides with the
    // -1 "no deadline" sentinel when the deadline is exactly one slot early —
    // hence the separate presence flag, mirroring the test
    // objective.lateness_terms uses (`deadline is not None and not hard`).
    const p = makeProblem({
      tasks: [
        makeTask("past", {
          deadline: { at: "2026-05-17T20:00:00", hard: false, penalty_per_15min: 7 } as never,
        }),
        makeTask("oneSlotEarly", {
          deadline: { at: "2026-05-17T23:45:00", hard: false, penalty_per_15min: 7 } as never,
        }),
        makeTask("none"),
        makeTask("hard", {
          deadline: { at: "2026-05-20T00:00:00", hard: true, penalty_per_15min: 0 } as never,
        }),
      ],
    });
    const baked = bakeProblem(p);
    expect(baked.tasks[0]!.deadlineSlot).toBe(-16);
    expect(baked.tasks[0]!.deadlineHard).toBe(false);
    expect(baked.tasks[0]!.hasSoftDeadline).toBe(true);
    expect(baked.tasks[0]!.deadlinePenaltyPer15).toBe(7);
    // the sentinel collision: slot -1 is a real deadline, not "no deadline"
    expect(baked.tasks[1]!.deadlineSlot).toBe(-1);
    expect(baked.tasks[1]!.hasSoftDeadline).toBe(true);
    // genuinely absent, and a hard deadline is never "soft"
    expect(baked.tasks[2]!.deadlineSlot).toBe(-1);
    expect(baked.tasks[2]!.hasSoftDeadline).toBe(false);
    expect(baked.tasks[3]!.hasSoftDeadline).toBe(false);
    expect(baked.tasks[3]!.deadlineHard).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// externals
// ---------------------------------------------------------------------------

describe("externals", () => {
  it("marks external occupancy in the mask", () => {
    const p = makeProblem({
      external_pinned: [
        { id: "ev", title: "ev", start: "2026-05-19T10:00:00", duration_minutes: 60, context: "meeting" },
      ] as never,
    });
    const baked = bakeProblem(p);
    const bit = (s: number) => (baked.externalMask[s >> 5]! >>> (s & 31)) & 1;
    expect(bit(slot(1, 10))).toBe(1);
    expect(bit(slot(1, 10, 45))).toBe(1);
    expect(bit(slot(1, 11))).toBe(0);
    expect(bit(slot(1, 9, 45))).toBe(0);
    expect(baked.externalOverlapCore).toBeNull();
  });

  it("returns the external_pinned core immediately on overlapping externals (no search)", () => {
    const baked = bakeProblem(externalOverlapFx as unknown as Problem);
    const core = baked.externalOverlapCore;
    expect(core).not.toBeNull();
    expect(core!.every((i) => i.type === "external_pinned")).toBe(true);
    expect(core!.map((i) => i.task_id).sort()).toEqual(["ext-a", "ext-b"]);
    expect(core!.map((i) => i.value)).toContain("2026-05-19T11:00:00");
  });
});

// ---------------------------------------------------------------------------
// golden cross-language fixtures (dump-domains.py is the source of truth)
// ---------------------------------------------------------------------------

type DomainDump = Record<
  string,
  { task_id: string; duration_slots: number; allowed_starts: number[]; cost: number[] }
>;

const GOLDENS: Array<[string, { problem: unknown }, DomainDump]> = [
  ["earliest_start-light", earliestStartFx as never, earliestStartDom as DomainDump],
  ["preferred_window_hard-light", hardWindowFx as never, hardWindowDom as DomainDump],
  ["availability_windows-light", availabilityFx as never, availabilityDom as DomainDump],
  ["business_hours-light", businessHoursFx as never, businessHoursDom as DomainDump],
  ["fit_curve-light", fitCurveFx as never, fitCurveDom as DomainDump],
  ["churn-light", churnFx as never, churnDom as DomainDump],
  ["pinned_at-light", pinnedAtFx as never, pinnedAtDom as DomainDump],
  ["preferred_window_soft-light", softWindowFx as never, softWindowDom as DomainDump],
];

describe("golden cross-language parity (dump-domains.py)", () => {
  for (const [name, fx, dump] of GOLDENS) {
    it(`byte-matches allowed_starts and cost for ${name}`, () => {
      const baked = bakeProblem(fx.problem as Problem);
      const dumped = Object.keys(dump).sort();
      expect(baked.chunks.length).toBe(dumped.length);
      for (const chunkId of dumped) {
        const exp = dump[chunkId]!;
        const c = chunk(baked, exp.task_id, chunkId);
        expect(c.durationSlots).toBe(exp.duration_slots);
        expect(Array.from(c.allowedStarts), `${name}/${chunkId} allowed_starts`).toEqual(
          exp.allowed_starts,
        );
        expect(Array.from(c.cost), `${name}/${chunkId} cost`).toEqual(exp.cost);
      }
    });
  }
});
