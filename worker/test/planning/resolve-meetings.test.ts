import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runResolve } from "../../src/planning/resolve-internal";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import type { CalendarEvent } from "../../src/providers/types";
import type { Fetcher } from "@cloudflare/workers-types";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";

// A single owned movable meeting in the window: the signed-in user organises it
// and one external attendee has accepted. start is well inside the window so it
// is NOT imminent (with MEETING_MIN_NOTICE_MINUTES=0 nothing is imminent).
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

// A solver stub that captures the JSON problem it receives and echoes an empty
// schedule (we only assert on the INPUT problem, not the output plan).
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

describe("runResolve owned meetings", () => {
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
  });

  const meetingEnv = {
    ...env,
    OWNED_MEETINGS_ENABLED: "true",
    MEETING_MIN_NOTICE_MINUTES: "0",
    MEETING_CHURN_MULTIPLIER_CAP: "20",
  } as typeof env;

  it("emits the owned meeting as a movable task with an availability mask, churn multiplier, and not in external_pinned", async () => {
    const captured: { problem: any | null } = { problem: null };
    const cal = new MockCalendarProvider({
      events: [ownedMeetingEvent()],
      freeBusy: { "a@x.com": { busy: [] } },
    });
    const r = await runResolve({
      env: { ...meetingEnv, SOLVER: capturingSolver(captured) },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    expect(captured.problem).toBeTruthy();

    // The meeting was imported as a task row and reached the solver as a movable
    // task carrying an availability mask + churn multiplier.
    const wire = captured.problem.tasks.find((t: any) => t.context === "meeting");
    expect(wire).toBeTruthy();
    expect(wire.availability_windows?.length).toBeGreaterThan(0);
    expect(wire.churn_multiplier).toBe(1);

    // It is NOT a busy block: build-problem removes the movable meeting's event
    // from external_pinned so it does not block itself.
    expect(captured.problem.external_pinned.find((p: any) => p.id === MEETING_ID)).toBeUndefined();
  });

  it("freezes an imminent meeting: not a solver task, still a busy block in external_pinned", async () => {
    // A large min-notice makes the meeting imminent (start < now + minNotice),
    // so it is NOT promoted to movable. Its task row therefore must be excluded
    // from the solver problem, and its real event must remain a busy block so it
    // is frozen at its real slot (never relocated, never re-notified on commit).
    const captured: { problem: any | null } = { problem: null };
    const cal = new MockCalendarProvider({
      events: [ownedMeetingEvent()],
      freeBusy: { "a@x.com": { busy: [] } },
    });
    const r = await runResolve({
      env: { ...meetingEnv, MEETING_MIN_NOTICE_MINUTES: "5760", SOLVER: capturingSolver(captured) },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    expect(captured.problem).toBeTruthy();
    // Imminent → not promoted → excluded from the solver task set entirely.
    expect(captured.problem.tasks.find((t: any) => t.context === "meeting")).toBeUndefined();
    // Its event stays pinned as a busy block (frozen at its real slot).
    expect(captured.problem.external_pinned.find((p: any) => p.id === MEETING_ID)).toBeTruthy();
  });

  it("excludes a PROMOTED meeting's own event from externalEvents so the diff does not render it twice", async () => {
    // Regression: an owned meeting that is promoted to movable is rendered in the
    // diff as a "[Meeting]" scheduler card (moved-from/moved-to). Its underlying
    // calendar event must NOT also leak into externalEvents — build-problem
    // already strips it from external_pinned, but the diff path (externalEvents)
    // had no equivalent strip, so buildReplanEmailModel showed the meeting twice:
    // once as the meeting card and once as a plain external entry.
    const cal = new MockCalendarProvider({
      events: [ownedMeetingEvent()],
      freeBusy: { "a@x.com": { busy: [] } },
    });
    const r = await runResolve({
      env: { ...meetingEnv, SOLVER: capturingSolver({ problem: null }) },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.externalEvents.find((e) => e.id === MEETING_ID)).toBeUndefined();
  });

  it("returns the PROMOTED meeting's task id in meetingTaskIds, and only meeting rows (not ordinary tasks with context 'meeting')", async () => {
    // The email model keys the "Meeting" chip on result.meetingTaskIds. An
    // ordinary user task filed under the "meeting" batching context must NOT
    // appear there — only rows imported from real owned meetings.
    const now = "2026-05-18T00:00:00.000Z";
    const plainTaskId = "task-plain-1";
    await env.DB.prepare(
      "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).bind(
      plainTaskId,
      "primary",
      JSON.stringify({
        id: plainTaskId,
        title: "Multiplayer meeting bookings",
        context: "meeting",
        priority: 50,
        duration_minutes: 60,
        source: { kind: "mcp" },
        status: "pending",
        created_at: now,
        updated_at: now,
      }),
      "pending",
      now,
      now,
    ).run();

    const cal = new MockCalendarProvider({
      events: [ownedMeetingEvent()],
      freeBusy: { "a@x.com": { busy: [] } },
    });
    const r = await runResolve({
      env: { ...meetingEnv, SOLVER: capturingSolver({ problem: null }) },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.meetingTaskIds).toHaveLength(1);
    expect(r.meetingTaskIds).not.toContain(plainTaskId);
    // The one id is the imported meeting row for MEETING_ID.
    const row = await env.DB.prepare(
      "SELECT id FROM tasks WHERE owner_subject = 'primary' AND json_extract(body, '$.source.external_id') = ?",
    ).bind(MEETING_ID).first<{ id: string }>();
    expect(r.meetingTaskIds[0]).toBe(row!.id);
  });

  it("returns an empty meetingTaskIds for a FROZEN (imminent) meeting", async () => {
    // A frozen meeting is not in the plan's schedule, so it must not be flagged
    // for the email model either.
    const cal = new MockCalendarProvider({
      events: [ownedMeetingEvent()],
      freeBusy: { "a@x.com": { busy: [] } },
    });
    const r = await runResolve({
      env: { ...meetingEnv, MEETING_MIN_NOTICE_MINUTES: "5760", SOLVER: capturingSolver({ problem: null }) },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.meetingTaskIds).toEqual([]);
  });

  it("keeps a FROZEN (imminent) meeting's event in externalEvents (it is the only card for it)", async () => {
    // The inverse boundary: a frozen meeting has NO scheduler card, so its raw
    // event is its sole diff representation — it must remain in externalEvents.
    const cal = new MockCalendarProvider({
      events: [ownedMeetingEvent()],
      freeBusy: { "a@x.com": { busy: [] } },
    });
    const r = await runResolve({
      env: { ...meetingEnv, MEETING_MIN_NOTICE_MINUTES: "5760", SOLVER: capturingSolver({ problem: null }) },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.externalEvents.find((e) => e.id === MEETING_ID)).toBeTruthy();
  });

  it("leaves the meeting as a busy block (NOT a movable task) when the feature flag is off", async () => {
    const captured: { problem: any | null } = { problem: null };
    const cal = new MockCalendarProvider({
      events: [ownedMeetingEvent()],
      freeBusy: { "a@x.com": { busy: [] } },
    });
    const r = await runResolve({
      env: { ...env, OWNED_MEETINGS_ENABLED: "false", SOLVER: capturingSolver(captured) }, // flag explicitly off
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    expect(captured.problem).toBeTruthy();
    // No meeting task was synced/promoted; the event remains a busy block.
    expect(captured.problem.tasks.find((t: any) => t.context === "meeting")).toBeUndefined();
    expect(captured.problem.external_pinned.find((p: any) => p.id === MEETING_ID)).toBeTruthy();
  });

  it("under the not_declined default, a needsAction attendee's busy is subtracted from the mask", async () => {
    const captured: { problem: any | null } = { problem: null };
    const ev: CalendarEvent = {
      id: MEETING_ID, summary: "1:1 with Alex",
      start: "2026-05-20T03:00:00.000Z", end: "2026-05-20T03:30:00.000Z",
      organizer: { email: "primary", self: true },
      attendees: [
        { email: "primary", self: true, responseStatus: "accepted" },
        { email: "a@x.com", responseStatus: "needsAction" },
      ],
      extendedProperties: {},
    };
    const cal = new MockCalendarProvider({
      events: [ev],
      freeBusy: { "a@x.com": { busy: [{ start: "2026-05-20T05:00:00.000Z", end: "2026-05-20T06:00:00.000Z" }] } },
    });
    const r = await runResolve({
      // tz UTC so availability windows (emitted tz-local-naive) map to the real
      // instant when we append "Z" below.
      env: { ...meetingEnv, SCHEDULER_TZ: "UTC", SOLVER: capturingSolver(captured) },
      calendar: cal,
      windowStart: "2026-05-20T00:00:00Z",
      windowEnd: "2026-05-21T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    const wire = captured.problem.tasks.find((t: any) => t.context === "meeting");
    expect(wire).toBeTruthy();
    const overlaps05 = (wire.availability_windows ?? []).some(
      (w: any) => Date.parse(`${w.start}Z`) < Date.parse("2026-05-20T06:00:00Z") && Date.parse(`${w.end}Z`) > Date.parse("2026-05-20T05:00:00Z"),
    );
    expect(overlaps05).toBe(false);
  });

  it("freezes a meeting committed-moved within the stability window (excluded from movable)", async () => {
    // Faked now is 2026-05-18T00:00:00.000Z (beforeEach). A last_committed_move_at
    // equal to now is well inside the 60-minute stability window, so the meeting
    // must be held at its slot: dropped from the movable set, falling through to
    // the frozen external_pinned path. Seed the row with source.external_id ===
    // MEETING_ID so syncOwnedMeetings recognises it (no duplicate row) and its
    // title/duration/earliest_start match the event so no UPDATE fires.
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
        now, // last_committed_move_at = now (fresh → frozen)
      )
      .run();
    const captured: { problem: any | null } = { problem: null };
    const cal = new MockCalendarProvider({
      events: [ownedMeetingEvent()],
      freeBusy: { "a@x.com": { busy: [] } },
    });
    const r = await runResolve({
      env: { ...meetingEnv, MEETING_COMMIT_STABILITY_MINUTES: "60", SOLVER: capturingSolver(captured) },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    // Fresh committed-move → frozen → NOT promoted to a movable solver task.
    expect(captured.problem.tasks.find((t: any) => t.context === "meeting")).toBeUndefined();
    // Its event stays pinned as a busy block (held at its real slot).
    expect(captured.problem.external_pinned.find((p: any) => p.id === MEETING_ID)).toBeTruthy();
  });

  // --- Degrade-to-immovable when attendee free/busy is unreadable ---------
  // The documented contract: if we cannot read a constraining attendee's
  // free/busy, we do not know whether a new slot is free for them, so the
  // meeting MUST stay frozen at its real slot (never relocated) rather than be
  // treated as constraint-free and moved anywhere. The freeze manifests exactly
  // like the imminent/stability cases: NOT a movable solver task, still a busy
  // block in external_pinned. The attendee_availability_unknown warning still
  // surfaces (asserted in resolve-warnings.test.ts).
  //
  // An "owned meeting whose attendee free/busy is unreadable was moved" was the
  // prod incident: the account had not yet re-consented to calendar.freebusy, so
  // the query 403'd and both meetings relocated despite the warning.

  function twoAttendeeEvent(): CalendarEvent {
    return {
      id: MEETING_ID,
      summary: "1:1 with Alex",
      start: "2026-05-20T03:00:00.000Z",
      end: "2026-05-20T03:30:00.000Z",
      organizer: { email: "primary", self: true },
      attendees: [
        { email: "primary", self: true, responseStatus: "accepted" },
        { email: "a@x.com", responseStatus: "accepted" },
        { email: "b@x.com", responseStatus: "accepted" },
      ],
      extendedProperties: {},
    };
  }

  async function expectFrozen(cal: MockCalendarProvider) {
    const captured: { problem: any | null } = { problem: null };
    const r = await runResolve({
      env: { ...meetingEnv, SOLVER: capturingSolver(captured) },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    expect(captured.problem).toBeTruthy();
    // Unreadable free/busy → frozen → NOT promoted to a movable solver task.
    expect(captured.problem.tasks.find((t: any) => t.context === "meeting")).toBeUndefined();
    // Its event stays pinned as a busy block (held at its real slot).
    expect(captured.problem.external_pinned.find((p: any) => p.id === MEETING_ID)).toBeTruthy();
  }

  it("freezes the meeting when an attendee's free/busy is a 403 (calendar.freebusy not consented)", async () => {
    // The exact prod failure mode: missing-scope 403 reads back as a per-calendar
    // error for every attendee in the batch.
    await expectFrozen(
      new MockCalendarProvider({
        events: [ownedMeetingEvent()],
        freeBusy: { "a@x.com": { error: "freebusy_http_403" } },
      }),
    );
  });

  it("freezes the meeting on a transient upstream error (e.g. 502) rather than moving blind", async () => {
    // A transient 502 reads back as a per-calendar error just like a 403. We
    // freeze and defer the move to a later resolve where free/busy reads cleanly,
    // instead of relocating without knowing attendee availability.
    await expectFrozen(
      new MockCalendarProvider({
        events: [ownedMeetingEvent()],
        freeBusy: { "a@x.com": { error: "freebusy_http_502" } },
      }),
    );
  });

  it("freezes the meeting when an attendee's calendar is unreadable (notFound / private)", async () => {
    await expectFrozen(
      new MockCalendarProvider({
        events: [ownedMeetingEvent()],
        freeBusy: { "a@x.com": { error: "notFound" } },
      }),
    );
  });

  it("freezes the meeting when the whole free/busy query throws (transport failure → empty map)", async () => {
    // A thrown queryFreeBusy is caught in resolve-internal, leaving the free/busy
    // map empty, so every attendee reads back as unknown (undefined entry).
    const cal = new MockCalendarProvider({
      events: [ownedMeetingEvent()],
      freeBusy: {},
    });
    cal.queryFreeBusy = async () => {
      throw new Error("freebusy transport failure");
    };
    await expectFrozen(cal);
  });

  it("freezes the meeting when only SOME attendees are unreadable (one readable, one 403)", async () => {
    // Conservative policy: a single unreadable constraining attendee is enough to
    // freeze — we can't confirm the whole party is free at any new slot.
    await expectFrozen(
      new MockCalendarProvider({
        events: [twoAttendeeEvent()],
        freeBusy: { "a@x.com": { busy: [] }, "b@x.com": { error: "freebusy_http_403" } },
      }),
    );
  });

  it("does NOT freeze when free/busy is readable and EMPTY (attendee genuinely free)", async () => {
    // The negative control: an empty busy list is a SUCCESSFUL read meaning the
    // attendee is free — the meeting must remain movable. The fix must not
    // over-freeze legitimately-free attendees.
    const captured: { problem: any | null } = { problem: null };
    const r = await runResolve({
      env: { ...meetingEnv, SOLVER: capturingSolver(captured) },
      calendar: new MockCalendarProvider({
        events: [ownedMeetingEvent()],
        freeBusy: { "a@x.com": { busy: [] } },
      }),
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    const wire = captured.problem.tasks.find((t: any) => t.context === "meeting");
    expect(wire).toBeTruthy();
    expect(wire.availability_windows?.length).toBeGreaterThan(0);
    expect(captured.problem.external_pinned.find((p: any) => p.id === MEETING_ID)).toBeUndefined();
  });

  it("keeps a constraining (non-empty) mask for a 50-min speedy meeting whose readable attendee is busy all window", async () => {
    // Leak #2 (bug 2026-06-27): when free/busy is READABLE (so the freeze path
    // above does not apply) but the attendee is busy across the whole window, a
    // non-15-multiple "speedy" 50-min meeting used to round its current-slot
    // fallback away, emitting an EMPTY availability mask. The solver reads an
    // empty mask as UNCONSTRAINED and relocates the meeting onto attendee-busy
    // time. The mask must stay non-empty (and cover the current slot) so the
    // worst case is the meeting staying put — never a blind move.
    const captured: { problem: any | null } = { problem: null };
    const speedy: CalendarEvent = {
      id: MEETING_ID,
      summary: "1:1 with Alex",
      start: "2026-05-20T03:00:00.000Z",
      end: "2026-05-20T03:50:00.000Z", // 50 min — ends off the 15-grid
      organizer: { email: "primary", self: true },
      attendees: [
        { email: "primary", self: true, responseStatus: "accepted" },
        { email: "a@x.com", responseStatus: "accepted" },
      ],
      extendedProperties: {},
    };
    const cal = new MockCalendarProvider({
      events: [speedy],
      freeBusy: { "a@x.com": { busy: [{ start: "2026-05-20T00:00:00.000Z", end: "2026-05-21T00:00:00.000Z" }] } },
    });
    const r = await runResolve({
      env: { ...meetingEnv, SCHEDULER_TZ: "UTC", SOLVER: capturingSolver(captured) },
      calendar: cal,
      windowStart: "2026-05-20T00:00:00Z",
      windowEnd: "2026-05-21T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    const wire = captured.problem.tasks.find((t: any) => t.context === "meeting");
    expect(wire).toBeTruthy();
    // Mask is non-empty → solver is CONSTRAINED (not free to move anywhere).
    expect(wire.availability_windows?.length).toBeGreaterThan(0);
    // The stay-put window covers the current slot and holds the reserved chunk.
    const coversCurrent = (wire.availability_windows ?? []).some(
      (w: any) =>
        Date.parse(`${w.start}Z`) <= Date.parse("2026-05-20T03:00:00Z") &&
        Date.parse(`${w.end}Z`) >= Date.parse("2026-05-20T04:00:00Z"),
    );
    expect(coversCurrent).toBe(true);
  });

  it("does NOT freeze a meeting whose committed-move is older than the stability window", async () => {
    // A last_committed_move_at 48h before the faked now is far outside the
    // 60-minute window, so the freeze does not apply: the meeting is promoted to
    // a movable solver task exactly as an un-stamped meeting would be.
    const now = new Date().toISOString(); // 2026-05-18T00:00:00.000Z (faked)
    const stale = "2026-05-16T00:00:00.000Z"; // 48h before faked now
    await env.DB.prepare(
      "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at, last_committed_move_at) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(
        "mt-stale",
        "primary",
        JSON.stringify({ id: "mt-stale", title: "1:1 with Alex", context: "meeting", priority: 100, duration_minutes: 30, must_include: true, earliest_start: "2026-05-20T03:00:00.000Z", source: { kind: "meeting", external_id: MEETING_ID }, status: "pending", created_at: now, updated_at: now }),
        "pending",
        now,
        now,
        stale,
      )
      .run();
    const captured: { problem: any | null } = { problem: null };
    const cal = new MockCalendarProvider({
      events: [ownedMeetingEvent()],
      freeBusy: { "a@x.com": { busy: [] } },
    });
    const r = await runResolve({
      env: { ...meetingEnv, MEETING_COMMIT_STABILITY_MINUTES: "60", SOLVER: capturingSolver(captured) },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    // Stale committed-move → not frozen → promoted to a movable solver task.
    expect(captured.problem.tasks.find((t: any) => t.context === "meeting")).toBeTruthy();
  });

  // --- No constraining attendee under the effective policy -----------------
  // An EMPTY constraining set means "nobody's availability is known", not
  // "nothing blocks this meeting" — but the free/busy loop simply never runs
  // over an empty list, so hasUnknown stays false and the mask degenerates to
  // plain business hours. The meeting is then promoted as freely movable and
  // the solver may relocate it anywhere. A meeting whose attendees have not
  // yet responded, read under an accepted-only policy, is exactly that shape —
  // and so is a freshly confirmed public booking, whose booker would be emailed
  // a reschedule of the slot they picked.

  async function setPolicy(policy: string) {
    await env.DB.prepare("INSERT INTO config_meeting_policy (owner_subject, body) VALUES ('primary', ?)")
      .bind(JSON.stringify({ attendee_enforcement: policy }))
      .run();
  }

  function eventWithAttendee(attendee: Record<string, unknown>): CalendarEvent {
    return {
      id: MEETING_ID,
      summary: "1:1 with Alex",
      start: "2026-05-20T03:00:00.000Z",
      end: "2026-05-20T03:30:00.000Z",
      organizer: { email: "primary", self: true },
      attendees: [{ email: "primary", self: true, responseStatus: "accepted" }, attendee],
      extendedProperties: {},
    } as CalendarEvent;
  }

  async function resolveCapturing(cal: MockCalendarProvider) {
    const captured: { problem: any | null } = { problem: null };
    const r = await runResolve({
      env: { ...meetingEnv, SOLVER: capturingSolver(captured) },
      calendar: cal,
      windowStart: "2026-05-18T00:00:00Z",
      windowEnd: "2026-05-25T00:00:00Z",
      accountEmail: "primary",
      trigger: "api",
    });
    expect(r.kind).toBe("ok");
    expect(captured.problem).toBeTruthy();
    return captured;
  }

  it("freezes a meeting whose only attendee has not responded, under an accepted-only policy", async () => {
    await setPolicy("accepted");
    const captured = await resolveCapturing(
      new MockCalendarProvider({
        events: [eventWithAttendee({ email: "booker@x.com", responseStatus: "needsAction" })],
        freeBusy: { "booker@x.com": { busy: [] } },
      }),
    );
    // No attendee constrains it → nothing is known → NOT a movable solver task.
    expect(captured.problem.tasks.find((t: any) => t.context === "meeting")).toBeUndefined();
    // Its event stays pinned as a busy block (held at its real slot).
    expect(captured.problem.external_pinned.find((p: any) => p.id === MEETING_ID)).toBeTruthy();
  });

  it("freezes a tentative-only attendee's meeting under an accepted-only policy", async () => {
    await setPolicy("accepted");
    const captured = await resolveCapturing(
      new MockCalendarProvider({
        events: [eventWithAttendee({ email: "a@x.com", responseStatus: "tentative" })],
        freeBusy: { "a@x.com": { busy: [] } },
      }),
    );
    expect(captured.problem.tasks.find((t: any) => t.context === "meeting")).toBeUndefined();
    expect(captured.problem.external_pinned.find((p: any) => p.id === MEETING_ID)).toBeTruthy();
  });

  it("freezes a meeting whose only attendee has no responseStatus at all (never constraining under any policy)", async () => {
    // Google may omit responseStatus; constrainingAttendeeEmails skips such an
    // attendee whatever the policy, so even the not_declined default leaves the
    // set empty. Same hole, reached without any policy change.
    const captured = await resolveCapturing(
      new MockCalendarProvider({
        events: [eventWithAttendee({ email: "a@x.com" })],
        freeBusy: { "a@x.com": { busy: [] } },
      }),
    );
    expect(captured.problem.tasks.find((t: any) => t.context === "meeting")).toBeUndefined();
    expect(captured.problem.external_pinned.find((p: any) => p.id === MEETING_ID)).toBeTruthy();
  });

  it("STILL promotes a meeting whose attendee has accepted, under the same accepted-only policy", async () => {
    // The negative control: the freeze must key on the constraining set being
    // empty, not on the policy being strict. A genuinely accepted, readable
    // attendee still constrains the mask, so the meeting stays movable.
    await setPolicy("accepted");
    const captured = await resolveCapturing(
      new MockCalendarProvider({
        events: [ownedMeetingEvent()],
        freeBusy: { "a@x.com": { busy: [] } },
      }),
    );
    const wire = captured.problem.tasks.find((t: any) => t.context === "meeting");
    expect(wire).toBeTruthy();
    expect(wire.availability_windows?.length).toBeGreaterThan(0);
    expect(captured.problem.external_pinned.find((p: any) => p.id === MEETING_ID)).toBeUndefined();
  });

  it("STILL promotes a needsAction attendee's meeting under the not_declined default", async () => {
    // The other negative control: under the default policy a booker who has not
    // responded IS constraining, so the set is non-empty and the pre-existing
    // behaviour (promote, with their free/busy subtracted) is unchanged.
    const captured = await resolveCapturing(
      new MockCalendarProvider({
        events: [eventWithAttendee({ email: "booker@x.com", responseStatus: "needsAction" })],
        freeBusy: { "booker@x.com": { busy: [] } },
      }),
    );
    expect(captured.problem.tasks.find((t: any) => t.context === "meeting")).toBeTruthy();
  });
});
