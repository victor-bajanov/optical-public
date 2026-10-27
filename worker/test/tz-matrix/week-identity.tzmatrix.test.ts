// tz-matrix mirror of test/planning/proposed-plans.test.ts week-identity
// cases (getCommittedPlanForWeek, getCommittedDroppedForWeek,
// supersedeOtherPendingPlansForWeek): a Mon-anchored plan and a mid-week-
// narrowed replan of the same LOCAL week must bucket together; the next week
// must not. Also exercised on each zone's 2026 DST-transition weeks.
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  getCommittedPlanForWeek,
  getCommittedDroppedForWeek,
  supersedeOtherPendingPlansForWeek,
} from "../../src/planning/proposed-plans";
import { MATRIX_ZONES, MIDNIGHT_GAP_ZONES, addDays, dayStartIso, localMonday, transitions, wallIso } from "./zones";

const ALL_ZONES = [...new Set([...MATRIX_ZONES, ...MIDNIGHT_GAP_ZONES])];

function weeksFor(tz: string): string[] {
  const mons = new Set<string>(["2026-05-18", "2026-01-12"]);
  for (const t of transitions(tz, 2026)) mons.add(localMonday(t.atMs, tz));
  return [...mons];
}

async function seed(hash: string, w: { start: string; end: string }, committedAt: string | null, tz: string, dropped: unknown[] = []) {
  await env.DB
    .prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end, window_tz) VALUES (?, ?, '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z', ?, 'a@x.com', ?, ?, ?)")
    .bind(hash, JSON.stringify({ schedule: [], dropped, window: w }), committedAt, w.start, w.end, tz)
    .run();
}

describe.each(ALL_ZONES)("week identity in %s", (tz) => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposed_plans").run();
  });

  it("getCommittedPlanForWeek: Mon-anchored, mid-week-narrowed and late-Sunday starts all find the week's plan; the next week does not", async () => {
    for (const mon of weeksFor(tz)) {
      await env.DB.prepare("DELETE FROM proposed_plans").run();
      const WMON = { start: dayStartIso(mon, tz), end: dayStartIso(addDays(mon, 7), tz) };
      await seed(`p-${mon}`, WMON, "2026-01-02T00:00:00Z", tz);
      for (const start of [WMON.start, wallIso(addDays(mon, 2), "10:15", tz), wallIso(addDays(mon, 6), "23:45", tz)]) {
        const got = await getCommittedPlanForWeek(env.DB, "a@x.com", start, tz, tz);
        expect(got?.plan_hash, `${mon} ${start}`).toBe(`p-${mon}`);
      }
      const next = await getCommittedPlanForWeek(env.DB, "a@x.com", dayStartIso(addDays(mon, 7), tz), tz, tz);
      expect(next, `${mon} next`).toBeNull();
    }
  });

  it("getCommittedDroppedForWeek: a mid-week-anchored resolve finds the Mon-anchored baseline", async () => {
    const mon = "2026-05-18";
    const WMON = { start: dayStartIso(mon, tz), end: dayStartIso(addDays(mon, 7), tz) };
    const dropped = [{ task_id: "t1", reason: "drop_was_cheaper_than_alternatives" }];
    await seed("mon", WMON, "2026-05-18T01:00:00Z", tz, dropped);
    const got = await getCommittedDroppedForWeek(env.DB, "a@x.com", wallIso("2026-05-20", "00:00", tz), tz, tz);
    expect(got).toEqual(dropped);
  });

  it("supersedeOtherPendingPlansForWeek: a mid-week replan supersedes the Mon-anchored pending plan, not next week's", async () => {
    for (const mon of weeksFor(tz)) {
      await env.DB.prepare("DELETE FROM proposed_plans").run();
      const W = { start: dayStartIso(mon, tz), end: dayStartIso(addDays(mon, 7), tz) };
      const WN = { start: W.end, end: dayStartIso(addDays(mon, 14), tz) };
      const mid = { start: wallIso(addDays(mon, 2), "10:15", tz), end: W.end };
      await seed("mon-anchored", W, null, tz);
      await seed("next-week", WN, null, tz);
      await seed("new-1", mid, null, tz);
      const n = await supersedeOtherPendingPlansForWeek(env.DB, "a@x.com", mid.start, tz, "new-1", tz);
      expect(n, mon).toBe(1);
      const left = await env.DB.prepare("SELECT plan_hash FROM proposed_plans ORDER BY plan_hash").all<{ plan_hash: string }>();
      expect(left.results?.map((r) => r.plan_hash), mon).toEqual(["new-1", "next-week"]);
    }
  });
});
