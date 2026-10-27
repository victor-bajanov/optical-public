import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../src/env";
import type { AppVariables } from "../../src/index-providers";
import { mountIdentityRebindRoute } from "../../src/admin/identity-rebind-route";
import { upsertUser } from "../../src/db/users";
import { hashToken } from "../../src/auth/tokens";
import { hashingKey } from "../../src/auth/crypto-keys";
import {
  storeIdentityTokens, ProviderRebindRefusedError, cacheAccessToken, readCachedAccessToken,
} from "../../src/auth/identity-store";
import { __setIdentityProviderForTests, type IdentityProvider } from "../../src/auth/identity-provider";

// POST /admin/identity-rebind (plan 2026-10-23-identity-port-105, decision 9).
// Rows are seeded by SQL: the store does not take login_email in this task.

const ADMIN = "admin@example.com";
const tokens = { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" };

async function seedBearer(token: string, subject: string, scopes: string) {
  const h = await hashToken(token, hashingKey(env));
  await env.DB.prepare(`INSERT OR REPLACE INTO oauth_clients (id,name,type,redirect_uris,allowed_scopes,created_at) VALUES ('c','t','pkce',NULL,'scheduler:read scheduler:write admin','2026-01-01')`).run();
  await env.DB.prepare(`INSERT OR REPLACE INTO oauth_tokens (hashed_token,client_id,scopes,expires_at,refresh_of,revoked_at,subject) VALUES (?,?,?,?,?,?,?)`)
    .bind(h, "c", scopes, "2099-01-01T00:00:00Z", null, null, subject).run();
}

async function asAdmin() {
  await upsertUser(env.DB, ADMIN, "admin");
  await seedBearer("tok", ADMIN, "scheduler:read scheduler:write admin");
}

async function seedIdentity(
  subject: string,
  opts: { provider?: string; providerSubject?: string | null; loginEmail?: string | null } = {},
) {
  await env.DB.prepare(
    `INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject, login_email)
     VALUES (?, X'0102', 's', '2026-10-01T00:00:00Z', ?, ?, ?)`,
  ).bind(subject, opts.provider ?? "google", opts.providerSubject === undefined ? "sub-old" : opts.providerSubject, opts.loginEmail ?? null).run();
}

async function seedSync(subject: string) {
  await env.DB.prepare(
    `INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url)
     VALUES (?, 'primary', 'sync-tok', 'chan-1', 'chan-tok', '2099-01-01T00:00:00Z', 'res-1', 'https://cb.example.com/hook')`,
  ).bind(subject).run();
}

function makeApp() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  mountIdentityRebindRoute(app);
  return app;
}

function post(body: unknown, opts: { token?: string; env?: Env } = {}) {
  return makeApp().request("/admin/identity-rebind", {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.token ?? "tok"}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }, opts.env ?? env);
}

const identityRow = (subject: string) => env.DB.prepare(
  "SELECT provider, provider_subject, login_email, hex(refresh_token_encrypted) AS cred FROM identity_tokens WHERE account_email = ?",
).bind(subject).first<{ provider: string; provider_subject: string | null; login_email: string | null; cred: string }>();

const syncRow = (subject: string) => env.DB.prepare(
  `SELECT next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url
     FROM calendar_sync WHERE owner_subject = ?`,
).bind(subject).first<Record<string, string | null>>();

const auditRows = () => env.DB.prepare("SELECT subject, actor, action, table_name, source FROM audit_log").all().then((r) => r.results);

beforeEach(async () => {
  for (const t of ["users", "identity_tokens", "oauth_tokens", "oauth_clients", "oauth_codes", "calendar_sync", "audit_log", "pending_actions"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  __setIdentityProviderForTests(null);
});

describe("POST /admin/identity-rebind: auth", () => {
  it("is mounted on the top-level app (401 without a bearer, not 404)", async () => {
    const res = await SELF.fetch("https://x/admin/identity-rebind", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("401 without a bearer", async () => {
    const res = await makeApp().request("/admin/identity-rebind", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });

  it("403 for a member bearer, anchor untouched", async () => {
    await upsertUser(env.DB, "member@example.com");
    await seedBearer("tok", "member@example.com", "scheduler:read scheduler:write admin");
    await seedIdentity("alice@example.com");
    expect((await post({ subject: "alice@example.com" })).status).toBe(403);
    expect((await identityRow("alice@example.com"))!.provider_subject).toBe("sub-old");
  });

  it("403 insufficient_scope for an admin bearer without the admin scope", async () => {
    await upsertUser(env.DB, ADMIN, "admin");
    await seedBearer("tok", ADMIN, "scheduler:read scheduler:write");
    await seedIdentity("alice@example.com");
    const res = await post({ subject: "alice@example.com" });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe("insufficient_scope");
    expect((await identityRow("alice@example.com"))!.provider_subject).toBe("sub-old");
  });
});

describe("POST /admin/identity-rebind: validation and resolution", () => {
  it("400 validation_failed for {}, a blank subject, a non-string subject, non-JSON and a non-boolean force", async () => {
    await asAdmin();
    for (const body of [{}, { subject: "   " }, { subject: 42 }, "not json", { subject: "a@example.com", force: "yes" }]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const json = await res.json() as { error: string; issues: unknown[] };
      expect(json.error).toBe("validation_failed");
      expect(Array.isArray(json.issues)).toBe(true);
    }
  });

  it("404 unknown_subject when no users row and no identity_tokens row match", async () => {
    await asAdmin();
    const res = await post({ subject: "nobody@example.com" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_subject" });
    expect(await auditRows()).toEqual([]);
  });

  it("404 unknown_subject when a users row exists but no identity_tokens row", async () => {
    await asAdmin();
    await upsertUser(env.DB, "nocred@example.com");
    const res = await post({ subject: "nocred@example.com" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_subject" });
    expect(await auditRows()).toEqual([]);
  });

  it("409 ambiguous_subject for two case-variant rows, nothing cleared", async () => {
    await asAdmin();
    await seedIdentity("Bob@example.com", { providerSubject: "sub-1" });
    await seedIdentity("bob@example.com", { providerSubject: "sub-2" });
    const res = await post({ subject: "BOB@example.com" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "ambiguous_subject" });
    expect((await identityRow("Bob@example.com"))!.provider_subject).toBe("sub-1");
    expect((await identityRow("bob@example.com"))!.provider_subject).toBe("sub-2");
    expect(await auditRows()).toEqual([]);
  });
});

describe("POST /admin/identity-rebind: clearing the anchor", () => {
  it("resolves a padded, mixed-case subject to the stored one, clears the anchor and sync state, wipes the credential, keeps the done colour, audits once", async () => {
    await asAdmin();
    await upsertUser(env.DB, "alice@example.com");
    await env.DB.prepare("UPDATE users SET done_color_id = '11' WHERE subject = ?").bind("alice@example.com").run();
    await seedIdentity("alice@example.com", { providerSubject: "sub-alice", loginEmail: "alice@example.com" });
    await seedSync("alice@example.com");

    const res = await post({ subject: "  Alice@Example.com " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      subject: "alice@example.com",
      previous_provider: "google",
      previous_provider_subject: "sub-alice",
      login_email: "alice@example.com",
      forced: false,
    });

    const row = await identityRow("alice@example.com");
    // The row stays (provider and login_email for the next sign-in and owner
    // mail); its credential is a zero-length blob, so nothing refreshes.
    expect(row).toEqual({ provider: "google", provider_subject: null, login_email: "alice@example.com", cred: "" });
    expect(await syncRow("alice@example.com")).toEqual({
      next_sync_token: null, channel_id: null, channel_token: null,
      channel_expires_at: null, channel_resource_id: null, channel_callback_url: null,
    });
    const user = await env.DB.prepare("SELECT done_color_id FROM users WHERE subject = ?").bind("alice@example.com").first<{ done_color_id: string | null }>();
    expect(user!.done_color_id).toBe("11");
    expect(await auditRows()).toEqual([
      { subject: "alice@example.com", actor: ADMIN, action: "identity_rebind", table_name: "identity_tokens", source: "admin" },
    ]);
  });

  it("leaves another subject's sync state alone", async () => {
    await asAdmin();
    await seedIdentity("alice@example.com");
    await seedSync("alice@example.com");
    await seedIdentity("carol@example.com", { providerSubject: "sub-carol" });
    await env.DB.prepare(
      `INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id) VALUES (?, 'primary', 'carol-tok', 'chan-carol')`,
    ).bind("carol@example.com").run();
    expect((await post({ subject: "alice@example.com" })).status).toBe(200);
    expect(await syncRow("carol@example.com")).toMatchObject({ next_sync_token: "carol-tok", channel_id: "chan-carol" });
    expect((await identityRow("carol@example.com"))!.provider_subject).toBe("sub-carol");
  });

  it("reports a microsoft row's provider", async () => {
    await asAdmin();
    await seedIdentity("ms@example.org", { provider: "microsoft", providerSubject: "tid:oid" });
    const res = await post({ subject: "ms@example.org" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ previous_provider: "microsoft", previous_provider_subject: "tid:oid", login_email: null });
  });

  it("wipes the credential of a legacy row whose provider_subject is already NULL", async () => {
    await asAdmin();
    await seedIdentity("legacy@example.com", { providerSubject: null });
    expect((await post({ subject: "legacy@example.com" })).status).toBe(200);
    expect((await identityRow("legacy@example.com"))!.cred).toBe("");
  });

  it("409 subject_drifted leaves the credential in place", async () => {
    await asAdmin();
    await seedIdentity("old@example.com", { providerSubject: "sub-old", loginEmail: "new@example.org" });
    expect((await post({ subject: "old@example.com" })).status).toBe(409);
    expect((await identityRow("old@example.com"))!.cred).toBe("0102");
  });

  it("is idempotent on an already-unanchored row (previous_provider_subject null, had_anchor false)", async () => {
    await asAdmin();
    await seedIdentity("legacy@example.com", { providerSubject: null });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post({ subject: "legacy@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, previous_provider: "google", previous_provider_subject: null, forced: false });
    const cleared = warn.mock.calls.find((c) => c[0] === "identity_rebind_cleared");
    expect(cleared?.[1]).toEqual({ provider: "google", had_anchor: false, forced: false });
  });
});

describe("POST /admin/identity-rebind: REFUSE_PROVIDER_REBIND=true", () => {
  const refusing = () => ({ ...env, REFUSE_PROVIDER_REBIND: "true" }) as Env;

  it("a sign-in by another identity is refused before the rebind and anchors after it", async () => {
    await asAdmin();
    await seedIdentity("alice@example.com", { providerSubject: "sub-alice" });
    await expect(storeIdentityTokens(refusing(), "alice@example.com", tokens, "google", "sub-new"))
      .rejects.toBeInstanceOf(ProviderRebindRefusedError);

    expect((await post({ subject: "alice@example.com" }, { env: refusing() })).status).toBe(200);

    await storeIdentityTokens(refusing(), "alice@example.com", tokens, "google", "sub-new");
    expect((await identityRow("alice@example.com"))!.provider_subject).toBe("sub-new");
  });

  it("after a rebind, a cross-provider bind also clears done_color_id", async () => {
    await asAdmin();
    await upsertUser(env.DB, "sw@example.com");
    await env.DB.prepare("UPDATE users SET done_color_id = '11' WHERE subject = ?").bind("sw@example.com").run();
    await seedIdentity("sw@example.com", { providerSubject: "sub-g" });

    expect((await post({ subject: "sw@example.com" }, { env: refusing() })).status).toBe(200);
    // The rebind itself keeps the colour (same-provider colour ids stay meaningful).
    const kept = await env.DB.prepare("SELECT done_color_id FROM users WHERE subject = ?").bind("sw@example.com").first<{ done_color_id: string | null }>();
    expect(kept!.done_color_id).toBe("11");

    await storeIdentityTokens(refusing(), "sw@example.com", tokens, "microsoft", "tid:oid");
    const row = await identityRow("sw@example.com");
    expect({ provider: row!.provider, provider_subject: row!.provider_subject }).toEqual({ provider: "microsoft", provider_subject: "tid:oid" });
    const user = await env.DB.prepare("SELECT done_color_id FROM users WHERE subject = ?").bind("sw@example.com").first<{ done_color_id: string | null }>();
    expect(user!.done_color_id).toBeNull();
  });
});

describe("POST /admin/identity-rebind: renamed owner (login_email drift)", () => {
  async function seedRenamed() {
    await asAdmin();
    await seedIdentity("old@example.com", { providerSubject: "sub-old", loginEmail: "new@example.org" });
    await seedSync("old@example.com");
  }

  it("409 subject_drifted without force: no write and no audit", async () => {
    await seedRenamed();
    const res = await post({ subject: "old@example.com" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "subject_drifted", subject: "old@example.com", login_email: "new@example.org" });
    expect((await identityRow("old@example.com"))!.provider_subject).toBe("sub-old");
    expect((await syncRow("old@example.com"))!.next_sync_token).toBe("sync-tok");
    expect(await auditRows()).toEqual([]);
  });

  it("force:false is the same as no force", async () => {
    await seedRenamed();
    expect((await post({ subject: "old@example.com", force: false })).status).toBe(409);
    expect((await identityRow("old@example.com"))!.provider_subject).toBe("sub-old");
  });

  it("a case-only difference is not drift", async () => {
    await asAdmin();
    await seedIdentity("same@example.com", { providerSubject: "sub-s", loginEmail: "Same@Example.COM" });
    const res = await post({ subject: "same@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ forced: false, login_email: "Same@Example.COM" });
  });

  it("an empty login_email is not drift (it falls back to the subject)", async () => {
    await asAdmin();
    await seedIdentity("blank@example.com", { providerSubject: "sub-b", loginEmail: "" });
    expect((await post({ subject: "blank@example.com" })).status).toBe(200);
  });

  it("force:true clears, returns forced:true and audits identity_rebind_forced", async () => {
    await seedRenamed();
    const res = await post({ subject: "old@example.com", force: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      subject: "old@example.com",
      previous_provider: "google",
      previous_provider_subject: "sub-old",
      login_email: "new@example.org",
      forced: true,
    });
    expect((await identityRow("old@example.com"))!.provider_subject).toBeNull();
    expect((await syncRow("old@example.com"))!.next_sync_token).toBeNull();
    expect(await auditRows()).toEqual([
      { subject: "old@example.com", actor: ADMIN, action: "identity_rebind_forced", table_name: "identity_tokens", source: "admin" },
    ]);
  });

  it("force:true on a row that has not drifted is an ordinary rebind (forced:false)", async () => {
    await asAdmin();
    await seedIdentity("alice@example.com", { providerSubject: "sub-alice", loginEmail: "alice@example.com" });
    const res = await post({ subject: "alice@example.com", force: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ forced: false });
    expect((await auditRows())[0]).toMatchObject({ action: "identity_rebind" });
  });
});

describe("POST /admin/identity-rebind: a concurrent sign-in between the read and the clear", () => {
  // The drift decision is made on a read; the clear is a compare-and-set on
  // that read, so a sign-in that lands in between is never overwritten blind.
  function racingEnv(race: () => Promise<void>): Env {
    let raced = false;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            if (!raced) { raced = true; await race(); }
            return target.batch(stmts);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    return { ...env, DB: db } as Env;
  }

  it("409 concurrent_update with no write and no audit when the row changed after the read", async () => {
    await asAdmin();
    await seedIdentity("alice@example.com", { providerSubject: "sub-alice", loginEmail: "alice@example.com" });
    await seedSync("alice@example.com");
    const racer = racingEnv(async () => {
      // The owner signs in under a renamed address meanwhile: now drifted.
      await env.DB.prepare("UPDATE identity_tokens SET login_email = 'renamed@example.org' WHERE account_email = ?")
        .bind("alice@example.com").run();
    });
    const res = await post({ subject: "alice@example.com" }, { env: racer });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "concurrent_update" });
    expect((await identityRow("alice@example.com"))!.provider_subject).toBe("sub-alice");
    expect((await identityRow("alice@example.com"))!.cred).toBe("0102");
    expect((await syncRow("alice@example.com"))!.next_sync_token).toBe("sync-tok");
    expect(await auditRows()).toEqual([]);
  });

  it("409 concurrent_update when the row was offboarded after the read", async () => {
    await asAdmin();
    await seedIdentity("alice@example.com", { providerSubject: "sub-alice" });
    const racer = racingEnv(async () => {
      await env.DB.prepare("DELETE FROM identity_tokens WHERE account_email = ?").bind("alice@example.com").run();
    });
    const res = await post({ subject: "alice@example.com" }, { env: racer });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "concurrent_update" });
    expect(await auditRows()).toEqual([]);
  });
});

describe("POST /admin/identity-rebind: logs are PII-free", () => {
  it("logs identity_rebind_cleared / identity_rebind_drift_refused with no subject, login email or provider_subject", async () => {
    await asAdmin();
    await seedIdentity("old@example.com", { providerSubject: "sub-secret-old", loginEmail: "new@example.org" });
    await seedIdentity("plain@example.com", { providerSubject: "sub-secret-plain", loginEmail: "plain@example.com" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await post({ subject: "old@example.com" })).status).toBe(409);
    expect((await post({ subject: "old@example.com", force: true })).status).toBe(200);
    expect((await post({ subject: "Plain@Example.com" })).status).toBe(200);

    const drift = warn.mock.calls.filter((c) => c[0] === "identity_rebind_drift_refused");
    expect(drift).toEqual([["identity_rebind_drift_refused", { provider: "google" }]]);
    const cleared = warn.mock.calls.filter((c) => c[0] === "identity_rebind_cleared");
    expect(cleared).toEqual([
      ["identity_rebind_cleared", { provider: "google", had_anchor: true, forced: true }],
      ["identity_rebind_cleared", { provider: "google", had_anchor: true, forced: false }],
    ]);

    const everything = [...warn.mock.calls, ...log.mock.calls, ...error.mock.calls]
      .map((c) => c.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
      .join("\n")
      .toLowerCase();
    for (const pii of ["old@example.com", "new@example.org", "plain@example.com", "sub-secret-old", "sub-secret-plain", ADMIN]) {
      expect(everything).not.toContain(pii);
    }
  });
});

describe("POST /admin/identity-rebind: the previous holder's Optical sessions do not survive the handover", () => {
  it("revokes every oauth_tokens row of the subject (access and refresh) and drops its pending_actions", async () => {
    await asAdmin();
    await upsertUser(env.DB, "alice@example.com");
    await seedIdentity("alice@example.com", { providerSubject: "sub-old", loginEmail: "alice@example.com" });
    await seedBearer("alice-access", "alice@example.com", "scheduler:read scheduler:write");
    const h = await hashToken("alice-refresh", hashingKey(env));
    await env.DB.prepare(
      `INSERT INTO oauth_tokens (hashed_token,client_id,scopes,expires_at,refresh_of,revoked_at,subject) VALUES (?,?,?,?,?,?,?)`,
    ).bind(h, "c", "scheduler:read scheduler:write", null, "x", null, "alice@example.com").run();
    await env.DB.prepare(
      `INSERT INTO pending_actions (id, owner_subject, op, payload, summary, created_at, expires_at)
       VALUES ('pa1', 'alice@example.com', 'commit', '{}', '{}', '2026-10-01T00:00:00Z', '2099-01-01T00:00:00Z')`,
    ).run();
    await seedCode("alice@example.com");

    expect((await post({ subject: "alice@example.com" })).status).toBe(200);
    // Identity B binds the address.
    await storeIdentityTokens(env, "alice@example.com", tokens, "google", "sub-new");

    const live = await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_tokens WHERE subject = ? AND revoked_at IS NULL")
      .bind("alice@example.com").first<{ n: number }>();
    expect(live!.n).toBe(0);
    const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE owner_subject = ?")
      .bind("alice@example.com").first<{ n: number }>();
    expect(pending!.n).toBe(0);
    expect(await codeCount("alice@example.com")).toBe(0);
    // The old bearer no longer authenticates as the account.
    const res = await makeApp().request("/admin/identity-rebind", {
      method: "POST",
      headers: { Authorization: "Bearer alice-access", "content-type": "application/json" },
      body: JSON.stringify({ subject: "alice@example.com" }),
    }, env);
    expect(res.status).toBe(401);
  });

  it("leaves other subjects' sessions, codes and pending actions alone", async () => {
    await asAdmin();
    await seedIdentity("alice@example.com", { providerSubject: "sub-old" });
    await seedSessions("carol@example.com");
    expect((await post({ subject: "alice@example.com" })).status).toBe(200);
    expect(await sessionCounts("carol@example.com")).toEqual({ live: 1, pending: 1, codes: 1 });
    // The admin's own bearer is untouched too.
    const admin = await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_tokens WHERE subject = ? AND revoked_at IS NULL")
      .bind(ADMIN).first<{ n: number }>();
    expect(admin!.n).toBe(1);
  });

  it("409 subject_drifted leaves the subject's sessions live", async () => {
    await asAdmin();
    await seedIdentity("old@example.com", { providerSubject: "sub-old", loginEmail: "new@example.org" });
    await seedSessions("old@example.com");
    expect((await post({ subject: "old@example.com" })).status).toBe(409);
    expect(await sessionCounts("old@example.com")).toEqual({ live: 1, pending: 1, codes: 1 });
  });

  it("409 concurrent_update leaves the subject's sessions live", async () => {
    await asAdmin();
    await seedIdentity("alice@example.com", { providerSubject: "sub-alice", loginEmail: "alice@example.com" });
    await seedSessions("alice@example.com");
    let raced = false;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await env.DB.prepare("UPDATE identity_tokens SET login_email = 'renamed@example.org' WHERE account_email = ?")
                .bind("alice@example.com").run();
            }
            return target.batch(stmts);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const res = await post({ subject: "alice@example.com" }, { env: { ...env, DB: db } as Env });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "concurrent_update" });
    expect(await sessionCounts("alice@example.com")).toEqual({ live: 1, pending: 1, codes: 1 });
  });
});

// OAuth verification hardening, card C1: a 200 rebind drops the previous
// holder's cached IdP access token, which would otherwise serve calendar calls
// for up to an hour after the credential itself was wiped (card C8).
describe("POST /admin/identity-rebind: the previous holder's cached IdP access token", () => {
  async function seedCached(subject: string) {
    await cacheAccessToken(env, subject, "AT-previous-holder", 3600);
    await env.GOOGLE_TOKEN_CACHE.put(`idp_access_token:${subject}`, "AT-legacy", { expirationTtl: 600 });
  }

  it("a failing cache drop still answers 200, audits and leaves the anchor cleared, logging no error text", async () => {
    await asAdmin();
    await seedIdentity("alice@example.com", { providerSubject: "sub-alice", loginEmail: "alice@example.com" });
    await seedCached("alice@example.com");
    const kv = new Proxy(env.GOOGLE_TOKEN_CACHE, {
      get(target, prop) {
        if (prop === "delete") {
          return async (key: string) => { throw new Error(`kv delete failed for ${key}`); };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ subject: "alice@example.com" }, { env: { ...env, GOOGLE_TOKEN_CACHE: kv } as Env });
    expect(res.status).toBe(200);
    expect((await identityRow("alice@example.com"))!.provider_subject).toBeNull();
    expect(await auditRows()).toEqual([
      { subject: "alice@example.com", actor: ADMIN, action: "identity_rebind", table_name: "identity_tokens", source: "admin" },
    ]);
    const calls = [...warn.mock.calls, ...error.mock.calls];
    expect(calls.some((c) => c[0] === "identity_rebind_cache_drop_failed")).toBe(true);
    const logged = calls.map((c) => c.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")).join("\n");
    expect(logged).not.toContain("alice@example.com");
    expect(logged).not.toContain("kv delete failed");
  });

  it("a 200 rebind drops it (the encrypted entry and a legacy plaintext one)", async () => {
    await asAdmin();
    await seedIdentity("alice@example.com", { providerSubject: "sub-alice", loginEmail: "alice@example.com" });
    await seedCached("alice@example.com");
    await cacheAccessToken(env, "carol@example.com", "AT-carol", 3600);
    expect((await post({ subject: "alice@example.com" })).status).toBe(200);
    expect(await readCachedAccessToken(env, "alice@example.com")).toBeNull();
    expect(await env.GOOGLE_TOKEN_CACHE.get("idp_access_token:alice@example.com")).toBeNull();
    expect(await readCachedAccessToken(env, "carol@example.com")).toBe("AT-carol");
  });

  it("409 subject_drifted leaves it in place", async () => {
    await asAdmin();
    await seedIdentity("old@example.com", { providerSubject: "sub-old", loginEmail: "new@example.org" });
    await seedCached("old@example.com");
    expect((await post({ subject: "old@example.com" })).status).toBe(409);
    expect(await readCachedAccessToken(env, "old@example.com")).toBe("AT-previous-holder");
  });

  it("409 concurrent_update leaves it in place", async () => {
    await asAdmin();
    await seedIdentity("alice@example.com", { providerSubject: "sub-alice", loginEmail: "alice@example.com" });
    await seedCached("alice@example.com");
    let raced = false;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await env.DB.prepare("UPDATE identity_tokens SET login_email = 'renamed@example.org' WHERE account_email = ?")
                .bind("alice@example.com").run();
            }
            return target.batch(stmts);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const res = await post({ subject: "alice@example.com" }, { env: { ...env, DB: db } as Env });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "concurrent_update" });
    expect(await readCachedAccessToken(env, "alice@example.com")).toBe("AT-previous-holder");
  });
});

async function seedCode(subject: string) {
  await env.DB.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, kind, scopes, expires_at, subject)
     VALUES (?, 'c', 'auth', 'scheduler:read', '2099-01-01T00:00:00Z', ?)`,
  ).bind(`code-${subject}`, subject).run();
}

function codeCount(subject: string) {
  return env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_codes WHERE subject = ?")
    .bind(subject).first<{ n: number }>().then((r) => r!.n);
}

async function seedSessions(subject: string) {
  const h = await hashToken(`access-${subject}`, hashingKey(env));
  await env.DB.prepare(
    `INSERT INTO oauth_tokens (hashed_token,client_id,scopes,expires_at,refresh_of,revoked_at,subject) VALUES (?,?,?,?,?,?,?)`,
  ).bind(h, "c", "scheduler:read", "2099-01-01T00:00:00Z", null, null, subject).run();
  await env.DB.prepare(
    `INSERT INTO pending_actions (id, owner_subject, op, payload, summary, created_at, expires_at)
     VALUES (?, ?, 'commit', '{}', '{}', '2026-10-01T00:00:00Z', '2099-01-01T00:00:00Z')`,
  ).bind(`pa-${subject}`, subject).run();
  await seedCode(subject);
}

async function sessionCounts(subject: string) {
  const live = await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_tokens WHERE subject = ? AND revoked_at IS NULL")
    .bind(subject).first<{ n: number }>();
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE owner_subject = ?")
    .bind(subject).first<{ n: number }>();
  return { live: live!.n, pending: pending!.n, codes: await codeCount(subject) };
}

// Card C8: with UPSTREAM_REVOKE_ENABLED the rebind also revokes the previous
// holder's grant at the IdP, as offboard and a refused sign-in do. The
// credential is read before the compare-and-set wipes it; the revoke runs only
// once the clear and its audit row have landed, and never on a 409.
describe("POST /admin/identity-rebind: upstream revoke", () => {
  const ON = () => ({ ...env, UPSTREAM_REVOKE_ENABLED: "true" }) as Env;
  type Seen = { token: string; credBytes: number | undefined; audits: number };

  function recordingIdp(seen: Seen[], fail = false): IdentityProvider {
    return {
      scopes: [],
      authorizeUrl: () => { throw new Error("unused"); },
      exchangeCode: () => { throw new Error("unused"); },
      fetchIdentity: () => { throw new Error("unused"); },
      refreshAccessToken: () => { throw new Error("unused"); },
      revokeGrant: async (token: string) => {
        const cred = await env.DB.prepare("SELECT length(refresh_token_encrypted) AS n FROM identity_tokens WHERE account_email = 'alice@example.com'")
          .first<{ n: number }>();
        seen.push({ token, credBytes: cred?.n, audits: (await auditRows()).length });
        if (fail) throw new Error(`revoke failed for ${token} alice@example.com`);
      },
    };
  }

  async function seedRealCredential() {
    await upsertUser(env.DB, "alice@example.com");
    await storeIdentityTokens(env, "alice@example.com", { ...tokens, refreshToken: "r-previous-holder" }, "google", "sub-alice", "alice@example.com");
  }

  it("flag on: revokes the previous holder's grant once, after the wipe and the audit row", async () => {
    await asAdmin();
    await seedRealCredential();
    const seen: Seen[] = [];
    __setIdentityProviderForTests(recordingIdp(seen));
    const res = await post({ subject: "alice@example.com" }, { env: ON() });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ token: "r-previous-holder", credBytes: 0, audits: 1 }]);
  });

  it("flag on, no race: no identity_rebind_revoke_raced line", async () => {
    await asAdmin();
    await seedRealCredential();
    __setIdentityProviderForTests(recordingIdp([]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await post({ subject: "alice@example.com" }, { env: ON() })).status).toBe(200);
    expect(warn.mock.calls.some((c) => c[0] === "identity_rebind_revoke_raced")).toBe(false);
  });

  // Google's revoke ends the whole user-to-client grant, so a sign-in landing
  // between the wipe and the revoke has its fresh credential killed upstream.
  // The rebind can't undo that; it says so, with no email, so the operator can
  // ask the user to sign in again.
  it("a sign-in landing before the revoke completes logs identity_rebind_revoke_raced {provider}, no email", async () => {
    await asAdmin();
    await seedRealCredential();
    const base = recordingIdp([]);
    __setIdentityProviderForTests({
      ...base,
      revokeGrant: async (token: string) => {
        await storeIdentityTokens(env, "alice@example.com", { ...tokens, refreshToken: "r-new-holder" }, "google", "sub-new", "alice@example.com");
        await base.revokeGrant(token);
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await post({ subject: "alice@example.com" }, { env: ON() });
    expect(res.status).toBe(200);
    const raced = warn.mock.calls.filter((c) => c[0] === "identity_rebind_revoke_raced");
    expect(raced).toEqual([["identity_rebind_revoke_raced", { provider: "google" }]]);
  });

  it("a sign-in landing before a revoke that FAILED logs no raced line (the new grant survived)", async () => {
    await asAdmin();
    await seedRealCredential();
    const base = recordingIdp([]);
    __setIdentityProviderForTests({
      ...base,
      revokeGrant: async () => {
        await storeIdentityTokens(env, "alice@example.com", { ...tokens, refreshToken: "r-new-holder" }, "google", "sub-new", "alice@example.com");
        throw new Error("revoke endpoint down");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await post({ subject: "alice@example.com" }, { env: ON() })).status).toBe(200);
    expect(warn.mock.calls.some((c) => c[0] === "identity_rebind_revoke_raced")).toBe(false);
  });

  it("a D1 failure in the post-revoke race check still answers 200 and drops the cached token, logging a fixed line", async () => {
    await asAdmin();
    await seedRealCredential();
    await cacheAccessToken(env, "alice@example.com", "AT-previous-holder", 3600);
    __setIdentityProviderForTests(recordingIdp([]));
    // Only hasRefreshCredential's read (SELECT (length(...)) AS has_credential) fails.
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            const stmt = target.prepare(sql);
            if (!/^SELECT \(length\(refresh_token_encrypted\) > 0\) AS has_credential/.test(sql)) return stmt;
            const bind = stmt.bind.bind(stmt);
            return Object.assign(stmt, {
              bind: (...a: unknown[]) => Object.assign(bind(...a), {
                first: async () => { throw new Error("D1 read failed for alice@example.com"); },
              }),
            });
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ subject: "alice@example.com" }, { env: { ...ON(), DB: db } as Env });
    expect(res.status).toBe(200);
    expect(await readCachedAccessToken(env, "alice@example.com")).toBeNull();
    const calls = [...warn.mock.calls, ...error.mock.calls];
    expect(calls.filter((c) => c[0] === "identity_rebind_revoke_race_check_failed"))
      .toEqual([["identity_rebind_revoke_race_check_failed", { provider: "google" }]]);
    const logged = calls.map((c) => c.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")).join("\n");
    expect(logged).not.toContain("alice@example.com");
    expect(logged).not.toContain("D1 read failed");
  });

  it("flag off: nothing is revoked", async () => {
    await asAdmin();
    await seedRealCredential();
    const seen: Seen[] = [];
    __setIdentityProviderForTests(recordingIdp(seen));
    expect((await post({ subject: "alice@example.com" })).status).toBe(200);
    expect(seen).toEqual([]);
  });

  it("409 concurrent_update revokes nothing", async () => {
    await asAdmin();
    await seedRealCredential();
    const seen: Seen[] = [];
    __setIdentityProviderForTests(recordingIdp(seen));
    let raced = false;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await env.DB.prepare("UPDATE identity_tokens SET login_email = 'renamed@example.org' WHERE account_email = ?")
                .bind("alice@example.com").run();
            }
            return target.batch(stmts);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const res = await post({ subject: "alice@example.com" }, { env: { ...ON(), DB: db } as Env });
    expect(res.status).toBe(409);
    expect(seen).toEqual([]);
  });

  it("409 subject_drifted revokes nothing", async () => {
    await asAdmin();
    await upsertUser(env.DB, "alice@example.com");
    await storeIdentityTokens(env, "alice@example.com", tokens, "google", "sub-alice", "renamed@example.org");
    const seen: Seen[] = [];
    __setIdentityProviderForTests(recordingIdp(seen));
    expect((await post({ subject: "alice@example.com" }, { env: ON() })).status).toBe(409);
    expect(seen).toEqual([]);
  });

  it("a failing revoke still answers 200 with the account rebound; the log names neither the token nor the email", async () => {
    await asAdmin();
    await seedRealCredential();
    const seen: Seen[] = [];
    __setIdentityProviderForTests(recordingIdp(seen, true));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ subject: "alice@example.com" }, { env: ON() });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect((await identityRow("alice@example.com"))!.cred).toBe("");
    const calls = [...warn.mock.calls, ...error.mock.calls];
    expect(calls.some((c) => c[0] === "identity_rebind_revoke_failed")).toBe(true);
    const logged = calls.map((c) => c.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")).join("\n");
    expect(logged).not.toContain("r-previous-holder");
    expect(logged).not.toContain("alice@example.com");
  });

  it("an undecryptable stored credential: 200, the revoke logs a failure, nothing else changes", async () => {
    await asAdmin();
    await seedIdentity("alice@example.com", { providerSubject: "sub-alice", loginEmail: "alice@example.com" });
    const seen: Seen[] = [];
    __setIdentityProviderForTests(recordingIdp(seen));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await post({ subject: "alice@example.com" }, { env: ON() })).status).toBe(200);
    expect(seen).toEqual([]);
    expect(warn.mock.calls.some((c) => c[0] === "identity_rebind_revoke_failed")).toBe(true);
    expect((await identityRow("alice@example.com"))!.cred).toBe("");
  });
});
