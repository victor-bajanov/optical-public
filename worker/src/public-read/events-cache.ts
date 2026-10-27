import type { Env } from "../env";
import type { CalendarProvider } from "../providers/calendar-provider";
import type { CalendarEvent } from "../providers/types";
import { OPTICAL_POLL_ID_KEY, SCHEDULER_CHUNK_ID_KEY } from "../providers/types";
import { deploymentIdFromEnv } from "../providers/deployment-scope";
import { parseEnvNumberWithFloor } from "../util/env-parse";
import { debugLog } from "../log";
import { publicReadTargetAllowed, PublicReadRateLimitedError } from "./rate-limit";

/** The one provider method the public availability paths use. */
export type EventsReader = Pick<CalendarProvider, "fetchEventsInWindow">;

/** How long a public page may reuse an owner's calendar read.
 *
 *  60 s, because staleness here is bounded and harmless in one direction
 *  only: the booking claim and the poll booking engine re-read the calendar
 *  live, so a stale entry can never double-book — at worst a slot freed on the
 *  calendar shows up to a minute late, or a slot taken on the calendar (not
 *  through Optical: D1 bookings are always read fresh) stays on offer until
 *  the claim's live re-check refuses it with a 409 and a fresh list. A minute
 *  covers a booker's whole session (load, switch durations, page forward) with
 *  one read, and matches the rate limiter's 60 s period. */
export const DEFAULT_PUBLIC_READ_CACHE_TTL_SECONDS = 60;
/** Ceiling on the var: a mistyped "3600" must not freeze a page for an hour. */
export const MAX_PUBLIC_READ_CACHE_TTL_SECONDS = 300;
/** Windows are widened to whole hours before keying. A page's window starts at
 *  the server's `now`, so an exact-window key would be new on every request;
 *  the widened read is a superset, which can only add busy time near the
 *  edges (fewer slots, never more). */
const WINDOW_QUANTUM_MS = 60 * 60_000;
/** Bump when the stored shape or the projection changes, so a deploy never
 *  reads an entry an older build wrote. */
const ENTRY_VERSION = 1;

/** `PUBLIC_READ_CACHE_TTL_SECONDS`: unset, empty, unparseable or negative →
 *  the 60 s default; "0" turns the cache off; anything above 300 is capped. */
export function publicReadCacheTtlSeconds(env: Pick<Env, "PUBLIC_READ_CACHE_TTL_SECONDS">): number {
  const raw = env.PUBLIC_READ_CACHE_TTL_SECONDS;
  if (raw !== undefined && Number(raw) < 0) return DEFAULT_PUBLIC_READ_CACHE_TTL_SECONDS;
  const ttl = parseEnvNumberWithFloor(raw, DEFAULT_PUBLIC_READ_CACHE_TTL_SECONDS, 0, true);
  return Math.min(ttl, MAX_PUBLIC_READ_CACHE_TTL_SECONDS);
}

/** The event as the public availability paths need it, and nothing more.
 *
 *  Kept: id (bookable-over and booking ids match on it), start/end, status
 *  (cancelled/tentative), isAllDay and eventType (whole-day blocks), the
 *  scheduler chunk id (pinned chunks, and chunks never block on their own),
 *  the poll id (a poll's booked meeting is never bookable-over), and the
 *  organiser/attendee `self`/`resource` flags isOwnedMovableMeeting reads.
 *  Dropped: the title, every address, response statuses and every other
 *  extended property, so an edge cache entry holds times and opaque ids only.
 *  A cache miss returns this projection too, so a hit and a miss can never
 *  compute different slots. test/public-read/events-cache.test.ts pins that
 *  every busy, pinned and bookable-over decision survives it. */
export function projectForAvailability(e: CalendarEvent): CalendarEvent {
  const priv: Record<string, string> = {};
  const chunkId = e.extendedProperties?.private?.[SCHEDULER_CHUNK_ID_KEY];
  if (chunkId !== undefined) priv[SCHEDULER_CHUNK_ID_KEY] = chunkId;
  const pollId = e.extendedProperties?.private?.[OPTICAL_POLL_ID_KEY];
  if (pollId !== undefined) priv[OPTICAL_POLL_ID_KEY] = pollId;
  const out: CalendarEvent = {
    id: e.id,
    summary: "",
    start: e.start,
    end: e.end,
    extendedProperties: Object.keys(priv).length > 0 ? { private: priv } : {},
  };
  if (e.status !== undefined) out.status = e.status;
  if (e.eventType !== undefined) out.eventType = e.eventType;
  if (e.isAllDay !== undefined) out.isAllDay = e.isAllDay;
  if (e.organizer?.self !== undefined) out.organizer = { self: e.organizer.self };
  if (e.attendees !== undefined) {
    out.attendees = e.attendees.map((a) => {
      const kept: NonNullable<CalendarEvent["attendees"]>[number] = { email: "" };
      if (a.self !== undefined) kept.self = a.self;
      if (a.resource !== undefined) kept.resource = a.resource;
      return kept;
    });
  }
  return out;
}

function quantise(startIso: string, endIso: string): { start: string; end: string } {
  const s = Math.floor(Date.parse(startIso) / WINDOW_QUANTUM_MS) * WINDOW_QUANTUM_MS;
  const e = Math.ceil(Date.parse(endIso) / WINDOW_QUANTUM_MS) * WINDOW_QUANTUM_MS;
  return { start: new Date(s).toISOString(), end: new Date(e).toISOString() };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The owner's own-write generation: how many task rows they have and the
 *  newest `updated_at`. Part of the cache key, so this deployment's own
 *  calendar writes show on the public pages at once instead of after the TTL.
 *
 *  Of the calendar writes this deployment makes for an owner, booking-page
 *  claims and poll bookings need nothing here: each leaves a `bookings` row,
 *  which availability reads fresh from D1 and which blocks the same time as
 *  the event. What the bookings rows don't cover is commit — a pinned task's
 *  chunk, or an owned meeting moved to a new time. Commit writes the calendar
 *  first and then stamps every task in the plan (`status`, `scheduled_for`,
 *  `updated_at`), so the generation moves only once the calendar holds the
 *  new times; a read that lands in between is cached under the old
 *  generation and replaced on the next request. Deleting a task changes the
 *  count. Writes that only FREE time (a deleted chunk, a cancelled booking's
 *  event) can still show busy for up to the TTL, which never over-offers. */
export async function ownerWriteGeneration(db: D1Database, owner: string): Promise<string> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n, MAX(updated_at) AS latest FROM tasks WHERE owner_subject = ?")
    .bind(owner)
    .first<{ n: number; latest: string | null }>();
  return `${row?.n ?? 0}:${row?.latest ?? ""}`;
}

/** The Cache API key for one owner's quantised window. On the request's own
 *  origin (the cache is per zone, and a path nothing routes to), with the
 *  owner, window, provider, deployment and own-write generation hashed into
 *  the path: the URL never carries a subject, and dev and prod — two hosts in
 *  one zone — can never share an entry even if a path collided. */
export async function publicReadCacheKey(
  env: Pick<Env, "OAUTH_ISSUER">,
  origin: string,
  provider: string,
  owner: string,
  generation: string,
  startIso: string,
  endIso: string,
): Promise<string> {
  const w = quantise(startIso, endIso);
  const id = await sha256Hex(
    JSON.stringify([ENTRY_VERSION, deploymentIdFromEnv(env) ?? "", provider, owner, generation, w.start, w.end]),
  );
  return `${origin}/__optical/public-read-cache/v${ENTRY_VERSION}/${id}`;
}

interface Entry {
  fetchedAtMs: number;
  events: CalendarEvent[];
}

export interface CachedReaderOptions {
  env: Env;
  owner: string;
  /** The owner's provider name ("google" / "microsoft"). Part of the key, so
   *  a provider switch never serves the old provider's calendar. */
  provider: string;
  /** The request's origin, which the cache key lives under. */
  origin: string;
  now: Date;
  /** The page's per-target limiter key (`book:<slug>` / `poll:<id>`). Spent
   *  on every provider read this reader makes — a miss, a cache failure, or
   *  every read with the cache off — and never on a hit. */
  limitTarget: string;
}

/** Wraps a live reader for the PUBLIC availability paths only
 *  (`GET /book/{slug}/slots`, `GET /poll/{id}/grid`, `PUT /poll/{id}/response`).
 *
 *  Within the TTL, one owner's quantised window costs one provider read per
 *  colo (the Cache API is per data centre). Each provider read first spends
 *  one unit of the page's per-target budget (`limitTarget`) and throws
 *  `PublicReadRateLimitedError` when it is gone; a hit spends nothing.
 *  Requests that miss together are
 *  not collapsed: the Cache API doesn't, and sharing one in-flight promise
 *  across requests is unsafe in Workers (a promise is bound to the request
 *  that created it). The rate limiters bound that burst instead. Every read
 *  returns `projectForAvailability` events, hit or miss. Never use it for the
 *  booking claim's re-verification, the poll booking engine, resolve, commit
 *  or anything authenticated: those must read live, and
 *  test/public-read/wiring.test.ts pins the call sites.
 *
 *  Only the calendar read is cached. Callers still read D1 (bookings, pins,
 *  verdicts, hours, config, tz) on every request, so a just-made booking
 *  blocks its slot at once, and the key carries the owner's own-write
 *  generation, so a commit's calendar writes show at once too. A cache failure degrades to the live read; a live
 *  read failure propagates and is never cached. */
export function cachedEventsReader(live: EventsReader, opts: CachedReaderOptions): EventsReader {
  return {
    async fetchEventsInWindow(start: string, end: string) {
      const ttlMs = publicReadCacheTtlSeconds(opts.env) * 1000;
      const w = quantise(start, end);
      const readLive = async (): Promise<Entry> => {
        if (!(await publicReadTargetAllowed(opts.env, opts.limitTarget))) {
          throw new PublicReadRateLimitedError(opts.limitTarget);
        }
        const { events } = await live.fetchEventsInWindow(w.start, w.end, { syncToken: false });
        return { fetchedAtMs: opts.now.getTime(), events: events.map(projectForAvailability) };
      };
      if (ttlMs === 0) return { events: (await readLive()).events, nextSyncToken: "" };

      const generation = await ownerWriteGeneration(opts.env.DB, opts.owner);
      const key = await publicReadCacheKey(
        opts.env, opts.origin, opts.provider, opts.owner, generation, start, end,
      );
      const nowMs = opts.now.getTime();
      const fresh = (e: Entry | null): e is Entry =>
        e !== null && e.fetchedAtMs <= nowMs && nowMs - e.fetchedAtMs < ttlMs;

      const cached = await readEntry(key);
      if (fresh(cached)) {
        debugLog(opts.env, "dbg_public_read_cache", { hit: true });
        return { events: cached.events, nextSyncToken: "" };
      }
      debugLog(opts.env, "dbg_public_read_cache", { hit: false });

      const entry = await readLive();
      await writeEntry(key, entry, Math.ceil(ttlMs / 1000));
      return { events: entry.events, nextSyncToken: "" };
    },
  };
}

async function readEntry(key: string): Promise<Entry | null> {
  try {
    const hit = await caches.default.match(key);
    if (!hit) return null;
    const body = (await hit.json()) as Partial<Entry>;
    if (typeof body.fetchedAtMs !== "number" || !Array.isArray(body.events)) return null;
    return { fetchedAtMs: body.fetchedAtMs, events: body.events };
  } catch (err) {
    console.warn("public_read_cache_error", { op: "match", error: String(err) });
    return null;
  }
}

async function writeEntry(key: string, entry: Entry, ttlSeconds: number): Promise<void> {
  try {
    await caches.default.put(
      key,
      new Response(JSON.stringify(entry), {
        headers: { "content-type": "application/json", "cache-control": `max-age=${ttlSeconds}` },
      }),
    );
  } catch (err) {
    console.warn("public_read_cache_error", { op: "put", error: String(err) });
  }
}
