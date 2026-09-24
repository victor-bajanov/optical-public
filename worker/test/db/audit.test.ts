import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { writeAudit } from "../../src/db/audit";

beforeEach(async () => { await env.DB.prepare("DELETE FROM audit_log").run(); });

describe("writeAudit", () => {
  it("inserts a row with a generated id and created_at", async () => {
    const now = "2026-01-02T03:04:05.000Z";
    await writeAudit(env.DB, { subject: "u@org", actor: "admin@org", action: "offboard", source: "admin" }, now);
    const row = await env.DB.prepare(
      "SELECT id, subject, actor, action, table_name, source, created_at FROM audit_log",
    ).first<Record<string, unknown>>();
    expect(row?.subject).toBe("u@org");
    expect(row?.actor).toBe("admin@org");
    expect(row?.action).toBe("offboard");
    expect(row?.source).toBe("admin");
    expect(row?.table_name).toBeNull();
    expect(typeof row?.id).toBe("string");
    expect((row?.id as string).length).toBeGreaterThan(0);
    expect(row?.created_at).toBe(now);
  });

  it("inserts a row with a non-null table_name and reads it back", async () => {
    const now = "2026-03-04T05:06:07.000Z";
    await writeAudit(
      env.DB,
      { subject: "s@org", actor: null, action: "deactivate", table_name: "users", source: "admin" },
      now,
    );
    const row = await env.DB.prepare(
      "SELECT table_name, created_at FROM audit_log",
    ).first<Record<string, unknown>>();
    expect(row?.table_name).toBe("users");
    expect(row?.created_at).toBe(now);
  });

  it("never throws even if the insert fails (audit must not break the caller)", async () => {
    const brokenDb = { prepare: () => { throw new Error("db down"); } } as unknown as D1Database;
    await expect(
      writeAudit(brokenDb, { action: "x", source: "cron" }),
    ).resolves.toBeUndefined();
  });
});
