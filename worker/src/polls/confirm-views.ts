// O9.3: what the O9.1 confirm page shows for a deferred meeting-poll op. Each
// builder runs when the agent's call is deferred and produces a plain
// ConfirmView (the page escapes every string): who will be emailed, the exact
// subject and text of that email (rendered by the same renderer the send uses,
// with a placeholder for the per-invitee link that is only minted on confirm),
// and the slot for a booking. Times outside the email text are shown in the
// organiser's own timezone.
import { z } from "@hono/zod-openapi";
import type { Poll, PollInvitee } from "../db/polls";
import {
  formatDateTime,
  renderInviteEmail,
  renderNudgeEmail,
  renderDeadlineExtendedEmail,
  renderPollCancelledEmail,
  renderInviteeRemovedEmail,
  type PollEmailContent,
} from "./emails";

/** The stored summary: exactly a registry ConfirmView, minus `moves`. */
export const PollConfirmView = z.object({
  heading: z.string(),
  recipients: z.array(z.string()).optional(),
  text: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  slot: z.string().optional(),
  notes: z.array(z.string()).optional(),
});
export type PollConfirmView = z.infer<typeof PollConfirmView>;

/** Stands in for each invitee's personal link, which is only minted when the
 *  user confirms. */
export const LINK_PLACEHOLDER = "[their personal link]";

type Person = { email: string; name: string | null };
type Location = { kind: string; detail?: string | null };

export function personLabel(p: Person): string {
  return p.name ? `${p.name} <${p.email}>` : p.email;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function when(iso: string, tz: string): string {
  return `${formatDateTime(iso, tz)} (${tz})`;
}

export function locationLabel(loc: Location): string {
  const detail = (loc.detail ?? "").trim();
  switch (loc.kind) {
    case "meet":
      return "Video call (your calendar adds the link)";
    case "phone":
      return `Phone: ${detail}`;
    case "in_person":
      return `In person: ${detail}`;
    default:
      return detail;
  }
}

function emailLines(prefix: string, mail: PollEmailContent): Array<{ label: string; value: string }> {
  return [
    { label: `${prefix} subject`, value: mail.subject },
    { label: `${prefix} text`, value: mail.text },
  ];
}

interface PollBasics {
  title: string;
  durationMin: number;
  rangeStart: string;
  rangeEnd: string;
}

function basicsOf(poll: Poll): PollBasics {
  return { title: poll.title, durationMin: poll.durationMin, rangeStart: poll.rangeStart, rangeEnd: poll.rangeEnd };
}

function pollBasicsLines(b: PollBasics, deadlineUtc: string, tz: string): Array<{ label: string; value: string }> {
  return [
    { label: "Poll", value: b.title },
    { label: "Length", value: `${b.durationMin} minutes` },
    { label: "Dates", value: `${b.rangeStart} to ${b.rangeEnd}` },
    { label: "Responses close", value: when(deadlineUtc, tz) },
  ];
}

const BOOKING_NOTE =
  "Every invitee listed gets a calendar invite from you. Invitees who chose to hide their name get a private email with the invite attached instead.";

export function createPollView(a: {
  owner: string;
  tz: string;
  basics: PollBasics;
  deadlineUtc: string;
  location: Location;
  guestLink: boolean;
  invitees: Person[];
}): PollConfirmView {
  const mail = renderInviteEmail({
    pollTitle: a.basics.title,
    organiserName: a.owner,
    durationMin: a.basics.durationMin,
    rangeStart: a.basics.rangeStart,
    rangeEnd: a.basics.rangeEnd,
    deadlineUtc: a.deadlineUtc,
    inviteeUrl: LINK_PLACEHOLDER,
  });
  return {
    heading: `Create the meeting poll "${a.basics.title}" and email ${plural(a.invitees.length, "person", "people")} from your mailbox`,
    recipients: a.invitees.map(personLabel),
    text: [
      ...pollBasicsLines(a.basics, a.deadlineUtc, a.tz),
      { label: "Location", value: locationLabel(a.location) },
      {
        label: "Guest link",
        value: a.guestLink
          ? "On: anyone holding the link can add themselves, and Optical emails each of them a personal link from your mailbox"
          : "Off",
      },
      ...emailLines("Invite email", mail),
    ],
    notes: [
      "Once everyone has responded (or at the deadline), Optical books the best slot and sends every invitee a calendar invite.",
    ],
  };
}

export function nudgeView(a: {
  owner: string;
  poll: Poll;
  nonResponders: PollInvitee[];
  respondedCount: number;
  totalCount: number;
}): PollConfirmView {
  const mail = renderNudgeEmail({
    pollTitle: a.poll.title,
    organiserName: a.owner,
    durationMin: a.poll.durationMin,
    rangeStart: a.poll.rangeStart,
    rangeEnd: a.poll.rangeEnd,
    deadlineUtc: a.poll.deadlineUtc,
    inviteeUrl: LINK_PLACEHOLDER,
    respondedCount: a.respondedCount,
    totalCount: a.totalCount,
  });
  return {
    heading: `Send a reminder about "${a.poll.title}" to ${plural(a.nonResponders.length, "invitee", "invitees")} who haven't responded`,
    recipients: a.nonResponders.map(personLabel),
    text: emailLines("Reminder email", mail),
    notes: ["Each reminder carries a fresh personal link; the link in their earlier email stops working."],
  };
}

export function cancelView(a: { owner: string; poll: Poll; recipients: PollInvitee[] }): PollConfirmView {
  const mail = renderPollCancelledEmail({ pollTitle: a.poll.title, organiserName: a.owner, ...basicsOf(a.poll) });
  return {
    heading: `Cancel the meeting poll "${a.poll.title}"`,
    recipients: a.recipients.map(personLabel),
    text: emailLines("Cancellation email", mail),
    notes: ["No meeting will be booked from this poll."],
  };
}

export function bookView(a: { tz: string; poll: Poll; slotStartUtc: string; attendees: PollInvitee[] }): PollConfirmView {
  return {
    heading: `Book "${a.poll.title}" now`,
    recipients: a.attendees.map(personLabel),
    text: [
      { label: "Calendar event", value: a.poll.title },
      { label: "Location", value: locationLabel(a.poll.location as Location) },
    ],
    slot: `${when(a.slotStartUtc, a.tz)}, ${a.poll.durationMin} minutes`,
    notes: [BOOKING_NOTE],
  };
}

export function bookBestView(a: { poll: Poll; attendees: PollInvitee[] }): PollConfirmView {
  const responded = a.attendees.filter((i) => i.respondedAt !== null).length;
  return {
    heading: `Book "${a.poll.title}" now, at the best slot for whoever has responded`,
    recipients: a.attendees.map(personLabel),
    text: [
      { label: "Calendar event", value: a.poll.title },
      { label: "Location", value: locationLabel(a.poll.location as Location) },
    ],
    notes: [
      `Optical picks the slot when you confirm: the best one for the invitees who have responded by then (${responded} of ${a.attendees.length} so far).`,
      BOOKING_NOTE,
    ],
  };
}

export function updateView(a: {
  owner: string;
  tz: string;
  poll: Poll;
  newTitle?: string;
  newLocation?: Location;
  newDeadlineUtc?: string;
  added: Person[];
  removed: PollInvitee[];
  deadlineNotified: PollInvitee[];
  guestChange: "enable" | "disable" | null;
  /** Non-empty when the edit can book (a removal or guest-link disable):
   *  who stays on the poll, i.e. who the calendar invite would go to. */
  bookingAttendees: Person[];
}): PollConfirmView {
  const basics: PollBasics = { ...basicsOf(a.poll), title: a.newTitle ?? a.poll.title };
  const deadline = a.newDeadlineUtc ?? a.poll.deadlineUtc;
  const common = {
    pollTitle: basics.title,
    organiserName: a.owner,
    durationMin: basics.durationMin,
    rangeStart: basics.rangeStart,
    rangeEnd: basics.rangeEnd,
  };
  const text: Array<{ label: string; value: string }> = [];
  if (a.newTitle !== undefined) text.push({ label: "New title", value: a.newTitle });
  if (a.newLocation !== undefined) text.push({ label: "New location", value: locationLabel(a.newLocation) });
  if (a.added.length > 0) {
    text.push({ label: "Invite", value: a.added.map(personLabel).join(", ") });
    text.push(...emailLines("Invite email", renderInviteEmail({ ...common, deadlineUtc: deadline, inviteeUrl: LINK_PLACEHOLDER })));
  }
  if (a.removed.length > 0) {
    text.push({ label: "Remove", value: a.removed.map(personLabel).join(", ") });
    text.push(...emailLines("Removal email", renderInviteeRemovedEmail(common)));
  }
  if (a.newDeadlineUtc !== undefined) {
    text.push({ label: "New deadline", value: when(a.newDeadlineUtc, a.tz) });
    if (a.deadlineNotified.length > 0) {
      text.push({ label: "Deadline email goes to", value: a.deadlineNotified.map(personLabel).join(", ") });
      text.push(
        ...emailLines("Deadline email", renderDeadlineExtendedEmail({ ...common, deadlineUtc: a.newDeadlineUtc, inviteeUrl: LINK_PLACEHOLDER })),
      );
    }
  }
  if (a.guestChange === "enable") {
    text.push({
      label: "Guest link",
      value: "Turn on: anyone holding the link can add themselves, and Optical emails each of them a personal link from your mailbox",
    });
  } else if (a.guestChange === "disable") {
    text.push({ label: "Guest link", value: "Turn off" });
  }
  const recipients = [...a.added.map(personLabel), ...a.removed.map(personLabel), ...a.deadlineNotified.map(personLabel)];
  const notes: string[] = [];
  if (a.bookingAttendees.length > 0) {
    text.push({ label: "If this books, the calendar invite goes to", value: a.bookingAttendees.map(personLabel).join(", ") });
    notes.push("If everyone left on the poll has already responded, this books the meeting straight away and sends calendar invites.");
  }
  return {
    heading: `Edit the meeting poll "${a.poll.title}"`,
    recipients: [...new Set(recipients)],
    text,
    ...(notes.length > 0 ? { notes } : {}),
  };
}
