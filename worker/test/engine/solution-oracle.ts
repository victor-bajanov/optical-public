// A solveProblem-level oracle: recover the chunk-indexed placement from a
// Solution's schedule, check it against the hard constraints, and recompute
// the FULL objective — drop cost included — from the baked tables.
//
// This is deliberately not pass2.test.ts's `recomputeCost`, which is the
// place()-level, drop-exclusive oracle for a placement the caller already
// holds. What a canary needs is the other one: given only what the engine
// returned over the wire, is the schedule legal, and is `objective.total` the
// number that schedule actually costs? A "no worse than baseline" assertion is
// worth nothing if a cheaper objective can be bought with an illegal placement
// or a mis-added total.
//
// The arithmetic is transcribed from the Python authority
// (solver/src/solver/objective.py, two_pass._components_from_starts), same as
// the pass-2 suite's, and never read back out of the engine.

import { expect } from "vitest";
import { SLOTS_PER_DAY } from "../../src/engine/substrate";
import type { Baked, Placement, Solution } from "../../src/engine/types";

/** Rebuild the chunk-indexed placement from a Solution's schedule. Every
 * scheduled chunk must name a chunk the bake knows and land on a slot
 * boundary; -1 marks the chunks of dropped tasks. */
export function placementOf(baked: Baked, solution: Solution): Placement {
  const placement = new Int32Array(baked.chunks.length).fill(-1);
  const windowStart = Date.parse(`${baked.problem.window.start}Z`);
  for (const scheduled of solution.schedule) {
    const key = `${scheduled.task_id} ${scheduled.chunk_id}`;
    const ci = baked.chunkIndexByKey.get(key);
    expect(ci, `schedule names an unknown chunk: ${key}`).not.toBeUndefined();
    const offsetMs = Date.parse(`${scheduled.start}Z`) - windowStart;
    const slot = offsetMs / (15 * 60 * 1000);
    expect(Number.isInteger(slot), `${key} starts off the 15-minute grid`).toBe(true);
    placement[ci!] = slot;
  }
  return placement;
}

/** The kept set implied by a Solution: every task not in `dropped`. */
export function keptOf(baked: Baked, solution: Solution): number[] {
  const dropped = new Set(solution.dropped.map((d) => d.task_id));
  return baked.tasks.filter((t) => !dropped.has(t.id)).map((t) => t.index);
}

/** Hard-constraint legality over the kept set: domain membership, no-overlap
 * against externals and each other, group policy, and hard dependencies. */
export function assertScheduleLegal(
  baked: Baked,
  kept: readonly number[],
  placement: Placement,
  label: string,
): void {
  const keptSet = new Set(kept);
  const occupied = new Map<number, string>();
  for (let s = 0; s < baked.horizon; s++) {
    if ((baked.externalMask[s >> 5]! >>> (s & 31)) & 1) occupied.set(s, "external");
  }
  for (const ti of kept) {
    const task = baked.tasks[ti]!;
    for (const ci of task.chunkIndices) {
      const chunk = baked.chunks[ci]!;
      const start = placement[ci]!;
      expect(
        Array.from(chunk.allowedStarts),
        `${label}: ${task.id}/${chunk.chunkId} start ${start} outside its domain`,
      ).toContain(start);
      for (let s = start; s < start + chunk.durationSlots; s++) {
        expect(
          occupied.has(s),
          `${label}: ${task.id}/${chunk.chunkId} overlaps ${occupied.get(s)} at slot ${s}`,
        ).toBe(false);
        occupied.set(s, `${task.id}/${chunk.chunkId}`);
      }
    }
    if (task.sameDay) {
      const days = task.chunkIndices.map((ci) => Math.floor(placement[ci]! / SLOTS_PER_DAY));
      expect(new Set(days).size, `${label}: ${task.id} same_day`).toBe(1);
    }
    if (task.ordered) {
      for (let k = 1; k < task.chunkIndices.length; k++) {
        const prev = task.chunkIndices[k - 1]!;
        const next = task.chunkIndices[k]!;
        expect(
          placement[prev]! + baked.chunks[prev]!.durationSlots,
          `${label}: ${task.id} ordered`,
        ).toBeLessThanOrEqual(placement[next]!);
      }
    }
    for (const dep of task.deps) {
      const first = task.chunkIndices[0]!;
      const last = task.chunkIndices[task.chunkIndices.length - 1]!;
      const firstStart = placement[first]!;
      const lastEnd = placement[last]! + baked.chunks[last]!.durationSlots;
      if (dep.type === "after_event") {
        expect(firstStart, `${label}: ${task.id} after_event`).toBeGreaterThanOrEqual(
          dep.eventEndSlot,
        );
      } else if (dep.type === "before_event") {
        expect(lastEnd, `${label}: ${task.id} before_event`).toBeLessThanOrEqual(
          dep.eventStartSlot,
        );
      } else if (dep.taskIndex >= 0 && keptSet.has(dep.taskIndex)) {
        const other = baked.tasks[dep.taskIndex]!;
        const otherFirst = other.chunkIndices[0]!;
        const otherLast = other.chunkIndices[other.chunkIndices.length - 1]!;
        if (dep.type === "after_task") {
          expect(firstStart, `${label}: ${task.id} after_task`).toBeGreaterThanOrEqual(
            placement[otherLast]! + baked.chunks[otherLast]!.durationSlots,
          );
        } else {
          expect(lastEnd, `${label}: ${task.id} before_task`).toBeLessThanOrEqual(
            placement[otherFirst]!,
          );
        }
      }
    }
  }
}

/** The full objective — separable table + streak constant + lateness + daily
 * caps + drop weights — recomputed from the baked tables. */
export function recomputeTotal(
  baked: Baked,
  kept: readonly number[],
  placement: Placement,
): number {
  let total = 0;
  const keptSet = new Set(kept);
  for (const ti of kept) {
    const task = baked.tasks[ti]!;
    const ctx = task.contextIndex >= 0 ? baked.contexts[task.contextIndex]! : null;
    for (const ci of task.chunkIndices) {
      const chunk = baked.chunks[ci]!;
      const i = chunk.allowedStarts.indexOf(placement[ci]!);
      total += chunk.cost[i]!;
      if (ctx !== null && ctx.streakCapSlots >= 0 && chunk.durationSlots > ctx.streakCapSlots) {
        total += (chunk.durationSlots - ctx.streakCapSlots) * ctx.streakCapPenaltyPer15;
      }
    }
    if (task.hasSoftDeadline) {
      const last = task.chunkIndices[task.chunkIndices.length - 1]!;
      const ends = task.ordered
        ? [placement[last]! + baked.chunks[last]!.durationSlots]
        : task.chunkIndices.map((ci) => placement[ci]! + baked.chunks[ci]!.durationSlots);
      total += Math.max(0, Math.max(...ends) - task.deadlineSlot) * task.deadlinePenaltyPer15;
    }
  }
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
          const s = placement[ci]!;
          used += Math.max(0, Math.min(s + baked.chunks[ci]!.durationSlots, hi) - Math.max(s, lo));
        }
      }
      total += Math.max(0, used - ctx.dailyCapSlots) * ctx.dailyCapPenaltyPer15;
    }
  }
  for (const task of baked.tasks) {
    if (!keptSet.has(task.index)) total += task.dropWeight;
  }
  return total;
}
