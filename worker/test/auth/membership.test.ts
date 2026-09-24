/// <reference types="vite/client" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { isMember } from "../../src/auth/membership";
import { upsertUser, deactivateUser } from "../../src/db/users";

beforeEach(async () => { await env.DB.prepare("DELETE FROM users").run(); });

function withEnv(overrides: Record<string, unknown>) {
  return { ...env, ...overrides } as typeof env;
}

describe("isMember", () => {
  it("accepts an exact allow-list email", async () => {
    const e = withEnv({ MEMBERSHIP_ALLOWLIST: "alice@org.com,bob@org.com", OPERATOR_EMAIL: "" });
    expect(await isMember("bob@org.com", e)).toBe(true);
  });

  it("accepts a domain wildcard", async () => {
    const e = withEnv({ MEMBERSHIP_ALLOWLIST: "*@example.com", OPERATOR_EMAIL: "" });
    expect(await isMember("anyone@example.com", e)).toBe(true);
    expect(await isMember("anyone@elsewhere.com", e)).toBe(false);
  });

  it("is case-insensitive on email and domain", async () => {
    const e = withEnv({ MEMBERSHIP_ALLOWLIST: "*@Org.Com", OPERATOR_EMAIL: "" });
    expect(await isMember("PERSON@org.com", e)).toBe(true);
  });

  it("accepts the OPERATOR_EMAIL seed admin regardless of allow-list", async () => {
    const e = withEnv({ MEMBERSHIP_ALLOWLIST: "", OPERATOR_EMAIL: "seed@org.com,other@org.com" });
    expect(await isMember("other@org.com", e)).toBe(true);
  });

  it("accepts an existing active user not on the allow-list", async () => {
    await upsertUser(env.DB, "existing@org.com");
    const e = withEnv({ MEMBERSHIP_ALLOWLIST: "", OPERATOR_EMAIL: "" });
    expect(await isMember("existing@org.com", e)).toBe(true);
  });

  it("rejects a deactivated user not otherwise allowed", async () => {
    await upsertUser(env.DB, "gone@org.com");
    await deactivateUser(env.DB, "gone@org.com");
    const e = withEnv({ MEMBERSHIP_ALLOWLIST: "", OPERATOR_EMAIL: "" });
    expect(await isMember("gone@org.com", e)).toBe(false);
  });

  it("rejects an unknown email when nothing matches", async () => {
    const e = withEnv({ MEMBERSHIP_ALLOWLIST: "alice@org.com", OPERATOR_EMAIL: "seed@org.com" });
    expect(await isMember("intruder@evil.com", e)).toBe(false);
  });
});

