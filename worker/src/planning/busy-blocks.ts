import { SCHEDULER_CHUNK_ID_KEY } from "../providers/types";
import type { CalendarEvent } from "../providers/types";
import type { LocalNaive } from "./solver-contract";
import { fromLocalNaiveCompatible, floorToQuarter, ceilToQuarter } from "./datetime";

export interface BusyBlock {
  id: string;
  title: string;
  startUtc: string;
  endUtc: string;
}

export interface DeriveBusyOptions {
  tz: string;
  /** Decision D: when false, status "tentative" does not block. */
  tentativeIsBusy?: boolean;
  /** Event ids that must NOT contribute busy time (movable meetings for the
   *  planner; additionally bookable-over meetings for the booking page). */
  excludeEventIds: Set<string>;
}

const FLOATING_ALL_DAY = /^(\d{4}-\d{2}-\d{2})T00:00:00(\.000)?Z$/;

/** The floating calendar date an all-day event's start/end string carries, or
 *  null. Both providers hand an all-day date over as UTC midnight of that date
 *  (Google `${date}T00:00:00Z`; Graph's floating midnight read under
 *  outlook.timezone="UTC"). That instant is NOT the user's local midnight: the
 *  date is the meaning, so it is read back off the string. Anything else (a
 *  provider that sent a converted instant) is not a floating date. */
export function allDayFloatingDate(iso: string): string | null {
  return FLOATING_ALL_DAY.exec(iso)?.[1] ?? null;
}

/** First instant of local calendar date `date` (YYYY-MM-DD) in `tz`. A local
 *  midnight inside a DST gap (Santiago, Beirut, Cairo) moves forward to the
 *  day's first real instant. */
function localDateStartUtc(date: string, tz: string): string {
  return fromLocalNaiveCompatible(`${date}T00:00:00` as LocalNaive, tz);
}

/** The instant whose local week an event belongs to, for week bucketing. A
 *  floating all-day event belongs to the week of its DATE, so it buckets at
 *  local noon of that date (noon always exists, so no DST dependency); any
 *  other event at its start. */
export function eventBucketInstant(e: CalendarEvent, tz: string): string {
  const date = e.isAllDay === true ? allDayFloatingDate(e.start) : null;
  return date === null ? e.start : fromLocalNaiveCompatible(`${date}T12:00:00` as LocalNaive, tz);
}

/** UTC instant of local midnight that STARTS the local day containing `iso`.
 *  Used to widen an out-of-office event's start (and a converted, non-floating
 *  all-day instant) to the local day's beginning (decision C). The event's
 *  local calendar date is taken in `tz`. */
function localDayStartUtc(iso: string, tz: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`invalid ISO datetime: ${iso}`);
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms)); // "YYYY-MM-DD"
  return localDateStartUtc(localDate, tz);
}

/** UTC instant of local midnight that ENDS the local day containing `iso - 1ms`.
 *  We step back 1ms before taking the local date so that an end exactly on
 *  local midnight is attributed to the day it CLOSES, not the next one; then
 *  return the start of the following local day. Used for timed OOO events,
 *  whose `end` is a real UTC instant. All-day ends are exclusive dates and go
 *  through localDateStartUtc instead. */
function localDayEndUtc(iso: string, tz: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`invalid ISO datetime: ${iso}`);
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms - 1)); // local date of the last covered instant
  // Local midnight that STARTS the day after `localDate` = the block's end.
  const [y, mo, d] = localDate.split("-").map((x) => parseInt(x, 10));
  const nextDayMs = Date.UTC(y!, mo! - 1, d!) + 86_400_000;
  const nd = new Date(nextDayMs);
  const nextLocalDate = `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, "0")}-${String(nd.getUTCDate()).padStart(2, "0")}`;
  return localDateStartUtc(nextLocalDate, tz);
}

/** The authoritative busy derivation, shared by the planner and the booking
 *  page so the two can never disagree about blocked time.
 *
 *  The user owns overlaps in their own calendar (tentative invites, lunch over
 *  a meeting, a parallel "focus block" + meeting); callers can only move task
 *  chunks, not the calendar, so overlapping events are collapsed here into the
 *  union of busy intervals before anything downstream sees them — this is why
 *  the merge loop below exists, not a micro-optimisation.
 *
 *  Free/busy rules applied here (transparency — decision A — is already handled
 *  upstream by the Google provider, which drops transparent events so they
 *  never reach this function):
 *    B. status "cancelled" never blocks (defensive; the full fetch already
 *       omits cancelled events).
 *    D. status "tentative" blocks only when tentativeIsBusy is true.
 *    C. an all-day BUSY event, or any outOfOffice event, blocks its WHOLE local
 *       day(s), from the first instant of the first local day to the first
 *       instant of the day after the last.
 *
 *  All-day events are floating dates (allDayFloatingDate): the provider string
 *  "2026-05-19T00:00:00Z" means local May 19 wherever the user is, so the
 *  block runs from local midnight of the start date to local midnight of the
 *  exclusive end date, both built from the date strings in `tz`. Taking the
 *  UTC-midnight instant's local date instead would block May 18 everywhere
 *  west of UTC. An all-day event whose start/end is NOT UTC midnight (a
 *  converted instant) falls back to the local day containing that instant.
 *  Timed OOO events widen to the local days their instants touch
 *  (localDayStartUtc / localDayEndUtc). A local midnight inside a DST gap is
 *  the day's first real instant. */
export function deriveBusyBlocks(events: CalendarEvent[], opts: DeriveBusyOptions): BusyBlock[] {
  const { tz } = opts;
  const rounded = events
    .filter((e) => !e.extendedProperties?.private?.[SCHEDULER_CHUNK_ID_KEY])
    .filter((e) => !opts.excludeEventIds.has(e.id))
    .filter((e) => e.status !== "cancelled")
    .filter((e) => e.status !== "tentative" || opts.tentativeIsBusy === true)
    .map((e) => {
      const blocksWholeDay = e.isAllDay === true || e.eventType === "outOfOffice";
      const startUtcRaw = blocksWholeDay ? allDayBound(e, "start", tz) ?? localDayStartUtc(e.start, tz) : e.start;
      const endUtcRaw = blocksWholeDay
        ? (e.isAllDay === true ? allDayBound(e, "end", tz) ?? localDayStartUtc(e.end, tz) : localDayEndUtc(e.end, tz))
        : e.end;
      return {
        id: e.id,
        title: e.summary,
        startUtc: floorToQuarter(startUtcRaw),
        endUtc: ceilToQuarter(endUtcRaw),
      };
    })
    .sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));

  const merged: BusyBlock[] = [];
  for (const ev of rounded) {
    const last = merged[merged.length - 1];
    if (last && Date.parse(ev.startUtc) < Date.parse(last.endUtc)) {
      if (Date.parse(ev.endUtc) > Date.parse(last.endUtc)) last.endUtc = ev.endUtc;
    } else {
      merged.push({ ...ev });
    }
  }
  return merged;
}

/** Local midnight of an all-day event's floating start or (exclusive) end
 *  date, or null when the event is not all-day or the bound is not a floating
 *  date. */
function allDayBound(e: CalendarEvent, which: "start" | "end", tz: string): string | null {
  if (e.isAllDay !== true) return null;
  const date = allDayFloatingDate(e[which]);
  return date === null ? null : localDateStartUtc(date, tz);
}
