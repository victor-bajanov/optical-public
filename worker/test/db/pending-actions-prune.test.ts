import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  pruneExpiredPendingActions,
  claimSystemFallback,
  reservePendingAction,
  PENDING_ACTION_LIVE_CAP,
} from "../../src/db/pending-actions";

const NOW = new Date("2026-10-24T04:00:00.000Z");
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const DAY = 24 * 3600 * 1000;

async function seed(id: string, owner: string, expiresAt: string, opts: { createdAt?: string; consumed?: boolean; system?: boolean } = {}) {
  await env.DB.prepare(
    `INSERT INTO pending_actions (id, owner_subject, op, payload, summary, created_at, expires_at, consumed_at, mail_channel)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      owner,
      "createMeetingPoll",
      `{"id":"${id}"}`,
      `summary ${id}`,
      opts.createdAt ?? iso(-DAY),
      expiresAt,
      opts.consumed ? iso(-DAY) : null,
      opts.system ? "system" : null,
    )
    .run();
}

const row = (id: string) =>
  env.DB.prepare("SELECT payload, summary FROM pending_actions WHERE id = ?").bind(id).first<{ payload: string; summary: string }>();

describe("pruneExpiredPendingActions", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM pending_actions").run();
  });

  it("returns {deleted, blanked} from the batch's changes", async () => {
    await seed("old-1", "a@x", iso(-8 * DAY));
    await seed("old-2", "b@x", iso(-9 * DAY), { consumed: true });
    await seed("expired-1", "a@x", iso(-60_000));
    await seed("expired-2", "a@x", iso(-2 * DAY));
    await seed("expired-3", "b@x", iso(-3 * DAY));
    await seed("live", "a@x", iso(DAY));

    expect(await pruneExpiredPendingActions(env.DB, NOW)).toEqual({ deleted: 2, blanked: 3 });
    expect(await row("old-1")).toBeNull();
    expect(await row("old-2")).toBeNull();
    expect(await row("expired-2")).toEqual({ payload: "", summary: "" });
    expect(await row("live")).toEqual({ payload: '{"id":"live"}', summary: "summary live" });

    // Idempotent: a second run finds nothing to do.
    expect(await pruneExpiredPendingActions(env.DB, NOW)).toEqual({ deleted: 0, blanked: 0 });
  });

  it("returns zeros on an empty table", async () => {
    expect(await pruneExpiredPendingActions(env.DB, NOW)).toEqual({ deleted: 0, blanked: 0 });
  });

  it("leaves the system-fallback 24 h count unchanged", async () => {
    // Three system-mailed rows created inside the last 24 h, already expired
    // (short TTL) but not past the grace: the prune blanks them, and they
    // must still count against the owner's daily fallback quota.
    for (const id of ["s1", "s2", "s3"]) await seed(id, "c@x", iso(-60_000), { createdAt: iso(-3600_000), system: true });
    await seed("fresh", "c@x", iso(DAY), { createdAt: iso(-60_000) });

    await pruneExpiredPendingActions(env.DB, NOW);
    expect(await claimSystemFallback(env.DB, "fresh", "c@x", NOW)).toBe(false);
  });

  it("leaves the live cap unchanged", async () => {
    for (let i = 0; i < PENDING_ACTION_LIVE_CAP; i++) await seed(`l${i}`, "d@x", iso(DAY));
    await seed("gone", "d@x", iso(-8 * DAY));
    await seed("stale", "d@x", iso(-DAY));

    const attempt = (id: string) =>
      reservePendingAction(
        env.DB,
        { id, owner_subject: "d@x", op: "createMeetingPoll", payload: `{"n":"${id}"}`, summary: "s", created_at: NOW.toISOString(), expires_at: iso(DAY) },
        NOW,
      );
    expect((await attempt("before")).kind).toBe("capped");
    await pruneExpiredPendingActions(env.DB, NOW);
    expect((await attempt("after")).kind).toBe("capped");
    const live = await env.DB.prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE owner_subject = 'd@x' AND expires_at > ?").bind(NOW.toISOString()).first<{ n: number }>();
    expect(live?.n).toBe(PENDING_ACTION_LIVE_CAP);
  });
});
