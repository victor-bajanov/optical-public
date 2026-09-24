/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

// Regression guard for a bundling-only failure class that vitest can never
// hit at runtime: esbuild can only bundle a dynamic `import(...)` whose
// specifier is a STRING LITERAL. A variable specifier (e.g.
// `import(POLL_BOOKING_MODULE_PATH)`) survives bundling verbatim and then
// rejects in deployed workerd — the single-file bundle has no such module —
// while resolving fine under vitest's unbundled vite transform, so every
// test stays green as the deployed route 500s. Found live: resolveMeetingPoll
// {action:"book"} had never worked in a deployed environment because
// pollBookingEngine() imported via a const path.
//
// import.meta.glob with `query: "?raw"` inlines every source file as a
// string at transform time, so this runs fine inside the workers pool (no
// node:fs needed).
const sources = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

// Matches `import(` used as a call (dynamic import), capturing what follows.
// Comments are stripped first so prose like "for this import (orchestrator-
// authorized, ...)" can't false-positive. Type-only usages like
// `typeof import("...")` also match and must equally be literal, which is
// fine — they always are.
const DYNAMIC_IMPORT = /\bimport\s*\(\s*([^)]*)\)/g;

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("dynamic imports are bundle-safe", () => {
  it("every dynamic import(...) in worker/src uses a string-literal specifier", () => {
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      for (const m of stripComments(text).matchAll(DYNAMIC_IMPORT)) {
        const spec = (m[1] ?? "").trim();
        if (!/^["'`]/.test(spec)) {
          offenders.push(`${file}: import(${spec})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
