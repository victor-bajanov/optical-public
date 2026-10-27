import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  storeIdentityTokens, listSubjects, getSubjectProvider, getAccessToken, hasStoredGrant, ProviderRebindRefusedError,
  accessCacheKey, cacheAccessToken, readCachedAccessToken, dropCachedAccessToken,
  IdentityCredentialMissingError, readRefreshToken,
} from "../src/auth/identity-store";
import { hashToken } from "../src/auth/tokens";
import { hashingKey } from "../src/auth/crypto-keys";
import type { IdentityProvider } from "../src/auth/identity-provider";
import { readRebindTarget, clearIdentityAnchor } from "../src/auth/identity-rebind";
import { upsertCalendarSync } from "../src/db/calendar-sync";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM identity_tokens").run();
  await env.DB.prepare("DELETE FROM users").run();
});

afterEach(() => {
  vi.restoreAllMocks();
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

// OAuth verification hardening, card C1: the IdP access-token cache holds no
// plaintext token and no email in its key names.
describe("access-token cache at rest", () => {
  const counting = (calls: string[]): IdentityProvider => idpRefreshing(async (r) => {
    calls.push(r);
    return { accessToken: "AT-NEW", expiresIn: 3600 };
  });
  const allEntries = async (kv: KVNamespace) => {
    const { keys } = await kv.list();
    return Promise.all(keys.map(async (k) => ({ name: k.name, bytes: new Uint8Array((await kv.get(k.name, "arrayBuffer"))!) })));
  };

  it("stores no key containing the subject and no value equal to the token", async () => {
    await storeIdentityTokens(env, "a@x", { refreshToken: "r", accessToken: "AT-1-plain", expiresIn: 3600, scope: "s" });
    const entries = await allEntries(env.GOOGLE_TOKEN_CACHE);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.name).not.toContain("a@x");
      expect(new TextDecoder().decode(e.bytes)).not.toContain("AT-1-plain");
    }
    expect(entries.map((e) => e.name)).toContain(await accessCacheKey(env, "a@x"));
  });

  it("the key is idp_at: plus a keyed hash of the subject (no email, stable per subject)", async () => {
    const k = await accessCacheKey(env, "a@x");
    expect(k).toMatch(/^idp_at:[A-Za-z0-9_-]{43}$/);
    expect(k).toBe(`idp_at:${await hashToken("idp-access:a@x", hashingKey(env))}`);
    expect(await accessCacheKey(env, "b@x")).not.toBe(k);
  });

  it("readCachedAccessToken returns the stored token", async () => {
    await storeIdentityTokens(env, "a@x", { refreshToken: "r", accessToken: "AT-1", expiresIn: 3600, scope: "s" });
    expect(await readCachedAccessToken(env, "a@x")).toBe("AT-1");
  });

  it("getAccessToken returns the cached value without calling the IdP", async () => {
    await storeIdentityTokens(env, "a@x", { refreshToken: "r", accessToken: "AT-1", expiresIn: 3600, scope: "s" });
    const calls: string[] = [];
    expect(await getAccessToken(env, counting(calls), "a@x")).toBe("AT-1");
    expect(calls).toEqual([]);
  });

  it("a plaintext value under the new key reads as a miss: the IdP refresh fires and the new value is stored encrypted, nothing logged", async () => {
    await storeIdentityTokens(env, "a@x", { refreshToken: "r", accessToken: "AT-1", expiresIn: 3600, scope: "s" });
    const key = await accessCacheKey(env, "a@x");
    await env.GOOGLE_TOKEN_CACHE.put(key, "AT-OLD");
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    expect(await readCachedAccessToken(env, "a@x")).toBeNull();
    const calls: string[] = [];
    expect(await getAccessToken(env, counting(calls), "a@x")).toBe("AT-NEW");
    expect(calls).toEqual(["r"]);
    const logged = spies.flatMap((s) => s.mock.calls).map((c) => c.map(String).join(" ")).join("\n");
    expect(logged).not.toContain("AT-OLD");
    const raw = await env.GOOGLE_TOKEN_CACHE.get(key, "arrayBuffer");
    expect(new TextDecoder().decode(raw!)).not.toContain("AT-NEW");
    expect(await readCachedAccessToken(env, "a@x")).toBe("AT-NEW");
  });

  it("a value encrypted under another key (rotation) reads as a miss", async () => {
    await cacheAccessToken({ ...env, ENCRYPTION_KEY: "an-older-encryption-key" } as typeof env, "a@x", "AT-ROT", 3600);
    expect(await readCachedAccessToken(env, "a@x")).toBeNull();
  });

  it("a legacy plaintext idp_access_token:<subject> entry is never read", async () => {
    await storeIdentityTokens(env, "a@x", { refreshToken: "r", accessToken: "AT-1", expiresIn: 3600, scope: "s" });
    await dropCachedAccessToken(env, "a@x");
    await env.GOOGLE_TOKEN_CACHE.put("idp_access_token:a@x", "AT-LEGACY");
    const calls: string[] = [];
    expect(await getAccessToken(env, counting(calls), "a@x")).toBe("AT-NEW");
    expect(calls).toEqual(["r"]);
  });

  it("dropCachedAccessToken deletes the new entry and the legacy plaintext one", async () => {
    await cacheAccessToken(env, "a@x", "AT-1", 3600);
    await env.GOOGLE_TOKEN_CACHE.put("idp_access_token:a@x", "AT-LEGACY");
    await cacheAccessToken(env, "b@x", "AT-B", 3600);
    await dropCachedAccessToken(env, "a@x");
    expect(await env.GOOGLE_TOKEN_CACHE.get(await accessCacheKey(env, "a@x"))).toBeNull();
    expect(await env.GOOGLE_TOKEN_CACHE.get("idp_access_token:a@x")).toBeNull();
    expect(await readCachedAccessToken(env, "b@x")).toBe("AT-B");
  });

  it("TTL is capped at 3600 s and floored at 60 s, on sign-in and on refresh", async () => {
    const ttls: Array<{ key: string; ttl: number | undefined }> = [];
    const kv = new Proxy(env.GOOGLE_TOKEN_CACHE, {
      get(target, prop) {
        if (prop === "put") {
          return async (...args: Parameters<KVNamespace["put"]>) => {
            ttls.push({ key: args[0], ttl: args[2]?.expirationTtl });
            return target.put(...args);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const recording = { ...env, GOOGLE_TOKEN_CACHE: kv } as typeof env;
    const key = await accessCacheKey(env, "a@x");
    await storeIdentityTokens(recording, "a@x", { refreshToken: "r", accessToken: "AT-1", expiresIn: 5400, scope: "s" });
    await storeIdentityTokens(recording, "a@x", { refreshToken: "r", accessToken: "AT-1", expiresIn: 30, scope: "s" });
    await getAccessToken(recording, idpRefreshing(async () => ({ accessToken: "AT-2", expiresIn: 5400 })), "a@x", { forceRefresh: true });
    await getAccessToken(recording, idpRefreshing(async () => ({ accessToken: "AT-3", expiresIn: 30 })), "a@x", { forceRefresh: true });
    await cacheAccessToken(recording, "a@x", "AT-4", 3599);
    expect(ttls).toEqual([
      { key, ttl: 3600 }, { key, ttl: 60 }, { key, ttl: 3600 }, { key, ttl: 60 }, { key, ttl: 3539 },
    ]);
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
    revokeGrant: async () => {},
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
      revokeGrant: async () => {},
      refreshAccessToken: async () => {
        // The user switches to Google while this Microsoft refresh is in flight.
        await storeIdentityTokens(env, "race@example.com", { ...tokens, refreshToken: "google-r" }, "google");
        return { accessToken: "ms-at", expiresIn: 3600, refreshToken: "ms-rotated" };
      },
    };
    await getAccessToken(env, idp, "race@example.com", { forceRefresh: true });
    // The stale Microsoft access token must not be cached against the (now Google) subject.
    expect(await readCachedAccessToken(env, "race@example.com")).not.toBe("ms-at");
    // The next refresh (now via the Google row) must see the Google token, not the stale rotation.
    const seen: string[] = [];
    await getAccessToken(env, rotatingIdp(seen), "race@example.com", { forceRefresh: true });
    expect(seen).toEqual(["google-r"]);
  });
});

describe("hasStoredGrant (Task A: skip revoking an existing member's grant)", () => {
  const legacy = (email: string) => env.DB.prepare(
    "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at) VALUES (?,?,?,?)",
  ).bind(email, new Uint8Array([1]).buffer, "s", "2026-01-01T00:00:00Z").run();

  it("no row: false", async () => {
    expect(await hasStoredGrant(env, "google", "sub-x", "x@example.com")).toBe(false);
  });

  it("a row under the same provider, matched by email: true", async () => {
    await storeIdentityTokens(env, "a@example.com", { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" }, "google", "sub-a");
    expect(await hasStoredGrant(env, "google", "sub-a", "a@example.com")).toBe(true);
  });

  it("matched by providerSubject under the ORIGINAL email after a rename: true", async () => {
    await storeIdentityTokens(env, "old@example.com", { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" }, "microsoft", "tid:oid");
    expect(await hasStoredGrant(env, "microsoft", "tid:oid", "new@example.com")).toBe(true);
  });

  it("a row for the same email under the OTHER provider: false", async () => {
    await storeIdentityTokens(env, "b@example.com", { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" }, "microsoft", "tid:b");
    expect(await hasStoredGrant(env, "google", "sub-b", "b@example.com")).toBe(false);
  });

  it("same provider and email but a DIFFERENT stored provider_subject (another upstream account): false, so its partial grant is revoked", async () => {
    // Revoking that other account's grant cannot touch the stored one, and
    // with REFUSE_PROVIDER_REBIND it is about to be refused anyway.
    await storeIdentityTokens(env, "c@example.com", { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" }, "google", "sub-owner");
    expect(await hasStoredGrant(env, "google", "sub-other", "c@example.com")).toBe(false);
  });

  it("a legacy row with no provider counts as google", async () => {
    await legacy("legacy@example.com");
    expect(await hasStoredGrant(env, "google", "sub-l", "legacy@example.com")).toBe(true);
    expect(await hasStoredGrant(env, "microsoft", "tid:l", "legacy@example.com")).toBe(false);
  });
});

/** An IdentityProvider whose refresh runs `refresh` (everything else unused). */
function idpRefreshing(refresh: IdentityProvider["refreshAccessToken"]): IdentityProvider {
  return {
    scopes: [],
    authorizeUrl: () => { throw new Error("unused"); },
    exchangeCode: () => { throw new Error("unused"); },
    fetchIdentity: () => { throw new Error("unused"); },
    revokeGrant: async () => {},
    refreshAccessToken: refresh,
  };
}

/** `base` with a D1 that runs `race` once, just before the first write that
 *  touches a statement whose SQL matches `trigger`: either that statement's
 *  own run(), or a DB.batch that carries it. Everything else passes through
 *  to the real D1, so the race lands between the code's read and its write. */
function racedEnv(base: typeof env, trigger: RegExp, race: () => Promise<void>): typeof env {
  let fired = false;
  const fire = async () => { if (!fired) { fired = true; await race(); } };
  const marked = new WeakSet<object>();
  const mark = (stmt: D1PreparedStatement): D1PreparedStatement => {
    marked.add(stmt);
    const run = stmt.run.bind(stmt);
    const bind = stmt.bind.bind(stmt);
    Object.assign(stmt, {
      run: async () => { await fire(); return run(); },
      bind: (...a: unknown[]) => mark(bind(...a)),
    });
    return stmt;
  };
  const DB = new Proxy(base.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          return trigger.test(sql) ? mark(stmt) : stmt;
        };
      }
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          if (stmts.some((s) => marked.has(s))) await fire();
          return target.batch(stmts);
        };
      }
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { ...base, DB } as typeof env;
}

const encOf = async (email: string) => {
  const row = await env.DB.prepare("SELECT hex(refresh_token_encrypted) AS enc FROM identity_tokens WHERE account_email = ?")
    .bind(email).first<{ enc: string }>();
  return row!.enc;
};

// Decision 1 (identity port of #105): a refresh in flight across a change of
// the stored IdP identity must never cache, persist or (same provider) return
// the previous holder's token.
describe("getAccessToken across a change of identity mid-refresh", () => {
  const tokens = { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" };
  const rebind = (email: string, providerSubject: string) =>
    env.DB.prepare("UPDATE identity_tokens SET provider_subject = ? WHERE account_email = ?").bind(providerSubject, email).run();

  it("rotating refresh (Microsoft), provider_subject changes mid-flight: throws, refresh ciphertext unchanged, nothing cached", async () => {
    await storeIdentityTokens(env, "rot-a@example.com", tokens, "microsoft", "tid:oid-A");
    await dropCachedAccessToken(env, "rot-a@example.com");
    const before = await encOf("rot-a@example.com");
    const idp = idpRefreshing(async () => {
      // An admin rebind clears the anchor and identity B signs in as the address.
      await rebind("rot-a@example.com", "tid:oid-B");
      return { accessToken: "A-at", expiresIn: 3600, refreshToken: "A-rotated" };
    });
    await expect(getAccessToken(env, idp, "rot-a@example.com", { forceRefresh: true }))
      .rejects.toThrow(/^identity_changed_during_refresh$/);
    expect(await encOf("rot-a@example.com")).toBe(before);
    expect(await readCachedAccessToken(env, "rot-a@example.com")).toBeNull();
  });

  it("non-rotating refresh (Google), provider_subject changes mid-flight: throws and leaves B's cached token in place", async () => {
    await storeIdentityTokens(env, "nr@example.com", tokens, "google", "sub-A");
    await dropCachedAccessToken(env, "nr@example.com");
    const idp = idpRefreshing(async () => {
      await rebind("nr@example.com", "sub-B");
      await cacheAccessToken(env, "nr@example.com", "B-at", 3600); // B's own sign-in cached it
      return { accessToken: "A-at", expiresIn: 3600 }; // Google: no rotated refresh token
    });
    await expect(getAccessToken(env, idp, "nr@example.com", { forceRefresh: true }))
      .rejects.toThrow(/^identity_changed_during_refresh$/);
    expect(await readCachedAccessToken(env, "nr@example.com")).toBe("B-at");
  });

  it("the anchor changes after the re-read but before the rotated write-back: the guarded write matches nothing, throws, nothing persisted or cached", async () => {
    await storeIdentityTokens(env, "late@example.com", tokens, "microsoft", "tid:oid-A");
    await dropCachedAccessToken(env, "late@example.com");
    const before = await encOf("late@example.com");
    const raced = racedEnv(env, /SET refresh_token_encrypted/, () => rebind("late@example.com", "tid:oid-B").then(() => {}));
    const idp = idpRefreshing(async () => ({ accessToken: "A-at", expiresIn: 3600, refreshToken: "A-rotated" }));
    await expect(getAccessToken(raced, idp, "late@example.com", { forceRefresh: true }))
      .rejects.toThrow(/^identity_changed_during_refresh$/);
    expect(await encOf("late@example.com")).toBe(before);
    expect(await readCachedAccessToken(env, "late@example.com")).toBeNull();
  });

  it("a provider change mid-flight still hands the token back and caches nothing (today's behaviour)", async () => {
    await storeIdentityTokens(env, "prov@example.com", tokens, "microsoft", "tid:oid-A");
    await dropCachedAccessToken(env, "prov@example.com");
    const idp = idpRefreshing(async () => {
      // The same person switches to Google while the Microsoft refresh is in flight.
      await storeIdentityTokens(env, "prov@example.com", { ...tokens, refreshToken: "google-r", accessToken: "google-at" }, "google", "g-sub");
      await dropCachedAccessToken(env, "prov@example.com");
      return { accessToken: "ms-at", expiresIn: 3600, refreshToken: "ms-rotated" };
    });
    expect(await getAccessToken(env, idp, "prov@example.com", { forceRefresh: true })).toBe("ms-at");
    expect(await readCachedAccessToken(env, "prov@example.com")).toBeNull();
  });

  it("an unchanged identity still persists the rotation and caches the token", async () => {
    await storeIdentityTokens(env, "ok@example.com", tokens, "microsoft", "tid:oid-A");
    const seen: string[] = [];
    expect(await getAccessToken(env, rotatingIdp(seen), "ok@example.com", { forceRefresh: true })).toBe("at-1");
    expect(await readCachedAccessToken(env, "ok@example.com")).toBe("at-1");
    await getAccessToken(env, rotatingIdp(seen), "ok@example.com", { forceRefresh: true });
    expect(seen).toEqual(["r", "rotated-1"]);
  });

  it("B binds and caches between the re-read and the cache write: A's token must not end up cached", async () => {
    await storeIdentityTokens(env, "kv@example.com", tokens, "google", "sub-A");
    await dropCachedAccessToken(env, "kv@example.com");
    let raced = false;
    const kv = new Proxy(env.GOOGLE_TOKEN_CACHE, {
      get(target, prop) {
        if (prop === "put") {
          return async (...args: Parameters<KVNamespace["put"]>) => {
            if (!raced && args[0] === await accessCacheKey(env, "kv@example.com")) {
              raced = true; // B's sign-in lands here: anchor flips, B's token cached.
              await storeIdentityTokens(env, "kv@example.com", { ...tokens, accessToken: "B-at" }, "google", "sub-B");
            }
            return target.put(...args);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const racedKv = { ...env, GOOGLE_TOKEN_CACHE: kv } as typeof env;
    const idp = idpRefreshing(async () => ({ accessToken: "A-at", expiresIn: 3600 }));
    await getAccessToken(racedKv, idp, "kv@example.com", { forceRefresh: true }).catch(() => {});
    expect(await readCachedAccessToken(env, "kv@example.com")).not.toBe("A-at");
  });

  it("B binds between the re-read and the cache write: the call throws identity_changed_during_refresh and the key is dropped", async () => {
    await storeIdentityTokens(env, "kv2@example.com", tokens, "google", "sub-A");
    await dropCachedAccessToken(env, "kv2@example.com");
    const racedKv = putRacedEnv("kv2@example.com", () => storeIdentityTokens(env, "kv2@example.com", { ...tokens, accessToken: "B-at" }, "google", "sub-B"));
    const idp = idpRefreshing(async () => ({ accessToken: "A-at", expiresIn: 3600 }));
    await expect(getAccessToken(racedKv, idp, "kv2@example.com", { forceRefresh: true }))
      .rejects.toThrow(/^identity_changed_during_refresh$/);
    expect(await readCachedAccessToken(env, "kv2@example.com")).toBeNull();
  });

  it("a provider switch between the re-read and the cache write: the token is still returned, nothing left cached", async () => {
    await storeIdentityTokens(env, "kvp@example.com", tokens, "microsoft", "tid:oid-A");
    await dropCachedAccessToken(env, "kvp@example.com");
    const racedKv = putRacedEnv("kvp@example.com", () => storeIdentityTokens(env, "kvp@example.com", { ...tokens, accessToken: "google-at" }, "google", "g-sub"));
    const idp = idpRefreshing(async () => ({ accessToken: "ms-at", expiresIn: 3600 }));
    expect(await getAccessToken(racedKv, idp, "kvp@example.com", { forceRefresh: true })).toBe("ms-at");
    expect(await readCachedAccessToken(env, "kvp@example.com")).toBeNull();
  });

  it("an offboard between the re-read and the cache write: the token is still returned, nothing left cached", async () => {
    await storeIdentityTokens(env, "kvo@example.com", tokens, "google", "sub-A");
    await dropCachedAccessToken(env, "kvo@example.com");
    const racedKv = putRacedEnv("kvo@example.com", async () => {
      await env.DB.prepare("DELETE FROM identity_tokens WHERE account_email = ?").bind("kvo@example.com").run();
    });
    const idp = idpRefreshing(async () => ({ accessToken: "A-at", expiresIn: 3600 }));
    expect(await getAccessToken(racedKv, idp, "kvo@example.com", { forceRefresh: true })).toBe("A-at");
    expect(await readCachedAccessToken(env, "kvo@example.com")).toBeNull();
  });
});

/** `env` whose token cache runs `race` once, just before the first put of
 *  `subject`'s access-token entry (matched on accessCacheKey, not a literal). */
function putRacedEnv(subject: string, race: () => Promise<unknown>): typeof env {
  let raced = false;
  const kv = new Proxy(env.GOOGLE_TOKEN_CACHE, {
    get(target, prop) {
      if (prop === "put") {
        return async (...args: Parameters<KVNamespace["put"]>) => {
          if (!raced && args[0] === await accessCacheKey(env, subject)) { raced = true; await race(); }
          return target.put(...args);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { ...env, GOOGLE_TOKEN_CACHE: kv } as typeof env;
}

// Decision 2: the provider-switch reset (calendar_sync token + channel, done
// colour) commits in one D1 batch with the credential flip, and only when the
// flip takes effect.
describe("provider-switch reset is atomic with the credential flip", () => {
  const tokens = { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" };
  const on = () => ({ ...env, REFUSE_PROVIDER_REBIND: "true" }) as typeof env;
  const seedRow = async (email: string, provider: string, providerSubject: string | null) => {
    await env.DB.prepare(
      "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject) VALUES (?,?,?,?,?,?)",
    ).bind(email, new Uint8Array([1]).buffer, "s", "2026-01-01T00:00:00Z", provider, providerSubject).run();
    await env.DB.prepare("INSERT INTO users (subject, role, is_active, created_at, done_color_id) VALUES (?,?,?,?,?)")
      .bind(email, "member", 1, "2026-01-01T00:00:00Z", "11").run();
    await env.DB.prepare("DELETE FROM calendar_sync WHERE owner_subject = ?").bind(email).run();
    await env.DB.prepare("INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id) VALUES (?,?,?,?)")
      .bind(email, "primary", "CPJ", "chan-1").run();
  };
  const state = async (email: string) => ({
    row: await env.DB.prepare("SELECT provider, provider_subject FROM identity_tokens WHERE account_email = ?").bind(email).first(),
    sync: await env.DB.prepare("SELECT next_sync_token, channel_id FROM calendar_sync WHERE owner_subject = ?").bind(email).first(),
    colour: (await env.DB.prepare("SELECT done_color_id FROM users WHERE subject = ?").bind(email).first<{ done_color_id: string | null }>())!.done_color_id,
  });

  it("REFUSE_PROVIDER_REBIND: another sign-in anchors a legacy row between the pre-check and the write -> refused, sync and colour untouched", async () => {
    await seedRow("leg@example.com", "google", null);
    const raced = racedEnv(on(), /INSERT INTO identity_tokens/, async () => {
      await env.DB.prepare("UPDATE identity_tokens SET provider_subject = 'g-sub' WHERE account_email = 'leg@example.com'").run();
    });
    const err = await storeIdentityTokens(raced, "leg@example.com", tokens, "microsoft", "tid:oid").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRebindRefusedError);
    expect(await state("leg@example.com")).toEqual({
      row: { provider: "google", provider_subject: "g-sub" },
      sync: { next_sync_token: "CPJ", channel_id: "chan-1" },
      colour: "11",
    });
  });

  it("REFUSE_PROVIDER_REBIND: a cross-provider sign-in on an unanchored row still switches, resets and anchors", async () => {
    await seedRow("unanch@example.com", "google", null);
    await storeIdentityTokens(on(), "unanch@example.com", tokens, "microsoft", "tid:oid");
    expect(await state("unanch@example.com")).toEqual({
      row: { provider: "microsoft", provider_subject: "tid:oid" },
      sync: { next_sync_token: null, channel_id: null },
      colour: null,
    });
  });

  it("a failing reset rolls the credential flip back, and a retry resets", async () => {
    await seedRow("at@example.com", "google", null);
    await env.DB.prepare("CREATE TRIGGER fail_reset BEFORE UPDATE ON calendar_sync BEGIN SELECT RAISE(ABORT, 'boom'); END").run();
    try {
      await expect(storeIdentityTokens(env, "at@example.com", tokens, "microsoft", "tid:oid")).rejects.toThrow();
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_reset").run();
    }
    expect((await state("at@example.com")).row).toEqual({ provider: "google", provider_subject: null });
    await storeIdentityTokens(env, "at@example.com", tokens, "microsoft", "tid:oid");
    expect(await state("at@example.com")).toEqual({
      row: { provider: "microsoft", provider_subject: "tid:oid" },
      sync: { next_sync_token: null, channel_id: null },
      colour: null,
    });
  });

  it("a failing credential flip leaves sync state and the done colour untouched", async () => {
    await seedRow("flip@example.com", "google", null);
    await env.DB.prepare("CREATE TRIGGER fail_flip BEFORE UPDATE ON identity_tokens BEGIN SELECT RAISE(ABORT, 'boom'); END").run();
    try {
      await expect(storeIdentityTokens(env, "flip@example.com", tokens, "microsoft", "tid:oid")).rejects.toThrow();
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_flip").run();
    }
    expect(await state("flip@example.com")).toEqual({
      row: { provider: "google", provider_subject: null },
      sync: { next_sync_token: "CPJ", channel_id: "chan-1" },
      colour: "11",
    });
  });

  it("flag off: a concurrent switch to the other provider after the pre-check read is still reset when this sign-in flips it back", async () => {
    // Our read sees google (same as incoming: no switch). Before our write, the
    // same address signs in via Microsoft and Microsoft sync state is stored.
    // Flipping back to google must not keep that Microsoft sync token.
    await seedRow("flipback@example.com", "google", "g-sub");
    const raced = racedEnv(env, /INSERT INTO identity_tokens/, async () => {
      await storeIdentityTokens(env, "flipback@example.com", tokens, "microsoft", "tid:oid");
      await env.DB.prepare("UPDATE calendar_sync SET next_sync_token = 'MS-delta', channel_id = 'ms-sub' WHERE owner_subject = ?")
        .bind("flipback@example.com").run();
      await env.DB.prepare("UPDATE users SET done_color_id = 'Optical done' WHERE subject = ?").bind("flipback@example.com").run();
    });
    await storeIdentityTokens(raced, "flipback@example.com", tokens, "google", "g-sub");
    expect(await state("flipback@example.com")).toEqual({
      row: { provider: "google", provider_subject: "g-sub" },
      sync: { next_sync_token: null, channel_id: null },
      colour: null,
    });
  });

  // CR2: anchoring an unanchored row (legacy, or cleared by an admin rebind)
  // binds whichever upstream identity signed in, whose calendar the stored
  // sync token and push channel may not describe, so they are reset. The done
  // colour id stays meaningful under the same provider and is kept.
  for (const [flag, mk] of [["off", () => env], ["on", on]] as const) {
    it(`flag ${flag}: same-provider anchoring of a NULL-anchor row resets the sync token and channel, keeps the done colour`, async () => {
      await seedRow("anchor@example.com", "google", null);
      await storeIdentityTokens(mk(), "anchor@example.com", tokens, "google", "g-new");
      expect(await state("anchor@example.com")).toEqual({
        row: { provider: "google", provider_subject: "g-new" },
        sync: { next_sync_token: null, channel_id: null },
        colour: "11",
      });
    });

    it(`flag ${flag}: a re-sign-in under the same anchor resets nothing`, async () => {
      await seedRow("same-anchor@example.com", "google", "g-sub");
      await storeIdentityTokens(mk(), "same-anchor@example.com", tokens, "google", "g-sub");
      expect(await state("same-anchor@example.com")).toEqual({
        row: { provider: "google", provider_subject: "g-sub" },
        sync: { next_sync_token: "CPJ", channel_id: "chan-1" },
        colour: "11",
      });
    });
  }

  it("a store without a provider_subject on a NULL-anchor row resets nothing", async () => {
    await seedRow("noanchor@example.com", "google", null);
    await storeIdentityTokens(env, "noanchor@example.com", tokens, "google");
    expect((await state("noanchor@example.com")).sync).toEqual({ next_sync_token: "CPJ", channel_id: "chan-1" });
  });

  it("admin rebind, then the old credential re-subscribes, then sub-new signs in: the channel the old holder created is reset", async () => {
    await seedRow("rb@example.com", "google", "sub-old");
    const target = await readRebindTarget(env.DB, "rb@example.com");
    expect(await clearIdentityAnchor(env.DB, "rb@example.com", target!)).toBe(true);
    // Between the rebind and the next sign-in a renewal that was already in
    // flight with the old holder's token lands a channel and a sync token on
    // ITS calendar (the credential itself is wiped, so nothing starts one).
    await upsertCalendarSync(env.DB, "rb@example.com", "primary", { next_sync_token: "OLD-holder", channel_id: "old-chan" });
    await storeIdentityTokens(on(), "rb@example.com", tokens, "google", "sub-new");
    expect(await state("rb@example.com")).toEqual({
      row: { provider: "google", provider_subject: "sub-new" },
      sync: { next_sync_token: null, channel_id: null },
      colour: "11",
    });
  });
});

// Decision 3: identity_tokens.login_email is the verified, normalised email
// the subject's latest sign-in carried (the owner's notification address).
// The 7th storeIdentityTokens arg writes it; omitting it keeps the old value.
describe("storeIdentityTokens login_email", () => {
  const tokens = { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" };
  const on = () => ({ ...env, REFUSE_PROVIDER_REBIND: "true" }) as typeof env;
  const loginEmail = async (subject: string) =>
    (await env.DB.prepare("SELECT login_email FROM identity_tokens WHERE account_email = ?").bind(subject)
      .first<{ login_email: string | null }>())?.login_email;

  it("a first store writes it", async () => {
    await storeIdentityTokens(env, "orig@example.com", tokens, "google", "g-1", "orig@example.com");
    expect(await loginEmail("orig@example.com")).toBe("orig@example.com");
  });

  it("a first store without one leaves it NULL", async () => {
    await storeIdentityTokens(env, "none@example.com", tokens, "google", "g-1");
    expect(await loginEmail("none@example.com")).toBeNull();
  });

  it("a later store with a new one overwrites it", async () => {
    await storeIdentityTokens(env, "orig@example.com", tokens, "microsoft", "tid:oid", "orig@example.com");
    await storeIdentityTokens(env, "orig@example.com", tokens, "microsoft", "tid:oid", "renamed@example.org");
    expect(await loginEmail("orig@example.com")).toBe("renamed@example.org");
  });

  it("a later store without one keeps it", async () => {
    await storeIdentityTokens(env, "orig@example.com", tokens, "google", "g-1", "renamed@example.org");
    await storeIdentityTokens(env, "orig@example.com", tokens, "google", "g-1");
    expect(await loginEmail("orig@example.com")).toBe("renamed@example.org");
  });

  it("a provider switch writes the switching sign-in's address", async () => {
    await storeIdentityTokens(env, "sw@example.com", tokens, "google", "g-1", "sw@example.com");
    await storeIdentityTokens(env, "sw@example.com", tokens, "microsoft", "tid:oid", "sw-ms@example.org");
    expect(await loginEmail("sw@example.com")).toBe("sw-ms@example.org");
  });

  it("REFUSE_PROVIDER_REBIND: a refused rebind leaves it unchanged (pre-check refusal)", async () => {
    await storeIdentityTokens(on(), "own@example.com", tokens, "google", "owner-sub", "own@example.com");
    const err = await storeIdentityTokens(on(), "own@example.com", tokens, "google", "intruder-sub", "intruder@example.org")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRebindRefusedError);
    expect(await loginEmail("own@example.com")).toBe("own@example.com");
  });

  it("REFUSE_PROVIDER_REBIND: a raced rebind refused by the guarded upsert leaves it unchanged", async () => {
    await storeIdentityTokens(env, "leg@example.com", tokens, "google", undefined, "leg@example.com");
    const raced = racedEnv(on(), /INSERT INTO identity_tokens/, async () => {
      await env.DB.prepare("UPDATE identity_tokens SET provider_subject = 'g-sub' WHERE account_email = 'leg@example.com'").run();
    });
    const err = await storeIdentityTokens(raced, "leg@example.com", tokens, "microsoft", "tid:oid", "intruder@example.org")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRebindRefusedError);
    expect(await loginEmail("leg@example.com")).toBe("leg@example.com");
  });
});

// Card C8: an admin rebind wipes the stored refresh credential
// (refresh_token_encrypted = X'', the column is NOT NULL), so the account is
// idle until the next sign-in. Every reader treats a zero-length credential
// exactly like no credential at all.
describe("an emptied refresh credential (admin rebind, card C8)", () => {
  const tokens = { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" };
  const wipe = (email: string) =>
    env.DB.prepare("UPDATE identity_tokens SET refresh_token_encrypted = X'' WHERE account_email = ?").bind(email).run();
  const credBytes = async (email: string) =>
    (await env.DB.prepare("SELECT length(refresh_token_encrypted) AS n FROM identity_tokens WHERE account_email = ?")
      .bind(email).first<{ n: number }>())?.n;
  const neverRefreshes = (calls: string[]) => idpRefreshing(async (r) => {
    calls.push(r);
    return { accessToken: "at", expiresIn: 3600, refreshToken: "rot" };
  });
  /** Clear the anchor the way the admin rebind does (identity-rebind.ts). */
  const adminRebind = async (email: string) => {
    const target = await readRebindTarget(env.DB, email);
    expect(await clearIdentityAnchor(env.DB, email, target!)).toBe(true);
  };

  it("getAccessToken with no identity_tokens row throws IdentityCredentialMissingError, naming no email", async () => {
    const err = await getAccessToken(env, neverRefreshes([]), "ghost@example.com").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdentityCredentialMissingError);
    expect((err as Error).message).toBe("identity_credential_missing");
    expect(String(err)).not.toContain("ghost@example.com");
  });

  it("getAccessToken on an emptied credential throws IdentityCredentialMissingError without calling the IdP", async () => {
    await storeIdentityTokens(env, "wiped@example.com", tokens, "google", "sub-w");
    await dropCachedAccessToken(env, "wiped@example.com");
    await wipe("wiped@example.com");
    const calls: string[] = [];
    const err = await getAccessToken(env, neverRefreshes(calls), "wiped@example.com").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdentityCredentialMissingError);
    expect(String(err)).not.toContain("wiped@example.com");
    expect(calls).toEqual([]);
    expect(await readCachedAccessToken(env, "wiped@example.com")).toBeNull();
  });

  it("readRefreshToken returns null for an emptied credential", async () => {
    await storeIdentityTokens(env, "wiped@example.com", tokens, "google", "sub-w");
    expect(await readRefreshToken(env, "wiped@example.com")).toBe("r");
    await wipe("wiped@example.com");
    expect(await readRefreshToken(env, "wiped@example.com")).toBeNull();
  });

  it("hasStoredGrant is false for an emptied credential (anchored or legacy)", async () => {
    await storeIdentityTokens(env, "wiped@example.com", tokens, "google", "sub-w");
    await wipe("wiped@example.com");
    expect(await hasStoredGrant(env, "google", "sub-w", "wiped@example.com")).toBe(false);
    await env.DB.prepare(
      "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at) VALUES (?, X'', 's', '2026-01-01T00:00:00Z')",
    ).bind("legacy-wiped@example.com").run();
    expect(await hasStoredGrant(env, "google", "sub-l", "legacy-wiped@example.com")).toBe(false);
  });

  it("the next sign-in stores a credential again and getAccessToken works", async () => {
    await storeIdentityTokens(env, "back@example.com", tokens, "google", "sub-1");
    await adminRebind("back@example.com");
    await storeIdentityTokens(env, "back@example.com", { ...tokens, refreshToken: "r-new" }, "google", "sub-2");
    await dropCachedAccessToken(env, "back@example.com");
    const seen: string[] = [];
    expect(await getAccessToken(env, rotatingIdp(seen), "back@example.com")).toBe("at-1");
    expect(seen).toEqual(["r-new"]);
  });

  // The rebind of a legacy (NULL provider_subject) row leaves the anchor as
  // it was, so only the emptied credential tells an in-flight refresh that
  // the account was handed over.
  for (const [label, providerSubject] of [["legacy (NULL provider_subject)", undefined], ["anchored", "tid:oid-A"]] as const) {
    it(`${label}: a rebind landing while a rotating refresh is in flight never resurrects the credential`, async () => {
      const email = `mid-${providerSubject ? "a" : "l"}@example.com`;
      await storeIdentityTokens(env, email, tokens, "microsoft", providerSubject);
      await dropCachedAccessToken(env, email);
      const idp = idpRefreshing(async () => {
        await adminRebind(email);
        return { accessToken: "prev-at", expiresIn: 3600, refreshToken: "prev-rotated" };
      });
      const err = await getAccessToken(env, idp, email, { forceRefresh: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IdentityCredentialMissingError);
      expect(await credBytes(email)).toBe(0);
      expect(await readCachedAccessToken(env, email)).toBeNull();
    });

    it(`${label}: a rebind landing between the re-read and the rotated write-back matches nothing (CAS on the ciphertext)`, async () => {
      const email = `wb-${providerSubject ? "a" : "l"}@example.com`;
      await storeIdentityTokens(env, email, tokens, "microsoft", providerSubject);
      await dropCachedAccessToken(env, email);
      const raced = racedEnv(env, /SET refresh_token_encrypted = \?/, () => adminRebind(email));
      const idp = idpRefreshing(async () => ({ accessToken: "prev-at", expiresIn: 3600, refreshToken: "prev-rotated" }));
      const err = await getAccessToken(raced, idp, email, { forceRefresh: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IdentityCredentialMissingError);
      expect(await credBytes(email)).toBe(0);
      expect(await readCachedAccessToken(env, email)).toBeNull();
    });
  }

  it("legacy row, non-rotating (Google): a rebind between the re-read and the cache write drops the key and fails the call", async () => {
    await storeIdentityTokens(env, "kv-l@example.com", tokens, "google");
    await dropCachedAccessToken(env, "kv-l@example.com");
    const racedKv = putRacedEnv("kv-l@example.com", () => adminRebind("kv-l@example.com"));
    const idp = idpRefreshing(async () => ({ accessToken: "prev-at", expiresIn: 3600 }));
    const err = await getAccessToken(racedKv, idp, "kv-l@example.com", { forceRefresh: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdentityCredentialMissingError);
    expect(await readCachedAccessToken(env, "kv-l@example.com")).toBeNull();
  });

  it("a rotation by the SAME identity whose credential changed under it (a concurrent sign-in) is not written back", async () => {
    await storeIdentityTokens(env, "cas@example.com", tokens, "microsoft", "tid:oid-A");
    await dropCachedAccessToken(env, "cas@example.com");
    const raced = racedEnv(env, /SET refresh_token_encrypted = \?/, async () => {
      // The same person signs in again: same anchor, a fresh credential.
      await storeIdentityTokens(env, "cas@example.com", { ...tokens, refreshToken: "fresh" }, "microsoft", "tid:oid-A");
    });
    const idp = idpRefreshing(async () => ({ accessToken: "at", expiresIn: 3600, refreshToken: "stale-rotation" }));
    // Same identity, still holding a credential: the call succeeds, only the
    // stale rotation is dropped.
    expect(await getAccessToken(raced, idp, "cas@example.com", { forceRefresh: true })).toBe("at");
    expect(await readRefreshToken(env, "cas@example.com")).toBe("fresh");
  });

  // Microsoft rotates the refresh token on every use and keeps the old one
  // valid, so two refreshes of the same credential both succeed upstream. The
  // second write-back then finds the ciphertext already rotated by the first:
  // that is not a change of identity, and must not fail the call.
  it("two concurrent forced refreshes of a rotating (Microsoft) credential both resolve", async () => {
    await storeIdentityTokens(env, "par@example.com", tokens, "microsoft", "tid:oid-P");
    await dropCachedAccessToken(env, "par@example.com");
    let entered = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => { release = r; });
    let n = 0;
    const idp = idpRefreshing(async () => {
      const i = ++n;
      if (++entered === 2) release();
      await both; // both calls read the same ciphertext before either writes back
      return { accessToken: `at-${i}`, expiresIn: 3600, refreshToken: `rot-${i}` };
    });
    // allSettled: a rejection must not leave the other call's storage I/O
    // dangling past the test (isolated storage).
    const settled = await Promise.allSettled([
      getAccessToken(env, idp, "par@example.com", { forceRefresh: true }),
      getAccessToken(env, idp, "par@example.com", { forceRefresh: true }),
    ]);
    expect(settled.map((r) => (r.status === "fulfilled" ? r.value : String(r.reason))).sort()).toEqual(["at-1", "at-2"]);
    expect(["rot-1", "rot-2"]).toContain(await readRefreshToken(env, "par@example.com"));
  });
});
