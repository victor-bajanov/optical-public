import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runResolve } from "../../src/planning/resolve-internal";
import { fromLocalNaive } from "../../src/planning/datetime";
import type { LocalNaive } from "../../src/planning/solver-contract";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { loadCompletedChunkIdsByTask } from "../../src/db/chunk-completions";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";

const baseTask = {
  id: "t1",
  title: "Deep work",
  context: "deep",
  priority: 80,
  duration_minutes: 90,
  earliest_start: "2026-05-18T00:00:00Z",
};

describe("runResolve", () => {
  // Freeze the clock at the start of the earliest fixed window used below
  // (2026-05-18). The fully-past-week guard skips any week whose windowEnd <=
  // now; without a frozen clock these fixed historical windows would be
  // classified as past once the real date moves beyond them and the solver-path
  // assertions here would never run. The clock-relative tests (floor / past-pin /
  // guard) derive their windows from Date.now(), so they remain self-consistent
  // against this same frozen instant.
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
    await env.DB.prepare("DELETE FROM users").run();
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare("DELETE FROM task_templates").run();
    await env.DB.prepare("DELETE FROM chunk_completions").run();
    await env.DB.prepare("DELETE FROM proposed_plans").run();
    await env.DB.prepare("DELETE FROM config_weights").run();
    await env.DB.prepare("DELETE FROM config_contexts").run();
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)").bind(JSON.stringify({ time_of_day_fit_per_15min: 5, churn_per_15min_moved: 10, priority_unit: 1, base_drop_penalty: 200 })).run();
    await env.DB.prepare("INSERT INTO config_contexts (owner_subject, context, body) VALUES ('__default__', ?, ?)").bind("deep", JSON.stringify({ context: "deep", fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "16:00" }, max_minutes_per_day: 240, max_contiguous_minutes: 90, over_daily_cap_penalty_per_15min: 25, over_streak_cap_penalty_per_15min: 25 })).run();
    await seedMissingDefaultContexts();
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', '2026-05-17T00:00:00Z', '2026-05-17T00:00:00Z')").bind("t1", "primary", JSON.stringify(baseTask)).run();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns plan_hash + body on success", async () => {
    const stubSolver = { fetch: async () => new Response(JSON.stringify({ schedule: [{ task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00", duration_minutes: 90, context: "deep" }], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } }) } as unknown as Fetcher;
    const cal = new MockCalendarProvider();
    const r = await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") throw new Error("unreachable");
    expect(r.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.schedule).toHaveLength(1);
    const row = await env.DB.prepare("SELECT plan_hash FROM proposed_plans WHERE plan_hash = ?").bind(r.planHash).first();
    expect(row).not.toBeNull();
  });

  it("supersedes older pending plans for the same window on insert", async () => {
    // A stale pending plan for the SAME subject+window, different hash.
    await env.DB
      .prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end) VALUES ('stale-plan', ?, '2026-05-17T00:00:00Z', '2099-01-01T00:00:00Z', NULL, 'primary', '2026-05-18T00:00:00Z', '2026-05-25T00:00:00Z')")
      .bind(JSON.stringify({ schedule: [], dropped: [], window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" } }))
      .run();
    // A pending plan for a DIFFERENT window must survive.
    await env.DB
      .prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end) VALUES ('other-week', ?, '2026-05-17T00:00:00Z', '2099-01-01T00:00:00Z', NULL, 'primary', '2026-05-25T00:00:00Z', '2026-06-01T00:00:00Z')")
      .bind(JSON.stringify({ schedule: [], dropped: [], window: { start: "2026-05-25T00:00:00Z", end: "2026-06-01T00:00:00Z" } }))
      .run();
    const stubSolver = { fetch: async () => new Response(JSON.stringify({ schedule: [{ task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00", duration_minutes: 90, context: "deep" }], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } }) } as unknown as Fetcher;
    const r = await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: new MockCalendarProvider(),
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    const stale = await env.DB.prepare("SELECT plan_hash FROM proposed_plans WHERE plan_hash = 'stale-plan'").first();
    const other = await env.DB.prepare("SELECT plan_hash FROM proposed_plans WHERE plan_hash = 'other-week'").first();
    expect(stale).toBeNull();
    expect(other).not.toBeNull();
  });

  it("merges tasks.id column into Task when body omits id (production materialisation shape)", async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
    // Mimic what materialiseTemplate writes: body has no id field.
    const bodyWithoutId = { title: "Recurring standup", context: "deep", priority: 50, duration_minutes: 15, earliest_start: "2026-05-19T22:00:00Z", pinned_at: "2026-05-19T22:00:00Z" };
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', '2026-05-18T00:00:00Z', '2026-05-18T00:00:00Z')").bind("materialised-1", "primary", JSON.stringify(bodyWithoutId)).run();

    let capturedTaskId: string | undefined;
    let capturedChunkId: string | undefined;
    const stubSolver = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { tasks: Array<{ id: string; chunks: Array<{ chunk_id: string }> }> };
      capturedTaskId = body.tasks[0]?.id;
      capturedChunkId = body.tasks[0]?.chunks[0]?.chunk_id;
      return new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;
    const cal = new MockCalendarProvider();
    await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(capturedTaskId).toBe("materialised-1");
    expect(capturedChunkId).toBe("materialised-1#0");
  });

  it("excludes tasks pinned outside the resolve window so old committed residue can't poison the solver", async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
    // A task pinned in June (outside the August resolve window).
    const oldPinned = { title: "June standup", context: "deep", priority: 50, duration_minutes: 15, earliest_start: "2026-06-01T22:00:00Z", pinned_at: "2026-06-01T22:00:00Z" };
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'committed', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')").bind("old-residue", "primary", JSON.stringify(oldPinned)).run();
    // A task pinned inside the August window.
    const insidePinned = { title: "Aug standup", context: "deep", priority: 50, duration_minutes: 15, earliest_start: "2026-08-10T22:00:00Z", pinned_at: "2026-08-10T22:00:00Z" };
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')").bind("inside-window", "primary", JSON.stringify(insidePinned)).run();

    let capturedIds: string[] = [];
    const stubSolver = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { tasks: Array<{ id: string }> };
      capturedIds = body.tasks.map((t) => t.id);
      return new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;
    const cal = new MockCalendarProvider();
    await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2026-08-10T00:00:00Z",
      windowEnd: "2026-08-17T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(capturedIds).toContain("inside-window");
    expect(capturedIds).not.toContain("old-residue");
  });

  it("sheds a task whose scheduled_for stamp is in a past week", async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
    // Committed to last week (scheduled_for column set), undeadlined.
    const lastWeekTask = { title: "Last week's deep work", context: "deep", priority: 60, duration_minutes: 60 };
    await env.DB
      .prepare("INSERT INTO tasks (id, owner_subject, body, status, scheduled_for, created_at, updated_at) VALUES (?, ?, ?, 'committed', ?, '2026-05-11T00:00:00Z', '2026-05-11T00:00:00Z')")
      .bind("shed-me", "primary", JSON.stringify(lastWeekTask), "2026-05-11T09:00:00Z")
      .run();
    // A normal backlog task with no positional anchor for this week.
    const keepTask = { title: "This week's deep work", context: "deep", priority: 60, duration_minutes: 60 };
    await env.DB
      .prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', '2026-05-18T00:00:00Z', '2026-05-18T00:00:00Z')")
      .bind("keep-me", "primary", JSON.stringify(keepTask))
      .run();

    let capturedIds: string[] = [];
    const stubSolver = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { tasks: Array<{ id: string }> };
      capturedIds = body.tasks.map((t) => t.id);
      return new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;
    const cal = new MockCalendarProvider();
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(capturedIds).toContain("keep-me");
    expect(capturedIds).not.toContain("shed-me");
    expect(infoSpy).toHaveBeenCalledWith("resolve_window_shed", expect.objectContaining({ excluded_past: 1, kept: 1 }));
    infoSpy.mockRestore();
  });

  it("returns 200 (not unsat) for a committed task with a hard deadline before the window", async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
    // A legacy committed task with a hard deadline in the past and NO stamp.
    // Pre-fix this poisoned the solver: a hard deadline is mandatory, compiles
    // to chunk_end <= <negative slot>, and the whole resolve returns 422.
    const overdue = {
      title: "June deliverable",
      context: "deep",
      priority: 90,
      duration_minutes: 60,
      deadline: { at: "2026-06-15T17:00:00Z", hard: true },
    };
    await env.DB
      .prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'committed', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')")
      .bind("overdue-hard", "primary", JSON.stringify(overdue))
      .run();

    let capturedIds: string[] = [];
    const stubSolver = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { tasks: Array<{ id: string }> };
      capturedIds = body.tasks.map((t) => t.id);
      return new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;
    const cal = new MockCalendarProvider();
    // Resolve a window in 2027, well after the June-2026 deadline.
    const r = await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2027-02-08T00:00:00Z",
      windowEnd: "2027-02-15T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    // Shed before reaching the solver, so it can never appear in an unsat core.
    expect(capturedIds).not.toContain("overdue-hard");
  });

  it("drops previous_placement entries from the week's committed plan whose schedule sits outside the new resolve window", async () => {
    // The mid-week-narrowing shape: the committed plan IS this week's, but one
    // entry has elapsed and one falls past the narrowed window end. Passing
    // either through makes the solver constrain placements to impossible slots
    // and crash (see internal design notes). parseSolution
    // converts solver naive-local to ISO-Z before storage, so committed plans
    // always carry ISO-Z starts. Mirror that here.
    const priorPlan = {
      schedule: [
        // Mon 18 May 09:00 local — inside the plan's week, before windowStart.
        { task_id: "t1", chunk_id: "t1#0", start: "2026-05-17T23:00:00.000Z", end: "2026-05-18T00:30:00.000Z", context: "deep" },
        // After the narrowed window end.
        { task_id: "t1", chunk_id: "t1#1", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z", context: "deep" },
      ],
      dropped: [],
      window: { start: "2026-05-17T14:00:00.000Z", end: "2026-05-24T14:00:00.000Z" },
    };
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end) VALUES (?, ?, ?, ?, ?, 'primary', ?, ?)",
    )
      .bind("prior", JSON.stringify(priorPlan), "2026-05-11T00:00:00Z", "2026-05-12T00:00:00Z", "2026-05-11T00:00:00Z", priorPlan.window.start, priorPlan.window.end)
      .run();

    let capturedPrev: Array<{ chunk_id: string; start: string }> | undefined;
    const stubSolver = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { tasks: Array<{ id: string; previous_placement: Array<{ chunk_id: string; start: string }> }> };
      capturedPrev = body.tasks.find((t) => t.id === "t1")?.previous_placement;
      return new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;
    const cal = new MockCalendarProvider();
    await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",  // both prior entries are outside this window (one before, one on the boundary day)
      windowEnd: "2026-05-19T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(capturedPrev).toEqual([]);
  });

  // --- Churn baseline sourcing (an internal issue + the null-baseline todo card) -----
  // The baseline reaching the solver is `tasks[].previous_placement`, in
  // solver-local naive time; these tests read it off a captured request.
  const seedCommittedPlan = (
    hash: string,
    window: { start: string; end: string },
    committedAt: string,
    schedule: unknown[],
  ) =>
    env.DB
      .prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end) VALUES (?, ?, '2026-05-17T00:00:00Z', '2099-01-01T00:00:00Z', ?, 'primary', ?, ?)")
      .bind(hash, JSON.stringify({ schedule, dropped: [], window }), committedAt, window.start, window.end)
      .run();

  function capturingSolver(sink: Map<string, Array<{ chunk_id: string; start: string }>>): Fetcher {
    return { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { tasks: Array<{ id: string; previous_placement: Array<{ chunk_id: string; start: string }> }> };
      for (const t of body.tasks) sink.set(t.id, t.previous_placement);
      return new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;
  }

  it("anchors churn on the committed plan for the RESOLVED week, not the globally-latest one", async () => {
    // An internal issue (prod 2026-08-25): the newest committed plan was for a different
    // week, the window filter emptied it, and the future week resolved churn-free.
    await env.DB.prepare("DELETE FROM tasks").run();
    for (const id of ["t1", "t2"]) {
      // earliest_start inside the window: a pure backlog task is shed from a
      // window that has not started yet (taskBelongsInWindow).
      await env.DB
        .prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, 'primary', ?, 'pending', '2026-05-17T00:00:00Z', '2026-05-17T00:00:00Z')")
        .bind(id, JSON.stringify({ title: id, context: "deep", priority: 80, duration_minutes: 60, earliest_start: "2026-05-26T23:00:00Z" }))
        .run();
    }
    // The committed plan for the week being resolved (Mon 25 May local): t1 on
    // Thu — inside the Wed-narrowed window — and t2 on Mon, already elapsed.
    await seedCommittedPlan(
      "week-n1",
      { start: "2026-05-24T14:00:00.000Z", end: "2026-05-31T14:00:00.000Z" },
      "2026-05-17T02:00:00Z",
      [
        { task_id: "t1", chunk_id: "t1#0", start: "2026-05-27T23:00:00.000Z", end: "2026-05-28T00:00:00.000Z", context: "deep" },
        { task_id: "t2", chunk_id: "t2#0", start: "2026-05-24T23:00:00.000Z", end: "2026-05-25T00:00:00.000Z", context: "deep" },
      ],
    );
    // A plan for the PREVIOUS week, committed later — the globally-latest row.
    await seedCommittedPlan(
      "week-n",
      { start: "2026-05-17T14:00:00.000Z", end: "2026-05-24T14:00:00.000Z" },
      "2026-05-17T03:00:00Z",
      [{ task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T23:00:00.000Z", end: "2026-05-20T00:00:00.000Z", context: "deep" }],
    );

    const captured = new Map<string, Array<{ chunk_id: string; start: string }>>();
    await runResolve({
      env: { ...env, SOLVER: capturingSolver(captured) },
      calendar: new MockCalendarProvider(),
      windowStart: "2026-05-26T23:00:00Z", // Wed 27 May 09:00 local — mid-week narrowing
      windowEnd: "2026-05-31T14:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    // Thu 28 May 09:00 local: the overlap survives and anchors churn.
    expect(captured.get("t1")).toEqual([{ chunk_id: "t1#0", start: "2026-05-28T09:00:00" }]);
    // Mon 25 May 09:00 local is outside the narrowed window — no anchor.
    expect(captured.get("t2")).toEqual([]);
  });

  it("falls back to the live scheduler-owned calendar events when there is no committed plan", async () => {
    // The null-baseline card: an organiser who never accepts a replan has no
    // committed plan, and the week used to solve with no continuity pressure.
    const cal = new MockCalendarProvider({
      events: [
        { id: "sch-1", summary: "Deep work", start: "2026-05-18T23:00:00.000Z", end: "2026-05-19T00:30:00.000Z", extendedProperties: { private: { scheduler_chunk_id: "t1#0" } } },
      ],
    });
    const captured = new Map<string, Array<{ chunk_id: string; start: string }>>();
    await runResolve({
      env: { ...env, SOLVER: capturingSolver(captured) },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(captured.get("t1")).toEqual([{ chunk_id: "t1#0", start: "2026-05-19T09:00:00" }]);
  });

  it("prefers the week's committed plan over a disagreeing calendar event (no per-chunk merge)", async () => {
    await seedCommittedPlan(
      "this-week",
      { start: "2026-05-17T14:00:00.000Z", end: "2026-05-24T14:00:00.000Z" },
      "2026-05-17T02:00:00Z",
      [{ task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T23:00:00.000Z", end: "2026-05-20T00:30:00.000Z", context: "deep" }],
    );
    const cal = new MockCalendarProvider({
      events: [
        { id: "sch-1", summary: "Deep work", start: "2026-05-18T23:00:00.000Z", end: "2026-05-19T00:30:00.000Z", extendedProperties: { private: { scheduler_chunk_id: "t1#0" } } },
      ],
    });
    const captured = new Map<string, Array<{ chunk_id: string; start: string }>>();
    await runResolve({
      env: { ...env, SOLVER: capturingSolver(captured) },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    // Wed 20 May 09:00 local (the plan), not Tue 19 May 09:00 (the calendar).
    expect(captured.get("t1")).toEqual([{ chunk_id: "t1#0", start: "2026-05-20T09:00:00" }]);
  });

  it("buckets the baseline week in SCHEDULER_TZ — the tz that produced the window — even for a home_tz user", async () => {
    // Every windowStart producer (webhook, cron, accept) anchors on
    // SCHEDULER_TZ, and a Sydney week straddles two UTC weeks. Bucketing the
    // lookup in a UTC user's home_tz therefore splits the week: this mid-week
    // resolve lands in the UTC week AFTER its own Mon-anchored plan's, and the
    // user misses their own baseline.
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare("INSERT INTO users (subject, home_tz, created_at) VALUES ('primary', 'UTC', '2026-05-01T00:00:00Z')").run();
    await env.DB
      .prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES ('t1', 'primary', ?, 'pending', '2026-05-17T00:00:00Z', '2026-05-17T00:00:00Z')")
      .bind(JSON.stringify({ title: "Deep work", context: "deep", priority: 80, duration_minutes: 60, earliest_start: "2026-05-19T23:00:00Z" }))
      .run();
    // Mon-anchored plan for the Sydney week of Mon 18 May.
    await seedCommittedPlan(
      "sydney-week",
      { start: "2026-05-17T14:00:00.000Z", end: "2026-05-24T14:00:00.000Z" },
      "2026-05-17T02:00:00Z",
      [{ task_id: "t1", chunk_id: "t1#0", start: "2026-05-20T23:00:00.000Z", end: "2026-05-21T00:00:00.000Z", context: "deep" }],
    );
    const captured = new Map<string, Array<{ chunk_id: string; start: string }>>();
    await runResolve({
      env: { ...env, SOLVER: capturingSolver(captured) },
      calendar: new MockCalendarProvider(),
      windowStart: "2026-05-19T23:00:00Z", // Wed 20 May 09:00 Sydney — mid-week narrowing
      windowEnd: "2026-05-24T14:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    // home_tz drives the naive projection, so the anchor renders as its Z-time.
    expect(captured.get("t1")).toEqual([{ chunk_id: "t1#0", start: "2026-05-20T23:00:00" }]);
  });

  it("returns unsat result when solver returns 422", async () => {
    const stubSolver = { fetch: async () => new Response(JSON.stringify({ unsat_core: [{ type: "pinned_at", task_id: "t1", value: "x" }] }), { status: 422, headers: { "content-type": "application/json" } }) } as unknown as Fetcher;
    const cal = new MockCalendarProvider();
    const r = await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("unsat");
  });

  it("normalizes priorEvents start/end to ISO-Z when the calendar event uses an offset form", async () => {
    const stubSolver = { fetch: async () => new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } }) } as unknown as Fetcher;
    // Google returns RFC3339 with a zone offset, not Z-with-millis. The proposed
    // schedule is always ISO-Z, so the baseline must be normalized to compare equal.
    const cal = new MockCalendarProvider({
      events: [
        { id: "sch-1", summary: "Deep work", start: "2026-05-19T09:00:00+10:00", end: "2026-05-19T10:30:00+10:00", extendedProperties: { private: { scheduler_chunk_id: "t1#0" } } },
      ],
    });
    const r = await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") throw new Error("unreachable");
    expect(r.priorEvents).toEqual([
      { chunk_id: "t1#0", task_id: "t1", start: "2026-05-18T23:00:00.000Z", end: "2026-05-19T00:30:00.000Z", context: "" },
    ]);
  });

  it("returns priorEvents: scheduler-owned calendar events in the window, keyed by chunk_id", async () => {
    const stubSolver = { fetch: async () => new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } }) } as unknown as Fetcher;
    // One scheduler-owned event (carries scheduler_chunk_id) and one plain
    // external event (no metadata) — only the scheduler-owned one is a baseline.
    const cal = new MockCalendarProvider({
      events: [
        { id: "sch-1", summary: "Deep work", start: "2026-05-18T23:00:00.000Z", end: "2026-05-19T00:30:00.000Z", extendedProperties: { private: { scheduler_chunk_id: "t1#0" } } },
        { id: "ext-1", summary: "External meeting", start: "2026-05-19T03:00:00.000Z", end: "2026-05-19T04:00:00.000Z", extendedProperties: {} },
      ],
    });
    const r = await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") throw new Error("unreachable");
    expect(r.priorEvents).toEqual([
      { chunk_id: "t1#0", task_id: "t1", start: "2026-05-18T23:00:00.000Z", end: "2026-05-19T00:30:00.000Z", context: "" },
    ]);
  });

  it("floors the solver window.start at now for an in-progress week (placement floor)", async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
    // A current-week window straddling `now` (real test clock). The fetch and
    // selection windows stay week-wide, but the solver window.start must be
    // floored to >= now, never the (already-elapsed) week start.
    const nowMs = Date.now();
    const windowStart = new Date(nowMs - 3 * 24 * 3600 * 1000).toISOString(); // 3 days ago
    const windowEnd = new Date(nowMs + 4 * 24 * 3600 * 1000).toISOString();   // 4 days ahead
    // An unpinned task with no earliest_start → floors at the placement floor.
    const t = { id: "floor-task", title: "T", context: "deep", priority: 60, duration_minutes: 60 };
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', '2026-05-17T00:00:00Z', '2026-05-17T00:00:00Z')").bind("floor-task", "primary", JSON.stringify(t)).run();

    let problem: { window: { start: string }; tasks: Array<{ id: string; earliest_start: string }> } | undefined;
    const stubSolver = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      problem = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;
    const cal = new MockCalendarProvider();
    await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart,
      windowEnd,
      accountEmail: "primary",
      trigger: "api",
    });
    // The solver window.start is local-naive; compare it (in env.SCHEDULER_TZ)
    // back to an instant and assert it is strictly after the week start — i.e.
    // the past portion of the week was floored away.
    expect(problem).toBeTruthy();
    const startNaive = problem!.window.start;
    // local-naive Sydney → must be >= now (well after the 3-days-ago week start).
    // The unpinned task earliest_start equals the same floored start.
    expect(problem!.tasks[0]!.earliest_start).toBe(startNaive);
    // The floored naive start, read back in Sydney, must be >= the week start
    // (it is now-rounded, days after the 3-days-ago week start).
    const flooredMs = Date.parse(fromLocalNaive(startNaive as LocalNaive, env.SCHEDULER_TZ ?? "Australia/Sydney"));
    expect(flooredMs).toBeGreaterThan(Date.parse(windowStart));
    // And it is the next-quarter ceil of now, NOT merely some instant after the
    // 3-days-ago week start — a floor off by days would still pass the >weekStart
    // check above. The floor is ceilToQuarter(now), so it lands in [now, now+15min].
    const QUARTER_MS = 15 * 60_000;
    expect(flooredMs).toBeGreaterThanOrEqual(nowMs);
    expect(flooredMs).toBeLessThanOrEqual(nowMs + QUARTER_MS);
  });

  it("releases a hard pin that has already elapsed so the task reschedules forward", async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
    const nowMs = Date.now();
    const windowStart = new Date(nowMs - 3 * 24 * 3600 * 1000).toISOString();
    const windowEnd = new Date(nowMs + 4 * 24 * 3600 * 1000).toISOString();
    // Pinned 2 days ago — strictly before the placement floor → released.
    const pastPinnedAt = new Date(nowMs - 2 * 24 * 3600 * 1000);
    pastPinnedAt.setUTCSeconds(0, 0);
    pastPinnedAt.setUTCMinutes(0);
    const pastTask = { id: "past-pin", title: "T", context: "deep", priority: 60, duration_minutes: 60, pinned_at: pastPinnedAt.toISOString() };
    // Pinned 2 days ahead — at/after the floor → preserved.
    const futurePinnedAt = new Date(nowMs + 2 * 24 * 3600 * 1000);
    futurePinnedAt.setUTCSeconds(0, 0);
    futurePinnedAt.setUTCMinutes(0);
    const futureTask = { id: "future-pin", title: "T", context: "deep", priority: 60, duration_minutes: 60, pinned_at: futurePinnedAt.toISOString() };
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', '2026-05-17T00:00:00Z', '2026-05-17T00:00:00Z')").bind("past-pin", "primary", JSON.stringify(pastTask)).run();
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', '2026-05-17T00:00:00Z', '2026-05-17T00:00:00Z')").bind("future-pin", "primary", JSON.stringify(futureTask)).run();

    let problem: { tasks: Array<{ id: string; pinned_at?: string }> } | undefined;
    const stubSolver = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      problem = JSON.parse(init!.body as string);
      return new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;
    const cal = new MockCalendarProvider();
    await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart,
      windowEnd,
      accountEmail: "primary",
      trigger: "api",
    });
    const past = problem!.tasks.find((t) => t.id === "past-pin")!;
    const future = problem!.tasks.find((t) => t.id === "future-pin")!;
    expect(past.pinned_at).toBeUndefined();
    expect(future.pinned_at).toBeTruthy();
  });

  it("skips a fully-past week: never calls the solver, persists no plan (fully-past-week guard)", async () => {
    // A week whose windowEnd is strictly before now. Resolving it would set
    // placementFloor (= ceilToQuarter(now)) past windowEnd and mass-drop every
    // task. The week-iterating callers must skip such a week entirely, so
    // runResolve short-circuits BEFORE the solver and persists nothing.
    const nowMs = Date.now();
    const windowStart = new Date(nowMs - 14 * 24 * 3600 * 1000).toISOString(); // 2 weeks ago
    const windowEnd = new Date(nowMs - 7 * 24 * 3600 * 1000).toISOString();    // 1 week ago (< now)

    let solverCalled = false;
    const stubSolver = { fetch: async () => {
      solverCalled = true;
      return new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;
    const cal = new MockCalendarProvider();
    const r = await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart,
      windowEnd,
      accountEmail: "primary",
      trigger: "api",
    });
    // Skipped: solver untouched, an empty (diff-clean) plan, no DB row persisted.
    expect(solverCalled).toBe(false);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") throw new Error("unreachable");
    expect(r.body.schedule).toEqual([]);
    expect(r.priorEvents).toEqual([]);
    const row = await env.DB.prepare("SELECT plan_hash FROM proposed_plans WHERE plan_hash = ?").bind(r.planHash).first();
    expect(row).toBeNull();
  });

  it("never reads another owner's pending tasks", async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
    const aTask = { id: "a1", title: "A task", context: "deep", priority: 80, duration_minutes: 90, earliest_start: "2026-05-18T00:00:00Z" };
    const bTask = { id: "b1", title: "B task", context: "deep", priority: 80, duration_minutes: 90, earliest_start: "2026-05-18T00:00:00Z" };
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', '2026-05-17T00:00:00Z', '2026-05-17T00:00:00Z')").bind("a1", "owner-a", JSON.stringify(aTask)).run();
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', '2026-05-17T00:00:00Z', '2026-05-17T00:00:00Z')").bind("b1", "owner-b", JSON.stringify(bTask)).run();

    let capturedIds: string[] = [];
    const stubSolver = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { tasks: Array<{ id: string }> };
      capturedIds = body.tasks.map((t) => t.id);
      return new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;
    const cal = new MockCalendarProvider();
    await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "owner-a",
      trigger: "api",
    });
    expect(capturedIds).toEqual(["a1"]);
  });

  // --- color-done detection (task done-marking feature) ---
  // env.DONE_COLOR_ID is "11" (wrangler.toml [vars]); a scheduler-owned event
  // painted that color marks its task done during resolve: the task row flips to
  // 'done' in D1 and the task drops out of the solver problem. The excluded
  // task's events are then orphan-deleted by commit.ts (not exercised here).

  it("marks a task 'done' in D1 and drops it from the solver when a scheduler event carries the done color", async () => {
    let capturedIds: string[] = [];
    const stubSolver = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { tasks: Array<{ id: string }> };
      capturedIds = body.tasks.map((t) => t.id);
      return new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;
    const cal = new MockCalendarProvider({
      events: [
        { id: "sch-1", summary: "Deep work", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z", colorId: "11", extendedProperties: { private: { scheduler_chunk_id: "t1#0" } } },
      ],
    });
    await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    // Dropped from the solver input...
    expect(capturedIds).not.toContain("t1");
    // ...and persisted as done in D1 for this owner.
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ? AND owner_subject = ?").bind("t1", "primary").first<{ status: string }>();
    expect(row?.status).toBe("done");
  });

  it("uses the provider's defaultDoneColorId floor for a NULL users.done_color_id row (Microsoft-shaped provider)", async () => {
    // users.done_color_id is unset for this owner; env.DONE_COLOR_ID ("11",
    // wrangler.toml [vars]) is a Google colorId, meaningless for a
    // Microsoft-shaped provider. The provider's defaultDoneColorId
    // ("Optical Done") must be consulted BEFORE the env default (Card H).
    let capturedIds: string[] = [];
    const stubSolver = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { tasks: Array<{ id: string }> };
      capturedIds = body.tasks.map((t) => t.id);
      return new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;
    const cal = new MockCalendarProvider({
      events: [
        { id: "sch-1", summary: "Deep work", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z", colorId: "Optical Done", extendedProperties: { private: { scheduler_chunk_id: "t1#0" } } },
      ],
    });
    (cal as { defaultDoneColorId?: string }).defaultDoneColorId = "Optical Done";
    await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(capturedIds).not.toContain("t1");
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ? AND owner_subject = ?").bind("t1", "primary").first<{ status: string }>();
    expect(row?.status).toBe("done");
  });

  it("a Google-shaped provider (no defaultDoneColorId) with a NULL row still resolves to env.DONE_COLOR_ID (no behaviour change)", async () => {
    let capturedIds: string[] = [];
    const stubSolver = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { tasks: Array<{ id: string }> };
      capturedIds = body.tasks.map((t) => t.id);
      return new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;
    const cal = new MockCalendarProvider({
      events: [
        { id: "sch-1", summary: "Deep work", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z", colorId: "11", extendedProperties: { private: { scheduler_chunk_id: "t1#0" } } },
      ],
    });
    await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(capturedIds).not.toContain("t1");
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ? AND owner_subject = ?").bind("t1", "primary").first<{ status: string }>();
    expect(row?.status).toBe("done");
  });

  it("parses taskId from chunk_id '{taskId}#{idx}' (taskId may itself contain '#')", async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
    // A taskId containing a literal '#': the parse must split on the LAST '#'.
    const hashy = { id: "weird#id", title: "T", context: "deep", priority: 60, duration_minutes: 60, earliest_start: "2026-05-18T00:00:00Z" };
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', '2026-05-17T00:00:00Z', '2026-05-17T00:00:00Z')").bind("weird#id", "primary", JSON.stringify(hashy)).run();

    let capturedIds: string[] = [];
    const stubSolver = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { tasks: Array<{ id: string }> };
      capturedIds = body.tasks.map((t) => t.id);
      return new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;
    const cal = new MockCalendarProvider({
      events: [
        { id: "sch-1", summary: "T", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:00:00.000Z", colorId: "11", extendedProperties: { private: { scheduler_chunk_id: "weird#id#0" } } },
      ],
    });
    await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(capturedIds).not.toContain("weird#id");
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ? AND owner_subject = ?").bind("weird#id", "primary").first<{ status: string }>();
    expect(row?.status).toBe("done");
  });

  it("records only the done-colored chunk and keeps a 2-chunk task pending (per-chunk granularity)", async () => {
    // Per-chunk semantics: painting only ONE of a 2-chunk task's chunks done must
    // NOT flip the whole task done. The done chunk earns a completion record, but
    // the task stays 'pending' and is still fed to the solver (for its remaining
    // chunk). This supersedes the old task-level "ANY chunk done → whole task" rule.
    await env.DB.prepare("DELETE FROM tasks").run();
    const twoChunk = { title: "Deep work", context: "deep", priority: 80, chunks: [{ duration_minutes: 45 }, { duration_minutes: 45 }], group_policy: { same_day: false, ordered: false }, earliest_start: "2026-05-18T00:00:00Z" };
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', '2026-05-17T00:00:00Z', '2026-05-17T00:00:00Z')").bind("t1", "primary", JSON.stringify({ id: "t1", ...twoChunk })).run();
    let capturedIds: string[] = [];
    const capturing = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedIds = (JSON.parse(init!.body as string) as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id);
      return new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;
    const cal = new MockCalendarProvider({
      events: [
        { id: "sch-0", summary: "Deep work", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T09:45:00.000Z", colorId: "5", extendedProperties: { private: { scheduler_chunk_id: "t1#0" } } },
        { id: "sch-1", summary: "Deep work", start: "2026-05-20T09:00:00.000Z", end: "2026-05-20T09:45:00.000Z", colorId: "11", extendedProperties: { private: { scheduler_chunk_id: "t1#1" } } },
      ],
    });
    await runResolve({
      env: { ...env, SOLVER: capturing },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    // Only t1#1 recorded; task stays pending and is still solved.
    expect(capturedIds).toContain("t1");
    const completed = await loadCompletedChunkIdsByTask(env.DB, "primary", ["t1"]);
    expect(completed.get("t1")).toEqual(new Set(["t1#1"]));
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ? AND owner_subject = ?").bind("t1", "primary").first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  it("ignores a NON-scheduler (external) event painted the done color", async () => {
    let capturedIds: string[] = [];
    const stubSolver = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedIds = (JSON.parse(init!.body as string) as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id);
      return new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;
    // An external event (no scheduler_chunk_id) painted the done color, whose
    // summary coincidentally collides with a task id. Must NOT mark t1 done.
    const cal = new MockCalendarProvider({
      events: [
        { id: "ext-1", summary: "t1#0", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:00:00.000Z", colorId: "11", extendedProperties: {} },
      ],
    });
    await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(capturedIds).toContain("t1");
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ? AND owner_subject = ?").bind("t1", "primary").first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  it("never treats the create/default color '5' as done", async () => {
    let capturedIds: string[] = [];
    const stubSolver = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedIds = (JSON.parse(init!.body as string) as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id);
      return new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;
    // A scheduler event still painted the create color "5" must never count as done.
    const cal = new MockCalendarProvider({
      events: [
        { id: "sch-1", summary: "Deep work", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z", colorId: "5", extendedProperties: { private: { scheduler_chunk_id: "t1#0" } } },
      ],
    });
    await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(capturedIds).toContain("t1");
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ? AND owner_subject = ?").bind("t1", "primary").first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  // --- un-done by color (revive scan, the mirror of the done-scan) ---
  // A task that is currently status='done' in D1, whose in-window scheduler chunk
  // is NO LONGER painted the done color (e.g. repainted to banana "5"), is revived:
  // its row flips back to 'pending' AND it is re-added to the current solve so the
  // round-trip yields a useful plan. The revive set excludes any task that still
  // has a done-colored chunk (it stays in doneTaskIds).

  it("revives a done task when its in-window chunk is no longer done-colored, and re-feeds it to the solver", async () => {
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = ? AND owner_subject = ?").bind("t1", "primary").run();
    // Per-chunk revive requires a color-confirmed completion record to delete;
    // the off-done present event is the un-paint evidence that clears it.
    await env.DB.prepare("INSERT INTO chunk_completions (owner_subject, task_id, chunk_id, done_at, color_confirmed_at, source) VALUES (?, ?, ?, ?, ?, 'color')").bind("primary", "t1", "t1#0", "2026-05-17T00:00:00Z", "2026-05-17T00:00:00Z").run();
    let capturedIds: string[] = [];
    const stubSolver = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedIds = (JSON.parse(init!.body as string) as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id);
      return new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;
    // Banana ("5") in-window scheduler chunk for the done task → revive signal.
    const cal = new MockCalendarProvider({
      events: [
        { id: "sch-1", summary: "Deep work", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z", colorId: "5", extendedProperties: { private: { scheduler_chunk_id: "t1#0" } } },
      ],
    });
    await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    // Flipped back to pending in D1...
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ? AND owner_subject = ?").bind("t1", "primary").first<{ status: string }>();
    expect(row?.status).toBe("pending");
    // ...and re-fed to the current solve.
    expect(capturedIds).toContain("t1");
  });

  it("clears the stale scheduled_for stamp when reviving a done task", async () => {
    // The done task carries a commit stamp anchoring it to a PAST week. Revive
    // must clear it (scheduled_for = NULL), mirroring commit.ts's drop-reset —
    // otherwise window-relative shedding drops the revived task from every
    // future solve. Set status='done' AND a past-week scheduled_for column.
    await env.DB
      .prepare("UPDATE tasks SET status = 'done', scheduled_for = ? WHERE id = ? AND owner_subject = ?")
      .bind("2026-05-11T09:00:00Z", "t1", "primary")
      .run();
    // Per-chunk revive needs a color-confirmed record to delete; the off-done
    // present event is the un-paint evidence.
    await env.DB.prepare("INSERT INTO chunk_completions (owner_subject, task_id, chunk_id, done_at, color_confirmed_at, source) VALUES (?, ?, ?, ?, ?, 'color')").bind("primary", "t1", "t1#0", "2026-05-17T00:00:00Z", "2026-05-17T00:00:00Z").run();
    const stubSolver = { fetch: async () => new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } }) } as unknown as Fetcher;
    // Banana ("5") in-window scheduler chunk for the done task → revive signal.
    const cal = new MockCalendarProvider({
      events: [
        { id: "sch-1", summary: "Deep work", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z", colorId: "5", extendedProperties: { private: { scheduler_chunk_id: "t1#0" } } },
      ],
    });
    await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    const row = await env.DB.prepare("SELECT status, scheduled_for FROM tasks WHERE id = ? AND owner_subject = ?").bind("t1", "primary").first<{ status: string; scheduled_for: string | null }>();
    expect(row?.status).toBe("pending");
    expect(row?.scheduled_for).toBeNull();
  });

  it("does NOT revive a done task whose in-window chunk IS done-colored (the api-done-recolored case)", async () => {
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = ? AND owner_subject = ?").bind("t1", "primary").run();
    let capturedIds: string[] = [];
    const stubSolver = {
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedIds = (JSON.parse(init!.body as string) as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id);
        return new Response(
          JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    } as unknown as Fetcher;
    // Done-colored ("11") in-window chunk for the done task → must NOT revive.
    const cal = new MockCalendarProvider({
      events: [
        { id: "sch-1", summary: "Deep work", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z", colorId: "11", extendedProperties: { private: { scheduler_chunk_id: "t1#0" } } },
      ],
    });
    await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    // Stays done in D1...
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ? AND owner_subject = ?").bind("t1", "primary").first<{ status: string }>();
    expect(row?.status).toBe("done");
    // ...and is NOT re-fed to the solve.
    expect(capturedIds).not.toContain("t1");
  });

  it("keeps a done task done when its chunk is still tomato (records + stays done, no revive)", async () => {
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = ? AND owner_subject = ?").bind("t1", "primary").run();
    let capturedIds: string[] = [];
    const stubSolver = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedIds = (JSON.parse(init!.body as string) as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id);
      return new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;
    // Still tomato ("11") in-window → recorded as done → atomic task stays done, never revived.
    const cal = new MockCalendarProvider({
      events: [
        { id: "sch-1", summary: "Deep work", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z", colorId: "11", extendedProperties: { private: { scheduler_chunk_id: "t1#0" } } },
      ],
    });
    await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ? AND owner_subject = ?").bind("t1", "primary").first<{ status: string }>();
    expect(row?.status).toBe("done");
    expect(capturedIds).not.toContain("t1");
  });

  it("does NOT revive a chunk whose record is still done-colored in-window (per-chunk)", async () => {
    // Per-chunk: a completion record is revived only if its event is present AND
    // off the done color. A record whose in-window event is STILL done-colored is
    // not un-paint evidence → the record survives and (being the task's only
    // chunk) the task stays 'done'. Supersedes the old task-level "ANY tomato
    // keeps the whole task done".
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = ? AND owner_subject = ?").bind("t1", "primary").run();
    await env.DB.prepare("INSERT INTO chunk_completions (owner_subject, task_id, chunk_id, done_at, color_confirmed_at, source) VALUES (?, ?, ?, ?, ?, 'color')").bind("primary", "t1", "t1#0", "2026-05-17T00:00:00Z", "2026-05-17T00:00:00Z").run();
    let capturedIds: string[] = [];
    const stubSolver = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedIds = (JSON.parse(init!.body as string) as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id);
      return new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;
    // t1#0 still tomato ("11") in-window → still done-colored → record survives.
    const cal = new MockCalendarProvider({
      events: [
        { id: "sch-0", summary: "Deep work", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z", colorId: "11", extendedProperties: { private: { scheduler_chunk_id: "t1#0" } } },
      ],
    });
    await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    const completed = await loadCompletedChunkIdsByTask(env.DB, "primary", ["t1"]);
    expect(completed.get("t1")).toEqual(new Set(["t1#0"]));
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ? AND owner_subject = ?").bind("t1", "primary").first<{ status: string }>();
    expect(row?.status).toBe("done");
    expect(capturedIds).not.toContain("t1");
  });

  it("leaves a done task untouched when there is NO in-window event (best-effort edge: event already deleted)", async () => {
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = ? AND owner_subject = ?").bind("t1", "primary").run();
    let capturedIds: string[] = [];
    const stubSolver = { fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedIds = (JSON.parse(init!.body as string) as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id);
      return new Response(JSON.stringify({ schedule: [], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } });
    } } as unknown as Fetcher;
    // No events at all → no in-window chunk → not in revive set.
    const cal = new MockCalendarProvider();
    await runResolve({
      env: { ...env, SOLVER: stubSolver },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id = ? AND owner_subject = ?").bind("t1", "primary").first<{ status: string }>();
    expect(row?.status).toBe("done");
    expect(capturedIds).not.toContain("t1");
  });
});

const stubOkSolver = {
  fetch: async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(
      JSON.stringify({
        schedule: [
          {
            task_id: "t1",
            chunk_id: "t1#0",
            start: "2026-06-01T09:00:00",
            duration_minutes: 90,
            context: "deep",
          },
        ],
        dropped: [],
        objective: {
          total: 0,
          components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 },
        },
        diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
} as unknown as Fetcher;

describe("runResolve forwards business hours to the solver problem", () => {
  // Freeze the clock inside the fixed 2026-06-01 → 2026-06-08 window used below.
  // The fully-past-week guard short-circuits any week whose windowEnd <= now;
  // without a frozen clock this fixed window becomes fully-past on/after
  // 2026-06-08, the solver is never called, capturedBody stays null, and
  // JSON.parse(capturedBody!) throws. Pin to the window start to keep the
  // solver-path assertions deterministic regardless of the real date.
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    await env.DB.prepare("DELETE FROM calendar_sync").run();
    await env.DB.prepare("DELETE FROM users").run();
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare("DELETE FROM proposed_plans").run();
    await env.DB.prepare("DELETE FROM config_weights").run();
    await env.DB.prepare("DELETE FROM config_contexts").run();
    await env.DB.prepare("DELETE FROM config_business_hours").run();
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)")
      .bind(
        JSON.stringify({
          time_of_day_fit_per_15min: 5,
          churn_per_15min_moved: 10,
          priority_unit: 1,
          base_drop_penalty: 200,
        }),
      )
      .run();
    await env.DB.prepare("INSERT INTO config_contexts (owner_subject, context, body) VALUES ('__default__', ?, ?)")
      .bind(
        "deep",
        JSON.stringify({
          context: "deep",
          fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "16:00" },
          max_minutes_per_day: 240,
          max_contiguous_minutes: 90,
          over_daily_cap_penalty_per_15min: 25,
          over_streak_cap_penalty_per_15min: 25,
        }),
      )
      .run();
    await seedMissingDefaultContexts();
    await env.DB.prepare("INSERT INTO config_business_hours (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify({ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" }))
      .run();
    await env.DB.prepare(
      "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)",
    )
      .bind(
        "t1",
        "primary",
        JSON.stringify({ id: "t1", title: "Deep work", context: "deep", priority: 80, duration_minutes: 90 }),
        "2026-05-17T00:00:00Z",
        "2026-05-17T00:00:00Z",
      )
      .run();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("the solver problem carries business_hours globally, not as a per-task window", async () => {
    let capturedBody: string | null = null;
    const capturingSolver = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = (init?.body ?? "") as string;
        return stubOkSolver.fetch(input, init);
      },
    } as unknown as Fetcher;

    const calendar = new MockCalendarProvider();
    const result = await runResolve({
      env: { ...env, SOLVER: capturingSolver, OAUTH_ISSUER: "https://x" } as typeof env,
      calendar,
      windowStart: "2026-06-01T00:00:00Z",
      windowEnd: "2026-06-08T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(result.kind).toBe("ok");
    expect(capturedBody).toBeTruthy();
    const problem = JSON.parse(capturedBody!);
    expect(problem.tasks).toHaveLength(1);
    // Business hours travels as a global Problem field; the task is left
    // un-mutated so the solver can still drop it under load.
    expect(problem.business_hours).toEqual({
      days: ["mon", "tue", "wed", "thu", "fri"],
      start: "09:00",
      end: "17:00",
    });
    expect(problem.tasks[0].preferred_windows).toEqual([]);
  });
});
