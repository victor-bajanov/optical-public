import type { BusinessHours, LocalNaive } from "../planning/solver-contract";
import { computeBookableSlots, slotStepForDurations } from "../booking/slots";
import { fromLocalNaive } from "../planning/datetime";

/** Width of one paintable grid cell, in minutes. Single source of truth —
 *  the invitee client mirrors this value from the grid endpoint's bootstrap
 *  payload rather than hard-coding it independently. */
export const CELL_MINUTES = 30;

/** The poll fields `candidateStarts` reads. Structural — callers pass a full
 *  `polls` row (worker/src/db/polls.ts); only these fields matter here. */
export interface PollRangeInput {
  duration_min: number;
  /** Inclusive local calendar date "YYYY-MM-DD", in `availability.tz`. */
  range_start: string;
  /** Inclusive local calendar date "YYYY-MM-DD", in `availability.tz`. */
  range_end: string;
}

/** The organiser's live availability picture, already assembled by the
 *  caller. grid.ts does no I/O — it never fetches calendar or D1 data
 *  itself, only walks what it's handed. */
export interface CandidateAvailabilityInput {
  tz: string;
  hours: BusinessHours | null;
  /** Busy blocks AND live bookings, UTC ISO 8601 — same shape `computeBookableSlots` takes. */
  busy: Array<{ startUtc: string; endUtc: string }>;
}

/** Structural subset of `BookingPageConfig` (worker/src/db/booking-page.ts)
 *  — a caller can pass the loaded config object directly. Polls reuse the
 *  booking page's min-notice, never `MEETING_MIN_NOTICE_MINUTES`. */
export interface CandidateBookingConfig {
  min_notice_minutes: number;
  buffer_minutes: { before: number; after: number };
}

/** Probe order for the first local time that exists on a calendar date. Real
 *  spring-forward gaps are 30 or 60 minutes and start at or after midnight;
 *  probing out to 03:00 covers every zone in the tz database with margin. */
const DAY_START_PROBES = [
  "00:00:00", "00:15:00", "00:30:00", "00:45:00",
  "01:00:00", "01:30:00", "02:00:00", "02:30:00", "03:00:00",
];

/** The UTC instant at which local calendar day `date` begins in `tz`, tolerant
 *  of a DST gap at midnight. `fromLocalNaive` THROWS for a local time that does
 *  not exist, and several zones (America/Santiago, America/Havana, Africa/Cairo,
 *  Asia/Beirut, …) start DST at exactly 00:00 — so on those nights a bare
 *  "T00:00:00" conversion takes down every caller of candidateStarts, silently
 *  in the booking and sweep paths. Stepping forward to the first instant that
 *  does exist is what "the day starts here" means on such a night. */
function localDayStartUtc(date: string, tz: string): string {
  for (const probe of DAY_START_PROBES) {
    try {
      return fromLocalNaive(`${date}T${probe}` as LocalNaive, tz);
    } catch {
      // Inside the gap — try the next candidate. Any other failure mode
      // (malformed date) will fail identically on every probe and fall through
      // to the last-resort conversion below.
    }
  }
  // Last resort: local noon always exists in every zone; subtracting 12 hours
  // lands at or just before the true day start, which for an inclusive lower
  // bound and an exclusive upper bound is the safe direction (never clips a
  // legitimate candidate).
  return new Date(Date.parse(fromLocalNaive(`${date}T12:00:00` as LocalNaive, tz)) - 12 * 3_600_000).toISOString();
}

/** Add `n` calendar days to a "YYYY-MM-DD" date string. Pure calendar
 *  arithmetic on bare Y/M/D (never zoned) — mirrors the date-stepping idiom
 *  in `planning/business-hours-intervals.ts`, since range_start/range_end
 *  are local dates, not instants. */
function addCalendarDays(date: string, n: number): string {
  const y = parseInt(date.slice(0, 4), 10);
  const m = parseInt(date.slice(5, 7), 10);
  const d = parseInt(date.slice(8, 10), 10);
  const t = Date.UTC(y, m - 1, d) + n * 86_400_000;
  const dt = new Date(t);
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

/** The organiser's bookable start times for `poll.duration_min`, within
 *  `[range_start, range_end]` (inclusive local dates), respecting the
 *  booking page's min-notice/buffers. Wraps `computeBookableSlots` — the
 *  poll range and the booking horizon are independent clips (the horizon is
 *  sized to reach `range_end`, then results are filtered to the range),
 *  so a candidate must satisfy both. */
export function candidateStarts(
  poll: PollRangeInput,
  availability: CandidateAvailabilityInput,
  bookingCfg: CandidateBookingConfig,
  now: Date,
): string[] {
  const rangeStartMs = Date.parse(localDayStartUtc(poll.range_start, availability.tz));
  const rangeEndExclusiveMs = Date.parse(
    localDayStartUtc(addCalendarDays(poll.range_end, 1), availability.tz),
  );

  // The window only needs to reach range_end; a poll range that has already
  // fully elapsed puts the end at or before `now`, which computeBookableSlots
  // reads as an empty window (ceiling <= floor) — no separate "range in the
  // past" branch needed.
  const slots = computeBookableSlots({
    tz: availability.tz,
    hours: availability.hours,
    nowMs: now.getTime(),
    minNoticeMinutes: bookingCfg.min_notice_minutes,
    windowStartMs: now.getTime(),
    windowEndMs: rangeEndExclusiveMs,
    durationMinutes: poll.duration_min,
    slotStepMinutes: slotStepForDurations([poll.duration_min]),
    bufferBeforeMinutes: bookingCfg.buffer_minutes.before,
    bufferAfterMinutes: bookingCfg.buffer_minutes.after,
    busy: availability.busy,
  });

  // The window floors at `now` (min-notice is measured from it), not at
  // `range_start`, so it can offer starts before the poll range begins. Clip
  // to the range; the end clip is a no-op now the window ends exactly there,
  // kept so this filter states the whole contract on its own.
  return slots.filter((s) => {
    const t = Date.parse(s);
    return t >= rangeStartMs && t < rangeEndExclusiveMs;
  });
}

/** The 30-min cell starts touched by any candidate's span, including a
 *  partial tail (e.g. a 45-min candidate touches two 30-min cells, the
 *  second only half-covered). Invitees paint cells; candidates are what
 *  actually get booked — a cell is offered for painting whenever it could
 *  matter to at least one bookable start. */
export function paintableCells(candidates: string[], durationMin: number): string[] {
  const cellMs = CELL_MINUTES * 60_000;
  const durMs = durationMin * 60_000;
  const cells = new Set<number>();
  for (const c of candidates) {
    const start = Date.parse(c);
    const end = start + durMs;
    let cellStart = Math.floor(start / cellMs) * cellMs;
    while (cellStart < end) {
      cells.add(cellStart);
      cellStart += cellMs;
    }
  }
  return Array.from(cells)
    .sort((a, b) => a - b)
    .map((t) => new Date(t).toISOString());
}
