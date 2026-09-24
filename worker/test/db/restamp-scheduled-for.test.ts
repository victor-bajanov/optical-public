import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { restampScheduledFor } from "../../src/db/d1";

const body = JSON.stringify({ title: "T", context: "admin", priority: 40, duration_minutes: 30 });

async function seedTask(id: string, owner: string, status: string) {
  await env.DB.prepare(
    "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at, scheduled_for) VALUES (?, ?, ?, ?, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', '2026-06-09T09:00:00Z')",
  ).bind(id, owner, body, status).run();
}

async function rowOf(id: string) {
  return env.DB.prepare("SELECT scheduled_for, updated_at, status FROM tasks WHERE id = ?")
    .bind(id)
    .first<{ scheduled_for: string | null; updated_at: string; status: string }>();
}

describe("restampScheduledFor", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
  });

  it("updates scheduled_for and updated_at for the owner's live task", async () => {
    await seedTask("t1", "primary", "committed");
    await restampScheduledFor(env.DB, "primary", "t1", "2026-06-10T13:00:00.000Z", "2026-06-10T05:00:00.000Z");
    const row = await rowOf("t1");
    expect(row?.scheduled_for).toBe("2026-06-10T13:00:00.000Z");
    expect(row?.updated_at).toBe("2026-06-10T05:00:00.000Z");
  });

  it("does not touch a task owned by someone else", async () => {
    await seedTask("t1", "other", "committed");
    await restampScheduledFor(env.DB, "primary", "t1", "2026-06-10T13:00:00.000Z", "2026-06-10T05:00:00.000Z");
    const row = await rowOf("t1");
    expect(row?.scheduled_for).toBe("2026-06-09T09:00:00Z");
    expect(row?.updated_at).toBe("2026-06-01T00:00:00Z");
  });

  it("does not touch a done task", async () => {
    await seedTask("t1", "primary", "done");
    await restampScheduledFor(env.DB, "primary", "t1", "2026-06-10T13:00:00.000Z", "2026-06-10T05:00:00.000Z");
    const row = await rowOf("t1");
    expect(row?.scheduled_for).toBe("2026-06-09T09:00:00Z");
    expect(row?.status).toBe("done");
  });

  it("fails closed on an empty owner", async () => {
    await seedTask("t1", "primary", "committed");
    await expect(
      restampScheduledFor(env.DB, "", "t1", "2026-06-10T13:00:00.000Z", "2026-06-10T05:00:00.000Z"),
    ).rejects.toThrow("owner_scope_missing");
  });
});
