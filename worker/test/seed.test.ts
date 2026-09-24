import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("seed data", () => {
  it("config_weights row exists with documented defaults", async () => {
    const row = await env.DB.prepare("SELECT body FROM config_weights WHERE owner_subject = '__default__'").first<{ body: string }>();
    expect(row).not.toBeNull();
    const w = JSON.parse(row!.body);
    expect(w).toEqual({
      time_of_day_fit_per_15min: 5,
      churn_per_15min_moved: 10,
      priority_unit: 1,
      base_drop_penalty: 200,
      preferred_day_miss: 40,
      preferred_time_miss_per_15min: 5,
    });
  });

  it("all five contexts seeded", async () => {
    const rows = await env.DB.prepare("SELECT context FROM config_contexts ORDER BY context").all<{ context: string }>();
    expect(rows.results.map((r: { context: string }) => r.context)).toEqual([
      "admin",
      "deep",
      "family",
      "meeting",
      "physical",
    ]);
  });

  it("deep context has 240-min daily cap and 90-min streak cap", async () => {
    const row = await env.DB.prepare("SELECT body FROM config_contexts WHERE context = 'deep'").first<{ body: string }>();
    const c = JSON.parse(row!.body);
    expect(c.max_minutes_per_day).toBe(240);
    expect(c.max_contiguous_minutes).toBe(90);
  });
});
