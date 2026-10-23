import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import { sweepInactiveUsers } from "../../src/lifecycle/sweep-inactive";
import { upsertUser, touchLastSeen, getUser, bumpLastSeenStmt } from "../../src/db/users";
import { systemMailer, type SystemMail } from "../../src/mail/system-mailer";
// sweepInactiveUsers calls offboardUser, whose per-user DELETE batch now
// includes the poll tables (OWNER_SCOPED_TABLES). Applied locally, same
// pattern as the rest of test/lifecycle/*, since the shared test/setup.ts
// migration list is outside this correction's file fence.
import meetingPollSql from "../../migrations/0032_meeting_poll.sql?raw";

beforeAll(async () => {
  await applyD1Migrations(env.DB, [{ name: "0032_meeting_poll.sql", queries: [meetingPollSql] }]);
});

const NOW = new Date("2026-06-01T00:00:00Z");

// offboardUser builds a real calendar provider unless given a seam; inject a no-op.
const noopCalendar = { calendarFor: () => ({ stopChannel: async () => {} }) as any };

async function seedUser(subject: string, lastSeen: string, warnedAt: string | null = null) {
  await upsertUser(env.DB, subject);
  await touchLastSeen(env.DB, subject, lastSeen);
  if (warnedAt) {
    await env.DB.prepare("UPDATE users SET retention_warned_at = ? WHERE subject = ?").bind(warnedAt, subject).run();
  }
}

async function warnedAt(subject: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT retention_warned_at AS w FROM users WHERE subject = ?").bind(subject).first<{ w: string | null }>();
  return r?.w ?? null;
}

const MAIL_ON = { SYSTEM_MAIL_ENABLED: "true", SYSTEM_MAIL_FROM: "Optical <optical@example.test>", SYSTEM_MAIL_API_KEY: "k" };

/** A real systemMailer over a recording fetch: `ok` false → SMTP2GO 500. */
function recordingMailer(ok = true) {
  const sent: SystemMail[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init!.body)) as { to: string[]; subject: string; text_body: string };
    if (!ok) return new Response("boom", { status: 500 });
    sent.push({ to: body.to[0]!, subject: body.subject, text: body.text_body });
    return new Response(JSON.stringify({ data: { succeeded: 1, failed: 0 } }), { status: 200 });
  });
  return { mailer: systemMailer(MAIL_ON, { fetch: fetch as unknown as typeof globalThis.fetch }), sent, fetch };
}

describe("sweepInactiveUsers", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    for (const t of ["users", "tasks", "task_templates", "projects", "calendar_sync", "identity_tokens", "oauth_tokens", "oauth_codes", "proposed_plans", "audit_log"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it("is a strict no-op when RETENTION_DAYS is unset", async () => {
    await seedUser("stale@org", "2020-01-01T00:00:00Z");
    const swept = await sweepInactiveUsers({ ...env, RETENTION_DAYS: undefined }, NOW, noopCalendar);
    expect(swept).toEqual([]);
    expect((await getUser(env.DB, "stale@org"))?.is_active).toBe(1);
  });

  it("is a strict no-op when RETENTION_DAYS is empty / zero / negative / non-numeric", async () => {
    await seedUser("stale@org", "2020-01-01T00:00:00Z");
    for (const v of ["", "0", "-5", "abc"]) {
      const swept = await sweepInactiveUsers({ ...env, RETENTION_DAYS: v }, NOW, noopCalendar);
      expect(swept, `RETENTION_DAYS=${JSON.stringify(v)}`).toEqual([]);
    }
    expect((await getUser(env.DB, "stale@org"))?.is_active).toBe(1);
  });

  // O10b: idle > R no longer deletes outright. It warns (and stamps
  // retention_warned_at); deletion waits until the warning is 14 days old.
  it("warns (does not delete) users idle longer than RETENTION_DAYS - 14 and leaves recent ones intact", async () => {
    await seedUser("stale@org", "2026-04-01T00:00:00Z"); // 61 days before NOW
    await seedUser("recent@org", "2026-05-30T00:00:00Z"); // 2 days before NOW
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .bind("st1", "stale@org", "{}", "pending", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z").run();
    const rec = recordingMailer();

    const swept = await sweepInactiveUsers({ ...env, ...MAIL_ON, RETENTION_DAYS: "30" }, NOW, { ...noopCalendar, mailer: rec.mailer });

    expect(swept).toEqual([]);
    expect((await getUser(env.DB, "stale@org"))?.is_active).toBe(1);
    expect(await warnedAt("stale@org")).toBe(NOW.toISOString());
    expect(await warnedAt("recent@org")).toBeNull();
    const taskCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE owner_subject = ?").bind("stale@org").first<{ n: number }>();
    expect(taskCount?.n).toBe(1);
    expect(rec.sent).toHaveLength(1);
    expect(rec.sent[0]!.to).toBe("stale@org");
    // Deletion date = warning + 14 days (UTC date).
    expect(rec.sent[0]!.subject).toBe("Your Optical data will be deleted on 15 June 2026");
    expect(rec.sent[0]!.text).toContain("sign in or use it to keep it");
    const audit = await env.DB.prepare("SELECT subject, actor, action, source FROM audit_log WHERE action = 'retention_warned'").first<Record<string, unknown>>();
    expect(audit).toEqual({ subject: "stale@org", actor: "cron-sweep", action: "retention_warned", source: "cron" });
  });

  it("warns at R - 14 days idle, not before", async () => {
    // R = 30 → warn once idle > 16 days.
    await seedUser("edge@org", "2026-05-16T00:00:00Z"); // exactly 16 d: not yet
    await seedUser("past@org", "2026-05-15T23:59:59Z"); // 16 d + 1 s
    const rec = recordingMailer();
    await sweepInactiveUsers({ ...env, ...MAIL_ON, RETENTION_DAYS: "30" }, NOW, { ...noopCalendar, mailer: rec.mailer });
    expect(await warnedAt("edge@org")).toBeNull();
    expect(await warnedAt("past@org")).toBe(NOW.toISOString());
  });

  it("with RETENTION_DAYS <= 14, warns once a user has been idle a full day", async () => {
    await seedUser("day@org", "2026-05-30T23:00:00Z"); // 25 h idle
    await seedUser("hour@org", "2026-05-31T23:00:00Z"); // 1 h idle
    const rec = recordingMailer();
    await sweepInactiveUsers({ ...env, ...MAIL_ON, RETENTION_DAYS: "7" }, NOW, { ...noopCalendar, mailer: rec.mailer });
    expect(await warnedAt("day@org")).toBe(NOW.toISOString());
    expect(await warnedAt("hour@org")).toBeNull();
  });

  it("does not warn twice: an already-stamped user gets no second email", async () => {
    await seedUser("stale@org", "2026-04-01T00:00:00Z", "2026-05-25T04:00:00.000Z");
    const rec = recordingMailer();
    await sweepInactiveUsers({ ...env, ...MAIL_ON, RETENTION_DAYS: "30" }, NOW, { ...noopCalendar, mailer: rec.mailer });
    expect(rec.fetch).not.toHaveBeenCalled();
    expect(await warnedAt("stale@org")).toBe("2026-05-25T04:00:00.000Z");
  });

  it("deletes a user warned 14 days ago who is idle past RETENTION_DAYS, then sends a deletion notice", async () => {
    await seedUser("stale@org", "2026-04-01T00:00:00Z", "2026-05-18T04:00:00.000Z"); // 14 d before NOW (UTC date)
    await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .bind("st1", "stale@org", "{}", "pending", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z").run();
    const rec = recordingMailer();

    const swept = await sweepInactiveUsers({ ...env, ...MAIL_ON, RETENTION_DAYS: "30" }, NOW, { ...noopCalendar, mailer: rec.mailer });

    expect(swept).toEqual(["stale@org"]);
    expect((await getUser(env.DB, "stale@org"))?.is_active).toBe(0);
    const taskCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE owner_subject = ?").bind("stale@org").first<{ n: number }>();
    expect(taskCount?.n).toBe(0);
    const audit = await env.DB.prepare("SELECT subject, actor, action, source FROM audit_log WHERE action = 'sweep_offboard'").first<Record<string, unknown>>();
    expect(audit).toEqual({ subject: "stale@org", actor: "cron-sweep", action: "sweep_offboard", source: "cron" });
    expect(rec.sent).toEqual([expect.objectContaining({ to: "stale@org", subject: "Your Optical data has been deleted" })]);
  });

  it("the deletion date in the warning is the day the sweep deletes (UTC-day granularity)", async () => {
    // Warned at 04:00:05 on 18 May; the 1 June sweep at 04:00:00 is a few
    // seconds short of 14 x 24 h but on the promised date, so it deletes.
    await seedUser("stale@org", "2026-04-01T00:00:00Z", "2026-05-18T04:00:05.000Z");
    const swept = await sweepInactiveUsers({ ...env, RETENTION_DAYS: "30" }, new Date("2026-06-01T04:00:00Z"), noopCalendar);
    expect(swept).toEqual(["stale@org"]);
  });

  it("does not delete a user warned under 14 days ago", async () => {
    await seedUser("stale@org", "2026-04-01T00:00:00Z", "2026-05-19T00:00:00.000Z"); // 13 d before NOW
    const swept = await sweepInactiveUsers({ ...env, RETENTION_DAYS: "30" }, NOW, noopCalendar);
    expect(swept).toEqual([]);
    expect((await getUser(env.DB, "stale@org"))?.is_active).toBe(1);
  });

  it("does not delete a warned user whose last_seen is within RETENTION_DAYS (e.g. R was raised)", async () => {
    await seedUser("stale@org", "2026-05-10T00:00:00Z", "2026-05-01T00:00:00.000Z"); // idle 22 d < 30
    const swept = await sweepInactiveUsers({ ...env, RETENTION_DAYS: "30" }, NOW, noopCalendar);
    expect(swept).toEqual([]);
  });

  it("activity clears the stamp, so a returning user is not deleted on the old warning", async () => {
    await seedUser("back@org", "2026-04-01T00:00:00Z", "2026-05-10T04:00:00.000Z");
    await bumpLastSeenStmt(env.DB, "back@org", new Date("2026-05-20T00:00:00Z")).run();
    const rec = recordingMailer();
    const swept = await sweepInactiveUsers({ ...env, ...MAIL_ON, RETENTION_DAYS: "30" }, NOW, { ...noopCalendar, mailer: rec.mailer });
    expect(swept).toEqual([]);
    expect((await getUser(env.DB, "back@org"))?.is_active).toBe(1);
    expect(await warnedAt("back@org")).toBeNull();
    expect(rec.fetch).not.toHaveBeenCalled();
  });

  it("with system mail off: stamps without sending and logs retention_warning_unsent", async () => {
    await seedUser("stale@org", "2026-04-01T00:00:00Z");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const info = vi.spyOn(console, "warn").mockImplementation(() => {});
    const swept = await sweepInactiveUsers({ ...env, SYSTEM_MAIL_ENABLED: undefined, RETENTION_DAYS: "30" }, NOW, noopCalendar);
    expect(swept).toEqual([]);
    expect(await warnedAt("stale@org")).toBe(NOW.toISOString());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("retention_warning_unsent", expect.objectContaining({ reason: "system_mail_disabled" }));
    // The log line never carries the address.
    expect(JSON.stringify(info.mock.calls)).not.toContain("stale@org");
  });

  it("a failed send leaves no stamp, so the next run retries", async () => {
    await seedUser("stale@org", "2026-04-01T00:00:00Z");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = recordingMailer(false);
    await sweepInactiveUsers({ ...env, ...MAIL_ON, RETENTION_DAYS: "30" }, NOW, { ...noopCalendar, mailer: failing.mailer });
    expect(failing.fetch).toHaveBeenCalledTimes(1);
    expect(await warnedAt("stale@org")).toBeNull();
    const ok = recordingMailer();
    await sweepInactiveUsers({ ...env, ...MAIL_ON, RETENTION_DAYS: "30" }, new Date(NOW.getTime() + 24 * 3600 * 1000), { ...noopCalendar, mailer: ok.mailer });
    expect(ok.sent).toHaveLength(1);
    expect(await warnedAt("stale@org")).not.toBeNull();
  });

  it("a warn-phase failure is logged without the user's address and the sweep carries on", async () => {
    await seedUser("boom@org", "2026-04-01T00:00:00Z");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwing = { send: async () => { throw new Error("mailer exploded"); } };
    await sweepInactiveUsers({ ...env, ...MAIL_ON, RETENTION_DAYS: "30" }, NOW, { ...noopCalendar, mailer: throwing });
    expect(err).toHaveBeenCalledWith("sweepInactiveUsers: warn failed", expect.anything());
    expect(JSON.stringify(err.mock.calls)).not.toContain("boom@org");
    expect(await warnedAt("boom@org")).toBeNull();
  });

  it("activity during the warning send: no stamp and no retention_warned audit row", async () => {
    await seedUser("racer@org", "2026-04-01T00:00:00Z");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const racing = {
      send: async () => {
        // The user comes back while the warning is in flight.
        await env.DB.prepare("UPDATE users SET last_seen = ? WHERE subject = ?").bind(NOW.toISOString(), "racer@org").run();
        return { ok: true };
      },
    };
    await sweepInactiveUsers({ ...env, ...MAIL_ON, RETENTION_DAYS: "30" }, NOW, { ...noopCalendar, mailer: racing });
    expect(await warnedAt("racer@org")).toBeNull();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'retention_warned'").first<{ n: number }>();
    expect(n?.n).toBe(0);
    expect(warn).toHaveBeenCalledWith("retention_warning_raced");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("racer@org");
  });

  // O14 #7: `stale` is read once, so activity by a later user while an
  // earlier one is being offboarded must still cancel that later deletion.
  // Whichever user the sweep reaches first touches the other from inside its
  // own offboard (calendarFor runs first in offboardUser), so the assertions
  // hold for either SELECT order.
  it("activity during the sweep cancels that user's deletion (re-check before each offboard)", async () => {
    const subjects = ["one@org", "two@org"];
    for (const s of subjects) {
      await seedUser(s, "2026-04-01T00:00:00Z", "2026-05-01T00:00:00.000Z");
      await env.DB.prepare("INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?)")
        .bind(`t-${s}`, s, "{}", "pending", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z").run();
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let first: string | null = null;
    const racingCalendar = {
      calendarFor: async (_e: unknown, subject: string) => {
        if (first === null) {
          first = subject;
          // The other user comes back while this one is being offboarded.
          await touchLastSeen(env.DB, subjects.find((s) => s !== subject)!, NOW.toISOString());
        }
        return { stopChannel: async () => {} } as any;
      },
    };
    const rec = recordingMailer();

    const swept = await sweepInactiveUsers({ ...env, ...MAIL_ON, RETENTION_DAYS: "30" }, NOW, { ...racingCalendar, mailer: rec.mailer });

    expect(first).not.toBeNull();
    const survivor = subjects.find((s) => s !== first)!;
    expect(swept).toEqual([first]);
    expect((await getUser(env.DB, first!))?.is_active).toBe(0);
    expect((await getUser(env.DB, survivor))?.is_active).toBe(1);
    const tasks = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE owner_subject = ?").bind(survivor).first<{ n: number }>();
    expect(tasks?.n).toBe(1);
    const audit = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE subject = ? AND action IN ('sweep_offboard', 'offboard')").bind(survivor).first<{ n: number }>();
    expect(audit?.n).toBe(0);
    expect(rec.sent.map((m) => m.to)).toEqual([first]);
    expect(warn).toHaveBeenCalledWith("retention_delete_raced");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(survivor);
  });

  it("a failed deletion notice does not undo or block the offboard", async () => {
    await seedUser("stale@org", "2026-04-01T00:00:00Z", "2026-05-01T00:00:00.000Z");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = recordingMailer(false);
    const swept = await sweepInactiveUsers({ ...env, ...MAIL_ON, RETENTION_DAYS: "30" }, NOW, { ...noopCalendar, mailer: failing.mailer });
    expect(swept).toEqual(["stale@org"]);
    expect((await getUser(env.DB, "stale@org"))?.is_active).toBe(0);
  });

  it("ignores already-inactive users (only sweeps active ones)", async () => {
    await seedUser("gone@org", "2020-01-01T00:00:00Z");
    await env.DB.prepare("UPDATE users SET is_active = 0 WHERE subject = ?").bind("gone@org").run();
    const swept = await sweepInactiveUsers({ ...env, RETENTION_DAYS: "30" }, NOW, noopCalendar);
    expect(swept).toEqual([]);
  });

  it("skips active users whose last_seen is NULL (never offboard on unknown activity)", async () => {
    await upsertUser(env.DB, "fresh@org"); // upsertUser leaves last_seen NULL
    const swept = await sweepInactiveUsers({ ...env, RETENTION_DAYS: "30" }, NOW, noopCalendar);
    expect(swept).toEqual([]);
    expect((await getUser(env.DB, "fresh@org"))?.is_active).toBe(1);
  });

  // Decision E: a user whose warning can never be sent is never deleted
  // (phase 2 needs the stamp), so the sweep surfaces them as a daily count.
  describe("retention_unwarnable", () => {
    it("counts active users idle past R with no warning stamp, without addresses, and never deletes them", async () => {
      await seedUser("stuck@org", "2026-04-01T00:00:00Z"); // 61 d idle > 30
      await seedUser("stuck2@org", "2026-03-01T00:00:00Z");
      await seedUser("warnonly@org", "2026-05-10T00:00:00Z"); // 22 d: warn window, not past R
      await seedUser("warned@org", "2026-04-01T00:00:00Z", "2026-05-25T00:00:00.000Z");
      vi.spyOn(console, "error").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const failing = recordingMailer(false);

      const swept = await sweepInactiveUsers({ ...env, ...MAIL_ON, RETENTION_DAYS: "30" }, NOW, { ...noopCalendar, mailer: failing.mailer });

      expect(swept).toEqual([]);
      expect((await getUser(env.DB, "stuck@org"))?.is_active).toBe(1);
      expect(warn).toHaveBeenCalledWith("retention_unwarnable", { count: 2 });
      expect(warn.mock.calls.filter((c) => c[0] === "retention_unwarnable")).toHaveLength(1);
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/@org/);
    });

    it("logs a zero count at info level when nobody is stuck", async () => {
      await seedUser("ok@org", "2026-05-30T00:00:00Z");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await sweepInactiveUsers({ ...env, RETENTION_DAYS: "30" }, NOW, noopCalendar);
      expect(log).toHaveBeenCalledWith("retention_unwarnable", { count: 0 });
      expect(warn.mock.calls.some((c) => c[0] === "retention_unwarnable")).toBe(false);
    });

    it("a user warned in this very run is not counted", async () => {
      await seedUser("stale@org", "2026-04-01T00:00:00Z");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const rec = recordingMailer();
      await sweepInactiveUsers({ ...env, ...MAIL_ON, RETENTION_DAYS: "30" }, NOW, { ...noopCalendar, mailer: rec.mailer });
      expect(log).toHaveBeenCalledWith("retention_unwarnable", { count: 0 });
    });

    it("no line when the retention sweep is off", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await sweepInactiveUsers({ ...env, RETENTION_DAYS: undefined }, NOW, noopCalendar);
      const all = [...log.mock.calls, ...warn.mock.calls].map((c) => c[0]);
      expect(all).not.toContain("retention_unwarnable");
    });
  });

  // Decision F: the purge window runs from the same daily sweep, independent
  // of RETENTION_DAYS (an operator offboard or self-serve delete starts it too).
  it("purges deactivated rows past DELETED_ACCOUNT_RETENTION_DAYS even with RETENTION_DAYS unset", async () => {
    await upsertUser(env.DB, "gone@org");
    await env.DB.prepare("UPDATE users SET is_active = 0, deactivated_at = ? WHERE subject = ?")
      .bind("2026-04-01T00:00:00.000Z", "gone@org").run();
    await sweepInactiveUsers({ ...env, RETENTION_DAYS: undefined, DELETED_ACCOUNT_RETENTION_DAYS: "30" }, NOW, noopCalendar);
    expect(await getUser(env.DB, "gone@org")).toBeNull();
  });

  it("a user the sweep offboards today is not purged in the same run", async () => {
    await seedUser("stale@org", "2026-04-01T00:00:00Z", "2026-05-01T00:00:00.000Z");
    const swept = await sweepInactiveUsers({ ...env, RETENTION_DAYS: "30", DELETED_ACCOUNT_RETENTION_DAYS: "1" }, NOW, noopCalendar);
    expect(swept).toEqual(["stale@org"]);
    expect(await getUser(env.DB, "stale@org")).toMatchObject({ is_active: 0 });
  });
});
