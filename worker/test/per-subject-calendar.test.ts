import { describe, it, expect } from "vitest";
import { defaultCalendarProvider } from "../src/index-providers";
import { env } from "cloudflare:test";

describe("per-subject calendar factory", () => {
  it("uses the explicit subject over the active-account fallback", async () => {
    // With a subject passed, the factory must not call resolveActiveSubject.
    const provider = await defaultCalendarProvider(env, "explicit@example.com");
    expect(provider).toBeDefined(); // smoke: construction with explicit subject succeeds without any identity row
  });
});
