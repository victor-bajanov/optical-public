import type { Env } from "../env";
import type { CalendarEvent } from "../providers/types";
import { isSchedulerOwned } from "../webhooks/google-calendar";
import { getCalendarSync, PRIMARY_CALENDAR_ID } from "../db/calendar-sync";
import { defaultCalendarProvider, ProviderDisabledError } from "../index-providers";
import { deactivateUser } from "../db/users";
import { writeAudit } from "../db/audit";
import { ACCESS_PREFIX } from "../auth/identity-store";
import { OWNER_SCOPED_TABLES } from "./owner-scoped-tables";
import { SCHEDULER_HORIZON_MS } from "../planning/scheduler-chunks";

interface MinimalCalendar {
  stopChannel(channelId: string, resourceId: string): Promise<void>;
  fetchEventsInWindow(
    start: string,
    end: string,
    opts?: { syncToken?: boolean },
  ): Promise<{ events: CalendarEvent[] }>;
  deleteEvent(eventId: string): Promise<void>;
}

export interface OffboardOptions {
  // Test seam: build a per-subject calendar provider. Defaults to the real one.
  calendarFor?: (env: Env, subject: string) => MinimalCalendar | Promise<MinimalCalendar>;
  // Override the audit source recorded on the offboard action. Defaults to "admin".
  // Pass "cron" when the offboard is triggered by an automated sweep.
  auditSource?: import("../db/audit").AuditSource;
}

// Hard-delete a subject's CURRENT assets and stop their Google webhook. ORDER IS
// LOAD-BEARING (Plan 4 brief D):
//   1. read calendar_sync (need channel ids + a live access token),
//   2. stop the Google channel (tolerate any failure),
//   3. delete the per-user rows,
//   4. clear the KV access-token cache,
//   5. reset the per-user Durable Object,
//   6. deactivate the user,
//   7. audit.
// Sent emails / audit history are intentionally retained (see OWNER_SCOPED_TABLES
// `keep` entries). Per-user config and calendar feed tokens ARE deleted — offboard
// is a full removal. The shared "__default__" config sentinel is never touched
// (deletes bind the real subject). Stateless signed capability tokens expire by
// TTL and become inert once the plan rows go.
export async function offboardUser(
  env: Env,
  subject: string,
  actor: string,
  opts: OffboardOptions = {},
): Promise<void> {
  const calendarFor = opts.calendarFor ?? (async (e, s) => (await defaultCalendarProvider(e, s)) as unknown as MinimalCalendar);

  // Provider construction is itself best-effort ONLY for the kill switch: with
  // MS_PROVIDER_ENABLED flipped off it throws ProviderDisabledError, and that
  // must degrade to skipping the calendar cleanup — never block the D1
  // removal. Any OTHER error (transient D1 outage, KV failure, ...) is not
  // "this subject's provider is intentionally disabled" and must not be
  // silently swallowed into a degraded offboard that still deletes every
  // row — rethrow it and abort BEFORE any deletion happens.
  let cal: MinimalCalendar | null = null;
  try {
    cal = await calendarFor(env, subject);
  } catch (e) {
    if (!(e instanceof ProviderDisabledError)) throw e;
    console.warn("offboardUser: calendar provider unavailable (skipping calendar cleanup)", {
      subject, error: String(e),
    });
  }

  // 1 + 2: stop the live push channel BEFORE we lose its ids/credential.
  // Microsoft subscriptions store channel_resource_id = "" (Graph has no
  // resourceId), so test for presence with != null, not truthiness.
  const sync = await getCalendarSync(env.DB, subject, PRIMARY_CALENDAR_ID);
  if (cal && sync?.channel_id != null && sync.channel_resource_id != null) {
    try {
      await cal.stopChannel(sync.channel_id, sync.channel_resource_id);
    } catch (e) {
      // A failed stop must not block deletion — the channel self-expires (~7d).
      console.warn("offboardUser: stopChannel failed (continuing)", {
        subject, channelId: sync.channel_id, error: String(e),
      });
    }
  }

  // 2.5 (OS3): best-effort sweep of orphaned scheduler-chunk events over a forward
  // horizon. The OAuth token + KV cache are still present, so the calendar is
  // reachable. Without this, post-offboard chunk events have no commit reconcile
  // left to clean them and become ghost placements on re-onboard. A failure here
  // must never block the D1 deletion below (same contract as stopChannel).
  if (cal) {
    try {
      const now = Date.now();
      const horizonEnd = now + SCHEDULER_HORIZON_MS;
      const { events } = await cal.fetchEventsInWindow(
        new Date(now).toISOString(),
        new Date(horizonEnd).toISOString(),
        { syncToken: false },
      );
      for (const e of events) {
        if (isSchedulerOwned(e) && Date.parse(e.start) < horizonEnd) {
          await cal.deleteEvent(e.id);
        }
      }
    } catch (e) {
      console.warn("offboardUser: scheduler-event sweep failed (continuing)", {
        subject, error: String(e),
      });
    }
  }

  // 3: per-user D1 rows, generated from the owner-scoped-table registry (single
  // source of truth — see owner-scoped-tables.ts). Adding a per-user table there
  // with policy "delete" is all it takes to have offboard clear it. Config deletes
  // bind the real subject, so the shared "__default__" sentinel is never touched.
  const deletes: D1PreparedStatement[] = [];
  for (const t of OWNER_SCOPED_TABLES) {
    if (t.policy !== "delete") continue;
    // extraDeletes run FIRST: a child table scoped only transitively through
    // this table's rows (see owner-scoped-tables.ts) needs the parent rows
    // still present to join against, so it must clear before the primary
    // keyed delete below removes them.
    for (const sql of t.extraDeletes ?? []) {
      deletes.push(env.DB.prepare(sql).bind(subject));
    }
    deletes.push(env.DB.prepare(`DELETE FROM ${t.table} WHERE ${t.column} = ?`).bind(subject));
  }
  await env.DB.batch(deletes);

  // 4: KV access-token cache.
  await env.GOOGLE_TOKEN_CACHE.delete(ACCESS_PREFIX + subject);

  // 5: per-user Durable Object debounce state + pending alarm.
  try {
    const stub = env.RESOLVE_COORDINATOR.get(env.RESOLVE_COORDINATOR.idFromName(subject));
    await stub.reset();
  } catch (e) {
    console.warn("offboardUser: DO reset failed (continuing)", { subject, error: String(e) });
  }

  // 6 + 7.
  await deactivateUser(env.DB, subject);
  await writeAudit(env.DB, { subject, actor, action: "offboard", source: opts.auditSource ?? "admin" });
}
