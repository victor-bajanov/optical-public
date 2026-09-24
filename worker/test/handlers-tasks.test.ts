import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { hashToken } from "../src/auth/tokens";
import { atomicTask, chunkedDeepTask } from "./fixtures/tasks";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "../src/env";
import type { CalendarProvider } from "../src/providers/calendar-provider";
import { tasksApp } from "../src/handlers/tasks";
import { MockCalendarProvider } from "../src/providers/mock-calendar-provider";
import { SCHEDULER_CHUNK_ID_KEY } from "../src/providers/types";

async function seed() {
  await env.DB.prepare("DELETE FROM oauth_tokens").run();
  await env.DB.prepare("DELETE FROM oauth_clients").run();
  await env.DB.prepare("DELETE FROM tasks").run();
  await env.DB.prepare(
    "INSERT INTO oauth_clients (id, name, type, redirect_uris, created_at) VALUES (?,?,?,?,?)",
  ).bind("c1", "test", "pkce", null, "2026-01-01T00:00:00Z").run();
  const h = await hashToken("tok", env.TOKEN_HASH_PEPPER);
  await env.DB.prepare(
    "INSERT INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?,?,?,?,?,?,?)",
  ).bind(h, "c1", "scheduler:read scheduler:write", "2099-01-01T00:00:00Z", null, null, "seed@org").run();
}

const authedHeaders = { Authorization: "Bearer tok", "Content-Type": "application/json" };

describe("POST/GET /v1/tasks", () => {
  beforeEach(async () => { await seed(); });

  it("rejects unauthenticated", async () => {
    const r = await SELF.fetch("https://x/v1/tasks", { method: "POST", body: JSON.stringify(atomicTask) });
    expect(r.status).toBe(401);
  });

  it("creates a task and returns 201 with id", async () => {
    const r = await SELF.fetch("https://x/v1/tasks", {
      method: "POST", headers: authedHeaders, body: JSON.stringify(atomicTask),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { id: string; title: string; status: string; created_at: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.title).toBe("Email triage");
    expect(body.status).toBe("pending");
    expect(body.created_at).toBeDefined();
  });

  it("validates body and 400s", async () => {
    const r = await SELF.fetch("https://x/v1/tasks", {
      method: "POST", headers: authedHeaders, body: JSON.stringify({ title: "x" }),
    });
    expect(r.status).toBe(400);
  });

  it("lists tasks", async () => {
    await SELF.fetch("https://x/v1/tasks", { method: "POST", headers: authedHeaders, body: JSON.stringify(atomicTask) });
    await SELF.fetch("https://x/v1/tasks", { method: "POST", headers: authedHeaders, body: JSON.stringify(chunkedDeepTask) });
    const r = await SELF.fetch("https://x/v1/tasks", { headers: { Authorization: "Bearer tok" } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { tasks: unknown[] };
    expect(body.tasks).toHaveLength(2);
  });

  it("filters by status", async () => {
    await SELF.fetch("https://x/v1/tasks", { method: "POST", headers: authedHeaders, body: JSON.stringify(atomicTask) });
    const r = await SELF.fetch("https://x/v1/tasks?status=done", { headers: { Authorization: "Bearer tok" } });
    const body = (await r.json()) as { tasks: unknown[] };
    expect(body.tasks).toHaveLength(0);
  });

  it("GET / and GET /:id surface the live column status, not the frozen body.status", async () => {
    // POST stores status in both the column and the body JSON. /v1/commit
    // only updates the column. The list / detail handlers used to return
    // the body verbatim and so reported stale status forever in the dev UI.
    const create = await SELF.fetch("https://x/v1/tasks", {
      method: "POST", headers: authedHeaders, body: JSON.stringify(atomicTask),
    });
    const t = (await create.json()) as { id: string };
    // Simulate /v1/commit: flip the column only, leave the body's status alone.
    await env.DB.prepare("UPDATE tasks SET status = 'committed' WHERE id = ?").bind(t.id).run();

    const list = await SELF.fetch("https://x/v1/tasks", { headers: { Authorization: "Bearer tok" } });
    const listBody = (await list.json()) as { tasks: Array<{ id: string; status: string }> };
    expect(listBody.tasks.find((x) => x.id === t.id)?.status).toBe("committed");

    const detail = await SELF.fetch(`https://x/v1/tasks/${t.id}`, { headers: { Authorization: "Bearer tok" } });
    const detailBody = (await detail.json()) as { status: string };
    expect(detailBody.status).toBe("committed");
  });

  it("GET / and GET /:id surface the live column updated_at, not the frozen body.updated_at", async () => {
    // Column-only writers (commit stamp, done-by-color flip, revive flip, the
    // manual-move re-stamp) touch the column updated_at but leave body.updated_at
    // alone. The handlers must surface the column value or the record looks
    // unmodified to API readers.
    const create = await SELF.fetch("https://x/v1/tasks", {
      method: "POST", headers: authedHeaders, body: JSON.stringify(atomicTask),
    });
    const t = (await create.json()) as { id: string; updated_at: string };
    const newer = "2099-12-31T23:59:59.000Z";
    // Simulate a column-only writer: bump the column, leave the body's stamp alone.
    await env.DB.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").bind(newer, t.id).run();

    const list = await SELF.fetch("https://x/v1/tasks", { headers: { Authorization: "Bearer tok" } });
    const listBody = (await list.json()) as { tasks: Array<{ id: string; updated_at: string }> };
    expect(listBody.tasks.find((x) => x.id === t.id)?.updated_at).toBe(newer);

    const detail = await SELF.fetch(`https://x/v1/tasks/${t.id}`, { headers: { Authorization: "Bearer tok" } });
    const detailBody = (await detail.json()) as { updated_at: string };
    expect(detailBody.updated_at).toBe(newer);
  });
});

describe("PATCH/DELETE /v1/tasks/:id", () => {
  beforeEach(async () => { await seed(); });

  async function createOne(): Promise<{ id: string; updated_at: string; priority: number }> {
    const r = await SELF.fetch("https://x/v1/tasks", {
      method: "POST", headers: authedHeaders, body: JSON.stringify(atomicTask),
    });
    return (await r.json()) as { id: string; updated_at: string; priority: number };
  }

  it("patches priority", async () => {
    const t = await createOne();
    const r = await SELF.fetch(`https://x/v1/tasks/${t.id}`, {
      method: "PATCH", headers: authedHeaders, body: JSON.stringify({ priority: 95 }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { priority: number; updated_at: string };
    expect(body.priority).toBe(95);
    expect(body.updated_at >= t.updated_at).toBe(true);
  });

  it("PATCH 404 on unknown id", async () => {
    const r = await SELF.fetch(`https://x/v1/tasks/11111111-1111-1111-1111-111111111111`, {
      method: "PATCH", headers: authedHeaders, body: JSON.stringify({ priority: 50 }),
    });
    expect(r.status).toBe(404);
  });

  it("PATCH 400 if merged body breaks invariant", async () => {
    const t = await createOne();
    // atomicTask has duration_minutes; injecting chunks without removing it violates the XOR.
    const r = await SELF.fetch(`https://x/v1/tasks/${t.id}`, {
      method: "PATCH", headers: authedHeaders,
      body: JSON.stringify({ chunks: [{ duration_minutes: 15 }, { duration_minutes: 15 }], group_policy: { same_day: true, ordered: false } }),
    });
    expect(r.status).toBe(400);
  });

  it("patches a task whose stored body carries a resolve-stamped movable_verdict", async () => {
    // The resolve stamps $.movable_verdict onto meeting task bodies. PATCH
    // re-parses the merged stored body with the STRICT create schema, so an
    // undeclared field would 400 every patch of a meeting task — and would be
    // silently dropped from the row if it validated non-strictly.
    const t = await createOne();
    const verdict = { at: "2026-07-25T00:00:00.000Z", ok: false, reason: "attendee_availability_unknown" };
    await env.DB.prepare(
      "UPDATE tasks SET body = json_set(body, '$.movable_verdict', json(?)) WHERE id = ?",
    ).bind(JSON.stringify(verdict), t.id).run();

    const r = await SELF.fetch(`https://x/v1/tasks/${t.id}`, {
      method: "PATCH", headers: authedHeaders, body: JSON.stringify({ priority: 95 }),
    });
    expect(r.status).toBe(200);

    const row = await env.DB.prepare("SELECT json_extract(body, '$.movable_verdict') AS v FROM tasks WHERE id = ?")
      .bind(t.id)
      .first<{ v: string | null }>();
    expect(JSON.parse(row!.v!)).toEqual(verdict);
  });

  it("deletes a task", async () => {
    const t = await createOne();
    const r = await SELF.fetch(`https://x/v1/tasks/${t.id}`, { method: "DELETE", headers: { Authorization: "Bearer tok" } });
    expect(r.status).toBe(204);
    const r2 = await SELF.fetch(`https://x/v1/tasks/${t.id}`, { headers: { Authorization: "Bearer tok" } });
    expect(r2.status).toBe(404);
  });
});

describe("PATCH /tasks/:id done-recolor", () => {
  // Mount tasksApp directly with injected ownerSubject + calendarProvider so we
  // can observe the recolor without a real Google call (SELF.fetch can't).
  function mount(cal: CalendarProvider) {
    const app = new OpenAPIHono<{ Bindings: Env; Variables: { ownerSubject: string; calendarProvider?: CalendarProvider } }>();
    app.use("*", async (c, next) => {
      c.set("ownerSubject", "seed@org");
      c.set("calendarProvider", cal);
      await next();
    });
    app.route("/", tasksApp);
    return app;
  }

  function bananaChunk() {
    return {
      id: "sched-rc",
      summary: "Deep work",
      start: "2026-05-19T09:00:00Z",
      end: "2026-05-19T10:00:00Z",
      colorId: "5",
      extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: "t-rc#0" } },
    };
  }

  async function seedTask(status: string) {
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB
      .prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .bind("t-rc", "seed@org", JSON.stringify({ ...atomicTask, id: "t-rc" }), status, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
      .run();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("recolors the task's chunks to the done color on a pending→done PATCH", async () => {
    await seedTask("pending");
    const cal = new MockCalendarProvider({ events: [bananaChunk()] });
    const res = await mount(cal).request(
      "/t-rc",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }) },
      { ...env, DONE_COLOR_ID: "11" },
    );
    expect(res.status).toBe(200);
    expect(cal.updated.map((u) => u.eventId)).toContain("sched-rc");
    expect(cal.updated.every((u) => u.changes.colorId === "11")).toBe(true);
  });

  it("restores the create color on a done→pending PATCH", async () => {
    await seedTask("done");
    // Event is already painted the done color (as it would be for a real done
    // task) so the recolor's already-that-color skip doesn't mask the assertion.
    const cal = new MockCalendarProvider({ events: [{ ...bananaChunk(), colorId: "11" }] });
    const res = await mount(cal).request(
      "/t-rc",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "pending" }) },
      { ...env, DONE_COLOR_ID: "11", CREATE_COLOR_ID: "5" },
    );
    expect(res.status).toBe(200);
    expect(cal.updated.map((u) => u.eventId)).toContain("sched-rc");
    expect(cal.updated.every((u) => u.changes.colorId === "5")).toBe(true);
  });

  it("uses the provider's undoneColorId on a done→pending PATCH when the provider defines one (Microsoft)", async () => {
    await seedTask("done");
    const cal = new MockCalendarProvider({ events: [{ ...bananaChunk(), colorId: "11" }] });
    (cal as any).undoneColorId = ""; // Microsoft: explicit category clear, not a Google numeric color
    const res = await mount(cal).request(
      "/t-rc",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "pending" }) },
      { ...env, DONE_COLOR_ID: "11", CREATE_COLOR_ID: "5" },
    );
    expect(res.status).toBe(200);
    expect(cal.updated.map((u) => u.eventId)).toContain("sched-rc");
    expect(cal.updated.every((u) => u.changes.colorId === "")).toBe(true);
  });

  it("uses the provider's defaultDoneColorId on a pending→done PATCH when users.done_color_id is unset (Microsoft)", async () => {
    await seedTask("pending");
    const cal = new MockCalendarProvider({ events: [bananaChunk()] });
    (cal as any).defaultDoneColorId = "Optical Done"; // Microsoft floor; no users.done_color_id row exists for seed@org
    const res = await mount(cal).request(
      "/t-rc",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }) },
      { ...env, DONE_COLOR_ID: "11" },
    );
    expect(res.status).toBe(200);
    expect(cal.updated.map((u) => u.eventId)).toContain("sched-rc");
    // Today (pre-fix) this resolves to env.DONE_COLOR_ID ("11"), which
    // toGraphPatch silently ignores — the provider's own default must win.
    expect(cal.updated.every((u) => u.changes.colorId === "Optical Done")).toBe(true);
  });

  it("does NOT recolor on an idempotent done→done PATCH", async () => {
    await seedTask("done");
    const cal = new MockCalendarProvider({ events: [bananaChunk()] });
    const res = await mount(cal).request(
      "/t-rc",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }) },
      { ...env, DONE_COLOR_ID: "11" },
    );
    expect(res.status).toBe(200);
    expect(cal.updated).toHaveLength(0);
  });
});

describe("DELETE /tasks/:id — scheduler-chunk cleanup (X1)", () => {
  function mount(cal: CalendarProvider) {
    const app = new OpenAPIHono<{ Bindings: Env; Variables: { ownerSubject: string; calendarProvider?: CalendarProvider } }>();
    app.use("*", async (c, next) => {
      c.set("ownerSubject", "seed@org");
      c.set("calendarProvider", cal);
      await next();
    });
    app.route("/", tasksApp);
    return app;
  }

  function chunkEvent(id: string, chunkId: string, start: string, end: string) {
    return {
      id,
      summary: "Deep work",
      start,
      end,
      colorId: "5",
      extendedProperties: { private: { [SCHEDULER_CHUNK_ID_KEY]: chunkId } },
    };
  }

  async function seedTask(id: string, status: string) {
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB
      .prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .bind(id, "seed@org", JSON.stringify({ ...atomicTask, id }), status, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
      .run();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("deletes the task's near-term and far-out chunks, leaving other tasks' chunks", async () => {
    await seedTask("t-del", "committed");
    const near = chunkEvent("evt-near", "t-del#0", "2026-05-19T09:00:00Z", "2026-05-19T10:00:00Z");
    // ~60 days out: beyond recolor's 28-day window, within the 366-day horizon.
    const far = chunkEvent("evt-far", "t-del#1", "2026-07-18T09:00:00Z", "2026-07-18T10:00:00Z");
    const other = chunkEvent("evt-other", "t-keep#0", "2026-05-20T09:00:00Z", "2026-05-20T10:00:00Z");
    const cal = new MockCalendarProvider({ events: [near, far, other] });

    const res = await mount(cal).request(
      "/t-del",
      { method: "DELETE", headers: { Authorization: "Bearer tok" } },
      env,
    );

    expect(res.status).toBe(204);
    expect(cal.getDeleted().sort()).toEqual(["evt-far", "evt-near"]);
    const row = await env.DB.prepare("SELECT id FROM tasks WHERE id = 't-del'").first();
    expect(row).toBeNull();
  });

  it("still 204s and deletes the row when the calendar delete throws (best-effort)", async () => {
    await seedTask("t-del", "committed");
    const cal = new MockCalendarProvider({ events: [chunkEvent("evt-near", "t-del#0", "2026-05-19T09:00:00Z", "2026-05-19T10:00:00Z")] });
    cal.deleteEvent = async () => { throw new Error("Google 500"); };

    const res = await mount(cal).request(
      "/t-del",
      { method: "DELETE", headers: { Authorization: "Bearer tok" } },
      env,
    );

    expect(res.status).toBe(204);
    const row = await env.DB.prepare("SELECT id FROM tasks WHERE id = 't-del'").first();
    expect(row).toBeNull();
  });
});

describe("PATCH /tasks/:id — no-clobber + atomicity (X7)", () => {
  function mount(cal: CalendarProvider) {
    const app = new OpenAPIHono<{ Bindings: Env; Variables: { ownerSubject: string; calendarProvider?: CalendarProvider } }>();
    app.use("*", async (c, next) => {
      c.set("ownerSubject", "seed@org");
      c.set("calendarProvider", cal);
      await next();
    });
    app.route("/", tasksApp);
    return app;
  }

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare("DELETE FROM chunk_completions").run();
  });

  it("does not revert a concurrent status flip when the patch omits status", async () => {
    // Column = 'committed' (a commit landed), but the body JSON still says 'pending'
    // (column is authoritative since D3). A PATCH of a non-status field must NOT
    // re-derive status from the stale body and clobber the column back to pending.
    await env.DB.prepare(
      "INSERT INTO tasks (id, owner_subject, body, status, scheduled_for, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    ).bind("t-nc", "seed@org", JSON.stringify({ ...atomicTask, id: "t-nc", status: "pending" }), "committed", "2026-05-19T09:00:00.000Z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z").run();

    const res = await mount(new MockCalendarProvider()).request(
      "/t-nc",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ priority: 95 }) },
      { ...env },
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id='t-nc'").first<{ status: string }>();
    expect(row!.status).toBe("committed");
  });

  it("a timing PATCH clears scheduled_for and leaves status='committed' (backlog-eligible)", async () => {
    await env.DB.prepare(
      "INSERT INTO tasks (id, owner_subject, body, status, scheduled_for, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    ).bind("t-tm", "seed@org", JSON.stringify({ ...atomicTask, id: "t-tm" }), "committed", "2026-05-19T09:00:00.000Z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z").run();

    const res = await mount(new MockCalendarProvider()).request(
      "/t-tm",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ earliest_start: "2026-05-26T09:00:00.000Z" }) },
      { ...env },
    );
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT status, scheduled_for FROM tasks WHERE id='t-tm'")
      .first<{ status: string; scheduled_for: string | null }>();
    expect(row!.status).toBe("committed");   // status column untouched…
    expect(row!.scheduled_for).toBeNull();   // …but the stale stamp is cleared
  });

  it("rolls the task UPDATE back when a completion insert in the same batch fails", async () => {
    // pending→done writes the task UPDATE AND one completion row per chunk in one
    // db.batch. Poison the completion INSERT; the task UPDATE must roll back too.
    await env.DB.prepare(
      "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).bind("t-atom", "seed@org", JSON.stringify({ ...chunkedDeepTask, id: "t-atom" }), "pending", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z").run();

    const poisoned = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) =>
            /INSERT OR IGNORE INTO chunk_completions/.test(sql)
              ? target.prepare("INSERT INTO no_such_table (a) VALUES (?)")
              : target.prepare(sql);
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as typeof env.DB;

    await Promise.resolve(
      mount(new MockCalendarProvider()).request(
        "/t-atom",
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }) },
        { ...env, DB: poisoned },
      ),
    ).catch(() => undefined);

    // Atomic: status stayed 'pending', no completion rows persisted.
    const row = await env.DB.prepare("SELECT status FROM tasks WHERE id='t-atom'").first<{ status: string }>();
    expect(row!.status).toBe("pending");
    const comp = await env.DB.prepare("SELECT COUNT(*) AS n FROM chunk_completions WHERE task_id='t-atom'").first<{ n: number }>();
    expect(comp!.n).toBe(0);
  });
});

describe("PATCH /v1/tasks/:id — scheduled_for invalidation", () => {
  beforeEach(async () => { await seed(); });

  async function createStampedTask(): Promise<string> {
    const create = await SELF.fetch("https://x/v1/tasks", {
      method: "POST", headers: authedHeaders, body: JSON.stringify(atomicTask),
    });
    const t = (await create.json()) as { id: string };
    await env.DB.prepare("UPDATE tasks SET status = 'committed', scheduled_for = '2026-06-09T09:00:00Z' WHERE id = ?")
      .bind(t.id).run();
    return t.id;
  }

  async function stampOf(id: string): Promise<string | null> {
    const row = await env.DB.prepare("SELECT scheduled_for FROM tasks WHERE id = ?")
      .bind(id).first<{ scheduled_for: string | null }>();
    return row?.scheduled_for ?? null;
  }

  it("clears the stamp when earliest_start is patched", async () => {
    const id = await createStampedTask();
    const r = await SELF.fetch(`https://x/v1/tasks/${id}`, {
      method: "PATCH", headers: authedHeaders,
      body: JSON.stringify({ earliest_start: "2026-06-15T00:00:00Z" }),
    });
    expect(r.status).toBe(200);
    expect(await stampOf(id)).toBeNull();
  });

  it("clears the stamp when pinned_at is explicitly set to null", async () => {
    const id = await createStampedTask();
    const r = await SELF.fetch(`https://x/v1/tasks/${id}`, {
      method: "PATCH", headers: authedHeaders,
      body: JSON.stringify({ pinned_at: null }),
    });
    expect(r.status).toBe(200);
    expect(await stampOf(id)).toBeNull();
  });

  it("clears the stamp when preferred_windows or deadline is patched", async () => {
    const id1 = await createStampedTask();
    await SELF.fetch(`https://x/v1/tasks/${id1}`, {
      method: "PATCH", headers: authedHeaders,
      body: JSON.stringify({ preferred_windows: [] }),
    });
    expect(await stampOf(id1)).toBeNull();

    const id2 = await createStampedTask();
    await SELF.fetch(`https://x/v1/tasks/${id2}`, {
      method: "PATCH", headers: authedHeaders,
      body: JSON.stringify({ deadline: { at: "2026-06-19T17:00", hard: false, penalty_per_15min: 30 } }),
    });
    expect(await stampOf(id2)).toBeNull();
  });

  it("preserves the stamp on a non-timing patch (title only)", async () => {
    const id = await createStampedTask();
    const r = await SELF.fetch(`https://x/v1/tasks/${id}`, {
      method: "PATCH", headers: authedHeaders,
      body: JSON.stringify({ title: "Renamed" }),
    });
    expect(r.status).toBe(200);
    expect(await stampOf(id)).toBe("2026-06-09T09:00:00Z");
  });

  it("preserves the stamp when marking a task done", async () => {
    const id = await createStampedTask();
    const r = await SELF.fetch(`https://x/v1/tasks/${id}`, {
      method: "PATCH", headers: authedHeaders,
      body: JSON.stringify({ status: "done" }),
    });
    expect(r.status).toBe(200);
    expect(await stampOf(id)).toBe("2026-06-09T09:00:00Z");
  });
});
