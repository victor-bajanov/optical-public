import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { mountCommitRoute } from "../../src/planning/commit";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import type { CalendarProvider } from "../../src/providers/calendar-provider";
import type { NotificationProvider } from "../../src/providers/notification-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import { hashToken } from "../../src/auth/tokens";
import { getProposedPlan } from "../../src/planning/proposed-plans";

type Vars = { calendarProvider: CalendarProvider; notificationProvider: NotificationProvider; ownerSubject?: string };

async function seedBearer(token: string, subject = "primary") {
  const hashed = await hashToken(token, env.TOKEN_HASH_PEPPER);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?, 'test-client', 'scheduler.write', NULL, NULL, NULL, ?)",
  )
    .bind(hashed, subject)
    .run();
}

function makeApp(cal: MockCalendarProvider) {
  const v1 = new OpenAPIHono<{ Bindings: typeof env; Variables: Vars }>();
  v1.use("*", async (c, next) => {
    c.set("calendarProvider", cal);
    c.set("notificationProvider", new MockNotificationProvider());
    await next();
  });
  mountCommitRoute(v1);
  const app = new Hono<{ Bindings: typeof env; Variables: Vars }>();
  app.route("/v1", v1);
  return app;
}

const planBody = {
  schedule: [
    {
      task_id: "task-deep-1",
      chunk_id: "task-deep-1#0",
      start: "2026-05-19T09:00:00Z",
      end: "2026-05-19T10:30:00Z",
      context: "deep",
    },
  ],
  dropped: [],
  window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
};

const task = {
  id: "task-deep-1",
  title: "Deep work",
  context: "deep",
  priority: 80,
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
};

describe("POST /v1/commit", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposed_plans").run();
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare("DELETE FROM oauth_tokens").run();
    await env.DB
      .prepare(
        "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)",
      )
      .bind(task.id, "primary", JSON.stringify(task), task.created_at, task.updated_at)
      .run();
    await env.DB
      .prepare(
        "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES (?, ?, ?, ?, NULL, 'primary')",
      )
      .bind("h1", JSON.stringify(planBody), "2026-05-18T00:00:00Z", "2099-01-01T00:00:00Z")
      .run();
    await seedBearer("fake");
  });

  it("creates a calendar event per schedule entry and stamps scheduler_chunk_id", async () => {
    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    const res = await app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ plan_hash: "h1" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const created = cal.getCreated();
    expect(created).toHaveLength(1);
    expect(created[0]!.summary).toBe("Deep work");
    expect(created[0]!.extendedProperties.private?.scheduler_chunk_id).toBe("task-deep-1#0");
  });

  it("paints a freshly created chunk the scheduler create colour", async () => {
    // The provider no longer forces colorId "5" (a booking must not render in
    // the chunk colour), so commitPlan must set it explicitly.
    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    await app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ plan_hash: "h1" }),
      },
      env,
    );
    expect(cal.getCreated()[0]!.colorId).toBe("5");
  });

  it("marks the plan committed_at and flips task status to committed", async () => {
    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    await app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ plan_hash: "h1" }),
      },
      env,
    );
    const planRow = await env.DB
      .prepare("SELECT committed_at FROM proposed_plans WHERE plan_hash = 'h1'")
      .first<{ committed_at: string | null }>();
    expect(planRow?.committed_at).not.toBeNull();
    const taskRow = await env.DB
      .prepare("SELECT status FROM tasks WHERE id = 'task-deep-1'")
      .first<{ status: string }>();
    expect(taskRow?.status).toBe("committed");
  });

  it("is idempotent on plan_hash — second call returns 200 without re-creating events", async () => {
    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    await app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ plan_hash: "h1" }),
      },
      env,
    );
    const after1 = cal.getCreated().length;
    const res2 = await app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ plan_hash: "h1" }),
      },
      env,
    );
    expect(res2.status).toBe(200);
    expect(cal.getCreated()).toHaveLength(after1);
  });

  it("returns 404 for unknown plan_hash", async () => {
    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    const res = await app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ plan_hash: "no-such" }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("returns 410 for expired plan", async () => {
    await env.DB
      .prepare("UPDATE proposed_plans SET expires_at = ? WHERE plan_hash = 'h1'")
      .bind("2000-01-01T00:00:00Z")
      .run();
    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    const res = await app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ plan_hash: "h1" }),
      },
      env,
    );
    expect(res.status).toBe(410);
  });

  it("stamps scheduled_for to the committed chunk start", async () => {
    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    await app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ plan_hash: "h1" }),
      },
      env,
    );
    const row = await env.DB
      .prepare("SELECT scheduled_for FROM tasks WHERE id = 'task-deep-1'")
      .first<{ scheduled_for: string | null }>();
    // planBody's single entry starts at 2026-05-19T09:00:00Z.
    expect(row?.scheduled_for).toBe("2026-05-19T09:00:00Z");
  });

  it("stamps scheduled_for to the EARLIEST start for a multi-chunk task", async () => {
    // A plan that places task-deep-1 in two chunks; the later chunk appears
    // first in the array to prove we take the minimum, not the first.
    const multiChunkPlan = {
      schedule: [
        { task_id: "task-deep-1", chunk_id: "task-deep-1#1", start: "2026-05-21T09:00:00Z", end: "2026-05-21T10:00:00Z", context: "deep" },
        { task_id: "task-deep-1", chunk_id: "task-deep-1#0", start: "2026-05-19T09:00:00Z", end: "2026-05-19T10:00:00Z", context: "deep" },
      ],
      dropped: [],
      window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
    };
    await env.DB
      .prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES (?, ?, ?, ?, NULL, 'primary')")
      .bind("h-multi", JSON.stringify(multiChunkPlan), "2026-05-18T00:00:00Z", "2099-01-01T00:00:00Z")
      .run();
    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    await app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ plan_hash: "h-multi" }),
      },
      env,
    );
    const row = await env.DB
      .prepare("SELECT scheduled_for FROM tasks WHERE id = 'task-deep-1'")
      .first<{ scheduled_for: string | null }>();
    expect(row?.scheduled_for).toBe("2026-05-19T09:00:00Z");
  });

  it("overwrites scheduled_for when a later plan re-commits the task to a new week", async () => {
    const laterPlan = {
      schedule: [
        { task_id: "task-deep-1", chunk_id: "task-deep-1#0", start: "2026-05-26T09:00:00Z", end: "2026-05-26T10:30:00Z", context: "deep" },
      ],
      dropped: [],
      window: { start: "2026-05-25T00:00:00Z", end: "2026-06-01T00:00:00Z" },
    };
    await env.DB
      .prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES (?, ?, ?, ?, NULL, 'primary')")
      .bind("h2", JSON.stringify(laterPlan), "2026-05-25T00:00:00Z", "2099-01-01T00:00:00Z")
      .run();
    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    const commit = (hash: string) =>
      app.request(
        "/v1/commit",
        {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: "Bearer fake" },
          body: JSON.stringify({ plan_hash: hash }),
        },
        env,
      );
    await commit("h1");  // stamps 2026-05-19T09:00:00Z
    await commit("h2");  // re-commits the same task to the following week
    const row = await env.DB
      .prepare("SELECT scheduled_for FROM tasks WHERE id = 'task-deep-1'")
      .first<{ scheduled_for: string | null }>();
    expect(row?.scheduled_for).toBe("2026-05-26T09:00:00Z");
  });

  function existingMatchingEvent() {
    return {
      id: "g-existing-0",
      summary: "Deep work",
      start: "2026-05-19T09:00:00Z",
      end: "2026-05-19T10:30:00Z",
      extendedProperties: { private: { scheduler_chunk_id: "task-deep-1#0" } },
    };
  }

  function postCommit(app: ReturnType<typeof makeApp>, hash: string) {
    return app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ plan_hash: hash }),
      },
      env,
    );
  }

  it("PATCHes a moved chunk in place, leaving its event id and chunk_id intact", async () => {
    const cal = new MockCalendarProvider({
      events: [
        {
          id: "g-moved-0",
          summary: "Deep work",
          start: "2026-05-19T13:00:00Z",
          end: "2026-05-19T14:30:00Z",
          extendedProperties: { private: { scheduler_chunk_id: "task-deep-1#0" } },
        },
      ],
    });
    const app = makeApp(cal);
    const res = await postCommit(app, "h1");
    expect(res.status).toBe(200);

    expect(cal.getUpdated()).toHaveLength(1);
    expect(cal.getCreated()).toHaveLength(0);
    expect(cal.getDeleted()).toHaveLength(0);

    const upd = cal.getUpdated()[0]!;
    expect(upd.eventId).toBe("g-moved-0");
    expect(upd.changes.start).toBe("2026-05-19T09:00:00Z");
    expect(upd.changes.end).toBe("2026-05-19T10:30:00Z");
    expect(upd.changes.summary).toBe("Deep work");
    expect(upd.changes.extendedProperties).toBeUndefined();

    const remaining = (
      await cal.fetchEventsInWindow("2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z")
    ).events;
    const ev = remaining.find((e) => e.id === "g-moved-0");
    expect(ev).toBeDefined();
    expect(ev!.start).toBe("2026-05-19T09:00:00Z");
    expect(ev!.extendedProperties.private?.scheduler_chunk_id).toBe("task-deep-1#0");
  });

  it("is a no-op when the existing event already matches the proposed chunk", async () => {
    const cal = new MockCalendarProvider({ events: [existingMatchingEvent()] });
    const app = makeApp(cal);
    const res = await postCommit(app, "h1");
    expect(res.status).toBe(200);
    expect(cal.getCreated()).toHaveLength(0);
    expect(cal.getUpdated()).toHaveLength(0);
    expect(cal.getDeleted()).toHaveLength(0);
  });

  it("treats an existing event in local-offset time as a no-op when it matches the proposed instant", async () => {
    // Real Google events come back in offset form (e.g. +10:00), not UTC Z;
    // the same instant must not be seen as a change.
    const cal = new MockCalendarProvider({
      events: [
        {
          id: "g-offset-0",
          summary: "Deep work",
          start: "2026-05-19T19:00:00+10:00",
          end: "2026-05-19T20:30:00+10:00",
          extendedProperties: { private: { scheduler_chunk_id: "task-deep-1#0" } },
        },
      ],
    });
    const app = makeApp(cal);
    const res = await postCommit(app, "h1");
    expect(res.status).toBe(200);
    expect(cal.getUpdated()).toHaveLength(0);
    expect(cal.getCreated()).toHaveLength(0);
    expect(cal.getDeleted()).toHaveLength(0);
  });

  it("deletes a scheduler event whose chunk is no longer in the plan", async () => {
    const cal = new MockCalendarProvider({
      events: [
        existingMatchingEvent(),
        {
          id: "g-removed-9",
          summary: "Deep work",
          start: "2026-05-20T09:00:00Z",
          end: "2026-05-20T10:00:00Z",
          extendedProperties: { private: { scheduler_chunk_id: "task-deep-1#9" } },
        },
      ],
    });
    const app = makeApp(cal);
    const res = await postCommit(app, "h1");
    expect(res.status).toBe(200);
    expect(cal.getDeleted()).toEqual(["g-removed-9"]);
    expect(cal.getCreated()).toHaveLength(0);
    expect(cal.getUpdated()).toHaveLength(0);

    const remaining = (
      await cal.fetchEventsInWindow("2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z")
    ).events;
    expect(remaining.find((e) => e.id === "g-removed-9")).toBeUndefined();
    expect(remaining.find((e) => e.id === "g-existing-0")).toBeDefined();
  });

  it("creates an event for a chunk that has no existing event", async () => {
    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    const res = await postCommit(app, "h1");
    expect(res.status).toBe(200);
    expect(cal.getCreated()).toHaveLength(1);
    expect(cal.getCreated()[0]!.extendedProperties.private?.scheduler_chunk_id).toBe(
      "task-deep-1#0",
    );
    expect(cal.getUpdated()).toHaveLength(0);
    expect(cal.getDeleted()).toHaveLength(0);
  });

  it("PATCHes summary on a title-only change without moving start/end", async () => {
    const cal = new MockCalendarProvider({
      events: [
        {
          id: "g-title-0",
          summary: "Old title",
          start: "2026-05-19T09:00:00Z",
          end: "2026-05-19T10:30:00Z",
          extendedProperties: { private: { scheduler_chunk_id: "task-deep-1#0" } },
        },
      ],
    });
    const app = makeApp(cal);
    const res = await postCommit(app, "h1");
    expect(res.status).toBe(200);
    expect(cal.getUpdated()).toHaveLength(1);
    expect(cal.getCreated()).toHaveLength(0);
    expect(cal.getDeleted()).toHaveLength(0);

    const upd = cal.getUpdated()[0]!;
    expect(upd.eventId).toBe("g-title-0");
    expect(upd.changes.summary).toBe("Deep work");
    expect(upd.changes.start).toBe("2026-05-19T09:00:00Z");
    expect(upd.changes.end).toBe("2026-05-19T10:30:00Z");
  });

  it("leaves unchanged chunks' events untouched while PATCHing only the moved chunk", async () => {
    // Spec test 1: plan with 3 chunks where exactly 1 moved → 1 updateEvent,
    // 0 createEvent, 0 deleteEvent; the 2 unchanged events keep their ids.
    const threeChunkPlan = {
      schedule: [
        { task_id: "task-deep-1", chunk_id: "task-deep-1#0", start: "2026-05-19T09:00:00Z", end: "2026-05-19T10:30:00Z", context: "deep" },
        { task_id: "task-deep-1", chunk_id: "task-deep-1#1", start: "2026-05-20T09:00:00Z", end: "2026-05-20T10:30:00Z", context: "deep" },
        { task_id: "task-deep-1", chunk_id: "task-deep-1#2", start: "2026-05-21T09:00:00Z", end: "2026-05-21T10:30:00Z", context: "deep" },
      ],
      dropped: [],
      window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
    };
    await env.DB
      .prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES (?, ?, ?, ?, NULL, 'primary')")
      .bind("h-three", JSON.stringify(threeChunkPlan), "2026-05-18T00:00:00Z", "2099-01-01T00:00:00Z")
      .run();

    const cal = new MockCalendarProvider({
      events: [
        // #0 already matches the plan exactly (unchanged).
        {
          id: "g-unchanged-0",
          summary: "Deep work",
          start: "2026-05-19T09:00:00Z",
          end: "2026-05-19T10:30:00Z",
          extendedProperties: { private: { scheduler_chunk_id: "task-deep-1#0" } },
        },
        // #1 already matches the plan exactly (unchanged).
        {
          id: "g-unchanged-1",
          summary: "Deep work",
          start: "2026-05-20T09:00:00Z",
          end: "2026-05-20T10:30:00Z",
          extendedProperties: { private: { scheduler_chunk_id: "task-deep-1#1" } },
        },
        // #2 sits at a different time than the plan (moved); still inside window.
        {
          id: "g-moved-2",
          summary: "Deep work",
          start: "2026-05-21T13:00:00Z",
          end: "2026-05-21T14:30:00Z",
          extendedProperties: { private: { scheduler_chunk_id: "task-deep-1#2" } },
        },
      ],
    });
    const app = makeApp(cal);
    const res = await postCommit(app, "h-three");
    expect(res.status).toBe(200);

    // Exactly one update (the moved chunk), no creates, no deletes.
    expect(cal.getUpdated()).toHaveLength(1);
    expect(cal.getCreated()).toHaveLength(0);
    expect(cal.getDeleted()).toHaveLength(0);
    expect(cal.getUpdated()[0]!.eventId).toBe("g-moved-2");

    // The two unchanged events still exist under their ORIGINAL ids.
    const remaining = (
      await cal.fetchEventsInWindow("2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z")
    ).events;
    const ev0 = remaining.find((e) => e.id === "g-unchanged-0");
    const ev1 = remaining.find((e) => e.id === "g-unchanged-1");
    expect(ev0).toBeDefined();
    expect(ev1).toBeDefined();
    expect(ev0!.extendedProperties.private?.scheduler_chunk_id).toBe("task-deep-1#0");
    expect(ev1!.extendedProperties.private?.scheduler_chunk_id).toBe("task-deep-1#1");

    // Neither unchanged id was updated or deleted.
    const updatedIds = cal.getUpdated().map((u) => u.eventId);
    expect(updatedIds).not.toContain("g-unchanged-0");
    expect(updatedIds).not.toContain("g-unchanged-1");
    expect(cal.getDeleted()).not.toContain("g-unchanged-0");
    expect(cal.getDeleted()).not.toContain("g-unchanged-1");
  });

  it("is idempotent: reconciling an already-reconciled window does nothing", async () => {
    const cal = new MockCalendarProvider({
      events: [
        {
          id: "g-idem-0",
          summary: "Deep work",
          start: "2026-05-19T13:00:00Z",
          end: "2026-05-19T14:30:00Z",
          extendedProperties: { private: { scheduler_chunk_id: "task-deep-1#0" } },
        },
      ],
    });
    const app = makeApp(cal);

    await postCommit(app, "h1");
    expect(cal.getUpdated()).toHaveLength(1);

    await env.DB.prepare(
      "UPDATE proposed_plans SET committed_at = NULL WHERE plan_hash = 'h1'",
    ).run();
    await postCommit(app, "h1");

    expect(cal.getUpdated()).toHaveLength(1);
    expect(cal.getCreated()).toHaveLength(0);
    expect(cal.getDeleted()).toHaveLength(0);
  });

  it("is idempotent from a converged state: two commits over a matching event do nothing", async () => {
    // The seeded event already matches the plan exactly, so both runs converge
    // to a no-op: no creates, updates, or deletes across either commit.
    const cal = new MockCalendarProvider({ events: [existingMatchingEvent()] });
    const app = makeApp(cal);

    const res1 = await postCommit(app, "h1");
    expect(res1.status).toBe(200);
    expect(cal.getCreated()).toHaveLength(0);
    expect(cal.getUpdated()).toHaveLength(0);
    expect(cal.getDeleted()).toHaveLength(0);

    await env.DB.prepare(
      "UPDATE proposed_plans SET committed_at = NULL WHERE plan_hash = 'h1'",
    ).run();
    const res2 = await postCommit(app, "h1");
    expect(res2.status).toBe(200);

    // Still nothing after the second pass.
    expect(cal.getCreated()).toHaveLength(0);
    expect(cal.getUpdated()).toHaveLength(0);
    expect(cal.getDeleted()).toHaveLength(0);
  });

  it("does not flip another owner's task to committed", async () => {
    // Seed a task owned by owner-b with its own unique id. Then seed a plan
    // (as if tampered) that references owner-b's task id. Committing that plan
    // as "primary" exercises the UPDATE with WHERE id = ? AND owner_subject = ?
    // — without the owner_subject predicate the UPDATE would flip owner-b's row;
    // with it, the row remains pending because owner_subject = 'primary' never
    // matches owner-b's row.
    await env.DB
      .prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)")
      .bind("task-b-owned", "owner-b", JSON.stringify({ ...task, id: "task-b-owned", title: "B task" }), task.created_at, task.updated_at)
      .run();

    const crossOwnerPlan = {
      schedule: [
        { task_id: "task-b-owned", chunk_id: "task-b-owned#0", start: "2026-05-19T09:00:00Z", end: "2026-05-19T10:30:00Z", context: "deep" },
      ],
      dropped: [],
      window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
    };
    await env.DB
      .prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES (?, ?, ?, ?, NULL, 'primary')")
      .bind("h-cross", JSON.stringify(crossOwnerPlan), "2026-05-18T00:00:00Z", "2099-01-01T00:00:00Z")
      .run();

    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    const res = await app.request(
      "/v1/commit",
      { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer fake" }, body: JSON.stringify({ plan_hash: "h-cross" }) },
      env,
    );
    // Confirm the route reached the UPDATE path (not a 404/403/etc regression).
    expect(res.status).toBe(200);

    // owner-b's task must remain pending — the AND owner_subject = 'primary' predicate blocked the write.
    const b = await env.DB.prepare("SELECT status FROM tasks WHERE id = ?").bind("task-b-owned").first<{ status: string }>();
    expect(b!.status).toBe("pending");
  });

  it("does not create a calendar event for a cross-owner task (SELECT isolation)", async () => {
    // Seed a task owned by owner-b whose title differs from the fallback task_id.
    // Then seed a plan (as if tampered) that references owner-b's task id but is
    // committed as "primary". loadScheduleTasks uses WHERE owner_subject = ? so it
    // returns no row for the cross-owner task, which is then excluded as non-live —
    // no calendar event is created at all (stronger than the old title-fallback
    // behaviour, which created an event summarised by the raw task_id).
    await env.DB
      .prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)")
      .bind("task-b-secret", "owner-b", JSON.stringify({ ...task, id: "task-b-secret", title: "B secret title" }), task.created_at, task.updated_at)
      .run();

    const crossOwnerSelectPlan = {
      schedule: [
        { task_id: "task-b-secret", chunk_id: "task-b-secret#0", start: "2026-05-19T09:00:00Z", end: "2026-05-19T10:30:00Z", context: "deep" },
      ],
      dropped: [],
      window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
    };
    await env.DB
      .prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES (?, ?, ?, ?, NULL, 'primary')")
      .bind("h-select-cross", JSON.stringify(crossOwnerSelectPlan), "2026-05-18T00:00:00Z", "2099-01-01T00:00:00Z")
      .run();

    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    const res = await app.request(
      "/v1/commit",
      { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer fake" }, body: JSON.stringify({ plan_hash: "h-select-cross" }) },
      env,
    );
    expect(res.status).toBe(200);

    // With the live-task filter in place, a cross-owner task is invisible to "primary"
    // (loadScheduleTasks uses WHERE owner_subject = 'primary', returning no row), so
    // no calendar event is created at all — stronger than the previous title-fallback
    // behaviour, and the "B secret title" data is still not leaked.
    const created = cal.getCreated();
    expect(created).toHaveLength(0);
  });

  it("rejects a token with no subject (403 no_subject)", async () => {
    await env.DB.prepare("DELETE FROM oauth_tokens").run();
    // Seed a bearer with a NULL subject.
    const hashed = await hashToken("nosub", env.TOKEN_HASH_PEPPER);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?, 'test-client', 'scheduler.write', NULL, NULL, NULL, NULL)",
    ).bind(hashed).run();

    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    const res = await app.request(
      "/v1/commit",
      { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer nosub" }, body: JSON.stringify({ plan_hash: "h1" }) },
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "no_subject" });
  });

  it("cannot commit another tenant's plan", async () => {
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('b-plan', ?, '2026-05-18T12:00:00Z', '2099-01-01T00:00:00Z', NULL, 'b@org')",
    ).bind(JSON.stringify(planBody)).run();
    const cal = new MockCalendarProvider();
    const res = await makeApp(cal).request("/v1/commit", {
      method: "POST",
      headers: { Authorization: "Bearer fake", "content-type": "application/json" },
      body: JSON.stringify({ plan_hash: "b-plan" }),
    }, env);
    expect(res.status).toBe(404);
    expect((await getProposedPlan(env.DB, "b-plan"))?.committed_at).toBeNull();
  });

  it("resets solver-dropped tasks to pending and clears their stamp", async () => {
    // A second task, previously committed with a stamp, dropped by this plan.
    const droppedTask = { ...task, id: "task-dropped-1", title: "Squeezed out" };
    await env.DB
      .prepare(
        "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at, scheduled_for) VALUES (?, 'primary', ?, 'committed', ?, ?, '2026-05-12T09:00:00Z')",
      )
      .bind(droppedTask.id, JSON.stringify(droppedTask), task.created_at, task.updated_at)
      .run();
    const planWithDrop = {
      ...planBody,
      dropped: [
        { task_id: "task-dropped-1", title: "Squeezed out", drop_cost: 200, reason: "over-subscribed", contributing_constraints: [] },
      ],
    };
    await env.DB
      .prepare(
        "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('h2', ?, '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', NULL, 'primary')",
      )
      .bind(JSON.stringify(planWithDrop))
      .run();

    const app = makeApp(new MockCalendarProvider());
    const res = await app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ plan_hash: "h2" }),
      },
      env,
    );
    expect(res.status).toBe(200);

    const dropped = await env.DB
      .prepare("SELECT status, scheduled_for FROM tasks WHERE id = 'task-dropped-1'")
      .first<{ status: string; scheduled_for: string | null }>();
    expect(dropped?.status).toBe("pending");
    expect(dropped?.scheduled_for).toBeNull();

    // The scheduled task is stamped as before.
    const kept = await env.DB
      .prepare("SELECT status, scheduled_for FROM tasks WHERE id = 'task-deep-1'")
      .first<{ status: string; scheduled_for: string | null }>();
    expect(kept?.status).toBe("committed");
    expect(kept?.scheduled_for).toBe("2026-05-19T09:00:00Z");
  });

  it("does not resurrect a scheduled task the user marked done between resolve and commit", async () => {
    // task-deep-1 is in plan h1's schedule. The user marks it done after the
    // plan was proposed but before committing. The stamping UPDATE must not
    // flip it back to 'committed' with a fresh stamp.
    await env.DB.prepare("UPDATE tasks SET status='done' WHERE id='task-deep-1'").run();

    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    const res = await app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ plan_hash: "h1" }),
      },
      env,
    );
    expect(res.status).toBe(200);

    const row = await env.DB
      .prepare("SELECT status FROM tasks WHERE id = 'task-deep-1'")
      .first<{ status: string }>();
    expect(row?.status).toBe("done");
  });

  it("does not resurrect a scheduled task the user cancelled between resolve and commit", async () => {
    await env.DB.prepare("UPDATE tasks SET status='cancelled' WHERE id='task-deep-1'").run();

    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    const res = await app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ plan_hash: "h1" }),
      },
      env,
    );
    expect(res.status).toBe(200);

    const row = await env.DB
      .prepare("SELECT status FROM tasks WHERE id = 'task-deep-1'")
      .first<{ status: string }>();
    expect(row?.status).toBe("cancelled");
  });

  it("does not resurrect a dropped task the user marked done between resolve and commit", async () => {
    const doneTask = { ...task, id: "task-done-1", title: "Finished meanwhile" };
    await env.DB
      .prepare(
        "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at, scheduled_for) VALUES (?, 'primary', ?, 'done', ?, ?, '2026-05-12T09:00:00Z')",
      )
      .bind(doneTask.id, JSON.stringify(doneTask), task.created_at, task.updated_at)
      .run();
    const planWithDrop = {
      ...planBody,
      dropped: [
        { task_id: "task-done-1", title: "Finished meanwhile", drop_cost: 200, reason: "over-subscribed", contributing_constraints: [] },
      ],
    };
    await env.DB
      .prepare(
        "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('h3', ?, '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', NULL, 'primary')",
      )
      .bind(JSON.stringify(planWithDrop))
      .run();

    const app = makeApp(new MockCalendarProvider());
    const res = await app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ plan_hash: "h3" }),
      },
      env,
    );
    expect(res.status).toBe(200);

    const row = await env.DB
      .prepare("SELECT status, scheduled_for FROM tasks WHERE id = 'task-done-1'")
      .first<{ status: string; scheduled_for: string | null }>();
    expect(row?.status).toBe("done");
    expect(row?.scheduled_for).toBe("2026-05-12T09:00:00Z");
  });

  it("OS1: a foreign plan_hash mutates nothing and 404s (no calendar side effects)", async () => {
    const TOKEN = "tok-os1-foreign";
    await seedBearer(TOKEN, "primary");
    // Plan owned by a DIFFERENT subject.
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES (?,?,?,?,?,?)",
    )
      .bind(
        "foreign-hash",
        JSON.stringify(planBody),
        "2026-05-17T00:00:00Z",
        "2099-01-01T00:00:00Z",
        null,
        "other@org",
      )
      .run();

    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    const res = await app.request("/v1/commit", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ plan_hash: "foreign-hash" }),
    }, env);

    expect(res.status).toBe(404);
    expect(cal.getCreated()).toEqual([]);
    expect(cal.getUpdated()).toEqual([]);
    expect(cal.getDeleted()).toEqual([]);
    // The foreign plan must remain uncommitted.
    const plan = await getProposedPlan(env.DB, "foreign-hash");
    expect(plan?.committed_at).toBeNull();
  });

  it("does not create an event for a task deleted between resolve and commit (X2)", async () => {
    // Remove the seeded task so its id is missing at commit time.
    await env.DB.prepare("DELETE FROM tasks WHERE id = 'task-deep-1'").run();
    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    const res = await app.request(
      "/v1/commit",
      { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer fake" }, body: JSON.stringify({ plan_hash: "h1" }) },
      env,
    );
    expect(res.status).toBe(200);
    expect(cal.getCreated()).toHaveLength(0);
    expect(await res.json()).toMatchObject({ committed: 0 });
  });

  it("deletes the prior event of a task gone done between resolve and commit (X2)", async () => {
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE id = 'task-deep-1'").run();
    // A prior committed event for this chunk already exists on the calendar.
    const prior = {
      id: "evt-prior",
      summary: "Deep work",
      start: "2026-05-19T09:00:00Z",
      end: "2026-05-19T10:30:00Z",
      extendedProperties: { private: { scheduler_chunk_id: "task-deep-1#0" } },
    };
    const cal = new MockCalendarProvider({ events: [prior] });
    const app = makeApp(cal);
    const res = await app.request(
      "/v1/commit",
      { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer fake" }, body: JSON.stringify({ plan_hash: "h1" }) },
      env,
    );
    expect(res.status).toBe(200);
    expect(cal.getCreated()).toHaveLength(0);     // no fresh ghost
    expect(cal.getDeleted()).toContain("evt-prior"); // slot released
    expect(await res.json()).toMatchObject({ committed: 0 });
  });

  it("creates events only for the live task in a mixed-status plan (X2)", async () => {
    // Add a second live task + a second schedule entry for it.
    await env.DB
      .prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)")
      .bind("task-live-2", "primary", JSON.stringify({ ...task, id: "task-live-2", title: "Live two" }), task.created_at, task.updated_at)
      .run();
    // task-deep-1 is cancelled; task-live-2 stays live.
    await env.DB.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = 'task-deep-1'").run();
    const mixedBody = {
      schedule: [
        { task_id: "task-deep-1", chunk_id: "task-deep-1#0", start: "2026-05-19T09:00:00Z", end: "2026-05-19T10:30:00Z", context: "deep" },
        { task_id: "task-live-2", chunk_id: "task-live-2#0", start: "2026-05-19T11:00:00Z", end: "2026-05-19T12:30:00Z", context: "deep" },
      ],
      dropped: [],
      window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
    };
    await env.DB.prepare("UPDATE proposed_plans SET body = ? WHERE plan_hash = 'h1'").bind(JSON.stringify(mixedBody)).run();
    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    const res = await app.request(
      "/v1/commit",
      { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer fake" }, body: JSON.stringify({ plan_hash: "h1" }) },
      env,
    );
    expect(res.status).toBe(200);
    const created = cal.getCreated();
    expect(created).toHaveLength(1);
    expect(created[0]!.summary).toBe("Live two");
    expect(await res.json()).toMatchObject({ committed: 1 });
  });

  it("OS1: a legacy NULL-subject plan_hash 404s with no side effects", async () => {
    const TOKEN = "tok-os1-null";
    await seedBearer(TOKEN, "primary");
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES (?,?,?,?,?,?)",
    )
      .bind("null-hash", JSON.stringify(planBody), "2026-05-17T00:00:00Z", "2099-01-01T00:00:00Z", null, null)
      .run();

    const cal = new MockCalendarProvider();
    const app = makeApp(cal);
    const res = await app.request("/v1/commit", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ plan_hash: "null-hash" }),
    }, env);

    expect(res.status).toBe(404);
    expect(cal.getCreated()).toEqual([]);
    expect(cal.getDeleted()).toEqual([]);
  });

  // ── Duplicate-mint guard (incident 2026-07-06) ──────────────────────────
  // Commit reconciles chunk events against the PLAN WINDOW only, so a chunk
  // whose live event sits in another week used to get a SECOND event created —
  // two calendar events sharing one scheduler_chunk_id, which then confused
  // the colour-based done/revive scans. A commit must instead MOVE the stray
  // event into the planned slot (and delete any extras), preserving the
  // one-event-per-chunk invariant.

  function strayEvent(id: string, chunkId: string, start: string, end: string, colorId?: string) {
    return {
      id,
      summary: "Deep work",
      start,
      end,
      colorId,
      extendedProperties: { private: { scheduler_chunk_id: chunkId } },
    } as any;
  }

  it("moves an out-of-window event with the same chunk id instead of creating a duplicate", async () => {
    // Stray event for task-deep-1#0 sits weeks BEFORE the plan window.
    const cal = new MockCalendarProvider({
      events: [strayEvent("e-stray", "task-deep-1#0", "2026-04-20T01:00:00Z", "2026-04-20T02:00:00Z", "5")],
    });
    const app = makeApp(cal);
    const res = await app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ plan_hash: "h1" }),
      },
      { ...env, CREATE_COLOR_ID: "5" },
    );
    expect(res.status).toBe(200);

    // No second event minted for the chunk…
    expect(cal.getCreated()).toHaveLength(0);
    // …the stray is relocated to the planned slot instead (a fresh placement,
    // painted the create colour so a stale done-paint can't linger on it).
    const moved = cal.getUpdated().find((u) => u.eventId === "e-stray");
    expect(moved).toBeDefined();
    expect(moved!.changes.start).toBe("2026-05-19T09:00:00Z");
    expect(moved!.changes.end).toBe("2026-05-19T10:30:00Z");
    expect(moved!.changes.summary).toBe("Deep work");
    expect(moved!.changes.colorId).toBe("5");
    expect(cal.getDeleted()).toEqual([]);
  });

  it("relocate repaint uses the provider's undoneColorId over createColorId when the provider defines one (Microsoft)", async () => {
    // Microsoft's undoneColorId is the empty-string category-clear sentinel
    // (?? not ||, since "" is a legitimate value — see handlers/tasks.ts).
    // Without this, a relocated chunk keeps painting the Google-style
    // createColorId, which for Microsoft means the done category is never cleared
    // and the next scan flips the relocated (open) task straight back to done.
    const cal = new MockCalendarProvider({
      events: [strayEvent("e-stray-ms", "task-deep-1#0", "2026-04-20T01:00:00Z", "2026-04-20T02:00:00Z", "Optical Done")],
    });
    (cal as any).undoneColorId = "";
    const app = makeApp(cal);
    const res = await app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ plan_hash: "h1" }),
      },
      { ...env, CREATE_COLOR_ID: "5" },
    );
    expect(res.status).toBe(200);

    const moved = cal.getUpdated().find((u) => u.eventId === "e-stray-ms");
    expect(moved).toBeDefined();
    expect(moved!.changes.colorId).toBe("");
  });

  it("relocate repaint falls back to createColorId when the provider has no undoneColorId (Google)", async () => {
    const cal = new MockCalendarProvider({
      events: [strayEvent("e-stray-google", "task-deep-1#0", "2026-04-20T01:00:00Z", "2026-04-20T02:00:00Z", "5")],
    });
    const app = makeApp(cal);
    const res = await app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ plan_hash: "h1" }),
      },
      { ...env, CREATE_COLOR_ID: "5" },
    );
    expect(res.status).toBe(200);

    const moved = cal.getUpdated().find((u) => u.eventId === "e-stray-google");
    expect(moved).toBeDefined();
    expect(moved!.changes.colorId).toBe("5");
  });

  it("keeps one event and deletes extras when several strays share the chunk id", async () => {
    const cal = new MockCalendarProvider({
      events: [
        strayEvent("e-stray-1", "task-deep-1#0", "2026-04-20T01:00:00Z", "2026-04-20T02:00:00Z", "5"),
        strayEvent("e-stray-2", "task-deep-1#0", "2026-06-03T01:00:00Z", "2026-06-03T02:00:00Z", "11"),
      ],
    });
    const app = makeApp(cal);
    const res = await app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ plan_hash: "h1" }),
      },
      { ...env, CREATE_COLOR_ID: "5" },
    );
    expect(res.status).toBe(200);

    expect(cal.getCreated()).toHaveLength(0);
    const moved = cal.getUpdated().find((u) => u.eventId === "e-stray-1");
    expect(moved).toBeDefined();
    expect(cal.getDeleted()).toEqual(["e-stray-2"]);
  });

  it("still creates the event when no event anywhere carries the chunk id", async () => {
    const cal = new MockCalendarProvider({
      events: [strayEvent("e-other", "other-task#0", "2026-04-20T01:00:00Z", "2026-04-20T02:00:00Z", "5")],
    });
    const app = makeApp(cal);
    const res = await app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ plan_hash: "h1" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(cal.getCreated()).toHaveLength(1);
    expect(cal.getUpdated().filter((u) => u.eventId === "e-other")).toHaveLength(0);
    expect(cal.getDeleted()).toEqual([]);
  });

  // ── Contract 2: fetchEventsInWindow({ syncToken: false }) passthrough ──
  // Both of commitPlan's fetchEventsInWindow calls discard nextSyncToken —
  // the plan-window read and the wide stray-scan read — so both must pass
  // { syncToken: false } through, letting Microsoft use a plain bounded
  // /me/calendarView read instead of issuing a delta token it will never be
  // resumed from at this call site.
  class SpyCalendarProvider extends MockCalendarProvider {
    fetchCalls: Array<{ start: string; end: string; opts: { syncToken?: boolean } | undefined }> = [];
    async fetchEventsInWindow(start: string, end: string, opts?: { syncToken?: boolean }) {
      this.fetchCalls.push({ start, end, opts });
      return super.fetchEventsInWindow(start, end);
    }
  }

  it("passes { syncToken: false } on the plan-window fetchEventsInWindow call", async () => {
    const cal = new SpyCalendarProvider();
    const app = makeApp(cal);
    const res = await app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ plan_hash: "h1" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(cal.fetchCalls[0]?.opts).toEqual({ syncToken: false });
  });

  it("passes { syncToken: false } on the wide stray-scan fetchEventsInWindow call", async () => {
    // No in-window event for the chunk, so commitPlan falls through to the
    // wide stray scan (missingChunkIds non-empty) — the second call site.
    const cal = new SpyCalendarProvider();
    const app = makeApp(cal);
    const res = await app.request(
      "/v1/commit",
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer fake" },
        body: JSON.stringify({ plan_hash: "h1" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(cal.fetchCalls).toHaveLength(2);
    expect(cal.fetchCalls[1]?.opts).toEqual({ syncToken: false });
  });
});
