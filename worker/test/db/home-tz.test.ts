import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { upsertUser, getUser, getHomeTz, setHomeTz, clearHomeTz, canonicalIanaZone } from "../../src/db/users";

describe("getHomeTz", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM users").run();
  });

  it("returns env.SCHEDULER_TZ when the user has no home_tz", async () => {
    await upsertUser(env.DB, "user@org");
    const tz = await getHomeTz(env.DB, "user@org", "Australia/Sydney");
    expect(tz).toBe("Australia/Sydney");
  });

  it("returns env.SCHEDULER_TZ when the user does not exist", async () => {
    const tz = await getHomeTz(env.DB, "ghost@org", "Australia/Sydney");
    expect(tz).toBe("Australia/Sydney");
  });

  it("returns the user's home_tz when set", async () => {
    await upsertUser(env.DB, "user@org");
    // Direct SQL write is intentional: tests the read path (getHomeTz) in
    // isolation from setHomeTz (covered below).
    await env.DB.prepare("UPDATE users SET home_tz = ? WHERE subject = ?").bind("America/New_York", "user@org").run();
    const tz = await getHomeTz(env.DB, "user@org", "Australia/Sydney");
    expect(tz).toBe("America/New_York");
  });

  it("exposes home_tz on the UserRow from getUser", async () => {
    await upsertUser(env.DB, "user@org");
    // Direct SQL write is intentional: tests that getUser selects home_tz,
    // independently of setHomeTz.
    await env.DB.prepare("UPDATE users SET home_tz = ? WHERE subject = ?").bind("Europe/London", "user@org").run();
    const row = await getUser(env.DB, "user@org");
    expect(row?.home_tz).toBe("Europe/London");
  });
});

describe("setHomeTz / clearHomeTz", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM users").run();
  });

  it("stores the zone so getHomeTz returns it", async () => {
    await upsertUser(env.DB, "user@org");
    const stored = await setHomeTz(env.DB, "user@org", "Europe/London");
    expect(stored).toBe("Europe/London");
    expect(await getHomeTz(env.DB, "user@org", "Australia/Sydney")).toBe("Europe/London");
  });

  it("canonicalises the zone name before storing it", async () => {
    await upsertUser(env.DB, "user@org");
    const stored = await setHomeTz(env.DB, "user@org", "europe/london");
    expect(stored).toBe("Europe/London");
    const row = await getUser(env.DB, "user@org");
    expect(row?.home_tz).toBe("Europe/London");
  });

  it("never creates a users row: returns null and writes nothing when the subject has none", async () => {
    // A config write must not create a row (that would grant membership and
    // add the subject to the active fan-out).
    expect(await setHomeTz(env.DB, "fresh@org", "America/New_York")).toBeNull();
    expect(await getUser(env.DB, "fresh@org")).toBeNull();
  });

  it("throws on an invalid zone rather than storing it", async () => {
    await upsertUser(env.DB, "user@org");
    await expect(setHomeTz(env.DB, "user@org", "Not/AZone")).rejects.toThrow();
    const row = await getUser(env.DB, "user@org");
    expect(row?.home_tz).toBeNull();
  });

  it("clearHomeTz sets home_tz back to NULL so the instance default applies", async () => {
    await upsertUser(env.DB, "user@org");
    await setHomeTz(env.DB, "user@org", "Europe/London");
    await clearHomeTz(env.DB, "user@org");
    const row = await getUser(env.DB, "user@org");
    expect(row?.home_tz).toBeNull();
    expect(await getHomeTz(env.DB, "user@org", "Australia/Sydney")).toBe("Australia/Sydney");
  });

  it("is owner-scoped: setting one subject's zone leaves another's untouched", async () => {
    await upsertUser(env.DB, "a@org");
    await upsertUser(env.DB, "b@org");
    await setHomeTz(env.DB, "a@org", "Europe/London");
    expect((await getUser(env.DB, "b@org"))?.home_tz).toBeNull();
    await setHomeTz(env.DB, "b@org", "Asia/Tokyo");
    await clearHomeTz(env.DB, "a@org");
    expect((await getUser(env.DB, "b@org"))?.home_tz).toBe("Asia/Tokyo");
  });
});

describe("canonicalIanaZone", () => {
  it("returns the canonical spelling", () => {
    expect(canonicalIanaZone("europe/london")).toBe("Europe/London");
    expect(canonicalIanaZone("Australia/Sydney")).toBe("Australia/Sydney");
  });
});
