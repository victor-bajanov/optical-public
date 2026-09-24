// worker/test/fixtures/owners.test.ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { seedUsers } from "./owners";

describe("seedUsers(n)", () => {
  it("creates n distinct bearer/subject pairs", async () => {
    const users = await seedUsers(3);
    expect(users).toHaveLength(3);
    expect(new Set(users.map((u) => u.subject)).size).toBe(3);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_tokens").first<{ n: number }>();
    expect(rows?.n).toBe(3);
  });
});
