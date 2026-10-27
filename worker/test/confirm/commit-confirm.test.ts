// O9.2: commit and the BEARER branch of acceptPlan, for an agent-confirm
// client (AGENT_CONFIRM_CLIENT_IDS), apply nothing. They email the user the
// plan's own accept email (the replan email with the capability accept link)
// and answer 202 awaiting_confirmation. The ONLY path that then commits is
// the existing capability accept POST (the human's click), which keeps the
// commit CAS, the 409 plan_superseded and the timezone guards, and refuses
// Authorization, a foreign Sec-Fetch-Site and delisted owners (O9.1).
// Non-gated clients are unchanged.
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppVariables } from "../../src/index-providers";
import { mountCommitRoute } from "../../src/planning/commit";
import { mountAcceptRoute } from "../../src/planning/accept";
import { mountResolveRoute } from "../../src/planning/resolve";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import type { NotificationProvider } from "../../src/providers/notification-provider";
import { hashToken } from "../../src/auth/tokens";
import { hashingKey } from "../../src/auth/crypto-keys";
import { verifyCapabilityWithEnv } from "../../src/auth/capability";
import { SMTP2GO_SEND_URL } from "../../src/mail/system-mailer";
import { AwaitingConfirmationResponse } from "../../src/confirm/defer";
import { RenderSnapshotSchema } from "../../src/schema/render-snapshot";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";

const OWNER = "operator@example.com";
const OTHER = "someone-else@example.com";
const AGENT = "agent-client";
const ISSUER = "https://scheduler.example.com";
const GATED = { AGENT_CONFIRM_CLIENT_IDS: AGENT, OAUTH_ISSUER: ISSUER };
const W1 = { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" };

const planBody = {
  schedule: [
    { task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00Z", end: "2026-05-19T10:30:00Z", context: "deep" },
  ],
  dropped: [],
  window: W1,
};

function snapshot(title = "Deep work", isEmpty = false) {
  return {
    tz: "Australia/Sydney", window: W1, trigger: "monday-cron", isEmpty,
    days: isEmpty ? [] : [{ date: "2026-05-19", before: [],
      after: [{ title, start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z", role: "added", origin: "task" }] }],
    dropped: [], warnings: [],
  };
}

async function seedPlan(
  hash: string,
  opts: { subject?: string; snap?: unknown; createdAt?: string; expiresAt?: string; committedAt?: string | null; windowTz?: string | null } = {},
) {
  await env.DB.prepare(
    "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end, render_snapshot, window_tz) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).bind(
    hash, JSON.stringify(planBody), opts.createdAt ?? "2026-05-18T00:00:00Z", opts.expiresAt ?? "2099-01-01T00:00:00Z",
    opts.committedAt ?? null, opts.subject ?? OWNER, W1.start, W1.end,
    opts.snap === null ? null : JSON.stringify(opts.snap ?? snapshot()), opts.windowTz ?? null,
  ).run();
}

async function seedBearer(token: string, subject = OWNER, clientId = AGENT) {
  const h = await hashToken(token, hashingKey(env));
  await env.DB.prepare(
    "INSERT OR REPLACE INTO oauth_tokens (hashed_token,client_id,scopes,expires_at,refresh_of,revoked_at,subject) VALUES (?,?,?,?,?,?,?)",
  ).bind(h, clientId, "scheduler:read scheduler:write", "2099-01-01T00:00:00Z", null, null, subject).run();
  return { Authorization: `Bearer ${token}` };
}

function makeApp(cal = new MockCalendarProvider(), notify: NotificationProvider = new MockNotificationProvider()) {
  const v1 = new OpenAPIHono<{ Bindings: typeof env; Variables: AppVariables }>();
  v1.use("*", async (c, next) => {
    c.set("calendarProvider", cal);
    c.set("notificationProvider", notify);
    await next();
  });
  mountCommitRoute(v1);
  mountAcceptRoute(v1);
  mountResolveRoute(v1 as any);
  const app = new Hono<{ Bindings: typeof env; Variables: AppVariables }>();
  app.route("/v1", v1);
  return { app, cal, notify };
}

const commit = (app: Hono<any>, headers: Record<string, string>, hash: string, e: Record<string, unknown> = GATED) =>
  app.request("/v1/commit", {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ plan_hash: hash }),
  }, { ...env, ...e });

const bearerAccept = (app: Hono<any>, headers: Record<string, string>, hash: string, e: Record<string, unknown> = GATED) =>
  app.request(`/v1/plans/${hash}/accept`, { method: "POST", headers }, { ...env, ...e });

/** The human's click: the accept page's own form POST (no Authorization). */
function humanAccept(app: Hono<any>, hash: string, t: string, extra: Record<string, string> = {}, e: Record<string, unknown> = GATED) {
  return app.request(`/v1/plans/${hash}/accept`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", ...extra },
    body: new URLSearchParams({ t, ws: W1.start, we: W1.end }),
  }, { ...env, ...e });
}

function acceptLink(url: string): { hash: string; t: string } {
  const m = /^https:\/\/scheduler\.example\.com\/v1\/plans\/([^/]+)\/accept\?t=([^&\s]+)$/.exec(url);
  if (!m) throw new Error(`not an accept link: ${url}`);
  return { hash: decodeURIComponent(m[1]!), t: decodeURIComponent(m[2]!) };
}

async function planRow(hash: string) {
  return env.DB.prepare("SELECT committed_at FROM proposed_plans WHERE plan_hash = ?").bind(hash).first<{ committed_at: string | null }>();
}
async function taskStatus() {
  return (await env.DB.prepare("SELECT status FROM tasks WHERE id = 't1'").first<{ status: string }>())?.status;
}
function expectNothingWritten(cal: MockCalendarProvider) {
  expect(cal.getCreated()).toHaveLength(0);
  expect(cal.getUpdated()).toHaveLength(0);
  expect(cal.getDeleted()).toHaveLength(0);
}

beforeEach(async () => {
  for (const t of ["proposed_plans", "tasks", "oauth_tokens", "users", "pending_actions"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.DB.prepare(
    "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES ('t1', ?, ?, 'pending', '2026-05-17T00:00:00Z', '2026-05-17T00:00:00Z')",
  ).bind(OWNER, JSON.stringify({ id: "t1", title: "Deep work" })).run();
});
afterEach(() => vi.restoreAllMocks());

describe("gated POST /v1/commit", () => {
  it("defers: 202 awaiting_confirmation, nothing written, the plan's accept email sent to the user", async () => {
    await seedPlan("h1");
    const { app, cal, notify } = makeApp();
    const res = await commit(app, await seedBearer("tok"), "h1");
    expect(res.status).toBe(202);
    const body = await res.json() as Record<string, unknown>;
    expect(AwaitingConfirmationResponse.safeParse(body).success).toBe(true);
    expect(body.status).toBe("awaiting_confirmation");
    expect(body.action_id).toBe("h1");
    expect(String(body.message)).toMatch(/accept/i);

    expectNothingWritten(cal);
    expect((await planRow("h1"))?.committed_at).toBeNull();
    expect(await taskStatus()).toBe("pending");

    expect((notify as MockNotificationProvider).sentPollEmails).toHaveLength(0);
    const m = (notify as MockNotificationProvider).sent;
    expect(m).toHaveLength(1);
    expect(m[0]!.to).toBe(OWNER);
    expect(m[0]!.opts.planHash).toBe("h1");
    // The stored snapshot, framed as the assistant's request.
    expect(m[0]!.model.trigger).toBe("api");
    expect(m[0]!.model.days).toEqual(snapshot().days);
    const { hash, t } = acceptLink(m[0]!.opts.acceptUrl);
    expect(hash).toBe("h1");
    const claims = await verifyCapabilityWithEnv(t, { ...env, ...GATED } as any);
    expect(claims).toMatchObject({ purpose: "accept", planHash: "h1", subject: OWNER, window: W1 });
    // The link outlives neither the plan nor the accept token.
    expect(Math.abs(Date.parse(String(body.expires_at)) - claims!.exp * 1000)).toBeLessThanOrEqual(1000);
  });

  it("the 202's expires_at is the plan's own expiry when that comes first", async () => {
    const soon = new Date(Date.now() + 3600_000).toISOString();
    await seedPlan("h1", { expiresAt: soon });
    const { app } = makeApp();
    const res = await commit(app, await seedBearer("tok"), "h1");
    expect(res.status).toBe(202);
    expect((await res.json() as { expires_at: string }).expires_at).toBe(soon);
  });

  it("the human's click on the emailed link commits exactly that plan", async () => {
    await seedPlan("h1");
    const { app, cal, notify } = makeApp();
    expect((await commit(app, await seedBearer("tok"), "h1")).status).toBe(202);
    const { hash, t } = acceptLink((notify as MockNotificationProvider).sent[0]!.opts.acceptUrl);

    const page = await app.request(`/v1/plans/${hash}/accept?t=${encodeURIComponent(t)}`, { method: "GET" }, { ...env, ...GATED });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`action="/v1/plans/h1/accept"`);

    const res = await humanAccept(app, hash, t);
    expect(res.status).toBe(200);
    expect(cal.getCreated()).toHaveLength(1);
    expect((await planRow("h1"))?.committed_at).not.toBeNull();
    expect(await taskStatus()).toBe("committed");
  });

  it("the agent can't click the link itself: its bearer on the capability POST is 403, nothing committed", async () => {
    await seedPlan("h1");
    const { app, cal, notify } = makeApp();
    const auth = await seedBearer("tok");
    await commit(app, auth, "h1");
    const { hash, t } = acceptLink((notify as MockNotificationProvider).sent[0]!.opts.acceptUrl);
    const res = await humanAccept(app, hash, t, auth);
    expect(res.status).toBe(403);
    expectNothingWritten(cal);
    expect((await planRow("h1"))?.committed_at).toBeNull();
  });

  it("superseded before the click: the link re-shows the week's newer plan (409) and commits nothing", async () => {
    await seedPlan("h1");
    const { app, cal, notify } = makeApp();
    await commit(app, await seedBearer("tok"), "h1");
    const { hash, t } = acceptLink((notify as MockNotificationProvider).sent[0]!.opts.acceptUrl);
    // A newer resolve for the same week supersedes (hard-deletes) h1.
    await env.DB.prepare("DELETE FROM proposed_plans WHERE plan_hash = 'h1'").run();
    await seedPlan("h2", { createdAt: "2026-05-18T06:00:00Z", snap: snapshot("Newer plan") });

    const html = await humanAccept(app, hash, t);
    expect(html.status).toBe(409);
    const text = await html.text();
    expect(text).toContain("Newer plan");
    expect(text).toContain(`action="/v1/plans/h2/accept"`);
    const json = await humanAccept(app, hash, t, { accept: "application/json" });
    expect(json.status).toBe(409);
    expect(await json.json()).toEqual({ error: "plan_superseded", latest_plan_hash: "h2" });

    expectNothingWritten(cal);
    expect((await planRow("h2"))?.committed_at).toBeNull();
    expect(await taskStatus()).toBe("pending");
  });

  it("timezone changed before the click: the old-tz plan commits nothing", async () => {
    await seedPlan("h1");
    const { app, cal, notify } = makeApp();
    await commit(app, await seedBearer("tok"), "h1");
    const { hash, t } = acceptLink((notify as MockNotificationProvider).sent[0]!.opts.acceptUrl);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO users (subject, home_tz, created_at) VALUES (?, 'America/Los_Angeles', '2026-05-01T00:00:00Z')",
    ).bind(OWNER).run();
    const res = await humanAccept(app, hash, t, { accept: "application/json" });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("plan_superseded");
    expectNothingWritten(cal);
    expect((await planRow("h1"))?.committed_at).toBeNull();
  });

  it("a second click is the idempotent already-committed answer: one commit", async () => {
    await seedPlan("h1");
    const { app, cal, notify } = makeApp();
    await commit(app, await seedBearer("tok"), "h1");
    const { hash, t } = acceptLink((notify as MockNotificationProvider).sent[0]!.opts.acceptUrl);
    const a = await humanAccept(app, hash, t, { accept: "application/json" });
    const b = await humanAccept(app, hash, t, { accept: "application/json" });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(cal.getCreated()).toHaveLength(1);
  });

  describe("re-checks the plan before mailing (same answers as a direct commit, no mail)", () => {
    const cases: Array<[string, () => Promise<void>, number, Record<string, unknown>]> = [
      ["an unknown hash", async () => {}, 404, { error: "not_found" }],
      ["another subject's plan", () => seedPlan("h1", { subject: OTHER }), 404, { error: "not_found" }],
      ["an old-tz plan", () => seedPlan("h1", { windowTz: "America/Los_Angeles" }), 404, { error: "not_found" }],
      ["an expired plan", () => seedPlan("h1", { expiresAt: "2020-01-01T00:00:00Z" }), 410, { error: "plan_expired" }],
      ["an already-committed plan", () => seedPlan("h1", { committedAt: "2026-05-18T01:00:00Z" }), 200, { plan_hash: "h1", already_committed: true }],
    ];
    for (const [name, seed, status, json] of cases) {
      it(`${name}: ${status}`, async () => {
        await seed();
        const { app, cal, notify } = makeApp();
        const res = await commit(app, await seedBearer("tok"), "h1");
        expect(res.status).toBe(status);
        expect(await res.json()).toEqual(json);
        expect((notify as MockNotificationProvider).sent).toHaveLength(0);
        expectNothingWritten(cal);
      });
    }
  });

  for (const [name, snap] of [["no review snapshot", null], ["an empty diff", snapshot("x", true)]] as const) {
    it(`a plan with ${name}: 409 plan_not_reviewable, no mail, nothing written`, async () => {
      await seedPlan("h1", { snap });
      const { app, cal, notify } = makeApp();
      const res = await commit(app, await seedBearer("tok"), "h1");
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "plan_not_reviewable" });
      expect((notify as MockNotificationProvider).sent).toHaveLength(0);
      expectNothingWritten(cal);
      expect((await planRow("h1"))?.committed_at).toBeNull();
    });
  }

  it("falls back to the system mailer (accept link only) when the user's own mailbox fails", async () => {
    await seedPlan("h1");
    const failing: NotificationProvider = {
      sendReplanNotification: async () => { throw new Error("gmail 500"); },
      sendPollEmail: async () => {},
    };
    const sends: Array<{ to: string[]; subject: string; text_body: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== SMTP2GO_SEND_URL) throw new Error(`unexpected fetch ${url}`);
      sends.push(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify({ data: { succeeded: 1, failed: 0 } }), { status: 200 });
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, cal } = makeApp(new MockCalendarProvider(), failing);
    const res = await commit(app, await seedBearer("tok"), "h1", {
      ...GATED, SYSTEM_MAIL_ENABLED: "true", SYSTEM_MAIL_FROM: "Optical <o@example.test>", SYSTEM_MAIL_API_KEY: "k",
    });
    expect(res.status).toBe(202);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toEqual([OWNER]);
    // Only static copy and the link go through the system mailer: no titles.
    expect(sends[0]!.text_body).not.toContain("Deep work");
    const url = /(https:\/\/scheduler\.example\.com\/v1\/plans\/\S+)/.exec(sends[0]!.text_body)![1]!;
    expect(acceptLink(url).hash).toBe("h1");
    expectNothingWritten(cal);
  });

  it("503 confirmation_unavailable when no mail can be sent; nothing written", async () => {
    await seedPlan("h1");
    const failing: NotificationProvider = {
      sendReplanNotification: async () => { throw new Error("down"); },
      sendPollEmail: async () => {},
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, cal } = makeApp(new MockCalendarProvider(), failing);
    const res = await commit(app, await seedBearer("tok"), "h1", { ...GATED, SYSTEM_MAIL_ENABLED: "false" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "confirmation_unavailable" });
    expectNothingWritten(cal);
    expect((await planRow("h1"))?.committed_at).toBeNull();
  });

  describe("non-gated clients are unchanged", () => {
    it("a client not on the list commits directly", async () => {
      await seedPlan("h1");
      const { app, cal, notify } = makeApp();
      const res = await commit(app, await seedBearer("tok", OWNER, "smoke-cli"), "h1");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ plan_hash: "h1", committed: 1 });
      expect(cal.getCreated()).toHaveLength(1);
      expect((notify as MockNotificationProvider).sent).toHaveLength(0);
    });

    it("AGENT_CONFIRM_CLIENT_IDS unset: commits directly, even a plan with no snapshot", async () => {
      await seedPlan("h1", { snap: null });
      const { app, cal } = makeApp();
      const res = await commit(app, await seedBearer("tok"), "h1", { AGENT_CONFIRM_CLIENT_IDS: undefined });
      expect(res.status).toBe(200);
      expect(cal.getCreated()).toHaveLength(1);
    });
  });
});

describe("gated POST /v1/plans/{h}/accept (bearer branch)", () => {
  it("defers like commit: 202, nothing written, accept email sent", async () => {
    await seedPlan("h1");
    const { app, cal, notify } = makeApp();
    const res = await bearerAccept(app, await seedBearer("tok"), "h1");
    expect(res.status).toBe(202);
    const body = await res.json() as Record<string, unknown>;
    expect(AwaitingConfirmationResponse.safeParse(body).success).toBe(true);
    expect(body.action_id).toBe("h1");
    expectNothingWritten(cal);
    expect((await planRow("h1"))?.committed_at).toBeNull();
    const m = (notify as MockNotificationProvider).sent;
    expect(m).toHaveLength(1);
    expect(m[0]!.model.trigger).toBe("api");
    const { hash, t } = acceptLink(m[0]!.opts.acceptUrl);
    expect((await humanAccept(app, hash, t)).status).toBe(200);
    expect(cal.getCreated()).toHaveLength(1);
  });

  it("a superseded hash: 409 plan_superseded, no mail", async () => {
    await seedPlan("h2");
    const { app, cal, notify } = makeApp();
    const res = await bearerAccept(app, await seedBearer("tok"), "h1");
    expect(res.status).toBe(409);
    // The bearer path has no ws/we or token window, so no latest hash is named.
    expect(await res.json()).toEqual({ error: "plan_superseded" });
    expect((notify as MockNotificationProvider).sent).toHaveLength(0);
    expectNothingWritten(cal);
  });

  it("an expired plan: 410, no mail", async () => {
    await seedPlan("h1", { expiresAt: "2020-01-01T00:00:00Z" });
    const { app, notify } = makeApp();
    const res = await bearerAccept(app, await seedBearer("tok"), "h1");
    expect(res.status).toBe(410);
    expect((notify as MockNotificationProvider).sent).toHaveLength(0);
  });

  it("an already-committed plan: idempotent 200, no mail", async () => {
    await seedPlan("h1", { committedAt: "2026-05-18T01:00:00Z" });
    const { app, notify } = makeApp();
    const res = await bearerAccept(app, await seedBearer("tok"), "h1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((notify as MockNotificationProvider).sent).toHaveLength(0);
  });

  it("a plan with no review snapshot: 409 plan_not_reviewable, nothing written", async () => {
    await seedPlan("h1", { snap: null });
    const { app, cal, notify } = makeApp();
    const res = await bearerAccept(app, await seedBearer("tok"), "h1");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "plan_not_reviewable" });
    expect((notify as MockNotificationProvider).sent).toHaveLength(0);
    expectNothingWritten(cal);
  });

  it("a client not on the list commits directly", async () => {
    await seedPlan("h1");
    const { app, cal } = makeApp();
    const res = await bearerAccept(app, await seedBearer("tok", OWNER, "smoke-cli"), "h1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(cal.getCreated()).toHaveLength(1);
  });
});

describe("gated POST /v1/resolve attaches the review snapshot", () => {
  const taskBody = {
    id: "t1", title: "Deep work", context: "deep", priority: 80, duration_minutes: 60,
    earliest_start: "2026-05-18T00:00:00Z", preferred_windows: [], dependencies: [], pinned_at: null,
    template_id: null, project_id: null, source: { kind: "mcp", external_id: null }, status: "pending",
    created_at: "2026-05-17T00:00:00Z", updated_at: "2026-05-17T00:00:00Z",
  };
  const stubSolver = {
    fetch: async () => new Response(JSON.stringify({
      schedule: [{ task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00", duration_minutes: 60, context: "deep" }],
      dropped: [],
      objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } },
      diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  } as unknown as Fetcher;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
    await env.DB.prepare("DELETE FROM config_weights").run();
    await env.DB.prepare("DELETE FROM config_contexts").run();
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)").bind(JSON.stringify({
      time_of_day_fit_per_15min: 5, churn_per_15min_moved: 10, priority_unit: 1, base_drop_penalty: 200,
    })).run();
    await seedMissingDefaultContexts();
    await env.DB.prepare("UPDATE tasks SET body = ? WHERE id = 't1'").bind(JSON.stringify(taskBody)).run();
  });
  afterEach(() => vi.useRealTimers());

  const resolve = (app: Hono<any>, headers: Record<string, string>, e: Record<string, unknown>) =>
    app.request("/v1/resolve", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ window_start: W1.start, window_end: W1.end }),
    }, { ...env, SOLVER: stubSolver, ...e });

  it("resolve → commit (202) → the human's click commits it", async () => {
    const { app, cal, notify } = makeApp();
    const auth = await seedBearer("tok");
    const r = await resolve(app, auth, GATED);
    expect(r.status).toBe(200);
    const { plan_hash } = await r.json() as { plan_hash: string };
    const row = await env.DB.prepare("SELECT render_snapshot FROM proposed_plans WHERE plan_hash = ?")
      .bind(plan_hash).first<{ render_snapshot: string | null }>();
    const snap = JSON.parse(row!.render_snapshot!);
    expect(snap.trigger).toBe("api");
    expect(snap.isEmpty).toBe(false);
    expect(RenderSnapshotSchema.safeParse(snap).success).toBe(true);
    expect(JSON.stringify(snap)).toContain("Deep work");
    // Resolving mails nothing and writes nothing to the calendar.
    expect((notify as MockNotificationProvider).sent).toHaveLength(0);
    expectNothingWritten(cal);

    const c = await commit(app, auth, plan_hash);
    expect(c.status).toBe(202);
    expectNothingWritten(cal);
    const { hash, t } = acceptLink((notify as MockNotificationProvider).sent[0]!.opts.acceptUrl);
    expect(hash).toBe(plan_hash);
    expect((await humanAccept(app, hash, t)).status).toBe(200);
    expect(cal.getCreated()).toHaveLength(1);
    expect(cal.getCreated()[0]!.summary).toBe("Deep work");
  });

  it("a failed snapshot write doesn't fail the resolve; the gated commit is then plan_not_reviewable", async () => {
    // D1 that refuses only the snapshot UPDATE.
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("SET render_snapshot")) throw new Error("d1 down");
            return target.prepare(sql);
          };
        }
        const v = (target as any)[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a); });
    const { app, cal, notify } = makeApp();
    const auth = await seedBearer("tok");
    const r = await resolve(app, auth, { ...GATED, DB: db });
    expect(r.status).toBe(200);
    const { plan_hash } = await r.json() as { plan_hash: string };
    expect(errors.some((e) => e[0] === "resolve_review_snapshot_failed")).toBe(true);
    const c = await commit(app, auth, plan_hash);
    expect(c.status).toBe(409);
    expect(await c.json()).toEqual({ error: "plan_not_reviewable" });
    expect((notify as MockNotificationProvider).sent).toHaveLength(0);
    expectNothingWritten(cal);
  });

  it("a non-gated resolve stores no snapshot (unchanged)", async () => {
    const { app } = makeApp();
    const r = await resolve(app, await seedBearer("tok", OWNER, "smoke-cli"), GATED);
    expect(r.status).toBe(200);
    const { plan_hash } = await r.json() as { plan_hash: string };
    const row = await env.DB.prepare("SELECT render_snapshot FROM proposed_plans WHERE plan_hash = ?")
      .bind(plan_hash).first<{ render_snapshot: string | null }>();
    expect(row!.render_snapshot).toBeNull();
  });
});

// Decision K: re-asking for the same plan doesn't re-send its accept email,
// and the owner's live pending actions (plan mails included) are capped.
describe("dedupe and cap for plan commits (decision K)", () => {
  it("a second gated commit of the same plan returns the first 202 and sends no second email", async () => {
    await seedPlan("h1");
    const { app, notify } = makeApp();
    const headers = await seedBearer("tok");
    const a = await commit(app, headers, "h1");
    const b = await commit(app, headers, "h1");
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    const ab = await a.json() as Record<string, unknown>;
    expect(await b.json()).toEqual(ab);
    expect((notify as MockNotificationProvider).sent).toHaveLength(1);
  });

  it("commit then the bearer accept of the same plan: still one email", async () => {
    await seedPlan("h1");
    const { app, notify } = makeApp();
    const headers = await seedBearer("tok");
    expect((await commit(app, headers, "h1")).status).toBe(202);
    expect((await bearerAccept(app, headers, "h1")).status).toBe(202);
    expect((notify as MockNotificationProvider).sent).toHaveLength(1);
  });

  it("a different plan mails again", async () => {
    await seedPlan("h1");
    await seedPlan("h2");
    const { app, notify } = makeApp();
    const headers = await seedBearer("tok");
    expect((await commit(app, headers, "h1")).status).toBe(202);
    expect((await commit(app, headers, "h2")).status).toBe(202);
    expect((notify as MockNotificationProvider).sent).toHaveLength(2);
  });

  it("an undeliverable first try leaves nothing behind: the retry mails", async () => {
    await seedPlan("h1");
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const flaky = new MockNotificationProvider();
    const orig = flaky.sendReplanNotification.bind(flaky);
    flaky.sendReplanNotification = async (...args) => { if (fail) throw new Error("down"); return orig(...args); };
    const { app } = makeApp(new MockCalendarProvider(), flaky);
    const headers = await seedBearer("tok");
    expect((await commit(app, headers, "h1", { ...GATED, SYSTEM_MAIL_ENABLED: "false" })).status).toBe(503);
    fail = false;
    expect((await commit(app, headers, "h1")).status).toBe(202);
    expect(flaky.sent).toHaveLength(1);
  });

  it("at the live-action cap a new plan mail is 429 too_many_pending_actions; nothing sent", async () => {
    await seedPlan("h1");
    for (let i = 0; i < 20; i++) {
      await env.DB.prepare(
        "INSERT INTO pending_actions (id, owner_subject, op, payload, summary, created_at, expires_at, consumed_at) VALUES (?,?,?,?,?,?,?,NULL)",
      ).bind(`seed-${i}`, OWNER, "test.op", `{"i":${i}}`, "{}", new Date().toISOString(), "2099-01-01T00:00:00.000Z").run();
    }
    const { app, cal, notify } = makeApp();
    const res = await commit(app, await seedBearer("tok"), "h1");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "too_many_pending_actions" });
    expect((notify as MockNotificationProvider).sent).toHaveLength(0);
    expectNothingWritten(cal);
  });

  it("the system-mailer fallback is limited per owner too: past the limit, 503 and no SMTP2GO call", async () => {
    await seedPlan("h1");
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare(
        "INSERT INTO pending_actions (id, owner_subject, op, payload, summary, created_at, expires_at, consumed_at, mail_channel) VALUES (?,?,?,?,?,?,?,NULL,'system')",
      ).bind(`sys-${i}`, OWNER, "test.op", `{"i":${i}}`, "{}", new Date().toISOString(), "2099-01-01T00:00:00.000Z").run();
    }
    const failing: NotificationProvider = {
      sendReplanNotification: async () => { throw new Error("gmail 500"); },
      sendPollEmail: async () => {},
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ data: { succeeded: 1, failed: 0 } })));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { app } = makeApp(new MockCalendarProvider(), failing);
    const res = await commit(app, await seedBearer("tok"), "h1", {
      ...GATED, SYSTEM_MAIL_ENABLED: "true", SYSTEM_MAIL_FROM: "Optical <o@example.test>", SYSTEM_MAIL_API_KEY: "k",
    });
    expect(res.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// Final review #3: a plan's accept-email marker must not hold a live-cap slot
// once the plan can no longer be accepted (committed, or superseded and
// deleted), or 20 accepted plans would lock every gated op for up to 72 h.
describe("plan-commit markers free their live-cap slot (decision K, final review #3)", () => {
  async function seedOtherLive(n: number) {
    for (let i = 0; i < n; i++) {
      await env.DB.prepare(
        "INSERT INTO pending_actions (id, owner_subject, op, payload, summary, created_at, expires_at, consumed_at) VALUES (?,?,?,?,?,?,?,NULL)",
      ).bind(`live-${i}`, OWNER, "test.op", `{"i":${i}}`, "{}", new Date().toISOString(), "2099-01-01T00:00:00.000Z").run();
    }
  }

  it("(a) once the user accepts h1, a gated commit of h2 is deferred, not 429", async () => {
    await seedPlan("h1");
    await seedPlan("h2");
    await seedOtherLive(19);
    const { app, notify } = makeApp();
    const headers = await seedBearer("tok");
    expect((await commit(app, headers, "h1")).status).toBe(202);
    const { hash, t } = acceptLink((notify as MockNotificationProvider).sent[0]!.opts.acceptUrl);
    expect((await humanAccept(app, hash, t)).status).toBe(200);
    expect((await commit(app, headers, "h2")).status).toBe(202);
  });

  it("(b) once h1 is superseded (its row deleted), a gated commit of h2 is deferred, not 429", async () => {
    await seedPlan("h1");
    await seedPlan("h2");
    await seedOtherLive(19);
    const { app } = makeApp();
    const headers = await seedBearer("tok");
    expect((await commit(app, headers, "h1")).status).toBe(202);
    await env.DB.prepare("DELETE FROM proposed_plans WHERE plan_hash = 'h1'").run();
    expect((await commit(app, headers, "h2")).status).toBe(202);
  });

  it("a still-pending plan's marker keeps its slot (the cap still bites)", async () => {
    await seedPlan("h1");
    await seedPlan("h2");
    await seedOtherLive(19);
    const { app } = makeApp();
    const headers = await seedBearer("tok");
    expect((await commit(app, headers, "h1")).status).toBe(202);
    expect((await commit(app, headers, "h2")).status).toBe(429);
  });

  it("another owner's pending plan of the same hash doesn't keep this owner's marker alive", async () => {
    await seedPlan("h1");
    await seedPlan("h2");
    await seedOtherLive(19);
    const { app } = makeApp();
    const headers = await seedBearer("tok");
    expect((await commit(app, headers, "h1")).status).toBe(202);
    // h1 is accepted by the owner; a different subject's row can't share the
    // primary key, so model "someone else's pending plan" as h1 moving to them.
    await env.DB.prepare("UPDATE proposed_plans SET subject = ? WHERE plan_hash = 'h1'").bind(OTHER).run();
    expect((await commit(app, headers, "h2")).status).toBe(202);
  });

  it("a third gated call after a consumed (blanked) marker exists still defers", async () => {
    await seedPlan("h1");
    await seedPlan("h2");
    await seedPlan("h3");
    const { app, notify } = makeApp();
    const headers = await seedBearer("tok");
    expect((await commit(app, headers, "h1")).status).toBe(202);
    const { hash, t } = acceptLink((notify as MockNotificationProvider).sent[0]!.opts.acceptUrl);
    expect((await humanAccept(app, hash, t)).status).toBe(200);
    expect((await commit(app, headers, "h2")).status).toBe(202); // consumes and blanks h1's marker
    const blank = await env.DB.prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE op = 'plan.commit-mail' AND payload = ''").first<{ n: number }>();
    expect(blank?.n).toBe(1);
    expect((await commit(app, headers, "h3")).status).toBe(202);
  });

  it("a live marker with a blank or non-JSON payload never makes the release step throw", async () => {
    await seedPlan("h1");
    for (const [id, payload] of [["blank", ""], ["junk", "not json"]] as const) {
      await env.DB.prepare(
        "INSERT INTO pending_actions (id, owner_subject, op, payload, summary, created_at, expires_at, consumed_at) VALUES (?,?,?,?,?,?,?,NULL)",
      ).bind(id, OWNER, "plan.commit-mail", payload, "", new Date().toISOString(), "2099-01-01T00:00:00.000Z").run();
    }
    const { app } = makeApp();
    expect((await commit(app, await seedBearer("tok"), "h1")).status).toBe(202);
  });

  it("an expired plan's marker frees its slot too (it can no longer be accepted)", async () => {
    await seedPlan("h1");
    await seedPlan("h2");
    await seedOtherLive(19);
    const { app } = makeApp();
    const headers = await seedBearer("tok");
    expect((await commit(app, headers, "h1")).status).toBe(202);
    await env.DB.prepare("UPDATE proposed_plans SET expires_at = ? WHERE plan_hash = 'h1'").bind(new Date(Date.now() - 1000).toISOString()).run();
    expect((await commit(app, headers, "h2")).status).toBe(202);
  });

  it("only plan markers are freed: other ops' live rows keep their slots", async () => {
    await seedPlan("h1");
    await seedOtherLive(20);
    const { app } = makeApp();
    expect((await commit(app, await seedBearer("tok"), "h1")).status).toBe(429);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE op = 'test.op' AND consumed_at IS NULL").first<{ n: number }>();
    expect(n?.n).toBe(20);
  });
});

// Owner mail goes to the latest verified sign-in address (login_email,
// migration 0046), never the bare subject, which an IdP rename can hand to
// someone else; NULL falls back to the subject. The marker row stays keyed
// on the subject.
describe("gated commit: accept email recipient (ownerNotificationEmail)", () => {
  async function seedIdentity(loginEmail: string | null) {
    await env.DB.prepare("DELETE FROM identity_tokens").run();
    await env.DB.prepare(
      "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject, login_email) VALUES (?,?,?,?,?,?,?)",
    ).bind(OWNER, new Uint8Array([1]).buffer, "s", "2026-01-01T00:00:00Z", "google", "sub-o", loginEmail).run();
  }
  afterEach(async () => { await env.DB.prepare("DELETE FROM identity_tokens").run(); });

  for (const [label, loginEmail, expected] of [
    ["login_email set", "owner-now@example.com", "owner-now@example.com"],
    ["login_email NULL", null, OWNER],
  ] as const) {
    it(`own-mailbox accept email goes to ${expected} (${label})`, async () => {
      await seedIdentity(loginEmail);
      await seedPlan("h1");
      const { app, notify } = makeApp();
      const res = await commit(app, await seedBearer("tok"), "h1");
      expect(res.status).toBe(202);
      expect((notify as MockNotificationProvider).sent.map((m) => m.to)).toEqual([expected]);
      const owners = await env.DB.prepare("SELECT owner_subject FROM pending_actions").all<{ owner_subject: string }>();
      expect(owners.results.map((r) => r.owner_subject)).toEqual([OWNER]);
    });

    it(`system-mail fallback goes to ${expected} (${label})`, async () => {
      await seedIdentity(loginEmail);
      await seedPlan("h1");
      const failing: NotificationProvider = {
        sendReplanNotification: async () => { throw new Error("gmail 500"); },
        sendPollEmail: async () => {},
      };
      const sends: Array<{ to: string[] }> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_i: RequestInfo | URL, init?: RequestInit) => {
        sends.push(JSON.parse(String(init!.body)));
        return new Response(JSON.stringify({ data: { succeeded: 1, failed: 0 } }), { status: 200 });
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { app } = makeApp(new MockCalendarProvider(), failing);
      const res = await commit(app, await seedBearer("tok"), "h1", {
        ...GATED, SYSTEM_MAIL_ENABLED: "true", SYSTEM_MAIL_FROM: "Optical <o@example.test>", SYSTEM_MAIL_API_KEY: "k",
      });
      expect(res.status).toBe(202);
      expect(sends.map((s) => s.to)).toEqual([[expected]]);
    });
  }
});
