import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  insertProposedPlan,
  getLatestProposedPlanForSubjectCovering,
} from "../../src/planning/proposed-plans";

const SUBJ = "op@example.com";
const NOW = new Date("2026-06-02T00:00:00Z");
const FAR = "2099-01-01T00:00:00Z";
const EVENT = new Date("2026-06-01T23:00:00Z");

function planBody(start: string, end: string) {
  return { schedule: [], dropped: [], window: { start, end } };
}

describe("getLatestProposedPlanForSubjectCovering", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM proposed_plans").run(); });

  it("returns the plan whose window covers the instant, not the globally-newest", async () => {
    // An unrelated, MORE-RECENT plan for a different week...
    await insertProposedPlan(env.DB, "other", planBody("2027-03-07T13:00:00.000Z", "2027-03-14T13:00:00.000Z"),
      "2026-06-01T10:00:00Z", FAR, SUBJ);
    // ...and the plan for the week containing the instant, created earlier.
    await insertProposedPlan(env.DB, "target", planBody("2026-05-31T14:00:00.000Z", "2026-06-07T14:00:00.000Z"),
      "2026-06-01T09:00:00Z", FAR, SUBJ);

    const row = await getLatestProposedPlanForSubjectCovering(env.DB, SUBJ, NOW, EVENT);
    expect(row?.plan_hash).toBe("target");
  });

  it("returns the newest covering plan when several cover the instant", async () => {
    await insertProposedPlan(env.DB, "older", planBody("2026-05-31T14:00:00.000Z", "2026-06-07T14:00:00.000Z"),
      "2026-06-01T08:00:00Z", FAR, SUBJ);
    await insertProposedPlan(env.DB, "newer", planBody("2026-06-01T00:00", "2026-06-08T00:00"),
      "2026-06-01T09:30:00Z", FAR, SUBJ);

    const row = await getLatestProposedPlanForSubjectCovering(env.DB, SUBJ, NOW, EVENT);
    expect(row?.plan_hash).toBe("newer");
  });

  it("returns null when no plan's window covers the instant", async () => {
    await insertProposedPlan(env.DB, "future", planBody("2027-03-07T13:00:00.000Z", "2027-03-14T13:00:00.000Z"),
      "2026-06-01T09:00:00Z", FAR, SUBJ);
    const row = await getLatestProposedPlanForSubjectCovering(env.DB, SUBJ, NOW, EVENT);
    expect(row).toBeNull();
  });
});
