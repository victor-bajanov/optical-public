import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { storeIdentityTokens, listSubjects, getSubjectProvider, getAccessToken, ACCESS_PREFIX } from "../src/auth/identity-store";
import type { IdentityProvider } from "../src/auth/identity-provider";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM identity_tokens").run();
  await env.DB.prepare("DELETE FROM users").run();
});

describe("identity-store", () => {
  it("stores an encrypted refresh token and seeds an active user listable via listSubjects", async () => {
    await storeIdentityTokens(env, "u@example.com", { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" });
    expect(await listSubjects(env)).toContain("u@example.com");
  });

  it("listSubjects reflects the users table (active only), not identity_tokens directly", async () => {
    await storeIdentityTokens(env, "active@example.com", { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" });
    // A credential row with NO active user must not appear.
    await env.DB.prepare("INSERT OR REPLACE INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at) VALUES (?,?,?,?)")
      .bind("orphan@example.com", new Uint8Array([1, 2, 3]).buffer, "s", "2026-01-01T00:00:00Z").run();
    const subs = await listSubjects(env);
    expect(subs).toContain("active@example.com");
    expect(subs).not.toContain("orphan@example.com");
  });
});

describe("identity provider column", () => {
  it("defaults provider to google for rows stored without one", async () => {
    await storeIdentityTokens(env, "g@example.com", { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" });
    expect(await getSubjectProvider(env, "g@example.com")).toBe("google");
  });

  it("stores and returns microsoft when given", async () => {
    await storeIdentityTokens(env, "m@example.com", { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" }, "microsoft");
    expect(await getSubjectProvider(env, "m@example.com")).toBe("microsoft");
  });

  it("falls back to google for unknown subjects", async () => {
    expect(await getSubjectProvider(env, "nobody@example.com")).toBe("google");
  });
});

function rotatingIdp(seen: string[]): IdentityProvider {
  return {
    scopes: [],
    authorizeUrl: () => { throw new Error("unused"); },
    exchangeCode: () => { throw new Error("unused"); },
    fetchIdentity: () => { throw new Error("unused"); },
    refreshAccessToken: async (refreshToken: string) => {
      seen.push(refreshToken);
      return { accessToken: `at-${seen.length}`, expiresIn: 3600, refreshToken: `rotated-${seen.length}` };
    },
  };
}

describe("refresh token rotation", () => {
  it("persists a rotated refresh token and uses it on the next refresh", async () => {
    await storeIdentityTokens(env, "rot@example.com", { refreshToken: "r0", accessToken: "a", expiresIn: 3600, scope: "s" }, "microsoft");
    const seen: string[] = [];
    const idp = rotatingIdp(seen);
    await getAccessToken(env, idp, "rot@example.com", { forceRefresh: true });
    await getAccessToken(env, idp, "rot@example.com", { forceRefresh: true });
    expect(seen).toEqual(["r0", "rotated-1"]); // second call sees the rotated token
  });
});

describe("provider switch (same email signs in via the other IdP)", () => {
  const tokens = { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" };
  async function seedSync(owner: string): Promise<void> {
    await env.DB.prepare("DELETE FROM calendar_sync WHERE owner_subject = ?").bind(owner).run();
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES (?,?,?,?,?,?,?,?)",
    ).bind(owner, "primary", "CPJ-google-token", "chan-1", "tok-1", "2027-01-01T00:00:00Z", "res-1", "https://x/cb").run();
  }

  it("resets calendar_sync and done_color_id when the provider changes", async () => {
    await storeIdentityTokens(env, "sw@example.com", tokens, "google");
    await seedSync("sw@example.com");
    await env.DB.prepare("UPDATE users SET done_color_id = ? WHERE subject = ?").bind("11", "sw@example.com").run();

    await storeIdentityTokens(env, "sw@example.com", tokens, "microsoft");

    const sync = await env.DB.prepare("SELECT next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url FROM calendar_sync WHERE owner_subject = ?")
      .bind("sw@example.com").first<Record<string, unknown>>();
    expect(sync).toEqual({ next_sync_token: null, channel_id: null, channel_token: null, channel_expires_at: null, channel_resource_id: null, channel_callback_url: null });
    const user = await env.DB.prepare("SELECT done_color_id FROM users WHERE subject = ?").bind("sw@example.com").first<{ done_color_id: string | null }>();
    expect(user!.done_color_id).toBeNull();
    expect(await getSubjectProvider(env, "sw@example.com")).toBe("microsoft");
  });

  it("leaves calendar_sync and done_color_id alone on a same-provider re-login", async () => {
    await storeIdentityTokens(env, "same@example.com", tokens, "google");
    await seedSync("same@example.com");
    await env.DB.prepare("UPDATE users SET done_color_id = ? WHERE subject = ?").bind("11", "same@example.com").run();

    await storeIdentityTokens(env, "same@example.com", tokens, "google");

    const sync = await env.DB.prepare("SELECT next_sync_token, channel_id FROM calendar_sync WHERE owner_subject = ?")
      .bind("same@example.com").first<Record<string, unknown>>();
    expect(sync).toEqual({ next_sync_token: "CPJ-google-token", channel_id: "chan-1" });
    const user = await env.DB.prepare("SELECT done_color_id FROM users WHERE subject = ?").bind("same@example.com").first<{ done_color_id: string | null }>();
    expect(user!.done_color_id).toBe("11");
  });

  it("an in-flight old-provider refresh cannot clobber the new provider's refresh token", async () => {
    await storeIdentityTokens(env, "race@example.com", tokens, "microsoft");
    const idp: IdentityProvider = {
      scopes: [],
      authorizeUrl: () => { throw new Error("unused"); },
      exchangeCode: () => { throw new Error("unused"); },
      fetchIdentity: () => { throw new Error("unused"); },
      refreshAccessToken: async () => {
        // The user switches to Google while this Microsoft refresh is in flight.
        await storeIdentityTokens(env, "race@example.com", { ...tokens, refreshToken: "google-r" }, "google");
        return { accessToken: "ms-at", expiresIn: 3600, refreshToken: "ms-rotated" };
      },
    };
    await getAccessToken(env, idp, "race@example.com", { forceRefresh: true });
    // The stale Microsoft access token must not be cached against the (now Google) subject.
    expect(await env.GOOGLE_TOKEN_CACHE.get(ACCESS_PREFIX + "race@example.com")).not.toBe("ms-at");
    // The next refresh (now via the Google row) must see the Google token, not the stale rotation.
    const seen: string[] = [];
    await getAccessToken(env, rotatingIdp(seen), "race@example.com", { forceRefresh: true });
    expect(seen).toEqual(["google-r"]);
  });
});
