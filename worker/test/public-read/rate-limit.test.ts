import { describe, it, expect, vi, afterEach } from "vitest";
import {
  checkPublicReadIpLimit,
  publicReadTargetAllowed,
  rateLimitedResponse,
  ipLimitKey,
  PublicReadRateLimitedError,
  PUBLIC_READ_RETRY_AFTER_SECONDS,
  type RateLimitBinding,
} from "../../src/public-read/rate-limit";
import type { Env } from "../../src/env";

/** A limiter that allows `allow` calls per key and records every key it saw. */
function fakeLimiter(allow: number) {
  const seen: string[] = [];
  const counts = new Map<string, number>();
  const binding: RateLimitBinding = {
    async limit({ key }) {
      seen.push(key);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= allow };
    },
  };
  return { binding, seen };
}

function envWith(ip: RateLimitBinding | undefined, target: RateLimitBinding | undefined): Env {
  return { PUBLIC_READ_IP_LIMITER: ip, PUBLIC_READ_TARGET_LIMITER: target } as unknown as Env;
}

afterEach(() => vi.restoreAllMocks());

describe("rateLimitedResponse", () => {
  it("is 429 rate_limited with Retry-After", async () => {
    const res = rateLimitedResponse();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe(String(PUBLIC_READ_RETRY_AFTER_SECONDS));
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("PublicReadRateLimitedError is an Error the routes can map to it", () => {
    expect(new PublicReadRateLimitedError("book:x")).toBeInstanceOf(Error);
  });
});

describe("checkPublicReadIpLimit", () => {
  it("allows under the limit, keyed per IP", async () => {
    const ip = fakeLimiter(5);
    expect(await checkPublicReadIpLimit(envWith(ip.binding, undefined), "1.2.3.4")).toBeNull();
    expect(ip.seen).toEqual(["ip:1.2.3.4"]);
  });

  it("over the limit: the 429", async () => {
    const res = await checkPublicReadIpLimit(envWith(fakeLimiter(0).binding, undefined), "1.2.3.4");
    expect(res?.status).toBe(429);
    expect(await res?.json()).toEqual({ error: "rate_limited" });
  });

  it("no client IP (not fronted by Cloudflare): skipped", async () => {
    const ip = fakeLimiter(0);
    expect(await checkPublicReadIpLimit(envWith(ip.binding, undefined), "")).toBeNull();
    expect(ip.seen).toEqual([]);
  });

  it("two addresses in one IPv6 /64 share a budget", async () => {
    const ip = fakeLimiter(1);
    const env = envWith(ip.binding, undefined);
    expect(await checkPublicReadIpLimit(env, "2001:db8:0:1::1")).toBeNull();
    expect((await checkPublicReadIpLimit(env, "2001:db8:0:1:ffff:ffff:ffff:ffff"))?.status).toBe(429);
    expect(await checkPublicReadIpLimit(env, "2001:db8:0:2::1")).toBeNull();
  });

  it("an unbound limiter fails open with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await checkPublicReadIpLimit(envWith(undefined, undefined), "1.2.3.4")).toBeNull();
    expect(warn).toHaveBeenCalledWith("public_read_limiter_unbound", { binding: "PUBLIC_READ_IP_LIMITER" });
  });

  it("a limiter that throws fails open with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken: RateLimitBinding = { limit: async () => { throw new Error("rl down"); } };
    expect(await checkPublicReadIpLimit(envWith(broken, undefined), "1.2.3.4")).toBeNull();
    expect(warn).toHaveBeenCalledWith("public_read_limiter_error", expect.objectContaining({ binding: "PUBLIC_READ_IP_LIMITER" }));
  });
});

describe("publicReadTargetAllowed", () => {
  it("counts per target", async () => {
    const target = fakeLimiter(1);
    const env = envWith(undefined, target.binding);
    expect(await publicReadTargetAllowed(env, "poll:p1")).toBe(true);
    expect(await publicReadTargetAllowed(env, "poll:p1")).toBe(false);
    expect(await publicReadTargetAllowed(env, "poll:p2")).toBe(true);
    expect(target.seen).toEqual(["poll:p1", "poll:p1", "poll:p2"]);
  });

  it("unbound or failing: allowed, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await publicReadTargetAllowed(envWith(undefined, undefined), "book:a")).toBe(true);
    expect(warn).toHaveBeenCalledWith("public_read_limiter_unbound", { binding: "PUBLIC_READ_TARGET_LIMITER" });
    const broken: RateLimitBinding = { limit: async () => { throw new Error("rl down"); } };
    expect(await publicReadTargetAllowed(envWith(undefined, broken), "book:a")).toBe(true);
  });
});

describe("ipLimitKey", () => {
  it.each([
    ["1.2.3.4", "ip:1.2.3.4"],
    ["2001:DB8:0:1::1", "ip:2001:db8:0:1::/64"],
    ["2001:db8:0:1:ffff:ffff:ffff:ffff", "ip:2001:db8:0:1::/64"],
    ["2001:db8:0:2::1", "ip:2001:db8:0:2::/64"],
    ["2001:db8::1", "ip:2001:db8:0:0::/64"],
    ["::1", "ip:0:0:0:0::/64"],
    ["2001:0db8:0000:0001::", "ip:2001:db8:0:1::/64"],
    ["not-an-ip", "ip:not-an-ip"],
    ["1:2:3", "ip:1:2:3"],
  ])("%s -> %s", (raw, want) => {
    expect(ipLimitKey(raw)).toBe(want);
  });
});
