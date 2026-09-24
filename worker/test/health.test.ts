import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

describe("health", () => {
  it("GET / returns 200 with name", async () => {
    const res = await SELF.fetch("https://x/");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ name: "weekly-scheduling-assistant", version: "0.1.0" });
  });
});
