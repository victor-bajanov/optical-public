import type { CalendarEvent } from "./types";

// Fixed namespace GUID for Optical's MAPI named properties (the Graph analogue
// of Google extendedProperties.private). Generated once for this codebase —
// never change it or existing stamped events become invisible to us.
export const SCHEDULER_PROPERTY_GUID = "7f9d5e6a-1b3c-4a8d-9e2f-6c5b4a3d2e1f";

// Outlook has categories, not event colors. This named category is the M365
// done-marking signal: the user's done_color_id is set to this exact string
// (see spec §F) and the mapping below translates it to/from colorId.
export const OPTICAL_DONE_CATEGORY = "Optical Done";

export function graphPropId(name: string): string {
  return `String {${SCHEDULER_PROPERTY_GUID}} Name ${name}`;
}

export interface GraphEvent {
  id: string;
  subject?: string;
  body?: { contentType?: string; content?: string };
  bodyPreview?: string;
  location?: { displayName?: string };
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  showAs?: string;
  isCancelled?: boolean;
  isAllDay?: boolean;
  isOrganizer?: boolean;
  organizer?: { emailAddress?: { address?: string } };
  attendees?: Array<{
    type?: string;
    status?: { response?: string };
    emailAddress?: { address?: string };
  }>;
  categories?: string[];
  singleValueExtendedProperties?: Array<{ id: string; value: string }>;
  "@removed"?: { reason?: string };
}

/** Graph with Prefer: outlook.timezone="UTC" returns naive datetimes like
 *  "2026-07-06T09:00:00.0000000" — normalise to the internal ISO-Z form. */
export function isoZ(graphDateTime: string): string {
  const suffixed = /[zZ]$|[+-]\d\d:\d\d$/.test(graphDateTime) ? graphDateTime : `${graphDateTime}Z`;
  const d = new Date(suffixed);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid graph datetime: ${graphDateTime}`);
  return d.toISOString();
}

/** Mirror of google-calendar-provider isBusyEvent: showAs "free" and
 *  "workingElsewhere" are transparent for the solver; busy/tentative/oof all
 *  block HERE unconditionally. This is separate from the
 *  CalendarEvent.status:"tentative" mapping in toCalendarEventFromGraph
 *  below, which busy-blocks.ts only treats as busy when TENTATIVE_IS_BUSY
 *  is set — the two live at different layers and are not meant to agree. */
export function isBusyGraphEvent(g: GraphEvent): boolean {
  return g.showAs !== "free" && g.showAs !== "workingElsewhere";
}

const RESPONSE_MAP: Record<string, "needsAction" | "declined" | "tentative" | "accepted"> = {
  accepted: "accepted",
  declined: "declined",
  tentativelyAccepted: "tentative",
  organizer: "accepted",
  notResponded: "needsAction",
  none: "needsAction",
};

export function toCalendarEventFromGraph(g: GraphEvent): CalendarEvent {
  const organizerEmail = g.organizer?.emailAddress?.address;
  const priv: Record<string, string> = {};
  const prefix = `String {${SCHEDULER_PROPERTY_GUID}} Name `;
  for (const p of g.singleValueExtendedProperties ?? []) {
    if (p.id.startsWith(prefix)) priv[p.id.slice(prefix.length)] = p.value;
  }
  const hasDoneCategory = (g.categories ?? []).includes(OPTICAL_DONE_CATEGORY);
  return {
    id: g.id,
    summary: g.subject ?? "",
    start: g.start?.dateTime ? isoZ(g.start.dateTime) : "",
    end: g.end?.dateTime ? isoZ(g.end.dateTime) : "",
    location: g.location?.displayName,
    description: g.body?.content ?? g.bodyPreview,
    colorId: hasDoneCategory ? OPTICAL_DONE_CATEGORY : undefined,
    status: g.isCancelled ? "cancelled" : g.showAs === "tentative" ? "tentative" : "confirmed",
    // showAs "oof" is deliberately NOT mapped to eventType:"outOfOffice":
    // Graph's oof is a per-appointment flag on any event (any duration),
    // whereas Google's eventType:"outOfOffice" is a deliberate whole-day
    // event kind — busy-blocks.ts expands it to block the entire local day.
    // Mapping it here would let a 30-minute Graph appointment wipe a day.
    isAllDay: g.isAllDay,
    extendedProperties: { private: Object.keys(priv).length ? priv : undefined, shared: undefined },
    organizer: organizerEmail
      ? { email: organizerEmail, self: g.isOrganizer === true }
      : undefined,
    attendees: g.attendees
      ?.filter((a) => typeof a.emailAddress?.address === "string")
      .map((a) => ({
        email: a.emailAddress!.address!,
        responseStatus: RESPONSE_MAP[a.status?.response ?? "none"] ?? "needsAction",
        optional: a.type === "optional",
        resource: a.type === "resource",
        // Case-insensitive: Graph can return the organizer's address and the
        // matching attendee row's address with different casing even though
        // they denote the same mailbox.
        self:
          g.isOrganizer === true &&
          organizerEmail !== undefined &&
          a.emailAddress!.address!.toLowerCase() === organizerEmail.toLowerCase(),
      })),
  };
}

/** Internal partial-CalendarEvent → Graph PATCH/POST body fields. colorId is
 *  the done-category translation: OPTICAL_DONE_CATEGORY sets it, "" clears,
 *  any other value (e.g. a Google-style numeric colorId) omits `categories`
 *  entirely so it is left untouched on the Graph event. */
export function toGraphPatch(changes: Partial<CalendarEvent>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (changes.summary !== undefined) patch.subject = changes.summary;
  if (changes.description !== undefined) patch.body = { contentType: "text", content: changes.description };
  if (changes.location !== undefined) patch.location = { displayName: changes.location };
  if (changes.start !== undefined) patch.start = { dateTime: changes.start, timeZone: "UTC" };
  if (changes.end !== undefined) patch.end = { dateTime: changes.end, timeZone: "UTC" };
  if (changes.colorId === OPTICAL_DONE_CATEGORY) {
    patch.categories = [OPTICAL_DONE_CATEGORY];
  } else if (changes.colorId === "") {
    patch.categories = []; // explicit clear
  }
  // Any other colorId (e.g. a Google-style numeric colorId like "11", which has
  // no Graph meaning) is neither the done marker nor an explicit clear — omit
  // `categories` from the patch so a worker recolour doesn't wipe the user's
  // pre-existing Outlook categories on this event.
  if (changes.extendedProperties?.private !== undefined) {
    patch.singleValueExtendedProperties = Object.entries(changes.extendedProperties.private ?? {})
      .map(([name, value]) => ({ id: graphPropId(name), value }));
  }
  return patch;
}
