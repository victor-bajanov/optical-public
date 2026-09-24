import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("0016 audit_log migration", () => {
  it("creates an audit_log table with the expected columns", async () => {
    const cols = await env.DB.prepare("PRAGMA table_info(audit_log)").all<{ name: string; pk: number }>();
    const names = cols.results.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["id", "subject", "actor", "action", "table_name", "source", "created_at"]),
    );
    expect(cols.results.find((c) => c.name === "id")?.pk).toBe(1);
  });

  it("accepts an insert", async () => {
    await env.DB.prepare("DELETE FROM audit_log").run();
    await env.DB.prepare(
      "INSERT INTO audit_log (id, subject, actor, action, table_name, source, created_at) VALUES (?,?,?,?,?,?,?)",
    ).bind("a1", "u@org", "admin@org", "offboard", null, "admin", "2026-01-01T00:00:00Z").run();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});
