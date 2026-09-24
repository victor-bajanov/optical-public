import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { syncOwnedMeetings } from "../../src/meetings/sync";
import { OPTICAL_MEETING_TASK_ID_KEY } from "../../src/providers/types";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";

const WINDOW = { startMs: Date.parse("2026-05-18T00:00:00Z"), endMs: Date.parse("2026-05-25T00:00:00Z") };
const CFG = { churnMultiplierCap: 20 };

describe("syncOwnedMeetings", () => {
  let db: D1Database;
  beforeEach(async () => {
    db = env.DB;
    await db.prepare("DELETE FROM tasks").run();
  });

  it("imports a new owned meeting as a tasks row and tags the event", async () => {
    const cal = new MockCalendarProvider({});
    const events = [
      {
        id: "evt1",
        summary: "Standup",
        start: "2026-05-19T09:00:00Z",
        end: "2026-05-19T09:30:00Z",
        extendedProperties: {},
        organizer: { self: true, email: "me@x.com" },
        attendees: [
          { email: "a@x.com", responseStatus: "accepted" },
          { email: "me@x.com", self: true, responseStatus: "accepted" },
        ],
      },
    ];
    await syncOwnedMeetings(db, cal, "me@x.com", events as any, WINDOW.startMs, WINDOW.endMs, CFG);

    const { results } = await db
      .prepare("SELECT id, body, status FROM tasks WHERE owner_subject = ?")
      .bind("me@x.com")
      .all<{ id: string; body: string; status: string }>();
    expect(results).toHaveLength(1);
    const row0 = results[0]!;
    const body = JSON.parse(row0.body);
    expect(body.context).toBe("meeting");
    expect(body.source).toEqual({ kind: "meeting", external_id: "evt1" });
    expect(body.must_include).toBe(true);
    expect(body.duration_minutes).toBe(30);
    // event tagged with the new row id
    expect(cal.lastUpdate?.changes.extendedProperties?.private?.[OPTICAL_MEETING_TASK_ID_KEY]).toBe(row0.id);
  });

  it("is idempotent: a second sync of the same event creates no second row", async () => {
    const cal = new MockCalendarProvider({});
    const tagged = [
      {
        id: "evt1",
        summary: "Standup",
        start: "2026-05-19T09:00:00Z",
        end: "2026-05-19T09:30:00Z",
        organizer: { self: true },
        attendees: [{ email: "a@x.com", responseStatus: "accepted" }],
        extendedProperties: { private: { [OPTICAL_MEETING_TASK_ID_KEY]: "task-existing" } },
      },
    ];
    // Seed the existing row:
    await db
      .prepare(
        "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(
        "task-existing",
        "me@x.com",
        JSON.stringify({
          id: "task-existing",
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

    await syncOwnedMeetings(db, cal, "me@x.com", tagged as any, WINDOW.startMs, WINDOW.endMs, CFG);
    const { results } = await db.prepare("SELECT id FROM tasks WHERE owner_subject = ?").bind("me@x.com").all();
    expect(results).toHaveLength(1);
  });

  it("cancels a row whose in-window meeting event has vanished", async () => {
    const cal = new MockCalendarProvider({});
    await db
      .prepare(
        "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      )
      .bind(
        "task-gone",
        "me@x.com",
        JSON.stringify({
          id: "task-gone",
          title: "Old",
          context: "meeting",
          priority: 100,
          duration_minutes: 30,
          earliest_start: "2026-05-19T09:00:00Z",
          must_include: true,
          source: { kind: "meeting", external_id: "evt-gone" },
          status: "pending",
        }),
        "pending",
        "2026-05-18T00:00:00Z",
        "2026-05-18T00:00:00Z",
      )
      .run();

    // No events this window → the in-window meeting row is cancelled.
    await syncOwnedMeetings(db, cal, "me@x.com", [], WINDOW.startMs, WINDOW.endMs, CFG);
    const row = await db.prepare("SELECT status FROM tasks WHERE id = ?").bind("task-gone").first<{ status: string }>();
    expect(row?.status).toBe("cancelled");
  });
});
