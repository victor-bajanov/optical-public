import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("0015 users migration", () => {
  it("creates a users table with the expected columns", async () => {
    const cols = await env.DB.prepare("PRAGMA table_info(users)").all<{ name: string; pk: number }>();
    const names = cols.results.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["subject", "role", "is_active", "last_seen", "created_at"]),
    );
    const pk = cols.results.find((c) => c.name === "subject");
    expect(pk?.pk).toBe(1);
  });

  it("defaults role to 'member' and is_active to 1", async () => {
    await env.DB.prepare("DELETE FROM users").run();
    await env.DB.prepare(
      "INSERT INTO users (subject, created_at) VALUES (?, ?)",
    ).bind("d@org", "2026-01-01T00:00:00Z").run();
    const row = await env.DB.prepare("SELECT role, is_active FROM users WHERE subject = ?")
      .bind("d@org").first<{ role: string; is_active: number }>();
    expect(row).toEqual({ role: "member", is_active: 1 });
  });
});
