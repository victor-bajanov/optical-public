import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { upsertUser, getUser, getDoneColorId } from "../../src/db/users";

describe("getDoneColorId", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM users").run();
  });

  it("returns env default when the user has no done_color_id", async () => {
    await upsertUser(env.DB, "user@org");
    const color = await getDoneColorId(env.DB, "user@org", "11");
    expect(color).toBe("11");
  });

  it("returns env default when the user does not exist", async () => {
    const color = await getDoneColorId(env.DB, "ghost@org", "11");
    expect(color).toBe("11");
  });

  it("returns the user's done_color_id when set", async () => {
    await upsertUser(env.DB, "user@org");
    // Direct SQL write is intentional: no application-layer setter exists yet.
    // This tests the read path (getDoneColorId) in isolation until a write path lands.
    await env.DB.prepare("UPDATE users SET done_color_id = ? WHERE subject = ?").bind("3", "user@org").run();
    const color = await getDoneColorId(env.DB, "user@org", "11");
    expect(color).toBe("3");
  });

  it("exposes done_color_id on the UserRow from getUser", async () => {
    await upsertUser(env.DB, "user@org");
    // Direct SQL write is intentional: no application-layer setter exists yet.
    // This tests that getUser selects done_color_id until a write path lands.
    await env.DB.prepare("UPDATE users SET done_color_id = ? WHERE subject = ?").bind("9", "user@org").run();
    const row = await getUser(env.DB, "user@org");
    expect(row?.done_color_id).toBe("9");
  });

  it("throws when the resolved value equals the scheduler create color '5'", async () => {
    // Env default misconfigured to "5" — must throw.
    await upsertUser(env.DB, "user@org");
    await expect(getDoneColorId(env.DB, "user@org", "5")).rejects.toThrow();
  });

  it("throws when the user's per-user done_color_id is '5'", async () => {
    await upsertUser(env.DB, "user@org");
    await env.DB.prepare("UPDATE users SET done_color_id = ? WHERE subject = ?").bind("5", "user@org").run();
    await expect(getDoneColorId(env.DB, "user@org", "11")).rejects.toThrow();
  });
});
