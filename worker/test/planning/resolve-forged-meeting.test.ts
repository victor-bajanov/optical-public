import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runResolve } from "../../src/planning/resolve-internal";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import type { CalendarEvent } from "../../src/providers/types";
import type { Fetcher } from "@cloudflare/workers-types";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";

// O9.5 defence in depth. A meeting-kind task row is promoted to a MOVABLE
// meeting by the resolve, and a commit then moves its event with
// sendUpdates=all. The /v1 task routes no longer let a client write such a row,
// but a row that reached D1 by any other road (written before that guard,
// restored from a backup, or whose event has since changed) must still not be
// promoted unless its live event passes isOwnedMovableMeeting. These events are
// exactly the ones the meetings sync refuses to import.

const WINDOW_START = "2026-05-18T00:00:00Z";
const WINDOW_END = "2026-05-25T00:00:00Z";

function baseEvent(id: string): CalendarEvent {
  return {
    id,
    summary: "Team sync",
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

/** Booked by the meeting-poll feature: organised by the user, attendees voted. */
function pollBookedEvent(): CalendarEvent {
  return { ...baseEvent("poll-evt-1"), extendedProperties: { private: { optical_poll_id: "poll-1" } } };
}

/** Someone else's meeting the user merely attends. */
function othersMeetingEvent(): CalendarEvent {
  return {
    ...baseEvent("others-evt-1"),
    organizer: { email: "boss@x.com", self: false },
    attendees: [
      { email: "boss@x.com", responseStatus: "accepted" },
      { email: "primary", self: true, responseStatus: "accepted" },
    ],
  };
}

/** A forged meeting-kind row: what POST /v1/tasks accepted before O9.5. No
 *  earliest_start, so the sync's in-window cancellation pass never touches it. */
async function insertForgedRow(eventId: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = "2026-05-17T00:00:00.000Z";
  const body = {
    id, title: "forged", context: "deep", priority: 50, duration_minutes: 30, must_include: false,
    source: { kind: "meeting", external_id: eventId }, status: "pending", created_at: now, updated_at: now,
  };
  await env.DB.prepare(
    "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  ).bind(id, "primary", JSON.stringify(body), "pending", now, now).run();
  return id;
}

function capturingSolver(captured: { problem: any | null }): Fetcher {
  return {
    fetch: async (_url: string, init: RequestInit) => {
      captured.problem = JSON.parse(init.body as string);
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

const meetingEnv = {
  ...env,
  OWNED_MEETINGS_ENABLED: "true",
  MEETING_MIN_NOTICE_MINUTES: "0",
  MEETING_CHURN_MULTIPLIER_CAP: "20",
} as typeof env;

async function resolveWith(events: CalendarEvent[], captured: { problem: any | null }) {
  const cal = new MockCalendarProvider({
    events,
    freeBusy: { "a@x.com": { busy: [] }, "boss@x.com": { busy: [] } },
  });
  return runResolve({
    env: { ...meetingEnv, SOLVER: capturingSolver(captured) },
    calendar: cal,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    accountEmail: "primary",
    trigger: "api",
  });
}

async function verdictOf(taskId: string): Promise<{ ok: boolean; reason: string | null } | null> {
  const row = await env.DB.prepare("SELECT json_extract(body, '$.movable_verdict') AS v FROM tasks WHERE id = ?")
    .bind(taskId)
    .first<{ v: string | null }>();
  return row?.v ? JSON.parse(row.v) : null;
}

describe("resolve refuses to promote a meeting-kind row whose event is not an owned movable meeting (O9.5)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
    for (const t of ["calendar_sync", "tasks", "proposed_plans", "config_weights", "config_contexts", "config_business_hours", "config_meeting_policy"]) {
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
    vi.restoreAllMocks();
  });

  for (const [label, event] of [
    ["a poll-booked event", pollBookedEvent()],
    ["a meeting someone else organises", othersMeetingEvent()],
  ] as const) {
    it(`freezes a forged row pointing at ${label}: no movable input, event stays a busy block`, async () => {
      const taskId = await insertForgedRow(event.id);
      const warn = vi.spyOn(console, "warn");
      const captured: { problem: any | null } = { problem: null };
      const r = await resolveWith([event], captured);
      expect(r.kind).toBe("ok");
      expect(captured.problem).toBeTruthy();

      // Not promoted: no solver task carries a meeting availability mask, and
      // the forged row is not in the problem at all.
      expect(captured.problem.tasks.filter((t: any) => t.availability_windows !== undefined)).toEqual([]);
      expect(JSON.stringify(captured.problem.tasks)).not.toContain(taskId);
      // The real event is still pinned as a busy block, i.e. frozen in place.
      expect(captured.problem.external_pinned.find((p: any) => p.id === event.id)).toBeTruthy();

      expect(await verdictOf(taskId)).toMatchObject({ ok: false, reason: "not_owned_movable" });

      // One permanent, PII-free log line naming the refused row.
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith("meeting_promotion_refused"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(taskId);
      for (const pii of ["primary", "a@x.com", "boss@x.com", event.summary]) expect(lines[0]).not.toContain(pii);
    });
  }

  it("still promotes a genuine owned movable meeting alongside (control)", async () => {
    const captured: { problem: any | null } = { problem: null };
    const owned = baseEvent("owned-evt-1");
    const r = await resolveWith([owned, pollBookedEvent()], captured);
    expect(r.kind).toBe("ok");
    const promoted = captured.problem.tasks.filter((t: any) => t.availability_windows !== undefined);
    expect(promoted).toHaveLength(1);
    expect(captured.problem.external_pinned.find((p: any) => p.id === owned.id)).toBeUndefined();
  });
});
