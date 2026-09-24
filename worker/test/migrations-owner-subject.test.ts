// worker/test/migrations-owner-subject.test.ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("0013 owner_subject migration", () => {
  it("adds an owner_subject column to tasks, task_templates and projects", async () => {
    for (const table of ["tasks", "task_templates", "projects"]) {
      const cols = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      const names = cols.results.map((c) => c.name);
      expect(names, `${table} should have owner_subject`).toContain("owner_subject");
    }
  });

  it("can filter tasks by owner_subject", async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare(
      "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).bind("t1", "a@org", "{}", "pending", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z").run();
    const r = await env.DB.prepare("SELECT id FROM tasks WHERE owner_subject = ?").bind("a@org").all();
    expect(r.results).toHaveLength(1);
  });
});
