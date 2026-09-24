import type { BuildSolverProblemInput } from "../../src/planning/build-problem";
import type { Weights, ContextConfig } from "../../src/planning/solver-contract";
import type { Task } from "../../src/types/task";
import type { CalendarEvent } from "../../src/providers/types";

const SYD = "Australia/Sydney";

const WINDOW = { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" };

const WEIGHTS: Weights = {
  time_of_day_fit_per_15min: 5,
  churn_per_15min_moved: 10,
  priority_unit: 1,
  base_drop_penalty: 200,
};

const ALL_CONTEXTS: ContextConfig[] = [
  {
    context: "deep",
    fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "16:00" },
    max_minutes_per_day: 240,
    max_contiguous_minutes: 90,
    over_daily_cap_penalty_per_15min: 25,
    over_streak_cap_penalty_per_15min: 25,
  },
  {
    context: "admin",
    fit_curve: { peak_start: "13:00", peak_end: "17:00", falloff_end: "17:00" },
    max_minutes_per_day: 120,
    max_contiguous_minutes: 60,
    over_daily_cap_penalty_per_15min: 25,
    over_streak_cap_penalty_per_15min: 25,
  },
  {
    context: "physical",
    fit_curve: { peak_start: "16:00", peak_end: "20:00", falloff_end: "22:00" },
    max_minutes_per_day: null,
    max_contiguous_minutes: null,
    over_daily_cap_penalty_per_15min: 0,
    over_streak_cap_penalty_per_15min: 0,
  },
  {
    context: "family",
    fit_curve: { peak_start: "17:00", peak_end: "20:00", falloff_end: "22:00" },
    max_minutes_per_day: null,
    max_contiguous_minutes: null,
    over_daily_cap_penalty_per_15min: 0,
    over_streak_cap_penalty_per_15min: 0,
  },
  {
    context: "meeting",
    fit_curve: { peak_start: "10:00", peak_end: "11:00", falloff_end: "17:00" },
    max_minutes_per_day: 180,
    max_contiguous_minutes: 120,
    over_daily_cap_penalty_per_15min: 25,
    over_streak_cap_penalty_per_15min: 25,
  },
];

function task(overrides: Partial<Task>): Task {
  return {
    id: "task-x",
    title: "task",
    context: "deep",
    priority: 50,
    duration_minutes: 60,
    earliest_start: "2026-05-18T00:00:00Z",
    preferred_windows: [],
    dependencies: [],
    pinned_at: null,
    template_id: null,
    project_id: null,
    source: { kind: "mcp", external_id: null },
    status: "pending",
    created_at: "2026-05-17T00:00:00Z",
    updated_at: "2026-05-17T00:00:00Z",
    ...overrides,
  } as Task;
}

function base(overrides: Partial<BuildSolverProblemInput>): BuildSolverProblemInput {
  return {
    tasks: [],
    externalEvents: [],
    previousSchedule: [],
    window: WINDOW,
    weights: WEIGHTS,
    contexts: ALL_CONTEXTS,
    tz: SYD,
    ...overrides,
  };
}

export const singleAtomicTask: BuildSolverProblemInput = base({
  tasks: [task({ id: "single-A" })],
});

export const multiChunkOrdered: BuildSolverProblemInput = base({
  tasks: [
    task({
      id: "multi-O",
      duration_minutes: undefined,
      chunks: [{ duration_minutes: 60 }, { duration_minutes: 60 }],
      group_policy: { same_day: false, ordered: true },
    }),
  ],
});

export const multiChunkSameDay: BuildSolverProblemInput = base({
  tasks: [
    task({
      id: "multi-S",
      duration_minutes: undefined,
      chunks: [{ duration_minutes: 30 }, { duration_minutes: 30 }],
      group_policy: { same_day: true, ordered: false },
    }),
  ],
});

export const hardDeadline: BuildSolverProblemInput = base({
  tasks: [
    task({
      id: "hard-DL",
      deadline: { at: "2026-05-21T07:00:00Z", hard: true, penalty_per_15min: 0 },
    }),
  ],
});

export const softDeadlineWithPenalty: BuildSolverProblemInput = base({
  tasks: [
    task({
      id: "soft-DL",
      deadline: { at: "2026-05-22T07:00:00Z", hard: false, penalty_per_15min: 30 },
    }),
  ],
});

export const pinnedAt: BuildSolverProblemInput = base({
  tasks: [task({ id: "pin-T", pinned_at: "2026-05-20T09:00:00Z", context: "meeting" })],
});

export const afterTaskDependency: BuildSolverProblemInput = base({
  tasks: [
    task({ id: "dep-A" }),
    task({
      id: "dep-B",
      dependencies: [{ type: "after_task", ref: "dep-A", hard: true }],
    }),
  ],
});

export const preferredWindows: BuildSolverProblemInput = base({
  tasks: [
    task({
      id: "pref-T",
      preferred_windows: [
        { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "12:00", hard: false },
      ],
    }),
  ],
});

export const externalPinnedEvent: BuildSolverProblemInput = base({
  externalEvents: [
    {
      id: "ext-evt-1",
      summary: "External meeting",
      start: "2026-05-19T03:00:00Z",
      end: "2026-05-19T04:00:00Z",
      extendedProperties: undefined,
    } as unknown as CalendarEvent,
  ],
});

export const previousPlacement: BuildSolverProblemInput = base({
  tasks: [task({ id: "prev-T" })],
  previousSchedule: [
    {
      task_id: "prev-T",
      chunk_id: "prev-T#0",
      start: "2026-05-19T00:00:00Z",
      end: "2026-05-19T01:00:00Z",
      context: "deep",
    },
  ],
});

export const allFiveContexts: BuildSolverProblemInput = base({
  tasks: [
    task({ id: "ctx-deep", context: "deep" }),
    task({ id: "ctx-admin", context: "admin" }),
    task({ id: "ctx-physical", context: "physical" }),
    task({ id: "ctx-family", context: "family" }),
    task({ id: "ctx-meeting", context: "meeting" }),
  ],
});

export const softPreferredWindow: BuildSolverProblemInput = base({
  weights: {
    ...WEIGHTS,
    preferred_day_miss: 40,
    preferred_time_miss_per_15min: 5,
  },
  tasks: [
    task({
      id: "soft-pref-W",
      preferred_windows: [
        { days: ["thu", "fri"], start: "09:00", end: "12:00", hard: false },
      ],
    }),
  ],
});
