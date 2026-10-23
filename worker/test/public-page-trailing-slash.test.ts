import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

// A pasted or hand-typed public link with one trailing slash used to 404
// (Hono matches strictly). Public HTML pages now 301 to the slashless path;
// the API and every other path stay strict.
const get = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://x${path}`, { redirect: "manual", ...init });

describe("public page trailing slash", () => {
  it.each([
    ["/book/some-slug/", "/book/some-slug"],
    ["/poll/p_123/", "/poll/p_123"],
    ["/poll/p_123/status/", "/poll/p_123/status"],
    ["/confirm/abc123/", "/confirm/abc123"],
    ["/cal-reveal/tok123/", "/cal-reveal/tok123"],
    ["/v1/plans/hash123/accept/", "/v1/plans/hash123/accept"],
  ])("GET %s 301s to %s", async (from, to) => {
    const res = await get(from);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(to);
  });

  it("HEAD redirects too", async () => {
    const res = await get("/book/some-slug/", { method: "HEAD" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/book/some-slug");
  });

  it("preserves the query string exactly", async () => {
    const res = await get("/poll/p_123/?t=a.b-c_d%2Fe&g=x");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/poll/p_123?t=a.b-c_d%2Fe&g=x");
  });

  it("leaves / alone", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
  });

  it.each([
    "/nope/",
    "/book/",
    "/book//",
    "/book/x//",
    "//evil.example/",
    "/book/x/slots/",
    "/poll/p_123/grid/",
    "/cal/tok/busy.ics/",
    "/v1/tasks/",
    "/v1/plans/hash123/",
    "/oauth/authorize/",
    "/admin/dev-ui/",
  ])("does not redirect %s", async (path) => {
    const res = await get(path);
    expect(res.status).not.toBe(301);
    expect(res.headers.get("location")).toBeNull();
  });

  it("unknown path with a slash still 404s", async () => {
    const res = await get("/nope/");
    expect(res.status).toBe(404);
  });

  it("/v1 path with a slash stays strict (auth gate, then 404)", async () => {
    const res = await get("/v1/tasks/");
    expect([401, 404]).toContain(res.status);
  });

  it("POST is not redirected", async () => {
    const res = await get("/book/some-slug/", { method: "POST", body: "{}" });
    expect(res.status).not.toBe(301);
    expect(res.headers.get("location")).toBeNull();
  });
});
