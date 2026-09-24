import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { runCleanupExpiredPlans } from "../../src/cron/cleanup-proposed-plans";

describe("runCleanupExpiredPlans", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposed_plans").run();
  });

  it("deletes expired, uncommitted plans", async () => {
    const expiredBody = JSON.stringify({ schedule: [], dropped: [], window: {} });
    await env.DB.prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at) VALUES ('h-old', ?, '2026-05-10T00:00:00Z', '2026-05-11T00:00:00Z', NULL)").bind(expiredBody).run();
    await env.DB.prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at) VALUES ('h-fresh', ?, '2026-05-18T00:00:00Z', '2026-05-19T00:00:00Z', NULL)").bind(expiredBody).run();

    const r = await runCleanupExpiredPlans(env.DB, new Date("2026-05-18T12:00:00Z"));
    expect(r.deleted).toBe(1);

    const remaining = await env.DB.prepare("SELECT plan_hash FROM proposed_plans ORDER BY plan_hash").all<{ plan_hash: string }>();
    expect(remaining.results!.map((r) => r.plan_hash)).toEqual(["h-fresh"]);
  });

  it("preserves committed plans regardless of expires_at", async () => {
    const body = JSON.stringify({ schedule: [], dropped: [], window: {} });
    await env.DB.prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at) VALUES ('h-committed', ?, '2026-05-10T00:00:00Z', '2026-05-11T00:00:00Z', '2026-05-10T01:00:00Z')").bind(body).run();

    const r = await runCleanupExpiredPlans(env.DB, new Date("2026-05-18T12:00:00Z"));
    expect(r.deleted).toBe(0);

    const row = await env.DB.prepare("SELECT plan_hash FROM proposed_plans WHERE plan_hash = 'h-committed'").first();
    expect(row).not.toBeNull();
  });

  it("returns deleted: 0 when nothing matches", async () => {
    const r = await runCleanupExpiredPlans(env.DB, new Date("2026-05-18T12:00:00Z"));
    expect(r.deleted).toBe(0);
  });
});
