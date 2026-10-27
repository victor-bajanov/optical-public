import type { Env } from "../env";
import type { CalendarEvent } from "../providers/types";
import { isSchedulerOwned } from "../webhooks/google-calendar";
import { getCalendarSync, PRIMARY_CALENDAR_ID } from "../db/calendar-sync";
import { defaultCalendarProvider, defaultIdentityProvider, ProviderDisabledError } from "../index-providers";
import { deactivateUser } from "../db/users";
import { writeAudit } from "../db/audit";
import {
  dropCachedAccessToken, getSubjectProvider, IdentityCredentialMissingError, logCredentialMissingSkip, readRefreshToken,
} from "../auth/identity-store";
import { revokeUpstreamGrant, type RevokeCapable } from "../auth/upstream-revoke";
import { OWNER_SCOPED_TABLES } from "./owner-scoped-tables";
import { SCHEDULER_HORIZON_MS, deletableChunks } from "../planning/scheduler-chunks";

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
  // Test seam: build the subject's identity provider for the upstream revoke
  // (step 2.7). Defaults to the real one for the subject's stored provider.
  identityFor?: (env: Env, subject: string) => RevokeCapable | Promise<RevokeCapable>;
  // Override the audit source recorded on the offboard action. Defaults to "admin".
  // Pass "cron" when the offboard is triggered by an automated sweep.
  auditSource?: import("../db/audit").AuditSource;
}

// Hard-delete a subject's CURRENT assets and stop their Google webhook. ORDER IS
// LOAD-BEARING (Plan 4 brief D):
//   1. read calendar_sync (need channel ids + a live access token),
//   2. stop the Google channel (tolerate any failure),
//   2.5. sweep scheduler-owned chunk events (tolerate any failure),
//   2.7. revoke the upstream grant when UPSTREAM_REVOKE_ENABLED (tolerate any
//        failure) — AFTER 2 and 2.5,
//        which need a live access token the revoke would kill, and BEFORE 3,
//        which deletes the refresh token the revoke needs,
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
  // The subject has no credential (an admin rebind wiped it, so the account
  // was idle): there is no calendar to clean up and nothing to revoke
  // upstream (readRefreshToken reads null). One line, then the rest of the
  // calendar steps are skipped; the D1 removal runs as always.
  const credentialMissing = (): null => {
    logCredentialMissingSkip("offboard");
    return null;
  };
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
      if (e instanceof IdentityCredentialMissingError) {
        cal = credentialMissing();
      } else {
        console.warn("offboardUser: stopChannel failed (continuing)", {
          subject, channelId: sync.channel_id, error: String(e),
        });
      }
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
      // Runs before step 3 deletes the tasks rows that deletableChunks needs
      // to recognise this deployment's unstamped (legacy) chunks.
      const chunks = events.filter((e) => isSchedulerOwned(e) && Date.parse(e.start) < horizonEnd);
      for (const e of await deletableChunks(env.DB, subject, chunks)) {
        await cal.deleteEvent(e.id);
      }
    } catch (e) {
      if (e instanceof IdentityCredentialMissingError) {
        cal = credentialMissing();
      } else {
        console.warn("offboardUser: scheduler-event sweep failed (continuing)", {
          subject, error: String(e),
        });
      }
    }
  }

  // 2.7: revoke the upstream grant so the IdP stops honouring it once we
  // forget it. Gated by UPSTREAM_REVOKE_ENABLED (trial only; see env.ts):
  // off, the step is skipped entirely. Google: the revoke endpoint.
  // Microsoft: a documented no-op (no per-app revoke for a delegated grant;
  // the user removes the app, see MicrosoftIdentityProvider.revokeGrant).
  // Best-effort like 2 and 2.5: revokeUpstreamGrant never throws, so no
  // failure here (decrypt, provider construction, network, IdP error) can
  // block the deletion below. The MS kill switch logs offboard_revoke_skipped.
  // Any other failure logs offboard_revoke_failed, never carrying the token.
  const identityFor = opts.identityFor
    ?? (async (e: Env, s: string) => defaultIdentityProvider(e, await getSubjectProvider(e, s)));
  await revokeUpstreamGrant(env, {
    token: () => readRefreshToken(env, subject),
    idp: () => identityFor(env, subject),
    logPrefix: "offboard_revoke",
    context: { subject },
  });

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

  // 4: KV access-token cache (and a pre-encryption plaintext entry).
  await dropCachedAccessToken(env, subject);

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
