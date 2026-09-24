// Card C — pass-2 placement branch-and-bound tests.
//
// Semantics are pinned against the Python authority (solver/src/solver/
// objective.py for the cost arithmetic, fast_model.build_pass2_model for the
// hard constraints, two_pass._components_from_starts for the component
// recomposition). Every COUPLING penalty asserted here — lateness, daily cap,
// streak cap — is recomputed independently in the test from the Python
// formula rather than read back out of the engine. The separable component
// (fit + churn + soft window) is read from the substrate's baked table, which
// is not this card's arithmetic: card A already pins it byte-for-byte against
// dump-domains.py in substrate.test.ts, and the reference-run section below
// pins the resulting totals end to end against CP-SAT.
//
// The reference partitions come from the committed bench reference run
// (fixtures/reference-light.json); the problems themselves are read read-only
// from bench/problems (card C owns no fixtures).

import { describe, expect, it } from "vitest";
import { bakeProblem, SLOTS_PER_DAY } from "../../src/engine/substrate";
import { iterationBudget, place, withBudget } from "../../src/engine/pass2";
import pass2Source from "../../src/engine/pass2.ts?raw";
import { evaluateBound, optimizeMultipliers } from "../../src/engine/lagrangian";
import type {
  Baked,
  Budget,
  Pass2Result,
  Placement,
  Problem,
} from "../../src/engine/types";

import reference from "./fixtures/reference-light.json";

import availabilityWindowsBench from "../../../bench/problems/availability_windows-light.json";
import baselineBench from "../../../bench/problems/baseline-light.json";
import businessHoursBench from "../../../bench/problems/business_hours-light.json";
import churnBench from "../../../bench/problems/churn-light.json";
import comboChunkedWorkflowBench from "../../../bench/problems/combo_chunked_workflow-light.json";
import comboDeadlineWindowBench from "../../../bench/problems/combo_deadline_window-light.json";
import comboKitchenSinkBench from "../../../bench/problems/combo_kitchen_sink-light.json";
import comboMeetingBench from "../../../bench/problems/combo_meeting-light.json";
import comboOversubscribedBench from "../../../bench/problems/combo_oversubscribed-light.json";
import comboReplanBench from "../../../bench/problems/combo_replan-light.json";
import contextCapsBench from "../../../bench/problems/context_caps-light.json";
import deadlineHardBench from "../../../bench/problems/deadline_hard-light.json";
import deadlineSoftBench from "../../../bench/problems/deadline_soft-light.json";
import dependenciesBench from "../../../bench/problems/dependencies-light.json";
import earliestStartBench from "../../../bench/problems/earliest_start-light.json";
import edgeEmptyHardWindowBench from "../../../bench/problems/edge_empty_hard_window-light.json";
import edgeMustIncludeDemotionBench from "../../../bench/problems/edge_must_include_demotion-light.json";
import edgeSoftDependencyBench from "../../../bench/problems/edge_soft_dependency_ignored-light.json";
import fitCurveBench from "../../../bench/problems/fit_curve-light.json";
import groupOrderedBench from "../../../bench/problems/group_ordered-light.json";
import groupSameDayBench from "../../../bench/problems/group_same_day-light.json";
import mustIncludeBench from "../../../bench/problems/must_include-light.json";
import pinnedAtBench from "../../../bench/problems/pinned_at-light.json";
import preferredWindowHardBench from "../../../bench/problems/preferred_window_hard-light.json";
import preferredWindowSoftBench from "../../../bench/problems/preferred_window_soft-light.json";
import contextCapsMediumBench from "../../../bench/problems/context_caps-medium.json";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const WINDOW = {
  start: "2026-05-18T00:00:00", // a Monday
  end: "2026-05-25T00:00:00",
  tz: "Australia/Sydney",
};

const UNBOUNDED: Budget = { wallMs: Infinity, nodeCap: Infinity };

function budget(over: Partial<Budget> = {}): Budget {
  return { ...UNBOUNDED, ...over };
}

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
  } as Problem["tasks"][number];
}

type Weights = Problem["weights"];

function makeProblem(over: Partial<Problem> = {}, weights: Partial<Weights> = {}): Problem {
  return {
    window: WINDOW as Problem["window"],
    weights: {
      time_of_day_fit_per_15min: 0,
      churn_per_15min_moved: 0,
      priority_unit: 1,
      base_drop_penalty: 200,
      preferred_day_miss: 0,
      preferred_time_miss_per_15min: 0,
      ...weights,
    } as Weights,
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
  } as Problem;
}

function allTaskIndices(baked: Baked): number[] {
  return baked.tasks.map((t) => t.index);
}

function chunkIndex(baked: Baked, taskId: string, chunkId: string): number {
  const i = baked.chunkIndexByKey.get(`${taskId} ${chunkId}`);
  if (i === undefined) throw new Error(`no chunk ${taskId}/${chunkId}`);
  return i;
}

function startOf(baked: Baked, p: Placement, taskId: string, chunkId: string): number {
  return p[chunkIndex(baked, taskId, chunkId)]!;
}

/** Hard-constraint legality of a full placement over the kept set: domain
 * membership, no-overlap against externals and each other, group policy and
 * hard dependencies. (Card E owns the full oracle; this is the local guard so
 * an objective match can never be bought with an illegal placement.) */
function assertLegal(baked: Baked, kept: readonly number[], p: Placement): void {
  const keptSet = new Set(kept);
  const occupied = new Map<number, string>();
  for (let s = 0; s < baked.horizon; s++) {
    if ((baked.externalMask[s >> 5]! >>> (s & 31)) & 1) occupied.set(s, "external");
  }
  for (const ti of kept) {
    const task = baked.tasks[ti]!;
    for (const ci of task.chunkIndices) {
      const c = baked.chunks[ci]!;
      const s = p[ci]!;
      expect(Array.from(c.allowedStarts), `${task.id}/${c.chunkId} start in domain`).toContain(s);
      for (let k = s; k < s + c.durationSlots; k++) {
        expect(occupied.has(k), `${task.id}/${c.chunkId} overlaps ${occupied.get(k)} at ${k}`).toBe(
          false,
        );
        occupied.set(k, `${task.id}/${c.chunkId}`);
      }
    }
    if (task.sameDay) {
      const days = task.chunkIndices.map((ci) => Math.floor(p[ci]! / SLOTS_PER_DAY));
      expect(new Set(days).size, `${task.id} same_day`).toBe(1);
    }
    if (task.ordered) {
      for (let k = 1; k < task.chunkIndices.length; k++) {
        const prev = task.chunkIndices[k - 1]!;
        const next = task.chunkIndices[k]!;
        expect(p[prev]! + baked.chunks[prev]!.durationSlots).toBeLessThanOrEqual(p[next]!);
      }
    }
    const firstChunk = task.chunkIndices[0]!;
    const lastChunk = task.chunkIndices[task.chunkIndices.length - 1]!;
    const firstStart = p[firstChunk]!;
    const lastEnd = p[lastChunk]! + baked.chunks[lastChunk]!.durationSlots;
    for (const dep of task.deps) {
      if (dep.type === "after_event") {
        expect(firstStart).toBeGreaterThanOrEqual(dep.eventEndSlot);
      } else if (dep.type === "before_event") {
        expect(lastEnd).toBeLessThanOrEqual(dep.eventStartSlot);
      } else {
        if (!keptSet.has(dep.taskIndex)) continue;
        const other = baked.tasks[dep.taskIndex]!;
        const oFirst = other.chunkIndices[0]!;
        const oLast = other.chunkIndices[other.chunkIndices.length - 1]!;
        if (dep.type === "after_task") {
          expect(firstStart).toBeGreaterThanOrEqual(
            p[oLast]! + baked.chunks[oLast]!.durationSlots,
          );
        } else {
          expect(lastEnd).toBeLessThanOrEqual(p[oFirst]!);
        }
      }
    }
  }
}

/** Independent recomputation of the pass-2 (drop-exclusive) objective from a
 * concrete placement, transcribed from two_pass._components_from_starts. */
function recomputeCost(baked: Baked, kept: readonly number[], p: Placement): number {
  let total = 0;
  for (const ti of kept) {
    const task = baked.tasks[ti]!;
    const ctx = task.contextIndex >= 0 ? baked.contexts[task.contextIndex]! : null;
    // separable table (fit + churn + soft window)
    for (const ci of task.chunkIndices) {
      const c = baked.chunks[ci]!;
      const i = c.allowedStarts.indexOf(p[ci]!);
      total += c.cost[i]!;
      // streak cap: constant per present chunk whose duration exceeds the cap
      if (ctx !== null && ctx.streakCapSlots >= 0 && c.durationSlots > ctx.streakCapSlots) {
        total += (c.durationSlots - ctx.streakCapSlots) * ctx.streakCapPenaltyPer15;
      }
    }
    // lateness: soft deadlines only; ordered ⇒ last chunk's end, else max end.
    // Keyed on presence, exactly as two_pass._components_from_starts is — a
    // deadline that has already passed bakes to a NEGATIVE slot and still
    // prices lateness.
    if (task.hasSoftDeadline) {
      const ends = task.ordered
        ? [
            p[task.chunkIndices[task.chunkIndices.length - 1]!]! +
              baked.chunks[task.chunkIndices[task.chunkIndices.length - 1]!]!.durationSlots,
          ]
        : task.chunkIndices.map((ci) => p[ci]! + baked.chunks[ci]!.durationSlots);
      total += Math.max(0, Math.max(...ends) - task.deadlineSlot) * task.deadlinePenaltyPer15;
    }
  }
  // daily caps: exact slot overlap per (context, day)
  const days = Math.floor(baked.horizon / SLOTS_PER_DAY);
  for (let cx = 0; cx < baked.contexts.length; cx++) {
    const ctx = baked.contexts[cx]!;
    if (ctx.dailyCapSlots < 0 || ctx.dailyCapPenaltyPer15 === 0) continue;
    for (let d = 0; d < days; d++) {
      const lo = d * SLOTS_PER_DAY;
      const hi = lo + SLOTS_PER_DAY;
      let used = 0;
      for (const ti of kept) {
        const task = baked.tasks[ti]!;
        if (task.contextIndex !== cx) continue;
        for (const ci of task.chunkIndices) {
          const s = p[ci]!;
          const e = s + baked.chunks[ci]!.durationSlots;
          used += Math.max(0, Math.min(e, hi) - Math.max(s, lo));
        }
      }
      total += Math.max(0, used - ctx.dailyCapSlots) * ctx.dailyCapPenaltyPer15;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// 1. root shortcut on a sparse prod-shaped instance
// ---------------------------------------------------------------------------

describe("root shortcut", () => {
  it("proves a sparse prod-shaped week with zero search nodes", () => {
    // Prod's measured shape: 1–2 tasks against ~20 external events, and no
    // start-dependent soft cost that beats the root bound.
    const externals = [];
    for (let d = 0; d < 5; d++) {
      for (let h = 0; h < 4; h++) {
        externals.push({
          id: `ev-${d}-${h}`,
          title: "meeting",
          start: `2026-05-${18 + d}T${String(9 + h * 2).padStart(2, "0")}:00:00`,
          duration_minutes: 60,
          context: "meeting",
        });
      }
    }
    const p = makeProblem({
      external_pinned: externals as never,
      tasks: [makeTask("a"), makeTask("b", { chunks: [{ chunk_id: "b#0", duration_minutes: 90 }] })],
    });
    const baked = bakeProblem(p);
    const kept = allTaskIndices(baked);
    const res = place(baked, kept, null, budget());
    expect(res.proved).toBe(true);
    expect(res.nodes).toBe(0);
    expect(res.boundGap).toBe(0);
    expect(res.descents).toBeGreaterThanOrEqual(1);
    expect(res.cost).toBe(0);
    assertLegal(baked, kept, res.placement);
  });
});

// ---------------------------------------------------------------------------
// 2. component pins in isolation (ported from test_model_soft_objective.py)
// ---------------------------------------------------------------------------

describe("objective components in isolation", () => {
  it("keeps a chunk at its previous placement under a huge churn weight", () => {
    const p = makeProblem(
      {
        tasks: [
          makeTask("t", {
            previous_placement: [{ chunk_id: "t#0", start: "2026-05-18T10:00:00" }] as never,
          }),
        ],
      },
      { churn_per_15min_moved: 10_000 },
    );
    const baked = bakeProblem(p);
    const res = place(baked, allTaskIndices(baked), null, budget());
    expect(startOf(baked, res.placement, "t", "t#0")).toBe(slot(0, 10));
    expect(res.cost).toBe(0);
    expect(res.proved).toBe(true);
  });

  it("pulls a fit-only chunk into the peak window", () => {
    const p = makeProblem({ tasks: [makeTask("t")] }, { time_of_day_fit_per_15min: 100 });
    const baked = bakeProblem(p);
    const res = place(baked, allTaskIndices(baked), null, budget());
    const s = startOf(baked, res.placement, "t", "t#0");
    const minuteOfDay = (s % SLOTS_PER_DAY) * 15;
    expect(minuteOfDay).toBeGreaterThanOrEqual(9 * 60);
    expect(minuteOfDay + 60).toBeLessThanOrEqual(12 * 60);
    expect(res.cost).toBe(0);
    expect(res.proved).toBe(true);
  });

  it("prefers a soft-deadline-clean slot over a cheaper-but-late one", () => {
    // Two availability windows: 11:00–12:00 (ends on the deadline) and
    // 13:00–14:00 (40 cheaper on the soft-window table, but 8 slots late).
    const p = makeProblem(
      {
        tasks: [
          makeTask("t", {
            deadline: { at: "2026-05-18T12:00:00", hard: false, penalty_per_15min: 1000 } as never,
            availability_windows: [
              { start: "2026-05-18T11:00:00", end: "2026-05-18T12:00:00" },
              { start: "2026-05-18T13:00:00", end: "2026-05-18T14:00:00" },
            ] as never,
            preferred_windows: [
              { days: ["mon"], start: "13:00", end: "14:00", hard: false },
            ] as never,
          }),
        ],
      },
      { preferred_time_miss_per_15min: 5 },
    );
    const baked = bakeProblem(p);
    const kept = allTaskIndices(baked);
    const res = place(baked, kept, null, budget());
    const s = startOf(baked, res.placement, "t", "t#0");
    expect(s).toBe(slot(0, 11)); // ends exactly on the deadline
    // separable soft-window miss at 11:00: (13:00 − 11:00) = 120 min → 8 × 5
    expect(res.cost).toBe(40);
    expect(res.cost).toBe(recomputeCost(baked, kept, res.placement));
    expect(res.proved).toBe(true);
  });

  it("prices an unavoidable soft-deadline overrun exactly", () => {
    const p = makeProblem({
      tasks: [
        makeTask("t", {
          deadline: { at: "2026-05-18T12:00:00", hard: false, penalty_per_15min: 1000 } as never,
          availability_windows: [
            { start: "2026-05-18T14:00:00", end: "2026-05-18T15:00:00" },
          ] as never,
        }),
      ],
    });
    const baked = bakeProblem(p);
    const kept = allTaskIndices(baked);
    const res = place(baked, kept, null, budget());
    // end = 15:00 = slot 60, deadline = slot 48 → 12 late slots × 1000
    expect(res.cost).toBe((slot(0, 15) - slot(0, 12)) * 1000);
    expect(res.cost).toBe(recomputeCost(baked, kept, res.placement));
    expect(res.proved).toBe(true);
  });

  it("prices a deadline that has ALREADY PASSED, pulling the task earlier", () => {
    // Regression: a soft deadline before window.start bakes to a negative slot.
    // objective.lateness_terms keys on `deadline is not None and not hard`, not
    // on the slot's sign, so lateness = max(0, end − (−16)) × 7 still applies
    // and actively drags an overdue task towards the start of the week. The
    // worker admits these: task-window.ts anchors overdue tasks into the
    // current window and build-problem.ts passes `deadline.at` through
    // unclamped. Expected values brute-forced against solver.fit_curve:
    // optimum 387 at slot 34 (08:30) = fit 9 + lateness 378.
    const p = makeProblem(
      {
        window: {
          start: "2026-05-18T00:00:00",
          end: "2026-05-19T00:00:00",
          tz: "Australia/Sydney",
        } as never,
        tasks: [
          makeTask("t", {
            deadline: { at: "2026-05-17T20:00:00", hard: false, penalty_per_15min: 7 } as never,
          }),
        ],
      },
      { time_of_day_fit_per_15min: 1 },
    );
    const baked = bakeProblem(p);
    expect(baked.tasks[0]!.deadlineSlot).toBe(-16);
    expect(baked.tasks[0]!.hasSoftDeadline).toBe(true);
    const kept = allTaskIndices(baked);
    const res = place(baked, kept, null, budget());
    expect(startOf(baked, res.placement, "t", "t#0")).toBe(slot(0, 8, 30));
    expect(res.cost).toBe(387);
    expect(res.cost).toBe(recomputeCost(baked, kept, res.placement));
    expect(res.proved).toBe(true);
  });

  it("prices a per-context daily cap overrun exactly", () => {
    // 3 × 60 min of deep work squeezed into one 3-hour day window, cap 120 min.
    const avail = [{ start: "2026-05-18T09:00:00", end: "2026-05-18T12:00:00" }];
    const p = makeProblem({
      contexts: [
        {
          context: "deep",
          fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "15:00" },
          max_minutes_per_day: 120,
          max_contiguous_minutes: null,
          over_daily_cap_penalty_per_15min: 25,
          over_streak_cap_penalty_per_15min: 25,
        },
      ] as never,
      tasks: [
        makeTask("a", { availability_windows: avail as never }),
        makeTask("b", { availability_windows: avail as never }),
        makeTask("c", { availability_windows: avail as never }),
      ],
    });
    const baked = bakeProblem(p);
    const kept = allTaskIndices(baked);
    const res = place(baked, kept, null, budget());
    const usedSlots = 3 * 4;
    const capSlots = 120 / 15;
    expect(res.cost).toBe((usedSlots - capSlots) * 25);
    expect(res.cost).toBe(recomputeCost(baked, kept, res.placement));
    expect(res.proved).toBe(true);
    assertLegal(baked, kept, res.placement);
  });

  it("splits a midnight-spanning chunk across both days for the daily cap", () => {
    // 120 min from 23:00 lands 4 slots in day 0 and 4 in day 1. Under a 15-min
    // cap that is 3 over-cap slots on EACH day (6 × 25 = 150); charging the
    // whole chunk to one day would read 7 over (175) instead.
    const p = makeProblem({
      contexts: [
        {
          context: "deep",
          fit_curve: { peak_start: "00:00", peak_end: "23:45", falloff_end: "23:45" },
          max_minutes_per_day: 15,
          max_contiguous_minutes: null,
          over_daily_cap_penalty_per_15min: 25,
          over_streak_cap_penalty_per_15min: 25,
        },
      ] as never,
      tasks: [
        makeTask("t", {
          chunks: [{ chunk_id: "t#0", duration_minutes: 120 }],
          availability_windows: [
            { start: "2026-05-18T23:00:00", end: "2026-05-19T01:00:00" },
          ] as never,
        }),
      ],
    });
    const baked = bakeProblem(p);
    const kept = allTaskIndices(baked);
    const res = place(baked, kept, null, budget());
    expect(startOf(baked, res.placement, "t", "t#0")).toBe(slot(0, 23));
    expect(res.cost).toBe(2 * (4 - 1) * 25);
    expect(res.cost).toBe(recomputeCost(baked, kept, res.placement));
    expect(res.proved).toBe(true);
  });

  it("prices a contiguous-streak cap overrun exactly (constant per chunk)", () => {
    const p = makeProblem({
      contexts: [
        {
          context: "deep",
          fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "15:00" },
          max_minutes_per_day: null,
          max_contiguous_minutes: 60,
          over_daily_cap_penalty_per_15min: 25,
          over_streak_cap_penalty_per_15min: 25,
        },
      ] as never,
      tasks: [makeTask("t", { chunks: [{ chunk_id: "t#0", duration_minutes: 180 }] })],
    });
    const baked = bakeProblem(p);
    const kept = allTaskIndices(baked);
    const res = place(baked, kept, null, budget());
    // excess = (180 − 60)/15 = 8 slots × 25
    expect(res.cost).toBe(((180 - 60) / 15) * 25);
    expect(res.cost).toBe(recomputeCost(baked, kept, res.placement));
    expect(res.proved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. lateness endpoint: ordered = last chunk's end, unordered = max end
// ---------------------------------------------------------------------------

describe("lateness endpoint", () => {
  // c0 is long (60 min) and only fits the afternoon window; c1 is short
  // (30 min) and is squeezed into the morning one. The LAST chunk therefore
  // ends FIRST — the case that separates "max over chunk ends" (correct for an
  // unordered task) from "the last chunk's end".
  function twoChunkProblem(ordered: boolean): Problem {
    return makeProblem({
      tasks: [
        makeTask("t", {
          group_policy: { same_day: false, ordered },
          chunks: [
            { chunk_id: "t#0", duration_minutes: 60 },
            { chunk_id: "t#1", duration_minutes: 30 },
          ],
          deadline: { at: "2026-05-18T11:00:00", hard: false, penalty_per_15min: 100 } as never,
          availability_windows: [
            { start: "2026-05-18T09:00:00", end: "2026-05-18T09:30:00" },
            { start: "2026-05-18T15:00:00", end: "2026-05-18T16:00:00" },
          ] as never,
        }),
      ],
    });
  }

  it("uses the max chunk end for an unordered task", () => {
    const baked = bakeProblem(twoChunkProblem(false));
    const kept = allTaskIndices(baked);
    const res = place(baked, kept, null, budget());
    expect(startOf(baked, res.placement, "t", "t#0")).toBe(slot(0, 15)); // only the PM window fits 60 min
    expect(startOf(baked, res.placement, "t", "t#1")).toBe(slot(0, 9)); // AM window
    // max end = 16:00 = slot 64; deadline 11:00 = slot 44 → 20 late slots
    expect(res.cost).toBe((slot(0, 16) - slot(0, 11)) * 100);
    expect(res.cost).toBe(recomputeCost(baked, kept, res.placement));
    expect(res.proved).toBe(true);
  });

  it("uses the last chunk's end for an ordered task", () => {
    // Ordering forces c0 into the AM window is impossible (60 min > 30 min
    // window), so both land in the PM window back to back.
    const p = makeProblem({
      tasks: [
        makeTask("t", {
          group_policy: { same_day: false, ordered: true },
          chunks: [
            { chunk_id: "t#0", duration_minutes: 60 },
            { chunk_id: "t#1", duration_minutes: 30 },
          ],
          deadline: { at: "2026-05-18T11:00:00", hard: false, penalty_per_15min: 100 } as never,
          availability_windows: [
            { start: "2026-05-18T09:00:00", end: "2026-05-18T10:00:00" },
            { start: "2026-05-18T15:00:00", end: "2026-05-18T16:00:00" },
          ] as never,
        }),
      ],
    });
    const baked = bakeProblem(p);
    const kept = allTaskIndices(baked);
    const res = place(baked, kept, null, budget());
    expect(startOf(baked, res.placement, "t", "t#0")).toBe(slot(0, 9));
    expect(startOf(baked, res.placement, "t", "t#1")).toBe(slot(0, 15));
    // last chunk ends 15:30 = slot 62; deadline slot 44 → 18 late slots
    expect(res.cost).toBe((slot(0, 15, 30) - slot(0, 11)) * 100);
    expect(res.cost).toBe(recomputeCost(baked, kept, res.placement));
    expect(res.proved).toBe(true);
    assertLegal(baked, kept, res.placement);
  });
});

// ---------------------------------------------------------------------------
// 4. objective equality against the committed bench reference run
// ---------------------------------------------------------------------------

type ReferenceEntry = {
  status: string;
  kept?: string[];
  dropped?: string[];
  objective_total: number | null;
  objective_components: Record<string, number> | null;
};

const BENCH: Array<[string, { problem: unknown }]> = [
  ["availability_windows-light", availabilityWindowsBench as never],
  ["baseline-light", baselineBench as never],
  ["business_hours-light", businessHoursBench as never],
  ["churn-light", churnBench as never],
  ["combo_chunked_workflow-light", comboChunkedWorkflowBench as never],
  ["combo_deadline_window-light", comboDeadlineWindowBench as never],
  ["combo_kitchen_sink-light", comboKitchenSinkBench as never],
  ["combo_meeting-light", comboMeetingBench as never],
  ["combo_oversubscribed-light", comboOversubscribedBench as never],
  ["combo_replan-light", comboReplanBench as never],
  ["context_caps-light", contextCapsBench as never],
  ["deadline_hard-light", deadlineHardBench as never],
  ["deadline_soft-light", deadlineSoftBench as never],
  ["dependencies-light", dependenciesBench as never],
  ["earliest_start-light", earliestStartBench as never],
  ["edge_empty_hard_window-light", edgeEmptyHardWindowBench as never],
  ["edge_must_include_demotion-light", edgeMustIncludeDemotionBench as never],
  ["edge_soft_dependency_ignored-light", edgeSoftDependencyBench as never],
  ["fit_curve-light", fitCurveBench as never],
  ["group_ordered-light", groupOrderedBench as never],
  ["group_same_day-light", groupSameDayBench as never],
  ["must_include-light", mustIncludeBench as never],
  ["pinned_at-light", pinnedAtBench as never],
  ["preferred_window_hard-light", preferredWindowHardBench as never],
  ["preferred_window_soft-light", preferredWindowSoftBench as never],
];

/** Every light entry the reference run certified. Pinned so a truncated or
 * re-generated fixture cannot silently shrink the parity suite to a handful of
 * trivially-zero problems: 26 light entries, of which edge_unsat_must_include
 * is UNSAT (card D's) and the other 25 are OPTIMAL. */
const EXPECTED_OPTIMAL_ENTRIES = 25;

describe("objective equality with the reference run (light tier)", () => {
  const refs = reference as unknown as Record<string, ReferenceEntry>;

  it("covers every OPTIMAL entry in the reference run", () => {
    const optimalInFixture = Object.values(refs).filter((r) => r.status === "OPTIMAL").length;
    expect(optimalInFixture).toBe(EXPECTED_OPTIMAL_ENTRIES);
    const covered = BENCH.filter(([name]) => refs[name]?.status === "OPTIMAL").length;
    expect(covered).toBe(EXPECTED_OPTIMAL_ENTRIES);
  });

  for (const [name, fx] of BENCH) {
    const ref = refs[name];
    if (ref === undefined || ref.status !== "OPTIMAL") continue;
    it(`reaches the reference objective for ${name}`, () => {
      const baked = bakeProblem(fx.problem as Problem);
      const keptIds = new Set(ref.kept ?? []);
      const kept = baked.tasks.filter((t) => keptIds.has(t.id)).map((t) => t.index);
      expect(kept.length).toBe(keptIds.size);
      const dropWeight = baked.tasks
        .filter((t) => !keptIds.has(t.id))
        .reduce((acc, t) => acc + t.dropWeight, 0);
      // the drop-exclusive cost seam: engine.ts adds Σ dropWeight itself
      expect(dropWeight).toBe(ref.objective_components!.drop);

      const res = place(baked, kept, null, budget());
      expect(res.proved, `${name} must be certified`).toBe(true);
      expect(res.boundGap).toBe(0);
      assertLegal(baked, kept, res.placement);
      expect(res.cost).toBe(recomputeCost(baked, kept, res.placement));
      expect(res.cost + dropWeight, `${name} objective total`).toBe(ref.objective_total);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. warm start
// ---------------------------------------------------------------------------

describe("warm start", () => {
  // Three 60-minute deep chunks under a 120 min/day cap. The cap is a COUPLING
  // term — invisible to the per-chunk cost tables — so a cost-greedy first
  // descent stacks all three on day 0 and pays the overrun, while the previous
  // placement (one per day) is already optimal.
  const capContext = [
    {
      context: "deep",
      fit_curve: { peak_start: "00:00", peak_end: "23:45", falloff_end: "23:45" },
      max_minutes_per_day: 120,
      max_contiguous_minutes: null,
      over_daily_cap_penalty_per_15min: 25,
      over_streak_cap_penalty_per_15min: 25,
    },
  ];
  const PREV_DAYS = [0, 1, 2];

  function capProblem(withPrevious: boolean): Problem {
    return makeProblem({
      contexts: capContext as never,
      tasks: PREV_DAYS.map((d, i) =>
        makeTask(`t${i}`, {
          previous_placement: withPrevious
            ? ([{ chunk_id: `t${i}#0`, start: `2026-05-${18 + d}T10:00:00` }] as never)
            : [],
        }),
      ),
    });
  }

  it("seeds the incumbent from previous_placement, beating the greedy descent", () => {
    const greedyBaked = bakeProblem(capProblem(false));
    const greedy = place(greedyBaked, allTaskIndices(greedyBaked), null, budget({ nodeCap: 0 }));
    // greedy stacks day 0: 180 min used vs a 120 min cap → 4 slots × 25
    expect(greedy.cost).toBe(100);

    const warmBaked = bakeProblem(capProblem(true));
    const kept = allTaskIndices(warmBaked);
    const warm = place(warmBaked, kept, null, budget({ nodeCap: 0 }));
    expect(warm.cost).toBeLessThanOrEqual(greedy.cost);
    expect(warm.cost).toBe(0);
    for (let i = 0; i < PREV_DAYS.length; i++) {
      expect(startOf(warmBaked, warm.placement, `t${i}`, `t${i}#0`)).toBe(
        slot(PREV_DAYS[i]!, 10),
      );
    }
    expect(warm.cost).toBe(recomputeCost(warmBaked, kept, warm.placement));
  });

  it("honours an explicit warmStart placement over the greedy descent", () => {
    const baked = bakeProblem(capProblem(false));
    const kept = allTaskIndices(baked);
    const hint = new Int32Array(baked.chunks.length).fill(-1);
    for (let i = 0; i < PREV_DAYS.length; i++) {
      hint[chunkIndex(baked, `t${i}`, `t${i}#0`)] = slot(PREV_DAYS[i]!, 10);
    }
    const res = place(baked, kept, hint, budget({ nodeCap: 0 }));
    expect(res.cost).toBe(0);
    for (let i = 0; i < PREV_DAYS.length; i++) {
      expect(startOf(baked, res.placement, `t${i}`, `t${i}#0`)).toBe(slot(PREV_DAYS[i]!, 10));
    }
  });

  it("ignores a warmStart that is not legal and still returns a valid placement", () => {
    const baked = bakeProblem(capProblem(false));
    const kept = allTaskIndices(baked);
    const hint = new Int32Array(baked.chunks.length).fill(-1);
    // all three on the same slot: overlapping, so unusable as an incumbent
    for (let i = 0; i < PREV_DAYS.length; i++) {
      hint[chunkIndex(baked, `t${i}`, `t${i}#0`)] = slot(0, 10);
    }
    const res = place(baked, kept, hint, budget({ nodeCap: 0 }));
    assertLegal(baked, kept, res.placement);
    expect(res.descents).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 6. budget exhaustion + determinism
// ---------------------------------------------------------------------------

describe("budget exhaustion", () => {
  // 8 × 60 min of deep work under a 60 min/day cap across a 7-day week, half of
  // it carrying soft deadlines.
  //
  // The cap overrun ALONE no longer strains the search: that is exactly what
  // the energetic floor prices, and the cap-only version of this instance now
  // closes at the root. What still resists proof is no-overlap contention
  // against the deadlines — several tasks competing for the same early slots —
  // which no bound here models. That is what keeps this a genuine budget-
  // exhaustion fixture rather than one that quietly certifies.
  function crowdedProblem(): Problem {
    const avail: Array<{ start: string; end: string }> = [];
    for (let d = 0; d < 7; d++) {
      avail.push({
        start: `2026-05-${18 + d}T09:00:00`,
        end: `2026-05-${18 + d}T17:00:00`,
      });
    }
    return makeProblem({
      contexts: [
        {
          context: "deep",
          fit_curve: { peak_start: "00:00", peak_end: "23:45", falloff_end: "23:45" },
          max_minutes_per_day: 60,
          max_contiguous_minutes: null,
          over_daily_cap_penalty_per_15min: 25,
          over_streak_cap_penalty_per_15min: 25,
        },
      ] as never,
      tasks: Array.from({ length: 8 }, (_, i) =>
        makeTask(`t${i}`, {
          availability_windows: avail as never,
          deadline:
            i % 2 === 0
              ? ({
                  at: `2026-05-${19 + (i % 5)}T12:00:00`,
                  hard: false,
                  penalty_per_15min: 30 + i,
                } as never)
              : undefined,
        }),
      ),
    });
  }

  it("returns the incumbent with a positive bound gap when the node cap trips", () => {
    const baked = bakeProblem(crowdedProblem());
    const kept = allTaskIndices(baked);
    // Phase off: the round-batched LNS (card F) genuinely CERTIFIES this
    // fixture within 300 nodes (incumbent reaches the abandoned-bound floor),
    // which is a stronger engine but the wrong path for this test — it pins
    // the exhaustion contract of the proof search alone.
    const res = place(baked, kept, null, budget({ nodeCap: 300 }), {
      improveBudget: { wallMs: 0, nodeCap: 0 },
    });
    expect(res.proved).toBe(false);
    expect(res.nodes).toBeGreaterThan(0);
    expect(res.nodes).toBeLessThanOrEqual(300);
    expect(res.boundGap).toBeGreaterThan(0);
    expect(res.descents).toBeGreaterThanOrEqual(1);
    assertLegal(baked, kept, res.placement);
    expect(res.cost).toBe(recomputeCost(baked, kept, res.placement));
  });

  it("is deterministic across two identical runs", () => {
    const baked = bakeProblem(crowdedProblem());
    const kept = allTaskIndices(baked);
    const a = place(baked, kept, null, budget({ nodeCap: 300 }));
    const b = place(baked, kept, null, budget({ nodeCap: 300 }));
    expect(Array.from(b.placement)).toEqual(Array.from(a.placement));
    expect(b.cost).toBe(a.cost);
    expect(b.nodes).toBe(a.nodes);
    expect(b.boundGap).toBe(a.boundGap);
  });

  it("stops on the injected wall clock, sampled every CLOCK_STRIDE checks", () => {
    const baked = bakeProblem(crowdedProblem());
    const kept = allTaskIndices(baked);
    // A monotonic counter clock advances one "ms" per sample, so the run stops
    // deterministically after wallMs samples rather than after wall time. The
    // D3 phase is off here: this is the bare search's budget contract, and the
    // case below is what the phase does with the same 20 ticks.
    let ticks = 0;
    const res = place(
      baked,
      kept,
      null,
      { wallMs: 20, nodeCap: Infinity, now: () => ticks++ },
      { improveBudget: PHASE_OFF },
    );
    expect(res.proved).toBe(false);
    expect(res.nodes).toBeGreaterThan(0);
    expect(res.nodes).toBeLessThan(4000); // stride-sampled, not unbounded
    expect(res.boundGap).toBeGreaterThan(0);
    assertLegal(baked, kept, res.placement);

    let again = 0;
    const twin = place(
      baked,
      kept,
      null,
      { wallMs: 20, nodeCap: Infinity, now: () => again++ },
      { improveBudget: PHASE_OFF },
    );
    expect(twin.nodes).toBe(res.nodes);
    expect(Array.from(twin.placement)).toEqual(Array.from(res.placement));
  });

  it("D3 turns this fixture's budget exhaustion into a certificate", () => {
    // BEHAVIOUR CHANGE (card D): the same 20 ticks that leave the bare search
    // at 300 with a gap of 200 now return the instance's true optimum AND
    // prove it, because a better incumbent closes the gap against bounds the
    // search had already abandoned. The optimum is established independently
    // here, by the exhaustive search, so the certificate is checked rather
    // than taken on trust — this fixture is no longer a budget-exhaustion
    // example, and the case above carries that contract now.
    const baked = bakeProblem(crowdedProblem());
    const kept = allTaskIndices(baked);
    const exhaustive = place(baked, kept, null, budget({ nodeCap: 500_000 }), {
      improveBudget: PHASE_OFF,
    });
    expect(exhaustive.proved).toBe(true);

    let ticks = 0;
    const res = place(baked, kept, null, {
      wallMs: 20,
      nodeCap: Infinity,
      now: () => ticks++,
    });
    expect(res.cost).toBe(exhaustive.cost);
    expect(res.proved).toBe(true);
    expect(res.boundGap).toBe(0);
    expect(res.improveAccepted).toBeGreaterThan(0);
    expect(res.nodes).toBeLessThan(exhaustive.nodes / 50);
    assertLegal(baked, kept, res.placement);
    expect(res.cost).toBe(recomputeCost(baked, kept, res.placement));
  });

  it("honours the wall clock during the pre-search descents", () => {
    const baked = bakeProblem(crowdedProblem());
    const kept = allTaskIndices(baked);
    // The clock reads zero when the budget is stamped and is already past it
    // by the first sample, so even the greedy descent must give up: no
    // incumbent, nothing certified. The node cap is only a backstop — a correct
    // run does zero nodes, so a regression that ignores the clock during the
    // descents fails loudly here rather than hanging.
    let call = 0;
    const res = place(baked, kept, null, {
      wallMs: 1,
      nodeCap: 50_000,
      now: () => (call++ === 0 ? 0 : 1_000_000),
    });
    expect(res.proved).toBe(false);
    expect(res.nodes).toBe(0);
    expect(res.descents).toBe(0);
    expect(Array.from(res.placement).every((s) => s === -1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. unrealisable partitions — the descents === 0 contract card E maps to
//    PASS1_FALLBACK
// ---------------------------------------------------------------------------

describe("unrealisable partition", () => {
  it("reports no descent when a kept chunk has an empty domain", () => {
    // edge_empty_hard_window's task-0 has an unsatisfiable hard window; the
    // reference drops it. Forcing it into the kept set is exactly the
    // "pass 1 handed over something pass 2 cannot realise" case.
    const baked = bakeProblem((edgeEmptyHardWindowBench as never as { problem: Problem }).problem);
    const kept = allTaskIndices(baked);
    expect(baked.chunks.some((c) => c.allowedStarts.length === 0)).toBe(true);
    const res = place(baked, kept, null, budget());
    expect(res.descents).toBe(0);
    expect(res.proved).toBe(false);
    expect(res.nodes).toBe(0);
    expect(Array.from(res.placement).every((s) => s === -1)).toBe(true);
  });

  it("reports no descent when non-empty domains are jointly unplaceable", () => {
    // Two tasks pinned to the same slot: each domain is a legal singleton, so
    // the emptiness is only discovered inside the search.
    const p = makeProblem({
      tasks: [
        makeTask("a", { pinned_at: "2026-05-19T10:00:00" as never }),
        makeTask("b", { pinned_at: "2026-05-19T10:00:00" as never }),
      ],
    });
    const baked = bakeProblem(p);
    const kept = allTaskIndices(baked);
    expect(baked.chunks.every((c) => c.allowedStarts.length === 1)).toBe(true);
    const res = place(baked, kept, null, budget());
    expect(res.descents).toBe(0);
    expect(res.proved).toBe(false);
    expect(Array.from(res.placement).every((s) => s === -1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. coupling bounds — the energetic daily-cap floor and the lateness floor
// ---------------------------------------------------------------------------

describe("coupling bounds", () => {
  /** n deep tasks of `durMin` each, business hours only, under a daily cap.
   * Every separable cost is zero, so the ONLY cost is the cap overrun — the
   * class the separable bound is blind to. */
  function cappedWeek(n: number, durMin: number, capMin: number): Problem {
    return makeProblem({
      contexts: [
        {
          context: "deep",
          fit_curve: { peak_start: "09:00", peak_end: "17:00", falloff_end: "18:00" },
          max_minutes_per_day: capMin,
          max_contiguous_minutes: null,
          over_daily_cap_penalty_per_15min: 25,
          over_streak_cap_penalty_per_15min: 25,
        },
      ] as never,
      business_hours: {
        days: ["mon", "tue", "wed", "thu", "fri"],
        start: "09:00",
        end: "17:00",
      } as never,
      tasks: Array.from({ length: n }, (_, i) =>
        makeTask(`t${i}`, { chunks: [{ chunk_id: `t${i}#0`, duration_minutes: durMin }] }),
      ),
    });
  }

  it("proves the review's 12×120min-under-240min/day instance cheaply", () => {
    // 24 h of deep work against 20 h of capped weekday capacity ⇒ 4 h must
    // overrun: 16 slots × 25 = 400. Before the energetic floor this burned
    // 500 000 nodes with the lower bound never leaving zero.
    const baked = bakeProblem(cappedWeek(12, 120, 240));
    const kept = allTaskIndices(baked);
    const res = place(baked, kept, null, budget());
    expect(res.proved).toBe(true);
    expect(res.boundGap).toBe(0);
    const capSlots = 240 / 15;
    const overrun = 12 * (120 / 15) - 5 * capSlots; // demand − weekday capacity
    expect(res.cost).toBe(overrun * 25);
    expect(res.cost).toBe(400);
    expect(res.nodes).toBeLessThan(200); // was unbounded; measured 22
    expect(res.cost).toBe(recomputeCost(baked, kept, res.placement));
    assertLegal(baked, kept, res.placement);
  });

  it("scales to a tighter overrun without losing the certificate", () => {
    const baked = bakeProblem(cappedWeek(14, 120, 240));
    const kept = allTaskIndices(baked);
    const res = place(baked, kept, null, budget());
    expect(res.proved).toBe(true);
    const overrun = 14 * (120 / 15) - 5 * (240 / 15);
    expect(res.cost).toBe(overrun * 25);
    expect(res.nodes).toBeLessThan(200);
  });

  it("does not charge a cap floor when the remaining work still fits", () => {
    // 8 h of work against 20 h of capped capacity: no overrun is forced, so the
    // floor must contribute exactly nothing and a zero-cost plan must survive.
    // (The greedy descent packs all four chunks into Monday's eight hours and
    // so starts at 400; an over-charging floor would prune the zero-cost
    // optimum the search then finds.)
    const baked = bakeProblem(cappedWeek(4, 120, 240));
    const kept = allTaskIndices(baked);
    const res = place(baked, kept, null, budget());
    expect(res.proved).toBe(true);
    expect(res.cost).toBe(0);
    expect(res.cost).toBe(recomputeCost(baked, kept, res.placement));
    assertLegal(baked, kept, res.placement);
  });

  it("prices unavoidable lateness into the ROOT bound (closes with no search)", () => {
    // The chunk can only run 14:00–15:00 against a 12:00 soft deadline, so the
    // 12 late slots are forced before a single chunk is placed. The lateness
    // floor puts them in the root bound, which then equals the greedy
    // incumbent — the root shortcut fires and the search never starts.
    const p = makeProblem({
      tasks: [
        makeTask("t", {
          deadline: { at: "2026-05-18T12:00:00", hard: false, penalty_per_15min: 1000 } as never,
          availability_windows: [
            { start: "2026-05-18T14:00:00", end: "2026-05-18T15:00:00" },
          ] as never,
        }),
      ],
    });
    const baked = bakeProblem(p);
    const kept = allTaskIndices(baked);
    const res = place(baked, kept, null, budget());
    expect(res.cost).toBe((slot(0, 15) - slot(0, 12)) * 1000);
    expect(res.proved).toBe(true);
    expect(res.nodes).toBe(0);
  });

  it("keeps the medium-tier daily-cap problem certified", () => {
    // context_caps-medium is the card-F case: 35 chunks whose whole objective
    // is cap overrun. Uncertified at the full 20 s budget before this change
    // (gap 400); now proved. Node bound is generous around the measured 773.
    const baked = bakeProblem(
      (contextCapsMediumBench as never as { problem: Problem }).problem,
    );
    const kept = allTaskIndices(baked);
    const res = place(baked, kept, null, budget({ nodeCap: 100_000 }));
    expect(res.proved).toBe(true);
    expect(res.boundGap).toBe(0);
    expect(res.cost).toBe(550);
    expect(res.cost).toBe(recomputeCost(baked, kept, res.placement));
    assertLegal(baked, kept, res.placement);
  });

  it("never reports a negative bound gap", () => {
    const cases: Array<[string, Problem, Budget]> = [
      ["capped, proved", cappedWeek(12, 120, 240), budget()],
      ["capped, cut off", cappedWeek(12, 120, 240), budget({ nodeCap: 3 })],
      ["uncapped", cappedWeek(4, 120, 240), budget()],
      ["cut off at zero nodes", cappedWeek(14, 120, 240), budget({ nodeCap: 0 })],
    ];
    for (const [label, problem, b] of cases) {
      const baked = bakeProblem(problem);
      const res = place(baked, allTaskIndices(baked), null, b);
      expect(res.boundGap, label).toBeGreaterThanOrEqual(0);
      if (res.proved) expect(res.boundGap, label).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. admissibility — differential against exhaustive enumeration
// ---------------------------------------------------------------------------

/** Exhaustive minimum over every legal placement, using the test's own
 * independent cost recomputation. Exponential, so instances stay tiny. */
function bruteForceOptimum(baked: Baked, kept: readonly number[]): number | null {
  const chunkIdx: number[] = [];
  for (const ti of kept) chunkIdx.push(...baked.tasks[ti]!.chunkIndices);
  const placement = new Int32Array(baked.chunks.length).fill(-1);
  let best: number | null = null;

  const occupied = new Set<number>();
  for (let s = 0; s < baked.horizon; s++) {
    if ((baked.externalMask[s >> 5]! >>> (s & 31)) & 1) occupied.add(s);
  }

  const recurse = (k: number): void => {
    if (k === chunkIdx.length) {
      // group policy and dependencies are checked by re-running assertLegal's
      // rules cheaply: these fixtures carry neither, so only overlap matters
      const cost = recomputeCost(baked, kept, placement);
      if (best === null || cost < best) best = cost;
      return;
    }
    const ci = chunkIdx[k]!;
    const chunk = baked.chunks[ci]!;
    for (const s of chunk.allowedStarts) {
      let free = true;
      for (let x = s; x < s + chunk.durationSlots; x++) {
        if (occupied.has(x)) {
          free = false;
          break;
        }
      }
      if (!free) continue;
      for (let x = s; x < s + chunk.durationSlots; x++) occupied.add(x);
      placement[ci] = s;
      recurse(k + 1);
      placement[ci] = -1;
      for (let x = s; x < s + chunk.durationSlots; x++) occupied.delete(x);
    }
  };
  recurse(0);
  return best;
}

describe("bound admissibility (differential vs brute force)", () => {
  it("matches exhaustive enumeration on a grid of tiny capped instances", () => {
    // A bound that over-charges prunes the true optimum, and the engine would
    // return something dearer than exhaustive search. Sweeping caps, penalties,
    // deadlines and durations exercises both floors, including the cases where
    // they must contribute exactly zero.
    let checked = 0;
    for (const nTasks of [2, 3]) {
      for (const durMin of [30, 60]) {
        for (const capMin of [null, 30, 60, 120]) {
          for (const deadlineHour of [null, 10, 13]) {
            const p = makeProblem(
              {
                window: {
                  start: "2026-05-18T00:00:00",
                  end: "2026-05-19T00:00:00",
                  tz: "Australia/Sydney",
                } as never,
                contexts: [
                  {
                    context: "deep",
                    fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "15:00" },
                    max_minutes_per_day: capMin,
                    max_contiguous_minutes: null,
                    over_daily_cap_penalty_per_15min: 25,
                    over_streak_cap_penalty_per_15min: 25,
                  },
                ] as never,
                tasks: Array.from({ length: nTasks }, (_, i) =>
                  makeTask(`t${i}`, {
                    chunks: [{ chunk_id: `t${i}#0`, duration_minutes: durMin }],
                    availability_windows: [
                      { start: "2026-05-18T09:00:00", end: "2026-05-18T12:00:00" },
                    ] as never,
                    deadline:
                      deadlineHour === null
                        ? undefined
                        : ({
                            at: `2026-05-18T${deadlineHour}:00:00`,
                            hard: false,
                            penalty_per_15min: 40,
                          } as never),
                  }),
                ),
              },
              { time_of_day_fit_per_15min: 1 },
            );
            const baked = bakeProblem(p);
            const kept = allTaskIndices(baked);
            const res = place(baked, kept, null, budget());
            const brute = bruteForceOptimum(baked, kept);
            const label = `n=${nTasks} dur=${durMin} cap=${capMin} dl=${deadlineHour}`;
            expect(res.proved, label).toBe(true);
            expect(res.cost, label).toBe(brute);
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(2 * 2 * 4 * 3);
  });
});

// ---------------------------------------------------------------------------
// 10. D1 — the Lagrangian contention bound
//     (internal design notes, card B)
//
// Every "before" number quoted below was measured on this same suite with the
// D1 code stashed out (engine @ 43fac37), so the comparisons are same-machine,
// same-fixture, and — because the budgets here are NODE budgets, not wall
// budgets — reproducible on any machine.
// ---------------------------------------------------------------------------

describe("Lagrangian contention bound", () => {
  /** n single-chunk tasks of `durMin`, available only 09:00–13:00 on every day
   * of the window: 7 × 16 slots of capacity against n × durMin/15 of demand.
   * Pure no-overlap contention — each chunk ON ITS OWN reaches the zero-cost
   * 09:00 peak, so the separable Σ-min bound is exactly zero no matter how
   * crowded the week gets, and neither coupling floor sees anything (nothing
   * is capped, nothing has a deadline). This is the blind spot the pass-2
   * header records, in its purest form. */
  function crowdedWeek(n: number, durMin: number): Problem {
    return makeProblem(
      {
        business_hours: {
          days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          start: "09:00",
          end: "13:00",
        } as never,
        contexts: [
          {
            context: "deep",
            fit_curve: { peak_start: "09:00", peak_end: "11:00", falloff_end: "13:00" },
            max_minutes_per_day: null,
            max_contiguous_minutes: null,
            over_daily_cap_penalty_per_15min: 25,
            over_streak_cap_penalty_per_15min: 25,
          },
        ] as never,
        tasks: Array.from({ length: n }, (_, i) =>
          makeTask(`t${i}`, { chunks: [{ chunk_id: `t${i}#0`, duration_minutes: durMin }] }),
        ),
      },
      { time_of_day_fit_per_15min: 1000 },
    );
  }

  it("certifies the saturated 14 × 120 min week at the root, in zero nodes", () => {
    // 14 chunks × 8 slots exactly fills 7 days × 16 slots, so two chunks share
    // every day and the later one sits wholly past the 11:00 peak: the optimum
    // is 7 × 450 000. The LP relaxation is exact here and the subgradient
    // reaches it, which is the whole nodes-to-close claim in its strongest
    // form. BEFORE: root bound 0, gap 3 150 000, 18 745 970 nodes and still
    // unproved at the full 20 s budget. AFTER: proved at the root shortcut.
    const baked = bakeProblem(crowdedWeek(14, 120));
    const kept = allTaskIndices(baked);
    const res = place(baked, kept, null, budget({ nodeCap: 500_000 }));
    expect(res.proved).toBe(true);
    expect(res.boundGap).toBe(0);
    expect(res.nodes).toBe(0);
    expect(res.cost).toBe(7 * 450_000);
    expect(res.rootBound).toBe(3_150_000);
    expect(res.boundLift).toBe(3_150_000);
    expect(res.cost).toBe(recomputeCost(baked, kept, res.placement));
    assertLegal(baked, kept, res.placement);
  });

  it("collapses the bound gap on the 12 × 120 min / 240 min-per-day week", () => {
    // The plan's named instance. 12 × 2 h into 7 × 4 h leaves slack, the LP is
    // no longer integral, and the subgradient converges to 98.5 % of the
    // 2 250 000 optimum rather than onto it — so this one does NOT certify.
    // What it does do is turn a bound that never left zero into one that
    // brackets the optimum within 1.5 %:
    //   BEFORE  root bound 0          bound gap 2 250 000
    //   AFTER   root bound 2 216 171  bound gap    33 829   (500 000 nodes)
    const baked = bakeProblem(crowdedWeek(12, 120));
    const kept = allTaskIndices(baked);
    const res = place(baked, kept, null, budget({ nodeCap: 500_000 }));
    expect(res.rootBound).toBe(2_216_171);
    expect(res.boundLift).toBe(2_216_171);
    expect(res.cost).toBe(2_250_000);
    expect(res.boundGap).toBe(33_829);
    // an admissible bound never crosses a reachable cost
    expect(res.rootBound!).toBeLessThanOrEqual(res.cost);
    expect(res.cost).toBe(recomputeCost(baked, kept, res.placement));
    assertLegal(baked, kept, res.placement);
  });

  it("never pays for the subgradient on the root-shortcut path", () => {
    // 6 chunks, 7 peak starts: the greedy descent lands ON the separable root
    // bound, so the D1 guard short-circuits and the loop never runs — the
    // property this case actually pins, and the one prod depends on, since the
    // root shortcut is the shape almost every live resolve takes. (λ* itself
    // staying at the origin when there is nothing to price is a claim about
    // the module, and lagrangian.test.ts's crowdedWeek(2, 120) makes it.)
    const baked = bakeProblem(crowdedWeek(6, 120));
    const res = place(baked, allTaskIndices(baked), null, budget());
    expect(res.proved).toBe(true);
    expect(res.cost).toBe(0);
    expect(res.nodes).toBe(0);
    expect(res.rootBound).toBe(0);
    expect(res.rootIncumbent).toBe(res.rootBound); // incumbent met the bound
    expect(res.boundLift).toBe(0);
  });

  it("agrees with the module's own evaluate-only bound at the root", () => {
    // pass 2 fuses L(λ) into scan() for speed; lagrangian.ts computes it
    // standalone. On a fixture with no coupling floors and no binary
    // constraints the two see the same live domains, so the root bound must be
    // exactly the module's evaluate-only value at the same λ*.
    const baked = bakeProblem(crowdedWeek(12, 120));
    const kept = allTaskIndices(baked);
    const res = place(baked, kept, null, budget({ nodeCap: 0 }));
    const unplaced = baked.chunks.map((c) => c.index);
    const state = optimizeMultipliers(
      baked,
      { occ: baked.externalMask, unplaced, upperBound: res.cost },
      200,
    );
    expect(evaluateBound(baked, { occ: baked.externalMask, unplaced }, state.lambda)).toBe(
      res.rootBound,
    );
  });

  it("agrees with the module when event dependencies narrow the domains", () => {
    // An after_event dependency is folded into pass 2's WORKING domain as a
    // start-slot floor. λ is tuned against that narrowed domain, not the baked
    // envelope, so the multipliers never price slots the search cannot use:
    // pass 2's fused bound is then exactly the module's evaluate-only bound
    // over the same domains, which is what this pins. With the baked envelope
    // instead, this fixture's root bound is 1 412 523 against the 1 439 745 it
    // reaches now.
    //
    // Honest caveat, measured: the gain is NOT monotone per instance. Over the
    // same fixture at 0/2/5/8/10 dependent tasks the narrowed λ scores
    // 1412523 / 1371433 / 1412523 / 1439745 / 2669653 against a flat 1412523
    // for the baked envelope — a loss at two, a large win at eight and above.
    // Both λ are admissible; which one evaluates higher is not something a
    // heuristic ascent over a changed feasible set promises.
    const problem = makeProblem(
      {
        business_hours: {
          days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          start: "09:00",
          end: "13:00",
        } as never,
        contexts: [
          {
            context: "deep",
            fit_curve: { peak_start: "09:00", peak_end: "11:00", falloff_end: "13:00" },
            max_minutes_per_day: null,
            max_contiguous_minutes: null,
            over_daily_cap_penalty_per_15min: 25,
            over_streak_cap_penalty_per_15min: 25,
          },
        ] as never,
        external_pinned: [
          {
            id: "ev",
            title: "ev",
            start: "2026-05-20T09:00:00", // Wednesday
            duration_minutes: 60,
            context: "meeting",
          },
        ] as never,
        tasks: Array.from({ length: 10 }, (_, i) =>
          makeTask(`t${i}`, {
            chunks: [{ chunk_id: `t${i}#0`, duration_minutes: 120 }],
            // half the tasks may not start before the Wednesday event ends
            dependencies:
              i < 8 ? ([{ type: "after_event", ref: "ev", hard: true }] as never) : [],
          }),
        ),
      },
      { time_of_day_fit_per_15min: 1000 },
    );
    const baked = bakeProblem(problem);
    const kept = allTaskIndices(baked);
    const res = place(baked, kept, null, budget({ nodeCap: 0 }));
    expect(res.boundLift!).toBeGreaterThan(0);

    // Rebuild pass 2's working domains independently: the baked envelope
    // filtered by each task's own event-dependency floor.
    const unplaced: number[] = [];
    const domains: Array<{ slots: Int32Array; costs: Int32Array }> = [];
    for (const ti of kept) {
      const task = baked.tasks[ti]!;
      let floor = 0;
      for (const dep of task.deps) {
        if (dep.type === "after_event" && dep.eventEndSlot > floor) floor = dep.eventEndSlot;
      }
      for (const ci of task.chunkIndices) {
        const chunk = baked.chunks[ci]!;
        const keep: number[] = [];
        for (let i = 0; i < chunk.allowedStarts.length; i++) {
          if (chunk.allowedStarts[i]! >= floor) keep.push(i);
        }
        unplaced.push(ci);
        domains.push({
          slots: Int32Array.from(keep.map((i) => chunk.allowedStarts[i]!)),
          costs: Int32Array.from(keep.map((i) => chunk.cost[i]!)),
        });
      }
    }
    const occ = baked.externalMask;
    const state = optimizeMultipliers(
      baked,
      { occ, unplaced, domains, upperBound: res.cost },
      200,
    );
    expect(evaluateBound(baked, { occ, unplaced, domains }, state.lambda)).toBe(res.rootBound);
  });

  it("throttles the subgradient on a large root without the dual collapsing", () => {
    // The iteration budget is flat at 200 across the whole bench corpus, so
    // the throttle branch only ever meets an instance far larger than one —
    // 250 chunks × 672 live starts is 168 000 element visits per iteration,
    // which buys 119 of them. Measured: 9 139 607 throttled against
    // 10 244 724 at a generous 600, i.e. 89 % of the bound for 20 % of the
    // work. The failure this guards against is the count collapsing to
    // something that returns a useless dual on the first joint-solve-sized
    // problem to arrive.
    const problem = makeProblem(
      {
        contexts: [
          {
            context: "deep",
            fit_curve: { peak_start: "09:00", peak_end: "11:00", falloff_end: "13:00" },
            max_minutes_per_day: null,
            max_contiguous_minutes: null,
            over_daily_cap_penalty_per_15min: 25,
            over_streak_cap_penalty_per_15min: 25,
          },
        ] as never,
        tasks: Array.from({ length: 250 }, (_, i) =>
          makeTask(`t${i}`, { chunks: [{ chunk_id: `t${i}#0`, duration_minutes: 15 }] }),
        ),
      },
      { time_of_day_fit_per_15min: 1000 },
    );
    const baked = bakeProblem(problem);
    let work = 0;
    for (const chunk of baked.chunks) work += chunk.allowedStarts.length;
    expect(work).toBe(168_000);
    const throttled = iterationBudget(work);
    expect(throttled).toBe(119);
    expect(throttled).toBeGreaterThanOrEqual(50); // never below the spec band

    const residual = () => ({
      occ: baked.externalMask,
      unplaced: baked.chunks.map((c) => c.index),
    });
    const cheap = optimizeMultipliers(baked, residual(), throttled).bound;
    const generous = optimizeMultipliers(baked, residual(), 600).bound;
    expect(cheap).toBeGreaterThan(0);
    expect(cheap).toBeGreaterThanOrEqual(0.85 * generous);
  });

  it("sizes the subgradient budget by instance, inside the spec band", () => {
    expect(iterationBudget(1_000)).toBe(200); // small root: the 50–200 band's top
    expect(iterationBudget(100_000)).toBe(200); // exactly at the throttle's edge
    expect(iterationBudget(168_000)).toBe(119); // throttled
    expect(iterationBudget(10_000_000)).toBe(50); // floored, never below the band
    expect(iterationBudget(0)).toBe(50); // degenerate root
  });

  it("is bit-deterministic across runs", () => {
    const baked = bakeProblem(crowdedWeek(12, 120));
    const kept = allTaskIndices(baked);
    const runs = [0, 1].map(() => place(baked, kept, null, budget({ nodeCap: 200_000 })));
    const [a, b] = runs as [Pass2Result, Pass2Result];
    expect(Array.from(a.placement)).toEqual(Array.from(b.placement));
    expect(a.cost).toBe(b.cost);
    expect(a.nodes).toBe(b.nodes);
    expect(a.rootBound).toBe(b.rootBound);
    expect(a.boundLift).toBe(b.boundLift);
    expect(a.boundGap).toBe(b.boundGap);
    expect(a.proved).toBe(b.proved);
  });

  it("leaves a hook returning zero bit-identical, and honours a real one", () => {
    const baked = bakeProblem(crowdedWeek(12, 120));
    const kept = allTaskIndices(baked);
    const plain = place(baked, kept, null, budget({ nodeCap: 50_000 }));
    const zeroed = place(baked, kept, null, budget({ nodeCap: 50_000 }), {
      remainderBoundHook: () => 0,
    });
    expect(zeroed.rootBound).toBe(plain.rootBound);
    expect(zeroed.nodes).toBe(plain.nodes);
    expect(Array.from(zeroed.placement)).toEqual(Array.from(plain.placement));
    // an injected bound above the fused one must actually raise the root bound
    const injected = plain.rootBound! + 1000;
    const hooked = place(baked, kept, null, budget({ nodeCap: 50_000 }), {
      remainderBoundHook: () => injected,
    });
    expect(hooked.rootBound).toBe(injected);
    // ... but bound_lift means "what the Lagrangian added over the separable
    // term", and that is what the soak reads. A caller's injected bound is
    // neither, so it must not show up there.
    expect(hooked.boundLift).toBe(plain.boundLift);
  });
});

// ---------------------------------------------------------------------------
// 13. card D — LDS probes and frozen chunks (PlaceOptions become live)
// ---------------------------------------------------------------------------

/** Turn the D3 improvement phase off so a `place()` call is the bare search.
 * Every comparison in this section is about what the SEARCH does, so the
 * phase — which is itself built out of these two options — must not be the
 * thing that answers. */
const PHASE_OFF: Budget = { wallMs: 0, nodeCap: 0 };

/** A greedy trap: one shallow wrong choice the descent cannot see and the
 * value-ordered DFS cannot revisit inside a node budget.
 *
 * Six 60-minute chunks share a `deep` context capped at 300 min/day (20 slots)
 * at 100 per 15 min over. Five "filler" tasks may sit anywhere in 09:00–18:00
 * on Monday or Tuesday and carry a SOFT preferred window on Monday worth 500
 * per day of gap — Monday is where they belong, Tuesday is ruinous. The trap
 * task has exactly two legal starts (Mon 09:00, Tue 09:00) and no preferred
 * window at all, so both cost zero and the ascending-cost order takes the
 * earlier one.
 *
 * Greedy therefore parks the trap on Monday, the filler piles in behind it,
 * and Monday carries 24 slots against a cap of 20: cost 400. The optimum is
 * ZERO — trap on Tuesday, filler exactly filling Monday's cap — and the only
 * route to it is a deviation on the FIRST branched variable (the trap has the
 * smallest domain, so fail-first picks it at the root). Every deeper
 * deviation is either cost-neutral (shuffling filler inside Monday) or costs
 * 500 (filler onto Tuesday), which is exactly why plain DFS — which revisits
 * the shallowest choice last — cannot escape, and why a k = 1 discrepancy
 * probe can. */
function greedyTrap(): Problem {
  const filler = (i: number) =>
    makeTask(`f${i}`, {
      availability_windows: [
        { start: "2026-05-18T09:00:00", end: "2026-05-18T18:00:00" },
        { start: "2026-05-19T09:00:00", end: "2026-05-19T18:00:00" },
      ] as never,
      preferred_windows: [
        { days: ["mon"], start: "09:00", end: "18:00", hard: false },
      ] as never,
    });
  return makeProblem(
    {
      contexts: [
        {
          context: "deep",
          fit_curve: { peak_start: "09:00", peak_end: "18:00", falloff_end: "18:00" },
          max_minutes_per_day: 300,
          max_contiguous_minutes: null,
          over_daily_cap_penalty_per_15min: 100,
          over_streak_cap_penalty_per_15min: 0,
        },
      ] as never,
      tasks: [
        makeTask("trap", {
          availability_windows: [
            { start: "2026-05-18T09:00:00", end: "2026-05-18T10:00:00" },
            { start: "2026-05-19T09:00:00", end: "2026-05-19T10:00:00" },
          ] as never,
        }),
        ...[0, 1, 2, 3, 4].map(filler),
      ],
    },
    { preferred_day_miss: 500, preferred_time_miss_per_15min: 0 },
  );
}

describe("LDS — discrepancyLimit", () => {
  const NODES = 20_000;

  it("beats plain DFS on the greedy trap at an equal node budget", () => {
    const baked = bakeProblem(greedyTrap());
    const kept = allTaskIndices(baked);
    const dfs = place(baked, kept, null, budget({ nodeCap: NODES }), {
      improveBudget: PHASE_OFF,
    });
    const lds = place(baked, kept, null, budget({ nodeCap: NODES }), {
      improveBudget: PHASE_OFF,
      discrepancyLimit: 1,
    });

    // The greedy descent's own answer, which DFS never improves on here.
    expect(dfs.cost).toBe(400);
    expect(dfs.proved).toBe(false);
    assertLegal(baked, kept, dfs.placement);
    expect(dfs.cost).toBe(recomputeCost(baked, kept, dfs.placement));

    // One discrepancy at the root is the whole distance to the optimum.
    expect(lds.cost).toBe(0);
    expect(lds.cost).toBeLessThan(dfs.cost);
    assertLegal(baked, kept, lds.placement);
    expect(lds.cost).toBe(recomputeCost(baked, kept, lds.placement));
    expect(lds.nodes).toBeLessThanOrEqual(NODES);
  });

  it("k = 0 is exactly the greedy path, and never claims a certificate it lacks", () => {
    const baked = bakeProblem(greedyTrap());
    const kept = allTaskIndices(baked);
    const k0 = place(baked, kept, null, budget({ nodeCap: NODES }), {
      improveBudget: PHASE_OFF,
      discrepancyLimit: 0,
    });
    expect(k0.cost).toBe(400); // the descent's answer, unimproved
    expect(k0.proved).toBe(false); // a truncated tree proves nothing
  });

  it("a limit above every domain size leaves the search bit-identical", () => {
    // Discrepancy pruning that can never fire must not perturb anything: same
    // placement, same cost, same node count as the unlimited search.
    const baked = bakeProblem(greedyTrap());
    const kept = allTaskIndices(baked);
    const plain = place(baked, kept, null, budget({ nodeCap: 30_000 }), {
      improveBudget: PHASE_OFF,
    });
    const wide = place(baked, kept, null, budget({ nodeCap: 30_000 }), {
      improveBudget: PHASE_OFF,
      discrepancyLimit: 1_000_000,
    });
    expect(Array.from(wide.placement)).toEqual(Array.from(plain.placement));
    expect(wide.cost).toBe(plain.cost);
    expect(wide.nodes).toBe(plain.nodes);
    expect(wide.proved).toBe(plain.proved);
  });
});

describe("LNS — frozenChunks", () => {
  it("holds frozen starts byte-identical and re-solves only the freed set", () => {
    const baked = bakeProblem(greedyTrap());
    const kept = allTaskIndices(baked);
    const seed = place(baked, kept, null, budget({ nodeCap: 20_000 }), {
      improveBudget: PHASE_OFF,
    });
    expect(seed.cost).toBe(400); // the trapped incumbent

    // Free the trap chunk alone; everything else is pinned where it sits.
    const trapChunk = chunkIndex(baked, "trap", "trap#0");
    const frozen = Int32Array.from(seed.placement);
    frozen[trapChunk] = -1;

    const repaired = place(baked, kept, null, budget({ nodeCap: 20_000 }), {
      frozenChunks: frozen,
    });
    for (let ci = 0; ci < baked.chunks.length; ci++) {
      if (ci === trapChunk) continue;
      expect(repaired.placement[ci]).toBe(seed.placement[ci]);
    }
    // Monday is full, so the only improvement is the trap's other start.
    expect(repaired.placement[trapChunk]).toBe(slot(1, 9));
    expect(repaired.cost).toBe(0);
    expect(repaired.proved).toBe(true);
    assertLegal(baked, kept, repaired.placement);
    expect(repaired.cost).toBe(recomputeCost(baked, kept, repaired.placement));
  });

  it("a fully frozen placement is returned verbatim at its own cost", () => {
    const baked = bakeProblem(greedyTrap());
    const kept = allTaskIndices(baked);
    const seed = place(baked, kept, null, budget({ nodeCap: 20_000 }), {
      improveBudget: PHASE_OFF,
    });
    const pinned = place(baked, kept, null, budget({ nodeCap: 1_000 }), {
      frozenChunks: Int32Array.from(seed.placement),
    });
    expect(Array.from(pinned.placement)).toEqual(Array.from(seed.placement));
    expect(pinned.cost).toBe(seed.cost);
    expect(pinned.proved).toBe(true);
    expect(pinned.nodes).toBe(0); // nothing left to branch on
  });

  it("an unrealisable frozen start yields no incumbent rather than a lie", () => {
    const baked = bakeProblem(greedyTrap());
    const kept = allTaskIndices(baked);
    const frozen = new Int32Array(baked.chunks.length).fill(-1);
    // Slot 0 is 00:00 Monday — outside every task's availability window.
    frozen[chunkIndex(baked, "trap", "trap#0")] = 0;
    const res = place(baked, kept, null, budget({ nodeCap: 1_000 }), {
      frozenChunks: frozen,
    });
    expect(res.descents).toBe(0);
    expect(res.proved).toBe(false);
  });
});

describe("D3 phase driver", () => {
  it("spends nothing on improvement when the search certifies", () => {
    // The prod shape: root shortcut, zero nodes, certificate in hand.
    const p = makeProblem({ tasks: [makeTask("a"), makeTask("b")] });
    const baked = bakeProblem(p);
    const kept = allTaskIndices(baked);
    const res = place(baked, kept, null, budget());
    expect(res.proved).toBe(true);
    expect(res.improveIterations).toBe(0);
    expect(res.improveAccepted).toBe(0);
  });

  it("builds an incumbent from nothing when the descents ran out of wall", () => {
    // The card C pass-2 cliff in miniature: the clock is already past the
    // budget by the first sample, so both greedy descents abandon and the
    // proof search never gets an incumbent to prune against — descents 0,
    // which engine.ts serves as PASS1_FALLBACK. The phase's reserve is fresh
    // wall, and its bounded-discrepancy probe reaches a leaf where the plain
    // descent could not, so pass 2 has something to hand back after all.
    const baked = bakeProblem(greedyTrap());
    const kept = allTaskIndices(baked);
    const clock = () => {
      // 0 while the budget is stamped, then far past it: every wall check in the
      // proof half fails, while the phase — which re-stamps against its own
      // reserve — sees a stopped clock and gets its full share.
      calls++;
      return calls <= 1 ? 0 : 1e9;
    };
    let calls = 0;
    const bare = place(baked, kept, null, { wallMs: 100, nodeCap: 50_000, now: clock }, {
      improveBudget: PHASE_OFF,
    });
    expect(bare.descents).toBe(0);

    calls = 0;
    const withPhase = place(baked, kept, null, {
      wallMs: 100,
      nodeCap: 50_000,
      now: clock,
    });
    expect(withPhase.descents).toBeGreaterThan(0);
    expect(withPhase.improveIterations).toBeGreaterThan(0);
    assertLegal(baked, kept, withPhase.placement);
    expect(withPhase.cost).toBe(recomputeCost(baked, kept, withPhase.placement));
  });

  it("runs on the greedy trap and reports what it did", () => {
    const baked = bakeProblem(greedyTrap());
    const kept = allTaskIndices(baked);
    const res = place(baked, kept, null, budget({ nodeCap: 20_000 }));
    expect(res.improveIterations).toBeGreaterThan(0);
    expect(res.cost).toBeLessThan(400);
    assertLegal(baked, kept, res.placement);
    expect(res.cost).toBe(recomputeCost(baked, kept, res.placement));
  });
});

// ---------------------------------------------------------------------------
// 14. scoped budgets — withBudget
// ---------------------------------------------------------------------------

// The improvement phase, its probes and the proof search each borrow the
// instance's live budget fields and hand them back. Written by hand at three
// sites that pattern already shipped one bug (d0ffaa9), and none of the three
// restored on a throw. `withBudget` is the one place that arithmetic lives.

describe("withBudget", () => {
  const entry = () => ({
    wallMs: 5_000,
    nodeCap: 40_000,
    startedAt: 111,
    discrepancyLimit: -1,
  });

  it("applies the patch for the call and restores every field afterwards", () => {
    const scope = entry();
    const seen = withBudget(
      scope,
      { wallMs: 200, nodeCap: 1_000, startedAt: 999, discrepancyLimit: 2 },
      () => ({ ...scope }),
    );
    expect(seen).toEqual({
      wallMs: 200,
      nodeCap: 1_000,
      startedAt: 999,
      discrepancyLimit: 2,
    });
    expect(scope).toEqual(entry());
  });

  it("restores every field when the body THROWS, and rethrows", () => {
    const scope = entry();
    expect(() =>
      withBudget(scope, { wallMs: 1, nodeCap: 2, startedAt: 3, discrepancyLimit: 4 }, () => {
        throw new Error("phase blew up");
      }),
    ).toThrow("phase blew up");
    expect(scope).toEqual(entry());
  });

  it("leaves fields the patch does not name alone", () => {
    const scope = entry();
    const seen = withBudget(scope, { nodeCap: 7, discrepancyLimit: 1 }, () => ({ ...scope }));
    expect(seen).toEqual({
      wallMs: 5_000,
      nodeCap: 7,
      startedAt: 111,
      discrepancyLimit: 1,
    });
    expect(scope).toEqual(entry());
  });

  it("nests: each level restores what IT found, not the outermost entry", () => {
    const scope = entry();
    const inner = withBudget(scope, { nodeCap: 100 }, () => {
      const deepest = withBudget(scope, { nodeCap: 10 }, () => scope.nodeCap);
      return { deepest, afterInner: scope.nodeCap };
    });
    expect(inner).toEqual({ deepest: 10, afterInner: 100 });
    expect(scope).toEqual(entry());
  });

  it("returns the body's value untouched", () => {
    const scope = entry();
    expect(withBudget(scope, { wallMs: 1 }, () => "kept")).toBe("kept");
  });
});

describe("pass-2 budget mutation is scoped", () => {
  // The invariant behind finding (c), asserted structurally because it must
  // hold on EVERY path rather than on the ones a fixture happens to walk: the
  // four fields a phase borrows are assigned exactly once each — in the
  // constructor — so every later re-pointing goes through `withBudget` and is
  // restored in a `finally`. A new hand-written save/restore trips this.
  it("assigns each borrowed budget field exactly once, in the constructor", () => {
    // Comments are allowed to describe the old pattern; code is not allowed to
    // be it — same strip as the no-RNG check in improve.test.ts.
    const code = pass2Source.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    expect(code.length, "pass2.ts source did not load").toBeGreaterThan(100);
    for (const field of ["wallMs", "nodeCap", "startedAt", "discrepancyLimit"]) {
      // Compound assignment counts too: budget arithmetic in place (`+=`) is
      // the same hazard as a plain re-point. `(?!=)` keeps `==`/`===` out.
      const assignments = code.match(new RegExp(`this\\.${field}\\s*[+\\-*/%]?=(?!=)`, "g")) ?? [];
      expect(assignments, `this.${field} assignments`).toHaveLength(1);
    }
  });
});
