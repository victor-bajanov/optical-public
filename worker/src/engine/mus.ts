// MUS extraction + guarded demotion (card D).
//
// Mirrors the Python reference: solver/src/solver/model.py supplies the
// ASSUMPTION_* vocabulary and decides what each assumption attaches to;
// solver/src/solver/two_pass.py supplies the outer loop (`_solve_fast`'s
// INFEASIBLE branch), `_isolation_feasible`, and `_extract_unsat_core`.
//
// CP-SAT gets its core from `SufficientAssumptionsForInfeasibility`, which is
// sufficient but not necessarily minimal. There is no assumption machinery
// here, so the core comes from the classic destructive (deletion) algorithm
// instead: walk the active assumptions once, drop each in turn, and keep it
// only when the remainder becomes feasible. That yields a genuine MUS — parity
// with the reference is "covers the same conflict", not set-equality (plan
// Decisions #2).
//
// A "deletion" is a JSON-level transform of the wire problem followed by a
// re-bake; baking is cheap at these sizes, and it keeps every relaxation
// honest (no surgical mutation of a Baked, which would have to re-derive the
// bake's own coupling rules by hand). The feasibility oracle is
// `packFeasible` over the must_include set: every other task can always be
// dropped, so pass 1 is feasible exactly when the mandatory set packs — the
// same reduction `selectTasks` makes for its seed.
//
// COST SHAPE. A single deletion test is unbudgeted CPU by construction:
// `packFeasible` is definite by contract (Card B), because a test that gave up
// would make the core unsound rather than merely non-minimal. Budget is
// therefore checked only BETWEEN tests. On the in-production problem class a
// test is sub-millisecond, but on an adversarial instance — availability
// crowding that only a full DFS can refute — one test can run for seconds or
// minutes, and neither `wallMs` nor `nodeCap` will interrupt it.

import { packFeasible, selectTasks } from "./pass1";
import { bakeProblem } from "./substrate";
import type {
  Baked,
  Budget,
  MusOutcome,
  Placement,
  Problem,
  UnsatItem,
} from "./types";

export const MUST_INCLUDE_UNPLACEABLE = "must_include_unplaceable_in_isolation";

type WireTask = Problem["tasks"][number];

// ---------------------------------------------------------------------------
// Assumption registry
// ---------------------------------------------------------------------------

/** One deletable hard commitment, keyed so the reduction can look it up. */
interface Assumption {
  key: string;
  item: UnsatItem;
}

function taskKey(type: string, taskIndex: number): string {
  return `${type}#${taskIndex}`;
}

function depKey(taskIndex: number, depIndex: number): string {
  return `hard_dependency#${taskIndex}#${depIndex}`;
}

function externalKey(eventId: string): string {
  return `external_pinned#${eventId}`;
}

/** The active assumptions, in model.py's build order: per task (task_present,
 * pinned_at, group policy, hard deadline, earliest_start, hard preferred
 * window, availability mask, business hours), then the external events, then
 * the hard dependencies — which model.py also adds last, once every chunk
 * variable exists. Order decides *which* MUS is found when several exist, so
 * it is pinned to the reference's rather than left incidental.
 *
 * Only assumptions the oracle can actually consult are registered. The oracle
 * packs the must_include set, so a droppable task's own constraints can never
 * flip a deletion test — enumerating them would be pure noise that also eats
 * the budget before the real conflict is reached. Concretely: task-level
 * assumptions only for must_include tasks; every external event (occupancy
 * constrains any mandatory task); and a hard dependency only when its
 * declaring task is mandatory AND it can bind — an event dependency always
 * can (it is unary, folded into the task's own domain), a task dependency only
 * when the referenced task is mandatory too (pass1 gates the binary constraint
 * on both endpoints being in the set).
 *
 * Divergences from model.py, all immaterial to the core:
 *  - model.py registers one literal per (task, chunk) for the chunk-level
 *    assumptions; those collapse to a single UnsatItem on the wire (there is
 *    no chunk_id field), so one assumption per task is registered here.
 *  - model.py registers literals for droppable tasks and for dependencies that
 *    cannot bind; being unconstraining, they could never survive a destructive
 *    walk, so skipping them changes only the cost, never the result. */
function enumerateAssumptions(baked: Baked): Assumption[] {
  const src = baked.problem;
  const out: Assumption[] = [];

  for (let ti = 0; ti < baked.tasks.length; ti++) {
    const bt = baked.tasks[ti]!;
    if (!bt.mustInclude) continue;
    const task = src.tasks[ti]!;
    const push = (type: string, extra: Partial<UnsatItem> = {}): void => {
      out.push({ key: taskKey(type, ti), item: { type, task_id: bt.id, ...extra } });
    };

    push("task_present");
    if (bt.pinnedSlot >= 0) push("pinned_at", { value: task.pinned_at });
    if (bt.chunkIndices.length >= 2) {
      if (bt.sameDay) push("group_same_day");
      if (bt.ordered) push("group_ordered");
    }
    if (bt.deadlineHard) push("hard_deadline", { value: task.deadline?.at });
    // model.py skips earliest_start at or before the window start.
    if (bt.earliestStartSlot > 0) push("earliest_start", { value: task.earliest_start });
    if (bt.hasHardWindows) push("hard_preferred_window");
    if (bt.hasAvailability) push("availability_window");
    if (bt.usedBusinessHours) push("business_hours");
  }

  for (const ev of src.external_pinned) {
    out.push({
      key: externalKey(ev.id),
      item: { type: "external_pinned", task_id: ev.id, value: ev.start },
    });
  }

  for (let ti = 0; ti < src.tasks.length; ti++) {
    if (!baked.tasks[ti]!.mustInclude) continue;
    const task = src.tasks[ti]!;
    for (let k = 0; k < task.dependencies.length; k++) {
      const dep = task.dependencies[k]!;
      if (!dep.hard) continue; // soft dependencies are ignored everywhere
      if (dep.type === "after_task" || dep.type === "before_task") {
        const other = baked.taskIndexById.get(dep.ref);
        if (other === undefined || !baked.tasks[other]!.mustInclude) continue;
      } else if (!src.external_pinned.some((ev) => ev.id === dep.ref)) {
        continue;
      }
      out.push({
        key: depKey(ti, k),
        item: { type: "hard_dependency", task_id: task.id, ref: dep.ref },
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Relaxation: the wire problem with the deleted assumptions removed
// ---------------------------------------------------------------------------

/** Rebuild the wire problem with exactly the assumptions in `deleted` relaxed.
 *
 * The one non-obvious case is business hours. The floor is not a task field:
 * `bakeProblem` (like model.py `_add_business_hours`) applies it to a task
 * only when that task has no pin, no hard window of its own, and no
 * availability mask. Deleting one of those would therefore switch business
 * hours ON for a task that never carried the assumption — a constraint the
 * reference never had. So whenever business hours must not apply, the task
 * gets a whole-window availability mask, which restores the exemption and is
 * otherwise inert (it admits exactly the starts the horizon already does).
 *
 * Deleting an `external_pinned` assumption removes the event outright, which
 * is a STRONGER relaxation than model.py's: there, dropping the literal only
 * un-asserts it while the interval still joins the NoOverlap. Two consequences,
 * both legal under the coverage reading of parity (plan Decisions #2). A core
 * may name an `external_pinned` (or a `hard_dependency` kept alive by one)
 * that CP-SAT would call redundant. And because a hard event dependency
 * resolves against the event list at bake time, deleting the event also
 * un-resolves any dependency referencing it — a coupled relaxation, so those
 * two assumption kinds are not fully independent in the walk. */
function reduceProblem(baked: Baked, deleted: ReadonlySet<string>): Problem {
  const src = baked.problem;
  const hasBusinessHours = (src.business_hours ?? null) !== null;

  const tasks: WireTask[] = src.tasks.map((task, ti) => {
    const bt = baked.tasks[ti]!;
    const out: WireTask = { ...task };

    if (deleted.has(taskKey("task_present", ti))) out.must_include = false;
    if (deleted.has(taskKey("pinned_at", ti))) delete out.pinned_at;
    const sameDayGone = deleted.has(taskKey("group_same_day", ti));
    const orderedGone = deleted.has(taskKey("group_ordered", ti));
    if (sameDayGone || orderedGone) {
      out.group_policy = {
        same_day: task.group_policy.same_day && !sameDayGone,
        ordered: task.group_policy.ordered && !orderedGone,
      };
    }
    if (deleted.has(taskKey("hard_deadline", ti))) delete out.deadline;
    if (deleted.has(taskKey("earliest_start", ti))) out.earliest_start = src.window.start;
    if (deleted.has(taskKey("hard_preferred_window", ti))) {
      out.preferred_windows = task.preferred_windows.filter((w) => !w.hard);
    }
    if (deleted.has(taskKey("availability_window", ti))) out.availability_windows = [];
    if (task.dependencies.some((_, k) => deleted.has(depKey(ti, k)))) {
      out.dependencies = task.dependencies.filter((_, k) => !deleted.has(depKey(ti, k)));
    }

    if (hasBusinessHours) {
      const applies = bt.usedBusinessHours && !deleted.has(taskKey("business_hours", ti));
      const exempt =
        out.pinned_at != null ||
        out.preferred_windows.some((w) => w.hard) ||
        (out.availability_windows?.length ?? 0) > 0;
      if (!applies && !exempt) {
        // Inert stand-in for the exemption the deleted assumption carried.
        out.availability_windows = [{ start: src.window.start, end: src.window.end }];
      }
    }

    return out;
  });

  return {
    ...src,
    tasks,
    external_pinned: src.external_pinned.filter((ev) => !deleted.has(externalKey(ev.id))),
  };
}

// ---------------------------------------------------------------------------
// Budget bookkeeping for one MUS-layer call
// ---------------------------------------------------------------------------

/** One deadline and one deletion-test allowance for the WHOLE call, threaded
 * through every iteration of the demotion loop. Both are call-level, not
 * per-iteration: a per-iteration clock lets a K-demotion problem overrun
 * `wallMs` K-fold. */
interface MusRun {
  now: () => number;
  /** Absolute deadline; Infinity when unbounded. */
  deadline: number;
  /** Total deletion tests allowed across the call (Budget.nodeCap). */
  testCap: number;
  tests: number;
  /** Feasibility checks spent (bake + packFeasible), for `nodes` accounting. */
  checks: number;
}

function newRun(budget: Budget): MusRun {
  const now = budget.now ?? Date.now;
  return {
    now,
    deadline: budget.wallMs === Infinity ? Infinity : now() + budget.wallMs,
    testCap: budget.nodeCap,
    tests: 0,
    checks: 0,
  };
}

function outOfBudget(run: MusRun): boolean {
  if (run.tests >= run.testCap) return true;
  return run.deadline !== Infinity && run.now() > run.deadline;
}

/** The budget for one inner `selectTasks` call: its own node cap, but never
 * more wall clock than the MUS run has left. */
function threadSelectBudget(selectBudget: Budget, run: MusRun): Budget {
  if (run.deadline === Infinity) return selectBudget;
  return {
    nodeCap: selectBudget.nodeCap,
    wallMs: Math.min(selectBudget.wallMs, Math.max(0, run.deadline - run.now())),
    now: run.now,
  };
}

// ---------------------------------------------------------------------------
// Feasibility oracle
// ---------------------------------------------------------------------------

/** Pass-1 feasibility of an already-baked problem: the must_include set alone
 * decides it, since every other task can be dropped. Definite by contract —
 * `packFeasible` never abandons a check. Returns the witness placement so the
 * undecided-seed path can hand it to callers (engine.ts's PASS1_FALLBACK
 * serves it) instead of discarding the very placement the proof computed. */
function mustSetWitness(baked: Baked, run: MusRun): Placement | null {
  run.checks++;
  if (baked.externalOverlapCore !== null) return null;
  const must: number[] = [];
  for (const t of baked.tasks) if (t.mustInclude) must.push(t.index);
  return packFeasible(baked, must);
}

function feasibleBaked(baked: Baked, run: MusRun): boolean {
  return mustSetWitness(baked, run) !== null;
}

function feasibleProblem(problem: Problem, run: MusRun): boolean {
  return feasibleBaked(bakeProblem(problem), run);
}

// ---------------------------------------------------------------------------
// Core extraction
// ---------------------------------------------------------------------------

function extractCoreInternal(
  baked: Baked,
  run: MusRun,
  knownInfeasible: boolean,
): UnsatItem[] {
  // Two externals overlapping is decided in the substrate before any search;
  // it is not re-derived here.
  if (baked.externalOverlapCore !== null) return baked.externalOverlapCore;
  if (!knownInfeasible && feasibleBaked(baked, run)) {
    throw new Error(
      "extractCore: the baked problem is pass-1 feasible — there is no core to extract",
    );
  }

  const assumptions = enumerateAssumptions(baked);
  const deleted = new Set<string>();
  const core: Assumption[] = [];

  for (let i = 0; i < assumptions.length; i++) {
    // The budget bounds deletion TESTS, not the search inside one: each test
    // must give a definite answer or the core stops being sound.
    if (outOfBudget(run)) {
      // Everything not yet minimised stays in. The un-deleted set is still
      // infeasible, so the result remains a valid (merely sufficient) core.
      for (let j = i; j < assumptions.length; j++) core.push(assumptions[j]!);
      break;
    }

    const a = assumptions[i]!;
    deleted.add(a.key);
    run.tests++;
    if (feasibleProblem(reduceProblem(baked, deleted), run)) {
      deleted.delete(a.key); // needed: without it the conflict dissolves
      core.push(a);
    }
  }

  return core.map((a) => a.item);
}

/** Deletion-based minimal unsat core over the ASSUMPTION_* vocabulary
 * (task_present, pinned_at, hard_deadline, earliest_start, hard_dependency,
 * hard_preferred_window, business_hours, group_same_day, group_ordered,
 * availability_window, external_pinned). Each deletion test is one pass-1
 * feasibility check (packFeasible) on a rebaked reduced problem.
 *
 * `budget.nodeCap` caps the number of deletion TESTS and `budget.wallMs` the
 * wall clock between them; exhausting either returns a sound but no longer
 * minimal core. A single test is never interrupted (see COST SHAPE above).
 *
 * PRECONDITION: the baked problem is pass-1 infeasible. Throws otherwise —
 * an empty core would reach the wire as a 422 explaining nothing. */
export function extractCore(baked: Baked, budget: Budget): UnsatItem[] {
  return extractCoreInternal(baked, newRun(budget), false);
}

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

function isolationFeasibleInternal(
  baked: Baked,
  taskIndex: number,
  run: MusRun,
): boolean {
  const src = baked.problem;
  const task = src.tasks[taskIndex];
  if (task === undefined) return false;
  // two_pass._isolation_feasible copies the task with `dependencies: []`
  // before re-solving. That matters beyond the obvious: cross-task dependencies
  // go vacuous on a one-task set anyway, but hard EVENT dependencies are unary
  // and `packFeasible` would still enforce them (see its doc comment). Strip,
  // re-bake, then check.
  const solo: WireTask = { ...task, dependencies: [] };
  const sub: Problem = { ...src, tasks: [solo] };
  const isolated = bakeProblem(sub);
  run.checks++;
  if (isolated.externalOverlapCore !== null) return false;
  return packFeasible(isolated, [0]) !== null;
}

/** Could this task be placed if it were the only task, against the fixed
 * external calendar, with cross-task dependencies stripped? (Mirrors
 * two_pass._isolation_feasible.)
 *
 * Only meaningful for a must_include task — the guarded-demotion pass calls it
 * exactly on a core's `task_present` members. A droppable task has no
 * task_present assumption to isolate: in Python's model it is trivially
 * satisfiable by being dropped, so asking the question of one is a category
 * error, not a cheap "true". */
export function isolationFeasible(baked: Baked, taskIndex: number): boolean {
  return isolationFeasibleInternal(baked, taskIndex, newRun(UNBOUNDED));
}

const UNBOUNDED: Budget = { wallMs: Infinity, nodeCap: Infinity };

// ---------------------------------------------------------------------------
// Guarded demotion loop
// ---------------------------------------------------------------------------

function withDemotions(src: Problem, demoted: ReadonlyMap<number, string>): Problem {
  return {
    ...src,
    tasks: src.tasks.map((t, i) => (demoted.has(i) ? { ...t, must_include: false } : t)),
  };
}

/** Outer demotion loop, mirroring two_pass.solve: infeasible → core →
 * isolation-check the core's task_present members → demote with reason →
 * rebuild → retry; a surviving core with every member isolation-feasible is
 * a genuine 422.
 *
 * `budget` governs this layer — one deadline and one deletion-test allowance
 * for the whole call, shared by every iteration. `selectBudget` governs the
 * inner `selectTasks` calls, including the final successful one whose
 * `Pass1Result` is returned; it is additionally clipped to whatever wall clock
 * `budget` has left, so the call as a whole still respects `budget.wallMs`.
 *
 * `selectTasks` reports `{infeasible: false, proved: false}` for two unrelated
 * situations: a genuine partition it could not certify as optimal, and a seed
 * pack that ran out of budget without deciding whether the must set packs at
 * all. Returning the second as a plan would ship an unschedulable week, so an
 * unproved result is always re-decided here with this layer's own definite
 * oracle. A pass 1 that survives that check is still returned with
 * `proved: false` — uncertified, but real. */
export function resolveInfeasibility(
  baked: Baked,
  budget: Budget,
  selectBudget: Budget = budget,
): MusOutcome {
  const demoted = new Map<number, string>();
  const run = newRun(budget);

  // Overlapping externals are unconditionally UNSAT and are decided before any
  // search. Pass 1 cannot see them — it only asks whether the must set packs —
  // so checking here is what stops the overlap vanishing behind a valid plan.
  if (baked.externalOverlapCore !== null) {
    return { demoted, core: baked.externalOverlapCore, pass1: null, nodes: 0 };
  }

  let nodes = 0;
  let current = baked;
  let core: UnsatItem[] = [];

  // Every iteration that continues demotes at least one task, so the loop is
  // bounded by the task count; the extra turn covers the final, demotion-free
  // pass that either solves or returns the surviving core.
  for (let iter = 0; iter <= baked.tasks.length; iter++) {
    const pass1 = selectTasks(current, threadSelectBudget(selectBudget, run));
    nodes += pass1.nodes;

    // An unproved pass 1 is re-decided with this layer's own oracle — but
    // only when the seed pack was actually abandoned (`seedDecided` false).
    // A search-ran-but-uncertified partition is real; re-checking it would
    // spend an unbudgeted packFeasible for nothing.
    let infeasible = pass1.infeasible;
    let redecided: Placement | null = null;
    if (!infeasible && !pass1.proved && !pass1.seedDecided) {
      redecided = mustSetWitness(current, run);
      infeasible = redecided === null;
    }
    if (!infeasible) {
      // The re-decide proved the (undecided) must set packs: attach its
      // placement as the witness. The seed pack never verified an incumbent,
      // so the original pass 1 carries witness:null — returning it unpatched
      // would strand engine.ts's PASS1_FALLBACK path with nothing to serve.
      const fixed = redecided !== null ? { ...pass1, witness: redecided } : pass1;
      return { demoted, core: null, pass1: fixed, nodes: nodes + run.checks };
    }

    core = extractCoreInternal(current, run, true);

    const newly: number[] = [];
    for (const item of core) {
      if (item.type !== "task_present" || item.task_id === undefined) continue;
      const ti = baked.taskIndexById.get(item.task_id);
      if (ti === undefined || demoted.has(ti)) continue;
      // Isolation is judged against the ORIGINAL problem, as the Python does:
      // demoting other tasks cannot change whether this one fits alone.
      if (!isolationFeasibleInternal(baked, ti, run)) newly.push(ti);
    }

    if (newly.length === 0) break; // genuine contention → 422
    for (const ti of newly) demoted.set(ti, MUST_INCLUDE_UNPLACEABLE);
    current = bakeProblem(withDemotions(baked.problem, demoted));
  }

  return { demoted, core, pass1: null, nodes: nodes + run.checks };
}
