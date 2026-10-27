import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runCleanupExpiredPlans } from "../../src/cron/cleanup-proposed-plans";
import { getCommittedDroppedForWeek, getCommittedPlanForWeek, getCommittedPlansForSubject } from "../../src/planning/proposed-plans";

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

  describe("committed-plan scrub (third-party titles)", () => {
    const SUBJECT = "scrub-user@example.com";
    const TZ = "UTC";
    const WINDOW = { start: "2026-05-11T00:00:00Z", end: "2026-05-18T00:00:00Z" };
    const SCHEDULE = [{ task_id: "11111111-1111-4111-8111-111111111111", chunk_id: "c1", start: "2026-05-12T09:00:00Z", end: "2026-05-12T10:00:00Z", context: "deep" }];
    const DROPPED = [{ task_id: "22222222-2222-4222-8222-222222222222", title: "My task", drop_cost: 5, reason: "capacity", contributing_constraints: [] }];
    const SNAPSHOT = JSON.stringify({ tz: TZ, window: WINDOW, trigger: { kind: "webhook", inviteTitle: "Lunch with Alice" }, isEmpty: false, days: [], dropped: [], warnings: [] });
    const now = new Date("2026-05-18T12:00:00Z");

    async function insertPlan(hash: string, committedAt: string | null, expiresAt: string, withWarnings = true) {
      const body = JSON.stringify({
        schedule: SCHEDULE,
        dropped: DROPPED,
        window: WINDOW,
        weights: {},
        objective: 1,
        account_email: SUBJECT,
        ...(withWarnings ? { warnings: ["Alice's 1:1: attendee_availability_unknown"] } : {}),
      });
      await env.DB.prepare(
        "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, render_snapshot, subject, window_start, window_end, window_tz) VALUES (?, ?, '2026-05-10T00:00:00Z', ?, ?, ?, ?, ?, ?, ?)",
      ).bind(hash, body, expiresAt, committedAt, SNAPSHOT, SUBJECT, WINDOW.start, WINDOW.end, TZ).run();
    }

    async function rawRow(hash: string) {
      return env.DB.prepare("SELECT plan_hash, body, committed_at, render_snapshot FROM proposed_plans WHERE plan_hash = ?")
        .bind(hash).first<{ plan_hash: string; body: string; committed_at: string | null; render_snapshot: string | null }>();
    }

    it("scrubs render_snapshot and body.warnings from a committed plan, keeping the baselines", async () => {
      await insertPlan("h-c", "2026-05-10T01:00:00Z", "2026-05-13T00:00:00Z");
      const r = await runCleanupExpiredPlans(env.DB, now);
      expect(r).toEqual({ deleted: 0, scrubbed: 1 });

      const row = await rawRow("h-c");
      expect(row!.render_snapshot).toBeNull();
      expect(row!.committed_at).toBe("2026-05-10T01:00:00Z");
      const body = JSON.parse(row!.body);
      expect("warnings" in body).toBe(false);
      expect(body.schedule).toEqual(SCHEDULE);
      expect(body.dropped).toEqual(DROPPED);
      expect(body.window).toEqual(WINDOW);
      expect(body.account_email).toBe(SUBJECT);
    });

    it("scrubs a committed plan that has a snapshot but no warnings, leaving the body byte-identical", async () => {
      await insertPlan("h-nw", "2026-05-10T01:00:00Z", "2026-05-13T00:00:00Z", false);
      const before = (await rawRow("h-nw"))!.body;
      const r = await runCleanupExpiredPlans(env.DB, now);
      expect(r.scrubbed).toBe(1);
      const row = await rawRow("h-nw");
      expect(row!.render_snapshot).toBeNull();
      expect(row!.body).toBe(before);
    });

    it("scrubs a committed plan that has warnings but no snapshot", async () => {
      await insertPlan("h-wo", "2026-05-10T01:00:00Z", "2026-05-13T00:00:00Z");
      await env.DB.prepare("UPDATE proposed_plans SET render_snapshot = NULL WHERE plan_hash = 'h-wo'").run();
      const r = await runCleanupExpiredPlans(env.DB, now);
      expect(r.scrubbed).toBe(1);
      const body = JSON.parse((await rawRow("h-wo"))!.body);
      expect("warnings" in body).toBe(false);
      expect(body.schedule).toEqual(SCHEDULE);
    });

    it("leaves a pending, unexpired plan's snapshot and warnings alone", async () => {
      await insertPlan("h-p", null, "2026-05-20T00:00:00Z");
      const r = await runCleanupExpiredPlans(env.DB, now);
      expect(r).toEqual({ deleted: 0, scrubbed: 0 });
      const row = await rawRow("h-p");
      expect(row!.render_snapshot).toBe(SNAPSHOT);
      expect(JSON.parse(row!.body).warnings).toEqual(["Alice's 1:1: attendee_availability_unknown"]);
    });

    it("is idempotent: a second run scrubs nothing", async () => {
      await insertPlan("h-c", "2026-05-10T01:00:00Z", "2026-05-13T00:00:00Z");
      await runCleanupExpiredPlans(env.DB, now);
      const r2 = await runCleanupExpiredPlans(env.DB, now);
      expect(r2).toEqual({ deleted: 0, scrubbed: 0 });
    });

    it("counts deletes and scrubs separately in one run", async () => {
      await insertPlan("h-c", "2026-05-10T01:00:00Z", "2026-05-13T00:00:00Z");
      await insertPlan("h-x", null, "2026-05-13T00:00:00Z");
      const r = await runCleanupExpiredPlans(env.DB, now);
      expect(r).toEqual({ deleted: 1, scrubbed: 1 });
    });

    it("logs plans_cleanup with both counts", async () => {
      await insertPlan("h-c", "2026-05-10T01:00:00Z", "2026-05-13T00:00:00Z");
      const spy = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        await runCleanupExpiredPlans(env.DB, now);
        const call = spy.mock.calls.find((c) => c[0] === "plans_cleanup");
        expect(call?.[1]).toEqual({ deleted: 0, scrubbed: 1 });
      } finally {
        spy.mockRestore();
      }
    });

    it("the committed-plan baselines still read the scrubbed row intact", async () => {
      await insertPlan("h-c", "2026-05-10T01:00:00Z", "2026-05-13T00:00:00Z");
      await runCleanupExpiredPlans(env.DB, now);

      const week = await getCommittedPlanForWeek(env.DB, SUBJECT, WINDOW.start, TZ, TZ);
      expect(week?.plan_hash).toBe("h-c");
      expect(week?.render_snapshot).toBeNull();
      expect(week?.body.schedule).toEqual(SCHEDULE);
      expect(await getCommittedDroppedForWeek(env.DB, SUBJECT, WINDOW.start, TZ, TZ)).toEqual(DROPPED);
      const all = await getCommittedPlansForSubject(env.DB, SUBJECT);
      expect(all.map((p) => p.plan_hash)).toEqual(["h-c"]);
      expect(all[0]!.body.schedule).toEqual(SCHEDULE);
      expect(all[0]!.body.dropped).toEqual(DROPPED);
    });
  });
});
