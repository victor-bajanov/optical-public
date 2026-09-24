import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runMondayResolve } from "../../src/cron/monday-resolve";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import { getLatestProposedPlanForSubject } from "../../src/planning/proposed-plans";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";

// The Monday-window math now lives in localWeekWindow (local-tz anchored) and is
// unit-tested in test/planning/datetime.test.ts. These tests exercise the cron
// end-to-end; `now` = 2026-05-17T15:00:00Z is 01:00 Mon 2026-05-18 AEST, so the
// resolved window is the Sydney week [2026-05-17T14:00Z, 2026-05-24T14:00Z).
describe("runMondayResolve", () => {
  // Freeze the wall clock to the same instant these tests pass as `now`
  // (2026-05-17T15:00Z). runResolve's fully-past-week guard reads the real
  // `new Date()`, not the injected `now`; without freezing, the Sydney week
  // [2026-05-17T14:00Z, 2026-05-24T14:00Z) is fully past relative to today and
  // the guard short-circuits before the solver, so the schedule/diff assertions
  // would fail.
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T15:00:00.000Z"));
    await env.DB.prepare("DELETE FROM users").run();
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare("DELETE FROM task_templates").run();
    await env.DB.prepare("DELETE FROM proposed_plans").run();
    await env.DB.prepare("DELETE FROM config_weights").run();
    await env.DB.prepare("DELETE FROM config_contexts").run();
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)").bind(JSON.stringify({ time_of_day_fit_per_15min: 5, churn_per_15min_moved: 10, priority_unit: 1, base_drop_penalty: 200 })).run();
    await env.DB.prepare("INSERT INTO config_contexts (owner_subject, context, body) VALUES ('__default__', ?, ?)").bind("deep", JSON.stringify({ context: "deep", fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "16:00" }, max_minutes_per_day: 240, max_contiguous_minutes: 90, over_daily_cap_penalty_per_15min: 25, over_streak_cap_penalty_per_15min: 25 })).run();
    await seedMissingDefaultContexts();
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)")
      .bind("t1", "primary", JSON.stringify({ id: "t1", title: "Deep work", context: "deep", priority: 80, duration_minutes: 90 }), "2026-05-17T00:00:00Z", "2026-05-17T00:00:00Z").run();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves and emails the diff", async () => {
    const cal = new MockCalendarProvider();
    const notify = new MockNotificationProvider();
    const solver = { fetch: async () => new Response(JSON.stringify({ schedule: [{ task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00", duration_minutes: 90, context: "deep" }], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } }) } as unknown as Fetcher;

    const result = await runMondayResolve({
      env: { ...env, SOLVER: solver, OAUTH_ISSUER: "https://scheduler.example.com" },
      calendar: cal,
      notification: notify,
      accountEmail: "primary",
      now: new Date("2026-05-17T15:00:00Z"),
    });

    expect(result.kind).toBe("ok");
    expect(notify.sent).toHaveLength(1);
    expect(notify.sent[0]!.model.trigger).toBe("monday-cron");
    const allAfterEntries = notify.sent[0]!.model.days.flatMap((d) => d.after);
    expect(allAfterEntries.some((e) => e.title === "Deep work")).toBe(true);
    expect(notify.sent[0]!.opts.acceptUrl).toContain("/v1/plans/");

    // Assert the render_snapshot was persisted to D1 on the cron path.
    const row = await getLatestProposedPlanForSubject(env.DB, "primary", new Date("2026-05-17T15:00:00Z"));
    expect(row).not.toBeNull();
    expect(row!.render_snapshot).not.toBeNull();
    expect((row!.render_snapshot as { trigger: string }).trigger).toBe("monday-cron");
  });

  it("logs and does NOT email on unsat", async () => {
    const cal = new MockCalendarProvider();
    const notify = new MockNotificationProvider();
    const solver = { fetch: async () => new Response(JSON.stringify({ unsat_core: [{ type: "pinned_at", task_id: "t1", value: "x" }] }), { status: 422, headers: { "content-type": "application/json" } }) } as unknown as Fetcher;

    const result = await runMondayResolve({
      env: { ...env, SOLVER: solver, OAUTH_ISSUER: "https://scheduler.example.com" },
      calendar: cal,
      notification: notify,
      accountEmail: "primary",
      now: new Date("2026-05-17T15:00:00Z"),
    });

    expect(result.kind).toBe("unsat");
    expect(notify.sent).toHaveLength(0);
  });

  it("suppresses the email when the calendar already matches the proposed plan (empty diff)", async () => {
    const solver = { fetch: async () => new Response(JSON.stringify({ schedule: [{ task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00", duration_minutes: 90, context: "deep" }], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } }) } as unknown as Fetcher;
    const cal = new MockCalendarProvider({
      events: [{ id: "sch-1", summary: "Deep work", start: "2026-05-18T23:00:00.000Z", end: "2026-05-19T00:30:00.000Z", extendedProperties: { private: { scheduler_chunk_id: "t1#0" } } }],
    });
    const notify = new MockNotificationProvider();
    const result = await runMondayResolve({
      env: { ...env, SOLVER: solver, OAUTH_ISSUER: "https://scheduler.example.com" },
      calendar: cal,
      notification: notify,
      accountEmail: "primary",
      now: new Date("2026-05-17T15:00:00Z"),
    });
    expect(result.kind).toBe("ok");
    expect(notify.sent).toHaveLength(0);
    // An empty-diff cron resolve must NOT leave a phantom pending plan behind
    // (never emailed, but would surface as "latest pending" on the accept page).
    const pending = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM proposed_plans WHERE committed_at IS NULL",
    ).first<{ n: number }>();
    expect(pending?.n).toBe(0);
  });

  it("the drop baseline buckets the week in SCHEDULER_TZ, even for a home_tz user", async () => {
    // Sibling of the webhook's drop-baseline tz test. The cron resolves the
    // Sydney week [2026-05-17T14:00Z, 2026-05-24T14:00Z); the committed plan
    // below is a mid-week-narrowed commit of that same Sydney week. Under UTC
    // bucketing the two land in different weeks and the accepted drop re-emails.
    await env.DB.prepare("INSERT INTO users (subject, home_tz, created_at) VALUES ('primary', 'UTC', '2026-05-01T00:00:00Z')").run();
    const drop = { task_id: "t1", title: "Deep work", drop_cost: 5, reason: "drop_was_cheaper_than_alternatives", contributing_constraints: ["preferred_window"] };
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end) VALUES (?, ?, ?, ?, ?, 'primary', ?, ?)",
    ).bind(
      "committed-drop-midweek",
      JSON.stringify({ schedule: [], dropped: [drop], window: { start: "2026-05-19T23:00:00.000Z", end: "2026-05-24T14:00:00.000Z" } }),
      "2026-05-11T00:00:00Z", "2099-01-01T00:00:00Z", "2026-05-11T01:00:00Z",
      "2026-05-19T23:00:00.000Z", "2026-05-24T14:00:00.000Z",
    ).run();
    const dropSolver = { fetch: async () => new Response(JSON.stringify({ schedule: [], dropped: [drop], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } }) } as unknown as Fetcher;
    const notify = new MockNotificationProvider();
    const result = await runMondayResolve({
      env: { ...env, SOLVER: dropSolver, OAUTH_ISSUER: "https://scheduler.example.com" },
      calendar: new MockCalendarProvider(),
      notification: notify,
      accountEmail: "primary",
      now: new Date("2026-05-17T15:00:00Z"),
    });
    expect(result.kind).toBe("ok");
    expect(notify.sent).toHaveLength(0);
  });

  it("reports a single move (zero removed) when one scheduler event differs in start", async () => {
    const solver = { fetch: async () => new Response(JSON.stringify({ schedule: [{ task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00", duration_minutes: 90, context: "deep" }], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } }) } as unknown as Fetcher;
    // Calendar holds t1#0 at a DIFFERENT start (08:00 local = 2026-05-18T22:00:00.000Z).
    const cal = new MockCalendarProvider({
      events: [{ id: "sch-1", summary: "Deep work", start: "2026-05-18T22:00:00.000Z", end: "2026-05-18T23:30:00.000Z", extendedProperties: { private: { scheduler_chunk_id: "t1#0" } } }],
    });
    const notify = new MockNotificationProvider();
    const result = await runMondayResolve({
      env: { ...env, SOLVER: solver, OAUTH_ISSUER: "https://scheduler.example.com" },
      calendar: cal,
      notification: notify,
      accountEmail: "primary",
      now: new Date("2026-05-17T15:00:00Z"),
    });
    expect(result.kind).toBe("ok");
    expect(notify.sent).toHaveLength(1);
    const allAfterMove = notify.sent[0]!.model.days.flatMap((d) => d.after);
    expect(allAfterMove.some((e) => e.role === "moved-to")).toBe(true);
    expect(notify.sent[0]!.model.days.flatMap((d) => d.after).some((e) => e.role === "removed")).toBe(false);
  });

  it("does not report removed entries from a committed plan for a different week (regression)", async () => {
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      "old-committed",
      JSON.stringify({ schedule: [{ task_id: "t-old", chunk_id: "t-old#0", start: "2026-01-05T09:00:00.000Z", end: "2026-01-05T10:00:00.000Z", context: "deep" }], dropped: [], window: { start: "2026-01-05T00:00:00Z", end: "2026-01-12T00:00:00Z" } }),
      "2026-01-05T00:00:00Z", "2026-01-06T00:00:00Z", "2026-01-05T00:00:00Z",
    ).run();
    const solver = { fetch: async () => new Response(JSON.stringify({ schedule: [{ task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00", duration_minutes: 90, context: "deep" }], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } }) } as unknown as Fetcher;
    const cal = new MockCalendarProvider(); // no scheduler events in the window
    const notify = new MockNotificationProvider();
    const result = await runMondayResolve({
      env: { ...env, SOLVER: solver, OAUTH_ISSUER: "https://scheduler.example.com" },
      calendar: cal,
      notification: notify,
      accountEmail: "primary",
      now: new Date("2026-05-17T15:00:00Z"),
    });
    expect(result.kind).toBe("ok");
    expect(notify.sent).toHaveLength(1);
    const allEntriesOld = notify.sent[0]!.model.days.flatMap((d) => [...d.before, ...d.after]);
    expect(allEntriesOld.some((e) => e.role === "removed")).toBe(false);
    expect(allEntriesOld.some((e) => e.title === "t-old")).toBe(false);
  });

  it("reports added for a new proposed chunk and removed for an orphaned calendar event", async () => {
    // Calendar holds t-gone#0 (in window) which the solver does NOT place.
    const cal = new MockCalendarProvider({
      events: [{ id: "sch-gone", summary: "Old task", start: "2026-05-20T23:00:00.000Z", end: "2026-05-21T00:00:00.000Z", extendedProperties: { private: { scheduler_chunk_id: "t-gone#0" } } }],
    });
    const solver = { fetch: async () => new Response(JSON.stringify({ schedule: [{ task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00", duration_minutes: 90, context: "deep" }], dropped: [], objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } }, diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" } }), { status: 200, headers: { "content-type": "application/json" } }) } as unknown as Fetcher;
    const notify = new MockNotificationProvider();
    const result = await runMondayResolve({
      env: { ...env, SOLVER: solver, OAUTH_ISSUER: "https://scheduler.example.com" },
      calendar: cal,
      notification: notify,
      accountEmail: "primary",
      now: new Date("2026-05-17T15:00:00Z"),
    });
    expect(result.kind).toBe("ok");
    expect(notify.sent).toHaveLength(1);
    const allEntriesAddRem = notify.sent[0]!.model.days.flatMap((d) => [...d.before, ...d.after]);
    expect(allEntriesAddRem.some((e) => e.role === "added")).toBe(true);
    expect(allEntriesAddRem.some((e) => e.role === "removed")).toBe(true);
  });
});
