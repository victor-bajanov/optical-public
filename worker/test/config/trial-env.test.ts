/// <reference types="vite/client" />
// Pins wrangler.toml deployment posture that nothing else checks until a live
// deploy goes wrong. Named environments inherit NO bindings, vars or
// triggers, but `routes` IS inherited: a named env that forgets its own
// routes override silently takes the prod custom domain on deploy.
import { describe, it, expect } from "vitest";

const files = import.meta.glob("../../wrangler.toml", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function wranglerToml(): string {
  const entry = Object.values(files)[0];
  if (entry === undefined) throw new Error("wrangler.toml not found via import.meta.glob");
  return entry;
}

// Not a general TOML parser — splits on table headers (`[x]` / `[[x]]`) and
// collects `key = value` lines under each, with string quotes and trailing
// comments removed. Good enough for wrangler.toml's flat tables; multi-line
// arrays (crons) are not parsed here (see test/cron/wrangler-crons.test.ts).
type Section = { header: string; kv: Map<string, string> };
function sections(toml: string): Section[] {
  const out: Section[] = [{ header: "", kv: new Map() }];
  for (const line of toml.split("\n")) {
    const h = line.match(/^\s*(\[\[?[^\]]+\]\]?)\s*(#.*)?$/);
    if (h) {
      out.push({ header: h[1]!, kv: new Map() });
      continue;
    }
    const str = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/);
    if (str) {
      out[out.length - 1]!.kv.set(str[1]!, str[2]!);
      continue;
    }
    const bare = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*([^\s#[]+)\s*(#.*)?$/);
    if (bare) out[out.length - 1]!.kv.set(bare[1]!, bare[2]!);
  }
  return out;
}

function all(header: string, toml: string): Map<string, string>[] {
  return sections(toml).filter((s) => s.header === header).map((s) => s.kv);
}

function one(header: string, toml: string): Map<string, string> {
  const found = all(header, toml);
  if (found.length !== 1) throw new Error(`expected exactly one ${header}, found ${found.length}`);
  return found[0]!;
}

function namedEnvs(toml: string): string[] {
  return sections(toml)
    .map((s) => s.header.match(/^\[env\.([a-z0-9_-]+)\]$/)?.[1])
    .filter((x): x is string => x !== undefined);
}

describe("wrangler.toml named environments", () => {
  const toml = wranglerToml();

  it("every named env overrides the inheritable top-level routes", () => {
    const missing = namedEnvs(toml).filter(
      (e) => all(`[[env.${e}.routes]]`, toml).length === 0 && !one(`[env.${e}]`, toml).has("routes"),
    );
    expect(namedEnvs(toml).length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});

