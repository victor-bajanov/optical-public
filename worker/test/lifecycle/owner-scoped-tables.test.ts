import { env, applyD1Migrations } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { OWNER_SCOPED_TABLES, OWNER_SCOPING_COLUMNS } from "../../src/lifecycle/owner-scoped-tables";
// Vite ?raw import resolves to the file's string contents at build time, same
// pattern as test/setup.ts for every other migration. Applied locally here
// (rather than in the shared setup file, which is outside this correction's
// file fence) so this guard scans the polls tables migration 0032 adds.
import meetingPollSql from "../../migrations/0032_meeting_poll.sql?raw";

beforeAll(async () => {
  await applyD1Migrations(env.DB, [{ name: "0032_meeting_poll.sql", queries: [meetingPollSql] }]);
});

// Internal/system tables that are never user-scoped even if a column name collides.
const SYSTEM_TABLE_PREFIXES = ["sqlite_", "_cf_", "d1_"];

async function userTablesInSchema(): Promise<string[]> {
  const rs = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
  return (rs.results ?? [])
    .map((r) => r.name)
    .filter((n) => !SYSTEM_TABLE_PREFIXES.some((p) => n.startsWith(p)));
}

async function columnsOf(table: string): Promise<string[]> {
  const rs = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return (rs.results ?? []).map((r) => r.name);
}

describe("owner-scoped table registry guard", () => {
  it("registers every table in the live schema that has an owner-scoping column", async () => {
    const registered = new Set(OWNER_SCOPED_TABLES.map((t) => t.table));
    const missing: string[] = [];

    for (const table of await userTablesInSchema()) {
      const cols = await columnsOf(table);
      const isOwnerScoped = OWNER_SCOPING_COLUMNS.some((c) => cols.includes(c));
      if (isOwnerScoped && !registered.has(table)) missing.push(table);
    }

    expect(missing, `owner-scoped tables missing from OWNER_SCOPED_TABLES: ${missing.join(", ")}`).toEqual([]);
  });

  it("every registered table exists and carries its declared scoping column", async () => {
    for (const t of OWNER_SCOPED_TABLES) {
      const cols = await columnsOf(t.table);
      expect(cols.length, `table ${t.table} does not exist in schema`).toBeGreaterThan(0);
      expect(cols, `table ${t.table} missing declared column ${t.column}`).toContain(t.column);
    }
  });
});
