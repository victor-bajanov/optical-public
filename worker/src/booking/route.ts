import type { Hono } from "hono";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { defaultCalendarProvider } from "../index-providers";
import type { CalendarEvent } from "../providers/types";
import { hashToken } from "../auth/tokens";
import { hashingKey } from "../auth/crypto-keys";
import { findOwnerBySlug, loadBookingPage } from "../db/booking-page";
import {
  claimSlot,
  confirmBooking,
  failBooking,
  countRecentByIp,
  countTodayByOwner,
} from "../db/bookings";
import { computeAvailability, PageOutOfRangeError, type AvailabilityResult } from "./availability";
import { pageForStart, pageWindow } from "./slots";
import {
  locationForEvent,
  needsBookerDetail,
  offerableModes,
  LocationError,
  MAX_LOCATION_LENGTH,
  ALL_KINDS,
  type EventLocation,
  type LocationKind,
} from "./location";
import { verifyTurnstile, MAX_CLAIMS_PER_IP_24H, MAX_CLAIMS_PER_PAGE_24H } from "./turnstile";
import { renderBookingPage, BOOKING_PAGE_CSP } from "./page";
import { BOOKING_CLIENT_JS, BOOKING_CLIENT_HASH } from "./booking-client-source.generated";

/** Deliberately narrower than RFC 5321: `<>"',;` are the characters that make
 *  an address dangerous *downstream* rather than invalid. The address is
 *  embedded in the event description as `<${email}>`, which Google renders with
 *  a limited HTML subset, and `,`/`;` are address-list separators. A single `@`
 *  is still enforced by the character classes, so a second address cannot be
 *  smuggled into the attendee list either. */
const EMAIL_RE = /^[^@\s<>"',;]+@[^@\s.<>"',;]+\.[^@\s<>"',;]+$/;
const MAX_NAME_LENGTH = 120;
const MAX_NOTE_LENGTH = 2000;
/** RFC 5321's cap on a full address. The regex alone bounds neither side. */
const MAX_EMAIL_LENGTH = 254;
/** Ceiling on the claim request body, checked before anything reads it. A real
 *  claim is well under 3 KB even with a full-length name and note, so this
 *  leaves generous headroom while keeping an unauthenticated caller from
 *  spending worker CPU on a multi-megabyte parse ahead of the Turnstile gate. */
export const MAX_CLAIM_BODY_BYTES = 16 * 1024;

/** Strip what makes booker-authored text dangerous once it reaches the owner's
 *  calendar: angle brackets (Google renders a limited HTML subset in event
 *  descriptions, so an anchor in a note becomes a live link) and control
 *  characters. `singleLine` also folds newlines and runs of whitespace, for the
 *  event title — a title is one line.
 *
 *  This bounds what the text can *say*; it does not fix who receives it. The
 *  booker's email address is never verified, so a claimant still chooses the
 *  recipient of an invitation Google sends, DKIM-signed, from the owner's own
 *  account. Emailing a confirmation link to the address before writing the
 *  event is the real fix, and is deliberately deferred.
 *
 *  Only the calendar copy is sanitised — D1 keeps the text exactly as submitted,
 *  so the owner sees what the booker really typed. */
function sanitiseForCalendar(text: string, singleLine = false): string {
  // Tab, LF and CR are excluded from the control-character class: a note keeps
  // its own line breaks.
  const stripped = text
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return singleLine ? stripped.replace(/\s+/g, " ").trim() : stripped;
}

/** The single 404 every failure path returns. Feature off, unknown slug and
 *  disabled page must be byte-identical, or the endpoint becomes a slug oracle. */
function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "X-Robots-Tag": "noindex" },
  });
}

/** The page fields every slot list carries — on a 200 and on a 409's courtesy
 *  list alike — so the client can splice the list into the pages it holds
 *  rather than replace them all. `window` is the half-open span the list
 *  covers, as ISO instants; the client cannot derive it (it never learns
 *  `horizon_days`, nor the server's `now`). */
function pageFields(a: Pick<AvailabilityResult, "page" | "window" | "hasMore">) {
  return {
    page: a.page,
    has_more: a.hasMore,
    window: {
      start: new Date(a.window.startMs).toISOString(),
      end: new Date(a.window.endMs).toISOString(),
    },
  };
}

/** `page` query → a non-negative integer, or null for anything else. Absent
 *  is page 0 (the pre-paging request shape); "" and other junk are not. */
function parsePage(raw: string | undefined): number | null {
  if (raw === undefined) return 0;
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

/** The keys a claim may carry. Every value arrives from untrusted JSON, so they
 *  are `unknown` and narrowed by the validation in the handler — declaring them
 *  as strings would make the runtime type checks look redundant when they are
 *  the only thing standing between a JSON object and a `.trim()` or a `.bind()`. */
interface ClaimBody {
  start?: unknown;
  duration_minutes?: unknown;
  name?: unknown;
  email?: unknown;
  note?: unknown;
  location_kind?: unknown;
  location_detail?: unknown;
  turnstile_token?: unknown;
}

/** Public, UNAUTHENTICATED booking page. Mounted on the root app ahead of any
 *  auth: the slug is public by design, and abuse is handled by Turnstile plus
 *  rate limits rather than by secrecy. */
export function mountBookingRoutes(app: Hono<{ Bindings: Env; Variables: AppVariables }>) {
  /** Resolve slug -> owner + config, or null when anything is off/absent. The
   *  flag check comes first so a disabled deployment never advertises the
   *  feature, and every failure is an opaque 404.
   *
   *  Stored slugs are always lowercase (validateSlug rejects anything else), but
   *  these are public URLs retyped off a business card or an email signature, so
   *  the path segment is lowercased before the (exact-match) lookup — that, not
   *  a case-insensitive collation, is what makes /book/Victor resolve. Callers
   *  use the lowercased `slug` returned here rather than the raw path segment;
   *  it is by construction the form the config row holds, since the row matched
   *  this exact string. */
  async function resolvePage(c: { env: Env }, rawSlug: string) {
    if (c.env.BOOKING_PAGE_ENABLED !== "true") return null;
    const slug = rawSlug.toLowerCase();
    const owner = await findOwnerBySlug(c.env.DB, slug);
    if (!owner) return null;
    const config = await loadBookingPage(c.env.DB, owner);
    if (!config.enabled) return null;
    return { owner, config, slug };
  }

  // Literal path registered before the /book/:slug parameter route below, so
  // it wins the match instead of being swallowed as a "slug".
  //
  // The filename carries a content hash of the module. That is what makes the
  // immutable cache below safe, and it is not a nicety: this asset used to be
  // served at a FIXED url with `max-age=3600` and neither an ETag nor a
  // Last-Modified, so browsers had nothing to revalidate against and simply
  // reused their copy for an hour. A deploy fixing the .ics parser therefore
  // did not reach anyone who had opened the page recently — including, at
  // first, us. Now every edit changes the url, so a deploy lands at once.
  //
  // Only the current hash is routed. A stale url 404s rather than silently
  // serving today's bytes under yesterday's name, and the shell that names it
  // is sent `no-cache` so a browser always learns the current hash.
  app.get(`/book/_static/booking.${BOOKING_CLIENT_HASH}.js`, (c) => {
    if (c.env.BOOKING_PAGE_ENABLED !== "true") return notFound();
    return new Response(BOOKING_CLIENT_JS, {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  });

  app.get("/book/:slug", async (c) => {
    const page = await resolvePage(c, c.req.param("slug"));
    if (!page) return notFound();
    return new Response(
      renderBookingPage({
        slug: page.slug,
        durations: page.config.durations_minutes,
        siteKey: c.env.TURNSTILE_SITE_KEY ?? "",
        modes: offerableModes(page.config.location.modes),
      }),
      {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          // The shell names the content-hashed client asset, so it must never
          // be reused from cache: a stale shell asks for a hash that no longer
          // routes, which is a broken page rather than merely a stale one.
          // `no-cache` means revalidate before use, not "never store".
          "cache-control": "no-cache",
          "X-Robots-Tag": "noindex",
          "Content-Security-Policy": BOOKING_PAGE_CSP,
          // Belt and braces with the policy's frame-ancestors, for browsers
          // that never implemented it. A claim here sends an invitation from
          // the owner's account, so this is worth clickjacking.
          "X-Frame-Options": "DENY",
        },
      },
    );
  });

  app.get("/book/:slug/slots", async (c) => {
    const page = await resolvePage(c, c.req.param("slug"));
    if (!page) return notFound();

    const duration = Number(c.req.query("duration"));
    if (!page.config.durations_minutes.includes(duration)) {
      return json({ error: "duration_not_offered" }, 400);
    }
    // One page per request, each a single calendar read sized to
    // `horizon_days`; how far the pages go is the owner's `max_horizon_days`.
    const pageIndex = parsePage(c.req.query("page"));
    if (pageIndex === null) return json({ error: "invalid_page" }, 400);

    const cal = c.get("calendarProvider") ?? await defaultCalendarProvider(c.env, page.owner);
    try {
      const availability = await computeAvailability(
        c.env.DB,
        c.env,
        page.owner,
        cal,
        duration,
        new Date(),
        pageIndex,
      );
      return json({
        slots: availability.slots,
        timezone: availability.tz,
        duration_minutes: duration,
        ...pageFields(availability),
      });
    } catch (err) {
      // Refused before any read, so it is the caller's error, not the
      // calendar's — and not a 404, which is reserved for "no such page".
      if (err instanceof PageOutOfRangeError) return json({ error: "page_out_of_range" }, 400);
      console.error("booking slots computation failed:", String(err));
      return json({ error: "calendar_unavailable" }, 502);
    }
  });

  app.post("/book/:slug", async (c) => {
    const page = await resolvePage(c, c.req.param("slug"));
    if (!page) return notFound();

    // Bound the body BEFORE reading it. `c.req.json()` buffers and parses the
    // whole request, so without this an unauthenticated caller could spend
    // hundreds of milliseconds of worker CPU on a multi-megabyte parse ahead of
    // every anti-abuse control below. Caveat: this reads the declared
    // content-length, so a chunked request that omits the header is not bounded
    // here — Cloudflare sets it for ordinary buffered bodies, which is what a
    // browser claim is.
    const declaredLength = Number(c.req.header("content-length"));
    if (declaredLength > MAX_CLAIM_BODY_BYTES) {
      return json({ error: "invalid_body" }, 400);
    }

    let body: ClaimBody;
    try {
      body = await c.req.json<ClaimBody>();
    } catch {
      return json({ error: "invalid_body" }, 400);
    }

    // Absent only when the request did not arrive through Cloudflare's edge
    // (`wrangler dev`, or any other fronting). Behind Cloudflare the edge sets
    // it and a client cannot forge it, which is what makes it a rate-limit key.
    const ip = c.req.header("cf-connecting-ip") ?? "";
    // Turnstile as early as the body allows: it is the gate protecting invites
    // sent from the owner's own account. Reading and parsing the (size-capped)
    // body is the only work that precedes it — no field validation, no counter
    // query, no calendar fetch and no row happen until it passes. The expected
    // hostname comes from this request's own URL: the widget is served from the
    // same origin, so a token reporting any other host was solved elsewhere.
    const token = typeof body.turnstile_token === "string" ? body.turnstile_token : "";
    if (!(await verifyTurnstile(c.env, token, ip, new URL(c.req.url).hostname))) {
      return json({ error: "challenge_failed" }, 403);
    }

    // Type first, then shape: `name`/`email`/`note` are as untrusted as `start`,
    // and a non-string reaching `.trim()` or D1's `.bind()` is a 500 with a
    // logged stack rather than the 400 the caller has coming.
    const note = body.note ?? null;
    const locationDetail = body.location_detail ?? null;
    if (
      typeof body.start !== "string" ||
      typeof body.name !== "string" ||
      typeof body.email !== "string" ||
      (note !== null && typeof note !== "string") ||
      typeof body.location_kind !== "string" ||
      (locationDetail !== null && typeof locationDetail !== "string")
    ) {
      return json({ error: "invalid_body" }, 400);
    }
    // The cast is a claim, not a check, so nothing may act on it until
    // ALL_KINDS has vouched for it. Hence the membership test stands alone
    // here rather than riding along in the condition below, where it would sit
    // one line after `needsBookerDetail` had already read the unvouched value.
    const locationKind = body.location_kind as LocationKind;
    if (!ALL_KINDS.includes(locationKind)) {
      return json({ error: "invalid_body" }, 400);
    }
    const wantsDetail = needsBookerDetail(locationKind);
    const detail = (locationDetail ?? "").trim();
    if (
      detail.length > MAX_LOCATION_LENGTH ||
      // A kind that collects nothing must carry nothing: rejecting rather than
      // ignoring keeps the stored row honest about what the booker was asked.
      (wantsDetail && detail.length === 0) ||
      (!wantsDetail && detail.length > 0)
    ) {
      return json({ error: "invalid_body" }, 400);
    }

    const start = body.start;
    const duration = Number(body.duration_minutes);
    const name = body.name.trim();
    const email = body.email.trim();
    if (
      !page.config.durations_minutes.includes(duration) ||
      name.length === 0 ||
      name.length > MAX_NAME_LENGTH ||
      email.length > MAX_EMAIL_LENGTH ||
      !EMAIL_RE.test(email) ||
      (note ?? "").length > MAX_NOTE_LENGTH
    ) {
      return json({ error: "invalid_body" }, 400);
    }

    // One sanitised copy, used both on the event and in the row, so the
    // invitation the booker receives and the record the owner reads cannot
    // disagree about the number or place they gave.
    const safeDetail = detail.length > 0 ? sanitiseForCalendar(detail) : null;
    // The checks above ran on the raw text; sanitising can empty it out (a
    // detail of only angle brackets survives the length check and comes back
    // ""). Re-check what will actually be stored, and call it what it is: the
    // kind is offered and the page is fine, so this is a bad body, not an
    // unavailable location.
    if (wantsDetail && (safeDetail ?? "").length === 0) {
      return json({ error: "invalid_body" }, 400);
    }
    // Resolved HERE, before the slot is reserved: a kind this page does not
    // offer must be refused without first taking a reservation that then has to
    // be released. The result is carried down to the event build below, so the
    // offered-set check and the mapping onto the event are one call against one
    // list and cannot disagree — a separate early check reading the RAW config
    // would diverge from what locationForEvent sees, which is the offerable
    // subset (a `custom` mode with an empty detail is in one and not the other).
    //
    // LocationError also covers "this kind requires a detail", but the
    // validation above has already refused that as invalid_body, so the branch
    // below is only ever reached by a kind outside the offered set. That has
    // two causes, not one: a hand-rolled POST naming a kind this page does not
    // offer, and — config-side — an owner whose `custom` entry has a blank
    // detail, which offerableModes drops as unusable. Both are honestly
    // location_unavailable from the booker's side.
    let placement: EventLocation;
    try {
      placement = locationForEvent(locationKind, safeDetail, page.config.location.modes);
    } catch (err) {
      if (err instanceof LocationError) return json({ error: "location_unavailable" }, 400);
      throw err;
    }

    // A claim with no client IP cannot be rate-limited, so it is refused rather
    // than counted. Hashing "" files every such caller under one constant
    // bucket, which turns MAX_CLAIMS_PER_IP_24H into a global cap of 5 shared
    // by unrelated bookers — five requests from anywhere would lock the page
    // for everyone else. Refusing keeps the per-IP limit meaning per-IP.
    //
    // Deliberately AFTER the challenge, so the "nothing happens until Turnstile
    // passes" ordering holds for this too; the only caller that can reach it is
    // a deployment not fronted by Cloudflare, where burning a token costs
    // nothing. 400 rather than 403/429: the challenge passed and no counter was
    // read, so neither of the anti-abuse codes would mean what it says.
    if (!ip) {
      console.error("booking claim rejected: no cf-connecting-ip on the request");
      return json({ error: "client_ip_required" }, 400);
    }

    const now = new Date();
    const ipHash = await hashToken(ip, hashingKey(c.env));
    if (
      (await countRecentByIp(c.env.DB, ipHash, now, 24)) >= MAX_CLAIMS_PER_IP_24H ||
      (await countTodayByOwner(c.env.DB, page.owner, now)) >= MAX_CLAIMS_PER_PAGE_24H
    ) {
      return json({ error: "rate_limited" }, 429);
    }

    // Never trust the client's slot list: the authoritative check is that the
    // requested start is in a freshly computed set — for the PAGE holding it,
    // which is one calendar read whatever the distance, rather than every
    // page from now to there. A start past the reach has no page: refused
    // here, before the calendar, with no courtesy list (there is no page to
    // list) — the client reads a missing list as "refetch".
    const startMs = Date.parse(start);
    const requested = Number.isNaN(startMs) ? null : new Date(startMs).toISOString();
    const claimPage = requested === null ? null : pageForStart(now.getTime(), startMs, page.config.horizon_days);
    if (
      requested === null ||
      claimPage === null ||
      pageWindow(now.getTime(), claimPage, page.config.horizon_days, page.config.max_horizon_days) === null
    ) {
      return json({ error: "slot_unavailable" }, 409);
    }

    const cal = c.get("calendarProvider") ?? await defaultCalendarProvider(c.env, page.owner);
    let availability: AvailabilityResult;
    try {
      availability = await computeAvailability(c.env.DB, c.env, page.owner, cal, duration, now, claimPage);
    } catch (err) {
      console.error("booking availability computation failed:", String(err));
      return json({ error: "calendar_unavailable" }, 502);
    }

    if (!availability.slots.includes(requested)) {
      return json({ error: "slot_unavailable", slots: availability.slots, ...pageFields(availability) }, 409);
    }

    const endIso = new Date(startMs + duration * 60_000).toISOString();
    // Guard bounds carry the page's buffers; claimSlot recovers the padding from
    // these deltas and re-applies it to the stored rows it probes against.
    const claim = await claimSlot(c.env.DB, {
      ownerSubject: page.owner,
      slug: page.slug,
      startUtc: requested,
      endUtc: endIso,
      durationMinutes: duration,
      bookerName: name,
      bookerEmail: email,
      bookerNote: note,
      locationKind,
      locationDetail: safeDetail,
      ipHash,
      guardStartUtc: new Date(startMs - page.config.buffer_minutes.before * 60_000).toISOString(),
      guardEndUtc: new Date(
        startMs + duration * 60_000 + page.config.buffer_minutes.after * 60_000,
      ).toISOString(),
      now,
    });
    if (!claim) {
      // The claim has already lost — the INSERT's guard is authoritative and
      // needs no calendar. The recompute is a courtesy, so that the client can
      // repaint with times that are still free; when the calendar cannot be
      // read the answer is STILL 409, just without a list. A 502 here would
      // tell the booker the calendar is down when what actually happened is
      // that their slot went, and would send the client down its generic
      // error path instead of the one that clears the selection and re-renders.
      const body: {
        error: string;
        slots?: string[];
        page?: number;
        has_more?: boolean;
        window?: { start: string; end: string };
      } = { error: "slot_unavailable" };
      try {
        const fresh = await computeAvailability(c.env.DB, c.env, page.owner, cal, duration, now, claimPage);
        Object.assign(body, { slots: fresh.slots, ...pageFields(fresh) });
      } catch (err) {
        // `slots` omitted rather than sent empty: the client reads a missing
        // list as "the cached one is now unknown, refetch", where [] would read
        // as "this page has nothing left on offer".
        console.error("booking post-claim slot refresh failed:", String(err));
      }
      return json(body, 409);
    }

    // From here on the booker's text is bound for the owner's calendar and for
    // an invitation email, so it travels sanitised. The name and note written
    // to the row above keep the raw submission, so the owner sees what was
    // really typed. The location detail is the exception: it is stored
    // sanitised, deliberately, so the invitation and the record cannot
    // disagree about the number or place the booker gave.
    const safeName = sanitiseForCalendar(name, true);
    const safeNote = note ? sanitiseForCalendar(note) : "";
    const noteLine = safeNote ? `\n\nNote from ${safeName}:\n${safeNote}` : "";
    const event: CalendarEvent = {
      id: "",
      // A global regex, not a string: a string first argument replaces only the
      // FIRST occurrence, so `"{booker_name} intro with {booker_name}"` left a
      // literal placeholder in the subject line of every invitation.
      //
      // And a replacer FUNCTION, not a replacement string: `$&`, "$`" and `$'`
      // in a replacement string are directives, and a booker could otherwise
      // use them to duplicate or displace the owner's own template text.
      summary: page.config.event_title.replace(/\{booker_name\}/g, () => safeName),
      description: `Booked via Optical by ${safeName} <${email}>.${noteLine}`,
      start: requested,
      end: endIso,
      attendees: [{ email }],
      extendedProperties: {},
    };
    // Never the owner's own contact details — see locationForEvent, which is
    // the only thing that decides what goes here. This event is created with
    // `notifyAttendees: true`, so anything on it is mailed to the booker.
    if (placement.location) event.location = placement.location;
    let eventId: string;
    try {
      ({ eventId } = await cal.createEvent(
        event,
        { optical_booking: claim.id },
        { notifyAttendees: true, addMeet: placement.addMeet, conferenceRequestId: claim.id },
      ));
    } catch (err) {
      // Nothing was written to the calendar, so release the reservation and let
      // the slot re-open rather than holding it with a row that never resolves.
      console.error("booking calendar write failed:", String(err));
      await failBooking(c.env.DB, claim.id, new Date());
      return json({ error: "calendar_write_failed" }, 502);
    }

    try {
      await confirmBooking(c.env.DB, claim.id, eventId, new Date());
    } catch (err) {
      // The event EXISTS and the booker has already been invited, so the
      // calendar is the truth here. Leaving the row 'reserving' keeps the slot
      // blocked to match it; failing it would re-offer time that is really
      // taken, which is strictly worse than one row needing a manual look.
      console.error(
        `booking confirm failed after calendar write (booking ${claim.id}, event ${eventId}):`,
        String(err),
      );
      return json({ error: "booking_unconfirmed" }, 502);
    }
    return json({ booking_id: claim.id, start: requested, end: endIso }, 201);
  });
}
