import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { mountScheduleRoute } from "../../src/planning/schedule";
import type { AppVariables } from "../../src/index-providers";
import { hashToken } from "../../src/auth/tokens";

async function seedBearer(token: string, subject: string) {
  const hashed = await hashToken(token, env.TOKEN_HASH_PEPPER);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?, 'test-client', 'scheduler.write', NULL, NULL, NULL, ?)",
  )
    .bind(hashed, subject)
    .run();
}

async function seedTask(id: string, owner: string, context = "deep") {
  await env.DB.prepare(
    "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(id, owner, JSON.stringify({ title: `t-${id}`, context }), "committed", "2026-05-01T00:00:00Z", "2026-05-01T00:00:00Z")
    .run();
}

async function seedCommitted(subject: string, body: unknown, hash = "h-1") {
  await env.DB.prepare(
    "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES (?, ?, '2026-05-11T00:00:00Z', '2026-05-12T00:00:00Z', '2026-05-11T01:00:00Z', ?)",
  )
    .bind(hash, JSON.stringify(body), subject)
    .run();
}

function entry(taskId: string, n: number, context = "deep") {
  return {
    task_id: taskId,
    chunk_id: `${taskId}#${n}`,
    start: `2026-05-12T0${n + 1}:00:00Z`,
    end: `2026-05-12T0${n + 2}:00:00Z`,
    context,
  };
}

function makeApp() {
  const v1 = new OpenAPIHono<{ Bindings: typeof env; Variables: AppVariables }>();
  mountScheduleRoute(v1);
  const app = new Hono<{ Bindings: typeof env; Variables: AppVariables }>();
  app.route("/v1", v1);
  return app;
}

describe("GET /v1/schedule", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposed_plans").run();
    await env.DB.prepare("DELETE FROM oauth_tokens").run();
    await env.DB.prepare("DELETE FROM tasks").run();
    await seedBearer("fake", "me@x");
  });

  it("returns 404 when no committed plan exists", async () => {
    const res = await makeApp().request(
      "/v1/schedule",
      { headers: { Authorization: "Bearer fake" } },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("returns the most recently committed plan body", async () => {
    const body1 = {
      schedule: [
        {
          task_id: "old",
          chunk_id: "old#0",
          start: "2026-05-12T09:00:00Z",
          end: "2026-05-12T10:00:00Z",
          context: "deep",
        },
      ],
      dropped: [],
      window: { start: "2026-05-11T00:00:00Z", end: "2026-05-18T00:00:00Z" },
    };
    const body2 = {
      schedule: [
        {
          task_id: "new",
          chunk_id: "new#0",
          start: "2026-05-19T09:00:00Z",
          end: "2026-05-19T10:00:00Z",
          context: "deep",
        },
      ],
      dropped: [],
      window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
    };
    await env.DB
      .prepare(
        "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('h-old', ?, '2026-05-11T00:00:00Z', '2026-05-12T00:00:00Z', '2026-05-11T01:00:00Z', 'me@x')",
      )
      .bind(JSON.stringify(body1))
      .run();
    await env.DB
      .prepare(
        "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('h-new', ?, '2026-05-18T00:00:00Z', '2026-05-19T00:00:00Z', '2026-05-18T01:00:00Z', 'me@x')",
      )
      .bind(JSON.stringify(body2))
      .run();
    await seedTask("new", "me@x");

    const res = await makeApp().request(
      "/v1/schedule",
      { headers: { Authorization: "Bearer fake" } },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { schedule: Array<{ task_id: string }> };
    expect(json.schedule[0]!.task_id).toBe("new");
  });

  it("does NOT return another tenant's committed plan", async () => {
    const theirs = {
      schedule: [{ task_id: "theirs", chunk_id: "theirs#0", start: "2026-05-26T09:00:00Z", end: "2026-05-26T10:00:00Z", context: "deep" }],
      dropped: [],
      window: { start: "2026-05-25T00:00:00Z", end: "2026-06-01T00:00:00Z" },
    };
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('h-theirs', ?, '2026-05-25T00:00:00Z', '2026-05-26T00:00:00Z', '2026-05-25T01:00:00Z', 'other@y')",
    ).bind(JSON.stringify(theirs)).run();
    const res = await makeApp().request("/v1/schedule", { headers: { Authorization: "Bearer fake" } }, env);
    expect(res.status).toBe(404);
  });

  it("403s a subject-less token", async () => {
    await seedBearer("nosub-token", "");
    await env.DB.prepare("UPDATE oauth_tokens SET subject = NULL WHERE client_id = 'test-client' AND hashed_token = ?")
      .bind(await hashToken("nosub-token", env.TOKEN_HASH_PEPPER)).run();
    const res = await makeApp().request("/v1/schedule", { headers: { Authorization: "Bearer nosub-token" } }, env);
    expect(res.status).toBe(403);
  });

  it("never returns body.warnings (third-party event titles) from the committed plan", async () => {
    await seedCommitted("me@x", {
      schedule: [],
      dropped: [],
      window: { start: "2026-05-11T00:00:00Z", end: "2026-05-18T00:00:00Z" },
      warnings: ["Alice's 1:1: attendee_availability_unknown"],
    });
    const res = await makeApp().request("/v1/schedule", { headers: { Authorization: "Bearer fake" } }, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect("warnings" in json).toBe(false);
    expect(json.window).toEqual({ start: "2026-05-11T00:00:00Z", end: "2026-05-18T00:00:00Z" });
  });

  describe("omits entries for tasks that no longer exist", () => {
    const live = "11111111-1111-4111-8111-111111111111";
    const gone = "22222222-2222-4222-8222-222222222222";
    const meetingLive = "33333333-3333-4333-8333-333333333333";
    const meetingGone = "44444444-4444-4444-8444-444444444444";
    const window = { start: "2026-05-11T00:00:00Z", end: "2026-05-18T00:00:00Z" };

    async function getSchedule() {
      const res = await makeApp().request("/v1/schedule", { headers: { Authorization: "Bearer fake" } }, env);
      expect(res.status).toBe(200);
      return (await res.json()) as {
        schedule: Array<{ task_id: string; chunk_id: string }>;
        dropped: Array<{ task_id: string }>;
        window: { start: string; end: string };
      };
    }

    it("drops a deleted task's blocks and keeps an existing task's", async () => {
      await seedTask(live, "me@x");
      await seedCommitted("me@x", {
        schedule: [entry(live, 0), entry(gone, 1), entry(live, 2), entry(gone, 3)],
        dropped: [],
        window,
      });
      const json = await getSchedule();
      expect(json.schedule.map((e) => e.chunk_id)).toEqual([`${live}#0`, `${live}#2`]);
      expect(json.window).toEqual(window);
    });

    it("a same-id task owned by another subject does not keep the entry alive", async () => {
      await seedTask(gone, "other@y");
      await seedCommitted("me@x", { schedule: [entry(gone, 0)], dropped: [], window });
      const json = await getSchedule();
      expect(json.schedule).toEqual([]);
    });

    it("applies the same rule to owned-meeting (context meeting) entries", async () => {
      await seedTask(meetingLive, "me@x", "meeting");
      await seedCommitted("me@x", {
        schedule: [entry(meetingLive, 0, "meeting"), entry(meetingGone, 1, "meeting")],
        dropped: [],
        window,
      });
      const json = await getSchedule();
      expect(json.schedule.map((e) => e.task_id)).toEqual([meetingLive]);
    });

    it("handles more task ids than one D1 statement can bind", async () => {
      const ids = Array.from({ length: 150 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
      for (const id of ids.slice(0, 140)) await seedTask(id, "me@x");
      await seedCommitted("me@x", { schedule: ids.map((id) => entry(id, 0)), dropped: [], window });
      const json = await getSchedule();
      expect(json.schedule.map((e) => e.task_id)).toEqual(ids.slice(0, 140));
    });

    it("drops a deleted task from the dropped list too", async () => {
      await seedTask(live, "me@x");
      const d = (id: string) => ({ task_id: id, title: "t", drop_cost: 1, reason: "r", contributing_constraints: [] });
      await seedCommitted("me@x", { schedule: [], dropped: [d(live), d(gone)], window });
      const json = await getSchedule();
      expect(json.dropped.map((e) => e.task_id)).toEqual([live]);
    });
  });
});
