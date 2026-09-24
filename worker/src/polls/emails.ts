// Pure render paths for meeting-poll emails (invite / nudge / escalation).
// These are new content, distinct from the replan diff renderer in ../diff/ —
// do not reuse or extend that renderer for polls. Callers (route/handler/cron)
// attach `to` and hand the result to NotificationProvider.sendPollEmail.

import { escText as esc } from "../util/html-escape";
import { foldLine, escapeText as escIcs } from "../calendar-feed/ics-lines";
import type { PollEmail } from "../providers/notification-provider";

/** What a renderer produces: everything but the recipient address. */
export type PollEmailContent = Omit<PollEmail, "to">;

function parts(iso: string, tz: string): Record<string, string> {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`invalid ISO datetime: ${iso}`);
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-AU", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(ms))) {
    out[p.type] = p.value;
  }
  return out;
}

// "Wed 19 August, 4:00 AM" in `tz` when given; else the same in UTC with an
// explicit "UTC" label so a bare instant is never ambiguous about its zone.
function formatDateTime(iso: string, tz?: string): string {
  const zone = tz ?? "UTC";
  const p = parts(iso, zone);
  const period = (p.dayPeriod ?? "").toUpperCase();
  const base = `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute} ${period}`;
  return tz ? base : `${base} UTC`;
}

// range_start/range_end are plain inclusive local dates (YYYY-MM-DD), not
// instants — format the calendar day itself, never through a viewer timezone.
function formatLocalDateOnly(dateStr: string): string {
  const p = parts(`${dateStr}T00:00:00Z`, "UTC");
  return `${p.weekday} ${p.day} ${p.month}`;
}

interface PollEmailBase {
  pollTitle: string;
  organiserName: string;
  durationMin: number;
  rangeStart: string;
  rangeEnd: string;
  deadlineUtc: string;
  inviteeUrl: string;
  inviteeTz?: string;
}

// Exported so booking/emails.ts (decline auto-cancel notices) can reuse the
// cosmetic chrome. The "renderer families deliberately not shared" comment
// above fences POLLS off from the diff/ replan-email family — it says
// nothing about two email-renderer modules sharing presentational shell
// helpers, which carry no poll-specific content or behaviour.
export function emailShell(bodyHtml: string): string {
  return (
    `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f8fc">` +
    `<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;padding:24px">` +
    bodyHtml +
    `</div></body></html>`
  );
}

export function ctaButton(url: string, label: string): string {
  // `url` is an opaque per-invitee capability-token link — never log it, and
  // escape it the same as any other attribute value even though it is
  // server-generated.
  return `<div style="margin-top:18px"><a href="${esc(url)}" style="display:inline-block;background:#1a73e8;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 24px;border-radius:6px">${label}</a></div>`;
}

export function renderInviteEmail(params: PollEmailBase): PollEmailContent {
  const { pollTitle, organiserName, durationMin, rangeStart, rangeEnd, deadlineUtc, inviteeUrl, inviteeTz } = params;
  const deadline = formatDateTime(deadlineUtc, inviteeTz);
  const rangeText = `${formatLocalDateOnly(rangeStart)} – ${formatLocalDateOnly(rangeEnd)}`;

  const subject = `You're invited: ${pollTitle} — pick your availability`;

  const text = [
    `${organiserName} wants to find a time for "${pollTitle}" (${durationMin} minutes).`,
    ``,
    `Window: ${rangeText}`,
    `Responses close: ${deadline}`,
    ``,
    `Mark when you're free: ${inviteeUrl}`,
  ].join("\n");

  const html = emailShell(
    `<p>${esc(organiserName)} wants to find a time for <strong>${esc(pollTitle)}</strong> (${durationMin} minutes).</p>` +
      `<p>Window: ${esc(rangeText)}<br>Responses close: ${esc(deadline)}</p>` +
      ctaButton(inviteeUrl, "Mark your availability")
  );

  return { subject, text, html };
}

interface NudgeEmailParams extends PollEmailBase {
  respondedCount: number;
  totalCount: number;
}

export function renderNudgeEmail(params: NudgeEmailParams): PollEmailContent {
  const { pollTitle, organiserName, durationMin, rangeStart, rangeEnd, deadlineUtc, inviteeUrl, inviteeTz, respondedCount, totalCount } = params;
  const deadline = formatDateTime(deadlineUtc, inviteeTz);
  const rangeText = `${formatLocalDateOnly(rangeStart)} – ${formatLocalDateOnly(rangeEnd)}`;
  const progress = `${respondedCount} of ${totalCount}`;

  const subject = `Reminder: ${pollTitle} — poll closes soon`;

  const text = [
    `Reminder from ${organiserName}: "${pollTitle}" (${durationMin} minutes) is still waiting on your response.`,
    ``,
    `Window: ${rangeText}`,
    `Responses close: ${deadline}`,
    `Responses so far: ${progress}`,
    ``,
    `Mark when you're free: ${inviteeUrl}`,
  ].join("\n");

  const html = emailShell(
    `<p>Reminder from ${esc(organiserName)}: <strong>${esc(pollTitle)}</strong> (${durationMin} minutes) is still waiting on your response.</p>` +
      `<p>Window: ${esc(rangeText)}<br>Responses close: ${esc(deadline)}<br>Responses so far: ${esc(progress)}</p>` +
      ctaButton(inviteeUrl, "Mark your availability")
  );

  return { subject, text, html };
}

export function renderDeadlineExtendedEmail(params: PollEmailBase): PollEmailContent {
  const { pollTitle, organiserName, durationMin, rangeStart, rangeEnd, deadlineUtc, inviteeUrl, inviteeTz } = params;
  const deadline = formatDateTime(deadlineUtc, inviteeTz);
  const rangeText = `${formatLocalDateOnly(rangeStart)} – ${formatLocalDateOnly(rangeEnd)}`;

  const subject = `Deadline extended: ${pollTitle}`;

  const text = [
    `${organiserName} pushed back the response deadline for "${pollTitle}" (${durationMin} minutes).`,
    ``,
    `Window: ${rangeText}`,
    `New deadline: ${deadline}`,
    ``,
    // The link is a fresh token (the old one no longer works, same as a
    // nudge) — say so, since anyone who already responded is being asked to
    // click a DIFFERENT link than the one they used before.
    `Your link has been refreshed — mark or revise your availability: ${inviteeUrl}`,
  ].join("\n");

  const html = emailShell(
    `<p>${esc(organiserName)} pushed back the response deadline for <strong>${esc(pollTitle)}</strong> (${durationMin} minutes).</p>` +
      `<p>Window: ${esc(rangeText)}<br>New deadline: ${esc(deadline)}</p>` +
      ctaButton(inviteeUrl, "Mark or revise your availability")
  );

  return { subject, text, html };
}

interface PollCancelledEmailParams {
  pollTitle: string;
  organiserName: string;
  durationMin: number;
  rangeStart: string;
  rangeEnd: string;
}

/** Sent to every non-dropped invitee (invited AND guest kinds, hidden
 *  included — this is a private, per-recipient email, never a shared/BCC
 *  notice) when the organiser cancels a poll. Deliberately carries no
 *  link/CTA: every invitee link is dead by design once the poll is
 *  cancelled, so there is nothing useful to click through to. */
export function renderPollCancelledEmail(params: PollCancelledEmailParams): PollEmailContent {
  const { pollTitle, organiserName, durationMin, rangeStart, rangeEnd } = params;
  const rangeText = `${formatLocalDateOnly(rangeStart)} – ${formatLocalDateOnly(rangeEnd)}`;

  const subject = `Cancelled: ${pollTitle}`;

  const text = [
    `${organiserName} cancelled "${pollTitle}" (${durationMin} minutes).`,
    ``,
    `Window: ${rangeText}`,
    ``,
    `This poll has been cancelled. No meeting will be booked, and any links you were sent for it can now be disregarded.`,
  ].join("\n");

  const html = emailShell(
    `<p>${esc(organiserName)} cancelled <strong>${esc(pollTitle)}</strong> (${durationMin} minutes).</p>` +
      `<p>Window: ${esc(rangeText)}</p>` +
      `<p>This poll has been cancelled. No meeting will be booked, and any links you were sent for it can now be disregarded.</p>`,
  );

  return { subject, text, html };
}

interface InviteeRemovedEmailParams {
  pollTitle: string;
  organiserName: string;
  durationMin: number;
  rangeStart: string;
  rangeEnd: string;
}

/** Sent to a single invitee (the "least-email principle" — nobody else on
 *  the poll is notified) when the organiser removes them via
 *  `updateMeetingPoll`. `resolveInvitee` already locks a dropped invitee's
 *  old link out (route.ts), so this needs no token rotation — it's purely a
 *  polite heads-up. Deliberately carries no link/CTA: their link is already
 *  dead, so one would read as a bug rather than an invitation. */
export function renderInviteeRemovedEmail(params: InviteeRemovedEmailParams): PollEmailContent {
  const { pollTitle, organiserName, durationMin, rangeStart, rangeEnd } = params;
  const rangeText = `${formatLocalDateOnly(rangeStart)} – ${formatLocalDateOnly(rangeEnd)}`;

  const subject = `Removed: ${pollTitle}`;

  const text = [
    `${organiserName} has removed you from "${pollTitle}" (${durationMin} minutes).`,
    ``,
    `Window: ${rangeText}`,
    ``,
    `No action is needed on your part. You will not receive a calendar invite for this meeting. Apologies for any time you already spent responding.`,
  ].join("\n");

  const html = emailShell(
    `<p>${esc(organiserName)} has removed you from <strong>${esc(pollTitle)}</strong> (${durationMin} minutes).</p>` +
      `<p>Window: ${esc(rangeText)}</p>` +
      `<p>No action is needed on your part. You will not receive a calendar invite for this meeting. Apologies for any time you already spent responding.</p>`,
  );

  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// Booking notice (hidden invitees — BCC-equivalent)
// ---------------------------------------------------------------------------

// Duplicated from calendar-feed/build-busy-ics.ts's (unexported) utcStamp:
// that file is outside this task's file fence, and the function isn't
// exported. Same RFC 5545 form (YYYYMMDDTHHMMSSZ).
function icsUtcStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function toBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function buildBookingNoticeIcs(params: {
  pollId: string;
  title: string;
  startUtc: string;
  endUtc: string;
  location?: string;
  now: Date;
}): string {
  const { pollId, title, startUtc, endUtc, location, now } = params;
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//optical//meeting-poll//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    // Stable per-poll UID (not per-invitee): this is a one-shot notice, not a
    // subscription feed entry, so there is no update/cancel path to key off.
    `UID:poll-${pollId}@optical`,
    `DTSTAMP:${icsUtcStamp(now)}`,
    `DTSTART:${icsUtcStamp(new Date(startUtc))}`,
    `DTEND:${icsUtcStamp(new Date(endUtc))}`,
    `SUMMARY:${escIcs(title)}`,
  ];
  if (location) lines.push(`LOCATION:${escIcs(location)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

interface BookingNoticeEmailParams {
  pollId: string;
  pollTitle: string;
  organiserName: string;
  durationMin: number;
  slotStartUtc: string;
  slotEndUtc: string;
  // Resolved, human-readable location text (a Meet link, phone number,
  // address, etc) — the same string set on the calendar event's `location`.
  // Omitted when the poll has no location detail to show.
  location?: string;
  inviteeTz?: string;
  now: Date;
}

/** BCC-equivalent notice for a hidden ("hide my name") invitee: the booked
 *  event excludes them from the attendee list (decision D2), so this is the
 *  only way they learn what was booked. Carries a minimal METHOD:PUBLISH
 *  VEVENT so their own calendar client can add it — trade-off: no RSVP
 *  tracking, no auto-updates if the event later changes (documented
 *  limitation, acceptable because poll meetings are pinned). */
export function renderBookingNoticeEmail(params: BookingNoticeEmailParams): PollEmailContent {
  const { pollId, pollTitle, organiserName, durationMin, slotStartUtc, slotEndUtc, location, inviteeTz, now } = params;
  const when = formatDateTime(slotStartUtc, inviteeTz);

  const subject = `Booked: ${pollTitle}`;

  const textLines = [`${organiserName} booked "${pollTitle}" (${durationMin} minutes).`, ``, `When: ${when}`];
  if (location) textLines.push(`Where: ${location}`);
  textLines.push(
    ``,
    `You're not listed by name on the calendar invite, since you asked to keep your response private from other invitees. Add the attached calendar file to your own calendar if you'd like a reminder — it won't update automatically if this meeting later changes.`,
  );
  const text = textLines.join("\n");

  const html = emailShell(
    `<p>${esc(organiserName)} booked <strong>${esc(pollTitle)}</strong> (${durationMin} minutes).</p>` +
      `<p>When: ${esc(when)}${location ? `<br>Where: ${esc(location)}` : ""}</p>` +
      `<p>You're not listed by name on the calendar invite, since you asked to keep your response private from other invitees. Add the attached calendar file to your own calendar if you'd like a reminder — it won't update automatically if this meeting later changes.</p>`
  );

  const ics = buildBookingNoticeIcs({ pollId, title: pollTitle, startUtc: slotStartUtc, endUtc: slotEndUtc, location, now });
  const attachments = [{ filename: "invite.ics", mimeType: "text/calendar; method=PUBLISH", contentBase64: toBase64(ics) }];

  return { subject, text, html, attachments };
}

// ---------------------------------------------------------------------------
// Organiser notifications: booked, and a response saved (T-notify)
// ---------------------------------------------------------------------------

export interface PollBookedEmailParams {
  pollTitle: string;
  slotStartUtc: string;
  durationMin: number;
  // Resolved, human-readable location text for the booked event. The caller
  // (bookPollSlotInternal) resolves the Google-Meet case to an explanatory
  // string too, rather than leaving this undefined — Meet's own join link is
  // minted asynchronously by Google, not known at booking time, so the text
  // points at the calendar event instead of promising a URL this function
  // doesn't have.
  location?: string;
  organiserTz?: string;
  // Real names of everyone on the calendar invite (never dropped, never
  // hidden). Real names throughout, per inviteeLabel's "organiser always
  // sees real names" rule — never a pseudonym.
  attendeeNames: string[];
  // Real names of hidden ("hide my name") invitees whose private booking-
  // notice email actually SENT — never derived from intent. This email is
  // the organiser's only signal that those people were reached at all, so
  // conflating "we tried" with "it arrived" would misinform them.
  hiddenNames: string[];
  // Real names of hidden invitees whose booking-notice send FAILED — the
  // organiser needs to know these people may not know about the meeting yet
  // (their own send failure is logged separately, by invitee id only; this
  // is the human-facing surface of that failure).
  hiddenFailedNames: string[];
}

/** Successful-booking notification for the organiser — the counterpart to
 *  renderEscalationEmail (which only fires when booking FAILS). Every
 *  booking path (all-in, deadline fallback, manual resolve book) shares one
 *  call site in bookPollSlotInternal, so this covers all of them. */
export function renderPollBookedEmail(params: PollBookedEmailParams): PollEmailContent {
  const { pollTitle, slotStartUtc, durationMin, location, organiserTz, attendeeNames, hiddenNames, hiddenFailedNames } =
    params;
  const when = formatDateTime(slotStartUtc, organiserTz);

  // Distinct from renderBookingNoticeEmail's "Booked: <title>" (R8) — that
  // subject goes to a hidden invitee; sharing the exact string with the
  // organiser's own copy would read as a duplicate, or thread the two
  // together in a client that groups by subject.
  const subject = `You booked: ${pollTitle}`;

  const textLines = [`"${pollTitle}" is booked for ${when} (${durationMin} minutes).`];
  if (location) textLines.push(`Where: ${location}`);
  textLines.push(``);
  textLines.push(
    attendeeNames.length > 0
      ? `On the calendar invite: ${attendeeNames.join(", ")}`
      : `No one is listed on the calendar invite.`,
  );
  if (hiddenNames.length > 0) {
    textLines.push(
      `Notified privately (asked to keep their response hidden from other invitees): ${hiddenNames.join(", ")}`,
    );
  }
  if (hiddenFailedNames.length > 0) {
    textLines.push(
      `Could not notify privately — their booking-notice email failed to send, so they may not know about this meeting yet: ${hiddenFailedNames.join(", ")}`,
    );
  }
  const text = textLines.join("\n");

  const html = emailShell(
    `<p><strong>${esc(pollTitle)}</strong> is booked for ${esc(when)} (${durationMin} minutes).${
      location ? `<br>Where: ${esc(location)}` : ""
    }</p>` +
      (attendeeNames.length > 0
        ? `<p>On the calendar invite: ${esc(attendeeNames.join(", "))}</p>`
        : `<p>No one is listed on the calendar invite.</p>`) +
      (hiddenNames.length > 0
        ? `<p>Notified privately (asked to keep their response hidden from other invitees): ${esc(hiddenNames.join(", "))}</p>`
        : ``) +
      (hiddenFailedNames.length > 0
        ? `<p>Could not notify privately — their booking-notice email failed to send, so they may not know about this meeting yet: ${esc(hiddenFailedNames.join(", "))}</p>`
        : ``),
  );

  return { subject, text, html };
}

export interface PollResponseSavedEmailParams {
  pollTitle: string;
  // Real name (falling back to email upstream) — the organiser always sees
  // real identity here, never the pseudonym peers see on the grid.
  respondentName: string;
  isFirstResponse: boolean;
  respondedCount: number;
  totalCount: number;
}

/** Organiser notice for an invitee response save (route.ts's PUT
 *  /poll/:id/response). The route gates repeat saves behind a 15-minute
 *  per-invitee quiet-period debounce (runbook §L) — a first response always
 *  renders/sends; a burst of revisions yields one email total. */
export function renderPollResponseSavedEmail(params: PollResponseSavedEmailParams): PollEmailContent {
  const { pollTitle, respondentName, isFirstResponse, respondedCount, totalCount } = params;
  const verb = isFirstResponse ? "responded to" : "updated their response to";

  const subject = `${respondentName} responded: ${pollTitle}`;

  const text = [
    `${respondentName} ${verb} "${pollTitle}".`,
    ``,
    `${respondedCount} of ${totalCount} invitees have now responded.`,
  ].join("\n");

  const html = emailShell(
    `<p>${esc(respondentName)} ${verb} <strong>${esc(pollTitle)}</strong>.</p>` +
      `<p>${respondedCount} of ${totalCount} invitees have now responded.</p>`,
  );

  return { subject, text, html };
}

export interface EscalationPollInfo {
  id: string;
  title: string;
  durationMin: number;
  deadlineUtc: string;
}

export interface NearMissSlot {
  slotStartUtc: string;
  // Name/pseudonym of the invitee whose absence (dropped, or honouring their
  // if_needed) would let this slot qualify.
  droppedInvitee: string;
}

interface EscalationEmailParams {
  poll: EscalationPollInfo;
  nearMisses: NearMissSlot[];
  organiserTz?: string;
}

export function renderEscalationEmail(params: EscalationEmailParams): PollEmailContent {
  const { poll, nearMisses, organiserTz } = params;
  const deadline = formatDateTime(poll.deadlineUtc, organiserTz);

  const subject = `Action needed: ${poll.title} — no slot works for everyone`;

  const nearMissLines = nearMisses.length
    ? nearMisses.map((m) => `- ${formatDateTime(m.slotStartUtc, organiserTz)} (works if you drop ${m.droppedInvitee})`)
    : ["- No near-miss slots were found."];

  const actions = [
    `- Book a specific time anyway: resolveMeetingPoll(action: "book", slotStartUtc: <one of the times above>)`,
    `- Book the best slot for whoever has responded so far: resolveMeetingPoll(action: "bookBest")`,
    `- Give people more time: updateMeetingPoll(deadlineUtc: <new deadline>)`,
    `- Drop someone from the required set: updateMeetingPoll(removeInviteeIds: [<their id>])`,
  ];

  // Not a fourth resolveMeetingPoll action — a standalone note, so it gets
  // its own paragraph in html and its own blank-line-separated line in text
  // rather than joining the actions bullet list / <ul>.
  const stillOpenNote = `Invitees can still update their availability from their existing links until you book.`;

  const text = [
    `No time works for everyone invited to "${poll.title}" (${poll.durationMin} minutes, deadline ${deadline}).`,
    ``,
    `Near-miss times:`,
    ...nearMissLines,
    ``,
    `You can:`,
    ...actions,
    ``,
    stillOpenNote,
  ].join("\n");

  const nearMissHtml = nearMisses.length
    ? `<ul>${nearMisses
        .map((m) => `<li>${esc(formatDateTime(m.slotStartUtc, organiserTz))} (works if you drop ${esc(m.droppedInvitee)})</li>`)
        .join("")}</ul>`
    : `<p>No near-miss slots were found.</p>`;

  const html = emailShell(
    `<p>No time works for everyone invited to <strong>${esc(poll.title)}</strong> (${poll.durationMin} minutes, deadline ${esc(deadline)}).</p>` +
      `<p>Near-miss times:</p>` +
      nearMissHtml +
      `<p>You can:</p>` +
      `<ul>${actions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` +
      `<p>${esc(stillOpenNote)}</p>`
  );

  return { subject, text, html };
}
