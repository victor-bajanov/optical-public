import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { insertProposedPlan, attachRenderSnapshot, attachPendingRenderSnapshot, getLatestProposedPlanForSubject, getProposedPlan } from "../../src/planning/proposed-plans";

describe("render_snapshot round-trip", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM proposed_plans").run(); });

  it("stores and returns the snapshot for the latest plan", async () => {
    const body = { schedule: [], dropped: [], window: { start: "2026-06-14T14:00:00Z", end: "2026-06-21T14:00:00Z" } };
    await insertProposedPlan(env.DB, "p1", body, "2026-06-10T00:00:00Z", "2099-01-01T00:00:00Z", "op@example.com");
    const snapshot = { tz: "Australia/Sydney", isEmpty: false, days: [], dropped: [], window: body.window, trigger: "monday-cron" };
    await attachRenderSnapshot(env.DB, "p1", snapshot);
    const row = await getLatestProposedPlanForSubject(env.DB, "op@example.com", new Date("2026-06-11T00:00:00Z"));
    expect(row?.render_snapshot).toEqual(snapshot);
  });

  it("returns null render_snapshot when none attached", async () => {
    const body = { schedule: [], dropped: [], window: { start: "2026-06-14T14:00:00Z", end: "2026-06-21T14:00:00Z" } };
    await insertProposedPlan(env.DB, "p2", body, "2026-06-10T00:00:00Z", "2099-01-01T00:00:00Z", "op@example.com");
    const row = await getLatestProposedPlanForSubject(env.DB, "op@example.com", new Date("2026-06-11T00:00:00Z"));
    expect(row?.render_snapshot).toBeNull();
  });

  describe("attachPendingRenderSnapshot (O9.2)", () => {
    const body = { schedule: [], dropped: [], window: { start: "2026-06-14T14:00:00Z", end: "2026-06-21T14:00:00Z" } };
    const snap = { tz: "Australia/Sydney", isEmpty: false, days: [], dropped: [], window: body.window, trigger: "api" };

    it("attaches to the owner's pending plan", async () => {
      await insertProposedPlan(env.DB, "p3", body, "2026-06-10T00:00:00Z", "2099-01-01T00:00:00Z", "op@example.com");
      await attachPendingRenderSnapshot(env.DB, "p3", "op@example.com", snap);
      expect((await getProposedPlan(env.DB, "p3"))?.render_snapshot).toEqual(snap);
    });

    it("never touches another subject's plan", async () => {
      await insertProposedPlan(env.DB, "p4", body, "2026-06-10T00:00:00Z", "2099-01-01T00:00:00Z", "other@example.com");
      await attachPendingRenderSnapshot(env.DB, "p4", "op@example.com", snap);
      expect((await getProposedPlan(env.DB, "p4"))?.render_snapshot).toBeNull();
    });

    it("never rewrites a committed plan's snapshot", async () => {
      await insertProposedPlan(env.DB, "p5", body, "2026-06-10T00:00:00Z", "2099-01-01T00:00:00Z", "op@example.com");
      const kept = { ...snap, trigger: "monday-cron" };
      await attachRenderSnapshot(env.DB, "p5", kept);
      await env.DB.prepare("UPDATE proposed_plans SET committed_at = '2026-06-11T00:00:00Z' WHERE plan_hash = 'p5'").run();
      await attachPendingRenderSnapshot(env.DB, "p5", "op@example.com", snap);
      expect((await getProposedPlan(env.DB, "p5"))?.render_snapshot).toEqual(kept);
    });
  });
});
