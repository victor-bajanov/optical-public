/// <reference types="vite/client" />
// Pins wrangler.toml's two `crons = [...]` arrays against the cron-expression
// constants scheduled-entry.ts actually dispatches on. Nothing else checks
// this: a stray space, a typo, or a forgotten entry in either [triggers]
// block is a silently DEAD cron in that environment — dispatchScheduled just
// falls through to "unknown cron expression" and warns, with no user-facing
// symptom until someone notices a feature never fires.
import { describe, it, expect } from "vitest";
import {
  MONDAY_CRON,
  CLEANUP_CRON,
  POLL_CRON,
  BOOKING_DECLINE_CRON,
} from "../../src/cron/scheduled-entry";

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

// Not a general TOML parser — wrangler.toml's crons arrays are always a
// bracketed list of double-quoted strings, one per line, each with an
// optional trailing "# comment". Good enough to pin exactly this shape.
function cronsUnder(sectionHeader: string, toml: string): string[] {
  const headerIdx = toml.indexOf(sectionHeader);
  if (headerIdx === -1) throw new Error(`section ${sectionHeader} not found in wrangler.toml`);
  const arrayMatch = toml.slice(headerIdx).match(/crons\s*=\s*\[([\s\S]*?)\]/);
  if (!arrayMatch) throw new Error(`no crons = [...] found under ${sectionHeader}`);
  const crons: string[] = [];
  for (const line of arrayMatch[1]!.split("\n")) {
    const m = line.match(/"([^"]*)"/);
    if (m) crons.push(m[1]!);
  }
  return crons;
}

describe("wrangler.toml crons match scheduled-entry.ts's exported cron constants", () => {
  const toml = wranglerToml();

  it("[triggers] (prod) contains every cron dispatchScheduled understands", () => {
    const crons = cronsUnder("[triggers]", toml);
    expect(crons).toContain(MONDAY_CRON);
    expect(crons).toContain(CLEANUP_CRON);
    expect(crons).toContain(POLL_CRON);
    expect(crons).toContain(BOOKING_DECLINE_CRON);
  });

  it("[env.dev.triggers] contains the always-present crons (cleanup, poll sweep, booking-decline sweep) but not the Monday resolve, which dev drives manually", () => {
    const crons = cronsUnder("[env.dev.triggers]", toml);
    expect(crons).toContain(CLEANUP_CRON);
    expect(crons).toContain(POLL_CRON);
    expect(crons).toContain(BOOKING_DECLINE_CRON);
    expect(crons).not.toContain(MONDAY_CRON);
  });
});
