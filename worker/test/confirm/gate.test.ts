import { describe, it, expect } from "vitest";
import { isAgentConfirmClient } from "../../src/confirm/gate";

// O9.1 gating: AGENT_CONFIRM_CLIENT_IDS is a comma-separated list of OAuth
// client ids whose consequential actions are deferred for email confirmation.
// "*" matches every OAuth client; unset or empty gates nobody.
const env = (v: string | undefined) => ({ AGENT_CONFIRM_CLIENT_IDS: v });

describe("isAgentConfirmClient", () => {
  it("unset gates nobody", () => {
    expect(isAgentConfirmClient(env(undefined), "c1")).toBe(false);
  });

  it("empty or whitespace gates nobody", () => {
    expect(isAgentConfirmClient(env(""), "c1")).toBe(false);
    expect(isAgentConfirmClient(env("  ,  "), "c1")).toBe(false);
  });

  it('"*" gates every OAuth client', () => {
    expect(isAgentConfirmClient(env("*"), "c1")).toBe(true);
    expect(isAgentConfirmClient(env("*"), "anything-else")).toBe(true);
    expect(isAgentConfirmClient(env(" * "), "c1")).toBe(true);
  });

  it('"*" does not gate a request with no OAuth client (capability links, cron)', () => {
    expect(isAgentConfirmClient(env("*"), undefined)).toBe(false);
    expect(isAgentConfirmClient(env("*"), "")).toBe(false);
  });

  it("a csv gates exactly the listed ids, trimmed, case-sensitive", () => {
    const e = env("c1, c2 ,c3");
    expect(isAgentConfirmClient(e, "c1")).toBe(true);
    expect(isAgentConfirmClient(e, "c2")).toBe(true);
    expect(isAgentConfirmClient(e, "c3")).toBe(true);
    expect(isAgentConfirmClient(e, "c4")).toBe(false);
    expect(isAgentConfirmClient(e, "C1")).toBe(false);
    expect(isAgentConfirmClient(e, undefined)).toBe(false);
  });

  it("a csv containing * still matches any client", () => {
    expect(isAgentConfirmClient(env("c1,*"), "zzz")).toBe(true);
  });
});
