import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { loadBusinessHours } from "../../src/db/business-hours";

const DEFAULT_BH = { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" };

describe("loadBusinessHours", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM config_business_hours").run();
  });

  it("returns null when neither the user row nor the default row is present", async () => {
    const r = await loadBusinessHours(env.DB, "user@org");
    expect(r).toBeNull();
  });

  it("returns the __default__ row when the user has no own row", async () => {
    await env.DB.prepare("INSERT INTO config_business_hours (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify(DEFAULT_BH)).run();
    const r = await loadBusinessHours(env.DB, "user@org");
    expect(r).toEqual(DEFAULT_BH);
  });

  it("returns the user's own row over the default", async () => {
    await env.DB.prepare("INSERT INTO config_business_hours (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify(DEFAULT_BH)).run();
    await env.DB.prepare("INSERT INTO config_business_hours (owner_subject, body) VALUES (?, ?)")
      .bind("user@org", JSON.stringify({ days: ["mon"], start: "10:00", end: "16:00" })).run();
    const r = await loadBusinessHours(env.DB, "user@org");
    expect(r?.start).toBe("10:00");
    expect(r?.end).toBe("16:00");
    expect(r?.days).toEqual(["mon"]);
  });
});
