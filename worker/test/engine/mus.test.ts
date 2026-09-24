// Card D — MUS extraction + guarded demotion tests. Semantics are pinned
// against the Python reference: solver/src/solver/two_pass.py (`_solve_fast`'s
// demotion loop, `_isolation_feasible`, `_extract_unsat_core`) and
// solver/src/solver/model.py (the ASSUMPTION_* vocabulary and what each
// assumption attaches to). Bench-derived expectations come from the committed
// reference run (fixtures/reference-light.json, bench/problems/*-light.json).
//
// Parity note (plan Decisions #2): deletion-based MUS returns a MINIMAL core
// where CP-SAT's SufficientAssumptionsForInfeasibility returns a merely
// sufficient one. Cross-checks against the reference are therefore "covers the
// same conflict", never set-equality.

import { describe, expect, it } from "vitest";
import { bakeProblem } from "../../src/engine/substrate";
import { selectTasks } from "../../src/engine/pass1";
import {
  MUST_INCLUDE_UNPLACEABLE,
  extractCore,
  isolationFeasible,
  resolveInfeasibility,
} from "../../src/engine/mus";
import type { Baked, Budget, Problem, UnsatItem } from "../../src/engine/types";

import reference from "./fixtures/reference-light.json";
import pEdgeMustIncludeDemotion from "../../../bench/problems/edge_must_include_demotion-light.json";
import pEdgeSoftDependencyIgnored from "../../../bench/problems/edge_soft_dependency_ignored-light.json";
import pEdgeUnsatMustInclude from "../../../bench/problems/edge_unsat_must_include-light.json";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const UNBOUNDED: Budget = { wallMs: Infinity, nodeCap: Infinity };

const WINDOW = {
  start: "2026-05-18T00:00:00", // a Monday
  end: "2026-05-25T00:00:00",
  tz: "UTC",
};

/** Local-naive timestamp `days` after the window start. */
function at(day: number, hour: number, minute = 0): Problem["window"]["start"] {
  const d = String(18 + day).padStart(2, "0");
  const h = String(hour).padStart(2, "0");
  const m = String(minute).padStart(2, "0");
  return `2026-05-${d}T${h}:${m}:00` as Problem["window"]["start"];
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

function clone(problem: Problem): Problem {
  return JSON.parse(JSON.stringify(problem)) as Problem;
}

function benchProblem(fixture: unknown): Problem {
  return (fixture as { problem: Problem }).problem;
}

function ids(baked: Baked, indices: readonly number[]): string[] {
  return indices.map((i) => baked.tasks[i]!.id).sort();
}

function pass1Infeasible(problem: Problem): boolean {
  return selectTasks(bakeProblem(problem), UNBOUNDED).infeasible;
}

/** (type, task_id) pairs, sorted — the comparable shape of a core. */
function coreKeys(core: readonly UnsatItem[]): string[] {
  return core.map((it) => `${it.type}:${it.task_id ?? ""}`).sort();
}

function demotedIds(baked: Baked, demoted: Map<number, string>): string[] {
  return [...demoted.keys()].map((i) => baked.tasks[i]!.id).sort();
}

/** Relax one core member in the source problem — the test's own, deliberately
 * independent, transform (mirrors what dropping an assumption literal means in
 * model.py). Only the assumption kinds these fixtures carry are handled.
 *
 * The business-hours exemption is restored here too, independently derived
 * from model.py `_add_business_hours`: the floor applies only to a task with
 * no pin, no hard window of its own, and no availability mask, so relaxing one
 * of those must not switch the floor ON for a task that never carried it. */
function relaxItem(problem: Problem, item: UnsatItem): Problem {
  const out = clone(problem);
  if (item.type === "external_pinned") {
    out.external_pinned = out.external_pinned.filter((e) => e.id !== item.task_id);
    return out;
  }
  const task = out.tasks.find((t) => t.id === item.task_id);
  if (task === undefined) throw new Error(`no task ${item.task_id ?? "?"}`);
  const exemptBefore =
    task.pinned_at != null ||
    task.preferred_windows.some((w) => w.hard) ||
    (task.availability_windows?.length ?? 0) > 0;
  switch (item.type) {
    case "task_present":
      task.must_include = false;
      break;
    case "pinned_at":
      delete task.pinned_at;
      break;
    case "availability_window":
      task.availability_windows = [];
      break;
    case "hard_preferred_window":
      task.preferred_windows = task.preferred_windows.filter((w) => !w.hard);
      break;
    default:
      throw new Error(`relaxItem: unhandled assumption ${item.type}`);
  }
  const exemptAfter =
    task.pinned_at != null ||
    task.preferred_windows.some((w) => w.hard) ||
    (task.availability_windows?.length ?? 0) > 0;
  if ((out.business_hours ?? null) !== null && exemptBefore && !exemptAfter) {
    task.availability_windows = [{ start: out.window.start, end: out.window.end }];
  }
  return out;
}

type ReferenceRecord = {
  status: string;
  unsat_core?: Array<{ type: string; task_id: string | null }>;
  drop_reasons?: Record<string, string>;
  dropped?: string[];
  kept?: string[];
};

const REFERENCE = reference as unknown as Record<string, ReferenceRecord>;

// ---------------------------------------------------------------------------
// 1. Colliding must_include pins ⇒ genuine UNSAT with a minimal core
// ---------------------------------------------------------------------------

describe("extractCore — colliding must_include pins (edge_unsat_must_include)", () => {
  const problem = benchProblem(pEdgeUnsatMustInclude);

  it("is pass-1 infeasible to begin with", () => {
    expect(pass1Infeasible(problem)).toBe(true);
  });

  it("returns a core whose task_present items cover both conflicting tasks", () => {
    const baked = bakeProblem(problem);
    const core = extractCore(baked, UNBOUNDED);

    const present = core.filter((it) => it.type === "task_present").map((it) => it.task_id);
    expect(present.slice().sort()).toEqual(["task-0", "task-1"]);
  });

  it("covers the same conflict as the reference run's recorded core", () => {
    const baked = bakeProblem(problem);
    const core = extractCore(baked, UNBOUNDED);
    const record = REFERENCE["edge_unsat_must_include-light"]!;
    expect(record.status).toBe("UNSAT");

    // Coverage, not set-equality (Decisions #2): every task the reference
    // blamed is blamed here, under the same assumption types.
    const refKeys = new Set(
      record.unsat_core!.map((it) => `${it.type}:${it.task_id ?? ""}`),
    );
    for (const key of refKeys) expect(coreKeys(core)).toContain(key);
  });

  it("carries the pin timestamp on pinned_at items, as model.py does", () => {
    const baked = bakeProblem(problem);
    const core = extractCore(baked, UNBOUNDED);
    const pins = core.filter((it) => it.type === "pinned_at");
    expect(pins).toHaveLength(2);
    for (const pin of pins) expect(pin.value).toBe("2026-05-19T10:00:00");
  });

  it("is MINIMAL — removing any single member makes the remainder feasible", () => {
    const baked = bakeProblem(problem);
    const core = extractCore(baked, UNBOUNDED);
    // This problem's whole assumption set is exactly {task_present,
    // pinned_at} × {task-0, task-1}: no deadlines, windows, deps, externals,
    // and earliest_start == window.start (slot 0, which model.py skips). So
    // "core minus one member" is just "problem minus that one assumption".
    expect(core).toHaveLength(4);
    for (const item of core) {
      expect(
        pass1Infeasible(relaxItem(problem, item)),
        `core is not minimal: ${item.type}/${item.task_id ?? "?"} is redundant`,
      ).toBe(false);
    }
  });

  it("resolveInfeasibility reports a genuine 422 — nothing is demotable", () => {
    const baked = bakeProblem(problem);
    const outcome = resolveInfeasibility(baked, UNBOUNDED);

    expect(outcome.core).not.toBeNull();
    expect(outcome.pass1).toBeNull();
    expect(outcome.demoted.size).toBe(0);
    expect(isolationFeasible(baked, 0)).toBe(true);
    expect(isolationFeasible(baked, 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. must_include pinned onto an external ⇒ demotion, then SAT
// ---------------------------------------------------------------------------

describe("resolveInfeasibility — must_include pinned onto an external", () => {
  const problem = benchProblem(pEdgeMustIncludeDemotion);

  it("isolationFeasible is false for the pinned-onto-external task only", () => {
    const baked = bakeProblem(problem);
    expect(isolationFeasible(baked, 0)).toBe(false); // task-0, pinned onto ext-0
    expect(isolationFeasible(baked, 1)).toBe(true);
  });

  it("demotes exactly that task and then solves, matching the reference run", () => {
    const baked = bakeProblem(problem);
    const outcome = resolveInfeasibility(baked, UNBOUNDED);
    const record = REFERENCE["edge_must_include_demotion-light"]!;

    expect(outcome.core).toBeNull();
    expect(outcome.pass1).not.toBeNull();
    expect(demotedIds(baked, outcome.demoted)).toEqual(["task-0"]);
    expect(outcome.demoted.get(0)).toBe(MUST_INCLUDE_UNPLACEABLE);
    expect(MUST_INCLUDE_UNPLACEABLE).toBe("must_include_unplaceable_in_isolation");

    expect(ids(baked, outcome.pass1!.kept)).toEqual(record.kept);
    expect(ids(baked, outcome.pass1!.dropped)).toEqual(record.dropped);
    expect(record.drop_reasons!["task-0"]).toBe(MUST_INCLUDE_UNPLACEABLE);
  });
});

// ---------------------------------------------------------------------------
// 3. Three-way conflict with one demotable member ⇒ the rebuild loop
// ---------------------------------------------------------------------------

/** Three must_include 60-min tasks sharing a Tue 09:00–12:00 availability
 * window (three start slots), an external eating 09:00–10:00 (leaving two),
 * and task-a pinned onto that external. Infeasible with all three mandatory;
 * feasible once the one unplaceable-in-isolation member is demoted. */
function threeWayWithOneDemotable(): Problem {
  const avail = [{ start: at(1, 9), end: at(1, 12) }];
  return makeProblem({
    external_pinned: [
      {
        id: "ext-0",
        title: "External 0",
        start: at(1, 9),
        duration_minutes: 60,
        context: "meeting",
      },
    ],
    tasks: [
      makeTask("task-a", {
        must_include: true,
        pinned_at: at(1, 9),
        availability_windows: avail,
      }),
      makeTask("task-b", { must_include: true, availability_windows: avail }),
      makeTask("task-c", { must_include: true, availability_windows: avail }),
    ],
  });
}

describe("resolveInfeasibility — three-way conflict, one demotable member", () => {
  it("demotes the unplaceable member, rebuilds, and succeeds", () => {
    const problem = threeWayWithOneDemotable();
    expect(pass1Infeasible(problem)).toBe(true);

    const baked = bakeProblem(problem);
    expect(isolationFeasible(baked, 0)).toBe(false);
    expect(isolationFeasible(baked, 1)).toBe(true);
    expect(isolationFeasible(baked, 2)).toBe(true);

    const outcome = resolveInfeasibility(baked, UNBOUNDED);
    expect(outcome.core).toBeNull();
    expect(outcome.pass1).not.toBeNull();
    expect(demotedIds(baked, outcome.demoted)).toEqual(["task-a"]);
    expect(ids(baked, outcome.pass1!.kept)).toEqual(["task-b", "task-c"]);
    expect(ids(baked, outcome.pass1!.dropped)).toEqual(["task-a"]);
  });

  it("iterates the loop when a minimal core hides a second demotable task", () => {
    // Two tasks pinned inside the SAME external. A minimal core blames only
    // one of them (the other's items are redundant), so the second demotion
    // can only come from a later iteration of the rebuild loop.
    const problem = makeProblem({
      external_pinned: [
        {
          id: "ext-0",
          title: "External 0",
          start: at(1, 9),
          duration_minutes: 60,
          context: "meeting",
        },
      ],
      tasks: [
        makeTask("task-a", { must_include: true, pinned_at: at(1, 9) }),
        makeTask("task-d", { must_include: true, pinned_at: at(1, 9, 15) }),
        makeTask("task-c", { must_include: true }),
      ],
    });

    const baked = bakeProblem(problem);
    const firstCore = extractCore(baked, UNBOUNDED);
    const blamed = firstCore
      .filter((it) => it.type === "task_present")
      .map((it) => it.task_id);
    expect(blamed).toHaveLength(1); // minimal: only one of the two is needed

    const outcome = resolveInfeasibility(baked, UNBOUNDED);
    expect(outcome.core).toBeNull();
    expect(demotedIds(baked, outcome.demoted)).toEqual(["task-a", "task-d"]);
    for (const reason of outcome.demoted.values()) {
      expect(reason).toBe(MUST_INCLUDE_UNPLACEABLE);
    }
    expect(ids(baked, outcome.pass1!.kept)).toEqual(["task-c"]);
  });

  it("returns a minimal 422 core when no member is unplaceable alone", () => {
    // Same shape, but the window fits only two of three tasks and nothing is
    // pinned: every member is placeable alone, so this is genuine contention.
    const avail = [{ start: at(1, 9), end: at(1, 11) }];
    const problem = makeProblem({
      tasks: [
        makeTask("task-a", { must_include: true, availability_windows: avail }),
        makeTask("task-b", { must_include: true, availability_windows: avail }),
        makeTask("task-c", { must_include: true, availability_windows: avail }),
      ],
    });

    const baked = bakeProblem(problem);
    for (let i = 0; i < 3; i++) expect(isolationFeasible(baked, i)).toBe(true);

    const outcome = resolveInfeasibility(baked, UNBOUNDED);
    expect(outcome.pass1).toBeNull();
    expect(outcome.demoted.size).toBe(0);
    expect(coreKeys(outcome.core!)).toEqual([
      "availability_window:task-a",
      "availability_window:task-b",
      "availability_window:task-c",
      "task_present:task-a",
      "task_present:task-b",
      "task_present:task-c",
    ]);
    for (const item of outcome.core!) {
      expect(
        pass1Infeasible(relaxItem(problem, item)),
        `core is not minimal: ${item.type}/${item.task_id ?? "?"} is redundant`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// isolationFeasible — the dependency-stripping seam
// ---------------------------------------------------------------------------

describe("isolationFeasible — dependencies are stripped before the check", () => {
  it("ignores a hard cross-task dependency that makes the task unplaceable", () => {
    // task-b is hard-after task-a, and task-a is pinned to the last hour of
    // the window: with the dependency live, task-b cannot be placed at all.
    const problem = makeProblem({
      tasks: [
        makeTask("task-a", { pinned_at: at(6, 23) }),
        makeTask("task-b", {
          must_include: true,
          dependencies: [{ type: "after_task", ref: "task-a", hard: true }],
        }),
      ],
    });
    const baked = bakeProblem(problem);
    expect(isolationFeasible(baked, 1)).toBe(true);
  });

  it("ignores a hard EVENT dependency too (the packFeasible divergence)", () => {
    // Hard event dependencies are UNARY: packFeasible enforces them even on a
    // one-task set, but two_pass._isolation_feasible copies the task with
    // dependencies: [] first, so they must not decide isolation.
    const problem = makeProblem({
      external_pinned: [
        {
          id: "ext-late",
          title: "External late",
          start: at(6, 23),
          duration_minutes: 60,
          context: "meeting",
        },
      ],
      tasks: [
        makeTask("task-a", {
          must_include: true,
          dependencies: [{ type: "after_event", ref: "ext-late", hard: true }],
        }),
      ],
    });
    const baked = bakeProblem(problem);
    expect(isolationFeasible(baked, 0)).toBe(true);
  });

  it("still reports false when the task's own hard constraints exclude every slot", () => {
    const problem = makeProblem({
      tasks: [
        makeTask("task-a", {
          must_include: true,
          pinned_at: at(1, 9),
          availability_windows: [{ start: at(2, 9), end: at(2, 12) }],
        }),
      ],
    });
    expect(isolationFeasible(bakeProblem(problem), 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Non-must_include versions of the same fixtures ⇒ never UNSAT
// ---------------------------------------------------------------------------

describe("droppable variants — drop wins, the MUS layer never fires", () => {
  function withoutMustInclude(problem: Problem): Problem {
    const out = clone(problem);
    for (const t of out.tasks) t.must_include = false;
    return out;
  }

  const cases: Array<[string, Problem]> = [
    ["edge_unsat_must_include", benchProblem(pEdgeUnsatMustInclude)],
    ["edge_must_include_demotion", benchProblem(pEdgeMustIncludeDemotion)],
    ["three-way contention", threeWayWithOneDemotable()],
  ];

  for (const [name, source] of cases) {
    it(`${name} without must_include is pass-1 feasible`, () => {
      const problem = withoutMustInclude(source);
      expect(pass1Infeasible(problem)).toBe(false);

      // And resolveInfeasibility is a no-op pass-through on a feasible
      // problem: no core, no demotions.
      const outcome = resolveInfeasibility(bakeProblem(problem), UNBOUNDED);
      expect(outcome.core).toBeNull();
      expect(outcome.pass1).not.toBeNull();
      expect(outcome.demoted.size).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Soft dependencies are ignored everywhere
// ---------------------------------------------------------------------------

describe("soft dependencies are ignored by the MUS layer", () => {
  it("the bench soft-dependency fixture stays feasible", () => {
    expect(pass1Infeasible(benchProblem(pEdgeSoftDependencyIgnored))).toBe(false);
  });

  it("adding soft dependencies changes neither the core nor isolation", () => {
    const avail = [{ start: at(1, 9), end: at(1, 11) }];
    const base = makeProblem({
      tasks: [
        makeTask("task-a", { must_include: true, availability_windows: avail }),
        makeTask("task-b", { must_include: true, availability_windows: avail }),
        makeTask("task-c", { must_include: true, availability_windows: avail }),
      ],
    });
    const withSoft = clone(base);
    withSoft.tasks[1]!.dependencies = [{ type: "after_task", ref: "task-a", hard: false }];
    withSoft.tasks[2]!.dependencies = [{ type: "before_task", ref: "task-a", hard: false }];

    const bakedBase = bakeProblem(base);
    const bakedSoft = bakeProblem(withSoft);

    expect(coreKeys(extractCore(bakedSoft, UNBOUNDED))).toEqual(
      coreKeys(extractCore(bakedBase, UNBOUNDED)),
    );
    for (const item of extractCore(bakedSoft, UNBOUNDED)) {
      expect(item.type).not.toBe("hard_dependency");
    }
    for (let i = 0; i < 3; i++) {
      expect(isolationFeasible(bakedSoft, i)).toBe(isolationFeasible(bakedBase, i));
    }
  });

  it("a soft dependency that would be unsatisfiable if honoured is still fine", () => {
    // task-b soft-after task-a, but task-a is pinned to the window's last hour
    // — impossible to honour. Soft deps are never baked, so this is feasible.
    const problem = makeProblem({
      tasks: [
        makeTask("task-a", { must_include: true, pinned_at: at(6, 23) }),
        makeTask("task-b", {
          must_include: true,
          dependencies: [{ type: "after_task", ref: "task-a", hard: false }],
        }),
      ],
    });
    expect(pass1Infeasible(problem)).toBe(false);
    const outcome = resolveInfeasibility(bakeProblem(problem), UNBOUNDED);
    expect(outcome.core).toBeNull();
    expect(outcome.demoted.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Budget behaviour (the Card E contract)
// ---------------------------------------------------------------------------

describe("extractCore under a spent budget", () => {
  it("returns a sound (sufficient) core rather than an unsound minimal one", () => {
    const problem = benchProblem(pEdgeUnsatMustInclude);
    const baked = bakeProblem(problem);
    // nodeCap caps DELETION TESTS, not search nodes inside one check.
    const core = extractCore(baked, { wallMs: Infinity, nodeCap: 0 });

    // Nothing was minimised away, so the core is the full active assumption
    // set — still a valid explanation, just not minimal.
    expect(coreKeys(core)).toEqual([
      "pinned_at:task-0",
      "pinned_at:task-1",
      "task_present:task-0",
      "task_present:task-1",
    ]);
  });

  it("throws on a feasible problem — an empty-core 422 is worse than a crash", () => {
    const baked = bakeProblem(
      makeProblem({ tasks: [makeTask("task-a", { must_include: true })] }),
    );
    expect(() => extractCore(baked, UNBOUNDED)).toThrow(/no core to extract/i);
  });
});

// ---------------------------------------------------------------------------
// F1 — an UNDECIDED pass 1 must never be laundered into a plan
// ---------------------------------------------------------------------------

/** `selectTasks` returns {infeasible: false, proved: false} in two very
 * different situations: a real partition it could not certify as optimal, and
 * a seed pack that ran out of budget without deciding whether the must set
 * packs at all. Only the MUS layer's own oracle can tell them apart. A tiny
 * nodeCap reproduces the second in milliseconds; the natural route is
 * `packFeasible` hitting PACK_NODE_CAP on availability-crowded weeks.
 *
 * The crowding must EVADE the capacity bands (Card B's fix round derives band
 * spans from the baked domain envelope): a single shared two-hour window
 * would be refuted by its own band with zero search nodes and come back as a
 * definite `infeasible: true`. Scattering the availability across two days
 * stretches every envelope over the whole span — no band binds, and only
 * enumeration (which the spent budget forbids) can refute the pack. */
function threeTasksTwoScatteredHours(): Problem {
  // Two usable hours (Tue 09:00–10:00, Fri 09:00–10:00) for three 60-min
  // must_include tasks: unpackable by pigeonhole, invisible to the bands.
  const avail = [
    { start: at(1, 9), end: at(1, 10) },
    { start: at(4, 9), end: at(4, 10) },
  ];
  return makeProblem({
    tasks: [
      makeTask("task-a", { must_include: true, availability_windows: avail }),
      makeTask("task-b", { must_include: true, availability_windows: avail }),
      makeTask("task-c", { must_include: true, availability_windows: avail }),
    ],
  });
}

describe("resolveInfeasibility — undecided pass 1", () => {
  const SPENT: Budget = { wallMs: Infinity, nodeCap: 0 };

  it("selectTasks really does report undecided here (test precondition)", () => {
    const baked = bakeProblem(threeTasksTwoScatteredHours());
    const pass1 = selectTasks(baked, SPENT);
    expect(pass1.infeasible).toBe(false);
    expect(pass1.proved).toBe(false);
    // ... and the "kept" set it hands back does NOT actually pack.
    expect(pass1.kept).toHaveLength(3);
  });

  it("re-decides an undecided pass 1 instead of returning it as a plan", () => {
    const baked = bakeProblem(threeTasksTwoScatteredHours());
    const outcome = resolveInfeasibility(baked, UNBOUNDED, SPENT);

    // The must set does not pack, so this is a 422 — never a three-task plan.
    expect(outcome.pass1).toBeNull();
    expect(outcome.core).not.toBeNull();
    expect(coreKeys(outcome.core!)).toEqual([
      "availability_window:task-a",
      "availability_window:task-b",
      "availability_window:task-c",
      "task_present:task-a",
      "task_present:task-b",
      "task_present:task-c",
    ]);
  });

  it("skips the redundant oracle re-check when the seed already decided", () => {
    // Two droppable tasks under a spent SELECTION budget: the seed pack
    // (empty must set) decided instantly, so the uncertified partition is
    // real and the MUS layer must not spend an extra feasibility check on
    // it. Observable through MusOutcome.nodes, which counts one unit per
    // MUS-layer check on top of the inner selectTasks' search nodes.
    const baked = bakeProblem(
      makeProblem({ tasks: [makeTask("task-a"), makeTask("task-b")] }),
    );
    const spent: Budget = { wallMs: Infinity, nodeCap: 0 };
    const direct = selectTasks(baked, spent);
    expect(direct.proved).toBe(false);
    expect(direct.seedDecided).toBe(true);

    const outcome = resolveInfeasibility(baked, UNBOUNDED, spent);
    expect(outcome.core).toBeNull();
    expect(outcome.pass1).not.toBeNull();
    expect(outcome.nodes).toBe(direct.nodes);
  });

  it("still returns an undecided-but-feasible pass 1 unchanged", () => {
    // Two 60-min tasks in the same two-hour window: genuinely feasible, but
    // the seed pack is cut off before it can prove that.
    const avail = [{ start: at(1, 9), end: at(1, 11) }];
    const baked = bakeProblem(
      makeProblem({
        tasks: [
          makeTask("task-a", { must_include: true, availability_windows: avail }),
          makeTask("task-b", { must_include: true, availability_windows: avail }),
        ],
      }),
    );
    expect(selectTasks(baked, SPENT).proved).toBe(false);

    const outcome = resolveInfeasibility(baked, UNBOUNDED, SPENT);
    expect(outcome.core).toBeNull();
    expect(outcome.pass1).not.toBeNull();
    expect(outcome.pass1!.proved).toBe(false); // still uncertified — Card E's problem
    expect(ids(baked, outcome.pass1!.kept)).toEqual(["task-a", "task-b"]);
    // The re-decide proved the must set packs with its own oracle; the
    // placement that proof computed must be ATTACHED as the witness — the
    // seed pack never decided, so the original pass 1 carries witness:null,
    // and returning it unpatched lets a budget-starved pass 2 reach
    // engine.ts's PASS1_FALLBACK branch with nothing to serve (the
    // documented-impossible null-witness throw).
    const witness = outcome.pass1!.witness;
    expect(witness).not.toBeNull();
    for (const kept of outcome.pass1!.kept) {
      for (const ci of baked.tasks[kept]!.chunkIndices) {
        expect(witness![ci]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("also re-decides on a later loop iteration, after a demotion", () => {
    // Two independent conflicts. A minimal core always lands on the LAST one
    // in enumeration order — dropping an earlier conflict's assumptions leaves
    // the problem infeasible, so they are discarded as redundant. Putting the
    // demotable task last therefore forces the loop to iterate: iteration 1
    // demotes it, iteration 2 meets the three-way contention with a
    // selectTasks that is STILL cut off, and must re-decide rather than hand
    // back a four-task plan.
    const avail = [{ start: at(1, 9), end: at(1, 11) }];
    const baked = bakeProblem(
      makeProblem({
        external_pinned: [
          {
            id: "ext-0",
            title: "External 0",
            start: at(2, 9),
            duration_minutes: 60,
            context: "meeting",
          },
        ],
        tasks: [
          makeTask("task-a", { must_include: true, availability_windows: avail }),
          makeTask("task-b", { must_include: true, availability_windows: avail }),
          makeTask("task-c", { must_include: true, availability_windows: avail }),
          makeTask("task-p", { must_include: true, pinned_at: at(2, 9) }),
        ],
      }),
    );

    const outcome = resolveInfeasibility(baked, UNBOUNDED, SPENT);
    expect(demotedIds(baked, outcome.demoted)).toEqual(["task-p"]);
    expect(outcome.pass1).toBeNull();
    expect(coreKeys(outcome.core!)).toEqual([
      "availability_window:task-a",
      "availability_window:task-b",
      "availability_window:task-c",
      "task_present:task-a",
      "task_present:task-b",
      "task_present:task-c",
    ]);
  });
});

// ---------------------------------------------------------------------------
// F2 — assumptions on droppable tasks are never enumerated
// ---------------------------------------------------------------------------

describe("enumeration is restricted to what the oracle can consult", () => {
  /** One genuine 3-item conflict (a must task pinned onto an external) buried
   * under a pile of droppable tasks carrying every constraint kind. */
  function conflictUnderNoise(): Problem {
    const noise = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
      makeTask(`noise-${i}`, {
        pinned_at: at(3, 9 + (i % 8)),
        deadline: { at: at(5, 12), hard: true, penalty_per_15min: 0 },
        earliest_start: at(1, 0),
        availability_windows: [{ start: at(1, 0), end: at(5, 0) }],
        preferred_windows: [{ days: ["tue"], start: "09:00", end: "17:00", hard: true }],
        dependencies: [{ type: "after_task", ref: "task-m", hard: true }],
      }),
    );
    return makeProblem({
      external_pinned: [
        {
          id: "ext-0",
          title: "External 0",
          start: at(2, 9),
          duration_minutes: 60,
          context: "meeting",
        },
      ],
      tasks: [...noise, makeTask("task-m", { must_include: true, pinned_at: at(2, 9) })],
    });
  }

  it("never blames a droppable task", () => {
    const baked = bakeProblem(conflictUnderNoise());
    const core = extractCore(baked, UNBOUNDED);
    for (const item of core) {
      expect(item.task_id ?? "").not.toMatch(/^noise-/);
    }
  });

  it("spends a small budget on the real conflict, not on droppable noise", () => {
    const baked = bakeProblem(conflictUnderNoise());
    // Exactly the three deletion tests the true core needs.
    const core = extractCore(baked, { wallMs: Infinity, nodeCap: 3 });
    expect(coreKeys(core)).toEqual([
      "external_pinned:ext-0",
      "pinned_at:task-m",
      "task_present:task-m",
    ]);
  });

  it("keeps a hard dependency between two must tasks", () => {
    // task-y is hard-after task-x, and task-x is pinned to the last hour of
    // the window: with both mandatory the dependency is genuinely in the core.
    const baked = bakeProblem(
      makeProblem({
        tasks: [
          makeTask("task-x", { must_include: true, pinned_at: at(6, 23) }),
          makeTask("task-y", {
            must_include: true,
            dependencies: [{ type: "after_task", ref: "task-x", hard: true }],
          }),
        ],
      }),
    );
    const core = extractCore(baked, UNBOUNDED);
    expect(coreKeys(core)).toContain("hard_dependency:task-y");
  });
});

// ---------------------------------------------------------------------------
// F6 — an externals overlap is never silently swallowed
// ---------------------------------------------------------------------------

describe("overlapping externals", () => {
  function overlappingExternals(): Problem {
    return makeProblem({
      external_pinned: [
        {
          id: "ext-0",
          title: "External 0",
          start: at(1, 9),
          duration_minutes: 60,
          context: "meeting",
        },
        {
          id: "ext-1",
          title: "External 1",
          start: at(1, 9, 30),
          duration_minutes: 60,
          context: "meeting",
        },
      ],
      tasks: [makeTask("task-a")], // droppable: pass 1 alone sees no problem
    });
  }

  it("is reported by resolveInfeasibility even when pass 1 is happy", () => {
    const baked = bakeProblem(overlappingExternals());
    expect(baked.externalOverlapCore).not.toBeNull();
    expect(selectTasks(baked, UNBOUNDED).infeasible).toBe(false);

    const outcome = resolveInfeasibility(baked, UNBOUNDED);
    expect(outcome.pass1).toBeNull();
    expect(outcome.core).toEqual(baked.externalOverlapCore);
    expect(outcome.demoted.size).toBe(0);
  });

  it("is passed through by extractCore too", () => {
    const baked = bakeProblem(overlappingExternals());
    expect(extractCore(baked, UNBOUNDED)).toEqual(baked.externalOverlapCore);
  });
});

// ---------------------------------------------------------------------------
// F4 — one wall-clock deadline for the whole call, not one per iteration
// ---------------------------------------------------------------------------

describe("resolveInfeasibility wall budget", () => {
  /** K must_include tasks all pinned inside one external. A minimal core
   * blames one at a time, so this needs K demotion iterations — exactly the
   * shape that a per-iteration clock would let overrun K-fold. */
  function kPinnedIntoOneExternal(k: number): Problem {
    return makeProblem({
      external_pinned: [
        {
          id: "ext-0",
          title: "External 0",
          start: at(1, 9),
          duration_minutes: 120,
          context: "meeting",
        },
      ],
      tasks: Array.from({ length: k }, (_, i) =>
        makeTask(`task-${i}`, { must_include: true, pinned_at: at(1, 9, (i % 4) * 15) }),
      ),
    });
  }

  it("shares one deadline across every iteration", () => {
    const problem = kPinnedIntoOneExternal(8);

    // A virtual clock ticking once per reading. Unbounded, the whole call
    // costs ~80 ticks (8 iterations of a shrinking assumption walk). With one
    // shared deadline a 25-tick budget stops the minimising early and the rest
    // of the loop only demotes; with a per-iteration clock each of the eight
    // iterations would get its own fresh 25.
    let ticks = 0;
    const now = (): number => ++ticks;
    const outcome = resolveInfeasibility(
      bakeProblem(problem),
      { wallMs: 25, nodeCap: Infinity, now },
      UNBOUNDED,
    );

    // Correctness first: the answer is still right.
    expect(outcome.core).toBeNull();
    expect(outcome.demoted.size).toBe(8);
    expect(outcome.pass1!.kept).toHaveLength(0);
    // ... and the budget was a budget for the CALL.
    expect(ticks).toBeLessThan(60);
  });

  it("costs far more than that when the budget is generous", () => {
    // The control for the bound above: the same problem, minimised properly.
    // The budget has to be finite or the clock is never read at all.
    let ticks = 0;
    const now = (): number => ++ticks;
    resolveInfeasibility(
      bakeProblem(kPinnedIntoOneExternal(8)),
      { wallMs: 1_000_000, nodeCap: Infinity, now },
      UNBOUNDED,
    );
    expect(ticks).toBeGreaterThan(60);
  });

  it("does not read the clock at all when the budget is unbounded", () => {
    let ticks = 0;
    const now = (): number => ++ticks;
    resolveInfeasibility(
      bakeProblem(kPinnedIntoOneExternal(4)),
      { wallMs: Infinity, nodeCap: Infinity, now },
      UNBOUNDED,
    );
    expect(ticks).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F9 — the business-hours exemption restore is load-bearing in a core
// ---------------------------------------------------------------------------

describe("business hours in core extraction", () => {
  /** Business hours are a single one-hour Tuesday window, and an external
   * fills it completely. The must task is pinned into that same hour, which
   * also exempts it from the floor.
   *
   * Deleting `pinned_at` must free the task to the whole week. If the
   * reduction let the business-hours floor switch on — the task no longer has
   * a pin — its only legal slot would be the one hour the external already
   * occupies, the deletion test would still read "infeasible", and `pinned_at`
   * would be dropped from the core as redundant. */
  function bhCounterfactual(): Problem {
    return makeProblem({
      business_hours: { days: ["tue"], start: "09:00", end: "10:00" },
      external_pinned: [
        {
          id: "ext-0",
          title: "External 0",
          start: at(1, 9),
          duration_minutes: 60,
          context: "meeting",
        },
      ],
      tasks: [makeTask("task-m", { must_include: true, pinned_at: at(1, 9) })],
    });
  }

  it("keeps pinned_at in the core", () => {
    const problem = bhCounterfactual();
    expect(pass1Infeasible(problem)).toBe(true);

    const core = extractCore(bakeProblem(problem), UNBOUNDED);
    expect(coreKeys(core)).toEqual([
      "external_pinned:ext-0",
      "pinned_at:task-m",
      "task_present:task-m",
    ]);
  });

  it("and that core is minimal under the test's own relaxation", () => {
    const problem = bhCounterfactual();
    const core = extractCore(bakeProblem(problem), UNBOUNDED);
    for (const item of core) {
      expect(
        pass1Infeasible(relaxItem(problem, item)),
        `core is not minimal: ${item.type}/${item.task_id ?? "?"} is redundant`,
      ).toBe(false);
    }
  });

  it("a task that genuinely carries the floor still gets a business_hours item", () => {
    // No pin, no window, no mask ⇒ the floor applies, and it is what makes the
    // task unplaceable once the external fills the only legal hour.
    const problem = makeProblem({
      business_hours: { days: ["tue"], start: "09:00", end: "10:00" },
      external_pinned: [
        {
          id: "ext-0",
          title: "External 0",
          start: at(1, 9),
          duration_minutes: 60,
          context: "meeting",
        },
      ],
      tasks: [makeTask("task-m", { must_include: true })],
    });
    const core = extractCore(bakeProblem(problem), UNBOUNDED);
    expect(coreKeys(core)).toEqual([
      "business_hours:task-m",
      "external_pinned:ext-0",
      "task_present:task-m",
    ]);
  });
});
