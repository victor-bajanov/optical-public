import { env, applyD1Migrations } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import guestRateLimitSql from "../../migrations/0033_poll_guest_rate_limit.sql?raw";
import { mountMeetingPollRoutes, __setPollBookingEngineForTests } from "../../src/handlers/polls";
import { mountPollRoutes } from "../../src/polls/route";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import { hashToken } from "../../src/auth/tokens";
import { signCapability } from "../../src/auth/capability";
import { capabilityHmacKey } from "../../src/auth/crypto-keys";
import { clearIdentityAnchor, identityAnchorTag, readRebindTarget } from "../../src/auth/identity-rebind";
import { dropCachedAccessToken, storeIdentityTokens } from "../../src/auth/identity-store";
import { __setIdentityProviderForTests } from "../../src/auth/identity-provider";
import { saveBookingPage } from "../../src/db/booking-page";
import type { AppVariables } from "../../src/index-providers";
import type { Env } from "../../src/env";

// The organiser's poll-status link (createMeetingPoll's statusUrl) is a
// stateless capability that renders the poll's roster and responses and ranks
// candidates against the subject's CURRENT calendar credential. Like an accept
// link it carries the subject's identity anchor at mint time
// (identityAnchorTag), so it dies when the address passes to another identity
// (admin rebind, provider switch).

const OWNER = "status-anchor-owner@org";
const ON: Env = { ...(env as unknown as Env), MEETING_POLL_ENABLED: "true", OAUTH_ISSUER: "https://scheduler.example.com" };
const AUTH = { Authorization: "Bearer status-anchor" };
const tokens = { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" };

const BODY = {
  title: "Roadmap sync",
  invitees: [{ email: "alice@example.com", name: "Alice" }],
  durationMin: 30,
  rangeStart: "2027-01-04",
  rangeEnd: "2027-01-15",
  deadlineUtc: "2027-01-14T00:00:00Z",
  location: { kind: "meet" },
  guestLink: false,
};

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

function makeApp(): App {
  const v1 = new OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>();
  mountMeetingPollRoutes(v1);
  const app: App = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("notificationProvider", new MockNotificationProvider());
    c.set("calendarProvider", new MockCalendarProvider({ events: [] }));
    await next();
  });
  app.route("/v1", v1);
  mountPollRoutes(app);
  return app;
}

async function createPoll(app: App): Promise<{ id: string; statusUrl: string }> {
  const res = await app.request("/v1/polls", {
    method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify(BODY),
  }, ON);
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; statusUrl: string };
}

const statusPath = (statusUrl: string) => {
  const u = new URL(statusUrl);
  return `${u.pathname}${u.search}`;
};

async function rebind() {
  const target = await readRebindTarget(env.DB, OWNER);
  expect(await clearIdentityAnchor(env.DB, OWNER, target!)).toBe(true);
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, [{ name: "0033_poll_guest_rate_limit.sql", queries: [guestRateLimitSql] }]);
});

beforeEach(async () => {
  for (const t of ["poll_responses", "poll_invitees", "polls", "oauth_tokens", "identity_tokens", "users"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  await env.DB.prepare("DELETE FROM config_booking_page WHERE owner_subject != '__default__'").run();
  __setPollBookingEngineForTests(null);
  await saveBookingPage(env.DB, OWNER, {
    enabled: true,
    hours: { days: ["mon", "tue", "wed", "thu", "fri"], start: "00:00", end: "23:45" },
    horizon_days: 21,
    min_notice_minutes: 0,
    buffer_minutes: { before: 0, after: 0 },
  });
  await env.DB.prepare(
    "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject, login_email) VALUES (?,?,?,?,?,?,?)",
  ).bind(OWNER, new Uint8Array([1]).buffer, "s", "2026-01-01T00:00:00Z", "google", "sub-owner", OWNER).run();
  await env.DB.prepare("INSERT INTO users (subject, role, is_active, created_at) VALUES (?,?,?,?)")
    .bind(OWNER, "member", 1, "2026-01-01T00:00:00Z").run();
  await env.DB.prepare(
    "INSERT INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?, 'test-client', 'scheduler.write', NULL, NULL, NULL, ?)",
  ).bind(await hashToken("status-anchor", env.TOKEN_HASH_PEPPER), OWNER).run();
});

describe("poll-status links and the identity anchor", () => {
  it("createMeetingPoll's statusUrl carries the organiser's current anchor and opens", async () => {
    const app = makeApp();
    const { statusUrl } = await createPoll(app);
    const t = new URL(statusUrl).searchParams.get("t")!;
    const claims = JSON.parse(atob(t.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"))) as { anchor?: string };
    expect(claims.anchor).toBe(await identityAnchorTag(env, OWNER));
    expect((await app.request(statusPath(statusUrl), {}, ON)).status).toBe(200);
  });

  it("after a rebind the link is the same 404 as an unknown poll (no 500)", async () => {
    const app = makeApp();
    const { statusUrl } = await createPoll(app);
    await rebind();
    expect((await app.request(statusPath(statusUrl), {}, ON)).status).toBe(404);
  });

  it("after the next holder signs in the link stays dead", async () => {
    const app = makeApp();
    const { statusUrl } = await createPoll(app);
    await rebind();
    await storeIdentityTokens(ON, OWNER, tokens, "google", "sub-next-holder", OWNER);
    const res = await app.request(statusPath(statusUrl), {}, ON);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Roadmap sync");
  });

  it("a legacy NULL-anchor organiser: the rebind still kills the link (credential wipe rotates the tag)", async () => {
    await env.DB.prepare("UPDATE identity_tokens SET provider_subject = NULL WHERE account_email = ?").bind(OWNER).run();
    const app = makeApp();
    const { statusUrl } = await createPoll(app);
    expect((await app.request(statusPath(statusUrl), {}, ON)).status).toBe(200);
    await rebind();
    const res = await app.request(statusPath(statusUrl), {}, ON);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Roadmap sync");
  });

  it("the same identity signing back in keeps the link alive", async () => {
    const app = makeApp();
    const { statusUrl } = await createPoll(app);
    await storeIdentityTokens(ON, OWNER, tokens, "google", "sub-owner", OWNER);
    expect((await app.request(statusPath(statusUrl), {}, ON)).status).toBe(200);
  });

  // No legacy transition: a status link lives until the poll deadline + 7 d,
  // and a deadline has no upper bound (rangeStart may be any future date), so
  // a claim-less link could outlive any rebind indefinitely. It is refused;
  // the organiser opens the page with a bearer (same route, no ?t=).
  it("a status link minted before the anchor claim existed is refused; the bearer path still opens the page", async () => {
    const app = makeApp();
    const { id } = await createPoll(app);
    const legacy = await signCapability({ purpose: "poll-status", pollId: id, subject: OWNER, ttlSeconds: 3600 }, capabilityHmacKey(ON));
    expect((await app.request(`/poll/${id}/status?t=${encodeURIComponent(legacy)}`, {}, ON)).status).toBe(404);
    expect((await app.request(`/poll/${id}/status`, { headers: AUTH }, ON)).status).toBe(200);
  });
});

// Card C8, tightened: a legacy (NULL provider_subject) row's rebind has no
// anchor to clear, but it wipes the credential, and the wipe rotates the
// anchor tag. So a status link minted before the rebind is refused at once,
// with no IdP call, and stays refused after the next sign-in.
describe("a legacy row's poll-status link across a rebind (credential wiped)", () => {
  function realCalendarApp(): App {
    const v1 = new OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>();
    mountMeetingPollRoutes(v1);
    const app: App = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("notificationProvider", new MockNotificationProvider());
      await next();
    });
    app.route("/v1", v1);
    mountPollRoutes(app);
    return app;
  }

  it("404s straight after the rebind, with no IdP call, and after the next sign-in", async () => {
    await env.DB.prepare("UPDATE identity_tokens SET provider_subject = NULL WHERE account_email = ?").bind(OWNER).run();
    const { statusUrl } = await createPoll(makeApp());
    await rebind();
    await dropCachedAccessToken(ON, OWNER);
    const idpCalls: string[] = [];
    __setIdentityProviderForTests({
      scopes: [],
      authorizeUrl: () => { throw new Error("unused"); },
      exchangeCode: () => { throw new Error("unused"); },
      fetchIdentity: () => { throw new Error("unused"); },
      refreshAccessToken: async () => { idpCalls.push("refresh"); throw new Error("must not refresh"); },
      revokeGrant: async () => { idpCalls.push("revoke"); },
    });
    try {
      const app = realCalendarApp();
      const res = await app.request(statusPath(statusUrl), {}, ON);
      expect(res.status).toBe(404);
      expect(idpCalls).toEqual([]);
      await storeIdentityTokens(ON, OWNER, tokens, "google", "sub-next-holder", OWNER);
      expect((await app.request(statusPath(statusUrl), {}, ON)).status).toBe(404);
    } finally {
      __setIdentityProviderForTests(null);
    }
  });
});
