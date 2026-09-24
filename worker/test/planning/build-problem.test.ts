import { describe, it, expect } from "vitest";
import {
  buildSolverProblem,
  realDurationsByChunkId,
} from "../../src/planning/build-problem";
import type {
  Weights,
  ContextConfig,
} from "../../src/planning/solver-contract";
import type { CalendarEvent } from "../../src/providers/types";
import type { Task } from "../../src/types/task";

const SYD = "Australia/Sydney";

const weights: Weights = {
  time_of_day_fit_per_15min: 5,
  churn_per_15min_moved: 10,
  priority_unit: 1,
  base_drop_penalty: 200,
};

const contexts: ContextConfig[] = [
  {
    context: "deep",
    fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "16:00" },
    max_minutes_per_day: 240,
    max_contiguous_minutes: 90,
    over_daily_cap_penalty_per_15min: 25,
    over_streak_cap_penalty_per_15min: 25,
  },
];

const window = { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" };

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "T1",
    context: "deep",
    priority: 70,
    duration_minutes: 90,
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

describe("buildSolverProblem", () => {
  it("emits window with tz and local-naive start/end", () => {
    const p = buildSolverProblem({
      tasks: [],
      externalEvents: [],
      previousSchedule: [],
      window,
      weights,
      contexts,
      tz: SYD,
    });
    expect(p.window.tz).toBe(SYD);
    expect(p.window.start).toBe("2026-05-18T10:00:00");
    expect(p.window.end).toBe("2026-05-25T10:00:00");
  });

  it("converts atomic task to single chunk with chunk_id <id>#0 and strips bookkeeping", () => {
    const p = buildSolverProblem({
      tasks: [baseTask({ id: "task-A", duration_minutes: 60 })],
      externalEvents: [],
      previousSchedule: [],
      window,
      weights,
      contexts,
      tz: SYD,
    });
    expect(p.tasks).toHaveLength(1);
    expect(p.tasks[0]).toMatchObject({
      id: "task-A",
      title: "T1",
      context: "deep",
      priority: 70,
      chunks: [{ chunk_id: "task-A#0", duration_minutes: 60 }],
      group_policy: { same_day: false, ordered: false },
      earliest_start: "2026-05-18T10:00:00",
      preferred_windows: [],
      dependencies: [],
      previous_placement: [],
    });
    expect(p.tasks[0]).not.toHaveProperty("duration_minutes");
    expect(p.tasks[0]).not.toHaveProperty("source");
    expect(p.tasks[0]).not.toHaveProperty("status");
    expect(p.tasks[0]).not.toHaveProperty("template_id");
    expect(p.tasks[0]).not.toHaveProperty("project_id");
    expect(p.tasks[0]).not.toHaveProperty("created_at");
    expect(p.tasks[0]).not.toHaveProperty("updated_at");
  });

  it("preserves multi-chunk shape and assigns chunk_id <id>#i", () => {
    const t = baseTask({
      id: "task-B",
      duration_minutes: undefined,
      chunks: [{ duration_minutes: 60 }, { duration_minutes: 30 }],
      group_policy: { same_day: true, ordered: true },
    });
    const p = buildSolverProblem({
      tasks: [t],
      externalEvents: [],
      previousSchedule: [],
      window,
      weights,
      contexts,
      tz: SYD,
    });
    expect(p.tasks[0]!.chunks).toEqual([
      { chunk_id: "task-B#0", duration_minutes: 60 },
      { chunk_id: "task-B#1", duration_minutes: 30 },
    ]);
    expect(p.tasks[0]!.group_policy).toEqual({ same_day: true, ordered: true });
  });

  it("projects deadline with local-naive `at` and defaults penalty_per_15min to 0 when absent", () => {
    const p = buildSolverProblem({
      tasks: [
        baseTask({
          id: "task-C",
          deadline: { at: "2026-05-22T07:00:00Z", hard: false },
        }),
      ],
      externalEvents: [],
      previousSchedule: [],
      window,
      weights,
      contexts,
      tz: SYD,
    });
    expect(p.tasks[0]!.deadline).toEqual({
      at: "2026-05-22T17:00:00",
      hard: false,
      penalty_per_15min: 0,
    });
  });

  it("projects must_include through to the wire task (omitted ⇒ false)", () => {
    const p = buildSolverProblem({
      tasks: [
        baseTask({ id: "m1", must_include: true }),
        baseTask({ id: "m2" }), // omitted
      ],
      externalEvents: [],
      previousSchedule: [],
      window,
      weights,
      contexts,
      tz: SYD,
    });
    const byId = Object.fromEntries(p.tasks.map((t) => [t.id, t]));
    expect(byId["m1"]!.must_include).toBe(true);
    expect(byId["m2"]!.must_include).toBe(false);
  });

  describe("placementFloor (decoupled placement)", () => {
    // A mid-week floor: the same week window, but now is Wednesday 2026-05-20
    // 09:07Z → placement may start no earlier than the next quarter slot.
    const floor = "2026-05-20T09:07:00Z"; // rounds DOWN to 09:00Z = 19:00 Sydney

    it("uses placementFloor (rounded down) as the solver window.start, keeping window.end", () => {
      const p = buildSolverProblem({
        tasks: [],
        externalEvents: [],
        previousSchedule: [],
        window,
        placementFloor: floor,
        weights,
        contexts,
        tz: SYD,
      });
      // 09:00Z floor → 19:00 Sydney; week end unchanged.
      expect(p.window.start).toBe("2026-05-20T19:00:00");
      expect(p.window.end).toBe("2026-05-25T10:00:00");
    });

    it("defaults a task's earliest_start to placementFloor (not window.start) when null", () => {
      const p = buildSolverProblem({
        tasks: [baseTask({ id: "task-pf", earliest_start: null })],
        externalEvents: [],
        previousSchedule: [],
        window,
        placementFloor: floor,
        weights,
        contexts,
        tz: SYD,
      });
      expect(p.tasks[0]!.earliest_start).toBe("2026-05-20T19:00:00");
    });

    it("falls back to window.start when placementFloor is omitted", () => {
      const p = buildSolverProblem({
        tasks: [baseTask({ id: "task-nofloor", earliest_start: null })],
        externalEvents: [],
        previousSchedule: [],
        window,
        weights,
        contexts,
        tz: SYD,
      });
      expect(p.window.start).toBe("2026-05-18T10:00:00");
      expect(p.tasks[0]!.earliest_start).toBe("2026-05-18T10:00:00");
    });

    it("releases a hard pin strictly before the placement floor (movable, no wire.pinned_at)", () => {
      // Pinned Monday 2026-05-18 09:00Z, but the floor is Wednesday → released.
      const p = buildSolverProblem({
        tasks: [baseTask({ id: "task-pastpin", pinned_at: "2026-05-18T09:00:00Z" })],
        externalEvents: [],
        previousSchedule: [],
        window,
        placementFloor: floor,
        weights,
        contexts,
        tz: SYD,
      });
      expect(p.tasks[0]).not.toHaveProperty("pinned_at");
    });

    it("preserves a hard pin at or after the placement floor", () => {
      // Pinned Thursday 2026-05-21 09:00Z, which is after the Wednesday floor.
      const p = buildSolverProblem({
        tasks: [baseTask({ id: "task-futurepin", pinned_at: "2026-05-21T09:00:00Z" })],
        externalEvents: [],
        previousSchedule: [],
        window,
        placementFloor: floor,
        weights,
        contexts,
        tz: SYD,
      });
      expect(p.tasks[0]!.pinned_at).toBe("2026-05-21T19:00:00");
    });
  });

  it("converts pinned_at to local-naive when present", () => {
    const p = buildSolverProblem({
      tasks: [baseTask({ id: "task-D", pinned_at: "2026-05-19T09:00:00Z" })],
      externalEvents: [],
      previousSchedule: [],
      window,
      weights,
      contexts,
      tz: SYD,
    });
    expect(p.tasks[0]!.pinned_at).toBe("2026-05-19T19:00:00");
  });

  it("defaults earliest_start to window.start when task earliest_start is null", () => {
    const p = buildSolverProblem({
      tasks: [baseTask({ id: "task-E", earliest_start: null })],
      externalEvents: [],
      previousSchedule: [],
      window,
      weights,
      contexts,
      tz: SYD,
    });
    expect(p.tasks[0]!.earliest_start).toBe("2026-05-18T10:00:00");
  });

  it("maps external (non-scheduler-owned) calendar events to external_pinned with id", () => {
    const events: CalendarEvent[] = [
      {
        id: "evt-ext-1",
        summary: "Client meeting",
        start: "2026-05-19T01:00:00Z",
        end: "2026-05-19T02:00:00Z",
        extendedProperties: undefined,
      } as unknown as CalendarEvent,
    ];
    const p = buildSolverProblem({
      tasks: [],
      externalEvents: events,
      previousSchedule: [],
      window,
      weights,
      contexts,
      tz: SYD,
    });
    expect(p.external_pinned).toEqual([
      {
        id: "evt-ext-1",
        title: "Client meeting",
        start: "2026-05-19T11:00:00",
        duration_minutes: 60,
        context: "meeting",
      },
    ]);
  });

  it("merges overlapping external events into the union busy interval", () => {
    // Real calendars have overlaps (tentative invites, lunch over a meeting,
    // recurring focus block + actual meeting). The solver only moves task
    // chunks, so overlapping external events should collapse into a single
    // busy interval rather than poison the constraint system.
    const events: CalendarEvent[] = [
      { id: "outer", summary: "Quarterly review", start: "2026-05-19T01:00:00Z", end: "2026-05-19T02:30:00Z", extendedProperties: undefined } as unknown as CalendarEvent,
      { id: "inner", summary: "Standup", start: "2026-05-19T01:30:00Z", end: "2026-05-19T01:45:00Z", extendedProperties: undefined } as unknown as CalendarEvent,
      { id: "later", summary: "Other", start: "2026-05-19T03:00:00Z", end: "2026-05-19T04:00:00Z", extendedProperties: undefined } as unknown as CalendarEvent,
    ];
    const p = buildSolverProblem({
      tasks: [], externalEvents: events, previousSchedule: [],
      window, weights, contexts, tz: SYD,
    });
    expect(p.external_pinned).toHaveLength(2);
    expect(p.external_pinned[0]!.duration_minutes).toBe(90);
    expect(p.external_pinned[0]!.start).toBe("2026-05-19T11:00:00");
    expect(p.external_pinned[1]!.duration_minutes).toBe(60);
  });

  it("excludes scheduler-owned calendar events from external_pinned", () => {
    const events: CalendarEvent[] = [
      {
        id: "evt-own",
        summary: "Deep work",
        start: "2026-05-19T01:00:00Z",
        end: "2026-05-19T02:00:00Z",
        extendedProperties: { private: { scheduler_chunk_id: "task-A#0" } },
      } as CalendarEvent,
    ];
    const p = buildSolverProblem({
      tasks: [],
      externalEvents: events,
      previousSchedule: [],
      window,
      weights,
      contexts,
      tz: SYD,
    });
    expect(p.external_pinned).toEqual([]);
  });

  describe("free/busy rules", () => {
    it("drops a cancelled event so it does not block (decision B)", () => {
      const events: CalendarEvent[] = [
        {
          id: "cancelled-1",
          summary: "Cancelled meeting",
          start: "2026-05-19T01:00:00Z",
          end: "2026-05-19T02:00:00Z",
          status: "cancelled",
          extendedProperties: {},
        } as CalendarEvent,
      ];
      const p = buildSolverProblem({
        tasks: [], externalEvents: events, previousSchedule: [],
        window, weights, contexts, tz: SYD,
      });
      expect(p.external_pinned).toEqual([]);
    });

    it("drops a tentative event by default (decision D, toggle off)", () => {
      const events: CalendarEvent[] = [
        {
          id: "tent-1",
          summary: "Maybe call",
          start: "2026-05-19T01:00:00Z",
          end: "2026-05-19T02:00:00Z",
          status: "tentative",
          extendedProperties: {},
        } as CalendarEvent,
      ];
      const p = buildSolverProblem({
        tasks: [], externalEvents: events, previousSchedule: [],
        window, weights, contexts, tz: SYD,
      });
      expect(p.external_pinned).toEqual([]);
    });

    it("blocks a tentative event when tentativeIsBusy is true (decision D, toggle on)", () => {
      const events: CalendarEvent[] = [
        {
          id: "tent-2",
          summary: "Maybe call",
          start: "2026-05-19T01:00:00Z",
          end: "2026-05-19T02:00:00Z",
          status: "tentative",
          extendedProperties: {},
        } as CalendarEvent,
      ];
      const p = buildSolverProblem({
        tasks: [], externalEvents: events, previousSchedule: [],
        window, weights, contexts, tz: SYD, tentativeIsBusy: true,
      });
      expect(p.external_pinned).toEqual([
        {
          id: "tent-2",
          title: "Maybe call",
          start: "2026-05-19T11:00:00",
          duration_minutes: 60,
          context: "meeting",
        },
      ]);
    });

    it("expands an all-day busy event into a whole-local-day block (decision C)", () => {
      // Google all-day: start.date=2026-05-19, end.date=2026-05-20 (exclusive),
      // coerced by the provider to UTC-midnight instants. In Sydney the busy
      // block must cover local 2026-05-19 00:00 -> 2026-05-20 00:00 = 1440 min.
      const events: CalendarEvent[] = [
        {
          id: "allday-busy",
          summary: "Conference",
          start: "2026-05-19T00:00:00Z",
          end: "2026-05-20T00:00:00Z",
          isAllDay: true,
          extendedProperties: {},
        } as CalendarEvent,
      ];
      const p = buildSolverProblem({
        tasks: [], externalEvents: events, previousSchedule: [],
        window, weights, contexts, tz: SYD,
      });
      expect(p.external_pinned).toEqual([
        {
          id: "allday-busy",
          title: "Conference",
          start: "2026-05-19T00:00:00",
          duration_minutes: 1440,
          context: "meeting",
        },
      ]);
    });

    it("expands a timed outOfOffice event into a whole-local-day block (decision C)", () => {
      // A timed OOO (09:00-17:00 local) still blocks the WHOLE local day.
      const events: CalendarEvent[] = [
        {
          id: "ooo-timed",
          summary: "Out of office",
          start: "2026-05-18T23:00:00Z", // 2026-05-19 09:00 Sydney
          end: "2026-05-19T07:00:00Z",   // 2026-05-19 17:00 Sydney
          eventType: "outOfOffice",
          extendedProperties: {},
        } as CalendarEvent,
      ];
      const p = buildSolverProblem({
        tasks: [], externalEvents: events, previousSchedule: [],
        window, weights, contexts, tz: SYD,
      });
      expect(p.external_pinned).toEqual([
        {
          id: "ooo-timed",
          title: "Out of office",
          start: "2026-05-19T00:00:00",
          duration_minutes: 1440,
          context: "meeting",
        },
      ]);
    });
  });

  it("embeds previous_placement per task from the flat previousSchedule input", () => {
    const p = buildSolverProblem({
      tasks: [baseTask({ id: "task-F" }), baseTask({ id: "task-G" })],
      externalEvents: [],
      previousSchedule: [
        {
          task_id: "task-F",
          chunk_id: "task-F#0",
          start: "2026-05-19T00:00:00Z",
          end: "2026-05-19T01:30:00Z",
          context: "deep",
        },
        {
          task_id: "task-F",
          chunk_id: "task-F#1",
          start: "2026-05-20T00:00:00Z",
          end: "2026-05-20T01:00:00Z",
          context: "deep",
        },
      ],
      window,
      weights,
      contexts,
      tz: SYD,
    });
    expect(p.tasks.find((t) => t.id === "task-F")!.previous_placement).toEqual([
      { chunk_id: "task-F#0", start: "2026-05-19T10:00:00" },
      { chunk_id: "task-F#1", start: "2026-05-20T10:00:00" },
    ]);
    expect(p.tasks.find((t) => t.id === "task-G")!.previous_placement).toEqual([]);
  });

  it("merges weightsOverride on top of base weights", () => {
    const p = buildSolverProblem({
      tasks: [],
      externalEvents: [],
      previousSchedule: [],
      window,
      weights,
      contexts,
      tz: SYD,
      weightsOverride: { churn_per_15min_moved: 50 },
    });
    expect(p.weights.churn_per_15min_moved).toBe(50);
    expect(p.weights.time_of_day_fit_per_15min).toBe(5);
  });

  it("rounds window.start DOWN and window.end UP to the 15-minute boundary", () => {
    const p = buildSolverProblem({
      tasks: [],
      externalEvents: [],
      previousSchedule: [],
      // start is 4 min past :00 → should round DOWN to :00 (10:00 in Sydney).
      // end is 13 min past :00 → should round UP to :15 (10:15 in Sydney).
      window: { start: "2026-05-18T00:04:00Z", end: "2026-05-25T00:13:00Z" },
      weights,
      contexts,
      tz: SYD,
    });
    expect(p.window.start).toBe("2026-05-18T10:00:00");
    expect(p.window.end).toBe("2026-05-25T10:15:00");
  });

  it("rounds external event boundaries outward; duration covers the rounded span", () => {
    const events: CalendarEvent[] = [
      {
        id: "evt-odd",
        summary: "Off-grid meeting",
        // 01:08:00Z → 02:38:00Z in UTC (real duration 90 min).
        // After conservative rounding: 01:00:00Z → 02:45:00Z = 105 min.
        // In Sydney (+10h): start = 11:00:00.
        start: "2026-05-19T01:08:00Z",
        end: "2026-05-19T02:38:00Z",
        extendedProperties: undefined,
      } as unknown as CalendarEvent,
    ];
    const p = buildSolverProblem({
      tasks: [],
      externalEvents: events,
      previousSchedule: [],
      window,
      weights,
      contexts,
      tz: SYD,
    });
    expect(p.external_pinned).toEqual([
      {
        id: "evt-odd",
        title: "Off-grid meeting",
        start: "2026-05-19T11:00:00",
        duration_minutes: 105,
        context: "meeting",
      },
    ]);
  });

  it("rounds an atomic task duration UP to the next quarter hour for the solver", () => {
    const p = buildSolverProblem({
      tasks: [baseTask({ id: "task-A", duration_minutes: 20 })],
      externalEvents: [],
      previousSchedule: [],
      window,
      weights,
      contexts,
      tz: SYD,
    });
    expect(p.tasks[0]!.chunks).toEqual([
      { chunk_id: "task-A#0", duration_minutes: 30 },
    ]);
  });

  it("leaves already-aligned atomic durations unchanged (round-up identity)", () => {
    const p45 = buildSolverProblem({
      tasks: [baseTask({ id: "task-45", duration_minutes: 45 })],
      externalEvents: [],
      previousSchedule: [],
      window,
      weights,
      contexts,
      tz: SYD,
    });
    expect(p45.tasks[0]!.chunks).toEqual([
      { chunk_id: "task-45#0", duration_minutes: 45 },
    ]);
    const p30 = buildSolverProblem({
      tasks: [baseTask({ id: "task-30", duration_minutes: 30 })],
      externalEvents: [],
      previousSchedule: [],
      window,
      weights,
      contexts,
      tz: SYD,
    });
    expect(p30.tasks[0]!.chunks).toEqual([
      { chunk_id: "task-30#0", duration_minutes: 30 },
    ]);
  });

  it("rounds each chunk of a multi-chunk task UP to the next quarter hour", () => {
    const t = baseTask({
      id: "task-MC",
      duration_minutes: undefined,
      chunks: [{ duration_minutes: 20 }, { duration_minutes: 50 }],
      group_policy: { same_day: true, ordered: true },
    });
    const p = buildSolverProblem({
      tasks: [t],
      externalEvents: [],
      previousSchedule: [],
      window,
      weights,
      contexts,
      tz: SYD,
    });
    expect(p.tasks[0]!.chunks).toEqual([
      { chunk_id: "task-MC#0", duration_minutes: 30 },
      { chunk_id: "task-MC#1", duration_minutes: 60 },
    ]);
  });

  it("returns top-level shape: window/weights/contexts/tasks/external_pinned/business_hours", () => {
    const p = buildSolverProblem({
      tasks: [],
      externalEvents: [],
      previousSchedule: [],
      window,
      weights,
      contexts,
      tz: SYD,
    });
    expect(Object.keys(p).sort()).toEqual([
      "business_hours",
      "contexts",
      "external_pinned",
      "tasks",
      "weights",
      "window",
    ]);
    // Omitted businessHours → explicit null (no policy), not undefined.
    expect(p.business_hours).toBeNull();
  });
});

describe("realDurationsByChunkId", () => {
  it("maps an atomic task to its UNROUNDED real duration keyed by <id>#0", () => {
    const m = realDurationsByChunkId([baseTask({ id: "task-A", duration_minutes: 20 })]);
    expect(m).toEqual(new Map([["task-A#0", 20]]));
  });

  it("maps each chunk of a multi-chunk task to its UNROUNDED real duration keyed by <id>#i", () => {
    const t = baseTask({
      id: "task-MC",
      duration_minutes: undefined,
      chunks: [{ duration_minutes: 20 }, { duration_minutes: 50 }],
      group_policy: { same_day: true, ordered: true },
    });
    const m = realDurationsByChunkId([t]);
    expect(m).toEqual(
      new Map([
        ["task-MC#0", 20],
        ["task-MC#1", 50],
      ]),
    );
  });
});
