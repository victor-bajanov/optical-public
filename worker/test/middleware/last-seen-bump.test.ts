// worker/test/middleware/last-seen-bump.test.ts
//
// O10a (hosted-trial plan): last_seen must reflect real use, not just OAuth
// sign-in. A user working through MCP on refreshed bearer tokens never signs in
// again, so with RETENTION_DAYS set the sweep would offboard them while active.
// requireBearer bumps last_seen on a valid bearer that resolves a subject:
// UPDATE-only (never creates a users row — that grants membership), never
// reactivates an offboarded subject, throttled to one write per ~20 h, and a
// bump failure never fails the request.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import type { Env } from "../../src/env";
import type { AppVariables } from "../../src/index-providers";
import { requireBearer } from "../../src/middleware/auth-bearer";
import { requireOwner } from "../../src/middleware/owner-gate";
import { hashToken } from "../../src/auth/tokens";
import { hashingKey } from "../../src/auth/crypto-keys";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SUBJECT = "user@example.com";
const TOKEN = "bump-token";

async function seedToken(token: string, subject: string | null, opts: { expires_at?: string; revoked?: boolean } = {}) {
  const hashed = await hashToken(token, hashingKey(env as unknown as Env));
  await env.DB.prepare(
    "INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?, 'test-client', 'scheduler:read scheduler:write', ?, NULL, ?, ?)",
  ).bind(hashed, opts.expires_at ?? null, opts.revoked ? "2024-01-01T00:00:00Z" : null, subject).run();
}

async function seedUser(subject: string, lastSeen: string | null, isActive = 1) {
  await env.DB.prepare(
    "INSERT INTO users (subject, role, is_active, last_seen, created_at) VALUES (?, 'member', ?, ?, '2026-01-01T00:00:00Z')",
  ).bind(subject, isActive, lastSeen).run();
}

async function userRow(subject: string) {
  return env.DB.prepare("SELECT subject, is_active, last_seen FROM users WHERE subject = ?")
    .bind(subject)
    .first<{ subject: string; is_active: number; last_seen: string | null }>();
}

/** env whose DB records every SQL string prepared through it; `failOn` makes a
 *  matching prepare throw (simulates a D1 error on the bump). */
function spyEnv(opts: { failOn?: RegExp; rejectRunOn?: RegExp } = {}) {
  const sql: string[] = [];
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (q: string) => {
          sql.push(q);
          if (opts.failOn?.test(q)) throw new Error("D1_ERROR: simulated prepare failure");
          const stmt = target.prepare(q);
          if (opts.rejectRunOn?.test(q)) {
            return new Proxy(stmt, {
              get(s, p) {
                if (p === "bind") return (...args: unknown[]) => {
                  const bound = s.bind(...args);
                  return new Proxy(bound, {
                    get(b, bp) {
                      if (bp === "run") return async () => { throw new Error("D1_ERROR: simulated run failure"); };
                      const v = Reflect.get(b, bp);
                      return typeof v === "function" ? v.bind(b) : v;
                    },
                  });
                };
                const v = Reflect.get(s, p);
                return typeof v === "function" ? v.bind(s) : v;
              },
            });
          }
          return stmt;
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { env: { ...env, DB: db } as unknown as Env, sql };
}

const BUMP_SQL = /UPDATE\s+users\s+SET\s+last_seen/i;

function bearerApp() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", requireBearer as never);
  app.get("/x", (c) => c.json({ ok: true }));
  return app;
}

function ownerApp() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.get("/probe", async (c) => {
    const owner = await requireOwner(c);
    if (owner instanceof Response) return owner;
    return c.json({ owner }, 200);
  });
  return app;
}

const auth = (token = TOKEN) => ({ headers: { Authorization: `Bearer ${token}` } });

describe("requireBearer bumps users.last_seen on real use (O10a)", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM oauth_tokens").run();
    await env.DB.prepare("DELETE FROM users").run();
  });
  afterEach(() => vi.restoreAllMocks());

  it("a valid bearer call moves a stale last_seen to now (ISO, same format the sweep compares)", async () => {
    const old = new Date(Date.now() - 30 * DAY).toISOString();
    await seedUser(SUBJECT, old);
    await seedToken(TOKEN, SUBJECT);
    const before = Date.now();
    const res = await bearerApp().request("/x", auth(), env);
    expect(res.status).toBe(200);
    const row = await userRow(SUBJECT);
    expect(row!.last_seen).not.toBe(old);
    expect(row!.last_seen).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(row!.last_seen!)).toBeGreaterThanOrEqual(before - 1000);
    expect(row!.is_active).toBe(1);
  });

  it("a NULL last_seen (seed admin, never stamped) is bumped", async () => {
    await seedUser(SUBJECT, null);
    await seedToken(TOKEN, SUBJECT);
    const res = await bearerApp().request("/x", auth(), env);
    expect(res.status).toBe(200);
    expect((await userRow(SUBJECT))!.last_seen).not.toBeNull();
  });

  it("a call within the ~20 h throttle issues no write at all", async () => {
    const recent = new Date(Date.now() - 1 * HOUR).toISOString();
    await seedUser(SUBJECT, recent);
    await seedToken(TOKEN, SUBJECT);
    const spy = spyEnv();
    const res = await bearerApp().request("/x", auth(), spy.env);
    expect(res.status).toBe(200);
    expect(spy.sql.filter((q) => BUMP_SQL.test(q))).toHaveLength(0);
    expect((await userRow(SUBJECT))!.last_seen).toBe(recent);
  });

  it("two calls back to back: the first writes, the second does not", async () => {
    await seedUser(SUBJECT, new Date(Date.now() - 2 * DAY).toISOString());
    await seedToken(TOKEN, SUBJECT);
    const first = spyEnv();
    await bearerApp().request("/x", auth(), first.env);
    expect(first.sql.filter((q) => BUMP_SQL.test(q))).toHaveLength(1);
    const stamped = (await userRow(SUBJECT))!.last_seen;
    const second = spyEnv();
    await bearerApp().request("/x", auth(), second.env);
    expect(second.sql.filter((q) => BUMP_SQL.test(q))).toHaveLength(0);
    expect((await userRow(SUBJECT))!.last_seen).toBe(stamped);
  });

  it("just past the throttle (21 h) bumps again", async () => {
    const old = new Date(Date.now() - 21 * HOUR).toISOString();
    await seedUser(SUBJECT, old);
    await seedToken(TOKEN, SUBJECT);
    await bearerApp().request("/x", auth(), env);
    expect((await userRow(SUBJECT))!.last_seen).not.toBe(old);
  });

  it("an inactive (offboarded) user is neither reactivated nor stamped", async () => {
    const old = new Date(Date.now() - 30 * DAY).toISOString();
    await seedUser(SUBJECT, old, 0);
    await seedToken(TOKEN, SUBJECT);
    await bearerApp().request("/x", auth(), env);
    const row = await userRow(SUBJECT);
    expect(row).toMatchObject({ is_active: 0, last_seen: old });
  });

  it("a subject with no users row gets no row (a bump never grants membership)", async () => {
    await seedToken(TOKEN, SUBJECT);
    const res = await bearerApp().request("/x", auth(), env);
    expect(res.status).toBe(200);
    expect(await userRow(SUBJECT)).toBeNull();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("a token with no subject touches no users row", async () => {
    await seedUser(SUBJECT, new Date(Date.now() - 30 * DAY).toISOString());
    await seedToken(TOKEN, null);
    const spy = spyEnv();
    const res = await bearerApp().request("/x", auth(), spy.env);
    expect(res.status).toBe(200);
    expect(spy.sql.filter((q) => BUMP_SQL.test(q))).toHaveLength(0);
  });

  it.each([
    ["revoked", { revoked: true }],
    ["expired", { expires_at: "2000-01-01T00:00:00Z" }],
  ] as const)("a %s token is rejected and does not bump", async (_label, opts) => {
    const old = new Date(Date.now() - 30 * DAY).toISOString();
    await seedUser(SUBJECT, old);
    await seedToken(TOKEN, SUBJECT, opts);
    const res = await bearerApp().request("/x", auth(), env);
    expect(res.status).toBe(401);
    expect((await userRow(SUBJECT))!.last_seen).toBe(old);
  });

  it("a bump failure at prepare still returns 200 and logs last_seen_bump_failed", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await seedUser(SUBJECT, new Date(Date.now() - 30 * DAY).toISOString());
    await seedToken(TOKEN, SUBJECT);
    const spy = spyEnv({ failOn: BUMP_SQL });
    const res = await bearerApp().request("/x", auth(), spy.env);
    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalledWith("last_seen_bump_failed", expect.objectContaining({ subject: SUBJECT }));
  });

  it("a bump failure at run still returns 200 and logs last_seen_bump_failed", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await seedUser(SUBJECT, new Date(Date.now() - 30 * DAY).toISOString());
    await seedToken(TOKEN, SUBJECT);
    const spy = spyEnv({ rejectRunOn: BUMP_SQL });
    const res = await bearerApp().request("/x", auth(), spy.env);
    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalledWith("last_seen_bump_failed", expect.objectContaining({ subject: SUBJECT }));
  });

  it("O10b: a warned user's next call clears retention_warned_at even inside the throttle", async () => {
    const recent = new Date(Date.now() - 1 * HOUR).toISOString();
    await seedUser(SUBJECT, recent);
    await env.DB.prepare("UPDATE users SET retention_warned_at = ? WHERE subject = ?")
      .bind(new Date(Date.now() - 30 * 60 * 1000).toISOString(), SUBJECT).run();
    await seedToken(TOKEN, SUBJECT);
    const spy = spyEnv();
    const res = await bearerApp().request("/x", auth(), spy.env);
    expect(res.status).toBe(200);
    expect(spy.sql.filter((q) => BUMP_SQL.test(q))).toHaveLength(1);
    const row = await env.DB.prepare("SELECT retention_warned_at AS w FROM users WHERE subject = ?")
      .bind(SUBJECT).first<{ w: string | null }>();
    expect(row!.w).toBeNull();
  });

  it("the requireOwner gate (inline requireBearer with a dummy next) bumps too", async () => {
    const old = new Date(Date.now() - 30 * DAY).toISOString();
    await seedUser(SUBJECT, old);
    await seedToken(TOKEN, SUBJECT);
    const res = await ownerApp().request("/probe", auth(), env);
    expect(res.status).toBe(200);
    expect((await userRow(SUBJECT))!.last_seen).not.toBe(old);
  });
});
