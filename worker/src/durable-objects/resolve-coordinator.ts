import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { defaultProviders } from "../index-providers";
import { runWebhookReplan } from "../webhooks/google-calendar";

/** Fixed-window debounce: a pending alarm is NOT pushed out by later changes,
 *  so worst-case resolve latency is bounded and a stream of edits cannot starve. */
export const DEBOUNCE_MS = 10_000;

const KEY_ACCOUNT = "accountEmail";
const KEY_DIRTY = "dirty";

type ReplanRunner = (env: Env, accountEmail: string) => Promise<void>;
let injectedRunner: ReplanRunner | null = null;

/** Test seam: replace the resolve runner so DO tests assert debounce/alarm
 *  logic without standing up a real resolve. Mirrors __setHandlersForTests. */
export function __setReplanRunnerForTests(fn: ReplanRunner | null): void {
  injectedRunner = fn;
}

type WebhookReplan = typeof runWebhookReplan;
let injectedWebhookReplan: WebhookReplan | null = null;

/** Test seam: replace the underlying webhook replan so defaultRunner's
 *  result-handling (e.g. the unsat warn) can be exercised without standing up
 *  real calendar/solver providers. The vitest-pool-workers runtime does not
 *  support module-level vi.mock, so this seam is how the result kind is driven. */
export function __setWebhookReplanForTests(fn: WebhookReplan | null): void {
  injectedWebhookReplan = fn;
}

export async function defaultRunner(env: Env, accountEmail: string): Promise<void> {
  // Bind both providers to the webhook OWNER's subject. Omitting it makes
  // subjectFor() fall back to resolveActiveSubject() — the globally
  // most-recently-active user — so the replan would read THAT user's Google
  // calendar and send mail from their Gmail (cross-tenant credential confusion).
  // Mirrors the cron fan-out (cron/scheduled-entry.ts), which threads the
  // subject per user.
  const { calendar, notification: notify } = await defaultProviders(env, accountEmail);
  const replan = injectedWebhookReplan ?? runWebhookReplan;
  const result = await replan({
    env,
    calendar,
    notify,
    accountEmail,
    oauthIssuer: env.OAUTH_ISSUER,
  });
  if (result.kind === "unsat") {
    console.warn("resolve_coordinator_unsat", { account: accountEmail, unsatCore: result.unsatCore });
  }
  console.info("resolve_coordinator_fired", { account: accountEmail, kind: result.kind });
}

export class ResolveCoordinator extends DurableObject<Env> {
  async notifyChange(accountEmail: string): Promise<void> {
    await this.ctx.storage.put(KEY_ACCOUNT, accountEmail);
    await this.ctx.storage.put(KEY_DIRTY, true);
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + DEBOUNCE_MS);
      console.info("resolve_coordinator_scheduled", { account: accountEmail });
    }
  }

  async alarm(): Promise<void> {
    const accountEmail = await this.ctx.storage.get<string>(KEY_ACCOUNT);
    // Clear dirty BEFORE running, so a change arriving during the resolve
    // re-arms the next cycle instead of being lost.
    await this.ctx.storage.put(KEY_DIRTY, false);
    if (!accountEmail) return;

    const runner = injectedRunner ?? defaultRunner;
    try {
      await runner(this.env, accountEmail);
    } catch (e) {
      // Do NOT re-throw: an uncaught throw makes the runtime auto-retry the
      // alarm, risking a duplicate email. The next webhook re-arms a fresh
      // resolve, and the Monday cron is a backstop.
      console.error("resolve_coordinator_alarm_failed", { account: accountEmail, error: String(e) });
    } finally {
      const dirtyAgain = await this.ctx.storage.get<boolean>(KEY_DIRTY);
      if (dirtyAgain) {
        await this.ctx.storage.setAlarm(Date.now() + DEBOUNCE_MS);
      }
    }
  }

  // Offboarding hook (Plan 4 brief D): wipe this user's debounce state + pending
  // alarm so a deleted user never triggers a future resolve.
  async reset(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
