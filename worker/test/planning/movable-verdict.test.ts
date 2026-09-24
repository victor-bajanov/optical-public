import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runResolve } from "../../src/planning/resolve-internal";
import { resolveBookableOverIds } from "../../src/booking/bookable-over";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import type { CalendarEvent } from "../../src/providers/types";
import type { Fetcher } from "@cloudflare/workers-types";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";

// Mirrors test/planning/resolve-meetings.test.ts: one owned movable meeting the
// signed-in user organises, with one external attendee who has accepted.
const MEETING_ID = "owned-meeting-1";
function ownedMeetingEvent(): CalendarEvent {
  return {
    id: MEETING_ID,
    summary: "1:1 with Alex",
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

function stubSolver(): Fetcher {
  return {
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
}

async function verdictOf(eventId: string): Promise<{ at: string; ok: boolean; reason: string | null } | null> {
  const row = await env.DB.prepare(
    `SELECT json_extract(body, '$.movable_verdict') AS v
       FROM tasks
      WHERE owner_subject = 'primary'
        AND json_extract(body, '$.source.external_id') = ?`,
  )
    .bind(eventId)
    .first<{ v: string | null }>();
  return row?.v ? JSON.parse(row.v) : null;
}

const meetingEnv = {
  ...env,
  OWNED_MEETINGS_ENABLED: "true",
  MEETING_MIN_NOTICE_MINUTES: "0",
  MEETING_CHURN_MULTIPLIER_CAP: "20",
} as typeof env;

async function resolveWith(cal: MockCalendarProvider, overrides: Record<string, unknown> = {}) {
  return runResolve({
    env: { ...meetingEnv, SOLVER: stubSolver(), ...overrides } as typeof env,
    calendar: cal,
    windowStart: "2026-05-18T00:00:00Z",
    windowEnd: "2026-05-25T00:00:00Z",
    accountEmail: "primary",
    trigger: "api",
  });
}

describe("movable verdict", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
    for (const t of ["calendar_sync", "tasks", "proposed_plans", "bookings", "config_weights", "config_contexts", "config_business_hours", "config_meeting_policy"]) {
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

  it("does NOT offer a meeting the resolve froze for unreadable attendee free/busy", async () => {
    // THE headline safety property. The planner froze this meeting (it can never
    // be relocated while the attendee's free/busy is unreadable), so offering its
    // time to a booker would permanently double-book the calendar.
    await resolveWith(
      new MockCalendarProvider({
        events: [ownedMeetingEvent()],
        freeBusy: { "a@x.com": { error: "freebusy_http_403" } },
      }),
    );

    const ids = await resolveBookableOverIds(env.DB, "primary", [ownedMeetingEvent()], {
      enabled: true,
      minNoticeMinutes: 60,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });
    expect([...ids]).toEqual([]);
  });

  it("does offer a meeting the resolve genuinely promoted as movable", async () => {
    // The negative control: readable free/busy, attendee free → really movable.
    await resolveWith(
      new MockCalendarProvider({
        events: [ownedMeetingEvent()],
        freeBusy: { "a@x.com": { busy: [] } },
      }),
    );

    const ids = await resolveBookableOverIds(env.DB, "primary", [ownedMeetingEvent()], {
      enabled: true,
      minNoticeMinutes: 60,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });
    expect([...ids]).toEqual([MEETING_ID]);
  });

  it("stamps ok:false with attendee_availability_unknown when free/busy is unreadable", async () => {
    await resolveWith(
      new MockCalendarProvider({
        events: [ownedMeetingEvent()],
        freeBusy: { "a@x.com": { error: "freebusy_http_403" } },
      }),
    );
    const v = await verdictOf(MEETING_ID);
    expect(v).toMatchObject({ ok: false, reason: "attendee_availability_unknown" });
    expect(Date.parse(v!.at)).toBe(Date.parse("2026-05-18T00:00:00.000Z"));
  });

  it("stamps ok:false with no_constraining_attendees when no attendee constrains the meeting", async () => {
    // Under an accepted-only policy an attendee who has not responded is not in
    // the constraining set, so nothing is known about anyone's availability —
    // the meeting must be frozen, and the booking page must not offer its slot.
    await env.DB.prepare("INSERT INTO config_meeting_policy (owner_subject, body) VALUES ('primary', ?)")
      .bind(JSON.stringify({ attendee_enforcement: "accepted" }))
      .run();
    const ev: CalendarEvent = {
      ...ownedMeetingEvent(),
      attendees: [
        { email: "primary", self: true, responseStatus: "accepted" },
        { email: "booker@x.com", responseStatus: "needsAction" },
      ],
    };
    await resolveWith(new MockCalendarProvider({ events: [ev], freeBusy: { "booker@x.com": { busy: [] } } }));
    expect(await verdictOf(MEETING_ID)).toMatchObject({ ok: false, reason: "no_constraining_attendees" });

    const ids = await resolveBookableOverIds(env.DB, "primary", [ev], {
      enabled: true,
      minNoticeMinutes: 60,
      now: new Date("2026-05-18T00:00:00.000Z"),
    });
    expect([...ids]).toEqual([]);
  });

  it("stamps ok:false with imminent_notice for a meeting inside the notice window", async () => {
    await resolveWith(
      new MockCalendarProvider({
        events: [ownedMeetingEvent()],
        freeBusy: { "a@x.com": { busy: [] } },
      }),
      { MEETING_MIN_NOTICE_MINUTES: "5760" },
    );
    expect(await verdictOf(MEETING_ID)).toMatchObject({ ok: false, reason: "imminent_notice" });
  });

  it("stamps ok:false with commit_stability for a meeting moved inside the stability window", async () => {
    const now = new Date().toISOString(); // 2026-05-18T00:00:00.000Z (faked)
    await env.DB.prepare(
      "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at, last_committed_move_at) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(
        "mt-fresh",
        "primary",
        JSON.stringify({ id: "mt-fresh", title: "1:1 with Alex", context: "meeting", priority: 100, duration_minutes: 30, must_include: true, earliest_start: "2026-05-20T03:00:00.000Z", source: { kind: "meeting", external_id: MEETING_ID }, status: "pending", created_at: now, updated_at: now }),
        "pending",
        now,
        now,
        now,
      )
      .run();
    await resolveWith(
      new MockCalendarProvider({
        events: [ownedMeetingEvent()],
        freeBusy: { "a@x.com": { busy: [] } },
      }),
      { MEETING_COMMIT_STABILITY_MINUTES: "60" },
    );
    expect(await verdictOf(MEETING_ID)).toMatchObject({ ok: false, reason: "commit_stability" });
  });

  it("stamps ok:true when the meeting is promoted as movable", async () => {
    await resolveWith(
      new MockCalendarProvider({
        events: [ownedMeetingEvent()],
        freeBusy: { "a@x.com": { busy: [] } },
      }),
    );
    expect(await verdictOf(MEETING_ID)).toMatchObject({ ok: true, reason: null });
  });

  it("re-promotion overwrites a stale ok:false verdict", async () => {
    await resolveWith(
      new MockCalendarProvider({
        events: [ownedMeetingEvent()],
        freeBusy: { "a@x.com": { error: "freebusy_http_403" } },
      }),
    );
    expect(await verdictOf(MEETING_ID)).toMatchObject({ ok: false });
    await resolveWith(
      new MockCalendarProvider({
        events: [ownedMeetingEvent()],
        freeBusy: { "a@x.com": { busy: [] } },
      }),
    );
    expect(await verdictOf(MEETING_ID)).toMatchObject({ ok: true, reason: null });
  });

  it("leaves the rest of the task body intact when stamping", async () => {
    await resolveWith(
      new MockCalendarProvider({
        events: [ownedMeetingEvent()],
        freeBusy: { "a@x.com": { busy: [] } },
      }),
    );
    const row = await env.DB.prepare(
      "SELECT body FROM tasks WHERE owner_subject = 'primary' AND json_extract(body, '$.source.external_id') = ?",
    )
      .bind(MEETING_ID)
      .first<{ body: string }>();
    const body = JSON.parse(row!.body) as Record<string, unknown>;
    expect(body.title).toBe("1:1 with Alex");
    expect(body.context).toBe("meeting");
    expect(body.must_include).toBe(true);
    expect((body.source as { external_id: string }).external_id).toBe(MEETING_ID);
  });
});
