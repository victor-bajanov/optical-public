import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

// O9.1: 0042 adds pending_actions, the owner-scoped store behind the
// agent-confirm mechanism (worker/src/confirm/). One row per deferred action:
// the op name, the validated payload and display summary as JSON, a 24 h
// expiry, and consumed_at, which the confirm POST's CAS sets exactly once.
describe("0042 pending_actions migration", () => {
  it("creates the table with the documented columns", async () => {
    const cols = await env.DB.prepare("PRAGMA table_info(pending_actions)")
      .all<{ name: string; type: string; notnull: number; pk: number }>();
    const byName = Object.fromEntries(cols.results.map((c) => [c.name, c]));
    // mail_channel arrives with 0045 (decision K); see its own test.
    expect(Object.keys(byName).filter((c) => c !== "mail_channel").sort()).toEqual(
      ["consumed_at", "created_at", "expires_at", "id", "op", "owner_subject", "payload", "summary"],
    );
    expect(byName.id).toMatchObject({ type: "TEXT", pk: 1 });
    for (const c of ["owner_subject", "op", "payload", "summary", "created_at", "expires_at"]) {
      expect(byName[c], c).toMatchObject({ type: "TEXT", notnull: 1 });
    }
    expect(byName.consumed_at).toMatchObject({ type: "TEXT", notnull: 0 });
  });

  it("indexes owner_subject (offboard deletes and per-owner hygiene scan by it)", async () => {
    const idx = await env.DB.prepare("PRAGMA index_list(pending_actions)").all<{ name: string }>();
    const cols: string[] = [];
    for (const i of idx.results) {
      const info = await env.DB.prepare(`PRAGMA index_info(${i.name})`).all<{ name: string }>();
      cols.push(...info.results.map((r) => r.name));
    }
    expect(cols).toContain("owner_subject");
  });

  it("has an index led by expires_at (the deferral-time housekeeping scans every owner by expiry)", async () => {
    const idx = await env.DB.prepare("PRAGMA index_list(pending_actions)").all<{ name: string }>();
    const leading: string[] = [];
    for (const i of idx.results) {
      const info = await env.DB.prepare(`PRAGMA index_info(${i.name})`).all<{ seqno: number; name: string }>();
      const first = info.results.find((r) => r.seqno === 0);
      if (first) leading.push(first.name);
    }
    expect(leading).toContain("expires_at");
  });
});
