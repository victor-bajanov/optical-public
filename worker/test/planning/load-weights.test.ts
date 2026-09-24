import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { loadWeights } from "../../src/planning/resolve-internal";

const FULL = {
  time_of_day_fit_per_15min: 5,
  churn_per_15min_moved: 10,
  priority_unit: 1,
  base_drop_penalty: 200,
  preferred_day_miss: 99,
  preferred_time_miss_per_15min: 7,
};
const BARE = {
  time_of_day_fit_per_15min: 5,
  churn_per_15min_moved: 10,
  priority_unit: 1,
  base_drop_penalty: 200,
};

describe("loadWeights", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM config_weights").run();
  });

  it("defaults the new preference weights when the row omits them", async () => {
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify(BARE)).run();
    const w = await loadWeights(env.DB, "__default__");
    expect(w.preferred_day_miss).toBe(40);
    expect(w.preferred_time_miss_per_15min).toBe(5);
  });

  it("respects explicit values in the row over defaults", async () => {
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify(FULL)).run();
    const w = await loadWeights(env.DB, "__default__");
    expect(w.preferred_day_miss).toBe(99);
    expect(w.preferred_time_miss_per_15min).toBe(7);
  });

  it("returns the user's own row when present", async () => {
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify({ ...BARE, base_drop_penalty: 200 })).run();
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES (?, ?)")
      .bind("user@org", JSON.stringify({ ...BARE, base_drop_penalty: 555 })).run();
    const w = await loadWeights(env.DB, "user@org");
    expect(w.base_drop_penalty).toBe(555);
  });

  it("falls back to __default__ when the user has no own row", async () => {
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify({ ...BARE, base_drop_penalty: 777 })).run();
    const w = await loadWeights(env.DB, "nobody@org");
    expect(w.base_drop_penalty).toBe(777);
  });

  it("throws when neither the user row nor the default row exists", async () => {
    await expect(loadWeights(env.DB, "nobody@org")).rejects.toThrow("config_weights row missing");
  });
});
