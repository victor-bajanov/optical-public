import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

// Decision K: 0045 adds pending_actions.mail_channel, set to 'system' when a
// deferral's confirmation went out through the shared SMTP2GO system mailer
// (the user's own mailbox failed). The fallback limit counts those rows.
describe("0045 pending_actions.mail_channel migration", () => {
  it("adds a nullable TEXT column with no default", async () => {
    const cols = await env.DB.prepare("PRAGMA table_info(pending_actions)")
      .all<{ name: string; type: string; notnull: number; dflt_value: unknown }>();
    expect(cols.results.find((c) => c.name === "mail_channel")).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });
  });

  it("existing-style inserts leave it NULL", async () => {
    await env.DB.prepare("DELETE FROM pending_actions").run();
    await env.DB.prepare(
      "INSERT INTO pending_actions (id, owner_subject, op, payload, summary, created_at, expires_at, consumed_at) VALUES ('m1','o','op','{}','{}','2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z',NULL)",
    ).run();
    const r = await env.DB.prepare("SELECT mail_channel FROM pending_actions WHERE id = 'm1'").first<{ mail_channel: string | null }>();
    expect(r).toEqual({ mail_channel: null });
  });
});
