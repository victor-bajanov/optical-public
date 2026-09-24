import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("device flow removed", () => {
  it("returns 404 for /oauth/device", async () => {
    const res = await SELF.fetch("https://x/oauth/device", { redirect: "manual" });
    expect(res.status).toBe(404);
  });
  it("rejects the device_code grant", async () => {
    const res = await SELF.fetch("https://x/oauth/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "x", client_id: "y" }),
    });
    expect(res.status).toBe(400);
  });
});
