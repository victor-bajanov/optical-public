import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { ownerNotificationEmail } from "../../src/db/owner-email";

async function seed(subject: string, loginEmail: string | null): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at, provider, provider_subject, login_email) VALUES (?,?,?,?,?,?,?)",
  ).bind(subject, "ct", "s", "2026-01-01T00:00:00.000Z", "google", `sub-${subject}`, loginEmail).run();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM identity_tokens").run();
});

describe("ownerNotificationEmail", () => {
  it("returns the latest verified login email, not the (possibly reassigned) subject", async () => {
    await seed("alice@example.com", "alice.smith@example.org");
    expect(await ownerNotificationEmail(env.DB, "alice@example.com")).toBe("alice.smith@example.org");
  });

  it("falls back to the subject when login_email is NULL (not signed in since 0046)", async () => {
    await seed("legacy@example.com", null);
    expect(await ownerNotificationEmail(env.DB, "legacy@example.com")).toBe("legacy@example.com");
  });

  it("falls back to the subject when login_email is empty", async () => {
    await seed("blank@example.com", "");
    expect(await ownerNotificationEmail(env.DB, "blank@example.com")).toBe("blank@example.com");
  });

  it("falls back to the subject when there is no identity_tokens row", async () => {
    expect(await ownerNotificationEmail(env.DB, "ghost@example.com")).toBe("ghost@example.com");
  });

  it("reads only the subject's own row", async () => {
    await seed("bob@example.com", "bob.new@example.org");
    await seed("carol@example.com", "carol.new@example.org");
    expect(await ownerNotificationEmail(env.DB, "carol@example.com")).toBe("carol.new@example.org");
  });
});
