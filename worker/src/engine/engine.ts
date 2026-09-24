// Engine orchestration (card E — integration phase, main session).
//
// Composes substrate → pass 1 → MUS/demotion → pass 2 per the spec's
// proof-state table (internal design notes):
//
//   both passes proved (or root-closed)  → OPTIMAL   (the certificate case)
//   budget hit in either pass            → FEASIBLE  (+ bound_gap diagnostic)
//   pass 2 finished no descent at all    → PASS1_FALLBACK (pass-1 witness
//                                          served, pass2_wall reported as 0
//                                          — mirroring two_pass.py)
//   genuine conflict                     → unsat core (422 upstream)
//
// Drop reasons, contributing_constraints and the objective component
// recomputation mirror two_pass.py (`_build_fast_solution`,
// `_drop_contributing`, `_components_from_starts`). The separable
// fit/churn/soft-window split reuses the substrate's own arithmetic
// (`rawChunkFit` + the baked cost vector, soft-window taken as the exact
// residual) so the breakdown cannot drift from the search's cost model.

import {
  FitCurve,
  SLOTS_PER_DAY,
  bakeProblem,
  rawChunkFit,
  slotToDatetime,
} from "./substrate";
import { selectTasks } from "./pass1";
import { place } from "./pass2";
import { improve, improveAsync } from "./improve";
import { MUST_INCLUDE_UNPLACEABLE, resolveInfeasibility } from "./mus";
import type {
  Baked,
  Budget,
  DroppedTask,
  EngineBudgets,
  EngineResult,
  EngineStatus,
  ImproveResult,
  ObjectiveComponents,
  Pass2Result,
  Placement,
  Problem,
  ScheduledChunk,
  Solution,
  SubsolveRequest,
  SubsolveResult,
  UnsatItem,
} from "./types";

/** Mirrors the container's PASS1/PASS2_TIME_LIMIT_S = 20 s defaults; node
 * caps are backstops well above anything the prod instance class reaches. */
export const DEFAULT_BUDGETS: EngineBudgets = {
  pass1: { wallMs: 20_000, nodeCap: 5_000_000 },
  pass2: { wallMs: 20_000, nodeCap: 5_000_000 },
  mus: { wallMs: 20_000, nodeCap: 100_000 },
};

/** D4 budget controller (card F, internal design notes).
 *
 * Splits the pass-2 budget once the root evaluation has produced a bound
 * and an incumbent — in practice NODES, since the improvement phase is
 * node-budgeted by the card E determinism adjudication and the wall is only
 * a safety valve — between the LNS improvement phase and the single proof
 * search that follows it, in proportion to the RELATIVE root gap:
 *
 *   gap closed (incumbent ≤ bound)  → all proof: certificate territory, the
 *                                     phase has nothing to add;
 *   no incumbent (`Infinity`)       → the ceiling share to the phase, which
 *                                     is what recovers one;
 *   otherwise                       → improve share = relative gap, clamped
 *                                     to [1/4, 3/4] so neither side is ever
 *                                     starved outright.
 *
 * Deterministic, integer, conserving (`proof + improve === remaining`), and
 * knob-free — the three public budget vars stay the whole tuning surface. */
export function splitPass2Budget(
  rootBound: number,
  rootIncumbent: number,
  remaining: number,
): { proof: number; improve: number } {
  if (remaining <= 0) return { proof: 0, improve: 0 };
  if (rootIncumbent <= rootBound) return { proof: remaining, improve: 0 };
  if (remaining === Infinity) return { proof: Infinity, improve: Infinity };
  const relGap =
    rootIncumbent === Infinity
      ? 1
      : (rootIncumbent - rootBound) / Math.max(rootIncumbent, 1);
  const share = Math.min(0.75, Math.max(0.25, relGap));
  const improve = Math.floor(remaining * share);
  return { proof: remaining - improve, improve };
}

/** Pass 1 + the MUS detour, shared by the sync and fan-out entry points. */
type Selection =
  | { kind: "unsat"; core: UnsatItem[] }
  | {
      kind: "selected";
      baked: Baked;
      pass1: ReturnType<typeof selectTasks>;
      demoted: Map<number, string>;
      musNodes: number;
      pass1Wall: number;
    };

function runSelection(problem: Problem, budgets: EngineBudgets): Selection {
  const baked = bakeProblem(problem);

  // Overlapping immovable externals: the one unconditional-UNSAT case,
  // detected by the substrate's interval sweep before any search.
  if (baked.externalOverlapCore !== null) {
    return { kind: "unsat", core: baked.externalOverlapCore };
  }

  const clock1 = budgets.pass1.now ?? Date.now;
  const t0 = clock1();
  let pass1 = selectTasks(baked, budgets.pass1);
  const demoted = new Map<number, string>();
  let musNodes = 0;

  // Two routes into the MUS layer: a must_include conflict, or a seed pack
  // abandoned before deciding whether the must set packs at all (an
  // undecided pass 1 must never be served as a plan).
  if (pass1.infeasible || (!pass1.proved && !pass1.seedDecided)) {
    const outcome = resolveInfeasibility(baked, budgets.mus, budgets.pass1);
    musNodes = outcome.nodes;
    if (outcome.core !== null) {
      // Genuine 422. Demotions that happened along the way are discarded,
      // exactly as two_pass.py returns only the core on this path.
      return { kind: "unsat", core: outcome.core };
    }
    pass1 = outcome.pass1!;
    for (const [index, reason] of outcome.demoted) demoted.set(index, reason);
  }
  const pass1Wall = (clock1() - t0) / 1000;
  return { kind: "selected", baked, pass1, demoted, musNodes, pass1Wall };
}

/** What one pass-2 phase (first search → LNS → re-prove) concluded. */
export interface PhaseOutcome {
  placement: Placement;
  cost: number;
  proved: boolean;
  /** The result carrying the freshest bound knowledge (for bound_gap). */
  source: Pass2Result;
  root: Pass2Result;
  nodes: number;
  improveIterations: number;
  improveAccepted: number;
  fanoutSubsolves: number;
}

const PHASE_OFF: Budget = { wallMs: 0, nodeCap: 0 };

/** The pipeline's first step: witness/greedy descents, the root scan and the
 * Lagrangian, at ZERO search nodes (a nodeCap-0 search aborts at its first
 * node, recording the root bound as abandoned). Cheap by construction —
 * measured ~8 ms/node for a seeded proof search on the heavy tier, the whole
 * reason the pipeline improves FIRST and proves ONCE (a first proof pass
 * whose shallow frontier gets re-explored by a re-prove pass doubled the
 * expensive nodes for nothing). The root shortcut still certifies here in
 * zero nodes when the descent incumbent meets the bound — the prod fast
 * path is untouched. */
function rootEvaluation(
  baked: Baked,
  pass1: ReturnType<typeof selectTasks>,
  p2: Budget,
): Pass2Result {
  return place(
    baked,
    pass1.kept,
    pass1.witness,
    { wallMs: p2.wallMs, nodeCap: 0, ...(p2.now === undefined ? {} : { now: p2.now }) },
    { externalLns: true, improveBudget: PHASE_OFF },
  );
}

/** The lower bound a finished (unproved) search established: its incumbent
 * minus its reported gap, i.e. `min(minAbandoned, incumbent)`. */
function boundOf(result: Pass2Result): number {
  return result.cost - result.boundGap;
}

/** The single proof search's budget: every node the LNS did not spend, and
 * whatever wall remains as the safety valve. A wall already exhausted skips
 * the proof rather than paying a bake for an instant timeout. */
function proofBudget(
  p2: Budget,
  spentNodes: number,
  clock: () => number,
  startedAt: number,
): Budget | null {
  const nodeCap = p2.nodeCap === Infinity ? Infinity : Math.max(0, p2.nodeCap - spentNodes);
  if (nodeCap <= 0) return null;
  const wallMs =
    p2.wallMs === Infinity ? Infinity : Math.max(0, p2.wallMs - (clock() - startedAt));
  if (wallMs <= 0) return null;
  return { wallMs, nodeCap, ...(p2.now === undefined ? {} : { now: p2.now }) };
}

/** The one job a phase hands out: improve this incumbent within this many
 * nodes. Whoever drives the generator decides who runs it. */
interface ImproveJob {
  placement: Placement;
  cost: number;
  nodeCap: number;
}

/** The phase schedule — root evaluation, the controller split, the LNS job,
 * the single proof search — written ONCE. It yields the LNS job (the phase's
 * only async point) and receives that job's result, so the sync and fan-out
 * drivers below cannot drift apart: the flag changes who runs the LNS, never
 * the schedule around it. Same shape improve.ts uses for `improveRounds`. */
function* pass2PhaseSteps(
  baked: Baked,
  pass1: ReturnType<typeof selectTasks>,
  p2: Budget,
): Generator<ImproveJob, PhaseOutcome, ImproveResult> {
  const clock = p2.now ?? Date.now;
  const startedAt = clock();
  const place0 = rootEvaluation(baked, pass1, p2);
  const out = phaseSeed(place0);
  if (out.proved || place0.descents === 0) return out;

  const split = splitPass2Budget(place0.rootBound ?? 0, out.cost, p2.nodeCap);
  if (split.improve > 0) {
    const imp = yield { placement: out.placement, cost: out.cost, nodeCap: split.improve };
    applyImprovement(out, imp, boundOf(place0));
  }
  if (!out.proved) {
    const budget = proofBudget(p2, out.nodes, clock, startedAt);
    if (budget !== null) {
      const proof = place(baked, pass1.kept, out.placement, budget, {
        externalLns: true,
        improveBudget: PHASE_OFF,
      });
      applyProof(out, proof);
    }
  }
  return out;
}

/** Drives the phase with the in-process LNS. Fully synchronous — `solveProblem`
 * is, and nothing on this path may become a Promise. */
export function pass2PhaseSync(
  baked: Baked,
  pass1: ReturnType<typeof selectTasks>,
  p2: Budget,
): PhaseOutcome {
  const gen = pass2PhaseSteps(baked, pass1, p2);
  let step = gen.next();
  while (!step.done) {
    const job = step.value;
    step = gen.next(
      improve(baked, pass1.kept, job.placement, job.cost, {
        wallMs: Infinity,
        nodeCap: job.nodeCap,
      }),
    );
  }
  return step.value;
}

/** Drives the same phase with the LNS awaited over card E's fan-out session. */
export async function pass2PhaseFanout(
  baked: Baked,
  pass1: ReturnType<typeof selectTasks>,
  p2: Budget,
  batch: (requests: readonly SubsolveRequest[]) => Promise<SubsolveResult[]>,
): Promise<PhaseOutcome> {
  const gen = pass2PhaseSteps(baked, pass1, p2);
  let step = gen.next();
  while (!step.done) {
    const job = step.value;
    step = gen.next(
      await improveAsync(
        baked,
        pass1.kept,
        job.placement,
        job.cost,
        { wallMs: Infinity, nodeCap: job.nodeCap },
        batch,
      ),
    );
  }
  return step.value;
}

function phaseSeed(root: Pass2Result): PhaseOutcome {
  return {
    placement: root.placement,
    cost: root.cost,
    proved: root.proved,
    source: root,
    root,
    nodes: root.nodes,
    improveIterations: root.improveIterations,
    improveAccepted: root.improveAccepted,
    fanoutSubsolves: root.fanoutSubsolves,
  };
}

function applyImprovement(out: PhaseOutcome, imp: ImproveResult, bound1: number): void {
  out.nodes += imp.nodes;
  out.improveIterations += imp.iterations;
  out.improveAccepted += imp.accepted;
  out.fanoutSubsolves += imp.fanoutSubsolves;
  if (imp.cost < out.cost) {
    out.placement = imp.placement;
    out.cost = imp.cost;
    // The first search's abandoned-bound floor is a valid lower bound for the
    // whole subproblem; an incumbent that reaches it is proved without any
    // further search (deadline_soft-heavy's bound-0 certificate).
    if (out.cost <= bound1) out.proved = true;
  }
}

function applyProof(out: PhaseOutcome, proof: Pass2Result): void {
  out.nodes += proof.nodes;
  if (proof.descents === 0) return;
  // The proof search was seeded with the phase incumbent, so its own
  // incumbent can only be equal or better; its tree also carries the
  // freshest bound.
  out.placement = proof.placement;
  out.cost = proof.cost;
  out.proved = proof.proved;
  out.source = proof;
}

export function solveProblem(
  problem: Problem,
  budgets: EngineBudgets = DEFAULT_BUDGETS,
): EngineResult {
  const selected = runSelection(problem, budgets);
  if (selected.kind === "unsat") return unsat(selected.core);
  const { baked, pass1, demoted, musNodes, pass1Wall } = selected;

  const clock2 = budgets.pass2.now ?? Date.now;
  const t0 = clock2();
  const phase = pass2PhaseSync(baked, pass1, budgets.pass2);
  const pass2Wall = (clock2() - t0) / 1000;
  return assemble(baked, pass1, demoted, musNodes, pass1Wall, pass2Wall, phase);
}

/** Fan-out entry point (card E/F): identical to `solveProblem` except the
 * LNS loop awaits the batched sub-solver. With an in-process batch the
 * answer is bit-identical to the sync path (controller test suite). */
export async function solveProblemFanout(
  problem: Problem,
  budgets: EngineBudgets,
  batch: (requests: readonly SubsolveRequest[]) => Promise<SubsolveResult[]>,
): Promise<EngineResult> {
  const selected = runSelection(problem, budgets);
  if (selected.kind === "unsat") return unsat(selected.core);
  const { baked, pass1, demoted, musNodes, pass1Wall } = selected;

  const clock2 = budgets.pass2.now ?? Date.now;
  const t0 = clock2();
  const phase = await pass2PhaseFanout(baked, pass1, budgets.pass2, batch);
  const pass2Wall = (clock2() - t0) / 1000;
  return assemble(baked, pass1, demoted, musNodes, pass1Wall, pass2Wall, phase);
}

function assemble(
  baked: Baked,
  pass1: ReturnType<typeof selectTasks>,
  demoted: Map<number, string>,
  musNodes: number,
  pass1Wall: number,
  pass2Wall: number,
  phase: PhaseOutcome,
): EngineResult {
  const nodes = pass1.nodes + musNodes + phase.nodes;

  if (phase.root.descents === 0) {
    // Pass 2 never completed a single descent, even from the pass-1 witness
    // seed (an unrealisable partition, or a broken witness): fall back to the
    // witness itself, like the container falls back to its pass-1 placements.
    // A null witness would mean an undecided pass 1 reached pass 2, which the
    // MUS detour rules out; it is an internal inconsistency worth crashing on.
    const witness = pass1.witness;
    if (witness === null) {
      throw new Error("engine: undecided pass-1 partition reached PASS1_FALLBACK");
    }
    return solution(
      baked,
      witness,
      pass1.kept,
      demoted,
      "PASS1_FALLBACK",
      pass1Wall,
      0,
      undefined,
      nodes,
      phase,
    );
  }

  const proved = pass1.proved && phase.proved;
  const status: EngineStatus = proved ? "OPTIMAL" : "FEASIBLE";
  // bound_gap covers pass 2's search over the certified partition. When
  // pass 1 itself is uncertified the true gap is UNKNOWN — omit the field
  // rather than emit pass 2's (possibly 0) gap, which would read as
  // "certified after all" (card F smoke finding).
  const boundGap = proved
    ? 0
    : pass1.proved
      ? Math.max(0, phase.cost - Math.min(boundOf(phase.source), phase.cost))
      : undefined;
  return solution(
    baked,
    phase.placement,
    pass1.kept,
    demoted,
    status,
    pass1Wall,
    pass2Wall,
    boundGap,
    nodes,
    phase,
  );
}

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

function unsat(core: UnsatItem[]): EngineResult {
  return { kind: "unsat", response: { unsat_core: core } };
}

function solution(
  baked: Baked,
  placement: Placement,
  kept: readonly number[],
  demoted: Map<number, string>,
  status: EngineStatus,
  pass1Wall: number,
  pass2Wall: number,
  boundGap: number | undefined,
  nodes: number,
  phase: PhaseOutcome,
): EngineResult {
  const problem = baked.problem;
  const origin = problem.window.start;
  const keptSet = new Set(kept);

  const schedule: ScheduledChunk[] = [];
  for (const task of baked.tasks) {
    if (!keptSet.has(task.index)) continue;
    for (const ci of task.chunkIndices) {
      const chunk = baked.chunks[ci]!;
      schedule.push({
        task_id: task.id,
        chunk_id: chunk.chunkId,
        start: slotToDatetime(placement[ci]!, origin) as ScheduledChunk["start"],
        duration_minutes: chunk.durationMinutes,
        context: task.context,
      });
    }
  }

  const dropped: DroppedTask[] = [];
  for (const task of baked.tasks) {
    if (keptSet.has(task.index)) continue;
    const wire = problem.tasks[task.index]!;
    const contributing: string[] = [];
    if (wire.deadline != null && !wire.deadline.hard) contributing.push("soft_deadline");
    if (wire.preferred_windows.some((w) => !w.hard)) contributing.push("preferred_window");
    dropped.push({
      task_id: task.id,
      title: task.title,
      drop_cost: task.dropWeight,
      reason: demoted.has(task.index)
        ? MUST_INCLUDE_UNPLACEABLE
        : "drop_was_cheaper_than_alternatives",
      contributing_constraints: contributing,
    });
  }

  const components = componentsFromPlacement(baked, placement, keptSet);
  const total =
    components.lateness +
    components.fit +
    components.churn +
    components.daily_cap +
    components.streak_cap +
    components.drop +
    components.preferred_window;

  const sol: Solution = {
    schedule,
    dropped,
    objective: { total, components },
    diagnostics: {
      pass1_wall_seconds: pass1Wall,
      pass2_wall_seconds: pass2Wall,
      status,
      ...(boundGap === undefined ? {} : { bound_gap: boundGap }),
      nodes,
      // Search-strengthening instrumentation (card A). Root fields exist
      // only where the FIRST pass-2 search measured them (the re-prove pass
      // is seeded, so its root is not the instance's root); the phase
      // counters aggregate the whole phase — probes inside pass 2 plus the
      // engine-level LNS — and are hard zeros wherever the D3 phase did not
      // run, every certified solve included.
      ...(phase.root.rootBound === undefined
        ? {}
        : { root_bound: phase.root.rootBound }),
      ...(phase.root.rootIncumbent === undefined
        ? {}
        : { root_incumbent: phase.root.rootIncumbent }),
      ...(phase.root.boundLift === undefined
        ? {}
        : { bound_lift: phase.root.boundLift }),
      improve_iterations: phase.improveIterations,
      improve_accepted: phase.improveAccepted,
      fanout_subsolves: phase.fanoutSubsolves,
    },
  };
  return { kind: "solution", solution: sol };
}

/** Port of two_pass._components_from_starts: recompute every objective
 * component from the concrete placement. The separable trio is split by
 * recomputing fit (via the substrate's own `rawChunkFit`) and churn from
 * the baked metadata, and reading soft-window as the exact residual of the
 * baked cost vector — the three summed there in the first place. */
export function componentsFromPlacement(
  baked: Baked,
  placement: Placement,
  keptSet: ReadonlySet<number>,
): ObjectiveComponents {
  const problem = baked.problem;
  const weights = problem.weights;
  const fitWeight = weights.time_of_day_fit_per_15min;
  const churnWeight = weights.churn_per_15min_moved;

  const curves = new Map<string, FitCurve>();
  if (fitWeight) {
    for (const cfg of problem.contexts) {
      curves.set(cfg.context, new FitCurve(cfg.fit_curve));
    }
  }

  let lateness = 0;
  let fit = 0;
  let churn = 0;
  let streakCap = 0;
  let drop = 0;
  let preferred = 0;

  for (const task of baked.tasks) {
    if (!keptSet.has(task.index)) {
      drop += task.dropWeight;
      continue;
    }

    if (task.hasSoftDeadline) {
      let endMax: number;
      if (task.ordered) {
        const last = baked.chunks[task.chunkIndices[task.chunkIndices.length - 1]!]!;
        endMax = placement[last.index]! + last.durationSlots;
      } else {
        endMax = -Infinity;
        for (const ci of task.chunkIndices) {
          const c = baked.chunks[ci]!;
          const e = placement[ci]! + c.durationSlots;
          if (e > endMax) endMax = e;
        }
      }
      lateness += Math.max(0, endMax - task.deadlineSlot) * task.deadlinePenaltyPer15;
    }

    const curve = curves.get(task.context);
    const ctx = baked.contexts[task.contextIndex];
    const taskChurnWeight = churnWeight * task.churnMultiplier;
    for (const ci of task.chunkIndices) {
      const chunk = baked.chunks[ci]!;
      const s = placement[ci]!;
      // Invariant guard: both searches emit subsets of allowedStarts, so a
      // miss can only mean a broken placement — fail loudly rather than let
      // cost[-1] (undefined) NaN-poison the objective on the wire.
      const idx = chunk.allowedStarts.indexOf(s);
      if (idx < 0) {
        throw new Error(
          `engine: ${task.id}/${chunk.chunkId} start ${s} is outside its baked domain`,
        );
      }

      let fitHere = 0;
      if (curve !== undefined) {
        fitHere = fitWeight * rawChunkFit(curve, baked.slotTod[s]!, chunk.durationMinutes);
        fit += fitHere;
      }
      let churnHere = 0;
      if (taskChurnWeight !== 0 && chunk.prevSlot >= 0) {
        churnHere = taskChurnWeight * Math.abs(s - chunk.prevSlot);
        churn += churnHere;
      }
      // Soft-window: exact residual of the baked separable cost.
      preferred += chunk.cost[idx]! - fitHere - churnHere;

      if (ctx !== undefined && ctx.streakCapSlots >= 0 && chunk.durationSlots > ctx.streakCapSlots) {
        streakCap += (chunk.durationSlots - ctx.streakCapSlots) * ctx.streakCapPenaltyPer15;
      }
    }
  }

  // Daily caps: exact slot overlap per (context, day).
  let dailyCap = 0;
  const days = baked.horizon / SLOTS_PER_DAY;
  for (let ctxIdx = 0; ctxIdx < baked.contexts.length; ctxIdx++) {
    const ctx = baked.contexts[ctxIdx]!;
    if (ctx.dailyCapSlots < 0 || ctx.dailyCapPenaltyPer15 === 0) continue;
    for (let d = 0; d < days; d++) {
      const lo = d * SLOTS_PER_DAY;
      const hi = lo + SLOTS_PER_DAY;
      let used = 0;
      for (const task of baked.tasks) {
        if (task.contextIndex !== ctxIdx || !keptSet.has(task.index)) continue;
        for (const ci of task.chunkIndices) {
          const c = baked.chunks[ci]!;
          const s = placement[ci]!;
          used += Math.max(0, Math.min(s + c.durationSlots, hi) - Math.max(s, lo));
        }
      }
      dailyCap += Math.max(0, used - ctx.dailyCapSlots) * ctx.dailyCapPenaltyPer15;
    }
  }

  return {
    lateness,
    fit,
    churn,
    daily_cap: dailyCap,
    streak_cap: streakCap,
    drop,
    preferred_window: preferred,
  };
}
