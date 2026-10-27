import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "../../src/env";
import type { AppVariables } from "../../src/index-providers";
import { upsertUser, getUser } from "../../src/db/users";
import { hashToken } from "../../src/auth/tokens";
import { hashingKey } from "../../src/auth/crypto-keys";
import { dropCachedAccessToken, hasRefreshCredential, storeIdentityTokens } from "../../src/auth/identity-store";
import { __setIdentityProviderForTests, type IdentityProvider } from "../../src/auth/identity-provider";
import { clearIdentityAnchor, identityAnchorTag, readRebindTarget } from "../../src/auth/identity-rebind";
import { signCapabilityWithEnv } from "../../src/auth/capability";
import { dispatchScheduled, __setHandlersForTests, MONDAY_CRON } from "../../src/cron/scheduled-entry";
import * as mondayResolve from "../../src/cron/monday-resolve";
import { __setReplanRunnerForTests, __setWebhookReplanForTests } from "../../src/durable-objects/resolve-coordinator";
import { runPollSweep } from "../../src/cron/poll-sweep";
import { bookAtDeadline } from "../../src/polls/booking";
import { createPoll, insertInvitee, newInviteeId, getPoll } from "../../src/db/polls";
import { mountBookingRoutes } from "../../src/booking/route";
import { saveBookingPage } from "../../src/db/booking-page";
import { mountResolveRoute } from "../../src/planning/resolve";
import { mountReplanNowRoute } from "../../src/handlers/replan-now";
import { mountAcceptRoute } from "../../src/planning/accept";
import { offboardUser } from "../../src/lifecycle/offboard";
import { sweepInactiveUsers } from "../../src/lifecycle/sweep-inactive";
import { runRenewSubscriptions } from "../../src/cron/renew-subscriptions";
import { listGrantHoldersWithoutChannel, casCalendarSyncChannel } from "../../src/db/calendar-sync";
import type { BusinessHours } from "../../src/planning/solver-contract";

// Card C8: an admin rebind wipes the stored refresh credential, so the account
// is idle until the next sign-in. Every caller that reaches the account's
// calendar or mailbox without a user present must then skip it with one log
// line naming the condition (never the subject's email), and the API routes a
// user can call answer a clean 409, never a 500.

const W = "wiped-holder@org";
const TOKEN = "wiped-bearer";

async function seedWiped(subject = W, opts: { provider?: string; providerSubject?: string | null } = {}) {
  await upsertUser(env.DB, subject);
  await env.DB.prepare(
    `INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject, login_email)
     VALUES (?, X'', 's', '2026-01-01T00:00:00Z', ?, ?, ?)`,
  ).bind(subject, opts.provider ?? "google", opts.providerSubject ?? null, subject).run();
  await dropCachedAccessToken(env, subject);
}

async function seedBearer(subject = W) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO oauth_clients (id, name, type, redirect_uris, created_at) VALUES ('wiped-client','t','pkce',NULL,'2026-01-01')",
  ).run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject)
     VALUES (?, 'wiped-client', 'scheduler:read scheduler:write', '2099-01-01T00:00:00Z', NULL, NULL, ?)`,
  ).bind(await hashToken(TOKEN, hashingKey(env)), subject).run();
}

/** An IdP that fails the test if anything tries to refresh or revoke with it. */
function untouchableIdp(calls: string[]): IdentityProvider {
  return {
    scopes: [],
    authorizeUrl: () => { throw new Error("unused"); },
    exchangeCode: () => { throw new Error("unused"); },
    fetchIdentity: () => { throw new Error("unused"); },
    refreshAccessToken: async (r) => { calls.push(`refresh:${r}`); throw new Error("refresh must not run"); },
    revokeGrant: async (t) => { calls.push(`revoke:${t}`); },
  };
}

type Spies = ReturnType<typeof vi.spyOn>[];
function spyLogs(): Spies {
  return (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
}
const lines = (spies: Spies) =>
  spies.flatMap((s) => s.mock.calls.map((args: unknown[]) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
/** The log lines naming the condition, and a check that none of the run's lines names the email. */
function credentialLines(spies: Spies, email = W): string[] {
  const all = lines(spies);
  for (const l of all.filter((x) => x.includes("identity_credential_missing"))) expect(l).not.toContain(email);
  return all.filter((l) => l.includes("identity_credential_missing"));
}

let idpCalls: string[];

beforeEach(async () => {
  for (const t of [
    "identity_tokens", "users", "oauth_tokens", "oauth_clients", "audit_log", "calendar_sync", "tasks",
    "proposed_plans", "poll_responses", "poll_invitees", "polls", "bookings",
  ]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  idpCalls = [];
  __setIdentityProviderForTests(untouchableIdp(idpCalls));
});

afterEach(() => {
  vi.restoreAllMocks();
  __setIdentityProviderForTests(null);
  __setHandlersForTests(null);
  __setReplanRunnerForTests(null);
  __setWebhookReplanForTests(null);
});

describe("hasRefreshCredential", () => {
  it("false with no row and for a wiped credential, true for a stored one", async () => {
    expect(await hasRefreshCredential(env, "nobody@org")).toBe(false);
    await seedWiped();
    expect(await hasRefreshCredential(env, W)).toBe(false);
    await storeIdentityTokens(env, "live@org", { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" }, "google", "sub-live");
    expect(await hasRefreshCredential(env, "live@org")).toBe(true);
  });
});

describe("Monday cron", () => {
  it("skips the subject with one line naming the condition, writes no audit row, and the next subject still runs", async () => {
    await seedWiped();
    await storeIdentityTokens(env, "zz-other@org", { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" }, "google", "sub-o");
    const reached: string[] = [];
    vi.spyOn(mondayResolve, "runMondayResolve").mockImplementation(async (args) => {
      reached.push(args.accountEmail);
      // Only the wiped subject touches its calendar (the other one would reach Google).
      if (args.accountEmail === W) await args.calendar.fetchEventsInWindow("2030-01-07T00:00:00Z", "2030-01-14T00:00:00Z");
      return { kind: "ok", planHash: "h" } as Awaited<ReturnType<typeof mondayResolve.runMondayResolve>>;
    });
    const spies = spyLogs();
    const tasks: Promise<unknown>[] = [];
    await dispatchScheduled(
      { cron: MONDAY_CRON, scheduledTime: Date.now() } as unknown as ScheduledEvent,
      { ...env, WEEKLY_CRON_ENABLED: "true" } as Env,
      { waitUntil: (p: Promise<unknown>) => { tasks.push(p); }, passThroughOnException: () => {} } as unknown as ExecutionContext,
    );
    await Promise.all(tasks);
    expect(reached).toContain(W);
    expect(reached).toContain("zz-other@org");
    expect(credentialLines(spies).filter((l) => l.includes("credential_missing_skip"))).toEqual([
      expect.stringContaining('"path":"monday_resolve"'),
    ]);
    expect(lines(spies).some((l) => l.includes("monday-resolve failed") && l.includes(W))).toBe(false);
    const audits = async (subject: string) => (await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE subject = ? AND action = 'monday_resolve'",
    ).bind(subject).first<{ n: number }>())!.n;
    expect(await audits(W)).toBe(0);
    expect(await audits("zz-other@org")).toBe(1);
    expect(idpCalls).toEqual([]);
  });
});

describe("webhook replan (ResolveCoordinator alarm)", () => {
  it("an alarm armed before the rebind skips with one line, not resolve_coordinator_alarm_failed", async () => {
    await seedWiped();
    __setWebhookReplanForTests(async (args) => {
      await args.calendar.fetchIncrementalChanges("tok");
      return { kind: "no_diff" };
    });
    const stub = env.RESOLVE_COORDINATOR.get(env.RESOLVE_COORDINATOR.idFromName(W));
    await runInDurableObject(stub, (inst) => inst.notifyChange(W));
    const spies = spyLogs();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(credentialLines(spies).filter((l) => l.includes("credential_missing_skip"))).toEqual([
      expect.stringContaining('"path":"webhook_replan"'),
    ]);
    expect(lines(spies).some((l) => l.includes("resolve_coordinator_alarm_failed"))).toBe(false);
    await runInDurableObject(stub, async (_inst, state) => {
      await state.storage.deleteAlarm();
      await state.storage.deleteAll();
    });
  });
});

describe("poll sweep", () => {
  const NOW = new Date("2026-08-21T00:00:00Z");
  async function seedPoll(deadlineUtc: string) {
    const poll = await createPoll(env.DB, {
      subject: W, title: "Kickoff", durationMin: 30, rangeStart: "2026-08-01", rangeEnd: "2026-08-31",
      deadlineUtc, location: { kind: "gmeet" }, guestTokenHash: null, now: "2026-08-01T00:00:00Z",
    });
    await insertInvitee(env.DB, {
      id: newInviteeId(), pollId: poll.id, email: "invitee@example.com", name: "Invitee", kind: "invited",
      tokenHash: `hash-${poll.id}`, pseudonym: "anon", now: "2026-08-01T00:00:00Z",
    });
    return poll;
  }
  const tokenHash = async (pollId: string) =>
    (await env.DB.prepare("SELECT token_hash FROM poll_invitees WHERE poll_id = ?").bind(pollId).first<{ token_hash: string }>())!.token_hash;

  it("skips an idle organiser's polls with one line: no deadline booking or escalation, no nudge, no invitee link rotated", async () => {
    await seedWiped();
    const due = await seedPoll("2026-08-20T00:00:00Z"); // past its deadline
    const nudge = await seedPoll("2026-08-21T12:00:00Z"); // inside the final-nudge window
    const spies = spyLogs();
    await runPollSweep(env as Env, NOW, { bookAtDeadline });
    expect(credentialLines(spies).filter((l) => l.includes("credential_missing_skip"))).toEqual([
      expect.stringContaining('"path":"poll_sweep"'),
    ]);
    expect((await getPoll(env.DB, due.id))!.status).toBe("open");
    expect((await getPoll(env.DB, nudge.id))!.nudgedFinalAt).toBeNull();
    expect(await tokenHash(nudge.id)).toBe(`hash-${nudge.id}`);
    expect(lines(spies).some((l) => l.includes("poll-sweep: poll failed"))).toBe(false);
  });

  it("a rebind racing the sweep (credential wiped mid-poll) logs one line per poll without the subject", async () => {
    await storeIdentityTokens(env, W, { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" }, "google", "sub-w");
    await upsertUser(env.DB, W);
    await seedPoll("2026-08-20T00:00:00Z");
    const spies = spyLogs();
    await runPollSweep(env as Env, NOW, {
      bookAtDeadline: async () => {
        const target = await readRebindTarget(env.DB, W);
        await clearIdentityAnchor(env.DB, W, target!);
        await dropCachedAccessToken(env, W);
        await bookAtDeadline(env as Env, (await env.DB.prepare("SELECT id FROM polls").first<{ id: string }>())!.id);
      },
    });
    const hits = credentialLines(spies);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("credential_missing_skip");
    expect(lines(spies).some((l) => l.includes(W))).toBe(false);
  });
});

describe("booking page slots", () => {
  it("answers 502 calendar_unavailable with one line naming the condition", async () => {
    await seedWiped();
    await saveBookingPage(env.DB, W, {
      slug: "wiped-page", enabled: true,
      hours: { days: ["mon", "tue", "wed", "thu", "fri"], start: "10:00", end: "16:00" } as BusinessHours,
      horizon_days: 14, min_notice_minutes: 0, buffer_minutes: { before: 0, after: 0 },
    });
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    mountBookingRoutes(app);
    const spies = spyLogs();
    const res = await app.request("/book/wiped-page/slots?duration=30", {}, { ...env, BOOKING_PAGE_ENABLED: "true", TURNSTILE_SECRET: "s" } as Env);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "calendar_unavailable" });
    expect(credentialLines(spies)).toHaveLength(1);
  });
});

describe("resolve and replan-now", () => {
  function v1App() {
    const v1 = new OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>();
    mountResolveRoute(v1 as never);
    mountReplanNowRoute(v1);
    return v1;
  }
  const auth = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

  it("POST /resolve answers 409 identity_credential_missing, not 500", async () => {
    await seedWiped();
    await seedBearer();
    const spies = spyLogs();
    const res = await v1App().request("/resolve", {
      method: "POST", headers: auth,
      body: JSON.stringify({ window_start: "2030-01-07T00:00:00Z", window_end: "2030-01-14T00:00:00Z" }),
    }, env);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "identity_credential_missing" });
    expect(credentialLines(spies).filter((l) => l.includes("credential_missing_skip"))).toEqual([
      expect.stringContaining('"path":"resolve"'),
    ]);
    expect(lines(spies).some((l) => l.includes("resolve_failed"))).toBe(false);
  });

  it("POST /replan-now answers 409 identity_credential_missing, not 500", async () => {
    await seedWiped();
    await seedBearer();
    const spies = spyLogs();
    const res = await v1App().request("/replan-now?dry_run=true", { method: "POST", headers: auth }, env);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "identity_credential_missing" });
    expect(credentialLines(spies).filter((l) => l.includes("credential_missing_skip"))).toEqual([
      expect.stringContaining('"path":"replan_now"'),
    ]);
  });
});

describe("offboard and the retention sweep", () => {
  it("offboard completes: calendar cleanup skipped with one line, no upstream revoke, rows deleted, user deactivated", async () => {
    await seedWiped();
    const spies = spyLogs();
    await offboardUser({ ...env, UPSTREAM_REVOKE_ENABLED: "true" } as Env, W, "admin@org");
    expect(credentialLines(spies).filter((l) => l.includes("credential_missing_skip"))).toEqual([
      expect.stringContaining('"path":"offboard"'),
    ]);
    expect(idpCalls).toEqual([]);
    expect(await env.DB.prepare("SELECT 1 FROM identity_tokens WHERE account_email = ?").bind(W).first()).toBeNull();
    expect((await getUser(env.DB, W))?.is_active).toBe(0);
  });

  it("the retention sweep offboards an idle wiped account like any other", async () => {
    await seedWiped();
    await env.DB.prepare("UPDATE users SET last_seen = '2026-04-01T00:00:00Z', retention_warned_at = '2026-05-18T04:00:00.000Z' WHERE subject = ?").bind(W).run();
    spyLogs();
    const swept = await sweepInactiveUsers({ ...env, RETENTION_DAYS: "30" } as Env, new Date("2026-06-01T00:00:00Z"));
    expect(swept).toEqual([W]);
    expect((await getUser(env.DB, W))?.is_active).toBe(0);
  });
});

describe("subscription renewal", () => {
  it("a wiped credential holds no grant: the create pass never lists it, and a channel write for it is refused", async () => {
    await seedWiped();
    expect((await listGrantHoldersWithoutChannel(env.DB)).map((r) => r.owner_subject)).not.toContain(W);
    const spies = spyLogs();
    const summary = await runRenewSubscriptions(env as Env, new Date());
    expect(summary.create_failed).toBe(0);
    expect(credentialLines(spies)).toEqual([]);
    expect(await casCalendarSyncChannel(env.DB, W, "primary", null, {
      channel_id: "c", channel_token: "t", channel_expires_at: "2099-01-01T00:00:00Z",
      channel_resource_id: "r", channel_callback_url: "https://x/hook",
    })).toBe(false);
  });
});

// A legacy (NULL provider_subject) row's rebind has no anchor to clear, but
// its credential wipe rotates the anchor tag, so the previous holder's accept
// links are refused at once (never a 500, no IdP call) and stay refused
// after the next sign-in.
describe("a legacy row's accept link across a rebind", () => {
  const WIN = { start: "2030-01-07T00:00:00Z", end: "2030-01-14T00:00:00Z" };
  function app() {
    const v1 = new OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>();
    mountAcceptRoute(v1);
    const root = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    root.route("/v1", v1);
    return root;
  }
  const post = (hash: string, t: string) => app().request(`/v1/plans/${hash}/accept`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", accept: "application/json" },
    body: new URLSearchParams({ t }),
  }, env);
  const get = (hash: string, t: string) => app().request(`/v1/plans/${hash}/accept?t=${encodeURIComponent(t)}`, {}, env);

  it("is refused straight after the rebind, with no IdP call, and after the next sign-in", async () => {
    const tokens = { refreshToken: "r", accessToken: "a", expiresIn: 3600, scope: "s" };
    await storeIdentityTokens(env, W, tokens, "google", undefined, W); // legacy: no provider_subject
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end) VALUES (?,?,?,?,?,?,?,?)",
    ).bind("legacy-pending", JSON.stringify({ schedule: [], dropped: [], window: WIN }), "2030-01-01T00:00:00Z", "2099-01-01T00:00:00Z", null, W, WIN.start, WIN.end).run();
    const link = await signCapabilityWithEnv(
      { purpose: "accept", planHash: "legacy-pending", subject: W, ttlSeconds: 3600, window: WIN, anchor: await identityAnchorTag(env, W) },
      env,
    );
    const target = await readRebindTarget(env.DB, W);
    expect(await clearIdentityAnchor(env.DB, W, target!)).toBe(true);
    await dropCachedAccessToken(env, W);

    const page = await get("legacy-pending", link);
    expect(page.status).toBe(400);
    expect(await page.text()).not.toContain('action="/v1/plans/legacy-pending/accept"');
    const accepted = await post("legacy-pending", link);
    expect(accepted.status).toBe(401);
    expect(idpCalls).toEqual([]);

    await storeIdentityTokens(env, W, tokens, "google", "sub-next", W);
    expect((await post("legacy-pending", link)).status).toBe(401);
    expect((await get("legacy-pending", link)).status).toBe(400);
  });
});
