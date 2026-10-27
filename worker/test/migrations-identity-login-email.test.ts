import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

// Decision 3 (identity port of #105): 0046 adds identity_tokens.login_email,
// the verified email from the subject's latest sign-in. Owner mail goes there
// (db/owner-email.ts), never to a possibly reassigned subject address.
describe("0046 identity_tokens.login_email migration", () => {
  it("adds a nullable TEXT column with no default", async () => {
    const cols = await env.DB.prepare("PRAGMA table_info(identity_tokens)")
      .all<{ name: string; type: string; notnull: number; dflt_value: unknown }>();
    expect(cols.results.find((c) => c.name === "login_email")).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });
  });

  it("existing-style inserts leave it NULL", async () => {
    await env.DB.prepare("DELETE FROM identity_tokens").run();
    await env.DB.prepare(
      "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject) VALUES (?,?,?,?,?,?)",
    ).bind("legacy@example.com", "ct", "s", "2026-01-01T00:00:00.000Z", "google", "sub-l").run();
    const r = await env.DB.prepare("SELECT login_email FROM identity_tokens WHERE account_email = ?")
      .bind("legacy@example.com").first<{ login_email: string | null }>();
    expect(r).toEqual({ login_email: null });
  });
});
