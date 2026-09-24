import { describe, expect, it } from "vitest";
import { parseEnvNumberWithFloor } from "../src/util/env-parse";

// Pins the shared parse-with-floor helper that resolve-internal.ts's
// parseEnvNumber, booking-decline-sweep.ts's graceMinutes, and
// fanout.ts's fanoutMinChunks all converge on (card G, note (g)). The
// three call sites' own suites (engine-flag.test.ts, fanout.test.ts,
// booking-decline-sweep.test.ts) keep pinning their specific
// default/floor values unchanged; this file pins the shared shape itself,
// including the one real semantic difference between the copies — whether
// the parsed value is floored to a whole number before the floor clamp.
describe("parseEnvNumberWithFloor", () => {
  it("unset falls back to the default", () => {
    expect(parseEnvNumberWithFloor(undefined, 10, 1)).toBe(10);
  });

  it("blank (including whitespace-only) falls back to the default", () => {
    expect(parseEnvNumberWithFloor("", 10, 1)).toBe(10);
    expect(parseEnvNumberWithFloor("   ", 10, 1)).toBe(10);
  });

  it("unparseable falls back to the default", () => {
    expect(parseEnvNumberWithFloor("not-a-number", 10, 1)).toBe(10);
  });

  it("a parseable value below the floor clamps UP, never falls back", () => {
    expect(parseEnvNumberWithFloor("0", 10, 1)).toBe(1);
    expect(parseEnvNumberWithFloor("-5", 10, 1)).toBe(1);
  });

  it("a parseable value at/above the floor is honoured", () => {
    expect(parseEnvNumberWithFloor("48", 24, 1)).toBe(48);
  });

  it("integer=false (default): fractions pass through as-is, above or clamped", () => {
    expect(parseEnvNumberWithFloor("0.5", 20, 0.001)).toBe(0.5);
    expect(parseEnvNumberWithFloor("2500.9", 120_000, 1)).toBe(2500.9);
  });

  it("integer=true: the parsed value is floored to a whole number BEFORE the floor clamp", () => {
    expect(parseEnvNumberWithFloor("12.7", 24, 1, true)).toBe(12);
    // A fractional value that floors to exactly the floor still clamps, not
    // falls back — floor(0.9) = 0, which is below the 1-floor.
    expect(parseEnvNumberWithFloor("0.9", 10, 1, true)).toBe(1);
  });
});
