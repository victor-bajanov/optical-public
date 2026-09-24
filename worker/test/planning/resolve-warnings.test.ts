import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runResolve } from "../../src/planning/resolve-internal";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import type { CalendarEvent } from "../../src/providers/types";
import type { Fetcher } from "@cloudflare/workers-types";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";

// A single owned movable meeting in the window: the signed-in user organises it
// and one external attendee has accepted.
const MEETING_ID = "owned-meeting-warn-1";
function ownedMeetingEvent(): CalendarEvent {
  return {
    id: MEETING_ID,
    summary: "1:1 with Bob",
    start: "2026-05-20T03:00:00.000Z",
    end: "2026-05-20T03:30:00.000Z",
    organizer: { email: "primary", self: true },
    attendees: [
      { email: "primary", self: true, responseStatus: "accepted" },
      { email: "a@x.com", responseStatus: "accepted" },
    ],
    extendedProperties: {},
  };
}

// A solver stub that returns an empty schedule (no dropped tasks).
function emptySolver(): Fetcher {
  return {
    fetch: async (_url: string, _init: RequestInit) => {
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

// A solver stub that DROPS the given high-priority task by id while keeping the
// meeting (echoes the meeting in the schedule). Used to exercise the
// dropped-vs-kept (must_include_meeting_with_dropped_task) warning path.
function droppingSolver(droppedTaskId: string, droppedTitle: string): Fetcher {
  return {
    fetch: async (_url: string, _init: RequestInit) => {
      return new Response(
        JSON.stringify({
          schedule: [],
          dropped: [
            {
              task_id: droppedTaskId,
              title: droppedTitle,
              drop_cost: 999,
              reason: "could_not_place",
              contributing_constraints: [],
            },
          ],
          objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } },
          diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  } as unknown as Fetcher;
}

describe("runResolve warnings", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
    for (const t of ["calendar_sync", "tasks", "proposed_plans", "config_weights", "config_contexts", "config_business_hours"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify({ time_of_day_fit_per_15min: 5, churn_per_15min_moved: 10, priority_unit: 1, base_drop_penalty: 200 }))
      .run();
    await env.DB.prepare("INSERT INTO config_contexts (owner_subject, context, body) VALUES ('__default__', ?, ?)")
      .bind("meeting", JSON.stringify({ context: "meeting", fit_curve: { peak_start: "09:00", peak_end: "17:00", falloff_end: "18:00" }, max_minutes_per_day: 480, max_contiguous_minutes: 480, over_daily_cap_penalty_per_15min: 25, over_streak_cap_penalty_per_15min: 25 }))
      .run();
    await seedMissingDefaultContexts();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const meetingEnv = {
    ...env,
    OWNED_MEETINGS_ENABLED: "true",
    MEETING_MIN_NOTICE_MINUTES: "0",
    MEETING_CHURN_MULTIPLIER_CAP: "20",
  } as typeof env;

  it("includes attendee_availability_unknown warning when free/busy is unreadable", async () => {
    const cal = new MockCalendarProvider({
      events: [ownedMeetingEvent()],
      freeBusy: { "a@x.com": { error: "notFound" } },
    });
    const r = await runResolve({
      env: { ...meetingEnv, SOLVER: emptySolver() },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.body.warnings?.some((w: string) => w.includes("attendee_availability_unknown"))).toBe(true);
  });

  it("does not include warnings when free/busy succeeds", async () => {
    const cal = new MockCalendarProvider({
      events: [ownedMeetingEvent()],
      freeBusy: { "a@x.com": { busy: [] } },
    });
    const r = await runResolve({
      env: { ...meetingEnv, SOLVER: emptySolver() },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    // No availability_unknown warning when free/busy returned successfully
    expect(r.body.warnings?.some((w: string) => w.includes("attendee_availability_unknown"))).toBeFalsy();
  });

  it("does not include warnings when OWNED_MEETINGS_ENABLED is off", async () => {
    const cal = new MockCalendarProvider({
      events: [ownedMeetingEvent()],
      freeBusy: { "a@x.com": { error: "notFound" } },
    });
    const r = await runResolve({
      env: { ...env, OWNED_MEETINGS_ENABLED: "false", SOLVER: emptySolver() }, // flag explicitly off
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    // No warnings when feature is off — existing responses unchanged
    expect(r.body.warnings).toBeUndefined();
  });

  it("does not emit must_include_meeting_with_dropped_task when the flag is OFF and a priority>0 task drops", async () => {
    // Flag OFF: even though the solver drops a priority>0 task, there is no kept
    // meeting, so the dropped-vs-kept warning must never fire (flag OFF must stay
    // byte-identical to the pre-feature response). Regression guard for C2.
    await env.DB.prepare(
      "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', '2026-05-17T00:00:00Z', '2026-05-17T00:00:00Z')",
    )
      .bind(
        "hp-task",
        "primary",
        JSON.stringify({ id: "hp-task", title: "High priority", context: "meeting", priority: 200, duration_minutes: 30, earliest_start: "2026-05-18T00:00:00Z" }),
      )
      .run();
    const cal = new MockCalendarProvider({
      events: [ownedMeetingEvent()],
      freeBusy: { "a@x.com": { busy: [] } },
    });
    const r = await runResolve({
      env: { ...env, OWNED_MEETINGS_ENABLED: "false", SOLVER: droppingSolver("hp-task", "High priority") }, // flag explicitly off
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(
      r.body.warnings?.some((w: string) => w.includes("must_include_meeting_with_dropped_task")),
    ).toBeFalsy();
  });

  it("emits exactly one must_include_meeting_with_dropped_task when a meeting is kept and a higher-priority task drops", async () => {
    // Flag ON, meeting promoted (kept), and the solver drops a priority>100 task
    // (higher than the meeting's priority 100). Exactly one summary warning. F4.
    await env.DB.prepare(
      "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', '2026-05-17T00:00:00Z', '2026-05-17T00:00:00Z')",
    )
      .bind(
        "hp-task",
        "primary",
        JSON.stringify({ id: "hp-task", title: "High priority", context: "meeting", priority: 200, duration_minutes: 30, earliest_start: "2026-05-18T00:00:00Z" }),
      )
      .run();
    const cal = new MockCalendarProvider({
      events: [ownedMeetingEvent()],
      freeBusy: { "a@x.com": { busy: [] } },
    });
    const r = await runResolve({
      env: { ...meetingEnv, SOLVER: droppingSolver("hp-task", "High priority") },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    const matches = (r.body.warnings ?? []).filter((w: string) =>
      w.includes("must_include_meeting_with_dropped_task"),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toContain("priority 200");
  });
});
