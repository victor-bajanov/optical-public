import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { upsertUser, getUser, getHomeTz } from "../../src/db/users";

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
    // Direct SQL write is intentional: no application-layer setter exists yet.
    // This tests the read path (getHomeTz) in isolation until a write path lands.
    await env.DB.prepare("UPDATE users SET home_tz = ? WHERE subject = ?").bind("America/New_York", "user@org").run();
    const tz = await getHomeTz(env.DB, "user@org", "Australia/Sydney");
    expect(tz).toBe("America/New_York");
  });

  it("exposes home_tz on the UserRow from getUser", async () => {
    await upsertUser(env.DB, "user@org");
    // Direct SQL write is intentional: no application-layer setter exists yet.
    // This tests that getUser selects home_tz until a write path lands.
    await env.DB.prepare("UPDATE users SET home_tz = ? WHERE subject = ?").bind("Europe/London", "user@org").run();
    const row = await getUser(env.DB, "user@org");
    expect(row?.home_tz).toBe("Europe/London");
  });
});
