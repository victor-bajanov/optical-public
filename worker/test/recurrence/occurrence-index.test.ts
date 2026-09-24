import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";

describe("occurrence_date UNIQUE index", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
  });

  it("rejects a duplicate (owner, template, occurrence_date) via INSERT OR IGNORE", async () => {
    const insert = (id: string) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO tasks (id, owner_subject, body, template_id, project_id, status, created_at, updated_at, occurrence_date)
         VALUES (?, 'owner-a', '{}', 'tpl-1', NULL, 'pending', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-06-15')`,
      ).bind(id);

    const first = await insert("task-1").run();
    const second = await insert("task-2").run();

    expect(first.meta.changes).toBe(1);
    expect(second.meta.changes).toBe(0); // ignored by the UNIQUE constraint

    const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM tasks").first<{ c: number }>();
    expect(count?.c).toBe(1);
  });

  it("allows multiple ad-hoc tasks (NULL occurrence_date) — NULLs are distinct", async () => {
    const insert = (id: string) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO tasks (id, owner_subject, body, template_id, project_id, status, created_at, updated_at, occurrence_date)
         VALUES (?, 'owner-a', '{}', NULL, NULL, 'pending', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL)`,
      ).bind(id);
    await insert("adhoc-1").run();
    await insert("adhoc-2").run();
    const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM tasks").first<{ c: number }>();
    expect(count?.c).toBe(2);
  });
});
