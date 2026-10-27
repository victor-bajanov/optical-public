import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { storeIdentityTokens, resolveSubject, ProviderRebindRefusedError, readCachedAccessToken } from "../src/auth/identity-store";

const tokens = { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" };

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM identity_tokens").run();
  await env.DB.prepare("DELETE FROM users").run();
  await env.DB.prepare("DELETE FROM calendar_sync").run();
});

describe("resolveSubject", () => {
  it("first sign-in: no existing row, resolves to the token's email; store creates a row with provider_subject", async () => {
    const subject = await resolveSubject(env, "microsoft", "tid:oid-1", "alice@old.com");
    expect(subject).toBe("alice@old.com");
    await storeIdentityTokens(env, subject, tokens, "microsoft", "tid:oid-1");
    const row = await env.DB.prepare("SELECT account_email, provider_subject FROM identity_tokens WHERE account_email = ?")
      .bind("alice@old.com").first<{ account_email: string; provider_subject: string | null }>();
    expect(row).toEqual({ account_email: "alice@old.com", provider_subject: "tid:oid-1" });
  });

  it("same subject, changed email: resolves to the ORIGINAL account_email, no second row, and warns identity_email_drift", async () => {
    await storeIdentityTokens(env, "alice@old.com", tokens, "microsoft", "tid:oid-1");
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const subject = await resolveSubject(env, "microsoft", "tid:oid-1", "alice@new.com");
      expect(subject).toBe("alice@old.com");
      const line = spy.mock.calls.map((c) => c.map(String).join(" ")).find((l) => l.includes("identity_email_drift"));
      expect(line).toBeDefined();
      expect(line).toContain("provider=microsoft");
      // Field is `provider_subject=`, not `subject=` — everywhere else in
      // this codebase `subject` means the internal email key, so reusing it
      // here for the IdP's providerSubject value would be misleading.
      expect(line).toContain("provider_subject=tid:oid-1");
      expect(line).toContain("stored=alice@old.com");
      expect(line).toContain("token=alice@new.com");

      // The caller (oauth-provider.ts callback, G6) stores under the resolved
      // subject, not the token's new email.
      await storeIdentityTokens(env, subject, tokens, "microsoft", "tid:oid-1");
      const rows = await env.DB.prepare("SELECT account_email, provider_subject FROM identity_tokens").all<{ account_email: string; provider_subject: string | null }>();
      expect(rows.results).toEqual([{ account_email: "alice@old.com", provider_subject: "tid:oid-1" }]);
    } finally {
      spy.mockRestore();
    }
  });

  it("legacy row (NULL provider_subject) + matching email: no subject match, resolves to email, backfilled on store", async () => {
    await env.DB.prepare(
      "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider) VALUES (?,?,?,?,?)",
    ).bind("legacy@x.com", new Uint8Array([1]).buffer, "s", "2026-01-01T00:00:00Z", "google").run();

    const subject = await resolveSubject(env, "google", "google-sub-1", "legacy@x.com");
    expect(subject).toBe("legacy@x.com");
    await storeIdentityTokens(env, subject, tokens, "google", "google-sub-1");

    const row = await env.DB.prepare("SELECT provider_subject FROM identity_tokens WHERE account_email = ?")
      .bind("legacy@x.com").first<{ provider_subject: string | null }>();
    expect(row!.provider_subject).toBe("google-sub-1");
  });

  it("neither matches: first sign-in row is created with the new email as subject", async () => {
    const subject = await resolveSubject(env, "google", "brand-new-sub", "new@x.com");
    expect(subject).toBe("new@x.com");
  });

  it("does not warn when the resolved subject's email is unchanged", async () => {
    await storeIdentityTokens(env, "same@x.com", tokens, "microsoft", "tid:oid-same");
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const subject = await resolveSubject(env, "microsoft", "tid:oid-same", "same@x.com");
      expect(subject).toBe("same@x.com");
      expect(spy.mock.calls.some((c) => c.map(String).join(" ").includes("identity_email_drift"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("provider switch (same email, other IdP) still resets sync state and stores the new provider_subject", () => {
  it("resets calendar_sync/done_color_id and persists the new provider's provider_subject", async () => {
    await storeIdentityTokens(env, "sw@example.com", tokens, "google", "google-sub-sw");
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES (?,?,?,?,?,?,?,?)",
    ).bind("sw@example.com", "primary", "CPJ-google-token", "chan-1", "tok-1", "2027-01-01T00:00:00Z", "res-1", "https://x/cb").run();
    await env.DB.prepare("UPDATE users SET done_color_id = ? WHERE subject = ?").bind("11", "sw@example.com").run();

    const subject = await resolveSubject(env, "microsoft", "tid:oid-sw", "sw@example.com");
    expect(subject).toBe("sw@example.com"); // different provider => no subject-row match under 'microsoft'
    await storeIdentityTokens(env, subject, tokens, "microsoft", "tid:oid-sw");

    const sync = await env.DB.prepare("SELECT next_sync_token, channel_id FROM calendar_sync WHERE owner_subject = ?")
      .bind("sw@example.com").first<Record<string, unknown>>();
    expect(sync).toEqual({ next_sync_token: null, channel_id: null });
    const user = await env.DB.prepare("SELECT done_color_id FROM users WHERE subject = ?").bind("sw@example.com").first<{ done_color_id: string | null }>();
    expect(user!.done_color_id).toBeNull();
    const row = await env.DB.prepare("SELECT provider, provider_subject FROM identity_tokens WHERE account_email = ?")
      .bind("sw@example.com").first<{ provider: string; provider_subject: string | null }>();
    expect(row).toEqual({ provider: "microsoft", provider_subject: "tid:oid-sw" });
  });
});

describe("storeIdentityTokens write-time invariant (G8.1): a provider_subject collision must not silently delete the other row", () => {
  it("rejects instead of clobbering B's row when A's write collides on (provider, provider_subject)", async () => {
    // A: a legacy row, no provider_subject yet.
    await env.DB.prepare(
      "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider) VALUES (?,?,?,?,?)",
    ).bind("a@x.com", new Uint8Array([9]).buffer, "s", "2026-01-01T00:00:00Z", "microsoft").run();
    // B already legitimately owns (microsoft, tid:oid-shared).
    await storeIdentityTokens(env, "b@x.com", tokens, "microsoft", "tid:oid-shared");

    // The callback can't reach this today (resolveSubject would find B
    // first and resolve to b@x.com) — this exercises the write-path
    // invariant directly, in case some other caller ever calls
    // storeIdentityTokens without going through resolveSubject.
    await expect(
      storeIdentityTokens(env, "a@x.com", tokens, "microsoft", "tid:oid-shared"),
    ).rejects.toThrow();

    const rowB = await env.DB.prepare(
      "SELECT account_email, provider_subject, refresh_token_encrypted FROM identity_tokens WHERE account_email = ?",
    ).bind("b@x.com").first<{ account_email: string; provider_subject: string | null; refresh_token_encrypted: ArrayBuffer }>();
    expect(rowB?.account_email).toBe("b@x.com");
    expect(rowB?.provider_subject).toBe("tid:oid-shared");
    expect(rowB?.refresh_token_encrypted).toBeTruthy(); // credential intact, not deleted
  });
});

describe("storeIdentityTokens logs identity_subject_rebound (G8.2)", () => {
  it("warns when the same account_email + provider gets a DIFFERENT provider_subject (IdP-side account re-creation)", async () => {
    await storeIdentityTokens(env, "a@x.com", tokens, "microsoft", "S1");
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await storeIdentityTokens(env, "a@x.com", tokens, "microsoft", "S2");
      const line = spy.mock.calls.map((c) => c.map(String).join(" ")).find((l) => l.includes("identity_subject_rebound"));
      expect(line).toBeDefined();
      expect(line).toContain("provider=microsoft");
      expect(line).toContain("email=a@x.com");
      expect(line).toContain("old=S1");
      expect(line).toContain("new=S2");
    } finally {
      spy.mockRestore();
    }
  });

  it("does not warn on backfill (prior provider_subject NULL -> a value)", async () => {
    await env.DB.prepare(
      "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider) VALUES (?,?,?,?,?)",
    ).bind("legacy@x.com", new Uint8Array([1]).buffer, "s", "2026-01-01T00:00:00Z", "google").run();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await storeIdentityTokens(env, "legacy@x.com", tokens, "google", "fresh-sub");
      expect(spy.mock.calls.some((c) => c.map(String).join(" ").includes("identity_subject_rebound"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not warn when the provider_subject is unchanged", async () => {
    await storeIdentityTokens(env, "same@x.com", tokens, "microsoft", "S-same");
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await storeIdentityTokens(env, "same@x.com", tokens, "microsoft", "S-same");
      expect(spy.mock.calls.some((c) => c.map(String).join(" ").includes("identity_subject_rebound"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("rule 6 conflict: subject row wins over an unrelated email row under the same provider", () => {
  it("resolves to the subject row's account_email and leaves the other row untouched", async () => {
    // Row A: signed in first under tid:oid-A, key a@x.com.
    await storeIdentityTokens(env, "a@x.com", tokens, "microsoft", "tid:oid-A");
    // Row B: an unrelated user, b@x.com, with its own row under the same provider.
    await storeIdentityTokens(env, "b@x.com", tokens, "microsoft", "tid:oid-B");

    // Now the token for tid:oid-A comes back claiming email b@x.com (A renamed
    // to collide with B's existing address).
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const subject = await resolveSubject(env, "microsoft", "tid:oid-A", "b@x.com");
      expect(subject).toBe("a@x.com"); // subject match wins
    } finally {
      spy.mockRestore();
    }

    const rowB = await env.DB.prepare("SELECT account_email, provider_subject FROM identity_tokens WHERE account_email = ?")
      .bind("b@x.com").first<{ account_email: string; provider_subject: string | null }>();
    expect(rowB).toEqual({ account_email: "b@x.com", provider_subject: "tid:oid-B" }); // untouched
  });
});

// Decision D (trial): REFUSE_PROVIDER_REBIND exactly "true" refuses to rebind
// an account whose stored provider_subject is set to a DIFFERENT IdP identity
// (another subject, or another provider). Nothing is written or reset.
describe("storeIdentityTokens with REFUSE_PROVIDER_REBIND", () => {
  const on = () => ({ ...env, REFUSE_PROVIDER_REBIND: "true" }) as typeof env;
  const seedSync = (owner: string) => env.DB.prepare(
    "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES (?,?,?,?,?,?,?,?)",
  ).bind(owner, "primary", "SYNC-TOKEN", "chan-1", "tok-1", "2027-01-01T00:00:00Z", "res-1", "https://x/cb").run();
  const seedBound = async (email: string, provider: string, providerSubject: string | null) => {
    await env.DB.prepare(
      "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject) VALUES (?,?,?,?,?,?)",
    ).bind(email, new Uint8Array([7, 7]).buffer, "stored", "2026-01-01T00:00:00Z", provider, providerSubject).run();
    await env.DB.prepare("INSERT INTO users (subject, role, is_active, last_seen, created_at, done_color_id) VALUES (?,?,?,?,?,?)")
      .bind(email, "member", 1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00Z", "11").run();
  };
  const snapshot = async (email: string) => ({
    tokens: await env.DB.prepare("SELECT hex(refresh_token_encrypted) AS enc, scopes, updated_at, provider, provider_subject FROM identity_tokens WHERE account_email = ?")
      .bind(email).first(),
    user: await env.DB.prepare("SELECT role, is_active, last_seen, done_color_id FROM users WHERE subject = ?").bind(email).first(),
    sync: await env.DB.prepare("SELECT next_sync_token, channel_id FROM calendar_sync WHERE owner_subject = ?").bind(email).first(),
    cached: await readCachedAccessToken(env, email),
  });

  for (const provider of ["google", "microsoft"] as const) {
    const other = provider === "google" ? "microsoft" : "google";

    it(`${provider}: same provider, different stored provider_subject -> ProviderRebindRefusedError (mismatch subject), nothing written`, async () => {
      await seedBound("own@x.com", provider, "owner-sub");
      await seedSync("own@x.com");
      const before = await snapshot("own@x.com");
      const err = await storeIdentityTokens(on(), "own@x.com", tokens, provider, "intruder-sub").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderRebindRefusedError);
      expect((err as ProviderRebindRefusedError).mismatch).toBe("subject");
      expect(await snapshot("own@x.com")).toEqual(before);
    });

    it(`${provider}: stored under the OTHER provider with a provider_subject -> refused (mismatch provider), no sync reset, done colour kept`, async () => {
      await seedBound("own@x.com", other, "owner-sub");
      await seedSync("own@x.com");
      const before = await snapshot("own@x.com");
      const err = await storeIdentityTokens(on(), "own@x.com", tokens, provider, "owner-sub").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderRebindRefusedError);
      expect((err as ProviderRebindRefusedError).mismatch).toBe("provider");
      expect(await snapshot("own@x.com")).toEqual(before);
      expect(before.sync).toEqual({ next_sync_token: "SYNC-TOKEN", channel_id: "chan-1" });
    });

    it(`${provider}: the same bound identity signs in again -> stored normally`, async () => {
      await seedBound("own@x.com", provider, "owner-sub");
      await storeIdentityTokens(on(), "own@x.com", tokens, provider, "owner-sub");
      const row = await env.DB.prepare("SELECT scopes, provider_subject FROM identity_tokens WHERE account_email = ?")
        .bind("own@x.com").first();
      expect(row).toEqual({ scopes: "s", provider_subject: "owner-sub" });
    });

    it(`${provider}: legacy row with NULL provider_subject still binds (backfill)`, async () => {
      await seedBound("legacy@x.com", provider, null);
      await storeIdentityTokens(on(), "legacy@x.com", tokens, provider, "first-sub");
      const row = await env.DB.prepare("SELECT provider, provider_subject FROM identity_tokens WHERE account_email = ?")
        .bind("legacy@x.com").first();
      expect(row).toEqual({ provider, provider_subject: "first-sub" });
    });

    it(`${provider}: no prior row -> first sign-in stores`, async () => {
      await storeIdentityTokens(on(), "new@x.com", tokens, provider, "new-sub");
      expect(await env.DB.prepare("SELECT provider_subject FROM identity_tokens WHERE account_email = ?").bind("new@x.com").first())
        .toEqual({ provider_subject: "new-sub" });
    });

    it(`${provider}: a concurrent first bind that lands between the pre-check and the write is refused by the guarded upsert`, async () => {
      // Two first sign-ins for one email race: both pre-checks see no row.
      // Simulate the loser: its pre-check read is stale (null) while the
      // winner's row is already committed. The upsert itself must refuse.
      await seedBound("race@x.com", provider, "winner-sub");
      const before = await snapshot("race@x.com");
      const err = await storeIdentityTokens(staleReadEnv(on()), "race@x.com", tokens, provider, "loser-sub").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderRebindRefusedError);
      expect(await snapshot("race@x.com")).toEqual(before);
    });
  }

  it("flag off (unset, \"TRUE\", \"1\"): today's rebind behaviour, overwrites the stored provider_subject", async () => {
    for (const v of [undefined, "TRUE", "1", "false"]) {
      await env.DB.prepare("DELETE FROM identity_tokens").run();
      await env.DB.prepare("DELETE FROM users").run();
      await seedBound("own@x.com", "google", "owner-sub");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await storeIdentityTokens({ ...env, REFUSE_PROVIDER_REBIND: v } as typeof env, "own@x.com", tokens, "google", "other-sub");
      } finally {
        warn.mockRestore();
      }
      expect(await env.DB.prepare("SELECT provider_subject FROM identity_tokens WHERE account_email = ?").bind("own@x.com").first(), String(v))
        .toEqual({ provider_subject: "other-sub" });
    }
  });
});

/** env whose D1 answers the storeIdentityTokens pre-check read with null (a
 *  stale view), every other statement passing through to the real D1. */
function staleReadEnv(e: typeof env): typeof env {
  const db = e.DB;
  const DB = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => sql.includes("SELECT provider, provider_subject FROM identity_tokens")
          ? { bind: () => ({ first: async () => null }) }
          : target.prepare(sql);
      }
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { ...e, DB } as typeof env;
}
