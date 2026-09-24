import { env, applyD1Migrations } from "cloudflare:test";
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { offboardUser } from "../../src/lifecycle/offboard";
import { upsertUser, getUser } from "../../src/db/users";
import { ProviderDisabledError } from "../../src/index-providers";
// Vite ?raw import resolves to the file's string contents at build time, same
// pattern as test/setup.ts for every other migration. Applied locally here
// (rather than in the shared setup file, which is outside this correction's
// file fence) so the poll tables exist for this test file's isolated D1.
import meetingPollSql from "../../migrations/0032_meeting_poll.sql?raw";
import guestRateLimitSql from "../../migrations/0033_poll_guest_rate_limit.sql?raw";
import joinAttemptsSql from "../../migrations/0034_poll_join_attempts.sql?raw";

beforeAll(async () => {
  await applyD1Migrations(env.DB, [
    { name: "0032_meeting_poll.sql", queries: [meetingPollSql] },
    { name: "0033_poll_guest_rate_limit.sql", queries: [guestRateLimitSql] },
    { name: "0034_poll_join_attempts.sql", queries: [joinAttemptsSql] },
  ]);
});

const SUBJECT = "leaver@org";

async function seedSubject() {
  await upsertUser(env.DB, SUBJECT);
  await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .bind("t1", SUBJECT, "{}", "pending", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z").run();
  await env.DB.prepare("INSERT INTO task_templates (id, owner_subject, body) VALUES (?,?,?)")
    .bind("tt1", SUBJECT, "{}").run();
  await env.DB.prepare("INSERT INTO projects (id, owner_subject, body) VALUES (?,?,?)")
    .bind("p1", SUBJECT, "{}").run();
  await env.DB.prepare("INSERT INTO proposed_plans (plan_hash, body, created_at, expires_at, committed_at, subject) VALUES (?,?,?,?,?,?)")
    .bind("h1", JSON.stringify({ account_email: SUBJECT, schedule: [], dropped: [] }), "2026-01-01T00:00:00Z", "2099-01-01T00:00:00Z", null, SUBJECT).run();
  await env.DB.prepare("INSERT OR REPLACE INTO identity_tokens (account_email, refresh_token_encrypted, scopes, updated_at) VALUES (?,?,?,?)")
    .bind(SUBJECT, new Uint8Array([1, 2, 3]).buffer, "s", "2026-01-01T00:00:00Z").run();
  await env.DB.prepare("INSERT INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?,?,?,?,?,?,?)")
    .bind("hh1", "c1", "scheduler:read", "2099-01-01T00:00:00Z", null, null, SUBJECT).run();
  await env.DB.prepare("INSERT INTO oauth_codes (code_hash, client_id, kind, scopes, expires_at, subject) VALUES (?,?,?,?,?,?)")
    .bind("ch1", "c1", "auth", "scheduler:read", "2099-01-01T00:00:00Z", SUBJECT).run();
  await env.DB.prepare("INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url) VALUES (?,?,?,?,?,?,?,?)")
    .bind(SUBJECT, "primary", null, "chan-1", "tok", "2099-01-01T00:00:00Z", "res-1", "https://cb").run();
  await env.GOOGLE_TOKEN_CACHE.put("idp_access_token:" + SUBJECT, "cached", { expirationTtl: 600 });
}

beforeEach(async () => {
  // Child-first: poll_responses/poll_invitees FK into poll_invitees/polls;
  // poll_join_attempts references polls.id directly (no FK, but scoped the
  // same transitive way for offboard purposes).
  for (const t of ["users", "tasks", "task_templates", "projects", "proposed_plans", "identity_tokens", "oauth_tokens", "oauth_codes", "calendar_sync", "audit_log", "template_exclusions", "calendar_feed_tokens", "poll_responses", "poll_invitees", "poll_join_attempts", "polls"]) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
});

describe("offboardUser", () => {
  it("stops the channel, deletes every per-user store, deactivates, and audits", async () => {
    await seedSubject();
    const stopped: Array<{ channelId: string; resourceId: string }> = [];
    const calendarFor = () => ({
      stopChannel: async (channelId: string, resourceId: string) => { stopped.push({ channelId, resourceId }); },
    }) as any;

    await offboardUser(env, SUBJECT, "admin@org", { calendarFor });

    expect(stopped).toEqual([{ channelId: "chan-1", resourceId: "res-1" }]);

    for (const [table, col] of [["tasks", "owner_subject"], ["task_templates", "owner_subject"], ["projects", "owner_subject"], ["calendar_sync", "owner_subject"], ["identity_tokens", "account_email"], ["oauth_tokens", "subject"], ["oauth_codes", "subject"], ["proposed_plans", "subject"]] as const) {
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).bind(SUBJECT).first<{ n: number }>();
      expect(n?.n, `${table} should be empty`).toBe(0);
    }
    expect(await env.GOOGLE_TOKEN_CACHE.get("idp_access_token:" + SUBJECT)).toBeNull();
    expect((await getUser(env.DB, SUBJECT))?.is_active).toBe(0);
    const audit = await env.DB.prepare("SELECT subject, actor, action, source FROM audit_log").first<Record<string, unknown>>();
    expect(audit).toEqual({ subject: SUBJECT, actor: "admin@org", action: "offboard", source: "admin" });
  });

  it("stops a Microsoft channel whose stored resourceId is the empty string", async () => {
    await seedSubject();
    await env.DB.prepare("UPDATE calendar_sync SET channel_resource_id = '' WHERE owner_subject = ?")
      .bind(SUBJECT).run();
    const stopped: Array<{ channelId: string; resourceId: string }> = [];
    const calendarFor = () => ({
      stopChannel: async (channelId: string, resourceId: string) => { stopped.push({ channelId, resourceId }); },
    }) as any;

    await offboardUser(env, SUBJECT, "admin@org", { calendarFor });

    expect(stopped).toEqual([{ channelId: "chan-1", resourceId: "" }]);
  });

  it("completes the deletes when the calendar provider cannot be constructed (MS kill switch)", async () => {
    await seedSubject();
    const calendarFor = () => { throw new ProviderDisabledError(); };
    await expect(offboardUser(env, SUBJECT, "admin@org", { calendarFor })).resolves.toBeUndefined();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM identity_tokens WHERE account_email = ?").bind(SUBJECT).first<{ n: number }>();
    expect(n?.n).toBe(0);
    expect((await getUser(env.DB, SUBJECT))?.is_active).toBe(0);
  });

  it("aborts BEFORE deleting rows when provider construction fails for a reason other than the kill switch", async () => {
    await seedSubject();
    const calendarFor = () => { throw new Error("d1 transient failure"); };
    await expect(offboardUser(env, SUBJECT, "admin@org", { calendarFor })).rejects.toThrow("d1 transient failure");
    // A transient error (D1 outage, KV failure, ...) is not the same as "this
    // subject's provider is intentionally disabled" — must not be silently
    // swallowed into a degraded offboard that still deletes everything.
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM identity_tokens WHERE account_email = ?").bind(SUBJECT).first<{ n: number }>();
    expect(n?.n).toBe(1);
    expect((await getUser(env.DB, SUBJECT))?.is_active).toBe(1);
  });

  it("still completes the deletes when the channel stop throws", async () => {
    await seedSubject();
    const calendarFor = () => ({ stopChannel: async () => { throw new Error("google down"); } }) as any;
    await expect(offboardUser(env, SUBJECT, "admin@org", { calendarFor })).resolves.toBeUndefined();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM identity_tokens WHERE account_email = ?").bind(SUBJECT).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("no-ops the channel stop when the subject has no calendar_sync row", async () => {
    await upsertUser(env.DB, SUBJECT);
    let called = false;
    const calendarFor = () => ({ stopChannel: async () => { called = true; } }) as any;
    await offboardUser(env, SUBJECT, "admin@org", { calendarFor });
    expect(called).toBe(false);
    expect((await getUser(env.DB, SUBJECT))?.is_active).toBe(0);
  });

  it("deletes the user's template_exclusions", async () => {
    await env.DB.prepare("INSERT INTO template_exclusions (owner_subject, template_id, occurrence_date, created_at) VALUES (?, ?, ?, ?)")
      .bind("subject-z", "tpl-1", "2026-06-15", "2026-06-10T00:00:00Z").run();

    await offboardUser(env, "subject-z", "admin-actor");

    const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM template_exclusions WHERE owner_subject='subject-z'").first<{ c: number }>();
    expect(count?.c).toBe(0);
  });

  it("OS2+L9: deletes the victim's feed tokens and per-user config, sparing bystander and __default__", async () => {
    const V = "victim@org";
    const B = "bystander@org";
    await upsertUser(env.DB, V);
    await upsertUser(env.DB, B);

    // Clean config so the only rows are the ones we seed here.
    for (const t of ["config_weights", "config_contexts", "config_business_hours", "calendar_feed_tokens"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }

    // calendar_feed_tokens (OS2)
    for (const s of [V, B]) {
      await env.DB.prepare("INSERT INTO calendar_feed_tokens (id, owner_subject, token_hash, created_at) VALUES (?,?,?,?)")
        .bind(`feed-${s}`, s, `hash-${s}`, "2026-01-01T00:00:00Z").run();
    }

    // config_* (L9) — victim, bystander, and the __default__ sentinel.
    for (const s of [V, B, "__default__"]) {
      await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES (?,?)").bind(s, "{}").run();
      await env.DB.prepare("INSERT INTO config_contexts (owner_subject, context, body) VALUES (?,?,?)").bind(s, "deep", "{}").run();
      await env.DB.prepare("INSERT INTO config_business_hours (owner_subject, body) VALUES (?,?)").bind(s, "{}").run();
    }

    await offboardUser(env, V, "admin@org");

    const count = async (table: string, subject: string) =>
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner_subject = ?`).bind(subject).first<{ n: number }>())?.n;

    for (const table of ["calendar_feed_tokens", "config_weights", "config_contexts", "config_business_hours"]) {
      expect(await count(table, V), `${table} victim rows`).toBe(0);
      expect(await count(table, B), `${table} bystander rows`).toBe(1);
    }
    // __default__ is the shared config sentinel; it is seeded only for the
    // config_* tables (calendar_feed_tokens has no sentinel) and must survive.
    for (const table of ["config_weights", "config_contexts", "config_business_hours"]) {
      expect(await count(table, "__default__"), `${table} __default__ row`).toBe(1);
    }
  });

  it("OS3: deletes only in-horizon scheduler-owned events on offboard", async () => {
    const S = "os3@org";
    await upsertUser(env.DB, S);

    const dayMs = 24 * 60 * 60 * 1000;
    const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * dayMs).toISOString();
    const scheduler = (id: string, startDays: number) => ({
      id,
      summary: "chunk",
      start: iso(startDays),
      end: iso(startDays),
      extendedProperties: { private: { scheduler_chunk_id: `${id}#0` } },
    });
    const userEvent = {
      id: "user-evt",
      summary: "lunch",
      start: iso(2),
      end: iso(2),
      extendedProperties: { private: {} },
    };

    const deleted: string[] = [];
    const calendarFor = () => ({
      stopChannel: async () => {},
      fetchEventsInWindow: async () => ({
        events: [scheduler("chunk-soon", 2), scheduler("chunk-far", 400), userEvent],
      }),
      deleteEvent: async (id: string) => { deleted.push(id); },
    }) as any;

    await offboardUser(env, S, "admin@org", { calendarFor });

    expect(deleted).toEqual(["chunk-soon"]);
  });

  it("OS3: a calendar sweep failure does not block D1 deletion", async () => {
    const S = "os3-fail@org";
    await upsertUser(env.DB, S);
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .bind("os3-task", S, "{}", "pending", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z").run();

    const calendarFor = () => ({
      stopChannel: async () => {},
      fetchEventsInWindow: async () => { throw new Error("google down"); },
      deleteEvent: async () => {},
    }) as any;

    await expect(offboardUser(env, S, "admin@org", { calendarFor })).resolves.toBeUndefined();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE owner_subject = ?").bind(S).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("sweeps booking page config and bookings on offboard", async () => {
    const S = "gone@org";
    await upsertUser(env.DB, S);
    await env.DB.prepare("INSERT INTO config_booking_page (owner_subject, slug, body) VALUES (?,?,?)")
      .bind(S, "goneslug", "{}").run();
    await env.DB.prepare(
      `INSERT INTO bookings (id, owner_subject, slug, start_utc, end_utc, duration_minutes,
         booker_name, booker_email, ip_hash, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      "b-gone", S, "goneslug", "2026-08-03T00:00:00Z", "2026-08-03T00:30:00Z", 30,
      "Sam", "sam@x.com", "h", "confirmed", "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z",
    ).run();

    await offboardUser(env, S, "admin@org");

    for (const t of ["config_booking_page", "bookings"]) {
      const row = await env.DB.prepare(`SELECT 1 FROM ${t} WHERE owner_subject = ?`).bind(S).first();
      expect(row, t).toBeNull();
    }
  });

  it("deletes the user's polls and their invitees/responses/join-attempts, sparing a bystander's poll", async () => {
    const S = "poller@org";
    const BYSTANDER = "bystander-poller@org";
    await upsertUser(env.DB, S);
    await upsertUser(env.DB, BYSTANDER);

    // poll_invitees, poll_responses, and poll_join_attempts all carry no
    // owner column of their own — they're scoped transitively via
    // poll_id -> polls.subject.
    async function seedPoll(subject: string, suffix: string) {
      await env.DB.prepare(
        `INSERT INTO polls (id, subject, title, duration_min, range_start, range_end, deadline_utc, location, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).bind(`poll-${suffix}`, subject, "t", 30, "2026-08-17", "2026-08-21", "2026-08-16T00:00:00Z", "{}", "open", "2026-08-14T00:00:00Z").run();
      await env.DB.prepare(
        "INSERT INTO poll_invitees (id, poll_id, email, kind, token_hash, pseudonym) VALUES (?,?,?,?,?,?)",
      ).bind(`inv-${suffix}`, `poll-${suffix}`, `invitee-${suffix}@org`, "invited", `hash-${suffix}`, `pseudo-${suffix}`).run();
      await env.DB.prepare(
        "INSERT INTO poll_responses (invitee_id, cell_start_utc, state) VALUES (?,?,?)",
      ).bind(`inv-${suffix}`, "2026-08-17T09:00:00Z", "free").run();
      await env.DB.prepare(
        "INSERT INTO poll_join_attempts (poll_id, ip_hash, created_at) VALUES (?,?,?)",
      ).bind(`poll-${suffix}`, `iphash-${suffix}`, "2026-08-14T00:00:00Z").run();
    }
    await seedPoll(S, "v");
    await seedPoll(BYSTANDER, "b");

    await offboardUser(env, S, "admin@org");

    const count = async (table: string, col: string, val: string) =>
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).bind(val).first<{ n: number }>())?.n;

    expect(await count("polls", "id", "poll-v")).toBe(0);
    expect(await count("poll_invitees", "id", "inv-v")).toBe(0);
    expect(await count("poll_responses", "invitee_id", "inv-v")).toBe(0);
    expect(await count("poll_join_attempts", "poll_id", "poll-v")).toBe(0);

    expect(await count("polls", "id", "poll-b")).toBe(1);
    expect(await count("poll_invitees", "id", "inv-b")).toBe(1);
    expect(await count("poll_responses", "invitee_id", "inv-b")).toBe(1);
    expect(await count("poll_join_attempts", "poll_id", "poll-b")).toBe(1);
  });

});
