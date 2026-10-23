// Pure render paths for the booking-page decline auto-cancel notices (see
// internal design notes, Card D). Booker gets a "please
// re-book" notice; owner gets a heads-up. Callers (cron/booking-decline-
// sweep.ts) attach `to` and hand the result to NotificationProvider.sendPollEmail
// — that method is a generic "send this rendered email" API despite its name
// (see providers/notification-provider.ts), not poll-specific.

import { escText as esc } from "../util/html-escape";
import type { PollEmail } from "../providers/notification-provider";
import { emailShell, ctaButton } from "../polls/emails";
import type { LocationKind } from "./location";

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

export interface BookingOwnerNotifiedEmailParams {
  /** Booker-typed, so untrusted: escaped in the html body. */
  bookerName: string;
  bookerEmail: string;
  startUtc: string;
  durationMinutes: number;
  /** Owner's effective tz (getHomeTz); UTC, labelled, when absent. */
  ownerTz?: string;
  locationKind: LocationKind;
  /** The booker's number (phone) or place (in_person), or the owner's own
   *  fixed text (custom); null for meet. */
  locationDetail: string | null;
  /** The booker's note, untrusted third-party text; null when none. */
  note: string | null;
}

// A video link isn't known when this is sent: Google mints Meet links
// asynchronously and neither provider's createEvent surfaces one, so point at
// the event rather than promise a URL (same wording rule as the poll
// organiser's booked email).
function locationLine(kind: LocationKind, detail: string | null): string {
  if (kind === "meet") return "Video call (the join link is on the calendar event)";
  if (kind === "phone") return `Phone call: ${detail ?? ""}`;
  if (kind === "in_person") return `In person: ${detail ?? ""}`;
  return detail ?? "";
}

/** Sent to the booking-page owner, from and to their own mailbox, when a
 *  booker claims a slot. The calendar invitation goes only to the booker —
 *  Google doesn't email you about an event on your own calendar — so without
 *  this the owner hears nothing. */
export function renderBookingOwnerNotifiedEmail(params: BookingOwnerNotifiedEmailParams): BookingEmailContent {
  const { bookerName, bookerEmail, startUtc, durationMinutes, ownerTz, locationKind, locationDetail, note } = params;
  const when = formatSlotTime(startUtc, ownerTz);
  const how = locationLine(locationKind, locationDetail);
  const noteLabel = `Note from ${bookerName} (their own words, not checked by Optical):`;

  const subject = `New booking: ${bookerName}, ${when}`;

  const textLines = [
    `${bookerName} <${bookerEmail}> booked ${when} (${durationMinutes} minutes) through your booking page.`,
    `How: ${how}`,
  ];
  if (note) textLines.push(``, noteLabel, note);
  textLines.push(``, `It's on your calendar, and ${bookerName} has been sent the invitation.`);
  const text = textLines.join("\n");

  const html = emailShell(
    `<p><strong>${esc(bookerName)}</strong> &lt;${esc(bookerEmail)}&gt; booked <strong>${esc(when)}</strong> (${durationMinutes} minutes) through your booking page.<br>How: ${esc(how)}</p>` +
      (note
        ? `<p>${esc(noteLabel)}</p><blockquote style="white-space:pre-wrap;margin:0 0 16px;padding-left:12px;border-left:3px solid #ccc">${esc(note)}</blockquote>`
        : ``) +
      `<p>It's on your calendar, and ${esc(bookerName)} has been sent the invitation.</p>`,
  );

  return { subject, text, html };
}
