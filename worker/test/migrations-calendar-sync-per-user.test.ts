import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";

describe("migration 0014: calendar_sync per-user re-key", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM calendar_sync").run();
  });

  it("has a composite primary key on (owner_subject, calendar_id)", async () => {
    const info = await env.DB.prepare("PRAGMA table_info(calendar_sync)").all<{
      name: string;
      pk: number;
    }>();
    const pkCols = info.results
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pkCols).toEqual(["owner_subject", "calendar_id"]);
  });

  it("allows two owners to share the same calendar_id", async () => {
    await env.DB
      .prepare("INSERT INTO calendar_sync (owner_subject, calendar_id) VALUES ('a@org', 'primary')")
      .run();
    await env.DB
      .prepare("INSERT INTO calendar_sync (owner_subject, calendar_id) VALUES ('b@org', 'primary')")
      .run();
    const rows = await env.DB
      .prepare("SELECT owner_subject FROM calendar_sync WHERE calendar_id = 'primary' ORDER BY owner_subject")
      .all<{ owner_subject: string }>();
    expect(rows.results.map((r) => r.owner_subject)).toEqual(["a@org", "b@org"]);
  });

  it("rejects a duplicate channel_id across owners (UNIQUE index)", async () => {
    await env.DB
      .prepare("INSERT INTO calendar_sync (owner_subject, calendar_id, channel_id) VALUES ('a@org', 'primary', 'ch-dup')")
      .run();
    await expect(
      env.DB
        .prepare("INSERT INTO calendar_sync (owner_subject, calendar_id, channel_id) VALUES ('b@org', 'primary', 'ch-dup')")
        .run(),
    ).rejects.toThrow();
  });

  it("allows multiple NULL channel_id rows (NULLs are distinct in SQLite)", async () => {
    await env.DB
      .prepare("INSERT INTO calendar_sync (owner_subject, calendar_id, channel_id) VALUES ('a@org', 'primary', NULL)")
      .run();
    await env.DB
      .prepare("INSERT INTO calendar_sync (owner_subject, calendar_id, channel_id) VALUES ('b@org', 'primary', NULL)")
      .run();
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM calendar_sync").first<{ n: number }>();
    expect(r?.n).toBe(2);
  });
});
