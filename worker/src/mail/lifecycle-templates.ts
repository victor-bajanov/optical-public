import type { SystemMail } from "./system-mailer";

/**
 * Lifecycle mail bodies (hosted-trial card O10b), sent through the first-party
 * SystemMailer (O11) — never the user's own mailbox, which may be the very
 * account whose token has died.
 *
 * Plain text only: no HTML, no links, no tracking. Deployment-neutral: no
 * operator name or host is baked in; an optional DEPLOYMENT_LABEL names the
 * deployment when set.
 */

export type LifecycleMail = Pick<SystemMail, "subject" | "text">;

/** The deletion date as a UTC calendar date ("23 October 2026"). The retention
 *  sweep compares warning stamps at UTC-day granularity, so the UTC date is the
 *  day the deleting sweep runs. */
export function formatDeletionDate(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

function product(deploymentLabel: string | undefined): string {
  const label = (deploymentLabel ?? "").trim();
  return label ? `Optical (${label})` : "Optical";
}

/** What deletion keeps, and for how long (decision F). The kept users row
 *  holds the subject (email address), role and timestamps (created_at,
 *  last_seen, retention_warned_at, deactivated_at); the audit log keeps the
 *  address too. With DELETED_ACCOUNT_RETENTION_DAYS set (purgeAfterDays > 0)
 *  the sweep deletes the row and pseudonymises the audit rows after that many
 *  days; otherwise neither has an end date. */
function keptParagraph(purgeAfterDays: number | null | undefined): string {
  const n = purgeAfterDays && purgeAfterDays > 0 ? purgeAfterDays : null;
  const howLong = n === null
    ? "Both are kept with no set end date."
    : `Both are kept for ${n} ${n === 1 ? "day" : "days"} after the deletion. Then the record is deleted and your email address in the audit log entries is replaced by an anonymous identifier.`;
  return `Two things are kept: a deactivated record of the account, which holds your email address, your role and account dates (such as when it was created, last used and deleted), and audit log entries, including one recording the deletion. Neither holds any of your tasks or calendar data. ${howLong}`;
}

export function retentionWarningEmail(args: {
  deletionDate: Date;
  retentionDays: number;
  deploymentLabel?: string;
}): LifecycleMail {
  const date = formatDeletionDate(args.deletionDate);
  const name = product(args.deploymentLabel);
  return {
    subject: `Your Optical data will be deleted on ${date}`,
    text: [
      "Hello,",
      "",
      `You haven't used your ${name} account for a while. Accounts that go unused for ${args.retentionDays} days are deleted, so your Optical data will be deleted on ${date}; sign in or use it to keep it.`,
      "",
      "Any sign-in, or any use through a connected app or assistant, cancels the deletion. If you no longer need the account, you don't need to do anything.",
      "",
      "This is an automated message about your account.",
    ].join("\n"),
  };
}

export function retentionDeletedEmail(args: {
  retentionDays: number;
  /** DELETED_ACCOUNT_RETENTION_DAYS, parsed; null/0/omitted = no end date. */
  purgeAfterDays?: number | null;
  deploymentLabel?: string;
}): LifecycleMail {
  const name = product(args.deploymentLabel);
  return {
    subject: "Your Optical data has been deleted",
    text: [
      "Hello,",
      "",
      `Your ${name} account went unused for more than ${args.retentionDays} days, including the period after the deletion warning we sent, so its data has now been deleted.`,
      "",
      "You don't need to do anything. Your tasks, plans and settings were removed, so any later sign-in starts from an empty account.",
      "",
      keptParagraph(args.purgeAfterDays),
      "",
      "This is an automated message about your account.",
    ].join("\n"),
  };
}

/** Confirmation after a self-serve deletion (hosted-trial O2, DELETE
 *  /v1/account). Discloses what is kept: the deactivated users row and the
 *  audit log still carry the address (plan O2 open question, resolved as
 *  keep-and-disclose), and for how long (decision F). No link: the upstream
 *  grant is removed from the provider's own account settings, which Optical
 *  can't link to neutrally. */
export function accountDeletedEmail(args: {
  /** DELETED_ACCOUNT_RETENTION_DAYS, parsed; null/0/omitted = no end date. */
  purgeAfterDays?: number | null;
  deploymentLabel?: string;
}): LifecycleMail {
  const name = product(args.deploymentLabel);
  return {
    subject: "Your Optical account has been deleted",
    text: [
      "Hello,",
      "",
      `Your ${name} account has been deleted, as you asked. Your tasks, plans and settings, connected calendar access and sign-in sessions have been removed. Upcoming work blocks Optical had placed on your calendar were removed where your calendar was still reachable; past ones, and meetings booked or moved through Optical, stay on your calendar.`,
      "",
      keptParagraph(args.purgeAfterDays),
      "",
      "Signing in again starts a new, empty account. To be sure Optical can no longer reach your calendar, you can also remove it from the connected apps in your Google or Microsoft account settings.",
      "",
      "This is an automated message about your account.",
    ].join("\n"),
  };
}
