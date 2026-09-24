import { SCHEDULER_CHUNK_ID_KEY } from "../providers/types";
import type { CalendarEvent } from "../providers/types";
import type { LocalNaive } from "./solver-contract";
import { fromLocalNaive, floorToQuarter, ceilToQuarter } from "./datetime";

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

/** UTC instant of local midnight that STARTS the local day containing `iso`.
 *  Used to widen an all-day / out-of-office event's start to the local day's
 *  beginning (decision C). The event's local calendar date is taken in `tz`. */
function localDayStartUtc(iso: string, tz: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`invalid ISO datetime: ${iso}`);
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms)); // "YYYY-MM-DD"
  return fromLocalNaive(`${localDate}T00:00:00` as LocalNaive, tz);
}

/** UTC instant of local midnight that ENDS the local day containing `iso - 1ms`.
 *  Google's all-day end.date is exclusive (one-day event ends on D+1 00:00), so
 *  for an all-day event we want local-midnight of that exclusive end date — i.e.
 *  the local date of `iso` itself. We step back 1ms before taking the local date
 *  so that an end exactly on local midnight is attributed to the day it CLOSES,
 *  not the next one; then return the start of the following local day.
 *
 *  NOTE: this function is correct for timed OOO events whose `end` is a real UTC
 *  instant. It MUST NOT be called with all-day event ends — those UTC-midnight
 *  values are not local midnights in positive-UTC-offset zones, so the -1ms
 *  step-back lands on the previous UTC day but still the same local day, causing
 *  the result to advance one extra local day. Use localDayStartUtc(end, tz) for
 *  all-day event ends instead (see the endUtcRaw calculation below). */
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
  return fromLocalNaive(`${nextLocalDate}T00:00:00` as LocalNaive, tz);
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
 *       day(s); the UTC instants are re-derived from the event's local calendar
 *       dates so the block aligns to local midnight, not to the coerced UTC
 *       midnight (which is mid-morning in +10 zones).
 *
 *  All-day events: the provider coerced Google's exclusive end.date to a
 *  UTC-midnight instant (e.g. "2026-05-20T00:00:00Z" for a May-19 event). In a
 *  positive-UTC-offset timezone (+10) that UTC midnight is 10am local, so its
 *  LOCAL date is still May 20 — calling localDayEndUtc (which advances to the
 *  NEXT local day) would yield May 21, a two-day block. Instead we use
 *  localDayStartUtc(end): the UTC-midnight end's local date is the exclusive
 *  end date, and localDayStartUtc returns midnight of that date — the correct
 *  local-day boundary. Timed OOO events keep localDayEndUtc, whose advance is
 *  correct. Verified by build-problem.test.ts "expands an all-day busy event". */
export function deriveBusyBlocks(events: CalendarEvent[], opts: DeriveBusyOptions): BusyBlock[] {
  const { tz } = opts;
  const rounded = events
    .filter((e) => !e.extendedProperties?.private?.[SCHEDULER_CHUNK_ID_KEY])
    .filter((e) => !opts.excludeEventIds.has(e.id))
    .filter((e) => e.status !== "cancelled")
    .filter((e) => e.status !== "tentative" || opts.tentativeIsBusy === true)
    .map((e) => {
      const blocksWholeDay = e.isAllDay === true || e.eventType === "outOfOffice";
      const startUtcRaw = blocksWholeDay ? localDayStartUtc(e.start, tz) : e.start;
      const endUtcRaw = blocksWholeDay
        ? (e.isAllDay === true ? localDayStartUtc(e.end, tz) : localDayEndUtc(e.end, tz))
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
