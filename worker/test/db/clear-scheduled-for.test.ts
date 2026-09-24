import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { clearScheduledFor } from "../../src/db/d1";

const body = JSON.stringify({ title: "T", context: "admin", priority: 40, duration_minutes: 30 });

async function seedTask(id: string, owner: string) {
  await env.DB.prepare(
    "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at, scheduled_for) VALUES (?, ?, ?, 'committed', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z', '2026-06-09T09:00:00Z')",
  ).bind(id, owner, body).run();
}

async function stampOf(id: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT scheduled_for FROM tasks WHERE id = ?")
    .bind(id)
    .first<{ scheduled_for: string | null }>();
  return row?.scheduled_for ?? null;
}

describe("clearScheduledFor", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
  });

  it("nulls the scheduled_for column for the owner's task", async () => {
    await seedTask("t1", "primary");
    await clearScheduledFor(env.DB, "primary", "t1");
    expect(await stampOf("t1")).toBeNull();
  });

  it("does not clear a task owned by someone else", async () => {
    await seedTask("t1", "other");
    await clearScheduledFor(env.DB, "primary", "t1");
    expect(await stampOf("t1")).toBe("2026-06-09T09:00:00Z");
  });

  it("fails closed on an empty owner", async () => {
    await seedTask("t1", "primary");
    await expect(clearScheduledFor(env.DB, "", "t1")).rejects.toThrow("owner_scope_missing");
  });
});
