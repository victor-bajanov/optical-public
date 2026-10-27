import type { Env } from "../env";
import type { NotificationProvider, PollEmail } from "../providers/notification-provider";
import type { ReplanEmailModel } from "../diff/email-model";
import type { RenderOpts } from "../diff/diff-email-renderer";
import { parseEnvNumberWithFloor } from "../util/env-parse";
import { ownerNotificationEmail } from "../db/owner-email";

/**
 * Per-subject outbound mail cap (hosted-trial card O9.8).
 *
 * Product mail goes out FROM the user's own mailbox (Gmail / Graph
 * notification providers). An injected agent can turn that into an
 * exfiltration or spam channel (O9 inventory §6: a poll titled with a feed
 * reveal_url, invitees = attacker). This caps it per subject per UTC day.
 *
 * Decisions:
 * - Unit = third-party RECIPIENTS, not messages: a message to N addresses
 *   costs N. Today every send has a single `to`, so the two coincide, but
 *   recipients stays correct if a multi-address send is ever added.
 * - Self-addressed mail (to the subject or to identity_tokens.login_email,
 *   the owner's current address after an IdP-side rename: replan emails,
 *   organiser booked/escalation/response notices) is never counted or
 *   refused, matched case-insensitively (see selfAddresses). It cannot
 *   exfiltrate anything, and capping it would let poll mail starve the
 *   user's own weekly plan email.
 * - OUTBOUND_MAIL_DAILY_CAP: unset/blank/unparseable → 50. "0" means NO
 *   third-party mail from user mailboxes (a kill switch), not "unlimited":
 *   a security cap must not turn off when someone types 0. Negatives clamp
 *   up to 0 (house parseEnvNumberWithFloor posture); fractions floor.
 *   "Unlimited" is expressed as a large number.
 * - Reserve-then-send: the slot is taken atomically BEFORE the provider
 *   call and not refunded if the send then fails (a timed-out send may still
 *   have been delivered), so the cap can never be overshot.
 * - SystemMailer (O11 lifecycle mail, sent as Optical) is a different path
 *   and is not capped.
 *
 * Enforcement point: index-providers.ts wraps every production notification
 * provider with withOutboundMailCap, so every caller is covered.
 */

export const DEFAULT_OUTBOUND_MAIL_DAILY_CAP = 50;

/** Thrown by a capped provider when a send would exceed today's cap. The
 *  message and fields carry no PII (no address, no subject). /v1 handlers
 *  map it to 429 {error:"mail_cap_exceeded"}; cron/webhook callers' existing
 *  per-item isolation skips the item. */
export class OutboundMailCapExceeded extends Error {
  readonly code = "mail_cap_exceeded" as const;
  constructor(readonly count: number, readonly cap: number) {
    super("mail_cap_exceeded");
    this.name = "OutboundMailCapExceeded";
  }
}

export function outboundMailDailyCap(env: Pick<Env, "OUTBOUND_MAIL_DAILY_CAP">): number {
  return parseEnvNumberWithFloor(env.OUTBOUND_MAIL_DAILY_CAP, DEFAULT_OUTBOUND_MAIL_DAILY_CAP, 0, true);
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function bareAddress(part: string): string {
  const angle = part.match(/<([^>]*)>/);
  return (angle?.[1] ?? part).trim().toLowerCase();
}

/** Recipients in `to` (comma/semicolon separated) other than the sender's
 *  own address(es), compared case-insensitively. `self` is the subject, or
 *  every self address (selfAddresses) when the owner has a login_email. */
export function countThirdPartyRecipients(to: string, self: string | readonly string[]): number {
  const own = new Set((typeof self === "string" ? [self] : self).map((a) => a.trim().toLowerCase()));
  return to
    .split(/[,;]/)
    .map(bareAddress)
    .filter((a) => a.length > 0 && !own.has(a)).length;
}

/** The subject's own mailbox addresses: the subject, plus login_email (via
 *  ownerNotificationEmail) when it is set and differs. Owner mail goes to
 *  login_email after a rename, and it must stay free under the cap. */
export async function selfAddresses(env: Pick<Env, "DB">, subject: string): Promise<string[]> {
  const login = await ownerNotificationEmail(env.DB, subject);
  return login.trim().toLowerCase() === subject.trim().toLowerCase() ? [subject] : [subject, login];
}

/** Third-party recipients across `recipients`. Reads login_email only when
 *  something isn't already addressed to the bare subject. */
async function thirdPartyCounts(env: Env, subject: string, recipients: readonly string[]): Promise<number[]> {
  if (recipients.every((to) => countThirdPartyRecipients(to, subject) === 0)) return recipients.map(() => 0);
  const self = await selfAddresses(env, subject);
  return recipients.map((to) => countThirdPartyRecipients(to, self));
}

async function currentCount(db: D1Database, subject: string, day: string): Promise<number> {
  const r = await db
    .prepare("SELECT count FROM outbound_mail_counts WHERE subject = ? AND utc_day = ?")
    .bind(subject, day)
    .first<{ count: number }>();
  return r?.count ?? 0;
}

/** Atomically reserves `n` recipients against today's cap, or throws
 *  OutboundMailCapExceeded (logging `outbound_mail_capped {count, cap}`). */
async function reserve(env: Env, subject: string, n: number, now: Date): Promise<void> {
  if (n <= 0) return;
  const cap = outboundMailDailyCap(env);
  const day = utcDay(now);
  let granted = false;
  if (n <= cap) {
    const results = await env.DB.batch([
      env.DB.prepare("DELETE FROM outbound_mail_counts WHERE subject = ? AND utc_day < ?").bind(subject, day),
      env.DB
        .prepare(
          `INSERT INTO outbound_mail_counts (subject, utc_day, count) VALUES (?1, ?2, ?3)
           ON CONFLICT (subject, utc_day) DO UPDATE SET count = outbound_mail_counts.count + excluded.count
           WHERE outbound_mail_counts.count + excluded.count <= ?4
           RETURNING count`,
        )
        .bind(subject, day, n, cap),
    ]);
    granted = (results[1]?.results ?? []).length > 0;
  }
  if (!granted) {
    const count = await currentCount(env.DB, subject, day);
    console.warn("outbound_mail_capped", { count, cap });
    throw new OutboundMailCapExceeded(count, cap);
  }
}

/** Handler pre-flight: would sending to `recipients` fit in today's remaining
 *  budget? Reads only; the sends themselves still reserve atomically. Lets a
 *  handler answer 429 BEFORE committing writes whose follow-up mail would be
 *  refused. */
export async function hasOutboundMailBudget(
  env: Env, subject: string, recipients: readonly string[], now: Date = new Date(),
): Promise<boolean> {
  const n = (await thirdPartyCounts(env, subject, recipients)).reduce((a, b) => a + b, 0);
  if (n === 0) return true;
  return (await currentCount(env.DB, subject, utcDay(now))) + n <= outboundMailDailyCap(env);
}

// Reservations taken ahead of a send (reserveOutboundMail) are parked here as
// per-provider credits keyed by the normalised `to`, and the capped send
// consumes a matching credit instead of reserving a second time.
const cappedProviders = new WeakSet<NotificationProvider>();
const credits = new WeakMap<NotificationProvider, Map<string, number>>();

function creditKey(to: string): string {
  return to.trim().toLowerCase();
}

function takeCredit(provider: NotificationProvider, to: string): boolean {
  const m = credits.get(provider);
  const k = creditKey(to);
  const n = m?.get(k) ?? 0;
  if (n <= 0) return false;
  if (n === 1) m!.delete(k);
  else m!.set(k, n - 1);
  return true;
}

/** Reserves today's budget for `recipients` atomically, all-or-nothing,
 *  BEFORE the caller does anything irreversible for them (rotating an
 *  invitee's link token, inserting a guest row). Throws
 *  OutboundMailCapExceeded (and logs outbound_mail_capped) when they don't
 *  all fit. The later sends through `provider` consume the reservation
 *  instead of reserving again. */
export async function reserveOutboundMail(
  env: Env, subject: string, provider: NotificationProvider, recipients: readonly string[], now: Date = new Date(),
): Promise<void> {
  const counts = await thirdPartyCounts(env, subject, recipients);
  await reserve(env, subject, counts.reduce((a, b) => a + b, 0), now);
  if (!cappedProviders.has(provider)) return; // an uncapped (test-injected) provider never consumes credits
  const m = credits.get(provider) ?? new Map<string, number>();
  recipients.forEach((to, i) => {
    if (counts[i] === 0) return;
    m.set(creditKey(to), (m.get(creditKey(to)) ?? 0) + 1);
  });
  credits.set(provider, m);
}

/** Caps a subject's notification provider IN PLACE: both send methods are
 *  replaced on the instance so every send reserves against the subject's
 *  daily cap first, and the same instance is returned. In place (rather than
 *  a wrapper object) keeps the provider's class and its other members
 *  (getFrom, …) intact for callers and tests that introspect them. */
export function withOutboundMailCap<T extends NotificationProvider>(
  env: Env,
  subject: string,
  provider: T,
  clock: () => Date = () => new Date(),
): T {
  const sendReplan = provider.sendReplanNotification.bind(provider);
  const sendPoll = provider.sendPollEmail.bind(provider);
  provider.sendReplanNotification = async (to: string, model: ReplanEmailModel, opts: RenderOpts): Promise<void> => {
    if (!takeCredit(provider, to)) await reserve(env, subject, (await thirdPartyCounts(env, subject, [to]))[0]!, clock());
    await sendReplan(to, model, opts);
  };
  provider.sendPollEmail = async (email: PollEmail): Promise<void> => {
    if (!takeCredit(provider, email.to)) await reserve(env, subject, (await thirdPartyCounts(env, subject, [email.to]))[0]!, clock());
    await sendPoll(email);
  };
  cappedProviders.add(provider);
  return provider;
}
