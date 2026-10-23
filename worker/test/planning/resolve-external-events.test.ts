import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runResolve } from "../../src/planning/resolve-internal";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { OPTICAL_DEPLOYMENT_KEY, SCHEDULER_CHUNK_ID_KEY } from "../../src/providers/types";
import type { Fetcher } from "@cloudflare/workers-types";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";

const okSolver = {
  fetch: async () =>
    new Response(
      JSON.stringify({
        schedule: [],
        dropped: [],
        objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } },
        diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
} as unknown as Fetcher;

describe("runResolve externalEvents", () => {
  beforeEach(async () => {
    // Pin `now` to just before the fixed test window so placement is not floored
    // past the window. Without this these tests rot the moment real time passes
    // 2026-06-21 (resolve short-circuits before the solver on a fully-past week).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-14T00:00:00.000Z"));
    for (const t of ["calendar_sync", "tasks", "proposed_plans", "config_weights", "config_contexts"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify({ time_of_day_fit_per_15min: 5, churn_per_15min_moved: 10, priority_unit: 1, base_drop_penalty: 200 }))
      .run();
    await seedMissingDefaultContexts();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function capturingSolver(captured: { external_pinned: { id: string; duration_minutes: number; start: string }[] }[]): Fetcher {
    return {
      fetch: async (_url: string, init: RequestInit) => {
        captured.push(JSON.parse(init.body as string));
        return new Response(
          JSON.stringify({
            schedule: [],
            dropped: [],
            objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } },
            diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    } as unknown as Fetcher;
  }

  it("returns non-scheduler calendar events as externalEvents", async () => {
    // own1 is an unstamped (legacy) chunk: it counts as ours only because its
    // task is a row of this D1 (externaliseUnprovenChunks). Done task: not
    // placed, but it proves the chunk.
    await env.DB.prepare(
      "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES ('t1', 'op@example.com', '{}', 'done', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')",
    ).run();
    const calendar = new MockCalendarProvider({
      events: [
        { id: "ext1", summary: "Client call", start: "2026-06-15T01:00:00Z", end: "2026-06-15T02:00:00Z", extendedProperties: {} },
        { id: "mine1", summary: "Dentist", start: "2026-06-16T01:00:00Z", end: "2026-06-16T02:00:00Z", extendedProperties: {},
          organizer: { email: "op@example.com", self: true } },
        { id: "own1", summary: "BAS prep", start: "2026-06-15T01:30:00Z", end: "2026-06-15T03:30:00Z",
          extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0" } } },
      ],
    });
    const res = await runResolve({
      env: { ...env, SOLVER: okSolver },
      calendar,
      windowStart: "2026-06-14T14:00:00Z",
      windowEnd: "2026-06-21T14:00:00Z",
      accountEmail: "op@example.com",
      trigger: "api",
    });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.externalEvents).toEqual([
      // organizedBySelf drives the O9.6 API redaction; no organizer = not own.
      { id: "ext1", title: "Client call", start: "2026-06-15T01:00:00.000Z", end: "2026-06-15T02:00:00.000Z", organizedBySelf: false },
      { id: "mine1", title: "Dentist", start: "2026-06-16T01:00:00.000Z", end: "2026-06-16T02:00:00.000Z", organizedBySelf: true },
    ]);
  });

  it("another Optical deployment's chunk on the same calendar blocks as busy time; this deployment's own does not", async () => {
    const captured: { external_pinned: { id: string; duration_minutes: number; start: string }[] }[] = [];
    const ME = "https://optical-a.example.com";
    const calendar = new MockCalendarProvider({
      deploymentId: ME,
      events: [
        { id: "own1", summary: "BAS prep", start: "2026-06-15T01:00:00Z", end: "2026-06-15T02:00:00Z",
          extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t1#0", [OPTICAL_DEPLOYMENT_KEY]: ME } } },
        { id: "foreign1", summary: "Trial work block", start: "2026-06-16T01:00:00Z", end: "2026-06-16T02:00:00Z",
          extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t9#0", [OPTICAL_DEPLOYMENT_KEY]: "https://optical-b.example.com" } } },
      ],
    });
    await runResolve({
      env: { ...env, SOLVER: capturingSolver(captured) },
      calendar,
      windowStart: "2026-06-14T14:00:00Z",
      windowEnd: "2026-06-21T14:00:00Z",
      accountEmail: "op@example.com",
      trigger: "api",
    });
    expect(captured[0]!.external_pinned.map((b) => b.id)).toEqual(["foreign1"]);
  });

  it("an unstamped chunk whose task is not in this D1 is external busy time, not one of ours", async () => {
    const captured: { external_pinned: { id: string; duration_minutes: number; start: string }[] }[] = [];
    const calendar = new MockCalendarProvider({
      events: [
        { id: "orphan", summary: "Deleted task's block", start: "2026-06-16T01:00:00Z", end: "2026-06-16T02:00:00Z",
          extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "gone-task#0" } } },
      ],
    });
    const res = await runResolve({
      env: { ...env, SOLVER: capturingSolver(captured) },
      calendar,
      windowStart: "2026-06-14T14:00:00Z",
      windowEnd: "2026-06-21T14:00:00Z",
      accountEmail: "op@example.com",
      trigger: "api",
    });
    expect(captured[0]!.external_pinned.map((b) => b.id)).toEqual(["orphan"]);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;
    expect(res.priorEvents).toEqual([]);
    expect(res.externalEvents.map((e) => e.id)).toEqual(["orphan"]);
  });

  const makeTentativeCal = () =>
    new MockCalendarProvider({
      events: [
        {
          id: "tent",
          summary: "Maybe call",
          start: "2026-06-15T01:00:00Z",
          end: "2026-06-15T02:00:00Z",
          status: "tentative",
          extendedProperties: {},
        },
      ],
    });

  it("does not block a tentative event when TENTATIVE_IS_BUSY is unset (toggle off)", async () => {
    const captured: { external_pinned: { id: string; duration_minutes: number; start: string }[] }[] = [];
    await runResolve({
      env: { ...env, SOLVER: capturingSolver(captured), TENTATIVE_IS_BUSY: undefined },
      calendar: makeTentativeCal(),
      windowStart: "2026-06-14T14:00:00Z",
      windowEnd: "2026-06-21T14:00:00Z",
      accountEmail: "op@example.com",
      trigger: "api",
    });
    expect(captured[0]!.external_pinned).toEqual([]);
  });

  it("blocks a tentative event when TENTATIVE_IS_BUSY is true (toggle on)", async () => {
    const captured: { external_pinned: { id: string; duration_minutes: number; start: string }[] }[] = [];
    await runResolve({
      env: { ...env, SOLVER: capturingSolver(captured), TENTATIVE_IS_BUSY: "true" },
      calendar: makeTentativeCal(),
      windowStart: "2026-06-14T14:00:00Z",
      windowEnd: "2026-06-21T14:00:00Z",
      accountEmail: "op@example.com",
      trigger: "api",
    });
    expect(captured[0]!.external_pinned).toHaveLength(1);
    expect(captured[0]!.external_pinned[0]!.id).toBe("tent");
  });

  it("an all-day OOO event blocks the whole local day (decision C, merge-gate)", async () => {
    const captured: { external_pinned: { id: string; duration_minutes: number; start: string }[] }[] = [];
    const calendar = new MockCalendarProvider({
      events: [
        {
          id: "ooo-allday",
          summary: "Out of office",
          // Google all-day: start.date 2026-06-16, end.date 2026-06-17 (exclusive),
          // coerced to UTC-midnight instants by the provider.
          start: "2026-06-16T00:00:00Z",
          end: "2026-06-17T00:00:00Z",
          eventType: "outOfOffice",
          isAllDay: true,
          extendedProperties: {},
        },
      ],
    });
    await runResolve({
      env: { ...env, SOLVER: capturingSolver(captured) },
      calendar,
      windowStart: "2026-06-14T14:00:00Z",
      windowEnd: "2026-06-21T14:00:00Z",
      accountEmail: "op@example.com",
      trigger: "api",
    });
    expect(captured[0]!.external_pinned).toHaveLength(1);
    const block = captured[0]!.external_pinned[0]!;
    expect(block.id).toBe("ooo-allday");
    expect(block.duration_minutes).toBe(1440);
    // Local midnight in Sydney for 2026-06-16.
    expect(block.start).toBe("2026-06-16T00:00:00");
  });

  it("a cancelled recurring instance does not block while the rest of the series does (decisions B+E)", async () => {
    const captured: { external_pinned: { id: string; duration_minutes: number; start: string }[] }[] = [];
    // singleEvents=true would return each weekly instance separately. The
    // Wednesday instance is cancelled; the Monday + Friday instances remain busy.
    const calendar = new MockCalendarProvider({
      events: [
        { id: "standup_mon", summary: "Standup", start: "2026-06-15T01:00:00Z", end: "2026-06-15T01:30:00Z", status: "confirmed", extendedProperties: {} },
        { id: "standup_wed", summary: "Standup", start: "2026-06-17T01:00:00Z", end: "2026-06-17T01:30:00Z", status: "cancelled", extendedProperties: {} },
        { id: "standup_fri", summary: "Standup", start: "2026-06-19T01:00:00Z", end: "2026-06-19T01:30:00Z", status: "confirmed", extendedProperties: {} },
      ],
    });
    await runResolve({
      env: { ...env, SOLVER: capturingSolver(captured) },
      calendar,
      windowStart: "2026-06-14T14:00:00Z",
      windowEnd: "2026-06-21T14:00:00Z",
      accountEmail: "op@example.com",
      trigger: "api",
    });
    const ids = captured[0]!.external_pinned.map((b) => b.id);
    expect(ids).toEqual(["standup_mon", "standup_fri"]);
    expect(ids).not.toContain("standup_wed");
  });

  it("a moved recurring instance blocks its new time (decision E)", async () => {
    const captured: { external_pinned: { id: string; duration_minutes: number; start: string }[] }[] = [];
    // The Wednesday instance was moved from 11:00 to 15:00 Sydney; Google returns
    // the overridden instance at its new time. It must block the new time.
    const calendar = new MockCalendarProvider({
      events: [
        { id: "standup_wed_moved", summary: "Standup", start: "2026-06-17T05:00:00Z", end: "2026-06-17T05:30:00Z", status: "confirmed", extendedProperties: {} },
      ],
    });
    await runResolve({
      env: { ...env, SOLVER: capturingSolver(captured) },
      calendar,
      windowStart: "2026-06-14T14:00:00Z",
      windowEnd: "2026-06-21T14:00:00Z",
      accountEmail: "op@example.com",
      trigger: "api",
    });
    expect(captured[0]!.external_pinned).toHaveLength(1);
    const block = captured[0]!.external_pinned[0]!;
    expect(block.id).toBe("standup_wed_moved");
    // 2026-06-17T05:00:00Z = 15:00 Sydney.
    expect(block.start).toBe("2026-06-17T15:00:00");
    expect(block.duration_minutes).toBe(30);
  });
});
