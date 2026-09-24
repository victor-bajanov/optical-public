import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { OpenAPIHono } from "@hono/zod-openapi";
import { mountAcceptRoute } from "../../src/planning/accept";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { MockNotificationProvider } from "../../src/providers/mock-notification-provider";
import type { AppVariables } from "../../src/index-providers";
import { signCapability } from "../../src/auth/capability";
import { attachRenderSnapshot } from "../../src/planning/proposed-plans";
import { hashToken } from "../../src/auth/tokens";

async function seedBearer(token: string, subject: string) {
  const hashed = await hashToken(token, env.TOKEN_HASH_PEPPER);
  await env.DB
    .prepare(
      "INSERT OR REPLACE INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?, 'test-client', 'scheduler.write', NULL, NULL, NULL, ?)",
    )
    .bind(hashed, subject)
    .run();
}

const planBody = {
  schedule: [
    {
      task_id: "t1",
      chunk_id: "t1#0",
      start: "2026-05-19T09:00:00Z",
      end: "2026-05-19T10:30:00Z",
      context: "deep",
    },
  ],
  dropped: [],
  window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
};

function makeApp(cal: MockCalendarProvider) {
  const v1 = new OpenAPIHono<{ Bindings: typeof env; Variables: AppVariables }>();
  v1.use("*", async (c, next) => {
    c.set("calendarProvider", cal);
    c.set("notificationProvider", new MockNotificationProvider());
    await next();
  });
  mountAcceptRoute(v1);
  const app = new Hono<{ Bindings: typeof env; Variables: AppVariables }>();
  app.route("/v1", v1);
  return app;
}

const W1 = { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" };
const W2 = { start: "2026-05-25T00:00:00Z", end: "2026-06-01T00:00:00Z" };
// A mid-week replan of W1's calendar week: window narrowed to Wed so the solver
// can't place into the past. Same local week (Mon 18 May, Australia/Sydney) as W1.
const WMID = { start: "2026-05-20T00:00:00+10:00", end: "2026-05-25T00:00:00+10:00" };

function seedPlan(hash: string, w: { start: string; end: string }, createdAt: string) {
  return env.DB
    .prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end) VALUES (?, ?, ?, '2099-01-01T00:00:00Z', NULL, 'operator@example.com', ?, ?)",
    )
    .bind(hash, JSON.stringify({ ...planBody, window: w }), createdAt, w.start, w.end)
    .run();
}

function seedCommitted(
  hash: string,
  w: { start: string; end: string },
  createdAt: string,
  committedAt: string,
) {
  return env.DB
    .prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end) VALUES (?, ?, ?, '2099-01-01T00:00:00Z', ?, 'operator@example.com', ?, ?)",
    )
    .bind(hash, JSON.stringify({ ...planBody, window: w }), createdAt, committedAt, w.start, w.end)
    .run();
}

function snapshotFor(w: { start: string; end: string }, title: string) {
  return {
    tz: "Australia/Sydney", window: w, trigger: "monday-cron", isEmpty: false,
    days: [{ date: "2026-05-19", before: [],
      after: [{ title, start: "2026-05-19T04:45:00.000Z", end: "2026-05-19T06:45:00.000Z", role: "added" }] }],
    dropped: [],
  };
}

describe("POST /v1/plans/:hash/accept", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposed_plans").run();
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB
      .prepare(
        "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES ('t1', 'operator@example.com', ?, 'pending', '2026-05-17T00:00:00Z', '2026-05-17T00:00:00Z')",
      )
      .bind(JSON.stringify({ id: "t1", title: "Deep work" }))
      .run();
    await env.DB
      .prepare(
        "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end) VALUES ('h1', ?, '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', NULL, 'operator@example.com', '2026-05-18T00:00:00Z', '2026-05-25T00:00:00Z')",
      )
      .bind(JSON.stringify(planBody))
      .run();
  });

  it("accepts with a valid capability token", async () => {
    const t = await signCapability(
      { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300 },
      env.TOKEN_HASH_PEPPER,
    );
    const cal = new MockCalendarProvider();
    const res = await makeApp(cal).request(
      "/v1/plans/h1/accept",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ t }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(cal.getCreated()).toHaveLength(1);
    const row = await env.DB
      .prepare("SELECT committed_at FROM proposed_plans WHERE plan_hash = 'h1'")
      .first<{ committed_at: string | null }>();
    expect(row?.committed_at).not.toBeNull();
  });

  it("POST on an already-committed hash is an idempotent 200", async () => {
    await env.DB.prepare("UPDATE proposed_plans SET committed_at = '2026-05-18T01:00:00Z' WHERE plan_hash = 'h1'").run();
    const app = makeApp(new MockCalendarProvider());
    const t = await signCapability(
      { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300 },
      env.TOKEN_HASH_PEPPER,
    );
    const res = await app.request(
      "/v1/plans/h1/accept",
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: `t=${encodeURIComponent(t)}` },
      { ...env, OAUTH_ISSUER: "https://scheduler.example.com" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("POST commits exactly the plan hash in the path, not a newer plan", async () => {
    await seedPlan("h2", W1, "2026-05-19T00:00:00Z"); // newer, same window
    const cal = new MockCalendarProvider();
    const t = await signCapability(
      { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300 },
      env.TOKEN_HASH_PEPPER,
    );
    const res = await makeApp(cal).request(
      "/v1/plans/h1/accept",
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `t=${encodeURIComponent(t)}` },
      { ...env, OAUTH_ISSUER: "https://scheduler.example.com" },
    );
    expect(res.status).toBe(200);
    const h1 = await env.DB.prepare("SELECT committed_at FROM proposed_plans WHERE plan_hash = 'h1'").first<{ committed_at: string | null }>();
    const h2 = await env.DB.prepare("SELECT committed_at FROM proposed_plans WHERE plan_hash = 'h2'").first<{ committed_at: string | null }>();
    expect(h1?.committed_at).not.toBeNull();
    expect(h2?.committed_at).toBeNull();
  });

  it("POST for a superseded (deleted) hash returns 409 plan_superseded with the window's latest hash (JSON)", async () => {
    await env.DB.prepare("DELETE FROM proposed_plans WHERE plan_hash = 'h1'").run();
    await seedPlan("h2", W1, "2026-05-19T00:00:00Z");
    const t = await signCapability(
      { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300 },
      env.TOKEN_HASH_PEPPER,
    );
    const res = await makeApp(new MockCalendarProvider()).request(
      "/v1/plans/h1/accept",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ t, ws: W1.start, we: W1.end }).toString(),
      },
      { ...env, OAUTH_ISSUER: "https://scheduler.example.com" },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "plan_superseded", latest_plan_hash: "h2" });
  });

  it("POST 409 with no ws/we resolves the window from the token's claim, not newest-overall (JSON)", async () => {
    // h1 (W1) gone. Two pending weeks remain; h3 (W2) is newer, so a pending[0]
    // fallback would return the WRONG week. The token carries the W1 claim → h2.
    await env.DB.prepare("DELETE FROM proposed_plans WHERE plan_hash = 'h1'").run();
    await seedPlan("h2", W1, "2026-05-19T00:00:00Z");
    await seedPlan("h3", W2, "2026-05-20T00:00:00Z"); // newer overall
    const t = await signCapability(
      { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300, window: W1 },
      env.TOKEN_HASH_PEPPER,
    );
    const res = await makeApp(new MockCalendarProvider()).request(
      "/v1/plans/h1/accept",
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: `t=${encodeURIComponent(t)}` },
      { ...env, OAUTH_ISSUER: "https://scheduler.example.com" },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "plan_superseded", latest_plan_hash: "h2" });
  });

  it("POST 409 omits latest_plan_hash when no window is identifiable (JSON)", async () => {
    // h1 (W1) gone, h2 (W1) pending, but the token carries NO window claim and
    // the form has no ws/we — the week is unidentifiable, so don't guess a hash.
    await env.DB.prepare("DELETE FROM proposed_plans WHERE plan_hash = 'h1'").run();
    await seedPlan("h2", W1, "2026-05-19T00:00:00Z");
    const t = await signCapability(
      { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300 },
      env.TOKEN_HASH_PEPPER,
    );
    const res = await makeApp(new MockCalendarProvider()).request(
      "/v1/plans/h1/accept",
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: `t=${encodeURIComponent(t)}` },
      { ...env, OAUTH_ISSUER: "https://scheduler.example.com" },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "plan_superseded" });
  });

  it("POST via optical bearer commits the exact hash and returns JSON 200", async () => {
    await seedBearer("fake", "operator@example.com");
    const cal = new MockCalendarProvider();
    const res = await makeApp(cal).request(
      "/v1/plans/h1/accept",
      { method: "POST", headers: { Authorization: "Bearer fake" } },
      { ...env, OAUTH_ISSUER: "https://scheduler.example.com" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(cal.getCreated()).toHaveLength(1);
    const row = await env.DB.prepare("SELECT committed_at FROM proposed_plans WHERE plan_hash = 'h1'").first<{ committed_at: string | null }>();
    expect(row?.committed_at).not.toBeNull();
  });

  it("POST race (HTML): superseded while the page was open re-renders the new plan with a banner and commits nothing", async () => {
    await env.DB.prepare("DELETE FROM proposed_plans WHERE plan_hash = 'h1'").run();
    await seedPlan("h2", W1, "2026-05-19T00:00:00Z");
    await attachRenderSnapshot(env.DB, "h2", snapshotFor(W1, "Rescheduled work"));
    const cal = new MockCalendarProvider();
    const t = await signCapability(
      { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300 },
      env.TOKEN_HASH_PEPPER,
    );
    const res = await makeApp(cal).request(
      "/v1/plans/h1/accept",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ t, ws: W1.start, we: W1.end }).toString(),
      },
      { ...env, OAUTH_ISSUER: "https://scheduler.example.com" },
    );
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain("while you had this page open");
    expect(html).toContain("Rescheduled work");
    expect(html).toContain("/v1/plans/h2/accept");   // form now targets the new plan
    expect(cal.getCreated()).toHaveLength(0);        // nothing was applied
    const h2 = await env.DB.prepare("SELECT committed_at FROM proposed_plans WHERE plan_hash = 'h2'").first<{ committed_at: string | null }>();
    expect(h2?.committed_at).toBeNull();
  });

  it("POST expired plan returns 410 with end-user copy (HTML)", async () => {
    await env.DB.prepare("UPDATE proposed_plans SET expires_at = '2020-01-01T00:00:00Z' WHERE plan_hash = 'h1'").run();
    const t = await signCapability(
      { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300 },
      env.TOKEN_HASH_PEPPER,
    );
    const res = await makeApp(new MockCalendarProvider()).request(
      "/v1/plans/h1/accept",
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `t=${encodeURIComponent(t)}` },
      { ...env, OAUTH_ISSUER: "https://scheduler.example.com" },
    );
    expect(res.status).toBe(410);
    expect(await res.text()).toContain("expired and can no longer be accepted");
  });

  it("accepted page offers the other pending week", async () => {
    await seedPlan("h2", W2, "2026-05-19T00:00:00Z");
    await attachRenderSnapshot(env.DB, "h2", snapshotFor(W2, "Week two work"));
    const t = await signCapability(
      { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300 },
      env.TOKEN_HASH_PEPPER,
    );
    const res = await makeApp(new MockCalendarProvider()).request(
      "/v1/plans/h1/accept",
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `t=${encodeURIComponent(t)}` },
      { ...env, OAUTH_ISSUER: "https://scheduler.example.com" },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Plan accepted");
    expect(html).toContain("You also have proposed changes");
    expect(html).toContain("/v1/plans/h2/accept");
  });

  it("GET preview points the form at the latest plan hash", async () => {
    await seedPlan("h2", W1, "2026-05-19T00:00:00Z");
    await attachRenderSnapshot(env.DB, "h2", {
      tz: "Australia/Sydney", window: planBody.window, trigger: "monday-cron", isEmpty: false,
      days: [{ date: "2026-05-19", before: [],
        after: [{ title: "Deep work", start: "2026-05-19T04:45:00.000Z", end: "2026-05-19T06:45:00.000Z", role: "added" }] }],
      dropped: [],
    });
    const app = makeApp(new MockCalendarProvider());
    const t = await signCapability(
      { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300 },
      env.TOKEN_HASH_PEPPER,
    );
    const res = await app.request(`/v1/plans/h1/accept?t=${encodeURIComponent(t)}`, { method: "GET" }, { ...env });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/v1/plans/h2/accept");
  });

  it("GET confirm page renders the latest plan's snapshot with local times and a staleness banner", async () => {
    // newer plan h2 (latest); capability is for the OLD h1 → stale
    await seedPlan("h2", W1, "2026-05-19T00:00:00Z");
    await attachRenderSnapshot(env.DB, "h2", {
      tz: "Australia/Sydney", window: planBody.window, trigger: "monday-cron", isEmpty: false,
      days: [{ date: "2026-05-19",
        before: [{ title: "Deep work", start: "2026-05-19T01:30:00.000Z", end: "2026-05-19T03:30:00.000Z", role: "moved-from" }],
        after: [{ title: "Deep work", start: "2026-05-19T04:45:00.000Z", end: "2026-05-19T06:45:00.000Z", role: "moved-to", movedFrom: "2026-05-19T01:30:00.000Z" }] }],
      dropped: [],
    });
    const t = await signCapability({ planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300 }, env.TOKEN_HASH_PEPPER);
    const res = await makeApp(new MockCalendarProvider()).request(`/v1/plans/h1/accept?t=${encodeURIComponent(t)}`, { method: "GET" }, { ...env });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Review &amp; accept");
    expect(html).toContain("changed after that email was sent");  // staleness banner
    expect(html).toContain("Deep work");
    expect(html).toContain("2:45 PM");
    expect(html).toContain("/v1/plans/h2/accept");               // form posts to latest
  });

  it("GET confirm page shows 'Nothing to accept' (no form) when the latest pending plan has no render snapshot", async () => {
    // beforeEach seeds h1 with a NULL render_snapshot — i.e. a phantom / no-op
    // replan leftover. The page must degrade gracefully, not show a bare button.
    const t = await signCapability(
      { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300 },
      env.TOKEN_HASH_PEPPER,
    );
    const res = await makeApp(new MockCalendarProvider()).request(`/v1/plans/h1/accept?t=${encodeURIComponent(t)}`, { method: "GET" }, { ...env });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("all caught up");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Your plan is ready to accept");
  });

  it("GET confirm page shows 'Nothing to accept' when the latest plan's snapshot is an empty diff", async () => {
    await attachRenderSnapshot(env.DB, "h1", {
      tz: "Australia/Sydney", window: planBody.window, trigger: "monday-cron", isEmpty: true, days: [], dropped: [],
    });
    const t = await signCapability(
      { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300 },
      env.TOKEN_HASH_PEPPER,
    );
    const res = await makeApp(new MockCalendarProvider()).request(`/v1/plans/h1/accept?t=${encodeURIComponent(t)}`, { method: "GET" }, { ...env });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("all caught up");
    expect(html).not.toContain("<form");
  });

  it("GET renders a week selector when plans for two windows are pending, preselecting the token's window", async () => {
    await seedPlan("h2", W2, "2026-05-19T00:00:00Z");
    await attachRenderSnapshot(env.DB, "h1", snapshotFor(W1, "Week one work"));
    await attachRenderSnapshot(env.DB, "h2", snapshotFor(W2, "Week two work"));
    // Token carries the W1 window claim even though h2 is newer.
    const t = await signCapability(
      { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300, window: W1 },
      env.TOKEN_HASH_PEPPER,
    );
    const res = await makeApp(new MockCalendarProvider()).request(`/v1/plans/h1/accept?t=${encodeURIComponent(t)}`, { method: "GET" }, { ...env });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Week one work");                 // W1 preselected despite h2 being newer
    expect(html).not.toContain("Week two work");
    expect(html).toContain("You have proposed changes for 2 weeks");
    expect(html).toContain("/v1/plans/h2/accept");           // other week's tab link
    expect(html).toContain("/v1/plans/h1/accept");           // form target
  });

  it("GET groups a mid-week window with its calendar week — one tab, newest plan shown", async () => {
    // h1 (Mon-anchored, from beforeEach) and h2 (newer, Wed-anchored) are the
    // SAME calendar week: one week on the page, showing the newest plan.
    await seedPlan("h2", WMID, "2026-05-19T00:00:00Z");
    await attachRenderSnapshot(env.DB, "h1", snapshotFor(W1, "Week one work"));
    await attachRenderSnapshot(env.DB, "h2", snapshotFor(WMID, "Midweek work"));
    const t = await signCapability(
      { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300, window: W1 },
      env.TOKEN_HASH_PEPPER,
    );
    const res = await makeApp(new MockCalendarProvider()).request(`/v1/plans/h1/accept?t=${encodeURIComponent(t)}`, { method: "GET" }, { ...env });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("proposed changes for 2 weeks");   // not two "weeks"
    expect(html).toContain("Midweek work");                       // the week's newest plan
    expect(html).not.toContain("Week one work");
    expect(html).toContain("/v1/plans/h2/accept");                // form targets it
    expect(html).toContain("changed after that email was sent");  // stale-email banner
  });

  it("week tab labels anchor to the week's Monday even for a mid-week window", async () => {
    await env.DB.prepare("DELETE FROM proposed_plans WHERE plan_hash = 'h1'").run();
    await seedPlan("h2", WMID, "2026-05-19T00:00:00Z");
    await seedPlan("h3", W2, "2026-05-20T00:00:00Z");
    await attachRenderSnapshot(env.DB, "h2", snapshotFor(WMID, "Midweek work"));
    await attachRenderSnapshot(env.DB, "h3", snapshotFor(W2, "Week two work"));
    const t = await signCapability(
      { planHash: "h2", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300, window: WMID },
      env.TOKEN_HASH_PEPPER,
    );
    const html = await (await makeApp(new MockCalendarProvider()).request(`/v1/plans/h2/accept?t=${encodeURIComponent(t)}`, { method: "GET" }, { ...env })).text();
    expect(html).toContain("Week of Mon 18 May");
    expect(html).not.toContain("Wed 20 May");
    expect(html).toContain("Week of Mon 25 May");
  });

  it("accepted page does not offer another window of the same calendar week", async () => {
    await seedPlan("h2", WMID, "2026-05-19T00:00:00Z");
    await attachRenderSnapshot(env.DB, "h2", snapshotFor(WMID, "Midweek work"));
    const t = await signCapability(
      { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300 },
      env.TOKEN_HASH_PEPPER,
    );
    const res = await makeApp(new MockCalendarProvider()).request(
      "/v1/plans/h1/accept",
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `t=${encodeURIComponent(t)}` },
      { ...env, OAUTH_ISSUER: "https://scheduler.example.com" },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Plan accepted");
    expect(html).not.toContain("also have proposed changes");
    expect(html).not.toContain("/v1/plans/h2/accept");
  });

  it("POST 409 resolves the replacement across differently-anchored windows of the same week (JSON)", async () => {
    await env.DB.prepare("DELETE FROM proposed_plans WHERE plan_hash = 'h1'").run();
    await seedPlan("h2", WMID, "2026-05-19T00:00:00Z");
    const t = await signCapability(
      { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300 },
      env.TOKEN_HASH_PEPPER,
    );
    const res = await makeApp(new MockCalendarProvider()).request(
      "/v1/plans/h1/accept",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ t, ws: W1.start, we: W1.end }).toString(),
      },
      { ...env, OAUTH_ISSUER: "https://scheduler.example.com" },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "plan_superseded", latest_plan_hash: "h2" });
  });

  it("GET ?ws/&we params override the token's window claim", async () => {
    await seedPlan("h2", W2, "2026-05-19T00:00:00Z");
    await attachRenderSnapshot(env.DB, "h1", snapshotFor(W1, "Week one work"));
    await attachRenderSnapshot(env.DB, "h2", snapshotFor(W2, "Week two work"));
    const t = await signCapability(
      { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300, window: W1 },
      env.TOKEN_HASH_PEPPER,
    );
    const url = `/v1/plans/h1/accept?t=${encodeURIComponent(t)}&ws=${encodeURIComponent(W2.start)}&we=${encodeURIComponent(W2.end)}`;
    const html = await (await makeApp(new MockCalendarProvider()).request(url, { method: "GET" }, { ...env })).text();
    expect(html).toContain("Week two work");
    expect(html).not.toContain("Week one work");
  });

  it("GET shows a 'no longer needed' notice (not another week's plan) when the token's window has nothing pending", async () => {
    // Only W2 is pending; the token was emailed for W1 whose plan is gone (superseded then no-diff'd away).
    await env.DB.prepare("DELETE FROM proposed_plans WHERE plan_hash = 'h1'").run();
    await seedPlan("h2", W2, "2026-05-19T00:00:00Z");
    await attachRenderSnapshot(env.DB, "h2", snapshotFor(W2, "Week two work"));
    const t = await signCapability(
      { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300, window: W1 },
      env.TOKEN_HASH_PEPPER,
    );
    const html = await (await makeApp(new MockCalendarProvider()).request(`/v1/plans/h1/accept?t=${encodeURIComponent(t)}`, { method: "GET" }, { ...env })).text();
    expect(html).toContain("no longer needed");
    expect(html).not.toContain("Week two work");   // don't silently show another week
    expect(html).not.toContain("<form");
  });

  it("GET shows an 'already accepted' notice when the emailed plan was committed", async () => {
    await env.DB.prepare("UPDATE proposed_plans SET committed_at = '2026-05-18T01:00:00Z' WHERE plan_hash = 'h1'").run();
    const t = await signCapability(
      { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300, window: W1 },
      env.TOKEN_HASH_PEPPER,
    );
    const html = await (await makeApp(new MockCalendarProvider()).request(`/v1/plans/h1/accept?t=${encodeURIComponent(t)}`, { method: "GET" }, { ...env })).text();
    expect(html).toContain("already accepted");
    expect(html).not.toContain("<form");
  });

  // A pending plan proposed BEFORE the same week's latest accept is stale: its
  // diff was computed against pre-accept task/calendar state (e.g. a resolve
  // racing the accept on another surface). Never show or offer it — the user
  // already accepted a newer plan for that week.
  describe("pending plans superseded by a newer same-week accept are never shown", () => {
    it("GET shows 'already accepted' (no form) when the week's accept postdates the pending plan", async () => {
      // h1 pending, created 2026-05-18T00:00 (beforeEach). A newer W1 plan was
      // accepted afterwards.
      await seedCommitted("hc", W1, "2026-05-18T02:00:00Z", "2026-05-18T03:00:00Z");
      await attachRenderSnapshot(env.DB, "h1", snapshotFor(W1, "Week one work"));
      const t = await signCapability(
        { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300, window: W1 },
        env.TOKEN_HASH_PEPPER,
      );
      const html = await (await makeApp(new MockCalendarProvider()).request(`/v1/plans/h1/accept?t=${encodeURIComponent(t)}`, { method: "GET" }, { ...env })).text();
      expect(html).toContain("already accepted");
      expect(html).not.toContain("Week one work");
      expect(html).not.toContain("<form");
    });

    it("GET viewing a fresh week shows no tab for a sibling week whose pending is stale", async () => {
      // W1's pending (h1) predates W1's accept → stale. Viewing W2's fresh
      // pending must not offer W1 as a second week.
      await seedCommitted("hc", W1, "2026-05-18T02:00:00Z", "2026-05-18T03:00:00Z");
      await seedPlan("h3", W2, "2026-05-19T00:00:00Z");
      await attachRenderSnapshot(env.DB, "h1", snapshotFor(W1, "Week one work"));
      await attachRenderSnapshot(env.DB, "h3", snapshotFor(W2, "Week two work"));
      const t = await signCapability(
        { planHash: "h3", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300, window: W2 },
        env.TOKEN_HASH_PEPPER,
      );
      const html = await (await makeApp(new MockCalendarProvider()).request(`/v1/plans/h3/accept?t=${encodeURIComponent(t)}`, { method: "GET" }, { ...env })).text();
      expect(html).toContain("Week two work");                    // fresh week renders
      expect(html).not.toContain("proposed changes for 2 weeks"); // stale week is not a tab
      expect(html).not.toContain("/v1/plans/h1/accept");
      expect(html).not.toContain("Week one work");
    });

    it("GET still shows a pending plan created AFTER the week's last accept (fresh re-resolve)", async () => {
      // Accept predates the pending: the pending was resolved against
      // post-accept state and is current — must still be reviewable.
      await seedCommitted("hc", W1, "2026-05-17T20:00:00Z", "2026-05-17T23:00:00Z");
      await attachRenderSnapshot(env.DB, "h1", snapshotFor(W1, "Week one work"));
      const t = await signCapability(
        { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300, window: W1 },
        env.TOKEN_HASH_PEPPER,
      );
      const html = await (await makeApp(new MockCalendarProvider()).request(`/v1/plans/h1/accept?t=${encodeURIComponent(t)}`, { method: "GET" }, { ...env })).text();
      expect(html).toContain("Week one work");
      expect(html).toContain("<form");
    });

    it("POST 409 for a superseded hash omits latest_plan_hash when the week's only pending is stale (JSON)", async () => {
      await env.DB.prepare("DELETE FROM proposed_plans WHERE plan_hash = 'h1'").run();
      await seedPlan("h2", W1, "2026-05-19T00:00:00Z");
      await seedCommitted("hc", W1, "2026-05-19T01:00:00Z", "2026-05-19T02:00:00Z");
      const t = await signCapability(
        { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300 },
        env.TOKEN_HASH_PEPPER,
      );
      const res = await makeApp(new MockCalendarProvider()).request(
        "/v1/plans/h1/accept",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({ t, ws: W1.start, we: W1.end }).toString(),
        },
        { ...env, OAUTH_ISSUER: "https://scheduler.example.com" },
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "plan_superseded" });
    });

    it("accepted page does not offer another week whose pending predates that week's accept", async () => {
      await seedPlan("h2", W2, "2026-05-19T00:00:00Z");
      await attachRenderSnapshot(env.DB, "h2", snapshotFor(W2, "Week two work"));
      await seedCommitted("hc", W2, "2026-05-19T01:00:00Z", "2026-05-19T02:00:00Z");
      const t = await signCapability(
        { planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300 },
        env.TOKEN_HASH_PEPPER,
      );
      const res = await makeApp(new MockCalendarProvider()).request(
        "/v1/plans/h1/accept",
        { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `t=${encodeURIComponent(t)}` },
        { ...env, OAUTH_ISSUER: "https://scheduler.example.com" },
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Plan accepted");
      expect(html).not.toContain("also have proposed changes");
      expect(html).not.toContain("/v1/plans/h2/accept");
    });
  });

  it("POST returns a styled HTML page for a browser form submit", async () => {
    const t = await signCapability({ planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300 }, env.TOKEN_HASH_PEPPER);
    const res = await makeApp(new MockCalendarProvider()).request(
      "/v1/plans/h1/accept",
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `t=${encodeURIComponent(t)}` },
      { ...env, OAUTH_ISSUER: "https://scheduler.example.com" },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Plan accepted");
  });

  it("POST returns JSON when the caller asks for application/json", async () => {
    const t = await signCapability({ planHash: "h1", subject: "operator@example.com", purpose: "accept", ttlSeconds: 300 }, env.TOKEN_HASH_PEPPER);
    const res = await makeApp(new MockCalendarProvider()).request(
      "/v1/plans/h1/accept",
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: `t=${encodeURIComponent(t)}` },
      { ...env, OAUTH_ISSUER: "https://scheduler.example.com" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
