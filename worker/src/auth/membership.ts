import type { Env } from "../env";
import { getUser } from "../db/users";

export function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// True when `email` matches one allow-list entry: either an exact email or a
// "*@domain" wildcard.
function matchesAllowlist(email: string, allowlist: string[]): boolean {
  for (const entry of allowlist) {
    if (entry.startsWith("*@")) {
      const domain = entry.slice(2);
      if (email.endsWith(`@${domain}`)) return true;
    } else if (entry === email) {
      return true;
    }
  }
  return false;
}

// Membership gate (Plan 4 brief B; tightened by hosted-trial O5). An email is
// a member if:
//  - it matches MEMBERSHIP_ALLOWLIST (exact or *@domain), OR
//  - it is an OPERATOR_EMAIL seed identity (initial admin), OR
//  - NO allow-list is configured and it already has an active users row.
// With an allow-list set, the allow-list is authoritative: removing an entry
// locks that user out at their next sign-in even though their users row is
// still active (upsert/touchLastSeen run only after this gate passes). The
// caller passes the stable `subject` (first-sign-in email, kept for life by
// the provider-subject anchor), so a renamed user stays matched on their
// ORIGINAL address's entry.
export async function isMember(email: string, env: Env): Promise<boolean> {
  const lower = email.trim().toLowerCase();
  if (!lower) return false;
  const allowlist = csv(env.MEMBERSHIP_ALLOWLIST);
  if (matchesAllowlist(lower, allowlist)) return true;
  if (csv(env.OPERATOR_EMAIL).includes(lower)) return true;
  if (allowlist.length > 0) return false;
  const existing = await getUser(env.DB, email);
  return !!existing && existing.is_active === 1;
}

// Where a delisted-user skip happened, for the `delisted_skip` log line. The
// path name is the only thing logged: never the subject (repo rule R1-F6).
export type DelistedSkipPath =
  | "monday_resolve"
  | "poll_sweep"
  | "webhook_replan"
  | "booking_decline_sweep"
  | "subscription_renewal"
  | "ms_lifecycle_reensure"
  | "booking_page"
  | "poll_page"
  | "poll_guest_join"
  | "calendar_feed"
  | "confirm_action"
  | "accept_link";

// Card C (decision C, O14b #3): may Optical act FOR `subject` on a background
// or public path (cron fan-outs, webhook replans, public booking/poll/feed
// pages)? With MEMBERSHIP_ALLOWLIST configured this is exactly isMember, so a
// user delisted but not yet offboarded gets nothing done on their behalf —
// no resolve, no mail from their mailbox, no calendar read or write with
// their grant. With no allow-list it is unconditionally true: prod parity,
// and deliberately NOT isMember's active-users-row fallback, which would
// change behaviour for a deactivated prod row. Sign-in and refresh keep
// calling isMember directly; offboard and the retention sweep never call
// this (they must still run for a delisted user).
export async function isActiveMember(env: Env, subject: string, path: DelistedSkipPath): Promise<boolean> {
  if (csv(env.MEMBERSHIP_ALLOWLIST).length === 0) return true;
  if (await isMember(subject, env)) return true;
  console.info("delisted_skip", { path });
  return false;
}
