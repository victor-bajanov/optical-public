// Pure render paths for the booking-page decline auto-cancel notices (see
// internal design notes, Card D). Booker gets a "please
// re-book" notice; owner gets a heads-up. Callers (cron/booking-decline-
// sweep.ts) attach `to` and hand the result to NotificationProvider.sendPollEmail
// — that method is a generic "send this rendered email" API despite its name
// (see providers/notification-provider.ts), not poll-specific.

import { escText as esc } from "../util/html-escape";
import type { PollEmail } from "../providers/notification-provider";
import { emailShell, ctaButton } from "../polls/emails";

/** What a renderer produces: everything but the recipient address. */
export type BookingEmailContent = Omit<PollEmail, "to">;

// "Wed 19 August, 12:00 PM (Australia/Sydney)" in `tz` when given; else the
// same in UTC with an explicit "UTC" label. The tz label is UNCONDITIONAL —
// a bare instant rendered in someone else's tz with no hint (e.g. a London
// booker seeing "12:00 PM" for what was, for them, "3:00 AM") reads as their
// own local time, which is actively misleading, not just ambiguous.
// Duplicated from polls/emails.ts's (unexported) formatDateTime rather than
// imported: that function isn't exported (only the cosmetic shell is, per
// Card D's file fence), and it's a small, self-contained presentational
// helper.
function formatSlotTime(iso: string, tz?: string): string {
  const zone = tz ?? "UTC";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`invalid ISO datetime: ${iso}`);
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-AU", {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(ms))) {
    parts[p.type] = p.value;
  }
  const period = (parts.dayPeriod ?? "").toUpperCase();
  const base = `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute} ${period}`;
  return tz ? `${base} (${tz})` : `${base} UTC`;
}

export interface BookingDeclineCancelledEmailParams {
  /** The booking page's slug, so the CTA points back at the same page. */
  slug: string;
  startUtc: string;
  /** Owner's home tz — there is no stored booker tz, and the slot is the
   *  same instant either way, so the booker sees it in the same rendering
   *  as the owner's copy of this notice. */
  ownerTz?: string;
  oauthIssuer: string;
}

/** Sent to the booker when their all-declined booking-page event is auto-
 *  cancelled at the end of the grace period. */
export function renderBookingDeclineCancelledEmail(
  params: BookingDeclineCancelledEmailParams,
): BookingEmailContent {
  const { slug, startUtc, ownerTz, oauthIssuer } = params;
  const when = formatSlotTime(startUtc, ownerTz);
  const bookUrl = `${oauthIssuer}/book/${slug}`;

  const subject = `Cancelled: your ${when} booking`;

  const text = [
    `Your booking for ${when} has been cancelled because you declined the calendar invite.`,
    ``,
    `To book a new (or the same) time, please use the booking page again: ${bookUrl}`,
  ].join("\n");

  const html = emailShell(
    `<p>Your booking for <strong>${esc(when)}</strong> has been cancelled because you declined the calendar invite.</p>` +
      `<p>To book a new (or the same) time, please use the booking page again.</p>` +
      ctaButton(bookUrl, "Book again"),
  );

  return { subject, text, html };
}

export interface BookingDeclineCancelledOwnerEmailParams {
  bookerName: string;
  startUtc: string;
  ownerTz?: string;
}

/** Heads-up to the owner when a booking-page event is auto-cancelled because
 *  the booker declined it. */
export function renderBookingDeclineCancelledOwnerEmail(
  params: BookingDeclineCancelledOwnerEmailParams,
): BookingEmailContent {
  const { bookerName, startUtc, ownerTz } = params;
  const when = formatSlotTime(startUtc, ownerTz);

  const subject = `Booking cancelled: ${bookerName} declined`;

  const text = [
    `${bookerName}'s booking for ${when} was cancelled after they declined the calendar invite.`,
    ``,
    `They were invited to book a new time via the booking page.`,
  ].join("\n");

  const html = emailShell(
    `<p>${esc(bookerName)}'s booking for <strong>${esc(when)}</strong> was cancelled after they declined the calendar invite.</p>` +
      `<p>They were invited to book a new time via the booking page.</p>`,
  );

  return { subject, text, html };
}
