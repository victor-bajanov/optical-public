import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

// Hosted-trial O10b: 0041 adds users.retention_warned_at, the stamp the
// retention sweep sets when it sends (or, with system mail off, skips) the
// deletion warning. Nullable: NULL means "not warned since last activity".
describe("0041 users.retention_warned_at migration", () => {
  it("adds a nullable TEXT column with no default", async () => {
    const cols = await env.DB.prepare("PRAGMA table_info(users)")
      .all<{ name: string; type: string; notnull: number; dflt_value: unknown }>();
    const col = cols.results.find((c) => c.name === "retention_warned_at");
    expect(col).toBeDefined();
    expect(col).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });
  });

  it("existing-style inserts leave it NULL", async () => {
    await env.DB.prepare("DELETE FROM users").run();
    await env.DB.prepare("INSERT INTO users (subject, created_at) VALUES (?, ?)")
      .bind("n@org", "2026-01-01T00:00:00Z").run();
    const row = await env.DB.prepare("SELECT retention_warned_at FROM users WHERE subject = ?")
      .bind("n@org").first<{ retention_warned_at: string | null }>();
    expect(row).toEqual({ retention_warned_at: null });
  });
});
