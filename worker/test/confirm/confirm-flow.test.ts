// O9.1 agent-confirm mechanism, end to end through a test-only registered op:
// a gated OAuth client's call is deferred (202 + pending_actions row + mail to
// the user), the emailed GET /confirm/{id} page shows the escaped summary, and
// only the browser POST (never one carrying Authorization) consumes the row
// with a CAS and replays the op, which re-validates state at that moment.
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AppVariables } from "../../src/index-providers";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import type { NotificationProvider, PollEmail } from "../../src/providers/notification-provider";
import { requireOwner } from "../../src/middleware/owner-gate";
import { hashToken } from "../../src/auth/tokens";
import { hashingKey } from "../../src/auth/crypto-keys";
import { signCapabilityWithEnv } from "../../src/auth/capability";
import { SMTP2GO_SEND_URL } from "../../src/mail/system-mailer";
import { registerConfirmableOp, getConfirmableOp } from "../../src/confirm/registry";
import { confirmationRequired } from "../../src/confirm/gate";
import {
  deferForConfirmation,
  AwaitingConfirmationResponse,
  confirmationResponses,
  PENDING_ACTION_TTL_SECONDS,
} from "../../src/confirm/defer";
import { mountConfirmRoutes } from "../../src/confirm/route";
import { upsertUser } from "../../src/db/users";
import { PENDING_ACTION_LIVE_CAP, SYSTEM_FALLBACK_DAILY_LIMIT } from "../../src/db/pending-actions";

const A = "alice@org";
const B = "bob@org";
const AGENT = "agent-client";
const ISSUER = "https://scheduler.example.com";
const EVIL_TITLE = `<script>alert("x")</script> & "quotes"`;
const EVIL_RECIPIENT = `"><img src=x onerror=alert(1)>@evil.test`;

// ---- test-only op ---------------------------------------------------------
const calls: Array<{ owner: string; payload: { n: number }; actionId: string }> = [];
const state = { blocked: false, throws: false, links: undefined as undefined | Array<{ label: string; url: string; copy?: boolean }> };

registerConfirmableOp("test.echo", {
  label: "Run the test echo",
  payloadSchema: z.object({ n: z.number() }),
  summarySchema: z.object({ title: z.string(), recipients: z.array(z.string()) }),
  render: (s) => ({
    heading: "Send a test echo",
    recipients: s.recipients,
    text: [{ label: "Title", value: s.title }],
    slot: "Tue 13 Oct, 09:00-10:00",
    moves: [{ title: s.title, from: "Mon 09:00", to: "Tue 09:00" }],
  }),
  replay: async (_env, owner, payload, deps) => {
    calls.push({ owner, payload, actionId: deps.actionId });
    // The re-validation hook: the op checks live state at confirm time.
    if (state.blocked) return { ok: false, reason: "stale", message: "That was already done elsewhere." };
    if (state.throws) throw new Error(`boom for ${owner}`);
    return { ok: true, message: `Echoed ${payload.n}.`, ...(state.links ? { links: state.links } : {}) };
  },
});

// ---- app ------------------------------------------------------------------
function makeApp(notify: NotificationProvider = new MockNotificationProvider()) {
  const v1 = new OpenAPIHono<{ Bindings: typeof env; Variables: AppVariables }>();
  const route = createRoute({
    method: "post",
    path: "/test-op",
    operationId: "testOp",
    request: { body: { content: { "application/json": { schema: z.object({ n: z.number(), title: z.string() }) } } } },
    responses: {
      200: { content: { "application/json": { schema: z.object({ direct: z.boolean() }) } }, description: "Ran directly" },
      ...confirmationResponses,
    },
  });
  v1.openapi(route, async (c) => {
    const owner = await requireOwner(c);
    if (owner instanceof Response) return owner as any;
    const body = c.req.valid("json");
    if (confirmationRequired(c)) {
      return deferForConfirmation(c, {
        op: "test.echo",
        payload: { n: body.n },
        summary: { title: body.title, recipients: [EVIL_RECIPIENT] },
      }) as any;
    }
    return c.json({ direct: true }, 200);
  });
  const app = new Hono<{ Bindings: typeof env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("notificationProvider", notify);
    await next();
  });
  mountConfirmRoutes(app);
  app.route("/v1", v1);
  return { app, v1 };
}

const GATED = { AGENT_CONFIRM_CLIENT_IDS: AGENT, OAUTH_ISSUER: ISSUER };

async function seedBearer(token: string, subject: string, clientId = AGENT) {
  // An active users row, as every signed-in subject has (the confirm route
  // requires one).
  await upsertUser(env.DB, subject);
  const h = await hashToken(token, hashingKey(env));
  await env.DB.prepare(
    "INSERT OR REPLACE INTO oauth_tokens (hashed_token,client_id,scopes,expires_at,refresh_of,revoked_at,subject) VALUES (?,?,?,?,?,?,?)",
  ).bind(h, clientId, "scheduler:read scheduler:write", "2099-01-01T00:00:00Z", null, null, subject).run();
  return { Authorization: `Bearer ${token}` };
}

function callOp(app: Hono<any>, headers: Record<string, string>, e: Record<string, unknown> = GATED, title = EVIL_TITLE, n = 7) {
  return app.request(
    "/v1/test-op",
    { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ n, title }) },
    { ...env, ...e },
  );
}

function linkFrom(text: string): { id: string; t: string; path: string } {
  const m = /https:\/\/scheduler\.example\.com(\/confirm\/([0-9a-f-]+)\?t=([^\s"<]+))/.exec(text);
  if (!m) throw new Error("no confirm link in mail");
  return { path: m[1]!, id: m[2]!, t: decodeURIComponent(m[3]!) };
}

/** Defers one action for `owner` and returns its id and emailed token. */
async function deferOne(owner = A) {
  const notify = new MockNotificationProvider();
  const { app } = makeApp(notify);
  const res = await callOp(app, await seedBearer(`tok-${owner}`, owner));
  expect(res.status).toBe(202);
  const mail = notify.sentPollEmails.at(-1)!;
  return { ...linkFrom(mail.text), app, mail, body: await res.json() as Record<string, unknown> };
}

function getPage(app: Hono<any>, id: string, t: string, e: Record<string, unknown> = {}) {
  return app.request(`/confirm/${id}?t=${encodeURIComponent(t)}`, { method: "GET" }, { ...env, ...GATED, ...e });
}

function postConfirm(
  app: Hono<any>, id: string, t: string, extraHeaders: Record<string, string> = {}, e: Record<string, unknown> = {},
) {
  return app.request(
    `/confirm/${id}`,
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...extraHeaders }, body: `t=${encodeURIComponent(t)}` },
    { ...env, ...GATED, ...e },
  );
}

async function row(id: string) {
  return env.DB.prepare("SELECT * FROM pending_actions WHERE id = ?").bind(id).first<{
    id: string; owner_subject: string; op: string; payload: string; summary: string;
    created_at: string; expires_at: string; consumed_at: string | null;
  }>();
}

function expectPageHeaders(res: Response) {
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(res.headers.get("Content-Type")).toContain("text/html");
}

beforeEach(async () => {
  for (const t of ["oauth_tokens", "pending_actions", "audit_log", "users"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  calls.length = 0;
  state.blocked = false;
  state.throws = false;
  state.links = undefined;
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
describe("registry", () => {
  it("returns a registered op and nothing for an unknown one", () => {
    expect(getConfirmableOp("test.echo")?.label).toBe("Run the test echo");
    expect(getConfirmableOp("no.such.op")).toBeUndefined();
  });

  it("refuses a duplicate registration (two modules claiming one op name is a wiring bug)", () => {
    expect(() => registerConfirmableOp("test.echo", getConfirmableOp("test.echo")!)).toThrow(/already registered/);
  });
});

describe("deferral (gated client)", () => {
  it("an ungated client runs the op directly: no row, no mail", async () => {
    const notify = new MockNotificationProvider();
    const { app } = makeApp(notify);
    const res = await callOp(app, await seedBearer("tok-direct", A), { OAUTH_ISSUER: ISSUER, AGENT_CONFIRM_CLIENT_IDS: undefined });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ direct: true });
    expect(notify.sentPollEmails).toHaveLength(0);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM pending_actions").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("a client not in the csv runs directly", async () => {
    const { app } = makeApp();
    const res = await callOp(app, await seedBearer("tok-other", A, "other-client"));
    expect(res.status).toBe(200);
  });

  it('"*" gates every client', async () => {
    const { app } = makeApp();
    const res = await callOp(app, await seedBearer("tok-star", A, "other-client"), { ...GATED, AGENT_CONFIRM_CLIENT_IDS: "*" });
    expect(res.status).toBe(202);
  });

  it("returns 202 awaiting_confirmation in the exported schema's shape, nothing replayed yet", async () => {
    const before = Date.now();
    const { body, id } = await deferOne();
    const parsed = AwaitingConfirmationResponse.parse(body);
    expect(Object.keys(body).sort()).toEqual(["action_id", "expires_at", "message", "status"]);
    expect(parsed.status).toBe("awaiting_confirmation");
    expect(parsed.action_id).toBe(id);
    const exp = Date.parse(parsed.expires_at);
    expect(exp).toBeGreaterThanOrEqual(before + PENDING_ACTION_TTL_SECONDS * 1000 - 1000);
    expect(exp).toBeLessThanOrEqual(Date.now() + PENDING_ACTION_TTL_SECONDS * 1000 + 1000);
    expect(PENDING_ACTION_TTL_SECONDS).toBe(24 * 3600);
    expect(calls).toHaveLength(0);
  });

  it("stores an owner-scoped row with the validated payload and summary", async () => {
    const { id, body } = await deferOne();
    const r = await row(id);
    expect(r).toMatchObject({ owner_subject: A, op: "test.echo", consumed_at: null, expires_at: body.expires_at });
    expect(JSON.parse(r!.payload)).toEqual({ n: 7 });
    expect(JSON.parse(r!.summary)).toEqual({ title: EVIL_TITLE, recipients: [EVIL_RECIPIENT] });
  });

  it("mails the user (to themselves) a confirm link carrying only the op's static label, never agent text", async () => {
    const { mail, id } = await deferOne();
    expect(mail.to).toBe(A);
    expect(mail.subject).toContain("Run the test echo");
    expect(mail.text).toContain(`${ISSUER}/confirm/${id}?t=`);
    expect(mail.html).toContain(`${ISSUER}/confirm/${id}?t=`);
    for (const part of [mail.subject, mail.text, mail.html]) {
      expect(part).not.toContain("script");
      expect(part).not.toContain("onerror");
    }
  });

  it("falls back to the system mailer when the user's own provider fails", async () => {
    const failing: NotificationProvider = {
      sendReplanNotification: async () => {},
      sendPollEmail: async (_e: PollEmail) => { throw new Error("gmail 500"); },
    };
    const sends: Array<{ to: string[]; subject: string; text_body: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== SMTP2GO_SEND_URL) throw new Error(`unexpected fetch ${url}`);
      sends.push(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify({ data: { succeeded: 1, failed: 0 } }), { status: 200 });
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = makeApp(failing);
    const res = await callOp(app, await seedBearer("tok-fb", A), {
      ...GATED, SYSTEM_MAIL_ENABLED: "true", SYSTEM_MAIL_FROM: "Optical <o@example.test>", SYSTEM_MAIL_API_KEY: "k",
    });
    expect(res.status).toBe(202);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.to).toEqual([A]);
    const { id } = linkFrom(sends[0]!.text_body);
    expect((await row(id))?.owner_subject).toBe(A);
  });

  it("503 confirmation_unavailable and no row when neither channel delivers", async () => {
    const failing: NotificationProvider = {
      sendReplanNotification: async () => {},
      sendPollEmail: async () => { throw new Error("down"); },
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = makeApp(failing);
    const res = await callOp(app, await seedBearer("tok-none", A), { ...GATED, SYSTEM_MAIL_ENABLED: "false" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "confirmation_unavailable" });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM pending_actions").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("housekeeping on every deferral: expired rows (any owner) lose their data, rows a week past expiry go", async () => {
    const insert = (id: string, owner: string, expires: string, consumed: string | null = null) =>
      env.DB.prepare(
        "INSERT INTO pending_actions (id, owner_subject, op, payload, summary, created_at, expires_at, consumed_at) VALUES (?,?,?,?,?,?,?,?)",
      ).bind(id, owner, "test.echo", '{"n":1}', '{"title":"secret"}', "2026-01-01T00:00:00.000Z", expires, consumed).run();
    const justExpired = new Date(Date.now() - 3600_000).toISOString();
    const longExpired = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
    const live = new Date(Date.now() + 3600_000).toISOString();
    await insert("old-a", A, longExpired);
    await insert("old-b", B, longExpired);
    await insert("old-consumed", B, longExpired, longExpired);
    await insert("recent-b", B, justExpired);
    await insert("live-b", B, live);
    await deferOne(A);
    expect(await row("old-a")).toBeNull();
    expect(await row("old-b")).toBeNull();
    expect(await row("old-consumed")).toBeNull();
    // Kept (so its link still says "expired"), but its data is gone.
    expect(await row("recent-b")).toMatchObject({ payload: "", summary: "" });
    // Another owner's live action is untouched.
    expect(await row("live-b")).toMatchObject({ payload: '{"n":1}', summary: '{"title":"secret"}' });
  });

  it("a deferral for an unregistered op is a programmer error, not a stored row", async () => {
    const v1 = new OpenAPIHono<{ Bindings: typeof env; Variables: AppVariables }>();
    v1.post("/bad", async (c) => {
      const owner = await requireOwner(c);
      if (owner instanceof Response) return owner;
      return deferForConfirmation(c, { op: "never.registered", payload: {}, summary: {} });
    });
    const headers = await seedBearer("tok-bad", A);
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errors.push(a); });
    const res = await v1.request("/bad", { method: "POST", headers }, { ...env, ...GATED });
    expect(res.status).toBe(500);
    expect(String(errors.flat().find((a) => a instanceof Error))).toMatch(/not registered/);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM pending_actions").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("the shared responses register 202 (and 503) on a route's OpenAPI entry", () => {
    const { v1 } = makeApp();
    const doc = v1.getOpenAPIDocument({ openapi: "3.0.0", info: { title: "t", version: "1" } });
    const responses = (doc.paths["/test-op"] as any).post.responses;
    expect(responses["202"].content["application/json"].schema).toBeDefined();
    expect(responses["202"].description).toMatch(/confirm/i);
    expect(responses["503"]).toBeDefined();
    // test/openapi.test.ts requires every schema inlined (no $ref / named
    // components), so a gated route spreading these must add none.
    expect(doc.components?.schemas ?? {}).toEqual({});
    expect(JSON.stringify(responses)).not.toContain("$ref");
  });
});

describe("GET /confirm/{id}", () => {
  it("renders the escaped summary with a POST form, without consuming or replaying", async () => {
    const { app, id, t } = await deferOne();
    const res = await getPage(app, id, t);
    expect(res.status).toBe(200);
    expectPageHeaders(res);
    const html = await res.text();
    expect(html).toContain("Run the test echo");
    expect(html).toContain("Send a test echo");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;quotes&quot;");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;@evil.test");
    expect(html).toContain("Tue 13 Oct, 09:00-10:00");
    expect(html).toContain("Mon 09:00");
    expect(html).toMatch(new RegExp(`<form method="post" action="/confirm/${id}"`));
    expect(html).toContain(`name="t" value="${t}"`);
    expect((await row(id))?.consumed_at).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("shows the expiry in the owner's effective timezone, naming the zone", async () => {
    const { app, id, t } = await deferOne();
    await env.DB.prepare("UPDATE users SET home_tz = 'America/Los_Angeles' WHERE subject = ?").bind(A).run();
    await env.DB.prepare("UPDATE pending_actions SET expires_at = ? WHERE id = ?").bind("2099-01-02T03:00:00.000Z", id).run();
    const html = await (await getPage(app, id, t)).text();
    expect(html).toContain("expires Thu 1 January, 7:00 PM (America/Los_Angeles)");
  });

  it("falls back to SCHEDULER_TZ for the expiry when the owner set no timezone", async () => {
    const { app, id, t } = await deferOne();
    await env.DB.prepare("UPDATE pending_actions SET expires_at = ? WHERE id = ?").bind("2099-01-02T03:00:00.000Z", id).run();
    const html = await (await getPage(app, id, t, { SCHEDULER_TZ: "Europe/London" })).text();
    expect(html).toContain("expires Fri 2 January, 3:00 AM (Europe/London)");
  });

  it("an invalid token gets the invalid-link page", async () => {
    const { app, id } = await deferOne();
    const res = await getPage(app, id, "garbage");
    expect(res.status).toBe(400);
    expectPageHeaders(res);
    expect(await res.text()).toMatch(/invalid or has expired/i);
  });

  it("a consumed action says so and offers no form", async () => {
    const { app, id, t } = await deferOne();
    expect((await postConfirm(app, id, t)).status).toBe(200);
    const res = await getPage(app, id, t);
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toMatch(/already confirmed/i);
    expect(html).not.toContain("<form");
  });

  it("an expired action says so and offers no form", async () => {
    const { app, id, t } = await deferOne();
    await env.DB.prepare("UPDATE pending_actions SET expires_at = ? WHERE id = ?").bind("2026-01-01T00:00:00.000Z", id).run();
    const res = await getPage(app, id, t);
    expect(res.status).toBe(410);
    const html = await res.text();
    expect(html).toMatch(/expired/i);
    expect(html).not.toContain("<form");
  });
});

describe("POST /confirm/{id}", () => {
  it("consumes and replays exactly once; a second POST is refused", async () => {
    const { app, id, t } = await deferOne();
    const first = await postConfirm(app, id, t);
    expect(first.status).toBe(200);
    expectPageHeaders(first);
    expect(await first.text()).toContain("Echoed 7.");
    expect(calls).toEqual([{ owner: A, payload: { n: 7 }, actionId: id }]);
    // A consumed row keeps no action data.
    expect(await row(id)).toMatchObject({ payload: "", summary: "" });

    const second = await postConfirm(app, id, t);
    expect(second.status).toBe(409);
    expect(await second.text()).toMatch(/already confirmed/i);
    expect(calls).toHaveLength(1);
  });

  it("a replay outcome's links render as real anchors on the Done page", async () => {
    state.links = [{ label: "Open it", url: "https://scheduler.example.com/x?t=1" }];
    const { app, id, t } = await deferOne();
    const html = await (await postConfirm(app, id, t)).text();
    expect(html).toContain(`<a class="btn" href="https://scheduler.example.com/x?t=1">Open it</a>`);
  });

  it("concurrent double POST replays once (the CAS decides)", async () => {
    const { app, id, t } = await deferOne();
    const results = await Promise.all([postConfirm(app, id, t), postConfirm(app, id, t), postConfirm(app, id, t)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(calls).toHaveLength(1);
  });

  it("refuses a request carrying Authorization (the agent can't click its own link): 403, nothing consumed", async () => {
    const { app, id, t } = await deferOne();
    const res = await postConfirm(app, id, t, { Authorization: `Bearer tok-${A}` });
    expect(res.status).toBe(403);
    expectPageHeaders(res);
    expect(calls).toHaveLength(0);
    expect((await row(id))?.consumed_at).toBeNull();
    // The human's browser POST still works afterwards.
    expect((await postConfirm(app, id, t)).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  for (const site of ["cross-site", "same-site", "none"]) {
    it(`refuses a POST with Sec-Fetch-Site: ${site} (only our own page's form may confirm): 403, nothing consumed`, async () => {
      const { app, id, t } = await deferOne();
      const res = await postConfirm(app, id, t, { "Sec-Fetch-Site": site });
      expect(res.status).toBe(403);
      expectPageHeaders(res);
      expect(calls).toHaveLength(0);
      expect((await row(id))?.consumed_at).toBeNull();
    });
  }

  it("accepts Sec-Fetch-Site: same-origin (the confirm page's own form)", async () => {
    const { app, id, t } = await deferOne();
    const res = await postConfirm(app, id, t, { "Sec-Fetch-Site": "same-origin" });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("GET of an expired action blanks its stored data", async () => {
    const { app, id, t } = await deferOne();
    await env.DB.prepare("UPDATE pending_actions SET expires_at = ? WHERE id = ?").bind("2026-01-01T00:00:00.000Z", id).run();
    expect((await getPage(app, id, t)).status).toBe(410);
    expect(await row(id)).toMatchObject({ payload: "", summary: "", consumed_at: null });
  });

  // Decision C: nothing runs on a delisted user's grant. With an allow-list
  // set, a subject no longer on it gets the same invalid-link page as an
  // unknown action, before the CAS: nothing consumed, nothing replayed.
  it("a delisted owner's link is refused like an unknown action (POST and GET), nothing consumed", async () => {
    const { app, id, t } = await deferOne();
    const delisted = { MEMBERSHIP_ALLOWLIST: "someone-else@org", OPERATOR_EMAIL: "" };
    const post = await postConfirm(app, id, t, {}, delisted);
    expect(post.status).toBe(400);
    expect(await post.text()).toMatch(/invalid or has expired/i);
    const get = await getPage(app, id, t, delisted);
    expect(get.status).toBe(400);
    expect(await get.text()).not.toContain("<form");
    expect(calls).toHaveLength(0);
    expect((await row(id))?.consumed_at).toBeNull();
    // Back on the list (or no allow-list at all), the same link works.
    const listed = await postConfirm(app, id, t, {}, { MEMBERSHIP_ALLOWLIST: `${A},someone-else@org`, OPERATOR_EMAIL: "" });
    expect(listed.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("an expired action is refused with no replay", async () => {
    const { app, id, t } = await deferOne();
    await env.DB.prepare("UPDATE pending_actions SET expires_at = ? WHERE id = ?").bind("2026-01-01T00:00:00.000Z", id).run();
    const res = await postConfirm(app, id, t);
    expect(res.status).toBe(410);
    expect(await res.text()).toMatch(/expired/i);
    expect(calls).toHaveLength(0);
    expect(await row(id)).toMatchObject({ consumed_at: null, payload: "", summary: "" });
  });

  it("an invalid or wrong-purpose token is refused with no replay", async () => {
    const { app, id } = await deferOne();
    expect((await postConfirm(app, id, "garbage")).status).toBe(400);
    const acceptToken = await signCapabilityWithEnv({ purpose: "accept", planHash: id, subject: A, ttlSeconds: 300, anchor: "test-anchor" }, env);
    expect((await postConfirm(app, id, acceptToken)).status).toBe(400);
    expect(calls).toHaveLength(0);
    expect((await row(id))?.consumed_at).toBeNull();
  });

  it("cross-user: A's token can't confirm B's action, even a token naming B's id for subject A", async () => {
    const a = await deferOne(A);
    const b = await deferOne(B);
    // A's real token on B's action id: action-id mismatch.
    expect((await postConfirm(a.app, b.id, a.t)).status).toBe(400);
    // A validly signed token naming B's action but subject A: owner mismatch.
    const forged = await signCapabilityWithEnv({ purpose: "confirm-action", actionId: b.id, subject: A, ttlSeconds: 300 }, env);
    expect((await postConfirm(a.app, b.id, forged)).status).toBe(400);
    expect((await getPage(a.app, b.id, forged)).status).toBe(400);
    expect(calls).toHaveLength(0);
    expect((await row(b.id))?.consumed_at).toBeNull();
    // B's own link still works.
    expect((await postConfirm(b.app, b.id, b.t)).status).toBe(200);
    expect(calls).toEqual([{ owner: B, payload: { n: 7 }, actionId: b.id }]);
  });

  it("replay re-validates live state: a stale action reports why, stays consumed, and is not retried", async () => {
    const { app, id, t } = await deferOne();
    state.blocked = true;
    const res = await postConfirm(app, id, t);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("That was already done elsewhere.");
    expect(calls).toHaveLength(1);
    expect((await row(id))?.consumed_at).not.toBeNull();
    state.blocked = false;
    expect((await postConfirm(app, id, t)).status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it("a replay that throws shows a generic failure page and logs no PII", async () => {
    const logged: unknown[][] = [];
    for (const m of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logged.push(args); });
    }
    const { app, id, t } = await deferOne();
    state.throws = true;
    const res = await postConfirm(app, id, t);
    expect(res.status).toBe(500);
    const html = await res.text();
    expect(html).toMatch(/couldn(&#39;|')t complete/i);
    expect(html).not.toContain("boom");
    expect((await row(id))?.consumed_at).not.toBeNull();
    const blob = JSON.stringify(logged.map((args) => args.map((a) => (a instanceof Error ? a.message : a))));
    expect(blob).toContain("confirm_action_replay_failed");
    expect(blob).not.toContain(A);
    expect(blob).not.toContain("boom");
    expect(blob).not.toContain("script");
    expect(blob).not.toContain(t);
  });

  it("logs the flow without PII (no owner, summary text, payload or token)", async () => {
    const logged: unknown[][] = [];
    for (const m of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logged.push(args); });
    }
    const { app, id, t } = await deferOne();
    await getPage(app, id, t);
    await postConfirm(app, id, t);
    await postConfirm(app, id, t);
    const blob = JSON.stringify(logged);
    expect(blob).toContain("confirm_action_replayed");
    expect(blob).not.toContain(A);
    expect(blob).not.toContain("script");
    expect(blob).not.toContain(t);
  });

  it("a row whose op is no longer registered is refused without consuming", async () => {
    await upsertUser(env.DB, A);
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO pending_actions (id, owner_subject, op, payload, summary, created_at, expires_at, consumed_at) VALUES (?,?,?,?,?,?,?,NULL)",
    ).bind(id, A, "gone.op", "{}", "{}", new Date().toISOString(), "2099-01-01T00:00:00.000Z").run();
    const t = await signCapabilityWithEnv({ purpose: "confirm-action", actionId: id, subject: A, ttlSeconds: 300 }, env);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = makeApp();
    expect((await getPage(app, id, t)).status).toBe(410);
    expect((await postConfirm(app, id, t)).status).toBe(410);
    expect((await row(id))?.consumed_at).toBeNull();
  });

  it("a stored payload that no longer parses is refused without consuming or replaying", async () => {
    await upsertUser(env.DB, A);
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO pending_actions (id, owner_subject, op, payload, summary, created_at, expires_at, consumed_at) VALUES (?,?,?,?,?,?,?,NULL)",
    ).bind(id, A, "test.echo", JSON.stringify({ n: "seven" }), JSON.stringify({ title: "x", recipients: [] }), new Date().toISOString(), "2099-01-01T00:00:00.000Z").run();
    const t = await signCapabilityWithEnv({ purpose: "confirm-action", actionId: id, subject: A, ttlSeconds: 300 }, env);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = makeApp();
    expect((await postConfirm(app, id, t)).status).toBe(410);
    expect(calls).toHaveLength(0);
    expect((await row(id))?.consumed_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Decision K: a looping agent can't flood the user's inbox or drain the
// shared SMTP2GO quota.
async function seedLive(owner: string, n: number, opts: { consumed?: boolean; expired?: boolean; channel?: string | null; createdAt?: string } = {}) {
  for (let i = 0; i < n; i++) {
    await env.DB.prepare(
      "INSERT INTO pending_actions (id, owner_subject, op, payload, summary, created_at, expires_at, consumed_at, mail_channel) VALUES (?,?,?,?,?,?,?,?,?)",
    ).bind(
      crypto.randomUUID(), owner, "test.echo", JSON.stringify({ n: 1000 + i }), "{}",
      opts.createdAt ?? new Date().toISOString(),
      opts.expired ? new Date(Date.now() - 3600_000).toISOString() : new Date(Date.now() + 3600_000).toISOString(),
      opts.consumed ? new Date().toISOString() : null,
      opts.channel ?? null,
    ).run();
  }
}

async function liveCount(owner: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE owner_subject = ?").bind(owner).first<{ n: number }>();
  return r?.n ?? -1;
}

describe("dedupe (decision K)", () => {
  it("the same op + payload while the first is live returns the first action's 202: one row, one email", async () => {
    const notify = new MockNotificationProvider();
    const { app } = makeApp(notify);
    const headers = await seedBearer("tok-dd", A);
    const first = await callOp(app, headers);
    const second = await callOp(app, headers);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const a = await first.json() as Record<string, unknown>;
    const b = await second.json() as Record<string, unknown>;
    expect(b.action_id).toBe(a.action_id);
    expect(b.expires_at).toBe(a.expires_at);
    expect(notify.sentPollEmails).toHaveLength(1);
    expect(await liveCount(A)).toBe(1);
  });

  it("concurrent identical calls create one row and send one email", async () => {
    const notify = new MockNotificationProvider();
    const { app } = makeApp(notify);
    const headers = await seedBearer("tok-ddc", A);
    const rs = await Promise.all([callOp(app, headers), callOp(app, headers), callOp(app, headers)]);
    const ids = new Set<unknown>();
    for (const r of rs) {
      expect(r.status).toBe(202);
      ids.add(((await r.json()) as Record<string, unknown>).action_id);
    }
    expect(ids.size).toBe(1);
    expect(notify.sentPollEmails).toHaveLength(1);
    expect(await liveCount(A)).toBe(1);
  });

  it("a different payload is a different action", async () => {
    const notify = new MockNotificationProvider();
    const { app } = makeApp(notify);
    const headers = await seedBearer("tok-ddp", A);
    expect((await callOp(app, headers, GATED, EVIL_TITLE, 1)).status).toBe(202);
    expect((await callOp(app, headers, GATED, EVIL_TITLE, 2)).status).toBe(202);
    expect(notify.sentPollEmails).toHaveLength(2);
  });

  it("a consumed or expired original no longer dedupes: a fresh row and email", async () => {
    const { app, id, t } = await deferOne();
    expect((await postConfirm(app, id, t)).status).toBe(200);
    const again = await deferOne();
    expect(again.id).not.toBe(id);
    await env.DB.prepare("UPDATE pending_actions SET expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), again.id).run();
    const third = await deferOne();
    expect(third.id).not.toBe(again.id);
  });

  it("another owner's identical action is not shared", async () => {
    const a = await deferOne(A);
    const b = await deferOne(B);
    expect(b.id).not.toBe(a.id);
  });
});

describe("live-action cap (decision K)", () => {
  it(`caps live pending actions per owner at ${20}: the next new one is 429 too_many_pending_actions, no row, no email`, async () => {
    expect(PENDING_ACTION_LIVE_CAP).toBe(20);
    await seedLive(A, PENDING_ACTION_LIVE_CAP);
    const notify = new MockNotificationProvider();
    const { app } = makeApp(notify);
    const res = await callOp(app, await seedBearer("tok-cap", A));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "too_many_pending_actions" });
    expect(notify.sentPollEmails).toHaveLength(0);
    expect(await liveCount(A)).toBe(PENDING_ACTION_LIVE_CAP);
  });

  it("consumed and expired rows, and other owners' rows, don't count", async () => {
    await seedLive(A, PENDING_ACTION_LIVE_CAP, { consumed: true });
    await seedLive(A, 5, { expired: true });
    await seedLive(B, PENDING_ACTION_LIVE_CAP);
    await seedLive(A, PENDING_ACTION_LIVE_CAP - 1);
    const { app } = makeApp();
    expect((await callOp(app, await seedBearer("tok-cap2", A))).status).toBe(202);
  });

  it("a duplicate of a live action still answers its 202 at the cap", async () => {
    const first = await deferOne();
    await seedLive(A, PENDING_ACTION_LIVE_CAP - 1);
    const { app } = makeApp();
    const res = await callOp(app, await seedBearer(`tok-${A}`, A));
    expect(res.status).toBe(202);
    expect(((await res.json()) as Record<string, unknown>).action_id).toBe(first.id);
  });

  it("documents the 429 in the shared confirmation responses", () => {
    const { v1 } = makeApp();
    const doc = v1.getOpenAPIDocument({ openapi: "3.0.0", info: { title: "t", version: "1" } });
    const r429 = (doc.paths["/test-op"] as any).post.responses["429"];
    expect(r429.description).toContain("too_many_pending_actions");
  });
});

describe("system-mailer fallback limit (decision K)", () => {
  const MAIL_ON = { ...GATED, SYSTEM_MAIL_ENABLED: "true", SYSTEM_MAIL_FROM: "Optical <o@example.test>", SYSTEM_MAIL_API_KEY: "k" };
  const failing: NotificationProvider = {
    sendReplanNotification: async () => {},
    sendPollEmail: async () => { throw new Error("gmail 500"); },
  };
  function spySmtp() {
    const sends: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url !== SMTP2GO_SEND_URL) throw new Error(`unexpected fetch ${url}`);
      sends.push(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify({ data: { succeeded: 1, failed: 0 } }), { status: 200 });
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    return sends;
  }

  it(`sends at most ${3} confirmation emails per owner per rolling 24 h through the shared system mailer; then 503, no row`, async () => {
    expect(SYSTEM_FALLBACK_DAILY_LIMIT).toBe(3);
    const sends = spySmtp();
    const { app } = makeApp(failing);
    const headers = await seedBearer("tok-fbl", A);
    for (let n = 1; n <= SYSTEM_FALLBACK_DAILY_LIMIT; n++) {
      expect((await callOp(app, headers, MAIL_ON, EVIL_TITLE, n)).status).toBe(202);
    }
    const over = await callOp(app, headers, MAIL_ON, EVIL_TITLE, 99);
    expect(over.status).toBe(503);
    expect(await over.json()).toEqual({ error: "confirmation_unavailable" });
    expect(sends).toHaveLength(SYSTEM_FALLBACK_DAILY_LIMIT);
    expect(await liveCount(A)).toBe(SYSTEM_FALLBACK_DAILY_LIMIT);
  });

  it("system-mailed rows older than 24 h, provider-mailed rows and other owners' don't count", async () => {
    const sends = spySmtp();
    await seedLive(A, SYSTEM_FALLBACK_DAILY_LIMIT, { channel: "system", consumed: true, createdAt: new Date(Date.now() - 25 * 3600_000).toISOString() });
    await seedLive(A, 5, { channel: null });
    await seedLive(B, SYSTEM_FALLBACK_DAILY_LIMIT, { channel: "system" });
    const { app } = makeApp(failing);
    expect((await callOp(app, await seedBearer("tok-fbl2", A), MAIL_ON)).status).toBe(202);
    expect(sends).toHaveLength(1);
  });

  it("consumed system-mailed rows still count (the mail was sent)", async () => {
    const sends = spySmtp();
    await seedLive(A, SYSTEM_FALLBACK_DAILY_LIMIT, { channel: "system", consumed: true });
    const { app } = makeApp(failing);
    expect((await callOp(app, await seedBearer("tok-fbl3", A), MAIL_ON)).status).toBe(503);
    expect(sends).toHaveLength(0);
  });
});

describe("confirm requires an active account (post-O14 #4)", () => {
  it("a deactivated owner's link is refused like an unknown action: nothing consumed or replayed", async () => {
    const { app, id, t } = await deferOne();
    await env.DB.prepare("UPDATE users SET is_active = 0 WHERE subject = ?").bind(A).run();
    expect((await getPage(app, id, t)).status).toBe(400);
    const res = await postConfirm(app, id, t);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/invalid or has expired/i);
    expect(calls).toHaveLength(0);
    expect((await row(id))?.consumed_at).toBeNull();
  });

  it("an owner with no users row at all is refused too", async () => {
    const { app, id, t } = await deferOne();
    await env.DB.prepare("DELETE FROM users WHERE subject = ?").bind(A).run();
    expect((await postConfirm(app, id, t)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

// Owner mail goes to the latest verified sign-in address (login_email,
// migration 0046), never the bare subject, which an IdP rename can hand to
// someone else; NULL falls back to the subject. pending_actions stays keyed
// on the subject.
describe("deferral mail recipient (ownerNotificationEmail)", () => {
  async function seedIdentity(loginEmail: string | null) {
    await env.DB.prepare("DELETE FROM identity_tokens").run();
    await env.DB.prepare(
      "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject, login_email) VALUES (?,?,?,?,?,?,?)",
    ).bind(A, new Uint8Array([1]).buffer, "s", "2026-01-01T00:00:00Z", "google", "sub-a", loginEmail).run();
  }
  afterEach(async () => { await env.DB.prepare("DELETE FROM identity_tokens").run(); });

  for (const [label, loginEmail, expected] of [
    ["login_email set", "owner-now@example.com", "owner-now@example.com"],
    ["login_email NULL", null, A],
  ] as const) {
    it(`own-mailbox confirm link goes to ${expected} (${label}); the row stays keyed on the subject`, async () => {
      await seedIdentity(loginEmail);
      const { mail, id } = await deferOne();
      expect(mail.to).toBe(expected);
      expect((await row(id))?.owner_subject).toBe(A);
    });

    it(`system-mail fallback goes to ${expected} (${label})`, async () => {
      await seedIdentity(loginEmail);
      const failing: NotificationProvider = {
        sendReplanNotification: async () => {},
        sendPollEmail: async () => { throw new Error("gmail 500"); },
      };
      const sends: Array<{ to: string[]; text_body: string }> = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_i: RequestInfo | URL, init?: RequestInit) => {
        sends.push(JSON.parse(String(init!.body)));
        return new Response(JSON.stringify({ data: { succeeded: 1, failed: 0 } }), { status: 200 });
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { app } = makeApp(failing);
      const res = await callOp(app, await seedBearer("tok-fb-login", A), {
        ...GATED, SYSTEM_MAIL_ENABLED: "true", SYSTEM_MAIL_FROM: "Optical <o@example.test>", SYSTEM_MAIL_API_KEY: "k",
      });
      expect(res.status).toBe(202);
      expect(sends.map((s) => s.to)).toEqual([[expected]]);
      expect((await row(linkFrom(sends[0]!.text_body).id))?.owner_subject).toBe(A);
    });
  }
});

// CR4: the owner's address is read before the pending action is reserved. A
// D1 error on that read must not leave a reserved row behind, or every retry
// is deduped onto a link that was never mailed (and the row counts toward the
// live cap for 24 h).
describe("deferral: a failed owner-address read reserves nothing", () => {
  function failingLoginEmailDb(db: D1Database): D1Database {
    return new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (/SELECT login_email FROM identity_tokens/.test(sql)) throw new Error("D1 unavailable");
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }

  it("leaves no pending_actions row, and a retry with a healthy DB mails exactly once", async () => {
    const notify = new MockNotificationProvider();
    const { app } = makeApp(notify);
    const headers = await seedBearer("tok-cr4", A);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = await callOp(app, headers, { ...GATED, DB: failingLoginEmailDb(env.DB) });
    expect(bad.status).toBe(500);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM pending_actions").first<{ n: number }>();
    expect(n?.n).toBe(0);
    expect(notify.sentPollEmails).toHaveLength(0);

    const ok = await callOp(app, headers);
    expect(ok.status).toBe(202);
    expect(notify.sentPollEmails).toHaveLength(1);
  });
});
