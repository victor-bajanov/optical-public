import { describe, it, expect } from "vitest";

// loadPendingTasks is not exported; we assert the log contract by spying on
// console.info and invoking the rename indirectly is overkill. Instead, this
// test guards the exact event name + field shape we emit, by importing the
// module source as text and asserting the rename landed. Keeping it as a
// source-contract test avoids standing up a full resolve.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

describe("resolve window-shed log line", () => {
  it("uses the non-dotted event name and structured fields", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      join(here, "../../src/planning/resolve-internal.ts"),
      "utf8",
    );
    expect(src).toContain('console.info("resolve_window_shed"');
    expect(src).toContain("excluded_past:");
    expect(src).toContain("kept:");
    expect(src).not.toContain("resolve.task_shedding");
  });
});
