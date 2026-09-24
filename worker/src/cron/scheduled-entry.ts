import type { Env } from "../env";
import { runMondayResolve } from "./monday-resolve";
import { runCleanupExpiredPlans } from "./cleanup-proposed-plans";
import { runRenewSubscriptions } from "./renew-subscriptions";
import { runPollSweep } from "./poll-sweep";
import { runBookingDeclineSweep } from "./booking-decline-sweep";
import { sweepInactiveUsers } from "../lifecycle/sweep-inactive";
import { defaultProviders } from "../index-providers";
import { listSubjects } from "../auth/identity-store";
import { writeAudit } from "../db/audit";

interface Handlers {
  monday: (...args: unknown[]) => Promise<unknown>;
  cleanup: (...args: unknown[]) => Promise<unknown>;
  renew?: (...args: unknown[]) => Promise<unknown>;
  pollSweep?: (...args: unknown[]) => Promise<unknown>;
  bookingDeclineSweep?: (...args: unknown[]) => Promise<unknown>;
}

let injected: Handlers | null = null;
export function __setHandlersForTests(h: Handlers | null) {
  injected = h;
}

export const MONDAY_CRON = "0 15 * * SUN";
export const CLEANUP_CRON = "0 4 * * *";
export const POLL_CRON = "0 * * * *";
export const BOOKING_DECLINE_CRON = "*/5 * * * *";

export async function dispatchScheduled(
  event: ScheduledController | ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  if (event.cron === MONDAY_CRON) {
    // Master switch: default OFF. Any value other than exactly "true" leaves the
    // weekly cron inert (e.g. during the multi-user rollout).
    if (env.WEEKLY_CRON_ENABLED !== "true") {
      console.info("monday-cron disabled", { weekly_cron_enabled: env.WEEKLY_CRON_ENABLED ?? null });
      return;
    }
    ctx.waitUntil(
      (async () => {
        const subjects = await listSubjects(env);
        // Sequential per-user fan-out. Concurrency-pool / staggering hardening is
        // explicitly DEFERRED to a later plan; one user's failure must not abort
        // the others, so each resolve is independently try/caught.
        for (const subject of subjects) {
          try {
            if (injected) {
              await injected.monday(subject);
              await writeAudit(env.DB, { subject, action: "monday_resolve", source: "cron" });
              continue;
            }
            const { calendar: cal, notification: notify } = await defaultProviders(env, subject);
            await runMondayResolve({ env, calendar: cal, notification: notify, accountEmail: subject });
            await writeAudit(env.DB, { subject, action: "monday_resolve", source: "cron" });
          } catch (e) {
            console.error("monday-resolve failed", { subject, error: String(e) });
          }
        }
      })(),
    );
    return;
  }
  if (event.cron === CLEANUP_CRON) {
    if (injected) {
      ctx.waitUntil(injected.cleanup());
      if (injected.renew) ctx.waitUntil(injected.renew());
      return;
    }
    ctx.waitUntil(
      runCleanupExpiredPlans(env.DB, new Date()).catch((e: unknown) =>
        console.error("cleanup failed", e),
      ),
    );
    // Keep Google push channels alive (they expire silently after ~7 days).
    ctx.waitUntil(
      runRenewSubscriptions(env, new Date()).catch((e: unknown) =>
        console.error("subscription-renewal sweep failed", e),
      ),
    );
    // Inactive-user retention sweep (Plan 6 brief C). Strictly gated inside
    // sweepInactiveUsers: a no-op unless RETENTION_DAYS is a positive integer.
    ctx.waitUntil(
      sweepInactiveUsers(env, new Date()).catch((e: unknown) =>
        console.error("inactive-user sweep failed", e),
      ),
    );
    return;
  }
  if (event.cron === POLL_CRON) {
    // Master switch: default OFF, same idiom as WEEKLY_CRON_ENABLED — any
    // value other than exactly "true" leaves the hourly sweep inert.
    if (env.MEETING_POLL_ENABLED !== "true") {
      console.info("poll-sweep disabled", { meeting_poll_enabled: env.MEETING_POLL_ENABLED ?? null });
      return;
    }
    if (injected) {
      if (injected.pollSweep) ctx.waitUntil(injected.pollSweep());
      return;
    }
    ctx.waitUntil(
      (async () => {
        // T9's booking module (worker/src/polls/booking.ts) is a parallel
        // Wave-2 task; see poll-sweep.ts's header comment for why it isn't
        // imported there. Real wiring lives only here, at the dispatch edge.
        const { bookAtDeadline } = await import("../polls/booking");
        await runPollSweep(env, new Date(), { bookAtDeadline });
      })().catch((e: unknown) => console.error("poll-sweep failed", e)),
    );
    return;
  }
  if (event.cron === BOOKING_DECLINE_CRON) {
    // Rides BOOKING_PAGE_ENABLED — no separate flag (plan decision 4). Any
    // value other than exactly "true" leaves the 5-minute sweep inert.
    if (env.BOOKING_PAGE_ENABLED !== "true") {
      console.info("booking-decline-sweep disabled", { booking_page_enabled: env.BOOKING_PAGE_ENABLED ?? null });
      return;
    }
    if (injected) {
      if (injected.bookingDeclineSweep) ctx.waitUntil(injected.bookingDeclineSweep());
      return;
    }
    ctx.waitUntil(
      runBookingDeclineSweep(env, new Date()).catch((e: unknown) =>
        console.error("booking-decline-sweep failed", e),
      ),
    );
    return;
  }
  console.warn("scheduled: unknown cron expression", { cron: event.cron });
}
