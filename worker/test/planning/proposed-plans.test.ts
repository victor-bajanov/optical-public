import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  insertProposedPlan,
  getProposedPlan,
  deleteProposedPlan,
  markProposedPlanCommitted,
  getLatestProposedPlanForSubject,
  getLatestCommittedPlanForSubject,
  updateCommittedPlanBody,
  getCommittedPlansForSubject,
  getCommittedPlanForWeek,
  getCommittedDroppedForWeek,
  supersedeOtherPendingPlansForWeek,
  getPendingPlansForSubject,
} from "../../src/planning/proposed-plans";
import { commitPlan } from "../../src/planning/commit";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";

const body = {
  schedule: [
    {
      task_id: "t1",
      chunk_id: "t1#0",
      start: "2026-05-19T09:00:00Z",
      end: "2026-05-19T10:00:00Z",
      context: "deep",
    },
  ],
  dropped: [],
  window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
  weights: {},
};

describe("proposed_plans D1 helpers", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposed_plans").run();
  });

  it("insert then get round-trips body and timestamps", async () => {
    await insertProposedPlan(
      env.DB,
      "hash-1",
      body,
      "2026-05-18T12:00:00Z",
      "2026-05-19T12:00:00Z",
    );
    const r = await getProposedPlan(env.DB, "hash-1");
    expect(r?.plan_hash).toBe("hash-1");
    expect(r?.body.schedule).toEqual(body.schedule);
    expect(r?.committed_at).toBeNull();
  });

  it("insert is idempotent on plan_hash", async () => {
    await insertProposedPlan(
      env.DB,
      "hash-1",
      body,
      "2026-05-18T12:00:00Z",
      "2026-05-19T12:00:00Z",
    );
    await insertProposedPlan(
      env.DB,
      "hash-1",
      body,
      "2026-05-18T12:00:00Z",
      "2026-05-19T12:00:00Z",
    );
    const r = await env.DB.prepare("SELECT COUNT(*) AS c FROM proposed_plans").first<{
      c: number;
    }>();
    expect(r?.c).toBe(1);
  });

  it("re-inserting an uncommitted plan re-arms created_at and expires_at (PP1)", async () => {
    // plan_hash is a pure content hash, so a re-resolve reproducing an earlier
    // solution conflicts. DO NOTHING would keep the stale expires_at while the
    // caller signs a fresh 72h accept link → commit 410s seconds after resolve
    // said ok. The conflict must re-arm the TTL for an uncommitted row.
    await insertProposedPlan(env.DB, "hash-1", body, "2026-05-18T12:00:00Z", "2026-05-19T12:00:00Z");
    await insertProposedPlan(env.DB, "hash-1", body, "2026-05-18T18:00:00Z", "2026-05-19T18:00:00Z");
    const r = await getProposedPlan(env.DB, "hash-1");
    expect(r?.created_at).toBe("2026-05-18T18:00:00Z");
    expect(r?.expires_at).toBe("2026-05-19T18:00:00Z");
    const c = await env.DB.prepare("SELECT COUNT(*) AS c FROM proposed_plans").first<{ c: number }>();
    expect(c?.c).toBe(1);
  });

  it("re-inserting never re-arms a committed plan (PP1 guard)", async () => {
    // A no-op replan after commit reproduces the committed row's hash. Re-arming
    // it would move expires_at on a committed plan; committed rows must be inert.
    await insertProposedPlan(env.DB, "hash-1", body, "2026-05-18T12:00:00Z", "2026-05-19T12:00:00Z", "me@x");
    await markProposedPlanCommitted(env.DB, "hash-1", "2026-05-18T12:34:56Z", "me@x");
    await insertProposedPlan(env.DB, "hash-1", body, "2026-05-20T00:00:00Z", "2026-05-21T00:00:00Z", "me@x");
    const r = await getProposedPlan(env.DB, "hash-1");
    expect(r?.created_at).toBe("2026-05-18T12:00:00Z");
    expect(r?.expires_at).toBe("2026-05-19T12:00:00Z");
    expect(r?.committed_at).toBe("2026-05-18T12:34:56Z");
  });

  it("markProposedPlanCommitted sets committed_at", async () => {
    await insertProposedPlan(
      env.DB,
      "hash-1",
      body,
      "2026-05-18T12:00:00Z",
      "2026-05-19T12:00:00Z",
      "me@x",
    );
    await markProposedPlanCommitted(env.DB, "hash-1", "2026-05-18T12:34:56Z", "me@x");
    const r = await getProposedPlan(env.DB, "hash-1");
    expect(r?.committed_at).toBe("2026-05-18T12:34:56Z");
  });

  it("delete removes the row", async () => {
    await insertProposedPlan(
      env.DB,
      "hash-1",
      body,
      "2026-05-18T12:00:00Z",
      "2026-05-19T12:00:00Z",
      "me@x",
    );
    await deleteProposedPlan(env.DB, "hash-1", "me@x");
    const r = await getProposedPlan(env.DB, "hash-1");
    expect(r).toBeNull();
  });

  it("insert populates window_start/window_end columns from body.window", async () => {
    await insertProposedPlan(env.DB, "hash-w1", body, "2026-05-18T12:00:00Z", "2026-05-19T12:00:00Z", "a@x.com");
    const row = await env.DB
      .prepare("SELECT window_start, window_end FROM proposed_plans WHERE plan_hash = 'hash-w1'")
      .first<{ window_start: string | null; window_end: string | null }>();
    expect(row?.window_start).toBe("2026-05-18T00:00:00Z");
    expect(row?.window_end).toBe("2026-05-25T00:00:00Z");
  });

  it("migration backfill statement fills window columns from body JSON", async () => {
    // Simulate a pre-0027 row: insert with NULL window columns via raw SQL.
    await env.DB
      .prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('hash-legacy', ?, '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', NULL, 'a@x.com')")
      .bind(JSON.stringify(body))
      .run();
    // Re-run the backfill UPDATE exactly as migration 0027 writes it.
    await env.DB
      .prepare("UPDATE proposed_plans SET window_start = json_extract(body, '$.window.start'), window_end = json_extract(body, '$.window.end') WHERE window_start IS NULL")
      .run();
    const row = await env.DB
      .prepare("SELECT window_start, window_end FROM proposed_plans WHERE plan_hash = 'hash-legacy'")
      .first<{ window_start: string | null; window_end: string | null }>();
    expect(row?.window_start).toBe("2026-05-18T00:00:00Z");
    expect(row?.window_end).toBe("2026-05-25T00:00:00Z");
  });

  it("rowFromRaw falls back to body.window when columns are NULL (legacy row)", async () => {
    await env.DB
      .prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('hash-legacy2', ?, '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', NULL, 'a@x.com')")
      .bind(JSON.stringify(body))
      .run();
    const r = await getProposedPlan(env.DB, "hash-legacy2");
    expect(r?.window_start).toBe("2026-05-18T00:00:00Z");
    expect(r?.window_end).toBe("2026-05-25T00:00:00Z");
  });
});

describe("getLatestProposedPlanForSubject", () => {
  const body = { schedule: [], dropped: [], window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" } };
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposed_plans").run();
  });

  it("returns the newest uncommitted, unexpired plan for the subject", async () => {
    const far = "2099-01-01T00:00:00Z";
    await env.DB.prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('old', ?, '2026-05-20T00:00:00Z', ?, NULL, 'me@x')").bind(JSON.stringify(body), far).run();
    await env.DB.prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('new', ?, '2026-05-21T00:00:00Z', ?, NULL, 'me@x')").bind(JSON.stringify(body), far).run();
    const row = await getLatestProposedPlanForSubject(env.DB, "me@x", new Date("2026-05-21T12:00:00Z"));
    expect(row?.plan_hash).toBe("new");
  });

  it("ignores committed and expired plans, and other subjects", async () => {
    await env.DB.prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('committed', ?, '2026-05-21T00:00:00Z', '2099-01-01T00:00:00Z', '2026-05-21T01:00:00Z', 'me@x')").bind(JSON.stringify(body)).run();
    await env.DB.prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('expired', ?, '2026-05-19T00:00:00Z', '2026-05-20T00:00:00Z', NULL, 'me@x')").bind(JSON.stringify(body)).run();
    await env.DB.prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('other', ?, '2026-05-21T00:00:00Z', '2099-01-01T00:00:00Z', NULL, 'someone@else')").bind(JSON.stringify(body)).run();
    const row = await getLatestProposedPlanForSubject(env.DB, "me@x", new Date("2026-05-21T12:00:00Z"));
    expect(row).toBeNull();
  });

  it("includes a plan whose expires_at equals now exactly (boundary is inclusive)", async () => {
    const exactNow = "2026-05-21T12:00:00.000Z";
    await env.DB.prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('boundary', ?, '2026-05-21T00:00:00Z', ?, NULL, 'me@x')").bind(JSON.stringify(body), exactNow).run();
    const row = await getLatestProposedPlanForSubject(env.DB, "me@x", new Date(exactNow));
    expect(row?.plan_hash).toBe("boundary");
  });
});

describe("owner-scoped proposed_plans accessors", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposed_plans").run();
  });

  it("deleteProposedPlan only removes the owner's row", async () => {
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('a-plan', ?, '2026-05-18T12:00:00Z', '2099-01-01T00:00:00Z', NULL, 'a@org')",
    ).bind(JSON.stringify(body)).run();
    const foreign = await deleteProposedPlan(env.DB, "a-plan", "b@org");
    expect(foreign).toBe(false);
    expect(await getProposedPlan(env.DB, "a-plan")).not.toBeNull();
    const own = await deleteProposedPlan(env.DB, "a-plan", "a@org");
    expect(own).toBe(true);
    expect(await getProposedPlan(env.DB, "a-plan")).toBeNull();
  });

  it("deleteProposedPlan never removes a committed row (no-diff cleanup guard)", async () => {
    // plan_hash is a pure content hash; after commit a no-op replan reproduces
    // the same hash and the no-diff cleanup calls deleteProposedPlan(hash). That
    // must NOT delete the committed row, or getLatestCommittedPlanForSubject goes
    // stale and the manual-move write-back stops firing.
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('committed-hash', ?, '2026-05-18T12:00:00Z', '2099-01-01T00:00:00Z', '2026-05-18T13:00:00Z', 'a@org')",
    ).bind(JSON.stringify(body)).run();
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('pending-hash', ?, '2026-05-18T12:00:00Z', '2099-01-01T00:00:00Z', NULL, 'a@org')",
    ).bind(JSON.stringify(body)).run();
    const committedDeleted = await deleteProposedPlan(env.DB, "committed-hash", "a@org");
    expect(committedDeleted).toBe(false);
    expect(await getProposedPlan(env.DB, "committed-hash")).not.toBeNull();
    const pendingDeleted = await deleteProposedPlan(env.DB, "pending-hash", "a@org");
    expect(pendingDeleted).toBe(true);
    expect(await getProposedPlan(env.DB, "pending-hash")).toBeNull();
  });

  it("markProposedPlanCommitted only flips the owner's row", async () => {
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('a-plan', ?, '2026-05-18T12:00:00Z', '2099-01-01T00:00:00Z', NULL, 'a@org')",
    ).bind(JSON.stringify(body)).run();
    const foreign = await markProposedPlanCommitted(env.DB, "a-plan", "2026-05-18T12:34:56Z", "b@org");
    expect(foreign).toBe(false);
    expect((await getProposedPlan(env.DB, "a-plan"))?.committed_at).toBeNull();
    const own = await markProposedPlanCommitted(env.DB, "a-plan", "2026-05-18T12:34:56Z", "a@org");
    expect(own).toBe(true);
    expect((await getProposedPlan(env.DB, "a-plan"))?.committed_at).toBe("2026-05-18T12:34:56Z");
  });

  it("getLatestCommittedPlanForSubject ignores other tenants' committed plans", async () => {
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('mine', ?, '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', '2026-05-18T01:00:00Z', 'a@org')",
    ).bind(JSON.stringify(body)).run();
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('theirs', ?, '2026-05-25T00:00:00Z', '2099-01-01T00:00:00Z', '2026-05-25T01:00:00Z', 'b@org')",
    ).bind(JSON.stringify(body)).run();
    expect((await getLatestCommittedPlanForSubject(env.DB, "a@org"))?.plan_hash).toBe("mine");
    expect(await getLatestCommittedPlanForSubject(env.DB, "c@org")).toBeNull();
  });

  it("getProposedPlan returns the owning subject", async () => {
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('a-plan', ?, '2026-05-18T12:00:00Z', '2099-01-01T00:00:00Z', NULL, 'a@org')",
    ).bind(JSON.stringify(body)).run();
    expect((await getProposedPlan(env.DB, "a-plan"))?.subject).toBe("a@org");
  });
});

async function seedCommitted(planHash: string, subject: string, seedBody: unknown): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject)
     VALUES (?, ?, '2026-05-17T00:00:00Z', '2099-01-01T00:00:00Z', '2026-05-17T01:00:00Z', ?)`,
  ).bind(planHash, JSON.stringify(seedBody), subject).run();
}

describe("updateCommittedPlanBody", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposed_plans").run();
  });

  it("overwrites the body of an owned committed plan and returns true", async () => {
    await seedCommitted("h1", "primary", { schedule: [{ chunk_id: "c0", start: "old" }] });
    const ok = await updateCommittedPlanBody(env.DB, "h1", "primary", {
      schedule: [{ chunk_id: "c0", start: "new" }],
    });
    expect(ok).toBe(true);
    const row = await env.DB.prepare("SELECT body FROM proposed_plans WHERE plan_hash = 'h1'").first<{ body: string }>();
    expect(JSON.parse(row!.body).schedule[0].start).toBe("new");
  });

  it("does not touch another tenant's plan (returns false)", async () => {
    await seedCommitted("h2", "other", { schedule: [] });
    const ok = await updateCommittedPlanBody(env.DB, "h2", "primary", { schedule: [{ chunk_id: "x", start: "z" }] });
    expect(ok).toBe(false);
    const row = await env.DB.prepare("SELECT body FROM proposed_plans WHERE plan_hash = 'h2'").first<{ body: string }>();
    expect(JSON.parse(row!.body).schedule).toHaveLength(0);
  });
});

describe("getCommittedPlansForSubject", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposed_plans").run();
  });

  async function insertCommitted(hash: string, committedAt: string | null, subject: string) {
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES (?,?,?,?,?,?)",
    )
      .bind(hash, JSON.stringify({ schedule: [], dropped: [] }), "2026-05-18T00:00:00Z", "2099-01-01T00:00:00Z", committedAt, subject)
      .run();
  }

  it("returns committed plans for the subject, newest first; excludes uncommitted and other subjects", async () => {
    await insertCommitted("h1", "2026-05-18T01:00:00Z", "primary");
    await insertCommitted("h2", "2026-05-25T01:00:00Z", "primary");
    await insertCommitted("h3", null, "primary");           // uncommitted → excluded
    await insertCommitted("h4", "2026-05-20T01:00:00Z", "other"); // other subject → excluded
    const rows = await getCommittedPlansForSubject(env.DB, "primary");
    expect(rows.map((r) => r.plan_hash)).toEqual(["h2", "h1"]);
  });

  it("caps the result at 16 plans", async () => {
    for (let i = 0; i < 20; i++) {
      await insertCommitted(`c${i}`, `2026-0${1 + (i % 9)}-1${i % 9}T01:00:00Z`, "primary");
    }
    const rows = await getCommittedPlansForSubject(env.DB, "primary");
    expect(rows.length).toBe(16);
  });
});

describe("getCommittedPlanForWeek", () => {
  const WMON = { start: "2026-05-17T14:00:00.000Z", end: "2026-05-24T14:00:00.000Z" }; // Mon 18 May local week (AEST)
  const WMID = { start: "2026-05-20T00:00:00+10:00", end: "2026-05-25T00:00:00+10:00" }; // Wed-narrowed, same week
  const WNEXT = { start: "2026-05-24T14:00:00.000Z", end: "2026-05-31T14:00:00.000Z" }; // Mon 25 May local week
  const seed = (
    hash: string,
    w: { start: string; end: string },
    committedAt: string | null,
    extra: { schedule?: unknown[]; dropped?: unknown[]; subject?: string } = {},
  ) =>
    env.DB
      .prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end) VALUES (?, ?, '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', ?, ?, ?, ?)")
      .bind(hash, JSON.stringify({ schedule: extra.schedule ?? [], dropped: extra.dropped ?? [], window: w }), committedAt, extra.subject ?? "a@x.com", w.start, w.end)
      .run();

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposed_plans").run();
  });

  it("returns the plan for the resolved week, not the globally-latest committed plan (an internal issue)", async () => {
    await seed("this-week", WMON, "2026-05-18T01:00:00Z");
    await seed("next-week", WNEXT, "2026-05-25T01:00:00Z"); // committed later
    expect((await getLatestCommittedPlanForSubject(env.DB, "a@x.com"))?.plan_hash).toBe("next-week");
    const got = await getCommittedPlanForWeek(env.DB, "a@x.com", WMON.start, env.SCHEDULER_TZ);
    expect(got?.plan_hash).toBe("this-week");
  });

  it("a mid-week-narrowed window.start still matches its Mon-anchored week plan", async () => {
    await seed("mon", WMON, "2026-05-18T01:00:00Z");
    const got = await getCommittedPlanForWeek(env.DB, "a@x.com", WMID.start, env.SCHEDULER_TZ);
    expect(got?.plan_hash).toBe("mon");
  });

  it("returns null when the subject has no committed plan for that week", async () => {
    await seed("next-week", WNEXT, "2026-05-25T01:00:00Z");
    await seed("pending-this-week", WMON, null);
    await seed("foreign-this-week", WMON, "2026-05-18T01:00:00Z", { subject: "b@x.com" });
    expect(await getCommittedPlanForWeek(env.DB, "a@x.com", WMON.start, env.SCHEDULER_TZ)).toBeNull();
  });

  it("finds the target week's plan behind 16+ newer commits for another week", async () => {
    // Prod shape (245 committed rows for one subject; the 16 newest span 3 days
    // and 2 weeks): a recency-ordered scan of the newest 16 rows never reaches a
    // future week's plan, so the lookup must be week-RANGED, not scan-then-filter.
    await seed("target", WNEXT, "2026-05-25T01:00:00Z");
    for (let i = 0; i < 20; i++) {
      await seed(`noise-${i}`, WMON, `2026-05-26T0${i % 10}:00:00Z`);
    }
    const got = await getCommittedPlanForWeek(env.DB, "a@x.com", WNEXT.start, env.SCHEDULER_TZ);
    expect(got?.plan_hash).toBe("target");
  });

  it("matches on the window_start column when the body carries no window object", async () => {
    // Column-first, the same precedence rowFromRaw uses.
    await env.DB
      .prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end) VALUES ('columns-only', ?, '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', '2026-05-18T01:00:00Z', 'a@x.com', ?, ?)")
      .bind(JSON.stringify({ schedule: [], dropped: [] }), WMON.start, WMON.end)
      .run();
    const got = await getCommittedPlanForWeek(env.DB, "a@x.com", WMON.start, env.SCHEDULER_TZ);
    expect(got?.plan_hash).toBe("columns-only");
  });

  it("an unparseable window on a newer row neither throws nor hides the valid plan", async () => {
    await seed("valid", WMON, "2026-05-18T01:00:00Z");
    await env.DB
      .prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end) VALUES ('garbage', ?, '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', '2026-05-19T01:00:00Z', 'a@x.com', 'not-a-date', 'not-a-date')")
      .bind(JSON.stringify({ schedule: [], dropped: [], window: { start: "not-a-date", end: "not-a-date" } }))
      .run();
    const got = await getCommittedPlanForWeek(env.DB, "a@x.com", WMON.start, env.SCHEDULER_TZ);
    expect(got?.plan_hash).toBe("valid");
  });

  it("matches a window_start stored with a zone offset rather than Z", async () => {
    // window_start strings mix formats, so the range predicate must compare
    // instants (SQLite datetime()), never raw strings.
    await seed("offset-form", WMID, "2026-05-20T05:00:00Z");
    const got = await getCommittedPlanForWeek(env.DB, "a@x.com", WMON.start, env.SCHEDULER_TZ);
    expect(got?.plan_hash).toBe("offset-form");
  });

  it("the most recently committed plan of the week wins, and the drop baseline reads the same plan", async () => {
    // Churn baseline and drop baseline share this lookup — they must never
    // select different plans for the same week.
    await seed("older", WMON, "2026-05-18T01:00:00Z", { dropped: [{ task_id: "t1" }] });
    await seed("newer", WMID, "2026-05-20T05:00:00Z", { dropped: [{ task_id: "t2" }] });
    const got = await getCommittedPlanForWeek(env.DB, "a@x.com", WMON.start, env.SCHEDULER_TZ);
    expect(got?.plan_hash).toBe("newer");
    expect(await getCommittedDroppedForWeek(env.DB, "a@x.com", WMON.start, env.SCHEDULER_TZ)).toEqual(
      got?.body.dropped,
    );
  });
});

describe("getCommittedDroppedForWeek", () => {
  const WMON = { start: "2026-05-17T14:00:00.000Z", end: "2026-05-24T14:00:00.000Z" }; // Mon 18 May local week (AEST)
  const WMID = { start: "2026-05-20T00:00:00+10:00", end: "2026-05-25T00:00:00+10:00" }; // Wed-narrowed, same week
  const dropped = (id: string) => [{ task_id: id, reason: "drop_was_cheaper_than_alternatives" }];
  const seed = (hash: string, w: { start: string; end: string }, drop: unknown[], committedAt: string | null) =>
    env.DB
      .prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end) VALUES (?, ?, '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', ?, 'a@x.com', ?, ?)")
      .bind(hash, JSON.stringify({ schedule: [], dropped: drop, window: w }), committedAt, w.start, w.end)
      .run();

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposed_plans").run();
  });

  it("a mid-week-anchored resolve finds the committed Mon-anchored plan of the same week as baseline", async () => {
    await seed("mon", WMON, dropped("t1"), "2026-05-18T01:00:00Z");
    const got = await getCommittedDroppedForWeek(env.DB, "a@x.com", WMID.start, env.SCHEDULER_TZ);
    expect(got).toEqual(dropped("t1"));
  });

  it("a committed plan for a different week is not a baseline", async () => {
    await seed("next-week", { start: "2026-05-24T14:00:00.000Z", end: "2026-05-31T14:00:00.000Z" }, dropped("t1"), "2026-05-25T01:00:00Z");
    const got = await getCommittedDroppedForWeek(env.DB, "a@x.com", WMON.start, env.SCHEDULER_TZ);
    expect(got).toEqual([]);
  });

  it("the most recently committed plan of the week wins, regardless of anchoring", async () => {
    await seed("older", WMON, dropped("t1"), "2026-05-18T01:00:00Z");
    await seed("newer", WMID, dropped("t2"), "2026-05-20T05:00:00Z");
    const got = await getCommittedDroppedForWeek(env.DB, "a@x.com", WMON.start, env.SCHEDULER_TZ);
    expect(got).toEqual(dropped("t2"));
  });

  it("uncommitted plans are never a baseline", async () => {
    await seed("pending", WMON, dropped("t1"), null);
    const got = await getCommittedDroppedForWeek(env.DB, "a@x.com", WMON.start, env.SCHEDULER_TZ);
    expect(got).toEqual([]);
  });
});

describe("commitPlan D1 atomicity (X3)", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposed_plans").run();
    await env.DB.prepare("DELETE FROM tasks").run();
  });

  it("rolls back t1's write when the LATER t2 UPDATE fails (genuine batch atomicity)", async () => {
    // Two-task plan: t1 commits first in schedule order, t2 second.
    // We poison ONLY the second task-commit UPDATE. Under sequential (non-atomic)
    // writes t1 would already be committed before t2 throws, leaving t1 with
    // status='committed' and a scheduled_for stamp. Under the atomic batch the
    // entire batch is rolled back, so t1 stays pending — that is the discriminating
    // assertion this test verifies.
    const twoTaskBody = {
      schedule: [
        { task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:00:00.000Z", context: "deep" },
        { task_id: "t2", chunk_id: "t2#0", start: "2026-05-19T10:00:00.000Z", end: "2026-05-19T11:00:00.000Z", context: "deep" },
      ],
      dropped: [],
      window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
    };
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('h1', ?, '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', NULL, 'o@org')",
    ).bind(JSON.stringify(twoTaskBody)).run();
    await env.DB.prepare(
      "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES ('t1','o@org',?, 'pending', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    ).bind(JSON.stringify({ id: "t1", title: "task one" })).run();
    await env.DB.prepare(
      "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES ('t2','o@org',?, 'pending', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    ).bind(JSON.stringify({ id: "t2", title: "task two" })).run();

    // Poison ONLY the second task-commit UPDATE (by call-count on the matching SQL).
    // The poisoned statement has the same arity (4 placeholders) so .bind() succeeds
    // and the error surfaces at batch-execution time, not at bind time.
    let taskUpdateCount = 0;
    const poisoned = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (/SET status = 'committed', scheduled_for = \?/.test(sql)) {
              taskUpdateCount++;
              if (taskUpdateCount === 2) {
                // Second task (t2): poison with a nonexistent table but same arity.
                return target.prepare("UPDATE no_such_table SET a = ?, b = ? WHERE c = ? AND d = ?");
              }
            }
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as typeof env.DB;

    await commitPlan(poisoned, new MockCalendarProvider(), "h1", "o@org").catch(() => undefined);

    // Key discriminating assertion: t1 must still be pending even though it was
    // the FIRST task processed. A sequential implementation would have already
    // committed t1 before hitting the t2 error; the atomic batch rolls t1 back.
    const t1 = await env.DB.prepare("SELECT status, scheduled_for FROM tasks WHERE id='t1'")
      .first<{ status: string; scheduled_for: string | null }>();
    expect(t1!.status).toBe("pending");
    expect(t1!.scheduled_for).toBeNull();

    const t2 = await env.DB.prepare("SELECT status, scheduled_for FROM tasks WHERE id='t2'")
      .first<{ status: string; scheduled_for: string | null }>();
    expect(t2!.status).toBe("pending");
    expect(t2!.scheduled_for).toBeNull();

    const plan = await env.DB.prepare("SELECT committed_at FROM proposed_plans WHERE plan_hash='h1'")
      .first<{ committed_at: string | null }>();
    expect(plan!.committed_at).toBeNull();
  });

  it("commits the plan and stamps the task in one batch on the happy path", async () => {
    const body = {
      schedule: [
        { task_id: "t1", chunk_id: "t1#0", start: "2026-05-19T09:00:00.000Z", end: "2026-05-19T10:00:00.000Z", context: "deep" },
      ],
      dropped: [],
      window: { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" },
    };
    await env.DB.prepare(
      "INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES ('h2', ?, '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', NULL, 'o@org')",
    ).bind(JSON.stringify(body)).run();
    await env.DB.prepare(
      "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES ('t1','o@org',?, 'pending', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    ).bind(JSON.stringify({ id: "t1", title: "deep" })).run();

    const res = await commitPlan(env.DB, new MockCalendarProvider(), "h2", "o@org");
    expect(res.status).toBe(200);
    const task = await env.DB.prepare("SELECT status, scheduled_for FROM tasks WHERE id='t1'")
      .first<{ status: string; scheduled_for: string | null }>();
    expect(task!.status).toBe("committed");
    expect(task!.scheduled_for).toBe("2026-05-19T09:00:00.000Z");
    const plan = await env.DB.prepare("SELECT committed_at FROM proposed_plans WHERE plan_hash='h2'")
      .first<{ committed_at: string | null }>();
    expect(plan!.committed_at).not.toBeNull();
  });
});

describe("supersedeOtherPendingPlansForWeek", () => {
  const W = { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" };
  const seed = (hash: string, subject: string, w: { start: string; end: string }, committedAt: string | null = null) =>
    env.DB
      .prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end) VALUES (?, ?, '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', ?, ?, ?, ?)")
      .bind(hash, JSON.stringify({ ...body, window: w }), committedAt, subject, w.start, w.end)
      .run();

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposed_plans").run();
  });

  it("deletes other pending plans for the same (subject, week) and keeps the new one", async () => {
    await seed("old-1", "a@x.com", W);
    await seed("old-2", "a@x.com", W);
    await seed("new-1", "a@x.com", W);
    const n = await supersedeOtherPendingPlansForWeek(env.DB, "a@x.com", W.start, env.SCHEDULER_TZ, "new-1");
    expect(n).toBe(2);
    const left = await env.DB.prepare("SELECT plan_hash FROM proposed_plans ORDER BY plan_hash").all<{ plan_hash: string }>();
    expect(left.results?.map((r) => r.plan_hash)).toEqual(["new-1"]);
  });

  it("a differently-anchored window in the same local week IS superseded (mid-week replan)", async () => {
    // Mon-anchored full-week plan vs a Wed-narrowed replan of the SAME week
    // (window_start clamped so the solver can't place into the past).
    const wmid = { start: "2026-05-20T00:00:00+10:00", end: "2026-05-25T00:00:00+10:00" };
    await seed("mon-anchored", "a@x.com", W);
    await seed("new-1", "a@x.com", wmid);
    const n = await supersedeOtherPendingPlansForWeek(env.DB, "a@x.com", wmid.start, env.SCHEDULER_TZ, "new-1");
    expect(n).toBe(1);
    const left = await env.DB.prepare("SELECT plan_hash FROM proposed_plans ORDER BY plan_hash").all<{ plan_hash: string }>();
    expect(left.results?.map((r) => r.plan_hash)).toEqual(["new-1"]);
  });

  it("a malformed window on another pending row does not abort the supersede", async () => {
    // 0027's backfill never validated the JSON it copied, so a malformed
    // window_start is reachable. localWeekWindow throws on it, and this loop runs
    // inside every successful resolve — one bad row would 500 the API resolve and
    // silently stop webhook/cron resolves until it was hand-deleted.
    await env.DB
      .prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end) VALUES ('malformed', ?, '2026-05-18T00:00:00Z', '2099-01-01T00:00:00Z', NULL, 'a@x.com', 'not-a-date', 'not-a-date')")
      .bind(JSON.stringify({ ...body, window: { start: "not-a-date", end: "not-a-date" } }))
      .run();
    await seed("old-1", "a@x.com", W);
    await seed("new-1", "a@x.com", W);
    const n = await supersedeOtherPendingPlansForWeek(env.DB, "a@x.com", W.start, env.SCHEDULER_TZ, "new-1");
    expect(n).toBe(1);
    // The unbucketable row is left for the expiry sweep, not deleted blindly.
    expect(await getProposedPlan(env.DB, "malformed")).not.toBeNull();
  });

  it("a plan for a different week is NOT superseded", async () => {
    await seed("next-week", "a@x.com", { start: "2026-05-25T00:00:00Z", end: "2026-06-01T00:00:00Z" });
    await seed("new-1", "a@x.com", W);
    const n = await supersedeOtherPendingPlansForWeek(env.DB, "a@x.com", W.start, env.SCHEDULER_TZ, "new-1");
    expect(n).toBe(0);
  });

  it("never touches committed rows or other subjects", async () => {
    await seed("committed-1", "a@x.com", W, "2026-05-18T01:00:00Z");
    await seed("foreign-1", "b@x.com", W);
    await seed("new-1", "a@x.com", W);
    const n = await supersedeOtherPendingPlansForWeek(env.DB, "a@x.com", W.start, env.SCHEDULER_TZ, "new-1");
    expect(n).toBe(0);
    const left = await env.DB.prepare("SELECT COUNT(*) AS c FROM proposed_plans").first<{ c: number }>();
    expect(left?.c).toBe(3);
  });
});

describe("getPendingPlansForSubject", () => {
  const W1 = { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" };
  const W2 = { start: "2026-05-25T00:00:00Z", end: "2026-06-01T00:00:00Z" };
  const seed = (hash: string, w: { start: string; end: string }, createdAt: string, opts: { committedAt?: string; expiresAt?: string; subject?: string } = {}) =>
    env.DB
      .prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject, window_start, window_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(hash, JSON.stringify({ ...body, window: w }), createdAt, opts.expiresAt ?? "2099-01-01T00:00:00Z", opts.committedAt ?? null, opts.subject ?? "a@x.com", w.start, w.end)
      .run();

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM proposed_plans").run();
  });

  it("returns pending plans newest-first with window fields, excluding committed/expired/foreign", async () => {
    await seed("p-old", W1, "2026-05-18T01:00:00Z");
    await seed("p-new", W2, "2026-05-18T02:00:00Z");
    await seed("p-committed", W1, "2026-05-18T03:00:00Z", { committedAt: "2026-05-18T04:00:00Z" });
    await seed("p-expired", W2, "2026-05-18T03:00:00Z", { expiresAt: "2026-05-01T00:00:00Z" });
    await seed("p-foreign", W1, "2026-05-18T03:00:00Z", { subject: "b@x.com" });
    const rows = await getPendingPlansForSubject(env.DB, "a@x.com", new Date("2026-05-19T00:00:00Z"));
    expect(rows.map((r) => r.plan_hash)).toEqual(["p-new", "p-old"]);
    expect(rows[0]?.window_start).toBe(W2.start);
    expect(rows[0]?.window_end).toBe(W2.end);
  });
});
