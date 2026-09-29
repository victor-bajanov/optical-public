// worker/test/handlers/timezone.test.ts
// Card A of internal design notes: GET/PATCH/DELETE /v1/timezone.
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { v1 as app } from "../../src/v1";
import { seedTwoUsers, type SeededUser } from "../fixtures/owners";
import { insertProposedPlan, markProposedPlanCommitted } from "../../src/planning/proposed-plans";
import { upsertUser, getUser } from "../../src/db/users";

interface TzResponse {
  tz: string;
  source: "user" | "default";
  superseded_plans: number;
}

let a: SeededUser, b: SeededUser;
const DEFAULT_TZ = env.SCHEDULER_TZ;

beforeEach(async () => {
  ({ a, b } = await seedTwoUsers());
  await env.DB.prepare("DELETE FROM users").run();
  await env.DB.prepare("DELETE FROM proposed_plans").run();
  // Sign-in creates the users row; the timezone routes never do.
  await upsertUser(env.DB, a.subject);
  await upsertUser(env.DB, b.subject);
});

function get(u: SeededUser) {
  return app.request("/timezone", { headers: { Authorization: `Bearer ${u.token}` } }, env);
}
function patch(u: SeededUser, body: unknown) {
  return app.request("/timezone", { method: "PATCH", headers: u.headers, body: JSON.stringify(body) }, env);
}
function del(u: SeededUser, e: typeof env = env) {
  return app.request("/timezone", { method: "DELETE", headers: { Authorization: `Bearer ${u.token}` } }, e);
}

/** env whose DB rewrites the pending-plan DELETE to hit a missing table, so
 *  that statement fails; everything else passes through to the real D1. */
function envWithFailingPlanDelete(): typeof env {
  const real = env.DB;
  const db = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) =>
          target.prepare(sql.replace(/DELETE FROM proposed_plans/, "DELETE FROM no_such_table_for_test"));
      }
      const v = (target as any)[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { ...env, DB: db } as typeof env;
}
async function homeTz(subject: string): Promise<string | null | undefined> {
  return (await getUser(env.DB, subject))?.home_tz;
}

const planBody = (tag: string) => ({
  schedule: [{ task_id: tag, chunk_id: `${tag}#0`, start: "2026-05-19T09:00:00Z", end: "2026-05-19T10:00:00Z", context: "deep" }],
  dropped: [],
  window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
  weights: {},
});

async function seedPlans() {
  await insertProposedPlan(env.DB, "a-pending", planBody("a1"), "2026-05-18T12:00:00Z", "2099-01-01T00:00:00Z", a.subject);
  await insertProposedPlan(env.DB, "a-committed", planBody("a2"), "2026-05-18T12:00:00Z", "2099-01-01T00:00:00Z", a.subject);
  await markProposedPlanCommitted(env.DB, "a-committed", "2026-05-18T13:00:00Z", a.subject);
  await insertProposedPlan(env.DB, "b-pending", planBody("b1"), "2026-05-18T12:00:00Z", "2099-01-01T00:00:00Z", b.subject);
}
async function planHashes(): Promise<string[]> {
  const rs = await env.DB.prepare("SELECT plan_hash FROM proposed_plans ORDER BY plan_hash").all<{ plan_hash: string }>();
  return rs.results.map((r) => r.plan_hash);
}

describe("GET /v1/timezone", () => {
  it("returns the instance default with source:default when unset", async () => {
    const res = await get(a);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tz: DEFAULT_TZ, source: "default", superseded_plans: 0 });
  });

  it("returns the user's zone with source:user once set", async () => {
    await patch(a, { tz: "Europe/London" });
    const res = await get(a);
    expect(await res.json()).toEqual({ tz: "Europe/London", source: "user", superseded_plans: 0 });
  });

  it("401 without a bearer", async () => {
    expect((await app.request("/timezone", {}, env)).status).toBe(401);
  });

  it("403 for a token carrying no subject", async () => {
    await env.DB.prepare("UPDATE oauth_tokens SET subject = NULL WHERE subject = ?").bind(a.subject).run();
    expect((await get(a)).status).toBe(403);
  });
});

describe("PATCH /v1/timezone", () => {
  it("stores the canonical zone name and whoami reflects it", async () => {
    const res = await patch(a, { tz: "europe/london" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tz: "Europe/London", source: "user", superseded_plans: 0 });
    const who = await app.request("/whoami", { headers: { Authorization: `Bearer ${a.token}` } }, env);
    expect(((await who.json()) as { home_tz: string }).home_tz).toBe("Europe/London");
  });

  it("deletes the caller's pending plans (only) when the effective zone changes", async () => {
    await seedPlans();
    const res = await patch(a, { tz: "Europe/London" });
    const body = (await res.json()) as TzResponse;
    expect(body.superseded_plans).toBe(1);
    expect(await planHashes()).toEqual(["a-committed", "b-pending"]);
  });

  it("keeps pending plans when the effective zone is unchanged (explicitly pinning the default)", async () => {
    await seedPlans();
    const res = await patch(a, { tz: DEFAULT_TZ.toLowerCase() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tz: DEFAULT_TZ, source: "user", superseded_plans: 0 });
    expect(await planHashes()).toEqual(["a-committed", "a-pending", "b-pending"]);
  });

  it("keeps pending plans when re-setting the same zone", async () => {
    await patch(a, { tz: "Europe/London" });
    await seedPlans();
    const body = (await (await patch(a, { tz: "Europe/London" })).json()) as TzResponse;
    expect(body.superseded_plans).toBe(0);
    expect(await planHashes()).toEqual(["a-committed", "a-pending", "b-pending"]);
  });

  it("400 validation_failed for an unknown zone, and nothing changes", async () => {
    await seedPlans();
    const res = await patch(a, { tz: "Not/AZone" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("validation_failed");
    expect(((await (await get(a)).json()) as TzResponse).source).toBe("default");
    expect(await planHashes()).toEqual(["a-committed", "a-pending", "b-pending"]);
  });

  it("400 validation_failed for a UTC offset or a bare legacy name like EST, and nothing changes", async () => {
    await seedPlans();
    for (const tz of ["+10:00", "-05:30", "+1000", "EST", "MST"]) {
      const res = await patch(a, { tz });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("validation_failed");
    }
    expect(((await (await get(a)).json()) as TzResponse).source).toBe("default");
    expect(await planHashes()).toEqual(["a-committed", "a-pending", "b-pending"]);
  });

  it("400 validation_failed for a missing tz or an unknown key", async () => {
    expect((await patch(a, {})).status).toBe(400);
    expect((await patch(a, { tz: "Europe/London", extra: 1 })).status).toBe(400);
  });

  it("401 without a bearer even when the body is malformed (auth runs before validation)", async () => {
    const res = await app.request("/timezone", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tz: "Not/AZone" }),
    }, env);
    expect(res.status).toBe(401);
  });

  it("403 for a token carrying no subject", async () => {
    await env.DB.prepare("UPDATE oauth_tokens SET subject = NULL WHERE subject = ?").bind(a.subject).run();
    expect((await patch(a, { tz: "Europe/London" })).status).toBe(403);
  });

  it("404 no_user_row when the subject has no users row: creates none and deletes nothing", async () => {
    await seedPlans();
    await env.DB.prepare("DELETE FROM users WHERE subject = ?").bind(a.subject).run();
    const res = await patch(a, { tz: "Europe/London" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("no_user_row");
    expect(await getUser(env.DB, a.subject)).toBeNull();
    expect(await planHashes()).toEqual(["a-committed", "a-pending", "b-pending"]);
  });

  it("is atomic: when the pending-plan delete fails, home_tz is left unchanged", async () => {
    await seedPlans();
    const res = await app.request(
      "/timezone",
      { method: "PATCH", headers: a.headers, body: JSON.stringify({ tz: "Europe/London" }) },
      envWithFailingPlanDelete(),
    );
    expect(res.status).toBe(500);
    expect(await homeTz(a.subject)).toBeNull();
    expect(await planHashes()).toEqual(["a-committed", "a-pending", "b-pending"]);
  });

  it("compares canonical forms: a legacy non-canonical home_tz equal to the new zone is no change", async () => {
    await env.DB.prepare("UPDATE users SET home_tz = 'europe/london' WHERE subject = ?").bind(a.subject).run();
    await seedPlans();
    const body = (await (await patch(a, { tz: "Europe/London" })).json()) as TzResponse;
    expect(body).toEqual({ tz: "Europe/London", source: "user", superseded_plans: 0 });
    expect(await homeTz(a.subject)).toBe("Europe/London");
    expect(await planHashes()).toEqual(["a-committed", "a-pending", "b-pending"]);
  });

  it("treats an uncanonicalisable legacy home_tz as different, superseding pending plans", async () => {
    await env.DB.prepare("UPDATE users SET home_tz = 'Bogus/Zone' WHERE subject = ?").bind(a.subject).run();
    await seedPlans();
    const body = (await (await patch(a, { tz: "Europe/London" })).json()) as TzResponse;
    expect(body.superseded_plans).toBe(1);
    expect(await planHashes()).toEqual(["a-committed", "b-pending"]);
  });
});

describe("DELETE /v1/timezone", () => {
  it("reverts to the default and supersedes pending plans when the zone was different", async () => {
    await patch(a, { tz: "Europe/London" });
    await seedPlans();
    const res = await del(a);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tz: DEFAULT_TZ, source: "default", superseded_plans: 1 });
    expect(await planHashes()).toEqual(["a-committed", "b-pending"]);
  });

  it("is an idempotent no-op (plans kept) when already on the default", async () => {
    await seedPlans();
    const res = await del(a);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tz: DEFAULT_TZ, source: "default", superseded_plans: 0 });
    expect(await planHashes()).toEqual(["a-committed", "a-pending", "b-pending"]);
  });

  it("keeps pending plans when the pinned zone equalled the default", async () => {
    await patch(a, { tz: DEFAULT_TZ });
    await seedPlans();
    const body = (await (await del(a)).json()) as TzResponse;
    expect(body).toEqual({ tz: DEFAULT_TZ, source: "default", superseded_plans: 0 });
    expect(await planHashes()).toEqual(["a-committed", "a-pending", "b-pending"]);
  });

  it("is atomic: when the pending-plan delete fails, home_tz is left unchanged", async () => {
    await patch(a, { tz: "Europe/London" });
    await seedPlans();
    const res = await del(a, envWithFailingPlanDelete());
    expect(res.status).toBe(500);
    expect(await homeTz(a.subject)).toBe("Europe/London");
    expect(await planHashes()).toEqual(["a-committed", "a-pending", "b-pending"]);
  });

  it("404 no_user_row when the subject has no users row", async () => {
    await seedPlans();
    await env.DB.prepare("DELETE FROM users WHERE subject = ?").bind(a.subject).run();
    const res = await del(a);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("no_user_row");
    expect(await getUser(env.DB, a.subject)).toBeNull();
    expect(await planHashes()).toEqual(["a-committed", "a-pending", "b-pending"]);
  });

  it("401 without a bearer", async () => {
    expect((await app.request("/timezone", { method: "DELETE" }, env)).status).toBe(401);
  });

  it("403 for a token carrying no subject", async () => {
    await env.DB.prepare("UPDATE oauth_tokens SET subject = NULL WHERE subject = ?").bind(a.subject).run();
    expect((await del(a)).status).toBe(403);
  });
});

describe("owner isolation", () => {
  it("A's PATCH is invisible to B", async () => {
    await patch(a, { tz: "Europe/London" });
    expect(await (await get(b)).json()).toEqual({ tz: DEFAULT_TZ, source: "default", superseded_plans: 0 });
  });
});

// Card E: a change of effective tz freezes every untimezoned preferred window of
// the caller's not-done tasks in the OLD zone, so a replan doesn't move it.
describe("preferred-window tz stamping on a change", () => {
  const W = (extra: Record<string, unknown> = {}) => ({ days: ["tue"], start: "14:00", end: "16:00", hard: true, ...extra });

  async function insertTask(owner: string, id: string, windows: unknown[] | undefined, status = "pending", templateId: string | null = null) {
    const body: Record<string, unknown> = { title: id, context: "deep", priority: 50, duration_minutes: 60 };
    if (windows !== undefined) body.preferred_windows = windows;
    await env.DB.prepare(
      "INSERT INTO tasks (id, body, template_id, project_id, status, created_at, updated_at, owner_subject) VALUES (?,?,?,?,?,?,?,?)",
    ).bind(id, JSON.stringify(body), templateId, null, status, "2026-05-01T00:00:00Z", "2026-05-01T00:00:00Z", owner).run();
  }
  async function windowsOf(id: string): Promise<unknown> {
    const row = await env.DB.prepare("SELECT body FROM tasks WHERE id = ?").bind(id).first<{ body: string }>();
    return (JSON.parse(row!.body) as { preferred_windows?: unknown }).preferred_windows;
  }
  async function insertTemplate(owner: string, id: string) {
    const body = {
      title: "tpl", context: "deep", rrule: "FREQ=WEEKLY;BYDAY=TU", duration_minutes: 60, active_from: "2026-01-01",
      task_body: { preferred_windows: [W()] },
    };
    await env.DB.prepare("INSERT INTO task_templates (id, body, owner_subject) VALUES (?,?,?)")
      .bind(id, JSON.stringify(body), owner).run();
  }

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare("DELETE FROM task_templates").run();
  });

  it("PATCH stamps the OLD effective tz onto untimezoned task windows, preserving window order", async () => {
    await insertTask(a.subject, "t-pending", [W(), W({ days: ["wed"], hard: false })]);
    await insertTask(a.subject, "t-scheduled", [W()], "scheduled");
    await insertTask(a.subject, "t-instance", [W()], "committed", "tpl-1");
    expect((await patch(a, { tz: "Europe/London" })).status).toBe(200);
    expect(await windowsOf("t-pending")).toEqual([W({ tz: DEFAULT_TZ }), W({ days: ["wed"], hard: false, tz: DEFAULT_TZ })]);
    expect(await windowsOf("t-scheduled")).toEqual([W({ tz: DEFAULT_TZ })]);
    // A materialised recurrence instance is a task row: it keeps its real-world time.
    expect(await windowsOf("t-instance")).toEqual([W({ tz: DEFAULT_TZ })]);
  });

  it("DELETE stamps the zone being left", async () => {
    await patch(a, { tz: "Europe/London" });
    await insertTask(a.subject, "t1", [W()]);
    expect((await del(a)).status).toBe(200);
    expect(await windowsOf("t1")).toEqual([W({ tz: "Europe/London" })]);
  });

  it("stamps done tasks too, so an un-done task keeps its real-world window", async () => {
    await insertTask(a.subject, "t-done", [W()], "done");
    await patch(a, { tz: "Europe/London" });
    expect(await windowsOf("t-done")).toEqual([W({ tz: DEFAULT_TZ })]);
  });

  it("bumps updated_at on stamped rows only", async () => {
    await insertTask(a.subject, "t-stamped", [W()]);
    await insertTask(a.subject, "t-explicit", [W({ tz: "Asia/Tokyo" })]);
    const before = Date.now();
    await patch(a, { tz: "Europe/London" });
    const at = async (id: string) =>
      (await env.DB.prepare("SELECT updated_at FROM tasks WHERE id = ?").bind(id).first<{ updated_at: string }>())!.updated_at;
    const stamped = await at("t-stamped");
    expect(stamped).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(Date.parse(stamped)).toBeGreaterThanOrEqual(before - 1000);
    expect(await at("t-explicit")).toBe("2026-05-01T00:00:00Z");
  });

  it("leaves an explicit window tz, other users, windowless tasks and templates alone", async () => {
    await insertTask(a.subject, "t-explicit", [W({ tz: "Asia/Tokyo" }), W()]);
    await insertTask(a.subject, "t-none", undefined);
    await insertTask(a.subject, "t-empty", []);
    await insertTask(b.subject, "t-b", [W()]);
    await insertTemplate(a.subject, "tpl-a");
    await patch(a, { tz: "Europe/London" });
    expect(await windowsOf("t-explicit")).toEqual([W({ tz: "Asia/Tokyo" }), W({ tz: DEFAULT_TZ })]);
    expect(await windowsOf("t-none")).toBeUndefined();
    expect(await windowsOf("t-empty")).toEqual([]);
    expect(await windowsOf("t-b")).toEqual([W()]);
    const tpl = await env.DB.prepare("SELECT body FROM task_templates WHERE id = 'tpl-a'").first<{ body: string }>();
    expect(JSON.parse(tpl!.body).task_body.preferred_windows).toEqual([W()]);
  });

  it("stamps nothing when the effective tz does not change", async () => {
    await insertTask(a.subject, "t1", [W()]);
    await patch(a, { tz: DEFAULT_TZ });
    expect(await windowsOf("t1")).toEqual([W()]);
    await del(a);
    expect(await windowsOf("t1")).toEqual([W()]);
  });

  it("stamps nothing when the old zone is uncanonicalisable (it can't be frozen)", async () => {
    await env.DB.prepare("UPDATE users SET home_tz = 'Bogus/Zone' WHERE subject = ?").bind(a.subject).run();
    await insertTask(a.subject, "t1", [W()]);
    await patch(a, { tz: "Europe/London" });
    expect(await windowsOf("t1")).toEqual([W()]);
  });

  it("stamps a legacy non-canonical old zone in canonical form", async () => {
    await env.DB.prepare("UPDATE users SET home_tz = 'asia/tokyo' WHERE subject = ?").bind(a.subject).run();
    await insertTask(a.subject, "t1", [W()]);
    await patch(a, { tz: "Europe/London" });
    expect(await windowsOf("t1")).toEqual([W({ tz: "Asia/Tokyo" })]);
  });

  it("is atomic with the tz write: a failed batch stamps nothing", async () => {
    await insertTask(a.subject, "t1", [W()]);
    const res = await app.request(
      "/timezone",
      { method: "PATCH", headers: a.headers, body: JSON.stringify({ tz: "Europe/London" }) },
      envWithFailingPlanDelete(),
    );
    expect(res.status).toBe(500);
    expect(await homeTz(a.subject)).toBeNull();
    expect(await windowsOf("t1")).toEqual([W()]);
  });
});
