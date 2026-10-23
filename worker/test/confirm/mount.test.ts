import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

// O9.1: the confirm routes are live on the deployed worker's root app (outside
// /v1 and the OpenAPI spec), on every deployment: a link emailed while an env
// had AGENT_CONFIRM_CLIENT_IDS set stays confirmable after it's narrowed.
describe("confirm routes are mounted on the root app", () => {
  it("GET /confirm/{id} with a bad token answers the invalid-link page", async () => {
    const res = await SELF.fetch("https://x/confirm/abc?t=bad");
    expect(res.status).toBe(400);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(await res.text()).toMatch(/invalid or has expired/i);
  });

  it("POST /confirm/{id} with Authorization is refused 403", async () => {
    const res = await SELF.fetch("https://x/confirm/abc", {
      method: "POST",
      headers: { Authorization: "Bearer x", "content-type": "application/x-www-form-urlencoded" },
      body: "t=bad",
    });
    expect(res.status).toBe(403);
  });
});
