import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { commitPlan } from "../../src/planning/commit";
import { v1 } from "../../src/v1";
import { COMMIT_CLAIM_LEASE_MS } from "../../src/planning/proposed-plans";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import type { CalendarEvent } from "../../src/providers/types";

// T3 (#2): two concurrent commits of one plan (a double-click on the accept
// page, or an agent's commit racing the user's emailed link) must not both
// write the calendar. commitPlan claims the plan before its first calendar
// read; the loser answers 409 commit_in_progress and writes nothing.

const OWNER = "o@org";
const HASH = "race-1";

const planBody = {
  schedule: [
    { task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:00:00.000Z", context: "deep" },
    { task_id: "t2", chunk_id: "t2#0", start: "2026-05-19T10:00:00.000Z", end: "2026-05-19T11:00:00.000Z", context: "deep" },
  ],
  dropped: [],
  window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
};

async function seed() {
  await env.DB.prepare(
    "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES (?, ?, '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', NULL, ?)",
  ).bind(HASH, JSON.stringify(planBody), OWNER).run();
  for (const id of ["t1", "t2"]) {
    await env.DB.prepare(
      "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    ).bind(id, OWNER, JSON.stringify({ id, title: `task ${id}` })).run();
  }
}

async function planRow() {
  return env.DB.prepare("SELECT committed_at, commit_claim, commit_claimed_at FROM proposed_plans WHERE plan_hash = ?")
    .bind(HASH)
    .first<{ committed_at: string | null; commit_claim: string | null; commit_claimed_at: string | null }>();
}

/** One shared calendar whose reads rendezvous in pairs: each
 *  fetchEventsInWindow waits until a second read arrives, so two commits run
 *  in lockstep and both scan the calendar before either writes it (the race
 *  the stray scan only narrows). `solo()` (called when either commit settles)
 *  stops pairing, so a commit that skips the calendar can't strand the other. */
class LockstepCalendar extends MockCalendarProvider {
  private waiting: (() => void) | null = null;
  private paired = true;

  solo(): void {
    this.paired = false;
    this.waiting?.();
    this.waiting = null;
  }

  override async fetchEventsInWindow(start: string, end: string, opts?: { syncToken?: boolean }) {
    if (this.paired) {
      if (this.waiting) {
        this.waiting();
        this.waiting = null;
      } else {
        await new Promise<void>((resolve) => { this.waiting = resolve; });
      }
    }
    return super.fetchEventsInWindow(start, end, opts);
  }
}

function chunkIds(events: CalendarEvent[]): string[] {
  return events.map((e) => e.extendedProperties?.private?.scheduler_chunk_id ?? "").sort();
}

describe("commitPlan claim (concurrent commits)", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposed_plans").run();
    await env.DB.prepare("DELETE FROM tasks").run();
    await seed();
  });

  it("two concurrent commits: exactly one 200 committed, one 409 commit_in_progress, one event per chunk", async () => {
    const cal = new LockstepCalendar();
    const a = commitPlan(env.DB, cal, HASH, OWNER).finally(() => cal.solo());
    const b = commitPlan(env.DB, cal, HASH, OWNER).finally(() => cal.solo());
    const results = await Promise.all([a, b]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(results.find((r) => r.status === 200)!.body).toEqual({ plan_hash: HASH, committed: 2 });
    expect(results.find((r) => r.status === 409)!.body).toEqual({ error: "commit_in_progress" });
    expect(chunkIds(cal.getCreated())).toEqual(["t1#0", "t2#0"]);

    const row = await planRow();
    expect(row!.committed_at).not.toBeNull();
    expect(row!.commit_claim).toBeNull();
    expect(row!.commit_claimed_at).toBeNull();
  });

  it("a throwing createEvent rejects, clears the claim, and an immediate retry commits (X3)", async () => {
    class Failing extends MockCalendarProvider {
      override async createEvent(): Promise<{ eventId: string }> {
        throw new Error("google 500");
      }
    }
    await expect(commitPlan(env.DB, new Failing(), HASH, OWNER)).rejects.toThrow("google 500");
    const after = await planRow();
    expect(after).toEqual({ committed_at: null, commit_claim: null, commit_claimed_at: null });

    const cal = new MockCalendarProvider();
    const res = await commitPlan(env.DB, cal, HASH, OWNER);
    expect(res).toEqual({ status: 200, body: { plan_hash: HASH, committed: 2 } });
    expect(chunkIds(cal.getCreated())).toEqual(["t1#0", "t2#0"]);
  });

  it("a live claim is refused 409 before any calendar read", async () => {
    await env.DB.prepare("UPDATE proposed_plans SET commit_claim = 'other', commit_claimed_at = ? WHERE plan_hash = ?")
      .bind(new Date(Date.now() - 10_000).toISOString(), HASH).run();
    let reads = 0;
    class Counting extends MockCalendarProvider {
      override async fetchEventsInWindow(start: string, end: string, opts?: { syncToken?: boolean }) {
        reads++;
        return super.fetchEventsInWindow(start, end, opts);
      }
    }
    const cal = new Counting();
    const res = await commitPlan(env.DB, cal, HASH, OWNER);
    expect(res).toEqual({ status: 409, body: { error: "commit_in_progress" } });
    expect(reads).toBe(0);
    expect(cal.getCreated()).toEqual([]);
    // The other holder's claim is untouched.
    expect((await planRow())!.commit_claim).toBe("other");
  });

  it("a claim older than the lease is reclaimable", async () => {
    await env.DB.prepare("UPDATE proposed_plans SET commit_claim = 'dead', commit_claimed_at = ? WHERE plan_hash = ?")
      .bind(new Date(Date.now() - COMMIT_CLAIM_LEASE_MS - 1_000).toISOString(), HASH).run();
    const cal = new MockCalendarProvider();
    const res = await commitPlan(env.DB, cal, HASH, OWNER);
    expect(res.status).toBe(200);
    expect(chunkIds(cal.getCreated())).toEqual(["t1#0", "t2#0"]);
    expect(await planRow()).toMatchObject({ commit_claim: null, commit_claimed_at: null });
  });

  it("a commit whose claim was taken over after lease expiry marks nothing (409) and leaves the new claim", async () => {
    // The takeover lands while this commit is writing the calendar: a second
    // claimer saw this one's lease expire and claimed the plan for itself.
    class TakenOver extends MockCalendarProvider {
      override async createEvent(event: CalendarEvent, meta: Record<string, string>) {
        await env.DB.prepare("UPDATE proposed_plans SET commit_claim = 'usurper', commit_claimed_at = ? WHERE plan_hash = ?")
          .bind(new Date().toISOString(), HASH).run();
        return super.createEvent(event, meta);
      }
    }
    const res = await commitPlan(env.DB, new TakenOver(), HASH, OWNER);
    expect(res).toEqual({ status: 409, body: { error: "commit_in_progress" } });
    const row = await planRow();
    expect(row!.committed_at).toBeNull();
    expect(row!.commit_claim).toBe("usurper");
  });

  it("a plan marked committed between the check and the claim answers 200 already_committed", async () => {
    // Another commit marks the plan in the gap between this one's
    // checkPlanCommittable read and its claim UPDATE.
    const db = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (/SET commit_claim = \?/.test(sql)) {
              return {
                bind: (...args: unknown[]) => ({
                  run: async () => {
                    await target.prepare("UPDATE proposed_plans SET committed_at = ? WHERE plan_hash = ?")
                      .bind(new Date().toISOString(), HASH).run();
                    return target.prepare(sql).bind(...args).run();
                  },
                }),
              } as unknown as D1PreparedStatement;
            }
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as typeof env.DB;
    const cal = new MockCalendarProvider();
    const res = await commitPlan(db, cal, HASH, OWNER);
    expect(res).toEqual({ status: 200, body: { plan_hash: HASH, already_committed: true } });
    expect(cal.getCreated()).toEqual([]);
  });
});

describe("published contract for commit_in_progress", () => {
  const doc: any = v1.getOpenAPIDocument({ openapi: "3.1.0", info: { title: "t", version: "0" } });
  const opById = (id: string): any => {
    for (const ops of Object.values<any>(doc.paths)) {
      for (const op of Object.values<any>(ops)) if (op?.operationId === id) return op;
    }
    throw new Error(`no op ${id}`);
  };

  for (const id of ["commit", "acceptPlan"]) {
    it(`${id} documents 409 commit_in_progress in its description and 409 response`, () => {
      const op = opById(id);
      expect(op.description).toMatch(/commit_in_progress/);
      const r409 = op.responses["409"];
      expect(r409.description).toMatch(/commit_in_progress/);
      expect(JSON.stringify(r409.content["application/json"].schema)).toMatch(/commit_in_progress/);
    });
  }
});
