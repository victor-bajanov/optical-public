import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

describe("migration 0037: identity_tokens.provider_subject", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM identity_tokens").run();
  });

  it("adds a nullable provider_subject column", async () => {
    const cols = await env.DB.prepare("PRAGMA table_info(identity_tokens)").all<{ name: string; notnull: number }>();
    const col = cols.results.find((c) => c.name === "provider_subject");
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
  });

  it("rejects two rows with the same (provider, provider_subject)", async () => {
    await env.DB.prepare(
      "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject) VALUES (?,?,?,?,?,?)",
    ).bind("a@example.com", new Uint8Array([1]).buffer, "s", "2026-01-01T00:00:00Z", "microsoft", "tid:oid-1").run();
    await expect(
      env.DB.prepare(
        "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject) VALUES (?,?,?,?,?,?)",
      ).bind("b@example.com", new Uint8Array([2]).buffer, "s", "2026-01-01T00:00:00Z", "microsoft", "tid:oid-1").run(),
    ).rejects.toThrow();
  });

  it("allows the same provider_subject under a different provider", async () => {
    await env.DB.prepare(
      "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject) VALUES (?,?,?,?,?,?)",
    ).bind("a@example.com", new Uint8Array([1]).buffer, "s", "2026-01-01T00:00:00Z", "microsoft", "same-sub").run();
    await expect(
      env.DB.prepare(
        "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject) VALUES (?,?,?,?,?,?)",
      ).bind("b@example.com", new Uint8Array([2]).buffer, "s", "2026-01-01T00:00:00Z", "google", "same-sub").run(),
    ).resolves.toBeDefined();
  });

  it("allows many NULL provider_subject rows to coexist (pre-0037 rows)", async () => {
    await env.DB.prepare(
      "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider) VALUES (?,?,?,?,?)",
    ).bind("c@example.com", new Uint8Array([3]).buffer, "s", "2026-01-01T00:00:00Z", "google").run();
    await expect(
      env.DB.prepare(
        "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider) VALUES (?,?,?,?,?)",
      ).bind("d@example.com", new Uint8Array([4]).buffer, "s", "2026-01-01T00:00:00Z", "google").run(),
    ).resolves.toBeDefined();
  });
});
