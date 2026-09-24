import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyManualMoveStmt, patchTaskRowStmt } from "../../src/db/d1";

async function readTask() {
  return env.DB.prepare("SELECT scheduled_for, updated_at, body FROM tasks WHERE id = 't1'")
    .first<{ scheduled_for: string | null; updated_at: string; body: string }>();
}

async function seedTask(status: string) {
  await env.DB.prepare("DELETE FROM tasks").run();
  await env.DB.prepare(
    "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at, scheduled_for) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      "t1", "primary",
      JSON.stringify({ id: "t1", title: "Deep work", earliest_start: "2026-05-19T09:00:00.000Z" }),
      status, "2026-05-17T00:00:00Z", "2026-05-17T00:00:00Z", "2026-05-19T09:00:00.000Z",
    )
    .run();
}

describe("applyManualMoveStmt", () => {
  beforeEach(() => seedTask("committed"));

  it("writes scheduled_for, updated_at, and body together for a live task", async () => {
    const nextBody = { id: "t1", title: "Deep work", earliest_start: "2026-05-19T13:00:00.000Z" };
    await applyManualMoveStmt(env.DB, "primary", "t1", "2026-05-19T13:00:00.000Z", nextBody, "2026-05-20T00:00:00.000Z").run();
    const row = await readTask();
    expect(row?.scheduled_for ?? null).toBe("2026-05-19T13:00:00.000Z");
    expect(row?.updated_at).toBe("2026-05-20T00:00:00.000Z");
    expect(JSON.parse(row!.body).earliest_start).toBe("2026-05-19T13:00:00.000Z");
  });

  it("is a no-op for a done task (status guard)", async () => {
    await seedTask("done");
    const res = await applyManualMoveStmt(env.DB, "primary", "t1", "2026-05-19T13:00:00.000Z", { id: "t1" }, "2026-05-20T00:00:00.000Z").run();
    expect(res.meta?.changes ?? 0).toBe(0);
    const row = await readTask();
    expect(row?.scheduled_for ?? null).toBe("2026-05-19T09:00:00.000Z"); // untouched
  });
});

describe("patchTaskRowStmt", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare(
      "INSERT INTO tasks (id, owner_subject, body, template_id, project_id, status, scheduled_for, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).bind("t1", "o@org", JSON.stringify({ id: "t1", title: "old" }), null, "p-old", "committed", "2026-05-19T09:00:00.000Z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z").run();
  });

  it("writes body + updated_at but leaves status untouched when status is not supplied", async () => {
    await patchTaskRowStmt(env.DB, "o@org", "t1", {
      body: { id: "t1", title: "new" },
      updatedAt: "2026-06-20T00:00:00Z",
    }).run();
    const row = await env.DB.prepare("SELECT body, status, scheduled_for, updated_at FROM tasks WHERE id='t1'")
      .first<{ body: string; status: string; scheduled_for: string | null; updated_at: string }>();
    expect(JSON.parse(row!.body).title).toBe("new");
    expect(row!.status).toBe("committed");                 // NOT clobbered
    expect(row!.scheduled_for).toBe("2026-05-19T09:00:00.000Z"); // untouched
    expect(row!.updated_at).toBe("2026-06-20T00:00:00Z");
  });

  it("writes status only when supplied, and clears scheduled_for when requested", async () => {
    await patchTaskRowStmt(env.DB, "o@org", "t1", {
      body: { id: "t1", title: "new" },
      updatedAt: "2026-06-20T00:00:00Z",
      status: "done",
      clearScheduledFor: true,
    }).run();
    const row = await env.DB.prepare("SELECT status, scheduled_for FROM tasks WHERE id='t1'")
      .first<{ status: string; scheduled_for: string | null }>();
    expect(row!.status).toBe("done");
    expect(row!.scheduled_for).toBeNull();
  });

  it("is owner-scoped: a non-owner update changes nothing", async () => {
    const res = await patchTaskRowStmt(env.DB, "other@org", "t1", {
      body: { id: "t1", title: "hacked" },
      updatedAt: "2026-06-20T00:00:00Z",
    }).run();
    expect(res.meta.changes).toBe(0);
    const row = await env.DB.prepare("SELECT body FROM tasks WHERE id='t1'").first<{ body: string }>();
    expect(JSON.parse(row!.body).title).toBe("old");
  });
});
