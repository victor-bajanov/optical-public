/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

// Regression guard for the NaN-parse bug class: a stringly-typed numeric
// Worker var read with a bare `Number(env.X ?? "default")` yields NaN when the
// var is SET to a garbage string, and every comparison against NaN silently
// answers false instead of falling back to the default. Found live in four
// `MEETING_MIN_NOTICE_MINUTES` sites (booking availability + three poll
// surfaces), where a misconfigured deployment would silently withdraw every
// bookable-over slot, and in `SOLVER_TIMEOUT_MS`, where the `|| default`
// rescue also swallowed an explicit "0" instead of clamping to a floor.
//
// House posture is util/env-parse.ts's parseEnvNumberWithFloor (or a shared
// reader like meetings/config.ts that wraps the same fallback semantics) —
// never a bare Number() on env. This scan pins every current site and any
// future one that reintroduces the idiom for these vars.
const sources = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Any direct `Number(env.SOMEVAR ...)` over an env member. Comments are
// stripped first so prose describing the old idiom can't false-positive.
const BARE_NUMBER_ON_ENV = /\bNumber\s*\(\s*env\.\w+/g;

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("stringly-typed numeric env vars", () => {
  it("no worker/src site parses an env var with a bare Number(env.X)", () => {
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      for (const m of stripComments(text).matchAll(BARE_NUMBER_ON_ENV)) {
        offenders.push(`${file}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
