import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

// T3 (#2): 0047 adds proposed_plans.commit_claim / commit_claimed_at, the
// lease commitPlan takes before its first calendar read so two concurrent
// commits of one plan can't both write the calendar (planning/commit.ts).
describe("0047 proposed_plans commit claim migration", () => {
  it("adds nullable TEXT commit_claim and commit_claimed_at with no default", async () => {
    const cols = await env.DB.prepare("PRAGMA table_info(proposed_plans)")
      .all<{ name: string; type: string; notnull: number; dflt_value: unknown }>();
    for (const name of ["commit_claim", "commit_claimed_at"]) {
      expect(cols.results.find((c) => c.name === name)).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null });
    }
  });

  it("existing-style inserts leave both NULL", async () => {
    await env.DB.prepare("DELETE FROM proposed_plans").run();
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('legacy', '{}', '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', NULL, 'o@org')",
    ).run();
    const r = await env.DB.prepare("SELECT commit_claim, commit_claimed_at FROM proposed_plans WHERE plan_hash = 'legacy'")
      .first<{ commit_claim: string | null; commit_claimed_at: string | null }>();
    expect(r).toEqual({ commit_claim: null, commit_claimed_at: null });
  });
});
