// tz-matrix mirror of test/handlers/timezone.test.ts and test/db/home-tz.test.ts:
// every matrix zone must be settable as a home_tz, read back canonically, and
// a change away from it must stamp it onto untimezoned task windows. Run both
// with the deployment default (SCHEDULER_TZ) as Sydney and as the zone itself.
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { v1 as app } from "../../src/v1";
import { seedTwoUsers, type SeededUser } from "../fixtures/owners";
import { upsertUser, getUser, getHomeTz } from "../../src/db/users";
import { MATRIX_ZONES, MIDNIGHT_GAP_ZONES } from "./zones";

const ALL_ZONES = [...new Set([...MATRIX_ZONES, ...MIDNIGHT_GAP_ZONES])];
let a: SeededUser;

beforeEach(async () => {
  ({ a } = await seedTwoUsers());
  await env.DB.prepare("DELETE FROM users").run();
  await env.DB.prepare("DELETE FROM proposed_plans").run();
  await env.DB.prepare("DELETE FROM tasks").run();
  await upsertUser(env.DB, a.subject);
});

const W = (extra: Record<string, unknown> = {}) => ({ days: ["tue"], start: "14:00", end: "16:00", hard: true, ...extra });
async function insertTask(id: string) {
  await env.DB.prepare("INSERT INTO tasks (id, body, template_id, project_id, status, created_at, updated_at, owner_subject) VALUES (?,?,?,?,?,?,?,?)")
    .bind(id, JSON.stringify({ title: id, context: "deep", priority: 50, duration_minutes: 60, preferred_windows: [W()] }), null, null, "pending", "2026-05-01T00:00:00Z", "2026-05-01T00:00:00Z", a.subject)
    .run();
}
async function windowsOf(id: string) {
  const row = await env.DB.prepare("SELECT body FROM tasks WHERE id = ?").bind(id).first<{ body: string }>();
  return (JSON.parse(row!.body) as { preferred_windows?: unknown }).preferred_windows;
}

describe.each(ALL_ZONES)("/v1/timezone with %s", (tz) => {
  const req = (method: string, body?: unknown, e: typeof env = env) =>
    app.request("/timezone", { method, headers: a.headers, body: body === undefined ? undefined : JSON.stringify(body) }, e);

  it("PATCH stores the zone, GET and getHomeTz read it back", async () => {
    const r = await req("PATCH", { tz });
    expect(r.status, await r.clone().text()).toBe(200);
    expect((await r.json<{ tz: string }>()).tz).toBe(tz);
    const g = await app.request("/timezone", { headers: { Authorization: `Bearer ${a.token}` } }, env);
    expect(await g.json()).toMatchObject({ tz, source: "user" });
    expect(await getHomeTz(env.DB, a.subject, env.SCHEDULER_TZ)).toBe(tz);
    expect((await getUser(env.DB, a.subject))?.home_tz).toBe(tz);
  });

  it("PATCH away from the zone stamps it onto untimezoned windows", async () => {
    await req("PATCH", { tz });
    await insertTask("t1");
    const other = tz === "Asia/Tokyo" ? "Europe/London" : "Asia/Tokyo";
    expect((await req("PATCH", { tz: other })).status).toBe(200);
    expect(await windowsOf("t1")).toEqual([W({ tz })]);
  });

  it("with the zone as SCHEDULER_TZ, GET reports it as the default and PATCH to Sydney stamps it", async () => {
    const e = { ...env, SCHEDULER_TZ: tz } as typeof env;
    const g = await app.request("/timezone", { headers: { Authorization: `Bearer ${a.token}` } }, e);
    expect(await g.json()).toMatchObject({ tz, source: "default" });
    await insertTask("t2");
    const target = tz === "Australia/Sydney" ? "Asia/Tokyo" : "Australia/Sydney";
    expect((await req("PATCH", { tz: target }, e)).status).toBe(200);
    expect(await windowsOf("t2")).toEqual([W({ tz })]);
  });
});
