/// <reference types="vite/client" />
// Card C5: CALENDAR_RAW_TOKEN_ENABLED gates GET /v1/calendar-access-token (the
// user's raw provider credential). Only the smoke envs turn it on; every vars
// block states its value explicitly (named envs inherit no vars, so absence
// would be correct but invisible), and the trial must never turn it on.
import { describe, it, expect } from "vitest";
import type { Env } from "../../src/env";

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

// Same section parser as trial-flags-default-off.test.ts: splits on table
// headers and collects flat `KEY = "value"` lines under each.
type Section = { header: string; vars: Map<string, string> };
function sections(toml: string): Section[] {
  const out: Section[] = [{ header: "", vars: new Map() }];
  for (const line of toml.split("\n")) {
    const h = line.match(/^\s*(\[\[?[^\]]+\]\]?)\s*(#.*)?$/);
    if (h) {
      out.push({ header: h[1]!, vars: new Map() });
      continue;
    }
    const kv = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"/);
    if (kv) out[out.length - 1]!.vars.set(kv[1]!, kv[2]!);
  }
  return out;
}

function varsOf(header: string, toml: string): Map<string, string> {
  const s = sections(toml).find((x) => x.header === header);
  if (!s) throw new Error(`section ${header} not found in wrangler.toml`);
  return s.vars;
}

// Compile-time pin: the flag exists on Env, optional, string-typed.
const _optional: Pick<Env, "CALENDAR_RAW_TOKEN_ENABLED"> = {};
const _member: Required<Pick<Env, "CALENDAR_RAW_TOKEN_ENABLED">> = { CALENDAR_RAW_TOKEN_ENABLED: "" };
void _optional;
void _member;

const KEY = "CALENDAR_RAW_TOKEN_ENABLED";
// Expected value per vars block. The public tree has prod + dev only.
const EXPECTED: Record<string, string> = {
  "[vars]": "false",
  "[env.dev.vars]": "true",
};

describe("CALENDAR_RAW_TOKEN_ENABLED per deployment", () => {
  const toml = wranglerToml();

  for (const [header, value] of Object.entries(EXPECTED)) {
    it(`${header} sets ${KEY} = "${value}"`, () => {
      expect(varsOf(header, toml).get(KEY)).toBe(value);
    });
  }

  it("every vars block states the flag explicitly", () => {
    const missing = sections(toml)
      .filter((s) => /^\[(env\.[a-z0-9_-]+\.)?vars\]$/.test(s.header))
      .filter((s) => !s.vars.has(KEY))
      .map((s) => s.header);
    expect(missing).toEqual([]);
  });

  it("no [env.trial*] block ever turns it on", () => {
    const on = sections(toml)
      .filter((s) => /^\[\[?env\.trial\b/.test(s.header))
      .filter((s) => s.vars.get(KEY) === "true")
      .map((s) => s.header);
    expect(on).toEqual([]);
  });
});
