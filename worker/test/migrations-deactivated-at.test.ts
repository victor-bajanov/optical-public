import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

// Hosted-trial decision F: 0043 adds users.deactivated_at, stamped by
// deactivateUser (offboard) and cleared on reactivation. The purge window
// (DELETED_ACCOUNT_RETENTION_DAYS) counts from it. Nullable, no default:
// rows deactivated before 0043 stay NULL until the first purge-enabled sweep
// stamps them.
describe("0043 users.deactivated_at migration", () => {
  it("adds a nullable TEXT column with no default", async () => {
    const cols = await env.DB.prepare("PRAGMA table_info(users)")
      .all<{ name: string; type: string; notnull: number; dflt_value: unknown }>();
    const col = cols.results.find((c) => c.name === "deactivated_at");
    expect(col).toBeDefined();
    expect(col).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });
  });

  it("existing-style inserts leave it NULL", async () => {
    await env.DB.prepare("DELETE FROM users").run();
    await env.DB.prepare("INSERT INTO users (subject, is_active, created_at) VALUES (?, 0, ?)")
      .bind("n@org", "2026-01-01T00:00:00Z").run();
    const row = await env.DB.prepare("SELECT deactivated_at FROM users WHERE subject = ?")
      .bind("n@org").first<{ deactivated_at: string | null }>();
    expect(row).toEqual({ deactivated_at: null });
  });
});
