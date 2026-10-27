/// <reference types="vite/client" />
// Mythos F1 (2026-10-24): Workers invocation logs record every request URL,
// and accept/confirm/poll links (`?t=`) and feed paths carry capability
// secrets in theirs. Owner ruling: invocation logs OFF where real users are
// (prod and trial), kept on the smoke deployments for per-invocation wall/CPU and the
// webhook-200 check (runbook §P). Console logs (our own structured lines)
// ship everywhere.
//
// An env-level [observability] REPLACES the top-level block (wrangler
// `inheritable`), so the smoke deployments restate their own block: without it they
// would inherit prod's invocation_logs = false.
import { describe, it, expect } from "vitest";

const files = import.meta.glob("../../wrangler.toml", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const toml = Object.values(files)[0] ?? "";

/** key = value lines directly under one table header, quotes and comments stripped. */
function table(header: string): Map<string, string> | undefined {
  const lines = toml.split("\n");
  const start = lines.findIndex((l) => l.trim() === header);
  if (start === -1) return undefined;
  const kv = new Map<string, string>();
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"?([^"\s#]+)"?/);
    if (m) kv.set(m[1]!, m[2]!);
  }
  return kv;
}

describe("wrangler.toml observability posture", () => {
  it("prod (top level): console logs ship, invocation logs are off", () => {
    expect(table("[observability]")?.get("enabled")).toBe("true");
    const logs = table("[observability.logs]");
    expect(logs?.get("enabled")).toBe("true");
    expect(logs?.get("invocation_logs")).toBe("false");
  });


  // The public release strips private env sections, so dev's block must sit
  // outside every strip region or the public dev inherits prod's off.
  it("dev: its observability block is outside every release strip region", () => {
    // Split so the release sanitiser doesn't read these as marker lines.
    const marker = (edge: string) => new RegExp("^#\\s*release" + ":strip-" + edge);
    let stripping = false;
    for (const line of toml.split("\n")) {
      if (marker("begin").test(line)) stripping = true;
      else if (marker("end").test(line)) stripping = false;
      else if (line.trim() === "[env.dev.observability]") {
        expect(stripping).toBe(false);
        return;
      }
    }
    expect.unreachable("[env.dev.observability] not found");
  });

  const smokeEnvs = ["dev"];
  for (const env of smokeEnvs) {
    it(`${env}: restates its own block so it keeps invocation logs (does not inherit prod's off)`, () => {
      expect(table(`[env.${env}.observability]`)?.get("enabled")).toBe("true");
      expect(table(`[env.${env}.observability.logs]`)?.get("invocation_logs")).not.toBe("false");
    });
  }
});
