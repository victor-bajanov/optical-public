import { env, applyD1Migrations } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
// Vite ?raw import resolves to the file's string contents at build time,
// same pattern as test/setup.ts for every other migration.
import meetingPollSql from "../../migrations/0032_meeting_poll.sql?raw";
import guestRateLimitSql from "../../migrations/0033_poll_guest_rate_limit.sql?raw";
import joinAttemptsSql from "../../migrations/0034_poll_join_attempts.sql?raw";
import {
  createPoll,
  getPoll,
  getPollForSubject,
  listInvitees,
  getInviteeByTokenHash,
  insertInvitee,
  newInviteeId,
  replaceResponses,
  markResponded,
  setHideName,
  setInviteeTokenHash,
  setInviteeName,
  setPollDeadline,
  aggregateResponses,
  setPollStatus,
  casSetPollStatus,
  setBooked,
  casSetBooked,
  clearPollEpisodeStamps,
  markNudged,
  listOpenPollsDue,
  dropInvitee,
  recordJoinAttempt,
  countRecentJoinAttempts,
  restoreInvitee,
  setPollTitle,
  setPollLocation,
  setGuestTokenHash,
} from "../../src/db/polls";

// test/setup.ts's global beforeAll only knows migrations up to 0031 — it is
// out of this card's file fence (T1 owns only 0032_meeting_poll.sql, not the
// shared setup file). Applying 0032 here, additively, on top of whatever
// setup.ts already applied to this test file's isolated D1 instance keeps
// the new migration entirely within the card's file list. applyD1Migrations
// is idempotent per migration name, so this is safe even if a future task
// also applies it for the same isolated instance. 0033 (T11's own new
// migration) follows the identical pattern — test/setup.ts is out of T11's
// fence too.
beforeAll(async () => {
  await applyD1Migrations(env.DB, [
    { name: "0032_meeting_poll.sql", queries: [meetingPollSql] },
    { name: "0033_poll_guest_rate_limit.sql", queries: [guestRateLimitSql] },
    { name: "0034_poll_join_attempts.sql", queries: [joinAttemptsSql] },
  ]);
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM poll_responses"),
    env.DB.prepare("DELETE FROM poll_invitees"),
    env.DB.prepare("DELETE FROM bookings"),
    env.DB.prepare("DELETE FROM polls"),
  ]);
});

const LOCATION = { kind: "meet" as const };

function pollInput(overrides: Partial<Parameters<typeof createPoll>[1]> = {}) {
  return {
    subject: "owner@org",
    title: "Kickoff",
    durationMin: 30,
    rangeStart: "2026-08-17",
    rangeEnd: "2026-08-21",
    deadlineUtc: "2026-08-16T00:00:00Z",
    location: LOCATION,
    guestTokenHash: null,
    now: "2026-08-14T00:00:00Z",
    ...overrides,
  };
}

describe("createPoll / getPoll / getPollForSubject", () => {
  it("creates a poll with an open status and a p_ id", async () => {
    const poll = await createPoll(env.DB, pollInput());
    expect(poll.id).toMatch(/^p_/);
    expect(poll.status).toBe("open");
    expect(poll.title).toBe("Kickoff");
    expect(poll.location).toEqual(LOCATION);
    expect(poll.createdAt).toBe("2026-08-14T00:00:00Z");
  });

  it("getPoll round-trips every stored field", async () => {
    const created = await createPoll(env.DB, pollInput({ title: "Sync" }));
    const fetched = await getPoll(env.DB, created.id);
    expect(fetched).toEqual(created);
  });

  it("getPoll returns null for an unknown id", async () => {
    expect(await getPoll(env.DB, "p_missing")).toBeNull();
  });

  it("getPollForSubject is ownership-checked: wrong subject gets null", async () => {
    const poll = await createPoll(env.DB, pollInput({ subject: "owner@org" }));
    expect(await getPollForSubject(env.DB, "owner@org", poll.id)).toEqual(poll);
    expect(await getPollForSubject(env.DB, "someone-else@org", poll.id)).toBeNull();
  });
});

describe("newInviteeId", () => {
  it("mints a pi_-prefixed id", () => {
    expect(newInviteeId()).toMatch(/^pi_/);
  });

  it("mints a fresh id on every call", () => {
    expect(newInviteeId()).not.toBe(newInviteeId());
  });
});

describe("insertInvitee / listInvitees / getInviteeByTokenHash", () => {
  it("stores the CALLER-SUPPLIED id verbatim (id must be mintable before insertion, so the caller can bind a capability token's claims to it first)", async () => {
    const poll = await createPoll(env.DB, pollInput());
    const id = newInviteeId();
    const invitee = await insertInvitee(env.DB, {
      id,
      pollId: poll.id,
      email: "alice@org",
      name: "Alice",
      kind: "invited",
      tokenHash: "hash-a",
      pseudonym: "curious koala",
      now: "2026-08-14T00:00:00Z",
    });
    expect(invitee.id).toBe(id);
    expect(invitee.dropped).toBe(false);
    expect(invitee.hideName).toBe(false);
    expect(invitee.respondedAt).toBeNull();

    const listed = await listInvitees(env.DB, poll.id);
    expect(listed).toEqual([invitee]);
  });

  it("UNIQUE (poll_id, email) violation surfaces to the caller", async () => {
    const poll = await createPoll(env.DB, pollInput());
    const insert = () =>
      insertInvitee(env.DB, {
        id: newInviteeId(),
        pollId: poll.id,
        email: "dup@org",
        name: null,
        kind: "invited",
        tokenHash: "hash-1",
        pseudonym: "brave quokka",
        now: "2026-08-14T00:00:00Z",
      });
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  it("getInviteeByTokenHash resolves by (pollId, tokenHash) and rejects a foreign poll", async () => {
    const pollA = await createPoll(env.DB, pollInput({ subject: "a@org" }));
    const pollB = await createPoll(env.DB, pollInput({ subject: "b@org" }));
    const invitee = await insertInvitee(env.DB, {
      id: newInviteeId(),
      pollId: pollA.id,
      email: "bob@org",
      name: "Bob",
      kind: "invited",
      tokenHash: "hash-bob",
      pseudonym: "jolly pangolin",
      now: "2026-08-14T00:00:00Z",
    });
    expect(await getInviteeByTokenHash(env.DB, pollA.id, "hash-bob")).toEqual(invitee);
    expect(await getInviteeByTokenHash(env.DB, pollB.id, "hash-bob")).toBeNull();
    expect(await getInviteeByTokenHash(env.DB, pollA.id, "wrong-hash")).toBeNull();
  });
});

describe("insertInvitee ip_hash/created_at (0033)", () => {
  it("stores ipHash and the caller's `now` as created_at when ipHash is supplied", async () => {
    const poll = await createPoll(env.DB, pollInput());
    await insertInvitee(env.DB, {
      id: newInviteeId(),
      pollId: poll.id,
      email: "guest@org",
      name: "Guest",
      kind: "guest",
      tokenHash: "hash-guest",
      pseudonym: "curious koala",
      now: "2026-08-14T00:00:00Z",
      ipHash: "iphash-1",
    });
    const row = await env.DB.prepare("SELECT ip_hash, created_at FROM poll_invitees WHERE poll_id = ?")
      .bind(poll.id)
      .first<{ ip_hash: string | null; created_at: string | null }>();
    expect(row).toEqual({ ip_hash: "iphash-1", created_at: "2026-08-14T00:00:00Z" });
  });

  it("leaves ip_hash NULL when the caller supplies none (the organiser-invite path)", async () => {
    const poll = await createPoll(env.DB, pollInput());
    await insertInvitee(env.DB, {
      id: newInviteeId(),
      pollId: poll.id,
      email: "invited@org",
      name: "Invited",
      kind: "invited",
      tokenHash: "hash-invited",
      pseudonym: "brave otter",
      now: "2026-08-14T00:00:00Z",
    });
    const row = await env.DB.prepare("SELECT ip_hash, created_at FROM poll_invitees WHERE poll_id = ?")
      .bind(poll.id)
      .first<{ ip_hash: string | null; created_at: string | null }>();
    expect(row?.ip_hash).toBeNull();
    // created_at is still stamped from `now`, regardless of ipHash — every
    // insert has a `now`, only ipHash is guest-join-specific.
    expect(row?.created_at).toBe("2026-08-14T00:00:00Z");
  });
});

describe("recordJoinAttempt / countRecentJoinAttempts (0034)", () => {
  // R1-F1/R4-H2 fix: the old countRecentJoinsByIp counted poll_invitees rows
  // carrying ip_hash, but the already-invited and dropped-invitee join arms
  // never insert a new row — so those attempts were invisible to the
  // counter and the per-IP limit was bypassable against any known invitee
  // address. recordJoinAttempt/countRecentJoinAttempts are keyed on a
  // dedicated 0034 table instead, recorded regardless of what the join
  // route eventually does with the attempt.
  it("counts only this poll's ATTEMPT rows for this ip_hash at or after the window start", async () => {
    const poll = await createPoll(env.DB, pollInput());
    const otherPoll = await createPoll(env.DB, pollInput({ subject: "someone-else@org" }));
    await recordJoinAttempt(env.DB, poll.id, "ip-a", "2026-08-14T12:00:00Z");
    await recordJoinAttempt(env.DB, poll.id, "ip-a", "2026-08-13T00:00:00Z"); // before window
    await recordJoinAttempt(env.DB, poll.id, "ip-b", "2026-08-14T12:00:00Z"); // other ip
    await recordJoinAttempt(env.DB, otherPoll.id, "ip-a", "2026-08-14T12:00:00Z"); // other poll

    const count = await countRecentJoinAttempts(env.DB, poll.id, "ip-a", "2026-08-14T00:00:00Z");
    expect(count).toBe(1);
  });

  it("returns 0 when nothing matches", async () => {
    const poll = await createPoll(env.DB, pollInput());
    expect(await countRecentJoinAttempts(env.DB, poll.id, "unseen-ip", "2026-08-14T00:00:00Z")).toBe(0);
  });

  it("counts an attempt that never resulted in an invitee row (already-invited / dropped / at-cap arms)", async () => {
    // The exact gap the fix closes: NO poll_invitees row is inserted here at
    // all — recordJoinAttempt is the only trace, and it must still count.
    const poll = await createPoll(env.DB, pollInput());
    for (let i = 0; i < 3; i++) {
      await recordJoinAttempt(env.DB, poll.id, "attacker-ip", "2026-08-14T12:00:00Z");
    }
    expect(await countRecentJoinAttempts(env.DB, poll.id, "attacker-ip", "2026-08-14T00:00:00Z")).toBe(3);
    const invitees = await listInvitees(env.DB, poll.id);
    expect(invitees).toHaveLength(0);
  });
});

describe("replaceResponses", () => {
  it("fully replaces prior cells, leaving no stale rows", async () => {
    const poll = await createPoll(env.DB, pollInput());
    const invitee = await insertInvitee(env.DB, {
      id: newInviteeId(), pollId: poll.id, email: "c@org", name: "Carol", kind: "invited",
      tokenHash: "hash-c", pseudonym: "swift narwhal", now: "2026-08-14T00:00:00Z",
    });
    await replaceResponses(env.DB, invitee.id, [
      { cellStartUtc: "2026-08-17T09:00:00Z", state: "free" },
      { cellStartUtc: "2026-08-17T09:30:00Z", state: "if_needed" },
    ]);
    let cells = await aggregateResponses(env.DB, poll.id);
    expect(cells.byInvitee.find((b) => b.inviteeId === invitee.id)?.cells).toHaveLength(2);

    await replaceResponses(env.DB, invitee.id, [
      { cellStartUtc: "2026-08-18T10:00:00Z", state: "free" },
    ]);
    cells = await aggregateResponses(env.DB, poll.id);
    const rows = cells.byInvitee.find((b) => b.inviteeId === invitee.id)?.cells ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ cellStartUtc: "2026-08-18T10:00:00Z", state: "free" });
  });

  it("replacing with an empty list clears all cells", async () => {
    const poll = await createPoll(env.DB, pollInput());
    const invitee = await insertInvitee(env.DB, {
      id: newInviteeId(), pollId: poll.id, email: "d@org", name: "Dan", kind: "invited",
      tokenHash: "hash-d", pseudonym: "mellow octopus", now: "2026-08-14T00:00:00Z",
    });
    await replaceResponses(env.DB, invitee.id, [{ cellStartUtc: "2026-08-17T09:00:00Z", state: "free" }]);
    await replaceResponses(env.DB, invitee.id, []);
    const cells = await aggregateResponses(env.DB, poll.id);
    expect(cells.byInvitee.find((b) => b.inviteeId === invitee.id)?.cells ?? []).toHaveLength(0);
  });
});

describe("markResponded / setHideName / dropInvitee", () => {
  it("markResponded stamps responded_at", async () => {
    const poll = await createPoll(env.DB, pollInput());
    const invitee = await insertInvitee(env.DB, {
      id: newInviteeId(), pollId: poll.id, email: "e@org", name: "Eve", kind: "invited",
      tokenHash: "hash-e", pseudonym: "gentle wallaby", now: "2026-08-14T00:00:00Z",
    });
    await markResponded(env.DB, invitee.id, "2026-08-15T12:00:00Z");
    const rows = await listInvitees(env.DB, poll.id);
    expect(rows.find((r) => r.id === invitee.id)?.respondedAt).toBe("2026-08-15T12:00:00Z");
  });

  it("setHideName toggles the flag", async () => {
    const poll = await createPoll(env.DB, pollInput());
    const invitee = await insertInvitee(env.DB, {
      id: newInviteeId(), pollId: poll.id, email: "f@org", name: "Finn", kind: "invited",
      tokenHash: "hash-f", pseudonym: "spry meerkat", now: "2026-08-14T00:00:00Z",
    });
    await setHideName(env.DB, invitee.id, true);
    let rows = await listInvitees(env.DB, poll.id);
    expect(rows.find((r) => r.id === invitee.id)?.hideName).toBe(true);
    await setHideName(env.DB, invitee.id, false);
    rows = await listInvitees(env.DB, poll.id);
    expect(rows.find((r) => r.id === invitee.id)?.hideName).toBe(false);
  });

  it("dropInvitee marks dropped", async () => {
    const poll = await createPoll(env.DB, pollInput());
    const invitee = await insertInvitee(env.DB, {
      id: newInviteeId(), pollId: poll.id, email: "g@org", name: "Gail", kind: "invited",
      tokenHash: "hash-g", pseudonym: "vivid capybara", now: "2026-08-14T00:00:00Z",
    });
    await dropInvitee(env.DB, invitee.id);
    const rows = await listInvitees(env.DB, poll.id);
    expect(rows.find((r) => r.id === invitee.id)?.dropped).toBe(true);
  });
});

describe("setInviteeTokenHash", () => {
  it("replaces the stored hash so re-issued tokens resolve and the old hash no longer does", async () => {
    const poll = await createPoll(env.DB, pollInput());
    const invitee = await insertInvitee(env.DB, {
      id: newInviteeId(), pollId: poll.id, email: "reissue@org", name: "Ray", kind: "invited",
      tokenHash: "hash-old", pseudonym: "clever meerkat", now: "2026-08-14T00:00:00Z",
    });
    await setInviteeTokenHash(env.DB, invitee.id, "hash-new");

    expect(await getInviteeByTokenHash(env.DB, poll.id, "hash-old")).toBeNull();
    const resolved = await getInviteeByTokenHash(env.DB, poll.id, "hash-new");
    expect(resolved?.id).toBe(invitee.id);
    expect(resolved?.tokenHash).toBe("hash-new");
  });
});

describe("setInviteeName", () => {
  it("updates the display name a respondent adjusts on submit", async () => {
    const poll = await createPoll(env.DB, pollInput());
    const invitee = await insertInvitee(env.DB, {
      id: newInviteeId(), pollId: poll.id, email: "rename@org", name: "Original Name", kind: "invited",
      tokenHash: "hash-rename", pseudonym: "tranquil quokka", now: "2026-08-14T00:00:00Z",
    });
    await setInviteeName(env.DB, invitee.id, "New Name");
    const rows = await listInvitees(env.DB, poll.id);
    expect(rows.find((r) => r.id === invitee.id)?.name).toBe("New Name");
  });
});

describe("aggregateResponses", () => {
  it("returns per-cell free/if_needed counts, excluding dropped invitees", async () => {
    const poll = await createPoll(env.DB, pollInput());
    const a = await insertInvitee(env.DB, {
      id: newInviteeId(), pollId: poll.id, email: "h1@org", name: "H1", kind: "invited",
      tokenHash: "hash-h1", pseudonym: "nimble chinchilla", now: "2026-08-14T00:00:00Z",
    });
    const b = await insertInvitee(env.DB, {
      id: newInviteeId(), pollId: poll.id, email: "h2@org", name: "H2", kind: "invited",
      tokenHash: "hash-h2", pseudonym: "dapper axolotl", now: "2026-08-14T00:00:00Z",
    });
    const dropped = await insertInvitee(env.DB, {
      id: newInviteeId(), pollId: poll.id, email: "h3@org", name: "H3", kind: "invited",
      tokenHash: "hash-h3", pseudonym: "wandering platypus", now: "2026-08-14T00:00:00Z",
    });
    await dropInvitee(env.DB, dropped.id);
    await replaceResponses(env.DB, a.id, [{ cellStartUtc: "2026-08-17T09:00:00Z", state: "free" }]);
    await replaceResponses(env.DB, b.id, [{ cellStartUtc: "2026-08-17T09:00:00Z", state: "if_needed" }]);
    await replaceResponses(env.DB, dropped.id, [{ cellStartUtc: "2026-08-17T09:00:00Z", state: "free" }]);

    const agg = await aggregateResponses(env.DB, poll.id);
    const cell = agg.cellCounts.find((c) => c.cellStartUtc === "2026-08-17T09:00:00Z");
    expect(cell).toEqual({ cellStartUtc: "2026-08-17T09:00:00Z", free: 1, ifNeeded: 1 });
  });
});

describe("setPollStatus", () => {
  it("updates status, and stamps escalated_at only once for needs_attention", async () => {
    const poll = await createPoll(env.DB, pollInput());
    await setPollStatus(env.DB, poll.id, "needs_attention", "2026-08-15T00:00:00Z");
    let fetched = await getPoll(env.DB, poll.id);
    expect(fetched?.status).toBe("needs_attention");
    expect(fetched?.escalatedAt).toBe("2026-08-15T00:00:00Z");

    // A second escalation sweep must not move the stamp (idempotent).
    await setPollStatus(env.DB, poll.id, "needs_attention", "2026-08-16T00:00:00Z");
    fetched = await getPoll(env.DB, poll.id);
    expect(fetched?.escalatedAt).toBe("2026-08-15T00:00:00Z");
  });

  it("plain transitions (e.g. cancelled) do not touch escalated_at", async () => {
    const poll = await createPoll(env.DB, pollInput());
    await setPollStatus(env.DB, poll.id, "cancelled", "2026-08-15T00:00:00Z");
    const fetched = await getPoll(env.DB, poll.id);
    expect(fetched?.status).toBe("cancelled");
    expect(fetched?.escalatedAt).toBeNull();
  });
});

describe("casSetPollStatus", () => {
  it("transitions from an allowed status and stamps escalated_at (needs_attention)", async () => {
    const poll = await createPoll(env.DB, pollInput());
    const moved = await casSetPollStatus(env.DB, poll.id, "needs_attention", ["open"], "2026-08-15T00:00:00Z");
    expect(moved).toBe(true);
    const fetched = await getPoll(env.DB, poll.id);
    expect(fetched?.status).toBe("needs_attention");
    expect(fetched?.escalatedAt).toBe("2026-08-15T00:00:00Z");
  });

  it("a second call preserves the earlier escalated_at stamp (COALESCE)", async () => {
    const poll = await createPoll(env.DB, pollInput());
    await casSetPollStatus(env.DB, poll.id, "needs_attention", ["open"], "2026-08-15T00:00:00Z");
    const moved = await casSetPollStatus(
      env.DB, poll.id, "needs_attention", ["open", "needs_attention"], "2026-08-16T00:00:00Z",
    );
    expect(moved).toBe(true);
    const fetched = await getPoll(env.DB, poll.id);
    expect(fetched?.escalatedAt).toBe("2026-08-15T00:00:00Z");
  });

  it("returns false and leaves a booked poll untouched when fromStatuses doesn't match", async () => {
    const poll = await createPoll(env.DB, pollInput());
    await setBooked(env.DB, poll.id, "2026-08-18T09:00:00Z", "evt-cas");
    const moved = await casSetPollStatus(env.DB, poll.id, "needs_attention", ["open"], "2026-08-15T00:00:00Z");
    expect(moved).toBe(false);
    const fetched = await getPoll(env.DB, poll.id);
    expect(fetched?.status).toBe("booked");
    expect(fetched?.escalatedAt).toBeNull();
  });

  it("throws on an empty fromStatuses (programming mistake, not a runtime condition)", async () => {
    const poll = await createPoll(env.DB, pollInput());
    await expect(casSetPollStatus(env.DB, poll.id, "needs_attention", [], "2026-08-15T00:00:00Z")).rejects.toThrow();
  });
});

describe("setBooked", () => {
  it("sets status booked, booked_slot_utc and gcal_event_id", async () => {
    const poll = await createPoll(env.DB, pollInput());
    await setBooked(env.DB, poll.id, "2026-08-18T09:00:00Z", "gcal-evt-1");
    const fetched = await getPoll(env.DB, poll.id);
    expect(fetched?.status).toBe("booked");
    expect(fetched?.bookedSlotUtc).toBe("2026-08-18T09:00:00Z");
    expect(fetched?.gcalEventId).toBe("gcal-evt-1");
  });
});

describe("casSetBooked", () => {
  it("books an open poll when 'open' is in fromStatuses", async () => {
    const poll = await createPoll(env.DB, pollInput());
    const moved = await casSetBooked(env.DB, poll.id, "2026-08-18T09:00:00Z", "evt-1", ["open", "needs_attention"]);
    expect(moved).toBe(true);
    const fetched = await getPoll(env.DB, poll.id);
    expect(fetched?.status).toBe("booked");
    expect(fetched?.bookedSlotUtc).toBe("2026-08-18T09:00:00Z");
    expect(fetched?.gcalEventId).toBe("evt-1");
  });

  it("books an escalated (needs_attention) poll — the resolved-then-booked path", async () => {
    const poll = await createPoll(env.DB, pollInput());
    await setPollStatus(env.DB, poll.id, "needs_attention", "2026-08-15T00:00:00Z");
    const moved = await casSetBooked(env.DB, poll.id, "2026-08-18T09:00:00Z", "evt-2", ["open", "needs_attention"]);
    expect(moved).toBe(true);
    const fetched = await getPoll(env.DB, poll.id);
    expect(fetched?.status).toBe("booked");
  });

  it("returns false and leaves a cancelled poll's status/slot/event completely unchanged", async () => {
    const poll = await createPoll(env.DB, pollInput());
    await setPollStatus(env.DB, poll.id, "cancelled", "2026-08-15T00:00:00Z");
    const moved = await casSetBooked(env.DB, poll.id, "2026-08-18T09:00:00Z", "evt-3", ["open", "needs_attention"]);
    expect(moved).toBe(false);
    const fetched = await getPoll(env.DB, poll.id);
    expect(fetched?.status).toBe("cancelled");
    expect(fetched?.bookedSlotUtc).toBeNull();
    expect(fetched?.gcalEventId).toBeNull();
  });

  it("throws on an empty fromStatuses", async () => {
    const poll = await createPoll(env.DB, pollInput());
    await expect(casSetBooked(env.DB, poll.id, "2026-08-18T09:00:00Z", "evt-4", [])).rejects.toThrow();
  });
});

describe("setPollDeadline", () => {
  it("updates deadline_utc only, leaving status untouched", async () => {
    const poll = await createPoll(env.DB, pollInput({ deadlineUtc: "2026-08-16T00:00:00Z" }));
    await setPollStatus(env.DB, poll.id, "needs_attention", "2026-08-15T00:00:00Z");

    await setPollDeadline(env.DB, poll.id, "2026-08-20T00:00:00Z");

    const fetched = await getPoll(env.DB, poll.id);
    expect(fetched?.deadlineUtc).toBe("2026-08-20T00:00:00Z");
    // extendDeadline's status flip back to 'open' is the caller's job (via
    // setPollStatus) — this primitive stays narrow to just the deadline column.
    expect(fetched?.status).toBe("needs_attention");
  });
});

describe("markNudged", () => {
  it("stamps nudged_midpoint_at and nudged_final_at independently", async () => {
    const poll = await createPoll(env.DB, pollInput());
    await markNudged(env.DB, poll.id, "midpoint", "2026-08-15T00:00:00Z");
    let fetched = await getPoll(env.DB, poll.id);
    expect(fetched?.nudgedMidpointAt).toBe("2026-08-15T00:00:00Z");
    expect(fetched?.nudgedFinalAt).toBeNull();

    await markNudged(env.DB, poll.id, "final", "2026-08-15T12:00:00Z");
    fetched = await getPoll(env.DB, poll.id);
    expect(fetched?.nudgedMidpointAt).toBe("2026-08-15T00:00:00Z");
    expect(fetched?.nudgedFinalAt).toBe("2026-08-15T12:00:00Z");
  });
});

describe("clearPollEpisodeStamps", () => {
  it("clears escalated_at/nudged_midpoint_at/nudged_final_at, leaving status and deadline_utc untouched", async () => {
    const poll = await createPoll(env.DB, pollInput({ deadlineUtc: "2026-08-16T00:00:00Z" }));
    await setPollStatus(env.DB, poll.id, "needs_attention", "2026-08-15T00:00:00Z");
    await markNudged(env.DB, poll.id, "midpoint", "2026-08-14T12:00:00Z");
    await markNudged(env.DB, poll.id, "final", "2026-08-15T00:00:00Z");

    await clearPollEpisodeStamps(env.DB, poll.id);

    const fetched = await getPoll(env.DB, poll.id);
    expect(fetched?.escalatedAt).toBeNull();
    expect(fetched?.nudgedMidpointAt).toBeNull();
    expect(fetched?.nudgedFinalAt).toBeNull();
    expect(fetched?.status).toBe("needs_attention");
    expect(fetched?.deadlineUtc).toBe("2026-08-16T00:00:00Z");
  });
});

describe("listOpenPollsDue", () => {
  it("returns only status='open' polls for the given subject", async () => {
    const open = await createPoll(env.DB, pollInput({ subject: "s@org" }));
    const booked = await createPoll(env.DB, pollInput({ subject: "s@org" }));
    const cancelled = await createPoll(env.DB, pollInput({ subject: "s@org" }));
    const escalated = await createPoll(env.DB, pollInput({ subject: "s@org" }));
    const otherSubject = await createPoll(env.DB, pollInput({ subject: "other@org" }));
    await setBooked(env.DB, booked.id, "2026-08-18T09:00:00Z", "evt");
    await setPollStatus(env.DB, cancelled.id, "cancelled", "2026-08-15T00:00:00Z");
    await setPollStatus(env.DB, escalated.id, "needs_attention", "2026-08-15T00:00:00Z");

    const due = await listOpenPollsDue(env.DB, "s@org", "2026-08-15T00:00:00Z");
    expect(due.map((p) => p.id)).toEqual([open.id]);

    const dueOther = await listOpenPollsDue(env.DB, "other@org", "2026-08-15T00:00:00Z");
    expect(dueOther.map((p) => p.id)).toEqual([otherSubject.id]);
  });
});

// Card A (updateMeetingPoll plan) — four narrow single-column setters,
// deliberately not folded into one "update poll" function so no primitive
// can revive a cancelled poll or touch status as a side effect.
describe("restoreInvitee", () => {
  it("flips dropped 1->0, leaving id/email/pseudonym/respondedAt/painted cells untouched, and doesn't disturb other dropped invitees", async () => {
    const poll = await createPoll(env.DB, pollInput());
    const otherPoll = await createPoll(env.DB, pollInput({ subject: "someone-else@org" }));
    const invitee = await insertInvitee(env.DB, {
      id: newInviteeId(), pollId: poll.id, email: "restore@org", name: "Rita", kind: "invited",
      tokenHash: "hash-restore", pseudonym: "quiet ocelot", now: "2026-08-14T00:00:00Z",
    });
    // A second dropped invitee on the SAME poll, and one on a DIFFERENT poll —
    // restoreInvitee must be scoped to just the targeted row (an unscoped
    // `SET dropped = 0` would revive these too).
    const sibling = await insertInvitee(env.DB, {
      id: newInviteeId(), pollId: poll.id, email: "sibling@org", name: "Sam", kind: "invited",
      tokenHash: "hash-sibling", pseudonym: "steady ibis", now: "2026-08-14T00:00:00Z",
    });
    const otherPollInvitee = await insertInvitee(env.DB, {
      id: newInviteeId(), pollId: otherPoll.id, email: "elsewhere@org", name: "Elle", kind: "invited",
      tokenHash: "hash-elsewhere", pseudonym: "keen heron", now: "2026-08-14T00:00:00Z",
    });
    await markResponded(env.DB, invitee.id, "2026-08-15T00:00:00Z");
    await replaceResponses(env.DB, invitee.id, [
      { cellStartUtc: "2026-08-17T09:00:00Z", state: "free" },
    ]);
    await dropInvitee(env.DB, invitee.id);
    await dropInvitee(env.DB, sibling.id);
    await dropInvitee(env.DB, otherPollInvitee.id);
    let rows = await listInvitees(env.DB, poll.id);
    expect(rows.find((r) => r.id === invitee.id)?.dropped).toBe(true);

    // Dropped while the invitee was out — excluded from aggregates.
    let agg = await aggregateResponses(env.DB, poll.id);
    expect(agg.cellCounts.find((c) => c.cellStartUtc === "2026-08-17T09:00:00Z")).toBeUndefined();

    await restoreInvitee(env.DB, invitee.id);

    rows = await listInvitees(env.DB, poll.id);
    const restored = rows.find((r) => r.id === invitee.id);
    expect(restored?.dropped).toBe(false);
    expect(restored?.id).toBe(invitee.id);
    expect(restored?.email).toBe("restore@org");
    expect(restored?.pseudonym).toBe("quiet ocelot");
    expect(restored?.respondedAt).toBe("2026-08-15T00:00:00Z");

    // The sibling dropped invitee (same poll) and the dropped invitee on a
    // different poll are untouched — restoreInvitee only moved the targeted row.
    expect(rows.find((r) => r.id === sibling.id)?.dropped).toBe(true);
    const otherPollRows = await listInvitees(env.DB, otherPoll.id);
    expect(otherPollRows.find((r) => r.id === otherPollInvitee.id)?.dropped).toBe(true);

    const byInvitee = (await aggregateResponses(env.DB, poll.id)).byInvitee.find((b) => b.inviteeId === invitee.id)?.cells;
    expect(byInvitee).toEqual([{ cellStartUtc: "2026-08-17T09:00:00Z", state: "free" }]);

    // A restore revives the cell into the aggregate counts too — while dropped
    // it was excluded (checked above); once restored it counts again.
    agg = await aggregateResponses(env.DB, poll.id);
    expect(agg.cellCounts.find((c) => c.cellStartUtc === "2026-08-17T09:00:00Z")).toEqual({
      cellStartUtc: "2026-08-17T09:00:00Z", free: 1, ifNeeded: 0,
    });
  });

  it("restoring a non-dropped row is a harmless no-op", async () => {
    const poll = await createPoll(env.DB, pollInput());
    const invitee = await insertInvitee(env.DB, {
      id: newInviteeId(), pollId: poll.id, email: "never-dropped@org", name: "Nate", kind: "invited",
      tokenHash: "hash-never-dropped", pseudonym: "bold heron", now: "2026-08-14T00:00:00Z",
    });
    const sibling = await insertInvitee(env.DB, {
      id: newInviteeId(), pollId: poll.id, email: "sibling-never@org", name: "Sid", kind: "invited",
      tokenHash: "hash-sibling-never", pseudonym: "calm ibis", now: "2026-08-14T00:00:00Z",
    });
    await dropInvitee(env.DB, sibling.id);

    await restoreInvitee(env.DB, invitee.id);

    const rows = await listInvitees(env.DB, poll.id);
    const untouched = rows.find((r) => r.id === invitee.id);
    expect(untouched?.dropped).toBe(false);
    expect(untouched?.email).toBe("never-dropped@org");
    expect(untouched?.pseudonym).toBe("bold heron");
    expect(untouched?.respondedAt).toBeNull();
    // A dropped sibling in the same poll must stay dropped.
    expect(rows.find((r) => r.id === sibling.id)?.dropped).toBe(true);
  });
});

describe("setPollTitle", () => {
  it("updates only title, leaving status untouched (including a cancelled poll — a mutated setter that also wrote status='open' would revive it)", async () => {
    const poll = await createPoll(env.DB, pollInput({ title: "Old Title" }));
    await setPollStatus(env.DB, poll.id, "needs_attention", "2026-08-15T00:00:00Z");

    await setPollTitle(env.DB, poll.id, "New Title");

    const fetched = await getPoll(env.DB, poll.id);
    expect(fetched?.title).toBe("New Title");
    // Every other field is untouched.
    expect(fetched?.location).toEqual(LOCATION);
    expect(fetched?.status).toBe("needs_attention");
    expect(fetched?.deadlineUtc).toBe(poll.deadlineUtc);
  });
});

describe("setPollLocation", () => {
  it("stores the JSON-serialised location, read back via getPoll as the parsed object, without reviving a cancelled poll", async () => {
    const poll = await createPoll(env.DB, pollInput({ location: { kind: "meet" } }));
    await setPollStatus(env.DB, poll.id, "cancelled", "2026-08-15T00:00:00Z");
    const newLocation = { kind: "in_person", detail: "42 Example St" };

    await setPollLocation(env.DB, poll.id, newLocation);

    const fetched = await getPoll(env.DB, poll.id);
    expect(fetched?.location).toEqual(newLocation);
    // title/status untouched — a mutated setter that also wrote status='open'
    // would incorrectly revive this cancelled poll.
    expect(fetched?.title).toBe(poll.title);
    expect(fetched?.status).toBe("cancelled");
  });
});

describe("setGuestTokenHash", () => {
  it("sets the hash without touching status on an escalated poll", async () => {
    const poll = await createPoll(env.DB, pollInput({ guestTokenHash: null }));
    await setPollStatus(env.DB, poll.id, "needs_attention", "2026-08-15T00:00:00Z");

    await setGuestTokenHash(env.DB, poll.id, "hash-guest-link");

    const fetched = await getPoll(env.DB, poll.id);
    expect(fetched?.guestTokenHash).toBe("hash-guest-link");
    expect(fetched?.status).toBe("needs_attention");
  });

  it("clears the hash back to null without reviving a cancelled poll", async () => {
    const poll = await createPoll(env.DB, pollInput({ guestTokenHash: "hash-initial" }));
    await setPollStatus(env.DB, poll.id, "cancelled", "2026-08-15T00:00:00Z");

    await setGuestTokenHash(env.DB, poll.id, null);

    const fetched = await getPoll(env.DB, poll.id);
    expect(fetched?.guestTokenHash).toBeNull();
    expect(fetched?.status).toBe("cancelled");
  });
});
