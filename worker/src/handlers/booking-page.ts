import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { requireOwner } from "../middleware/owner-gate";
import { CLOCK_TIME } from "../schema/common";
import { untrusted } from "../schema/untrusted";
import { loadBookingPage, saveBookingPage, assertSlugAvailable, SlugError, type BookingPageConfig } from "../db/booking-page";
import { listBookingsForOwner } from "../db/bookings";
import {
  validateDurations, DurationError, validateHours, HoursError, validateHorizons, HorizonError,
} from "../booking/slots";
import { validateLocationModes, LocationError, needsOwnerDetail, offerableModes, type LocationKind } from "../booking/location";
import { renderBookingPage } from "../booking/page";
import { confirmationRequired } from "../confirm/gate";
import { deferForConfirmation, confirmationResponses } from "../confirm/defer";
import { registerConfirmableOp } from "../confirm/registry";

/** Hours must use the strict CLOCK_TIME (real clock values only): the loose
 *  `/^\d{2}:\d{2}$/` once accepted "25:00" and "17:99", which reached
 *  `fromLocalNaive` and threw `invalid local datetime` from inside
 *  `computeAvailability` — so the PUT 200'd and every subsequent
 *  `/book/<slug>/slots` call answered `502 calendar_unavailable`, blaming the
 *  calendar for a config the owner had just saved. */
const HoursSchema = z.object({
  days: z.array(z.enum(["sun", "mon", "tue", "wed", "thu", "fri", "sat"])).min(1)
    .describe("Weekdays on which bookings are offered. At least one; an empty list would offer nothing."),
  start: z.string().regex(CLOCK_TIME)
    .describe("Local start time, HH:MM (00:00-23:59), in the owner's timezone. Must be before `end`."),
  end: z.string().regex(CLOCK_TIME)
    .describe("Local end time, HH:MM (00:00-23:59), in the owner's timezone. Must be after `start`."),
}).describe(
  "Booking-specific hours. Null falls back to the owner's business hours. The window must be non-empty: at least one day, and start strictly before end.",
);

const ConfigSchema = z.object({
  slug: z.string().nullable().describe("Public URL segment: the page lives at /book/<slug>. Null until set."),
  enabled: z.boolean().describe("When false the page 404s, even with a slug set."),
  durations_minutes: z.array(z.number().int()).describe(
    "Meeting lengths offered to the booker. Multiples of 15 only (Optical's placement grid); offering 15 switches slot starts to a 15-minute grid, otherwise they are on the half hour.",
  ),
  hours: HoursSchema.nullable(),
  buffer_minutes: z.object({
    before: z.number().int().min(0).describe("Padding reserved before each booking."),
    after: z.number().int().min(0).describe("Padding reserved after each booking."),
  }).describe(
    "Padding kept clear around bookings, also enforced against other bookings. The free gap kept on EITHER side of an existing booking is before+after (not just `before` on the leading edge and `after` on the trailing edge, and not max(before, after)) — claiming a slot pads it by before/after, then pads that guard by before/after again against any other same-owner booking, so the two compose. The same before+after gap is also kept around other busy time (calendar events, pinned tasks) even though nothing there re-pads — a deliberate over-suppression of up to min(before, after) per edge, zero at the shipped default (before:0), in exchange for one uniform rule.",
  ),
  min_notice_minutes: z.number().int().min(0).describe("No slot is offered sooner than this many minutes from now."),
  horizon_days: z.number().int().min(1).max(120).describe(
    "Days of availability served per page of the public booking page (1-120), and all a booker sees until they ask for more. The public `GET /book/{slug}/slots` endpoint takes a `page` index; page k covers days [k*horizon_days, (k+1)*horizon_days) from now, each page costing one calendar read.",
  ),
  max_horizon_days: z.number().int().min(1).max(365).nullable().describe(
    "How far into the future a booker may page, in days from now (1-365), or null for one page only (the reach equals `horizon_days` — the default, and the behaviour before paging existed). Must be at least `horizon_days` (`400 invalid_horizon` otherwise, checked against the merged config, not just this body). Pages past the reach are `400 page_out_of_range`; the last page is clamped to it.",
  ),
  bookable_over_movable_meetings: z.boolean().describe(
    "When true, time held by a meeting Optical can relocate is offered as bookable — the meeting must be owned by you, outside the meeting notice window, not itself a booking, currently unpinned and not done/cancelled, AND carrying a fresh positive movable verdict. That verdict is what the last resolve actually decided: every resolve records, per meeting, whether it could really be moved, and freezes it (recording a negative verdict) when a constraining attendee's free/busy cannot be read, when it starts inside the notice window, or when Optical moved it too recently. A meeting with no verdict, a negative one, or one older than 7 days is never offered — so the page only promises a reschedule Optical will actually perform. A displaced meeting reaches you through the normal proposed-plan email; it is never moved automatically.",
  ),
  location: z.object({
    modes: z.array(
      z.object({
        kind: z.enum(["meet", "phone", "custom", "in_person"]).describe(
          "meet asks the calendar provider for a Google Meet link and collects nothing. phone collects the BOOKER's number so you ring them — it never publishes yours. in_person collects a free-text place from the booker; there is no default, and 'TBC' is normal. custom shows fixed text you set and the booker cannot change.",
        ),
        detail: z.string().nullable().optional().describe(
          "Fixed text shown for kind 'custom', which requires it. Every other kind must omit it — for 'phone' and 'in_person' the booker supplies the value at booking time. Max 200 characters. This text is PUBLIC: it renders on the booking page, before any challenge, to anyone holding the slug.",
        ),
      }),
    ).describe(
      "Meeting types offered, in the order the booker sees them. Absence means not offered, so a page can be call-only. At least one, at most four, no duplicate kinds.",
    ),
  }).describe("How the booked meeting happens. The booker picks from the offered set."),
  event_title: z.string().describe("Calendar event title. '{booker_name}' is replaced with the booker's name."),
}).describe("Public booking page configuration.");

const PutBody = ConfigSchema.partial().describe("Only the supplied fields change.");
export { PutBody as BookingPagePutBody };

/** How each patchable field is named to the owner on the confirm page. A
 *  Record over the schema's keys, so a new field without a label is a type
 *  error (and a test failure). */
export const BOOKING_PAGE_FIELD_LABELS: Record<keyof z.infer<typeof ConfigSchema>, string> = {
  slug: "the page address",
  enabled: "whether the page is on",
  durations_minutes: "the meeting lengths offered",
  hours: "the hours bookings are offered",
  buffer_minutes: "the buffer time kept around bookings",
  min_notice_minutes: "the minimum notice for a booking",
  horizon_days: "how many days ahead bookers see at first",
  max_horizon_days: "how far ahead bookers can look",
  bookable_over_movable_meetings: "whether time held by meetings Optical can move is offered",
  location: "how the meeting happens",
  event_title: "the calendar event title",
};
const ErrorResponse = z.object({
  error: z.string().describe("Machine-readable error code."),
  detail: z.string().optional().describe("Human-readable detail; not machine-readable."),
});
const BookingSchema = z.object({
  id: z.string().describe("Booking id."),
  start_utc: z.string().describe("Booking start (ISO 8601, UTC)."),
  end_utc: z.string().describe("Booking end (ISO 8601, UTC)."),
  duration_minutes: z.number().int().describe("Booked length in minutes, excluding buffers."),
  booker_name: untrusted(z.string().describe("Name the booker gave. Booker-supplied text.")),
  booker_email: untrusted(z.string().describe("Email the booker gave; the calendar invite goes here. Booker-supplied text.")),
  booker_note: untrusted(z.string().nullable().describe("Free-text note from the booker, or null. Booker-supplied text.")),
  location_kind: z.string().nullable().describe("Meeting type the booker chose; null for bookings made before this was offered."),
  location_detail: untrusted(z.string().nullable().describe("Phone number or place the booker supplied, if their choice collects one. Booker-supplied text.")),
  status: z.string().describe("reserving | confirmed | cancelled. Failed reservations are omitted."),
  google_event_id: z.string().nullable().describe("Calendar event created for this booking; null until confirmed."),
  created_at: z.string().describe("When the slot was claimed (ISO 8601, UTC)."),
  poll_id: z.string().nullable().describe("Meeting poll that made this booking (resolveMeetingPoll/auto-book), or null for a booking-page booking."),
}).describe("A claimed slot.");

const errs = {
  401: { content: { "application/json": { schema: ErrorResponse } }, description: "Missing/invalid bearer" },
  403: { content: { "application/json": { schema: ErrorResponse } }, description: "Feature disabled or token carries no subject" },
} as const;

function disabled(c: { env: Env }): boolean {
  return c.env.BOOKING_PAGE_ENABLED !== "true";
}

type BookingPagePatch = z.infer<typeof PutBody>;
type PatchError = { status: 400 | 409; error: string; detail: string };

/** saveBookingPage raises SlugError for both a malformed slug and one another
 *  owner already holds; only the latter is a 409. */
function slugError(err: SlugError): PatchError {
  const taken = err.message.includes("already taken");
  return { status: taken ? 409 : 400, error: taken ? "slug_taken" : "invalid_slug", detail: err.message };
}

/** Every check the schema can't state, against the live config. Shared by the
 *  handler and the O9.4 confirm replay, so a confirmed edit is validated
 *  against the config as it is at confirm time, not as it was when asked. */
async function validatePatch(db: D1Database, owner: string, patch: BookingPagePatch): Promise<PatchError | null> {
  const fail = (error: string, err: Error): PatchError => ({ status: 400, error, detail: err.message });
  if (patch.durations_minutes) {
    try {
      validateDurations(patch.durations_minutes);
    } catch (err) {
      if (err instanceof DurationError) return fail("invalid_duration", err);
      throw err;
    }
  }
  // Cross-field, so the schema cannot state it: start must precede end.
  if (patch.hours) {
    try {
      validateHours(patch.hours);
    } catch (err) {
      if (err instanceof HoursError) return fail("invalid_hours", err);
      throw err;
    }
  }
  // Cross-field, so the schema cannot state it: which kinds require/forbid
  // `detail`, no duplicates, at least one offered.
  if (patch.location) {
    try {
      validateLocationModes(patch.location.modes);
    } catch (err) {
      if (err instanceof LocationError) return fail("invalid_location", err);
      throw err;
    }
  }
  // Cross-field AND cross-request: the reach must cover one page on the
  // config as it will be stored, so a patch to either field is checked
  // against the other's current value — otherwise a two-step edit stores
  // what a one-step edit is refused for.
  if (patch.horizon_days !== undefined || patch.max_horizon_days !== undefined) {
    const current = await loadBookingPage(db, owner);
    try {
      validateHorizons(
        patch.horizon_days ?? current.horizon_days,
        patch.max_horizon_days === undefined ? current.max_horizon_days : patch.max_horizon_days,
      );
    } catch (err) {
      if (err instanceof HorizonError) return fail("invalid_horizon", err);
      throw err;
    }
  }
  return null;
}

// ---- O9.4: publishing through the agent-confirm gate -----------------------

const PUBLISH_OP = "updateBookingPage";

/** Location modes in one canonical shape, so a re-sent identical location
 *  compares equal to the stored one. */
function canonicalModes(modes: Array<{ kind: LocationKind; detail?: string | null }>) {
  return modes.map((m) => (needsOwnerDetail(m.kind) ? { kind: m.kind, detail: m.detail ?? null } : { kind: m.kind }));
}

/** The publicly visible part of a page: what O9.4 gates, and what a confirm
 *  replay checks is unchanged since the agent asked. */
const PublishedState = z.object({
  enabled: z.boolean(),
  slug: z.string().nullable(),
  event_title: z.string(),
  location: z.array(z.object({ kind: z.enum(["meet", "phone", "custom", "in_person"]), detail: z.string().nullable().optional() })),
});
type PublishedState = z.infer<typeof PublishedState>;

function publishedState(cfg: BookingPageConfig): PublishedState {
  return { enabled: cfg.enabled, slug: cfg.slug, event_title: cfg.event_title, location: canonicalModes(cfg.location.modes) };
}

function stateAfter(current: BookingPageConfig, patch: BookingPagePatch): PublishedState {
  return {
    enabled: patch.enabled ?? current.enabled,
    slug: patch.slug === undefined ? current.slug : patch.slug,
    event_title: patch.event_title ?? current.event_title,
    location: patch.location ? canonicalModes(patch.location.modes) : canonicalModes(current.location.modes),
  };
}

/** True when the patch would put something new on the public page: turning it
 *  on, or, while it stays on, a new slug, event title or location. Anything
 *  that leaves the page off (or turns it off) publishes nothing. */
function publishesChange(current: BookingPageConfig, patch: BookingPagePatch): boolean {
  const before = publishedState(current);
  const after = stateAfter(current, patch);
  if (!after.enabled) return false;
  if (!before.enabled) return true;
  return after.slug !== before.slug
    || after.event_title !== before.event_title
    || JSON.stringify(after.location) !== JSON.stringify(before.location);
}

const LOCATION_LABEL: Record<Exclude<LocationKind, "custom">, string> = {
  meet: "Google Meet video call",
  phone: "Phone call (the booker gives their number)",
  in_person: "In person (the booker names the place)",
};

const PublishSummary = z.object({
  enabling: z.boolean(),
  public_url: z.string().nullable(),
  event_title: z.string(),
  location: z.array(z.string()),
  changes: z.array(z.string()),
  /** What the preview renders: the page as it will be after the change.
   *  Optional so a summary stored before previews existed still renders. */
  preview: z.object({
    slug: z.string(),
    durations: z.array(z.number().int()),
    modes: PublishedState.shape.location,
  }).optional(),
});
type PublishSummary = z.infer<typeof PublishSummary>;

function publicUrl(env: Pick<Env, "OAUTH_ISSUER">, slug: string | null): string | null {
  return slug ? `${env.OAUTH_ISSUER}/book/${slug}` : null;
}

function publishSummary(env: Pick<Env, "OAUTH_ISSUER">, current: BookingPageConfig, patch: BookingPagePatch): PublishSummary {
  const before = publishedState(current);
  const after = stateAfter(current, patch);
  const changes: string[] = [];
  if (!before.enabled) changes.push("Turns the booking page on: anyone with the address can book time with you.");
  if (after.slug !== before.slug) {
    changes.push(before.slug ? `Changes the address (it was ${publicUrl(env, before.slug)}).` : "Sets the page's address.");
  }
  if (after.event_title !== before.event_title) changes.push("Changes the calendar event title.");
  if (JSON.stringify(after.location) !== JSON.stringify(before.location)) changes.push("Changes how the meeting happens.");
  const others = (Object.keys(patch) as Array<keyof BookingPagePatch>)
    .filter((k) => !["enabled", "slug", "event_title", "location"].includes(k)).sort()
    .map((k) => BOOKING_PAGE_FIELD_LABELS[k]);
  if (others.length > 0) changes.push(`Also changes: ${others.join(", ")}.`);
  return {
    enabling: !before.enabled,
    public_url: publicUrl(env, after.slug),
    event_title: after.event_title,
    location: after.location.map((m) => (m.kind === "custom" ? `Fixed text shown to bookers: ${m.detail ?? ""}` : LOCATION_LABEL[m.kind])),
    changes,
    ...(after.slug
      ? { preview: { slug: after.slug, durations: patch.durations_minutes ?? current.durations_minutes, modes: after.location } }
      : {}),
  };
}

/** Stands in for the booker's name wherever the title template uses it. */
const EXAMPLE_BOOKER = "Alex Example";
const BOOKER_NAME = "{booker_name}";

function eventTitleExample(template: string): string {
  return template.includes(BOOKER_NAME)
    ? `${template.split(BOOKER_NAME).join(EXAMPLE_BOOKER)} (for example: each booking fills in the booker's name)`
    : template;
}

const refused = (reason: string, message: string) => ({ ok: false as const, reason, message });

registerConfirmableOp(PUBLISH_OP, {
  label: "Publish changes to your booking page",
  payloadSchema: z.object({ patch: PutBody, expected: PublishedState }),
  summarySchema: PublishSummary,
  render: (s) => ({
    heading: s.enabling ? "Turn on your public booking page" : "Change your live booking page",
    ...(s.preview
      ? {
        preview: {
          caption: "Preview: what a booker will see (example times)",
          html: renderBookingPage({
            slug: s.preview.slug,
            durations: s.preview.durations,
            siteKey: "",
            modes: offerableModes(s.preview.modes),
            preview: true,
          }),
        },
      }
      : {}),
    text: [
      { label: "Public page", value: s.public_url ?? "No address set, so the page stays unreachable until it has one" },
      { label: "Event title", value: eventTitleExample(s.event_title) },
      { label: "Location", value: s.location.join("; ") },
    ],
    notes: s.changes,
  }),
  replay: async (env, owner, { patch, expected }) => {
    if (env.BOOKING_PAGE_ENABLED !== "true") {
      return refused("feature_disabled", "Booking pages are turned off on this service, so nothing was changed.");
    }
    const current = await loadBookingPage(env.DB, owner);
    // The summary the user just approved described the page as it was then;
    // if its public part has moved since, that approval no longer holds.
    if (JSON.stringify(publishedState(current)) !== JSON.stringify(expected)) {
      return refused("stale", "Your booking page changed after this was requested, so nothing was changed. Ask your assistant again if you still want it.");
    }
    const invalid = await validatePatch(env.DB, owner, patch);
    if (invalid) return refused(invalid.error, `Nothing was changed: ${invalid.detail}.`);
    let saved: BookingPageConfig;
    try {
      saved = await saveBookingPage(env.DB, owner, patch as Partial<BookingPageConfig>);
    } catch (err) {
      if (err instanceof SlugError) {
        const e = slugError(err);
        return refused(e.error, `Nothing was changed: ${e.detail}.`);
      }
      throw err;
    }
    const url = saved.enabled ? publicUrl(env, saved.slug) : null;
    return url
      ? { ok: true, message: "Your booking page is live.", links: [{ label: "Open your booking page", url }] }
      : { ok: true, message: "Your booking page is updated." };
  },
});

export function mountBookingPageRoutes(app: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>) {
  // Auth and the feature flag must be checked before @hono/zod-openapi's
  // built-in body/query validator (which runs ahead of the route handler),
  // otherwise a disabled-flag or unauthenticated request with an invalid body
  // gets a 400 instead of the 401/403 it should — the caller can't distinguish
  // "malformed" from "not allowed to be here at all". Both paths are exact:
  // neither route has sub-paths.
  const gate = async (c: Parameters<typeof requireOwner>[0], next: () => Promise<void>) => {
    const owner = await requireOwner(c);
    if (owner instanceof Response) return owner;
    if (disabled(c)) return c.json({ error: "feature_disabled" }, 403);
    await next();
    return;
  };
  app.use("/booking-page", gate);
  app.use("/bookings", gate);

  const get = createRoute({
    method: "get", path: "/booking-page", operationId: "getBookingPage", tags: ["booking"],
    summary: "Read the booking page configuration",
    description: "Returns the caller's effective booking page config: their own row merged over the instance defaults.",
    security: [{ BearerAuth: [] }],
    responses: {
      200: { description: "Current configuration.", content: { "application/json": { schema: ConfigSchema } } },
      ...errs,
    },
  });
  app.openapi(get, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner gate above
    return c.json(await loadBookingPage(c.env.DB, owner), 200);
  });

  const put = createRoute({
    method: "put", path: "/booking-page", operationId: "updateBookingPage", tags: ["booking"],
    summary: "Update the booking page configuration",
    description:
      "Patches the caller's booking page. Slugs are lowercase alphanumeric with hyphens, 2-31 characters, globally unique, and a reserved-word list is rejected. " +
      "Agent-confirm clients (AGENT_CONFIRM_CLIENT_IDS) cannot publish on their own: an edit that turns the page on (enabled false to true), or that changes the slug, `event_title` or `location` while the page is on, is validated (400/409 still come back at once) and then NOT applied; it returns 202 awaiting_confirmation and the user is emailed a link showing the public address, title and location. The whole edit, including any other fields in the same body, applies only when they confirm, and only if the page's public state is still what it was and the slug is still free. Every other edit, and every other client, applies immediately.",
    security: [{ BearerAuth: [] }],
    request: { body: { content: { "application/json": { schema: PutBody } } } },
    responses: {
      200: { description: "Updated configuration.", content: { "application/json": { schema: ConfigSchema } } },
      400: {
        description: "Invalid slug, duration, hours, horizon or location (`invalid_slug`, `invalid_duration`, `invalid_hours`, `invalid_horizon`, `invalid_location`; `validation_failed` for anything the schema itself rejects).",
        content: { "application/json": { schema: ErrorResponse } },
      },
      409: { description: "Slug already taken.", content: { "application/json": { schema: ErrorResponse } } },
      ...confirmationResponses,
      ...errs,
    },
  });
  app.openapi(put, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner gate above
    const patch = c.req.valid("json") as BookingPagePatch;
    const invalid = await validatePatch(c.env.DB, owner, patch);
    if (invalid) return c.json({ error: invalid.error, detail: invalid.detail }, invalid.status);

    // O9.4: an agent-confirm client may not publish on its own. Anything that
    // puts new public text or a new address live waits for the user's emailed
    // confirmation; every other edit (and every ungated client) applies now.
    if (confirmationRequired(c)) {
      const current = await loadBookingPage(c.env.DB, owner);
      if (publishesChange(current, patch)) {
        // Refuse a slug that can't be had now, rather than mail a link that
        // can only fail; the replay checks again.
        if (patch.slug != null && patch.slug !== current.slug) {
          try {
            await assertSlugAvailable(c.env.DB, owner, patch.slug);
          } catch (err) {
            if (err instanceof SlugError) { const e = slugError(err); return c.json({ error: e.error, detail: e.detail }, e.status); }
            throw err;
          }
        }
        return deferForConfirmation(c, {
          op: PUBLISH_OP,
          payload: { patch, expected: publishedState(current) },
          summary: publishSummary(c.env, current, patch),
        }) as never;
      }
    }

    try {
      return c.json(await saveBookingPage(c.env.DB, owner, patch as Partial<BookingPageConfig>), 200);
    } catch (err) {
      if (err instanceof SlugError) { const e = slugError(err); return c.json({ error: e.error, detail: e.detail }, e.status); }
      throw err;
    }
  });

  const list = createRoute({
    method: "get", path: "/bookings", operationId: "listBookings", tags: ["booking"],
    summary: "List bookings in a window",
    description:
      "Bookings overlapping [from, to), for this owner's management view — includes reserving, " +
      "confirmed, AND cancelled rows (released reservations are still omitted). This is NOT the " +
      "slot-blocking set: a cancelled booking's slot is already available again. A booking is " +
      "auto-cancelled when its sole attendee declines the calendar invite and doesn't undo that " +
      "within a short grace period; see CLAUDE.md's \"decline auto-cancel\" note.",
    security: [{ BearerAuth: [] }],
    request: {
      // Validated here rather than in the handler: both reach
      // `new Date(iso).toISOString()`, which throws on junk and would surface
      // as a bodyless 500. `offset: true` keeps ordinary ISO 8601 with a
      // numeric offset (what most clients' isoformat() emits) acceptable.
      query: z.object({
        from: z.string().datetime({ offset: true }).describe("Window start (ISO 8601)."),
        to: z.string().datetime({ offset: true }).describe("Window end (ISO 8601)."),
      }),
    },
    responses: {
      200: {
        description: "Bookings, ascending by start.",
        content: {
          "application/json": {
            schema: z.object({
              bookings: z.array(BookingSchema).describe("Matching bookings, ascending by start."),
            }),
          },
        },
      },
      ...errs,
    },
  });
  app.openapi(list, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner gate above
    const { from, to } = c.req.valid("query");
    const rows = await listBookingsForOwner(c.env.DB, owner, from, to);
    return c.json({
      bookings: rows.map((r) => ({
        id: r.id, start_utc: r.start_utc, end_utc: r.end_utc,
        duration_minutes: r.duration_minutes, booker_name: r.booker_name,
        booker_email: r.booker_email, booker_note: r.booker_note,
        location_kind: r.location_kind, location_detail: r.location_detail,
        status: r.status, google_event_id: r.google_event_id, created_at: r.created_at,
        poll_id: r.poll_id,
      })),
    }, 200);
  });
}
