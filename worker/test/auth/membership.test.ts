/// <reference types="vite/client" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { isMember, isActiveMember, csv } from "../../src/auth/membership";
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

// O5 (hosted trial, G5): when an allow-list is configured it is the whole
// story — removing someone from it locks them out at their next sign-in,
// even though they still have an active `users` row. The existing-active-user
// branch survives only on a deployment with no allow-list at all.
describe("isMember — a configured allow-list is authoritative (O5)", () => {
  it("rejects an active user who is not on a non-empty allow-list", async () => {
    await upsertUser(env.DB, "delisted@org.com");
    const e = withEnv({ MEMBERSHIP_ALLOWLIST: "alice@org.com", OPERATOR_EMAIL: "" });
    expect(await isMember("delisted@org.com", e)).toBe(false);
  });

  it("rejects an active user outside a wildcard allow-list", async () => {
    await upsertUser(env.DB, "someone@elsewhere.com");
    const e = withEnv({ MEMBERSHIP_ALLOWLIST: "*@org.com", OPERATOR_EMAIL: "" });
    expect(await isMember("someone@elsewhere.com", e)).toBe(false);
  });

  it("still admits an active user on the allow-list", async () => {
    await upsertUser(env.DB, "alice@org.com");
    const e = withEnv({ MEMBERSHIP_ALLOWLIST: "alice@org.com", OPERATOR_EMAIL: "" });
    expect(await isMember("alice@org.com", e)).toBe(true);
  });

  it("admits an OPERATOR_EMAIL identity that is not on the allow-list", async () => {
    const e = withEnv({ MEMBERSHIP_ALLOWLIST: "alice@org.com", OPERATOR_EMAIL: "seed@other.com" });
    expect(await isMember("seed@other.com", e)).toBe(true);
  });

  it("admits an active OPERATOR_EMAIL identity that is not on the allow-list", async () => {
    await upsertUser(env.DB, "seed@other.com", "admin");
    const e = withEnv({ MEMBERSHIP_ALLOWLIST: "alice@org.com", OPERATOR_EMAIL: "seed@other.com" });
    expect(await isMember("seed@other.com", e)).toBe(true);
  });

  it("treats a whitespace/comma-only allow-list as unset (existing user still admitted)", async () => {
    await upsertUser(env.DB, "existing@org.com");
    const e = withEnv({ MEMBERSHIP_ALLOWLIST: " , ", OPERATOR_EMAIL: "" });
    expect(await isMember("existing@org.com", e)).toBe(true);
  });

  it("keeps the existing-active-user branch when no allow-list is set (unset var)", async () => {
    await upsertUser(env.DB, "existing@org.com");
    const e = withEnv({ MEMBERSHIP_ALLOWLIST: undefined, OPERATOR_EMAIL: "" });
    expect(await isMember("existing@org.com", e)).toBe(true);
  });

  // The callback passes `subject` — the first-sign-in email, kept for life
  // by the provider-subject anchor — so a renamed invitee is matched on
  // their ORIGINAL address; listing only the new one does not admit them.
  it("matches the stable subject, not a later renamed address", async () => {
    await upsertUser(env.DB, "original@org.com");
    const e = withEnv({ MEMBERSHIP_ALLOWLIST: "renamed@org.com", OPERATOR_EMAIL: "" });
    expect(await isMember("original@org.com", e)).toBe(false);
    const kept = withEnv({ MEMBERSHIP_ALLOWLIST: "original@org.com", OPERATOR_EMAIL: "" });
    expect(await isMember("original@org.com", kept)).toBe(true);
  });
});

// Card C (decision C, O14b #3): every background or public path that acts
// FOR a subject asks isActiveMember first. With an allow-list configured it
// is exactly isMember (so a delisted-but-not-offboarded user gets nothing
// done on their behalf); with none it is unconditionally true — prod parity,
// NOT isMember's existing-active-users-row branch, so a deactivated prod row
// keeps whatever behaviour it had before this card.
describe("isActiveMember (delisted-user skip, card C)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is true for a listed subject and logs nothing", async () => {
    const info = vi.spyOn(console, "info");
    const e = withEnv({ MEMBERSHIP_ALLOWLIST: "alice@org.com", OPERATOR_EMAIL: "" });
    expect(await isActiveMember(e, "alice@org.com", "monday_resolve")).toBe(true);
    expect(info).not.toHaveBeenCalledWith("delisted_skip", expect.anything());
  });

  it("is false for a delisted subject (active users row, off the allow-list) and logs delisted_skip {path} without PII", async () => {
    await upsertUser(env.DB, "delisted@org.com");
    const info = vi.spyOn(console, "info");
    const e = withEnv({ MEMBERSHIP_ALLOWLIST: "alice@org.com", OPERATOR_EMAIL: "" });
    expect(await isActiveMember(e, "delisted@org.com", "poll_sweep")).toBe(false);
    expect(info).toHaveBeenCalledWith("delisted_skip", { path: "poll_sweep" });
    expect(JSON.stringify(info.mock.calls)).not.toContain("delisted@org.com");
  });

  it("is true for an OPERATOR_EMAIL identity off the allow-list", async () => {
    const e = withEnv({ MEMBERSHIP_ALLOWLIST: "alice@org.com", OPERATOR_EMAIL: "seed@other.com" });
    expect(await isActiveMember(e, "seed@other.com", "booking_page")).toBe(true);
  });

  it("is true with no allow-list, even for a deactivated or unknown subject (prod parity)", async () => {
    await upsertUser(env.DB, "gone@org.com");
    await deactivateUser(env.DB, "gone@org.com");
    const info = vi.spyOn(console, "info");
    for (const list of [undefined, "", " , "]) {
      const e = withEnv({ MEMBERSHIP_ALLOWLIST: list, OPERATOR_EMAIL: "" });
      expect(await isActiveMember(e, "gone@org.com", "monday_resolve")).toBe(true);
      expect(await isActiveMember(e, "never-seen@org.com", "monday_resolve")).toBe(true);
    }
    expect(info).not.toHaveBeenCalledWith("delisted_skip", expect.anything());
  });
});

// Reads one `KEY = "value"` var out of a named section of the real
// wrangler.toml, or undefined when the section does not set it.
const tomlFiles = import.meta.glob("../../wrangler.toml", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function tomlVar(sectionHeader: string, key: string): string | undefined {
  const toml = Object.values(tomlFiles)[0];
  if (toml === undefined) throw new Error("wrangler.toml not found via import.meta.glob");
  const header = new RegExp(`^${sectionHeader.replace(/[.[\]]/g, "\\$&")}[ \\t]*$`, "m");
  const headerIdx = toml.search(header);
  if (headerIdx === -1) throw new Error(`section ${sectionHeader} not found in wrangler.toml`);
  const body = toml.slice(headerIdx + sectionHeader.length);
  const nextSection = body.search(/^\[/m);
  const section = nextSection === -1 ? body : body.slice(0, nextSection);
  const m = section.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"));
  return m ? m[1]! : undefined;
}

// O5 parity pins: run the real `isMember` against each deployment's real toml
// values, so tightening the gate can't silently lock out anyone those
// deployments admit today. Prod sets no allow-list, so the existing-user
// branch still governs there; adding one later fails the first test, which is
// the cue to confirm every active prod `users` row is covered before deploying.
describe("O5 parity with the deployed wrangler.toml vars", () => {
  const envFor = (section: string) =>
    withEnv({
      MEMBERSHIP_ALLOWLIST: tomlVar(section, "MEMBERSHIP_ALLOWLIST") ?? "",
      OPERATOR_EMAIL: tomlVar(section, "OPERATOR_EMAIL") ?? "",
    });

  it("prod [vars] sets no allow-list, so an existing active user is still admitted", async () => {
    expect(csv(tomlVar("[vars]", "MEMBERSHIP_ALLOWLIST"))).toEqual([]);
    await upsertUser(env.DB, "long-standing@anywhere.example");
    expect(await isMember("long-standing@anywhere.example", envFor("[vars]"))).toBe(true);
  });

  it.each(["[vars]", "[env.dev.vars]"])(
    "%s admits every OPERATOR_EMAIL identity with no users rows",
    async (section) => {
      const operators = csv(tomlVar(section, "OPERATOR_EMAIL"));
      expect(operators.length).toBeGreaterThan(0);
      for (const op of operators) expect(await isMember(op, envFor(section)), op).toBe(true);
    },
  );

  // Dev's real sign-ins: the operator's org address (via the wildcard) and
  // the smoke runner's Google a/b/c letters. The c letter is admitted only by
  // OPERATOR_EMAIL, not the allow-list — exactly the case O5 must keep.
  it.each([
    "operator@example.com",
    "operator.alt@example.com",
    "tester1@example.com",
    "tester2@example.com",
    // Decision H: the multi-user smoke's A identity, active on dev.
    "tester3@example.com",
  ])("[env.dev.vars] still admits the real dev account %s", async (email) => {
    expect(await isMember(email, envFor("[env.dev.vars]"))).toBe(true);
  });

  it("[env.dev.vars] refuses an active dev user outside the allow-list", async () => {
    expect(csv(tomlVar("[env.dev.vars]", "MEMBERSHIP_ALLOWLIST")).length).toBeGreaterThan(0);
    await upsertUser(env.DB, "stray@unlisted.example");
    expect(await isMember("stray@unlisted.example", envFor("[env.dev.vars]"))).toBe(false);
  });
});

