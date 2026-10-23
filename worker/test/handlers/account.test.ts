// Hosted-trial card O2: self-serve account deletion, DELETE /v1/account
// (op deleteAccount). Exercised through the real v1 app so the mount, the gate
// order (flag -> auth -> scope -> body) and the validation hook are all live.
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { v1 as app } from "../../src/v1";
import { hashToken } from "../../src/auth/tokens";
import { hashingKey } from "../../src/auth/crypto-keys";
import { upsertUser, getUser } from "../../src/db/users";
import { SMTP2GO_SEND_URL } from "../../src/mail/system-mailer";
import { storeIdentityTokens } from "../../src/auth/identity-store";
import { Hono } from "hono";
import type { AppVariables } from "../../src/index-providers";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import { mountConfirmRoutes } from "../../src/confirm/route";

const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

const A = "alice@org";
const B = "bob@org";

const FLAG_ON = { SELF_SERVE_DELETE_ENABLED: "true" };
const MAIL_ON = {
  SYSTEM_MAIL_ENABLED: "true",
  SYSTEM_MAIL_FROM: "Optical <optical@example.test>",
  SYSTEM_MAIL_API_KEY: "k",
};

async function seedBearer(token: string, subject: string, scopes = "scheduler:read scheduler:write") {
  const h = await hashToken(token, hashingKey(env));
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_clients (id,name,type,redirect_uris,allowed_scopes,created_at) VALUES ('c','t','pkce',NULL,'scheduler:read scheduler:write','2026-01-01')`,
  ).run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_tokens (hashed_token,client_id,scopes,expires_at,refresh_of,revoked_at,subject) VALUES (?,?,?,?,?,?,?)`,
  ).bind(h, "c", scopes, "2099-01-01T00:00:00Z", null, null, subject).run();
}

/** A user with a bearer and a few owner-scoped rows. */
async function seedUser(subject: string, token = `tok-${subject}`, scopes?: string) {
  await upsertUser(env.DB, subject);
  await seedBearer(token, subject, scopes);
  await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .bind(`t-${subject}`, subject, "{}", "pending", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z").run();
  await env.DB.prepare("INSERT INTO projects (id, owner_subject, body) VALUES (?,?,?)")
    .bind(`p-${subject}`, subject, "{}").run();
  await env.DB.prepare("INSERT OR REPLACE INTO config_weights (owner_subject, body) VALUES (?,?)").bind(subject, "{}").run();
  return { Authorization: `Bearer ${token}` };
}

async function count(table: string, column: string, subject: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).bind(subject).first<{ n: number }>();
  return r?.n ?? 0;
}

async function expectIntact(subject: string) {
  expect(await count("tasks", "owner_subject", subject), `${subject} tasks`).toBe(1);
  expect(await count("projects", "owner_subject", subject), `${subject} projects`).toBe(1);
  expect(await count("config_weights", "owner_subject", subject), `${subject} config_weights`).toBe(1);
  expect(await count("oauth_tokens", "subject", subject), `${subject} oauth_tokens`).toBeGreaterThan(0);
  expect((await getUser(env.DB, subject))?.is_active, `${subject} is_active`).toBe(1);
}

function del(headers: Record<string, string>, body: unknown, envOverride: Record<string, unknown> = FLAG_ON) {
  return app.request(
    "/account",
    {
      method: "DELETE",
      headers: { ...headers, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    { ...env, ...envOverride },
  );
}

/** Spy on global fetch: SMTP2GO answers per `mailOk`; anything else (the
 *  offboard's calendar/IdP calls for a subject with no identity row) fails,
 *  which offboardUser tolerates. Returns the recorded SMTP2GO sends. */
function spyFetch(mailOk = true) {
  const sends: { to: string[]; subject: string; text_body: string }[] = [];
  const revokes: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === SMTP2GO_SEND_URL) {
      sends.push(JSON.parse(String(init!.body)));
      return mailOk
        ? new Response(JSON.stringify({ data: { succeeded: 1, failed: 0 } }), { status: 200 })
        : new Response("boom", { status: 500 });
    }
    if (url === GOOGLE_REVOKE_URL) {
      revokes.push(new URLSearchParams(String(init!.body)).get("token") ?? "");
      return new Response("{}", { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  return { sends, revokes, spy };
}

beforeEach(async () => {
  for (const t of ["oauth_tokens", "oauth_clients", "oauth_codes", "users", "tasks", "projects", "audit_log", "identity_tokens", "calendar_sync"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  await env.DB.prepare("DELETE FROM config_weights WHERE owner_subject != '__default__'").run();
});
afterEach(() => vi.restoreAllMocks());

describe("DELETE /v1/account — flag gate", () => {
  for (const flag of [undefined, "false", "TRUE", "1"]) {
    it(`404 not_found with SELF_SERVE_DELETE_ENABLED=${String(flag)}, even with a valid body`, async () => {
      const headers = await seedUser(A);
      const res = await del(headers, { confirm: A }, { SELF_SERVE_DELETE_ENABLED: flag });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
      await expectIntact(A);
    });
  }

  it("flag off: 404 before auth and before body validation (no bearer, garbage body)", async () => {
    const res = await del({}, "{not json", { SELF_SERVE_DELETE_ENABLED: "false" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("DELETE /v1/account — auth, scope and confirmation", () => {
  it("401 without a bearer (flag on), before body validation", async () => {
    const res = await del({}, "{not json");
    expect(res.status).toBe(401);
  });

  it("403 insufficient_scope for a read-only bearer; nothing deleted", async () => {
    const headers = await seedUser(A, "tok-ro", "scheduler:read");
    const res = await del(headers, { confirm: A });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "insufficient_scope", required: "scheduler:write" });
    await expectIntact(A);
  });

  it("400 when confirm is missing; rows intact", async () => {
    const headers = await seedUser(A);
    const res = await del(headers, {});
    expect(res.status).toBe(400);
    await expectIntact(A);
  });

  it("400 confirmation_mismatch when confirm is not the caller's email; rows intact", async () => {
    const headers = await seedUser(A);
    const res = await del(headers, { confirm: "someone-else@org" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "confirmation_mismatch" });
    await expectIntact(A);
  });

  it("confirm is an exact match after lowercasing: surrounding whitespace is a mismatch", async () => {
    const headers = await seedUser(A);
    const res = await del(headers, { confirm: ` ${A} ` });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "confirmation_mismatch" });
    await expectIntact(A);
  });

  it("rejects unknown keys (no body-supplied subject is ever honoured)", async () => {
    const headersA = await seedUser(A);
    await seedUser(B);
    const res = await del(headersA, { confirm: A, subject: B });
    expect(res.status).toBe(400);
    await expectIntact(A);
    await expectIntact(B);
  });

  it("cross-user: A cannot delete B by confirming B's email", async () => {
    const headersA = await seedUser(A);
    await seedUser(B);
    const res = await del(headersA, { confirm: B });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "confirmation_mismatch" });
    await expectIntact(A);
    await expectIntact(B);
  });
});

describe("DELETE /v1/account — success", () => {
  it("offboards the caller only, kills their bearer, audits source api, mails once", async () => {
    const { sends } = spyFetch();
    const headersA = await seedUser(A);
    await seedBearer("tok-a-second", A); // another client's bearer for the same user
    const headersB = await seedUser(B);

    const res = await del(headersA, { confirm: "Alice@ORG" }, { ...FLAG_ON, ...MAIL_ON });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Owner-scoped rows gone; the users row is kept but deactivated.
    expect(await count("tasks", "owner_subject", A)).toBe(0);
    expect(await count("projects", "owner_subject", A)).toBe(0);
    expect(await count("config_weights", "owner_subject", A)).toBe(0);
    expect(await count("oauth_tokens", "subject", A)).toBe(0);
    expect((await getUser(env.DB, A))?.is_active).toBe(0);

    // The caller's bearer is dead (pins "bearers revoked" via the oauth_tokens delete).
    const after = await app.request("/whoami", { headers: headersA }, env);
    expect(after.status).toBe(401);
    const second = await app.request("/whoami", { headers: { Authorization: "Bearer tok-a-second" } }, env);
    expect(second.status).toBe(401);

    // Audit: offboard by the caller, source api.
    const audit = await env.DB.prepare(
      "SELECT actor, source FROM audit_log WHERE subject = ? AND action = 'offboard'",
    ).bind(A).all<{ actor: string; source: string }>();
    expect(audit.results).toEqual([{ actor: A, source: "api" }]);

    // One confirmation mail, to the caller's stored address.
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toEqual([A]);
    expect(sends[0]!.subject).toBe("Your Optical account has been deleted");

    // B untouched and still authenticated.
    await expectIntact(B);
    expect((await app.request("/whoami", { headers: headersB }, env)).status).toBe(200);
  });

  // Decision F: the confirmation states the deployment's own purge window.
  it("the confirmation mail states DELETED_ACCOUNT_RETENTION_DAYS when set, no end date otherwise", async () => {
    const { sends } = spyFetch();
    await del(await seedUser(A), { confirm: A }, { ...FLAG_ON, ...MAIL_ON, DELETED_ACCOUNT_RETENTION_DAYS: "30" });
    await del(await seedUser(B), { confirm: B }, { ...FLAG_ON, ...MAIL_ON, DELETED_ACCOUNT_RETENTION_DAYS: "0" });
    expect(sends).toHaveLength(2);
    expect(sends[0]!.text_body).toContain("Both are kept for 30 days after the deletion.");
    expect(sends[1]!.text_body).toContain("Both are kept with no set end date.");
  });

  it("a second call with the dead bearer is 401 and sends no second mail", async () => {
    const { sends } = spyFetch();
    const headers = await seedUser(A);
    expect((await del(headers, { confirm: A }, { ...FLAG_ON, ...MAIL_ON })).status).toBe(200);
    const again = await del(headers, { confirm: A }, { ...FLAG_ON, ...MAIL_ON });
    expect(again.status).toBe(401);
    expect(sends).toHaveLength(1);
  });

  it("a concurrent double submit is safe: no 5xx, the account is gone, B untouched", async () => {
    spyFetch();
    const headers = await seedUser(A);
    await seedUser(B);
    const [r1, r2] = await Promise.all([
      del(headers, { confirm: A }, { ...FLAG_ON, ...MAIL_ON }),
      del(headers, { confirm: A }, { ...FLAG_ON, ...MAIL_ON }),
    ]);
    // Whichever loses the race either re-runs the idempotent offboard (200) or
    // finds its bearer already deleted (401); neither is an error.
    expect([r1.status, r2.status].every((s) => s === 200 || s === 401)).toBe(true);
    expect([r1.status, r2.status]).toContain(200);
    expect(await count("tasks", "owner_subject", A)).toBe(0);
    expect(await count("oauth_tokens", "subject", A)).toBe(0);
    expect((await getUser(env.DB, A))?.is_active).toBe(0);
    await expectIntact(B);
  });

  it("with system mail off, deletes and sends nothing", async () => {
    const { sends, spy } = spyFetch();
    const headers = await seedUser(A);
    const res = await del(headers, { confirm: A });
    expect(res.status).toBe(200);
    expect(await count("tasks", "owner_subject", A)).toBe(0);
    expect(sends).toHaveLength(0);
    expect(spy.mock.calls.filter(([u]) => String(u) === SMTP2GO_SEND_URL)).toHaveLength(0);
  });

  it("a failed confirmation mail never fails the deletion", async () => {
    const { sends } = spyFetch(false);
    const headers = await seedUser(A);
    const res = await del(headers, { confirm: A }, { ...FLAG_ON, ...MAIL_ON });
    expect(res.status).toBe(200);
    expect(sends).toHaveLength(1);
    expect(await count("tasks", "owner_subject", A)).toBe(0);
    expect((await getUser(env.DB, A))?.is_active).toBe(0);
  });

  // O1 wiring through the route: deleteAccount runs the default offboard
  // seams, so a connected Google subject's grant is revoked at the IdP when
  // (and only when) UPSTREAM_REVOKE_ENABLED is "true".
  describe("upstream grant revocation (O1) via the route", () => {
    const REFRESH = "1//alice-refresh-secret";
    async function seedGoogle() {
      const headers = await seedUser(A);
      await storeIdentityTokens(env, A, { refreshToken: REFRESH, accessToken: "at", expiresIn: 3600, scope: "s" }, "google", "psub-alice");
      return headers;
    }

    it("UPSTREAM_REVOKE_ENABLED=true: the caller's Google refresh token is revoked once", async () => {
      const { revokes } = spyFetch();
      const headers = await seedGoogle();
      const res = await del(headers, { confirm: A }, { ...FLAG_ON, UPSTREAM_REVOKE_ENABLED: "true" });
      expect(res.status).toBe(200);
      expect(revokes).toEqual([REFRESH]);
      expect(await count("identity_tokens", "account_email", A)).toBe(0);
    });

    it("UPSTREAM_REVOKE_ENABLED off: no revoke call, the account is still deleted", async () => {
      const { revokes } = spyFetch();
      const headers = await seedGoogle();
      const res = await del(headers, { confirm: A }, { ...FLAG_ON, UPSTREAM_REVOKE_ENABLED: "false" });
      expect(res.status).toBe(200);
      expect(revokes).toEqual([]);
      expect(await count("identity_tokens", "account_email", A)).toBe(0);
      expect((await getUser(env.DB, A))?.is_active).toBe(0);
    });
  });
});

// Decision B: for an agent-confirm OAuth client (AGENT_CONFIRM_CLIENT_IDS),
// deleteAccount only defers: 202 awaiting_confirmation, nothing deleted, and a
// confirm link emailed to the user. The deletion runs on the human's browser
// POST to /confirm/{id}, once, after re-checking the account still applies.
describe("DELETE /v1/account — agent-confirm clients (decision B)", () => {
  const ISSUER = "https://scheduler.example.com";
  const GATED = { ...FLAG_ON, ...MAIL_ON, AGENT_CONFIRM_CLIENT_IDS: "c", OAUTH_ISSUER: ISSUER };

  function rootApp(notify: MockNotificationProvider) {
    const root = new Hono<{ Bindings: typeof env; Variables: AppVariables }>();
    root.use("*", async (c, next) => {
      c.set("notificationProvider", notify);
      await next();
    });
    mountConfirmRoutes(root);
    root.route("/v1", app);
    return root;
  }

  function delVia(root: Hono<any>, headers: Record<string, string>, body: unknown, e: Record<string, unknown> = GATED) {
    return root.request(
      "/v1/account",
      { method: "DELETE", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) },
      { ...env, ...e },
    );
  }

  function linkFrom(text: string): { id: string; t: string } {
    const m = /https:\/\/scheduler\.example\.com\/confirm\/([0-9a-f-]+)\?t=([^\s"<]+)/.exec(text);
    if (!m) throw new Error("no confirm link in mail");
    return { id: m[1]!, t: decodeURIComponent(m[2]!) };
  }

  function post(root: Hono<any>, id: string, t: string, e: Record<string, unknown> = GATED) {
    return root.request(
      `/confirm/${id}`,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `t=${encodeURIComponent(t)}` },
      { ...env, ...e },
    );
  }

  async function auditCount(subject: string) {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE subject = ? AND action = 'offboard'")
      .bind(subject).first<{ n: number }>();
    return r?.n ?? 0;
  }

  /** Defers A's deletion; returns the root app, the link and the response body. */
  async function deferDelete(e: Record<string, unknown> = GATED) {
    const notify = new MockNotificationProvider();
    const root = rootApp(notify);
    const headers = await seedUser(A);
    const res = await delVia(root, headers, { confirm: A }, e);
    return { root, notify, headers, res };
  }

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM pending_actions").run();
  });

  for (const ids of ["c", "*", "other, c"]) {
    it(`AGENT_CONFIRM_CLIENT_IDS=${JSON.stringify(ids)}: 202 awaiting_confirmation, nothing deleted, confirm link mailed`, async () => {
      const { sends } = spyFetch();
      const { notify, headers, res } = await deferDelete({ ...GATED, AGENT_CONFIRM_CLIENT_IDS: ids });
      expect(res.status).toBe(202);
      const body = await res.json() as Record<string, unknown>;
      expect(body.status).toBe("awaiting_confirmation");
      expect(typeof body.action_id).toBe("string");

      await expectIntact(A);
      expect(await auditCount(A)).toBe(0);
      expect(await count("pending_actions", "owner_subject", A)).toBe(1);
      // The bearer still works: nothing happened yet.
      expect((await app.request("/whoami", { headers }, env)).status).toBe(200);

      // One confirm mail to the user; no "account deleted" mail.
      expect(notify.sentPollEmails).toHaveLength(1);
      expect(notify.sentPollEmails[0]!.to).toBe(A);
      expect(notify.sentPollEmails[0]!.subject).toContain("Delete your Optical account");
      linkFrom(notify.sentPollEmails[0]!.text);
      expect(sends).toHaveLength(0);
    });
  }

  it("a non-gated client is unchanged: deleted at once (200)", async () => {
    spyFetch();
    const { res } = await deferDelete({ ...GATED, AGENT_CONFIRM_CLIENT_IDS: "someone-else" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await getUser(env.DB, A))?.is_active).toBe(0);
    expect(await count("pending_actions", "owner_subject", A)).toBe(0);
  });

  it("the confirm-field check still runs first: a mismatch is 400, no mail, nothing stored", async () => {
    spyFetch();
    const notify = new MockNotificationProvider();
    const root = rootApp(notify);
    const res = await delVia(root, await seedUser(A), { confirm: "someone-else@org" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "confirmation_mismatch" });
    expect(notify.sentPollEmails).toHaveLength(0);
    expect(await count("pending_actions", "owner_subject", A)).toBe(0);
    await expectIntact(A);
  });

  it("the confirm page says plainly that it deletes the account", async () => {
    spyFetch();
    const { root, notify } = await deferDelete();
    const { id, t } = linkFrom(notify.sentPollEmails[0]!.text);
    const page = await root.request(`/confirm/${id}?t=${encodeURIComponent(t)}`, { method: "GET" }, { ...env, ...GATED });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Delete your Optical account");
    expect(html).toContain("Permanently delete the Optical account alice@org");
    expect(html).toContain("cannot be undone");
    await expectIntact(A); // GET never acts
  });

  it("confirming deletes the account once: rows gone, bearer dead, audited, deletion mail sent", async () => {
    const { sends } = spyFetch();
    const { root, notify, headers } = await deferDelete();
    const { id, t } = linkFrom(notify.sentPollEmails[0]!.text);

    const res = await post(root, id, t);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Your Optical account has been deleted");

    expect(await count("tasks", "owner_subject", A)).toBe(0);
    expect(await count("projects", "owner_subject", A)).toBe(0);
    expect(await count("oauth_tokens", "subject", A)).toBe(0);
    expect(await count("pending_actions", "owner_subject", A)).toBe(0);
    expect((await getUser(env.DB, A))?.is_active).toBe(0);
    expect((await app.request("/whoami", { headers }, env)).status).toBe(401);

    const audit = await env.DB.prepare("SELECT actor, source FROM audit_log WHERE subject = ? AND action = 'offboard'")
      .bind(A).all<{ actor: string; source: string }>();
    expect(audit.results).toEqual([{ actor: A, source: "api" }]);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toEqual([A]);
    expect(sends[0]!.subject).toBe("Your Optical account has been deleted");
  });

  it("a second confirm of the same link does nothing more", async () => {
    const { sends } = spyFetch();
    const { root, notify } = await deferDelete();
    const { id, t } = linkFrom(notify.sentPollEmails[0]!.text);
    expect((await post(root, id, t)).status).toBe(200);
    const again = await post(root, id, t);
    expect(again.status).not.toBe(200);
    expect(again.status).toBeLessThan(500);
    expect(await auditCount(A)).toBe(1);
    expect(sends).toHaveLength(1);
  });

  it("concurrent confirms run the offboard once", async () => {
    const { sends } = spyFetch();
    const { root, notify } = await deferDelete();
    const { id, t } = linkFrom(notify.sentPollEmails[0]!.text);
    const [r1, r2] = await Promise.all([post(root, id, t), post(root, id, t)]);
    expect([r1.status, r2.status].filter((s) => s === 200)).toHaveLength(1);
    expect(await auditCount(A)).toBe(1);
    expect(sends).toHaveLength(1);
  });

  it("re-checks at confirm time: an account deactivated meanwhile is not offboarded again", async () => {
    const { sends } = spyFetch();
    const { root, notify } = await deferDelete();
    const { id, t } = linkFrom(notify.sentPollEmails[0]!.text);
    await env.DB.prepare("UPDATE users SET is_active = 0 WHERE subject = ?").bind(A).run();

    // The confirm route itself now refuses a deactivated account (post-O14
    // #4), with the invalid-link page, before the op's own re-check.
    const res = await post(root, id, t);
    expect(res.status).toBe(400);
    expect(await auditCount(A)).toBe(0);
    expect(await count("tasks", "owner_subject", A)).toBe(1);
    expect(sends).toHaveLength(0);
  });

  it("re-checks at confirm time: self-serve deletion switched off meanwhile refuses", async () => {
    const { sends } = spyFetch();
    const { root, notify } = await deferDelete();
    const { id, t } = linkFrom(notify.sentPollEmails[0]!.text);

    const res = await post(root, id, t, { ...GATED, SELF_SERVE_DELETE_ENABLED: "false" });
    expect(res.status).toBe(409);
    await expectIntact(A);
    expect(sends).toHaveLength(0);
  });

  it("with the user's own mailbox failing, the confirm link goes by system mail", async () => {
    const { sends } = spyFetch();
    const failing = new MockNotificationProvider();
    failing.sendPollEmail = async () => { throw new Error("mailbox down"); };
    const root = rootApp(failing);
    const res = await delVia(root, await seedUser(A), { confirm: A });
    expect(res.status).toBe(202);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.subject).toContain("Delete your Optical account");
    await expectIntact(A);
  });
});
