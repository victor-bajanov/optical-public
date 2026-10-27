import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  acceptLinkAnchorHolds, clearIdentityAnchor, identityAnchorTag, pollStatusLinkAnchorHolds, readRebindTarget,
} from "../../src/auth/identity-rebind";
import { storeIdentityTokens } from "../../src/auth/identity-store";
import { signCapability, signCapabilityWithEnv } from "../../src/auth/capability";
import { capabilityHmacKey, hashingKey } from "../../src/auth/crypto-keys";
import { mountAcceptRoute } from "../../src/planning/accept";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import type { AppVariables } from "../../src/index-providers";
import { mountCommitRoute } from "../../src/planning/commit";
import { runMondayResolve } from "../../src/cron/monday-resolve";
import { runWebhookReplan } from "../../src/webhooks/google-calendar";
import { hashToken } from "../../src/auth/tokens";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";

// What an admin rebind (clearIdentityAnchor) does to the capability links the
// previous holder of an address may still carry, beyond the sessions, codes and
// confirm links it already ends (test/identity-store.test.ts covers those).

const A = "rb-a@example.com";
const OTHER = "rb-other@example.com";

async function seedIdentity(subject: string, provider: string, providerSubject: string | null, loginEmail: string | null = subject) {
  await env.DB.prepare(
    "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject, login_email) VALUES (?,?,?,?,?,?,?)",
  ).bind(subject, new Uint8Array([1]).buffer, "s", "2026-01-01T00:00:00Z", provider, providerSubject, loginEmail).run();
  await env.DB.prepare("INSERT INTO users (subject, role, is_active, created_at) VALUES (?,?,?,?)")
    .bind(subject, "member", 1, "2026-01-01T00:00:00Z").run();
}

const W = { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" };
const body = JSON.stringify({ schedule: [], dropped: [], window: W });

async function seedPlan(hash: string, subject: string, committedAt: string | null) {
  await env.DB.prepare(
    "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end) VALUES (?,?,?,?,?,?,?,?)",
  ).bind(hash, body, "2026-05-18T00:00:00Z", "2099-01-01T00:00:00Z", committedAt, subject, W.start, W.end).run();
}

async function seedFeed(id: string, subject: string) {
  await env.DB.prepare(
    "INSERT INTO calendar_feed_tokens (id, owner_subject, token_hash, label, reveal_rules, created_at) VALUES (?,?,?,?,?,?)",
  ).bind(id, subject, `hash-${id}`, `label-${id}`, "[]", "2026-01-01T00:00:00Z").run();
}

const plans = async () =>
  (await env.DB.prepare("SELECT plan_hash FROM proposed_plans ORDER BY plan_hash").all<{ plan_hash: string }>())
    .results.map((r) => r.plan_hash);
const liveFeeds = async () =>
  (await env.DB.prepare("SELECT id FROM calendar_feed_tokens WHERE revoked_at IS NULL ORDER BY id").all<{ id: string }>())
    .results.map((r) => r.id);

beforeEach(async () => {
  for (const t of ["identity_tokens", "users", "proposed_plans", "calendar_feed_tokens"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  await seedIdentity(A, "google", "sub-old");
  await seedIdentity(OTHER, "google", "sub-other");
  await seedPlan("a-pending-1", A, null);
  await seedPlan("a-pending-2", A, null);
  await seedPlan("a-committed", A, "2026-05-18T01:00:00Z");
  await seedPlan("other-pending", OTHER, null);
  await seedFeed("a-feed", A);
  await seedFeed("other-feed", OTHER);
});

describe("clearIdentityAnchor: pending plans", () => {
  it("deletes the subject's uncommitted plans, keeps its committed ones and every other subject's", async () => {
    const target = await readRebindTarget(env.DB, A);
    expect(await clearIdentityAnchor(env.DB, A, target!)).toBe(true);
    expect(await plans()).toEqual(["a-committed", "other-pending"]);
  });

  it("a compare-and-set miss (a sign-in raced the rebind) deletes nothing", async () => {
    const target = await readRebindTarget(env.DB, A);
    // The raced sign-in re-anchors the row between the read and the batch.
    await env.DB.prepare("UPDATE identity_tokens SET provider_subject = 'sub-raced' WHERE account_email = ?").bind(A).run();
    expect(await clearIdentityAnchor(env.DB, A, target!)).toBe(false);
    expect(await plans()).toEqual(["a-committed", "a-pending-1", "a-pending-2", "other-pending"]);
  });
});

// Card C8 (the operator's decision): the rebind drops the stored refresh
// credential, so nothing (cron, webhook replan, booking page, poll sweep)
// refreshes with the previous holder's grant before the next sign-in.
describe("clearIdentityAnchor: the stored refresh credential", () => {
  const credBytes = async (subject: string) =>
    (await env.DB.prepare("SELECT length(refresh_token_encrypted) AS n FROM identity_tokens WHERE account_email = ?")
      .bind(subject).first<{ n: number }>())?.n;

  it("wipes the subject's credential to a zero-length blob and leaves every other subject's", async () => {
    const target = await readRebindTarget(env.DB, A);
    expect(await clearIdentityAnchor(env.DB, A, target!)).toBe(true);
    expect(await credBytes(A)).toBe(0);
    expect(await credBytes(OTHER)).toBe(1);
  });

  it("wipes it on a legacy row whose provider_subject is already NULL", async () => {
    await env.DB.prepare("UPDATE identity_tokens SET provider_subject = NULL WHERE account_email = ?").bind(A).run();
    const target = await readRebindTarget(env.DB, A);
    expect(await clearIdentityAnchor(env.DB, A, target!)).toBe(true);
    expect(await credBytes(A)).toBe(0);
  });

  it("a compare-and-set miss leaves the credential as it was", async () => {
    const target = await readRebindTarget(env.DB, A);
    await env.DB.prepare("UPDATE identity_tokens SET login_email = 'raced@example.com' WHERE account_email = ?").bind(A).run();
    expect(await clearIdentityAnchor(env.DB, A, target!)).toBe(false);
    expect(await credBytes(A)).toBe(1);
  });
});

describe("clearIdentityAnchor: calendar feeds", () => {
  it("revokes the subject's live feed tokens and no one else's", async () => {
    const target = await readRebindTarget(env.DB, A);
    expect(await clearIdentityAnchor(env.DB, A, target!)).toBe(true);
    expect(await liveFeeds()).toEqual(["other-feed"]);
  });

  it("a compare-and-set miss revokes nothing", async () => {
    const target = await readRebindTarget(env.DB, A);
    await env.DB.prepare("UPDATE identity_tokens SET login_email = 'raced@example.com' WHERE account_email = ?").bind(A).run();
    expect(await clearIdentityAnchor(env.DB, A, target!)).toBe(false);
    expect(await liveFeeds()).toEqual(["a-feed", "other-feed"]);
  });
});

// Accept links (planning/accept.ts) are stateless HMAC capabilities for ANY
// pending plan of their subject, not just the emailed one: the superseded flow
// offers the week's replacement plan under the same token. So deleting the
// pending plans at rebind is not enough on its own. The next holder's first
// resolve makes a new pending plan the previous holder's link could then show
// and commit, into the next holder's calendar. An accept link therefore carries
// the identity anchor its subject had when it was minted (identityAnchorTag),
// and holds only while the subject is still anchored to that identity.
describe("accept links after a rebind", () => {
  const tokens = { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" };

  function app() {
    const v1 = new OpenAPIHono<{ Bindings: typeof env; Variables: AppVariables }>();
    v1.use("*", async (c, next) => {
      c.set("calendarProvider", new MockCalendarProvider());
      c.set("notificationProvider", new MockNotificationProvider());
      await next();
    });
    mountAcceptRoute(v1);
    const root = new Hono<{ Bindings: typeof env; Variables: AppVariables }>();
    root.route("/v1", v1);
    return root;
  }
  const post = (hash: string, t: string) =>
    app().request(`/v1/plans/${hash}/accept`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", accept: "application/json" },
      body: new URLSearchParams({ t }),
    }, env);
  const get = (hash: string, t: string) =>
    app().request(`/v1/plans/${hash}/accept?t=${encodeURIComponent(t)}`, { method: "GET" }, env);
  const committedAt = async (hash: string) =>
    (await env.DB.prepare("SELECT committed_at FROM proposed_plans WHERE plan_hash = ?").bind(hash)
      .first<{ committed_at: string | null }>())?.committed_at;

  /** The link the previous holder was emailed for a-pending-1. */
  async function emailedLink(): Promise<string> {
    return signCapabilityWithEnv(
      { purpose: "accept", planHash: "a-pending-1", subject: A, ttlSeconds: 3600, window: W, anchor: await identityAnchorTag(env, A) },
      env,
    );
  }
  async function rebind() {
    const target = await readRebindTarget(env.DB, A);
    expect(await clearIdentityAnchor(env.DB, A, target!)).toBe(true);
  }

  it("before any rebind the link commits", async () => {
    const t = await emailedLink();
    expect((await post("a-pending-1", t)).status).toBe(200);
    expect(await committedAt("a-pending-1")).not.toBeNull();
  });

  it("after the rebind the link's page is the invalid-link page, not a 500", async () => {
    const t = await emailedLink();
    await rebind();
    const res = await get("a-pending-1", t);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("This link is invalid or has expired");
  });

  it("the link cannot commit, or show, a plan the next holder's resolve produced", async () => {
    const t = await emailedLink();
    await rebind();
    await storeIdentityTokens(env, A, tokens, "google", "sub-new", A);
    await seedPlan("a-next-holder", A, null);
    const res = await post("a-next-holder", t);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_token" });
    expect(await committedAt("a-next-holder")).toBeNull();
    const page = await get("a-next-holder", t);
    expect(page.status).toBe(400);
    expect(await page.text()).not.toContain("a-next-holder");
  });

  it("a link minted between the rebind and the next sign-in dies at that sign-in", async () => {
    await rebind();
    // A resolve already in flight at the rebind (on the previous holder's
    // token; the wiped credential starts none) mails a fresh link.
    await seedPlan("a-interim", A, null);
    const t = await signCapabilityWithEnv(
      { purpose: "accept", planHash: "a-interim", subject: A, ttlSeconds: 3600, window: W, anchor: await identityAnchorTag(env, A) },
      env,
    );
    await storeIdentityTokens(env, A, tokens, "google", "sub-new", A);
    expect((await post("a-interim", t)).status).toBe(401);
    expect(await committedAt("a-interim")).toBeNull();
  });

  // A legacy (pre-0037) row has no provider_subject to clear, so the rebind's
  // anchor clear changes nothing the tag reads; the credential wipe does.
  it("a legacy NULL-anchor row: the rebind still kills the link (credential wipe rotates the tag)", async () => {
    await env.DB.prepare("UPDATE identity_tokens SET provider_subject = NULL WHERE account_email = ?").bind(A).run();
    const t = await emailedLink();
    expect((await get("a-pending-1", t)).status).toBe(200);
    await rebind();
    await seedPlan("a-after-legacy-rebind", A, null);
    const res = await post("a-after-legacy-rebind", t);
    expect(res.status).toBe(401);
    expect(await committedAt("a-after-legacy-rebind")).toBeNull();
    const page = await get("a-after-legacy-rebind", t);
    expect(page.status).toBe(400);
    expect(await page.text()).toContain("This link is invalid or has expired");
  });

  it("the same identity signing back in keeps the link alive (no rebind happened)", async () => {
    const t = await emailedLink();
    await storeIdentityTokens(env, A, tokens, "google", "sub-old", A);
    expect((await post("a-pending-1", t)).status).toBe(200);
  });

  it("another subject's links are untouched by the rebind", async () => {
    const t = await signCapabilityWithEnv(
      { purpose: "accept", planHash: "other-pending", subject: OTHER, ttlSeconds: 3600, window: W, anchor: await identityAnchorTag(env, OTHER) },
      env,
    );
    await rebind();
    expect((await post("other-pending", t)).status).toBe(200);
  });

  it("a link minted before this change (no anchor claim) still verifies, for its 72 h life", async () => {
    const legacy = await signCapability({ purpose: "accept", planHash: "a-pending-1", subject: A, ttlSeconds: 3600 }, capabilityHmacKey(env));
    expect((await post("a-pending-1", legacy)).status).toBe(200);
  });
});

describe("identityAnchorTag", () => {
  it("names the provider and the provider subject, without carrying the subject itself", async () => {
    const g = await identityAnchorTag(env, A);
    expect(g).not.toContain("sub-old");
    await env.DB.prepare("UPDATE identity_tokens SET provider = 'microsoft' WHERE account_email = ?").bind(A).run();
    expect(await identityAnchorTag(env, A)).not.toBe(g);
    await env.DB.prepare("UPDATE identity_tokens SET provider = 'google', provider_subject = NULL WHERE account_email = ?").bind(A).run();
    const unanchored = await identityAnchorTag(env, A);
    expect(unanchored).not.toBe(g);
    expect(await identityAnchorTag(env, "no-row@example.com")).not.toBe(unanchored);
  });

  // Links minted before this change must keep verifying: a row holding a
  // credential reads exactly the material it always did.
  it("a row with a credential keeps the pre-existing tag material", async () => {
    expect(await identityAnchorTag(env, A)).toBe(
      await hashToken("identity-anchor:anchor\ngoogle\nsub-old", hashingKey(env)),
    );
  });

  it("an emptied credential gives a different tag, with or without a provider_subject", async () => {
    const live = await identityAnchorTag(env, A);
    await env.DB.prepare("UPDATE identity_tokens SET refresh_token_encrypted = X'' WHERE account_email = ?").bind(A).run();
    const wiped = await identityAnchorTag(env, A);
    expect(wiped).not.toBe(live);
    await env.DB.prepare("UPDATE identity_tokens SET provider_subject = NULL, refresh_token_encrypted = ? WHERE account_email = ?")
      .bind(new Uint8Array([1]).buffer, A).run();
    const legacyLive = await identityAnchorTag(env, A);
    await env.DB.prepare("UPDATE identity_tokens SET refresh_token_encrypted = X'' WHERE account_email = ?").bind(A).run();
    expect(await identityAnchorTag(env, A)).not.toBe(legacyLive);
  });

  it("is stable across reads of the same anchor", async () => {
    expect(await identityAnchorTag(env, A)).toBe(await identityAnchorTag(env, A));
  });

  // Keyed with hashingKey(env), never TOKEN_HASH_PEPPER directly: dev splits
  // the keys (HASHING_KEY != TOKEN_HASH_PEPPER), and an unkeyed hash of a
  // guessable provider_subject could be confirmed offline from a leaked link.
  const keyed = (hashing: string, pepper = env.TOKEN_HASH_PEPPER) =>
    ({ ...env, HASHING_KEY: hashing, TOKEN_HASH_PEPPER: pepper }) as typeof env;

  it("is keyed: two HASHING_KEYs give two tags for the same identity", async () => {
    expect(await identityAnchorTag(keyed("hk-one"), A)).not.toBe(await identityAnchorTag(keyed("hk-two"), A));
  });

  it("follows HASHING_KEY, not TOKEN_HASH_PEPPER, when the keys are split", async () => {
    const t = await identityAnchorTag(keyed("hk-split", "pepper-one"), A);
    expect(await identityAnchorTag(keyed("hk-split", "pepper-two"), A)).toBe(t);
    expect(t).not.toContain("sub-old");
  });

  it("under split keys a link holds where it was minted and nowhere keyed differently", async () => {
    const split = keyed("hk-split", "pepper-split");
    const claims = { subject: A, anchor: await identityAnchorTag(split, A) };
    expect(await acceptLinkAnchorHolds(split, claims)).toBe(true);
    expect(await pollStatusLinkAnchorHolds(split, claims)).toBe(true);
    expect(await acceptLinkAnchorHolds(keyed("hk-other", "pepper-split"), claims)).toBe(false);
    expect(await pollStatusLinkAnchorHolds(keyed("hk-other", "pepper-split"), claims)).toBe(false);
  });
});

// Every signer of an emailed accept link stamps the subject's current anchor.
// (signCapabilityWithEnv's type requires the claim; these pin its value.)
describe("accept links carry the subject's anchor at every signer", () => {
  const SUBJ = "primary";
  const anchorOf = (url: string): string | undefined => {
    const t = decodeURIComponent(/[?&]t=([^&\s]+)/.exec(url)![1]!);
    const b64 = t.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/");
    return (JSON.parse(atob(b64)) as { anchor?: string }).anchor;
  };
  const solver = {
    fetch: async () => new Response(JSON.stringify({
      schedule: [{ task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00", duration_minutes: 90, context: "deep" }],
      dropped: [],
      objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } },
      diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  } as unknown as Fetcher;
  const runEnv = () => ({ ...env, SOLVER: solver, OAUTH_ISSUER: "https://scheduler.example.com", DONE_COLOR_ID: "11" }) as typeof env;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T15:00:00.000Z"));
    for (const t of ["tasks", "task_templates", "config_weights", "config_contexts", "calendar_sync", "pending_actions", "oauth_tokens"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
    await seedIdentity(SUBJ, "microsoft", "tid:oid-p");
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify({ time_of_day_fit_per_15min: 5, churn_per_15min_moved: 10, priority_unit: 1, base_drop_penalty: 200 })).run();
    await seedMissingDefaultContexts();
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,'pending',?,?)")
      .bind("t1", SUBJ, JSON.stringify({ id: "t1", title: "Deep work", context: "deep", priority: 80, duration_minutes: 90 }),
        "2026-05-17T00:00:00Z", "2026-05-17T00:00:00Z").run();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("the Monday cron", async () => {
    const notify = new MockNotificationProvider();
    const r = await runMondayResolve({
      env: runEnv(), calendar: new MockCalendarProvider(), notification: notify, accountEmail: SUBJ,
      now: new Date("2026-05-17T15:00:00Z"),
    });
    expect(r.kind).toBe("ok");
    expect(anchorOf(notify.sent[0]!.opts.acceptUrl)).toBe(await identityAnchorTag(env, SUBJ));
  });

  it("the webhook replan", async () => {
    await env.DB.prepare(
      "INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES (?, 'primary', 'tok-old', 'ch-1', 'shared-secret', '2099-01-01T00:00:00Z', 'res-1', 'https://x/v1/webhook/google-calendar')",
    ).bind(SUBJ).run();
    const event = { id: "ext-1", summary: "Standup", start: "2026-05-19T11:00:00Z", end: "2026-05-19T12:00:00Z", extendedProperties: {} };
    const cal = new MockCalendarProvider({ events: [event] });
    cal.fetchIncrementalChanges = async () => ({ changes: [{ kind: "upsert", event }], nextSyncToken: "tok-new", syncTokenInvalidated: false });
    const notify = new MockNotificationProvider();
    const r = await runWebhookReplan({
      env: runEnv(), calendar: cal, notify, accountEmail: SUBJ, oauthIssuer: "https://scheduler.example.com", dryRun: false,
    });
    expect(r.kind).toBe("replanned");
    expect(anchorOf(notify.sent[0]!.opts.acceptUrl)).toBe(await identityAnchorTag(env, SUBJ));
  });

  it("an agent-confirm client's deferred commit", async () => {
    vi.useRealTimers();
    await seedPlan("h-defer", SUBJ, null);
    await env.DB.prepare("UPDATE proposed_plans SET render_snapshot = ? WHERE plan_hash = 'h-defer'").bind(JSON.stringify({
      tz: "Australia/Sydney", window: W, trigger: "monday-cron", isEmpty: false,
      days: [{ date: "2026-05-19", before: [], after: [{ title: "Deep work", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:30:00.000Z", role: "added", origin: "task" }] }],
      dropped: [], warnings: [],
    })).run();
    await env.DB.prepare(
      "INSERT INTO oauth_tokens (hashed_token,client_id,scopes,expires_at,refresh_of,revoked_at,subject) VALUES (?,?,?,?,?,?,?)",
    ).bind(await hashToken("agent-tok", hashingKey(env)), "agent-client", "scheduler:read scheduler:write", "2099-01-01T00:00:00Z", null, null, SUBJ).run();
    const notify = new MockNotificationProvider();
    const v1 = new OpenAPIHono<{ Bindings: typeof env; Variables: AppVariables }>();
    v1.use("*", async (c, next) => {
      c.set("calendarProvider", new MockCalendarProvider());
      c.set("notificationProvider", notify);
      await next();
    });
    mountCommitRoute(v1);
    const root = new Hono<{ Bindings: typeof env; Variables: AppVariables }>();
    root.route("/v1", v1);
    const res = await root.request("/v1/commit", {
      method: "POST", headers: { Authorization: "Bearer agent-tok", "content-type": "application/json" },
      body: JSON.stringify({ plan_hash: "h-defer" }),
    }, { ...env, AGENT_CONFIRM_CLIENT_IDS: "agent-client", OAUTH_ISSUER: "https://scheduler.example.com" });
    expect(res.status).toBe(202);
    expect(anchorOf(notify.sent[0]!.opts.acceptUrl)).toBe(await identityAnchorTag(env, SUBJ));
  });
});
