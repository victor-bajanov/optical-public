// Card B — pass-1 selection branch-and-bound tests. Semantics are pinned
// against the Python fast path (solver/src/solver/two_pass.py drop
// minimisation, fast_model.py hard constraints + capacity cuts,
// placements.py domains); the ported cases come from
// solver/tests/test_unplaceable_hard_task.py and test_must_include.py, and
// the bench-derived expectations from the committed reference run
// (fixtures/reference-light.json, bench/problems/*-light.json).

import { describe, expect, it } from "vitest";
import { bakeProblem } from "../../src/engine/substrate";
import { packFeasible, selectTasks } from "../../src/engine/pass1";
import type { Baked, Budget, Placement, Problem } from "../../src/engine/types";

import reference from "./fixtures/reference-light.json";

import pAvailabilityWindows from "../../../bench/problems/availability_windows-light.json";
import pBaseline from "../../../bench/problems/baseline-light.json";
import pBusinessHours from "../../../bench/problems/business_hours-light.json";
import pChurn from "../../../bench/problems/churn-light.json";
import pComboChunkedWorkflow from "../../../bench/problems/combo_chunked_workflow-light.json";
import pComboDeadlineWindow from "../../../bench/problems/combo_deadline_window-light.json";
import pComboKitchenSink from "../../../bench/problems/combo_kitchen_sink-light.json";
import pComboMeeting from "../../../bench/problems/combo_meeting-light.json";
import pComboOversubscribed from "../../../bench/problems/combo_oversubscribed-light.json";
import pComboReplan from "../../../bench/problems/combo_replan-light.json";
import pContextCaps from "../../../bench/problems/context_caps-light.json";
import pDeadlineHard from "../../../bench/problems/deadline_hard-light.json";
import pDeadlineSoft from "../../../bench/problems/deadline_soft-light.json";
import pDependencies from "../../../bench/problems/dependencies-light.json";
import pEarliestStart from "../../../bench/problems/earliest_start-light.json";
import pEdgeEmptyHardWindow from "../../../bench/problems/edge_empty_hard_window-light.json";
import pEdgeMustIncludeDemotion from "../../../bench/problems/edge_must_include_demotion-light.json";
import pEdgeSoftDependencyIgnored from "../../../bench/problems/edge_soft_dependency_ignored-light.json";
import pEdgeUnsatMustInclude from "../../../bench/problems/edge_unsat_must_include-light.json";
import pFitCurve from "../../../bench/problems/fit_curve-light.json";
import pGroupOrdered from "../../../bench/problems/group_ordered-light.json";
import pGroupSameDay from "../../../bench/problems/group_same_day-light.json";
import pMustInclude from "../../../bench/problems/must_include-light.json";
import pPinnedAt from "../../../bench/problems/pinned_at-light.json";
import pPreferredWindowHard from "../../../bench/problems/preferred_window_hard-light.json";
import pPreferredWindowSoft from "../../../bench/problems/preferred_window_soft-light.json";

import mAvailabilityWindows from "../../../bench/problems/availability_windows-medium.json";
import mBaseline from "../../../bench/problems/baseline-medium.json";
import mBusinessHours from "../../../bench/problems/business_hours-medium.json";
import mChurn from "../../../bench/problems/churn-medium.json";
import mComboChunkedWorkflow from "../../../bench/problems/combo_chunked_workflow-medium.json";
import mComboDeadlineWindow from "../../../bench/problems/combo_deadline_window-medium.json";
import mComboKitchenSink from "../../../bench/problems/combo_kitchen_sink-medium.json";
import mComboMeeting from "../../../bench/problems/combo_meeting-medium.json";
import mComboOversubscribed from "../../../bench/problems/combo_oversubscribed-medium.json";
import mComboReplan from "../../../bench/problems/combo_replan-medium.json";
import mContextCaps from "../../../bench/problems/context_caps-medium.json";
import mDeadlineHard from "../../../bench/problems/deadline_hard-medium.json";
import mDeadlineSoft from "../../../bench/problems/deadline_soft-medium.json";
import mDependencies from "../../../bench/problems/dependencies-medium.json";
import mEarliestStart from "../../../bench/problems/earliest_start-medium.json";
import mFitCurve from "../../../bench/problems/fit_curve-medium.json";
import mGroupOrdered from "../../../bench/problems/group_ordered-medium.json";
import mGroupSameDay from "../../../bench/problems/group_same_day-medium.json";
import mMustInclude from "../../../bench/problems/must_include-medium.json";
import mPinnedAt from "../../../bench/problems/pinned_at-medium.json";
import mPreferredWindowHard from "../../../bench/problems/preferred_window_hard-medium.json";
import mPreferredWindowSoft from "../../../bench/problems/preferred_window_soft-medium.json";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const WINDOW = {
  start: "2026-05-18T00:00:00", // a Monday
  end: "2026-05-25T00:00:00",
  tz: "UTC",
};
const SLOTS_PER_DAY = 96;

const UNBOUNDED: Budget = { wallMs: Infinity, nodeCap: Infinity };

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

function bake(over: Partial<Problem> = {}): Baked {
  return bakeProblem(makeProblem(over));
}

function ids(baked: Baked, indices: readonly number[]): string[] {
  return indices.map((i) => baked.tasks[i]!.id).sort();
}

function dropCost(baked: Baked, dropped: readonly number[]): number {
  let total = 0;
  for (const i of dropped) total += baked.tasks[i]!.dropWeight;
  return total;
}

/** Independent hard-constraint checker for a witness placement: domains,
 * externals + mutual occupancy, group policy, hard dependencies. Deliberately
 * re-derived from the Python semantics rather than sharing engine code. */
function assertLegalPlacement(
  baked: Baked,
  kept: readonly number[],
  placement: Placement,
): void {
  const inSet = new Set(kept);
  const occupied = new Map<number, string>();
  for (let s = 0; s < baked.horizon; s++) {
    if ((baked.externalMask[s >> 5]! >>> (s & 31)) & 1) occupied.set(s, "external");
  }

  for (const chunk of baked.chunks) {
    const start = placement[chunk.index]!;
    if (!inSet.has(chunk.taskIndex)) {
      expect(start, `chunk ${chunk.chunkId} of a non-kept task must be -1`).toBe(-1);
      continue;
    }
    expect(
      Array.from(chunk.allowedStarts).includes(start),
      `chunk ${chunk.chunkId} start ${start} outside its baked domain`,
    ).toBe(true);
    for (let s = start; s < start + chunk.durationSlots; s++) {
      expect(occupied.has(s), `slot ${s} double-booked by ${chunk.chunkId}`).toBe(false);
      occupied.set(s, chunk.chunkId);
    }
  }

  for (const task of baked.tasks) {
    if (!inSet.has(task.index) || task.chunkIndices.length === 0) continue;
    const starts = task.chunkIndices.map((c) => placement[c]!);
    if (task.sameDay) {
      const days = starts.map((s) => Math.floor(s / SLOTS_PER_DAY));
      expect(new Set(days).size, `${task.id} same_day violated`).toBe(1);
    }
    if (task.ordered) {
      for (let i = 1; i < task.chunkIndices.length; i++) {
        const prev = baked.chunks[task.chunkIndices[i - 1]!]!;
        expect(placement[prev.index]! + prev.durationSlots).toBeLessThanOrEqual(starts[i]!);
      }
    }
    const first = baked.chunks[task.chunkIndices[0]!]!;
    const last = baked.chunks[task.chunkIndices[task.chunkIndices.length - 1]!]!;
    const firstStart = placement[first.index]!;
    const lastEnd = placement[last.index]! + last.durationSlots;
    for (const dep of task.deps) {
      if (dep.type === "after_event") {
        expect(firstStart, `${task.id} after_event`).toBeGreaterThanOrEqual(dep.eventEndSlot);
      } else if (dep.type === "before_event") {
        expect(lastEnd, `${task.id} before_event`).toBeLessThanOrEqual(dep.eventStartSlot);
      } else {
        const other = baked.tasks[dep.taskIndex]!;
        if (!inSet.has(other.index) || other.chunkIndices.length === 0) continue;
        const otherFirst = baked.chunks[other.chunkIndices[0]!]!;
        const otherLast = baked.chunks[other.chunkIndices[other.chunkIndices.length - 1]!]!;
        const otherFirstStart = placement[otherFirst.index]!;
        const otherLastEnd = placement[otherLast.index]! + otherLast.durationSlots;
        if (dep.type === "after_task") {
          expect(firstStart, `${task.id} after_task ${other.id}`).toBeGreaterThanOrEqual(
            otherLastEnd,
          );
        } else {
          expect(lastEnd, `${task.id} before_task ${other.id}`).toBeLessThanOrEqual(
            otherFirstStart,
          );
        }
      }
    }
  }
}

/** Every pass-1 result must partition the task set, carry a witness exactly
 * when its seed pack reached a verdict, and — when not infeasible — carry a
 * genuinely packable kept set. */
function assertPartition(baked: Baked, result: ReturnType<typeof selectTasks>): void {
  const all = baked.tasks.map((t) => t.index);
  expect([...result.kept].sort((a, b) => a - b)).toEqual(result.kept);
  expect([...result.dropped].sort((a, b) => a - b)).toEqual(result.dropped);
  expect([...result.kept, ...result.dropped].sort((a, b) => a - b)).toEqual(all);

  // The witness is the incumbent's own placement: present whenever an
  // incumbent was verified, absent only where none exists.
  if (result.seedDecided) {
    expect(result.witness, "a decided pass 1 must carry its witness").not.toBeNull();
    assertLegalPlacement(baked, result.kept, result.witness!);
    for (const t of result.kept) {
      for (const c of baked.tasks[t]!.chunkIndices) {
        expect(result.witness![c], `chunk ${c} of kept task ${t} unplaced`).toBeGreaterThanOrEqual(0);
      }
    }
  } else {
    expect(result.witness, "an undecided seed has no verified incumbent").toBeNull();
  }

  if (!result.infeasible) {
    const witness = packFeasible(baked, result.kept);
    expect(witness, "kept set must be packable").not.toBeNull();
    assertLegalPlacement(baked, result.kept, witness!);
  }
}

// ---------------------------------------------------------------------------
// 1. everything fits — closed at the root, prod shape
// ---------------------------------------------------------------------------

describe("selectTasks — everything fits", () => {
  it("keeps every task, proves it, and closes at the root", () => {
    const baked = bake({ tasks: [makeTask("a"), makeTask("b"), makeTask("c")] });
    const result = selectTasks(baked, UNBOUNDED);

    expect(result.kept).toEqual([0, 1, 2]);
    expect(result.dropped).toEqual([]);
    expect(result.proved).toBe(true);
    expect(result.infeasible).toBe(false);
    // One node per keep decision plus the leaf: the greedy first descent is the
    // incumbent at drop cost 0, so every drop branch is bound-pruned unentered.
    expect(result.nodes).toBe(4);
    assertPartition(baked, result);
  });

  it("returns a legal witness placement from packFeasible", () => {
    const baked = bake({
      tasks: [makeTask("a"), makeTask("b")],
      external_pinned: [
        {
          id: "ev",
          title: "ev",
          start: "2026-05-18T09:00:00",
          duration_minutes: 120,
          context: "meeting",
        },
      ] as never,
    });
    const witness = packFeasible(baked, [0, 1]);
    expect(witness).not.toBeNull();
    assertLegalPlacement(baked, [0, 1], witness!);
  });

  it("packs the empty set trivially", () => {
    const baked = bake({ tasks: [makeTask("a")] });
    const witness = packFeasible(baked, []);
    expect(witness).not.toBeNull();
    expect(Array.from(witness!)).toEqual([-1]);
  });

  it("is deterministic across repeated runs", () => {
    const baked = bake({
      tasks: [makeTask("a"), makeTask("b", { priority: 10 }), makeTask("c", { priority: 90 })],
    });
    const first = selectTasks(baked, UNBOUNDED);
    const second = selectTasks(baked, UNBOUNDED);
    expect(second).toEqual(first);
    expect(Array.from(packFeasible(baked, [0, 1, 2])!)).toEqual(
      Array.from(packFeasible(baked, [0, 1, 2])!),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. drop economics — capacity for one keeps the higher drop weight
// ---------------------------------------------------------------------------

describe("selectTasks — drop economics", () => {
  const HARD_DEADLINE = {
    at: "2026-05-18T10:00:00",
    hard: true,
    penalty_per_15min: 0,
  } as never;

  function singleSlotPair(order: "hi-first" | "lo-first"): Baked {
    const hi = makeTask("hi", {
      priority: 50,
      earliest_start: "2026-05-18T09:00:00" as never,
      deadline: HARD_DEADLINE,
    });
    const lo = makeTask("lo", {
      priority: 10,
      earliest_start: "2026-05-18T09:00:00" as never,
      deadline: HARD_DEADLINE,
    });
    return bake({ tasks: order === "hi-first" ? [hi, lo] : [lo, hi] });
  }

  it("drops the lower drop-weight task when only one fits, and proves it", () => {
    const baked = singleSlotPair("hi-first");
    const result = selectTasks(baked, UNBOUNDED);

    expect(ids(baked, result.kept)).toEqual(["hi"]);
    expect(ids(baked, result.dropped)).toEqual(["lo"]);
    expect(dropCost(baked, result.dropped)).toBe(210);
    expect(result.proved).toBe(true);
    expect(result.infeasible).toBe(false);
    assertPartition(baked, result);
  });

  it("branches on drop weight, not on input order", () => {
    const baked = singleSlotPair("lo-first");
    const result = selectTasks(baked, UNBOUNDED);
    expect(ids(baked, result.kept)).toEqual(["hi"]);
    expect(ids(baked, result.dropped)).toEqual(["lo"]);
    expect(result.proved).toBe(true);
  });

  it("uses business-hours band capacity to drop the two cheapest (capacity cut)", () => {
    // Business hours mon–fri 09:00–17:00 give 32 free slots on the Monday; all
    // three tasks are 8 h and hard-deadlined to Monday midnight, so exactly one
    // survives. Mirrors fast_model._add_capacity_cut's band arithmetic.
    const deadline = {
      at: "2026-05-19T00:00:00",
      hard: true,
      penalty_per_15min: 0,
    } as never;
    const task = (id: string, priority: number) =>
      makeTask(id, {
        priority,
        deadline,
        chunks: [{ chunk_id: `${id}#0`, duration_minutes: 480 }],
      });
    const baked = bake({
      business_hours: { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
      tasks: [task("cheap", 10), task("mid", 50), task("dear", 90)],
    });

    const result = selectTasks(baked, UNBOUNDED);
    expect(ids(baked, result.kept)).toEqual(["dear"]);
    expect(ids(baked, result.dropped)).toEqual(["cheap", "mid"]);
    expect(dropCost(baked, result.dropped)).toBe(210 + 250);
    expect(result.proved).toBe(true);
    // The band, not the packer, is what settles this. Keeping a second 8 h
    // task blows the 32-slot Monday capacity, so both keep branches below the
    // first are refused without ever packing, and the one alternative the tree
    // opens — dropping "dear" — is priced out by the band's own lower bound.
    // Five nodes: the descent to the leaf, plus that pruned alternative.
    expect(result.nodes).toBe(5);
    assertPartition(baked, result);
  });
});

// ---------------------------------------------------------------------------
// 2b. capacity bands must see every restriction the baked domains carry, not
//     just earliest_start and the hard deadline
// ---------------------------------------------------------------------------

/** `n` hour-long tasks sharing one 7 h Monday availability window: seven fit,
 * the rest have to go. No deadline, no business hours — the crowding is
 * visible ONLY through the baked domains. */
function availabilityCrowd(n: number, mustInclude = false): Baked {
  const availability = [
    { start: "2026-05-18T09:00:00", end: "2026-05-18T16:00:00" },
  ] as never;
  const tasks = [];
  for (let i = 0; i < n; i++) {
    tasks.push(
      makeTask(`t${i}`, {
        priority: 10 + i,
        availability_windows: availability,
        must_include: mustInclude,
      }),
    );
  }
  return bake({ tasks });
}

describe("selectTasks — capacity bands span the baked domains", () => {
  it("certifies availability-window crowding that carries no deadline", () => {
    const baked = availabilityCrowd(8); // 8 h of work into a 7 h window
    const result = selectTasks(baked, UNBOUNDED);

    expect(result.proved).toBe(true);
    expect(ids(baked, result.dropped)).toEqual(["t0"]); // the cheapest
    expect(result.nodes).toBeLessThanOrEqual(16);
    assertPartition(baked, result);
  });

  it("refutes an over-full availability window by arithmetic, not by search", () => {
    // The band has to settle this: enumerating the placements to prove the set
    // does not pack is the case that ran for 81 s.
    const baked = availabilityCrowd(10);
    expect(packFeasible(baked, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).toBeNull();
    expect(packFeasible(baked, [0, 1, 2, 3, 4, 5, 6])).not.toBeNull();
  });

  it("certifies hard-window crowding the same way", () => {
    const win = [{ days: ["mon"], start: "09:00", end: "13:00", hard: true }] as never;
    const tasks = [];
    for (let i = 0; i < 6; i++) {
      tasks.push(makeTask(`w${i}`, { priority: 10 + i, preferred_windows: win }));
    }
    const baked = bake({ tasks });
    const result = selectTasks(baked, UNBOUNDED);

    expect(result.proved).toBe(true);
    expect(ids(baked, result.dropped)).toEqual(["w0", "w1"]); // 4 h holds four
    assertPartition(baked, result);
  });

  it("certifies pin crowding the same way", () => {
    const pin = "2026-05-19T11:00:00" as never;
    const baked = bake({
      tasks: [
        makeTask("pin-a", { priority: 10, pinned_at: pin }),
        makeTask("pin-b", { priority: 90, pinned_at: pin }),
      ],
    });
    const result = selectTasks(baked, UNBOUNDED);
    expect(result.proved).toBe(true);
    expect(ids(baked, result.dropped)).toEqual(["pin-a"]);
    assertPartition(baked, result);
  });
});

// ---------------------------------------------------------------------------
// 3. hardness ⊥ droppability (ported from test_unplaceable_hard_task.py)
// ---------------------------------------------------------------------------

describe("selectTasks — hardness is orthogonal to droppability", () => {
  const narrow = () =>
    makeTask("narrow", {
      preferred_windows: [{ days: ["thu"], start: "12:00", end: "12:30", hard: true }] as never,
    });

  it("drops a task whose hard preferred window can never hold its chunk", () => {
    const baked = bake({ tasks: [narrow()] });
    const result = selectTasks(baked, UNBOUNDED);
    expect(ids(baked, result.dropped)).toEqual(["narrow"]);
    expect(result.infeasible).toBe(false);
    expect(result.proved).toBe(true);
    assertPartition(baked, result);
  });

  it("does not nuke a placeable neighbour", () => {
    const baked = bake({ tasks: [narrow(), makeTask("fine")] });
    const result = selectTasks(baked, UNBOUNDED);
    expect(ids(baked, result.dropped)).toEqual(["narrow"]);
    expect(ids(baked, result.kept)).toEqual(["fine"]);
    expect(result.infeasible).toBe(false);
    assertPartition(baked, result);
  });

  it("drops an earliest_start past the window and keeps a hard-deadline sibling", () => {
    const baked = bake({
      tasks: [
        makeTask("good", {
          deadline: { at: "2026-05-25T00:00:00", hard: true, penalty_per_15min: 0 } as never,
        }),
        makeTask("late", { earliest_start: "2026-05-26T00:00:00" as never }),
      ],
    });
    const result = selectTasks(baked, UNBOUNDED);
    expect(ids(baked, result.dropped)).toEqual(["late"]);
    expect(ids(baked, result.kept)).toEqual(["good"]);
    assertPartition(baked, result);
  });

  it("drops a hard deadline that precedes the window", () => {
    const baked = bake({
      tasks: [
        makeTask("early-dl", {
          deadline: { at: "2026-05-17T00:00:00", hard: true, penalty_per_15min: 0 } as never,
        }),
      ],
    });
    const result = selectTasks(baked, UNBOUNDED);
    expect(ids(baked, result.dropped)).toEqual(["early-dl"]);
    expect(result.infeasible).toBe(false);
  });

  it("drops a feasible band shorter than the chunk", () => {
    const baked = bake({
      tasks: [
        makeTask("tight", {
          earliest_start: "2026-05-18T16:00:00" as never,
          deadline: { at: "2026-05-18T17:00:00", hard: true, penalty_per_15min: 0 } as never,
          chunks: [{ chunk_id: "tight#0", duration_minutes: 90 }],
        }),
      ],
    });
    const result = selectTasks(baked, UNBOUNDED);
    expect(ids(baked, result.dropped)).toEqual(["tight"]);
    expect(result.infeasible).toBe(false);
  });

  it("treats an empty-domain chunk as droppable, never infeasible", () => {
    // chunk #1 needs 90 min inside a 60-min hard window: no legal start at all.
    const baked = bake({
      tasks: [
        makeTask("split", {
          preferred_windows: [{ days: ["mon"], start: "10:00", end: "11:00", hard: true }] as never,
          chunks: [
            { chunk_id: "split#0", duration_minutes: 60 },
            { chunk_id: "split#1", duration_minutes: 90 },
          ],
        }),
        makeTask("fine"),
      ],
    });
    expect(baked.chunks[1]!.allowedStarts.length).toBe(0);

    const result = selectTasks(baked, UNBOUNDED);
    expect(result.infeasible).toBe(false);
    expect(ids(baked, result.dropped)).toEqual(["split"]);
    expect(ids(baked, result.kept)).toEqual(["fine"]);
    expect(packFeasible(baked, [0])).toBeNull();
    assertPartition(baked, result);
  });

  it("drops exactly one of two contending hard-deadline tasks", () => {
    const deadline = {
      at: "2026-05-19T00:00:00",
      hard: true,
      penalty_per_15min: 0,
    } as never;
    const baked = bake({
      tasks: [
        makeTask("a", {
          priority: 90,
          deadline,
          chunks: [{ chunk_id: "a#0", duration_minutes: 1440 }],
        }),
        makeTask("b", {
          priority: 90,
          deadline,
          chunks: [{ chunk_id: "b#0", duration_minutes: 1440 }],
        }),
      ],
    });
    const result = selectTasks(baked, UNBOUNDED);
    expect(result.dropped.length).toBe(1);
    expect(result.infeasible).toBe(false);
    expect(result.proved).toBe(true);
    assertPartition(baked, result);
  });
});

// ---------------------------------------------------------------------------
// 4. must_include removes the drop branch (ported from test_must_include.py)
// ---------------------------------------------------------------------------

describe("selectTasks — must_include", () => {
  function narrowWindowPair(mustOnLowPriority: boolean): Baked {
    // A hard mon 10:00–11:00 window fits exactly one 60-min task.
    const win = [{ days: ["mon"], start: "10:00", end: "11:00", hard: true }] as never;
    return bake({
      tasks: [
        makeTask("soft", {
          priority: 99,
          earliest_start: "2026-05-18T10:00:00" as never,
          preferred_windows: win,
        }),
        makeTask("must", {
          priority: 10,
          earliest_start: "2026-05-18T10:00:00" as never,
          preferred_windows: win,
          must_include: mustOnLowPriority,
        }),
      ],
    });
  }

  it("keeps a mandatory task even when a dearer droppable task must go instead", () => {
    const baked = narrowWindowPair(true);
    const result = selectTasks(baked, UNBOUNDED);
    expect(ids(baked, result.kept)).toEqual(["must"]);
    expect(ids(baked, result.dropped)).toEqual(["soft"]);
    expect(result.infeasible).toBe(false);
    expect(result.proved).toBe(true);
    assertPartition(baked, result);
  });

  it("keeps the dearer task when nothing is mandatory", () => {
    const baked = narrowWindowPair(false);
    const result = selectTasks(baked, UNBOUNDED);
    expect(ids(baked, result.kept)).toEqual(["soft"]);
    expect(ids(baked, result.dropped)).toEqual(["must"]);
    expect(result.proved).toBe(true);
  });

  function collidingPins(mustInclude: boolean): Baked {
    const pin = (id: string) =>
      makeTask(id, {
        context: "meeting",
        priority: 90,
        pinned_at: "2026-05-19T11:00:00" as never,
        must_include: mustInclude,
      });
    return bakeProblem(
      makeProblem({
        contexts: [
          {
            context: "meeting",
            fit_curve: { peak_start: "10:00", peak_end: "11:00", falloff_end: "17:00" },
            max_minutes_per_day: null,
            max_contiguous_minutes: null,
            over_daily_cap_penalty_per_15min: 0,
            over_streak_cap_penalty_per_15min: 0,
          },
        ],
        tasks: [pin("pin-a"), pin("pin-b")],
      }),
    );
  }

  it("reports infeasible when two mandatory pins collide", () => {
    const baked = collidingPins(true);
    const result = selectTasks(baked, UNBOUNDED);
    expect(result.infeasible).toBe(true);
    expect(packFeasible(baked, [0, 1])).toBeNull();
    expect(packFeasible(baked, [0])).not.toBeNull();
    expect(packFeasible(baked, [1])).not.toBeNull();
    // The best-effort relaxed partition carries its own placement, so the MUS
    // layer's post-demotion result can be served without a re-pack.
    assertPartition(baked, result);
  });

  it("drops one instead when the same pins are droppable", () => {
    const baked = collidingPins(false);
    const result = selectTasks(baked, UNBOUNDED);
    expect(result.infeasible).toBe(false);
    expect(result.dropped.length).toBe(1);
    expect(result.proved).toBe(true);
    assertPartition(baked, result);
  });

  it("reports infeasible for a mandatory task pinned onto an external event", () => {
    // Demotion (must_include_unplaceable_in_isolation) is the MUS layer's job:
    // pass 1 only reports the conflict.
    const baked = bakeProblem(
      makeProblem({
        contexts: [
          {
            context: "meeting",
            fit_curve: { peak_start: "10:00", peak_end: "11:00", falloff_end: "17:00" },
            max_minutes_per_day: null,
            max_contiguous_minutes: null,
            over_daily_cap_penalty_per_15min: 0,
            over_streak_cap_penalty_per_15min: 0,
          },
        ],
        tasks: [
          makeTask("must-on-ext", {
            context: "meeting",
            priority: 90,
            pinned_at: "2026-05-19T11:00:00" as never,
            must_include: true,
          }),
        ],
        external_pinned: [
          {
            id: "ext-1",
            title: "Immovable",
            start: "2026-05-19T11:00:00",
            duration_minutes: 60,
            context: "meeting",
          },
        ] as never,
      }),
    );
    const result = selectTasks(baked, UNBOUNDED);
    expect(result.infeasible).toBe(true);
    expect(packFeasible(baked, [0])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hard constraints packFeasible must enforce standalone (the B→D seam)
// ---------------------------------------------------------------------------

describe("packFeasible — hard constraints in isolation", () => {
  it("enforces same_day across a task's chunks", () => {
    // Two 4 h chunks that only fit on one day together: the free Monday band is
    // 08:00–16:00, everything else is externally occupied.
    const baked = bake({
      tasks: [
        makeTask("pair", {
          group_policy: { same_day: true, ordered: false },
          chunks: [
            { chunk_id: "pair#0", duration_minutes: 240 },
            { chunk_id: "pair#1", duration_minutes: 240 },
          ],
        }),
      ],
    });
    const witness = packFeasible(baked, [0]);
    expect(witness).not.toBeNull();
    assertLegalPlacement(baked, [0], witness!);
    expect(Math.floor(witness![0]! / SLOTS_PER_DAY)).toBe(
      Math.floor(witness![1]! / SLOTS_PER_DAY),
    );
  });

  it("enforces ordered chunk sequencing", () => {
    const baked = bake({
      tasks: [
        makeTask("seq", {
          group_policy: { same_day: false, ordered: true },
          chunks: [
            { chunk_id: "seq#0", duration_minutes: 60 },
            { chunk_id: "seq#1", duration_minutes: 60 },
          ],
        }),
      ],
    });
    const witness = packFeasible(baked, [0]);
    expect(witness).not.toBeNull();
    expect(witness![0]! + 4).toBeLessThanOrEqual(witness![1]!);
    assertLegalPlacement(baked, [0], witness!);
  });

  it("enforces hard after_task dependencies and ignores soft ones", () => {
    const baked = bake({
      tasks: [
        makeTask("first"),
        makeTask("second", {
          dependencies: [{ type: "after_task", ref: "first", hard: true }] as never,
        }),
      ],
    });
    const witness = packFeasible(baked, [0, 1])!;
    expect(witness).not.toBeNull();
    expect(witness[1]!).toBeGreaterThanOrEqual(witness[0]! + 4);
    assertLegalPlacement(baked, [0, 1], witness);

    const soft = bake({
      tasks: [
        makeTask("first"),
        makeTask("second", {
          dependencies: [{ type: "after_task", ref: "first", hard: false }] as never,
        }),
      ],
    });
    expect(soft.tasks[1]!.deps.length).toBe(0);
  });

  it("drops a dependency whose other endpoint is not in the set", () => {
    const baked = bake({
      tasks: [
        makeTask("first", {
          earliest_start: "2026-05-24T22:00:00" as never,
        }),
        makeTask("second", {
          deadline: { at: "2026-05-18T12:00:00", hard: true, penalty_per_15min: 0 } as never,
          dependencies: [{ type: "after_task", ref: "first", hard: true }] as never,
        }),
      ],
    });
    // Together the dependency is unsatisfiable; alone "second" packs fine.
    expect(packFeasible(baked, [0, 1])).toBeNull();
    expect(packFeasible(baked, [1])).not.toBeNull();
  });

  it("enforces hard event dependencies", () => {
    const baked = bake({
      tasks: [
        makeTask("after-ev", {
          dependencies: [{ type: "after_event", ref: "ev", hard: true }] as never,
        }),
      ],
      external_pinned: [
        {
          id: "ev",
          title: "ev",
          start: "2026-05-20T09:00:00",
          duration_minutes: 60,
          context: "meeting",
        },
      ] as never,
    });
    const witness = packFeasible(baked, [0])!;
    expect(witness).not.toBeNull();
    expect(witness[0]!).toBeGreaterThanOrEqual(slot(2, 10));
    assertLegalPlacement(baked, [0], witness);
  });

  it("treats a single-chunk self-dependency as unplaceable", () => {
    // `start >= start + duration` has no solution. Python builds exactly that
    // constraint and the model goes UNSAT for the task; silently ignoring the
    // degenerate edge would hand back a witness the reference rejects.
    for (const type of ["after_task", "before_task"] as const) {
      const baked = bake({
        tasks: [
          makeTask("loop", { dependencies: [{ type, ref: "loop", hard: true }] as never }),
          makeTask("fine"),
        ],
      });
      expect(packFeasible(baked, [0]), type).toBeNull();
      const result = selectTasks(baked, UNBOUNDED);
      expect(ids(baked, result.dropped), type).toEqual(["loop"]);
      expect(ids(baked, result.kept), type).toEqual(["fine"]);
      expect(result.infeasible, type).toBe(false);
    }
  });

  it("keeps a multi-chunk self-dependency packable", () => {
    // Two chunks, unordered: `first >= last + dur(last)` is satisfiable by
    // running the chunks in the other order, and Python agrees. The
    // single-chunk fix must not swallow this one.
    const baked = bake({
      tasks: [
        makeTask("pair", {
          chunks: [
            { chunk_id: "pair#0", duration_minutes: 60 },
            { chunk_id: "pair#1", duration_minutes: 60 },
          ],
          dependencies: [{ type: "after_task", ref: "pair", hard: true }] as never,
        }),
      ],
    });
    const witness = packFeasible(baked, [0]);
    expect(witness).not.toBeNull();
    expect(witness![0]!).toBeGreaterThanOrEqual(witness![1]! + 4);
  });

  it("still enforces an event dependency on a one-task set", () => {
    // The B→D seam's sharp edge: two_pass._isolation_feasible strips
    // dependencies before checking a task alone, so the Python would call this
    // task placeable in isolation. packFeasible does not strip anything — an
    // isolation check that wants the Python's answer must re-bake a
    // dependency-stripped problem.
    const baked = bake({
      tasks: [
        makeTask("blocked", {
          deadline: { at: "2026-05-18T12:00:00", hard: true, penalty_per_15min: 0 } as never,
          dependencies: [{ type: "after_event", ref: "ev", hard: true }] as never,
        }),
      ],
      external_pinned: [
        {
          id: "ev",
          title: "ev",
          start: "2026-05-20T09:00:00",
          duration_minutes: 60,
          context: "meeting",
        },
      ] as never,
    });
    expect(baked.chunks[0]!.allowedStarts.length).toBeGreaterThan(0);
    expect(packFeasible(baked, [0])).toBeNull();
  });

  it("refuses a set whose only starts collide with externals", () => {
    const baked = bake({
      tasks: [
        makeTask("pinned", { pinned_at: "2026-05-19T11:00:00" as never }),
      ],
      external_pinned: [
        {
          id: "ev",
          title: "ev",
          start: "2026-05-19T11:00:00",
          duration_minutes: 60,
          context: "meeting",
        },
      ] as never,
    });
    expect(packFeasible(baked, [0])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. budget exhaustion — honest incumbent, proved: false
// ---------------------------------------------------------------------------

describe("selectTasks — budgets", () => {
  /** Adversarial shape: many equal-weight tasks contending for one narrow band,
   * so the selection tree is wide and the bound cannot close early. */
  function adversarial(n: number): Baked {
    const tasks = [];
    for (let i = 0; i < n; i++) {
      tasks.push(
        makeTask(`t${i}`, {
          priority: 50 + (i % 3),
          earliest_start: "2026-05-18T09:00:00" as never,
          deadline: { at: "2026-05-18T13:00:00", hard: true, penalty_per_15min: 0 } as never,
          chunks: [{ chunk_id: `t${i}#0`, duration_minutes: 60 }],
        }),
      );
    }
    return bake({ tasks });
  }

  it("returns a valid incumbent with proved: false when the node cap trips", () => {
    const baked = adversarial(16);
    const result = selectTasks(baked, { wallMs: Infinity, nodeCap: 5 });

    expect(result.proved).toBe(false);
    expect(result.infeasible).toBe(false);
    expect(result.nodes).toBeLessThanOrEqual(6);
    assertPartition(baked, result);
  });

  it("returns a valid incumbent with proved: false when the wall clock trips", () => {
    // The clock is sampled, not read per node, so the instance has to be one
    // that actually burns nodes; `fragmented` does, and the second reading is
    // already past the deadline.
    const baked = fragmented(10, false);
    let reading = 0;
    const result = selectTasks(baked, {
      wallMs: 3,
      nodeCap: Infinity,
      now: () => (reading++ === 0 ? 0 : 1_000_000),
    });

    expect(result.proved).toBe(false);
    expect(result.infeasible).toBe(false);
    assertPartition(baked, result);
  });

  it("proves the same instance optimal when unbudgeted", () => {
    const baked = adversarial(16);
    const result = selectTasks(baked, UNBOUNDED);
    expect(result.proved).toBe(true);
    // Four 60-min slots in the band, so twelve of the sixteen tasks drop.
    expect(result.kept.length).toBe(4);
    assertPartition(baked, result);
  });

  /** Nine one-hour windows scattered Mon–Fri. The domain envelope spans four
   * days, so every capacity band sees hundreds of free slots and none of them
   * binds — but only nine hours are truly usable, and `n` > 9 tasks can only be
   * refuted by enumerating placements. This is the shape that reaches the
   * per-check node ceiling. */
  function fragmented(n: number, mustInclude: boolean): Baked {
    const availability = [];
    for (const day of ["18", "19", "20", "21"]) {
      availability.push({ start: `2026-05-${day}T09:00:00`, end: `2026-05-${day}T10:00:00` });
      availability.push({ start: `2026-05-${day}T14:00:00`, end: `2026-05-${day}T15:00:00` });
    }
    availability.push({ start: "2026-05-22T09:00:00", end: "2026-05-22T10:00:00" });
    const tasks = [];
    for (let i = 0; i < n; i++) {
      tasks.push(
        makeTask(`f${i}`, {
          priority: 10 + i,
          availability_windows: availability as never,
          must_include: mustInclude,
        }),
      );
    }
    return bake({ tasks });
  }

  it("gives up the certificate, not correctness, when a feasibility check is abandoned", () => {
    const baked = fragmented(10, false);
    const result = selectTasks(baked, UNBOUNDED);

    // Ten hours of work into nine usable hours: one task has to go, and the
    // check that would have proved it exceeded the per-check node ceiling.
    expect(result.proved).toBe(false);
    expect(result.infeasible).toBe(false);
    expect(result.dropped.length).toBe(1);
    assertPartition(baked, result); // the kept set still packs
    // The seed pack (empty must set) decided instantly: the uncertified
    // partition is real, and callers may skip re-verification.
    expect(result.seedDecided).toBe(true);
  });

  it("carries the seed pack's own placement when the search stops at node 0", () => {
    // The seed pack decides (the must_include set packs), then the node cap
    // trips before the first selection node can improve on it. The incumbent
    // is the seed partition, and the witness has to be the placement that
    // pack found — there is no leaf to capture one from.
    const baked = bake({
      tasks: [
        makeTask("m0", { must_include: true }),
        makeTask("m1", { must_include: true }),
        makeTask("m2", { must_include: true }),
        makeTask("free"),
      ],
    });
    const result = selectTasks(baked, { wallMs: Infinity, nodeCap: 3 });

    expect(result.seedDecided).toBe(true);
    expect(result.proved).toBe(false);
    expect(ids(baked, result.kept)).toEqual(["m0", "m1", "m2"]);
    expect(result.witness).not.toBeNull();
    assertPartition(baked, result);
  });

  it("returns an UNVERIFIED candidate when the must_include seed pack is abandoned", () => {
    // Ten mandatory tasks into nine usable hours. The seed pack cannot decide
    // feasibility inside its ceiling, so `infeasible` stays false and the
    // must_include set comes back as a CANDIDATE ONLY — it does not pack, and
    // callers (mus.ts) must re-verify rather than plan on it.
    const baked = fragmented(10, true);
    const result = selectTasks(baked, UNBOUNDED);

    expect(result.infeasible).toBe(false);
    expect(result.proved).toBe(false);
    expect(result.kept).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.dropped).toEqual([]);
    // The abandoned pack's work is reported, not hidden behind nodes: 0.
    expect(result.nodes).toBeGreaterThan(1000);
    // No verified incumbent exists on this path, so there is no witness to
    // hand on — the null is what stops a caller serving an unpacked set.
    expect(result.witness).toBeNull();
    // ... and the abandonment is named: feasibility of the must set is
    // UNDECIDED, which is what obliges callers to re-verify.
    expect(result.seedDecided).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. bench-derived: drop cost equals the committed reference run's drop
// ---------------------------------------------------------------------------

type ReferenceRecord = {
  status: string;
  kept?: string[];
  dropped?: string[];
  drop_reasons?: Record<string, string>;
  objective_components: { drop: number } | null;
};

const REFERENCE = reference as unknown as Record<string, ReferenceRecord>;

const BENCH: Array<[string, { problem: unknown }]> = [
  ["availability_windows-light", pAvailabilityWindows as never],
  ["baseline-light", pBaseline as never],
  ["business_hours-light", pBusinessHours as never],
  ["churn-light", pChurn as never],
  ["combo_chunked_workflow-light", pComboChunkedWorkflow as never],
  ["combo_deadline_window-light", pComboDeadlineWindow as never],
  ["combo_kitchen_sink-light", pComboKitchenSink as never],
  ["combo_meeting-light", pComboMeeting as never],
  ["combo_oversubscribed-light", pComboOversubscribed as never],
  ["combo_replan-light", pComboReplan as never],
  ["context_caps-light", pContextCaps as never],
  ["deadline_hard-light", pDeadlineHard as never],
  ["deadline_soft-light", pDeadlineSoft as never],
  ["dependencies-light", pDependencies as never],
  ["earliest_start-light", pEarliestStart as never],
  ["edge_empty_hard_window-light", pEdgeEmptyHardWindow as never],
  ["edge_must_include_demotion-light", pEdgeMustIncludeDemotion as never],
  ["edge_soft_dependency_ignored-light", pEdgeSoftDependencyIgnored as never],
  ["edge_unsat_must_include-light", pEdgeUnsatMustInclude as never],
  ["fit_curve-light", pFitCurve as never],
  ["group_ordered-light", pGroupOrdered as never],
  ["group_same_day-light", pGroupSameDay as never],
  ["must_include-light", pMustInclude as never],
  ["pinned_at-light", pPinnedAt as never],
  ["preferred_window_hard-light", pPreferredWindowHard as never],
  ["preferred_window_soft-light", pPreferredWindowSoft as never],
];

describe("selectTasks — bench light tier vs the committed reference run", () => {
  it("covers every light problem in the reference run", () => {
    expect(BENCH.map(([name]) => name).sort()).toEqual(Object.keys(REFERENCE).sort());
  });

  for (const [name, fixture] of BENCH) {
    const record = REFERENCE[name]!;
    const demoted = Object.values(record.drop_reasons ?? {}).includes(
      "must_include_unplaceable_in_isolation",
    );

    if (record.status !== "OPTIMAL" || demoted) {
      // UNSAT and demotion problems are exactly the cases pass 1 alone cannot
      // resolve: the drop branch of a must_include task is removed, so the
      // conflict surfaces as infeasible and the MUS layer takes over.
      it(`reports infeasible for ${name} (${demoted ? "demotion" : record.status})`, () => {
        const baked = bakeProblem((fixture as { problem: Problem }).problem);
        const result = selectTasks(baked, UNBOUNDED);
        expect(result.infeasible).toBe(true);
      });
      continue;
    }

    it(`matches the reference drop cost for ${name}`, () => {
      const baked = bakeProblem((fixture as { problem: Problem }).problem);
      const result = selectTasks(baked, UNBOUNDED);

      expect(result.infeasible).toBe(false);
      expect(result.proved).toBe(true);
      expect(dropCost(baked, result.dropped)).toBe(record.objective_components!.drop);
      assertPartition(baked, result);
    });
  }
});

// ---------------------------------------------------------------------------
// 7. bench medium tier: the drop-economics regression net. The reference-light
//    drop-equality check above is nearly vacuous (23 of 25 OPTIMAL entries drop
//    nothing), so the certificates and partition invariants are pinned here,
//    at 35 tasks, where combo_oversubscribed is a real oversubscription.
// ---------------------------------------------------------------------------

const MEDIUM: Array<[string, { problem: unknown }]> = [
  ["availability_windows-medium", mAvailabilityWindows as never],
  ["baseline-medium", mBaseline as never],
  ["business_hours-medium", mBusinessHours as never],
  ["churn-medium", mChurn as never],
  ["combo_chunked_workflow-medium", mComboChunkedWorkflow as never],
  ["combo_deadline_window-medium", mComboDeadlineWindow as never],
  ["combo_kitchen_sink-medium", mComboKitchenSink as never],
  ["combo_meeting-medium", mComboMeeting as never],
  ["combo_oversubscribed-medium", mComboOversubscribed as never],
  ["combo_replan-medium", mComboReplan as never],
  ["context_caps-medium", mContextCaps as never],
  ["deadline_hard-medium", mDeadlineHard as never],
  ["deadline_soft-medium", mDeadlineSoft as never],
  ["dependencies-medium", mDependencies as never],
  ["earliest_start-medium", mEarliestStart as never],
  ["fit_curve-medium", mFitCurve as never],
  ["group_ordered-medium", mGroupOrdered as never],
  ["group_same_day-medium", mGroupSameDay as never],
  ["must_include-medium", mMustInclude as never],
  ["pinned_at-medium", mPinnedAt as never],
  ["preferred_window_hard-medium", mPreferredWindowHard as never],
  ["preferred_window_soft-medium", mPreferredWindowSoft as never],
];

describe("selectTasks — bench medium tier certificates", () => {
  for (const [name, fixture] of MEDIUM) {
    it(`certifies ${name}`, () => {
      const baked = bakeProblem((fixture as { problem: Problem }).problem);
      const result = selectTasks(baked, UNBOUNDED);

      expect(result.infeasible).toBe(false);
      expect(result.proved).toBe(true);
      assertPartition(baked, result);
    });
  }

  it("holds the drop-economics answer on combo_oversubscribed-medium", () => {
    const baked = bakeProblem((mComboOversubscribed as unknown as { problem: Problem }).problem);
    const result = selectTasks(baked, UNBOUNDED);

    // The corpus's only genuine oversubscription: an optimum, so it must not
    // move — a bound bug shows up here as a cheaper "optimum" that is not one.
    expect(dropCost(baked, result.dropped)).toBe(5129);
    expect(result.proved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Card C — D2 interval Hall cuts wired into the selection search
//
// The cut is consulted in two places: the keep branch (the set-level
// question, before any DFS) and packSearch's entry (the same question with
// whatever is already placed charged against capacity). hall.test.ts pins the
// cut itself; what these pin is that wiring it changed no verdict and that the
// crowding it is meant to price is still refuted — including the shapes the
// existing capacity bands deliberately skip:
//
//   - a window whose only member is ONE task (`picked.length < 2` is not
//     emitted as a band), over-subscribed by that task's own chunks;
//   - a window that is only over-subscribed once a placement is committed in
//     it, which the static bands never see.
// ---------------------------------------------------------------------------

describe("selectTasks — interval Hall cuts", () => {
  /** One task, four 60-minute chunks, a single 2 h availability window: 16
   * slots of demand against 8. No capacity band covers it (a one-member
   * window is not emitted, and the global band has room), so this is the
   * crowding the Hall cut is there to price. */
  function overSubscribedByItsOwnChunks() {
    return bake({
      tasks: [
        makeTask("greedy", {
          chunks: [0, 1, 2, 3].map((i) => ({
            chunk_id: `greedy#${i}`,
            duration_minutes: 60,
          })),
          availability_windows: [
            {
              start: "2026-05-18T09:00:00" as Problem["tasks"][number]["earliest_start"],
              end: "2026-05-18T11:00:00" as Problem["tasks"][number]["earliest_start"],
            },
          ],
        }),
        makeTask("spare"),
      ],
    });
  }

  it("refuses a task whose own chunks over-subscribe its only window", () => {
    const baked = overSubscribedByItsOwnChunks();
    expect(packFeasible(baked, [0])).toBeNull();

    const result = selectTasks(baked, UNBOUNDED);
    expect(ids(baked, result.kept)).toEqual(["spare"]);
    expect(ids(baked, result.dropped)).toEqual(["greedy"]);
    expect(result.proved).toBe(true);
    expect(result.infeasible).toBe(false);
    assertPartition(baked, result);
  });

  it("still packs the same task once its window has room", () => {
    const baked = bake({
      tasks: [
        makeTask("greedy", {
          chunks: [0, 1].map((i) => ({ chunk_id: `greedy#${i}`, duration_minutes: 60 })),
          availability_windows: [
            {
              start: "2026-05-18T09:00:00" as Problem["tasks"][number]["earliest_start"],
              end: "2026-05-18T11:00:00" as Problem["tasks"][number]["earliest_start"],
            },
          ],
        }),
      ],
    });
    const result = selectTasks(baked, UNBOUNDED);
    expect(result.dropped).toEqual([]);
    expect(result.proved).toBe(true);
    assertPartition(baked, result);
  });

  it("prices a window that only overflows once something is committed in it", () => {
    // a and b fill the 09:00–11:00 window exactly; `wide` can sit there or in
    // the two hours after it. Every task is keepable, and the search has to
    // find the placement that leaves the window to a and b.
    const window = (from: string, to: string) => [
      {
        start: `2026-05-18T${from}:00` as Problem["tasks"][number]["earliest_start"],
        end: `2026-05-18T${to}:00` as Problem["tasks"][number]["earliest_start"],
      },
    ];
    const baked = bake({
      tasks: [
        makeTask("a", { availability_windows: window("09:00", "11:00") }),
        makeTask("b", { availability_windows: window("09:00", "11:00") }),
        makeTask("wide", { availability_windows: window("09:00", "13:00") }),
      ],
    });

    const result = selectTasks(baked, UNBOUNDED);
    expect(result.dropped).toEqual([]);
    expect(result.proved).toBe(true);
    assertPartition(baked, result);

    // One more task in the tight window and something has to give.
    const crowded = bake({
      tasks: [
        makeTask("a", { availability_windows: window("09:00", "11:00") }),
        makeTask("b", { availability_windows: window("09:00", "11:00") }),
        makeTask("c", { availability_windows: window("09:00", "11:00") }),
        makeTask("wide", { availability_windows: window("09:00", "13:00") }),
      ],
    });
    const tight = selectTasks(crowded, UNBOUNDED);
    expect(tight.dropped.length).toBe(1);
    expect(tight.proved).toBe(true);
    assertPartition(crowded, tight);
  });

  it("leaves a problem with no window structure alone", () => {
    // Every envelope is the horizon, so the only window IS the horizon and the
    // global capacity band already prices it: the index is not consulted and
    // the partition is the one pass 1 always produced.
    const baked = bake({ tasks: [makeTask("a"), makeTask("b"), makeTask("c")] });
    const result = selectTasks(baked, UNBOUNDED);
    expect(result.kept).toEqual([0, 1, 2]);
    expect(result.nodes).toBe(4);
    expect(result.proved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Card C (scope amendment) — deterministic pack-search strengthening
//
// Two changes, both measured on the class-B acceptance problems:
//
//   1. Branching order is drop weight PER OCCUPIED SLOT, descending — the
//      same fractional-knapsack ratio the capacity bands already use for
//      their bound. Pass 1 minimises Σ dropWeight subject to a shared
//      timeline, so a long task and a short one of equal weight are not
//      equally good to keep: the long one costs the week far more capacity.
//      Ordering by weight alone makes the greedy first descent keep the
//      expensive-per-slot tasks first and then fail to fit anything else.
//   2. A bounded keep-branch repair was measured alongside it and deliberately
//      not shipped — see the note above tryKeep in pass1.ts. The keep-branch
//      soundness cases it motivated are kept below, since they pin properties
//      the ordering change touches either way.
// ---------------------------------------------------------------------------

describe("selectTasks — branching order by drop weight per slot", () => {
  /** One 4 h task against four 1 h tasks, in a 4 h window. Dropping the big
   * one costs 300; dropping all four small ones costs 1000. Both orders find
   * the optimum eventually — but weight-first has to SEARCH for it, because
   * its greedy descent keeps the big task and then cannot fit the rest. */
  function bigVersusSmall() {
    const window = [
      {
        start: "2026-05-18T09:00:00" as Problem["tasks"][number]["earliest_start"],
        end: "2026-05-18T13:00:00" as Problem["tasks"][number]["earliest_start"],
      },
    ];
    const tasks = [
      makeTask("big", {
        priority: 100,
        chunks: [{ chunk_id: "big#0", duration_minutes: 240 }],
        availability_windows: window,
      }),
    ];
    for (let i = 0; i < 4; i++) {
      tasks.push(
        makeTask(`s${i}`, {
          priority: 50,
          chunks: [{ chunk_id: `s${i}#0`, duration_minutes: 60 }],
          availability_windows: window,
        }),
      );
    }
    return bake({ tasks });
  }

  it("makes the greedy first descent the optimum, not something to climb out of", () => {
    // A budget that stops the search before it can recover from a bad first
    // descent is what makes the ordering observable. Branching by weight alone
    // keeps `big` here and reports a drop cost of 1000; the per-slot ratio
    // keeps all four small tasks for 300, with the same budget and fewer nodes.
    const problem = bigVersusSmall();
    const budgeted = selectTasks(problem, { wallMs: Infinity, nodeCap: 12 });

    expect(ids(problem, budgeted.kept)).toEqual(["s0", "s1", "s2", "s3"]);
    expect(dropCost(problem, budgeted.dropped)).toBe(300);
    expect(budgeted.proved).toBe(false);
    assertPartition(problem, budgeted);
  });

  it("proves that partition optimal when the budget allows", () => {
    const problem = bigVersusSmall();
    const result = selectTasks(problem, UNBOUNDED);

    expect(ids(problem, result.kept)).toEqual(["s0", "s1", "s2", "s3"]);
    expect(ids(problem, result.dropped)).toEqual(["big"]);
    expect(dropCost(problem, result.dropped)).toBe(300);
    expect(result.proved).toBe(true);
    assertPartition(problem, result);
  });

  it("still finds the optimum when the ratio order is not the answer", () => {
    // Equal durations everywhere ⇒ the ratio order degenerates to the weight
    // order, and the highest-priority tasks are the ones to keep.
    const window = [
      {
        start: "2026-05-18T09:00:00" as Problem["tasks"][number]["earliest_start"],
        end: "2026-05-18T11:00:00" as Problem["tasks"][number]["earliest_start"],
      },
    ];
    const tasks = [1, 2, 3, 4].map((i) =>
      makeTask(`t${i}`, { priority: i * 10, availability_windows: window }),
    );
    const baked = bake({ tasks });
    const result = selectTasks(baked, UNBOUNDED);

    // Two of the four 60-minute tasks fit the 2 h window; the two highest
    // priorities survive.
    expect(ids(baked, result.kept)).toEqual(["t3", "t4"]);
    expect(result.proved).toBe(true);
    assertPartition(baked, result);
  });

  it("is deterministic across repeated solves", () => {
    const problem = bigVersusSmall();
    const a = selectTasks(problem, UNBOUNDED);
    const b = selectTasks(problem, UNBOUNDED);
    expect(a.kept).toEqual(b.kept);
    expect(a.nodes).toBe(b.nodes);
    expect(Array.from(a.witness!)).toEqual(Array.from(b.witness!));
  });
});

describe("selectTasks — keep-branch soundness under the new order", () => {
  /** The reordering changes which task is placed first, so the cases where an
   * early placement blocks a later one are the ones worth pinning: whatever
   * pass 1 keeps must still come back with a legal witness that packFeasible
   * independently agrees on. */
  it("produces a legal witness when a keep needs the week rearranged", () => {
    const day = (from: string, to: string) => [
      {
        start: `2026-05-18T${from}:00` as Problem["tasks"][number]["earliest_start"],
        end: `2026-05-18T${to}:00` as Problem["tasks"][number]["earliest_start"],
      },
    ];
    // `roomy` will be placed first and, left where the packer puts it, blocks
    // `tight`, which can only sit at 09:00–10:00.
    const baked = bake({
      tasks: [
        makeTask("roomy", { priority: 90, availability_windows: day("09:00", "12:00") }),
        makeTask("tight", { priority: 10, availability_windows: day("09:00", "10:00") }),
      ],
    });
    const result = selectTasks(baked, UNBOUNDED);
    expect(result.dropped).toEqual([]);
    expect(result.proved).toBe(true);
    assertPartition(baked, result);
  });

  it("agrees with packFeasible on every keep it makes", () => {
    const day = (from: string, to: string) => [
      {
        start: `2026-05-18T${from}:00` as Problem["tasks"][number]["earliest_start"],
        end: `2026-05-18T${to}:00` as Problem["tasks"][number]["earliest_start"],
      },
    ];
    const baked = bake({
      tasks: [
        makeTask("a", { priority: 90, availability_windows: day("09:00", "12:00") }),
        makeTask("b", { priority: 80, availability_windows: day("09:00", "11:00") }),
        makeTask("c", { priority: 70, availability_windows: day("09:00", "10:00") }),
        makeTask("d", { priority: 60, availability_windows: day("10:00", "11:00") }),
        makeTask("e", { priority: 50, availability_windows: day("09:00", "12:00") }),
      ],
    });
    const result = selectTasks(baked, UNBOUNDED);
    expect(result.proved).toBe(true);
    assertPartition(baked, result);
    expect(packFeasible(baked, result.kept)).not.toBeNull();
  });
});
