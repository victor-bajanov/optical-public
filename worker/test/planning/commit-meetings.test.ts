import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { commitPlan } from "../../src/planning/commit";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { insertProposedPlan } from "../../src/planning/proposed-plans";

async function seedMeetingMovePlan(
  db: D1Database,
  opts: {
    eventId: string;
    liveStart: string;
    liveEnd: string;
    proposedStart: string;
    proposedEnd: string;
  },
): Promise<{ planHash: string; meetingTaskId: string; ownerSubject: string }> {
  const ownerSubject = "me@x.com";
  const meetingTaskId = `task-${opts.eventId}`;
  const planHash = `plan-${opts.eventId}`;

  await db
    .prepare(
      "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
    .bind(
      meetingTaskId,
      ownerSubject,
      JSON.stringify({
        id: meetingTaskId,
        title: "1:1",
        context: "meeting",
        priority: 100,
        duration_minutes: 30,
        must_include: true,
        source: { kind: "meeting", external_id: opts.eventId },
        status: "pending",
      }),
      "pending",
      "2026-05-18T00:00:00Z",
      "2026-05-18T00:00:00Z",
    )
    .run();

  await insertProposedPlan(
    db,
    planHash,
    {
      schedule: [
        {
          task_id: meetingTaskId,
          chunk_id: `${meetingTaskId}#0`,
          start: opts.proposedStart,
          end: opts.proposedEnd,
          context: "meeting",
        },
      ],
      dropped: [],
      window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
    },
    "2026-05-18T00:00:00Z",
    "2099-01-01T00:00:00Z",
    ownerSubject,
  );

  return { planHash, meetingTaskId, ownerSubject };
}

describe("commit meeting move", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposed_plans").run();
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare("DELETE FROM bookings").run();
  });

  it("patches the meeting's real event with notify and never creates a chunk event", async () => {
    // Seed a meeting task row whose source.external_id = evt1.
    await env.DB
      .prepare(
        "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(
        "task-m1",
        "me@x.com",
        JSON.stringify({
          id: "task-m1",
          title: "Standup",
          context: "meeting",
          priority: 100,
          duration_minutes: 30,
          must_include: true,
          source: { kind: "meeting", external_id: "evt1" },
          status: "pending",
        }),
        "pending",
        "2026-05-18T00:00:00Z",
        "2026-05-18T00:00:00Z",
      )
      .run();

    // Calendar already has evt1 at 09:00; the plan moves it to 10:00.
    const cal = new MockCalendarProvider({
      events: [
        {
          id: "evt1",
          summary: "Standup",
          start: "2026-05-19T09:00:00Z",
          end: "2026-05-19T09:30:00Z",
          extendedProperties: {},
        },
      ],
    });

    await insertProposedPlan(
      env.DB,
      "plan-m1",
      {
        schedule: [
          {
            task_id: "task-m1",
            chunk_id: "task-m1#0",
            start: "2026-05-19T10:00:00Z",
            end: "2026-05-19T10:30:00Z",
            context: "meeting",
          },
        ],
        dropped: [],
        window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
      },
      "2026-05-18T00:00:00Z",
      "2099-01-01T00:00:00Z",
      "me@x.com",
    );

    const res = await commitPlan(env.DB, cal, "plan-m1", "me@x.com");
    expect(res.status).toBe(200);

    // The real event must be patched with the new time and notifyAttendees.
    expect(cal.lastUpdate).toMatchObject({
      eventId: "evt1",
      changes: { start: "2026-05-19T10:00:00Z", end: "2026-05-19T10:30:00Z" },
      opts: { notifyAttendees: true },
    });

    // No scheduler chunk event should have been created.
    expect(cal.getCreated()).toHaveLength(0);
  });

  it("does not patch when the meeting stays at its current time", async () => {
    // Seed the same meeting task.
    await env.DB
      .prepare(
        "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(
        "task-m2",
        "me@x.com",
        JSON.stringify({
          id: "task-m2",
          title: "Standup",
          context: "meeting",
          priority: 100,
          duration_minutes: 30,
          must_include: true,
          source: { kind: "meeting", external_id: "evt2" },
          status: "pending",
        }),
        "pending",
        "2026-05-18T00:00:00Z",
        "2026-05-18T00:00:00Z",
      )
      .run();

    // Calendar has evt2 at 09:00; the plan also puts it at 09:00 (no move).
    const cal = new MockCalendarProvider({
      events: [
        {
          id: "evt2",
          summary: "Standup",
          start: "2026-05-19T09:00:00Z",
          end: "2026-05-19T09:30:00Z",
          extendedProperties: {},
        },
      ],
    });

    await insertProposedPlan(
      env.DB,
      "plan-m2",
      {
        schedule: [
          {
            task_id: "task-m2",
            chunk_id: "task-m2#0",
            start: "2026-05-19T09:00:00Z",
            end: "2026-05-19T09:30:00Z",
            context: "meeting",
          },
        ],
        dropped: [],
        window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
      },
      "2026-05-18T00:00:00Z",
      "2099-01-01T00:00:00Z",
      "me@x.com",
    );

    const res = await commitPlan(env.DB, cal, "plan-m2", "me@x.com");
    expect(res.status).toBe(200);

    // No updateEvent call since the time did not change.
    expect(cal.lastUpdate).toBeUndefined();
    expect(cal.getCreated()).toHaveLength(0);
  });

  it("stamps last_committed_move_at when a meeting actually moves, not on a no-op", async () => {
    const { planHash, meetingTaskId, ownerSubject } = await seedMeetingMovePlan(env.DB, {
      eventId: "evt-move-1",
      liveStart: "2026-05-20T03:00:00.000Z", liveEnd: "2026-05-20T03:30:00.000Z",
      proposedStart: "2026-05-20T05:00:00.000Z", proposedEnd: "2026-05-20T05:30:00.000Z",
    });
    const cal = new MockCalendarProvider({
      events: [{ id: "evt-move-1", summary: "1:1", start: "2026-05-20T03:00:00.000Z", end: "2026-05-20T03:30:00.000Z", extendedProperties: {} }],
    });

    await commitPlan(env.DB, cal, planHash, ownerSubject);

    const row = await env.DB.prepare("SELECT last_committed_move_at FROM tasks WHERE id = ?").bind(meetingTaskId).first<{ last_committed_move_at: string | null }>();
    expect(row?.last_committed_move_at).toBeTruthy();
    expect(Number.isFinite(Date.parse(row!.last_committed_move_at!))).toBe(true);
  });

  it("does NOT stamp last_committed_move_at when the meeting time is unchanged", async () => {
    const { planHash, meetingTaskId, ownerSubject } = await seedMeetingMovePlan(env.DB, {
      eventId: "evt-noop-1",
      liveStart: "2026-05-20T03:00:00.000Z", liveEnd: "2026-05-20T03:30:00.000Z",
      proposedStart: "2026-05-20T03:00:00.000Z", proposedEnd: "2026-05-20T03:30:00.000Z",
    });
    const cal = new MockCalendarProvider({
      events: [{ id: "evt-noop-1", summary: "1:1", start: "2026-05-20T03:00:00.000Z", end: "2026-05-20T03:30:00.000Z", extendedProperties: {} }],
    });

    await commitPlan(env.DB, cal, planHash, ownerSubject);

    const row = await env.DB.prepare("SELECT last_committed_move_at FROM tasks WHERE id = ?").bind(meetingTaskId).first<{ last_committed_move_at: string | null }>();
    expect(row?.last_committed_move_at).toBeNull();
  });

  it("syncs a public booking's row when the moved meeting is that booking's real event", async () => {
    // The moved meeting's calendar event is also a claimed public-booking slot:
    // bookings.google_event_id points at the same event the plan relocates.
    const { planHash, ownerSubject } = await seedMeetingMovePlan(env.DB, {
      eventId: "evt-booking-1",
      liveStart: "2026-05-20T03:00:00.000Z", liveEnd: "2026-05-20T03:30:00.000Z",
      proposedStart: "2026-05-20T05:00:00.000Z", proposedEnd: "2026-05-20T05:30:00.000Z",
    });
    await env.DB
      .prepare(
        `INSERT INTO bookings (id, owner_subject, slug, start_utc, end_utc, duration_minutes,
           booker_name, booker_email, booker_note, ip_hash, status, google_event_id, created_at, updated_at)
         VALUES (?,?,?,?,?,30,'Sam','sam@example.com',NULL,'h','confirmed',?,'2026-05-18T00:00:00Z','2026-05-18T00:00:00Z')`,
      )
      .bind("booking-1", ownerSubject, "victor", "2026-05-20T03:00:00Z", "2026-05-20T03:30:00Z", "evt-booking-1")
      .run();

    const cal = new MockCalendarProvider({
      events: [{ id: "evt-booking-1", summary: "1:1", start: "2026-05-20T03:00:00.000Z", end: "2026-05-20T03:30:00.000Z", extendedProperties: {} }],
    });

    const res = await commitPlan(env.DB, cal, planHash, ownerSubject);
    expect(res.status).toBe(200);

    const row = await env.DB
      .prepare("SELECT start_utc, end_utc, updated_at FROM bookings WHERE id = ?")
      .bind("booking-1")
      .first<{ start_utc: string; end_utc: string; updated_at: string }>();
    expect(row?.start_utc).toBe("2026-05-20T05:00:00Z");
    expect(row?.end_utc).toBe("2026-05-20T05:30:00Z");
    expect(row?.updated_at).not.toBe("2026-05-18T00:00:00Z");
  });
});
