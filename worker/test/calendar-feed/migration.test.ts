import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import migration0029 from "../../migrations/0029_calendar_feed_multi.sql?raw";

/** Extracts only the UPDATE statements from the migration file's raw SQL, so the
 *  backfill test exercises the real file's backfill lines rather than a copy. */
function backfillStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.toUpperCase().startsWith("UPDATE"));
}

describe("0020_calendar_feed_tokens", () => {
  it("creates the table with the expected columns", async () => {
    const r = await env.DB.prepare("PRAGMA table_info(calendar_feed_tokens)").all<{ name: string }>();
    const cols = (r.results ?? []).map((c) => c.name).sort();
    expect(cols).toEqual(
      ["created_at", "id", "label", "last_used_at", "owner_subject", "reveal_rules", "revoked_at", "token_hash"].sort(),
    );
  });

  it("enforces a unique token_hash", async () => {
    await env.DB.prepare(
      "INSERT INTO calendar_feed_tokens (id, owner_subject, token_hash, created_at) VALUES (?,?,?,?)",
    ).bind("id-a", "u@org", "dup-hash", "2026-01-01T00:00:00Z").run();
    await expect(
      env.DB.prepare(
        "INSERT INTO calendar_feed_tokens (id, owner_subject, token_hash, created_at) VALUES (?,?,?,?)",
      ).bind("id-b", "u@org", "dup-hash", "2026-01-01T00:00:00Z").run(),
    ).rejects.toThrow();
  });
});

describe("migration 0029", () => {
  it("backfills label and reveal_rules on pre-existing rows", async () => {
    // Simulate a v1 row (label/reveal_rules NULL is no longer possible post-
    // migration for NEW rows, but old rows must have been backfilled). Migrations
    // run once in beforeAll against an empty table, so we insert a pre-0029-style
    // row here and then re-run the migration file's actual UPDATE statements
    // against it, to genuinely exercise the backfill rather than assert on an
    // already-empty table.
    await env.DB.prepare(
      "INSERT INTO calendar_feed_tokens (id, owner_subject, token_hash, created_at) VALUES (?,?,?,?)",
    ).bind("v1-row", "legacy@org", "legacy-hash", "2026-01-01T00:00:00Z").run();

    const statements = backfillStatements(migration0029);
    expect(statements.length).toBeGreaterThan(0);
    for (const stmt of statements) {
      await env.DB.prepare(stmt).run();
    }

    const row = await env.DB.prepare(
      "SELECT label, reveal_rules FROM calendar_feed_tokens WHERE id = 'v1-row'",
    ).first<{ label: string; reveal_rules: string }>();
    expect(row?.label).toBe("default");
    expect(row?.reveal_rules).toBe("[]");

    const r = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM calendar_feed_tokens WHERE label IS NULL OR reveal_rules IS NULL",
    ).first<{ n: number }>();
    expect(r!.n).toBe(0);
  });

  it("enforces unique (owner_subject, label) among ACTIVE rows only", async () => {
    await env.DB.prepare("DELETE FROM calendar_feed_tokens").run();
    const ins = (id: string, revoked: string | null) =>
      env.DB.prepare(
        "INSERT INTO calendar_feed_tokens (id, owner_subject, token_hash, label, reveal_rules, created_at, revoked_at) VALUES (?,?,?,?,?,?,?)",
      ).bind(id, "o1", `h-${id}`, "client-a", "[]", "2026-01-01T00:00:00Z", revoked).run();
    await ins("a", null);
    await ins("b", "2026-01-02T00:00:00Z"); // revoked duplicate label: OK
    await expect(ins("c", null)).rejects.toThrow(); // active duplicate: UNIQUE violation
  });

  it("has the calendar_feed_reveals table with a UNIQUE reveal_token_hash", async () => {
    await env.DB.prepare(
      "INSERT INTO calendar_feed_reveals (id, feed_id, owner_subject, reveal_token_hash, secret_ciphertext, created_at, expires_at) VALUES ('r1','f1','o1','th1',NULL,'2026-01-01T00:00:00Z','2026-01-01T01:00:00Z')",
    ).run();
    await expect(
      env.DB.prepare(
        "INSERT INTO calendar_feed_reveals (id, feed_id, owner_subject, reveal_token_hash, secret_ciphertext, created_at, expires_at) VALUES ('r2','f2','o1','th1',NULL,'2026-01-01T00:00:00Z','2026-01-01T01:00:00Z')",
      ).run(),
    ).rejects.toThrow();
  });
});
