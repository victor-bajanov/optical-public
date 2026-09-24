import type { BusinessHours } from "../planning/solver-contract";
import { subtract, intersect, mergeIntervals, type Interval } from "../planning/intervals";
import { businessHoursIntervals } from "../planning/business-hours-intervals";

export class DurationError extends Error {}
export class HoursError extends Error {}
export class HorizonError extends Error {}

const DAY_MS = 86_400_000;

/** Reject a reach shorter than one page.
 *
 *  `horizon_days` is the size of one page (and all a booker sees at first);
 *  `max_horizon_days` is how far they may page. The schema bounds each on its
 *  own; this is the cross-field rule it cannot express. A max below the page
 *  size would silently clamp page 0 to less than the owner set — null means
 *  "no further than one page", which is the pre-paging behaviour. */
export function validateHorizons(horizonDays: number, maxHorizonDays: number | null): void {
  if (maxHorizonDays !== null && maxHorizonDays < horizonDays) {
    throw new HorizonError(
      `max_horizon_days ${maxHorizonDays} must be at least horizon_days ${horizonDays}`,
    );
  }
}

export interface PageWindow {
  startMs: number;
  endMs: number;
  /** Whether a page after this one exists. */
  hasMore: boolean;
}

/** The window page `page` covers, or null when no such page exists.
 *
 *  Pages are contiguous, half-open, millisecond-exact spans off `now`:
 *  page k = [now + k·H, now + (k+1)·H) days, the last one clamped to the reach.
 *  Off `now` rather than local midnight so that page 0 is byte-for-byte the
 *  single window the page served before paging existed. A local day that
 *  straddles a boundary is therefore split across two pages — never
 *  duplicated, never dropped — and the client re-buckets the union.
 *
 *  A null `maxHorizonDays` is one page: the reach equals the page size. */
export function pageWindow(
  nowMs: number,
  page: number,
  horizonDays: number,
  maxHorizonDays: number | null,
): PageWindow | null {
  if (!Number.isInteger(page) || page < 0) return null;
  const reachDays = maxHorizonDays ?? horizonDays;
  const fromDays = page * horizonDays;
  if (fromDays >= reachDays) return null;
  const toDays = Math.min(fromDays + horizonDays, reachDays);
  return {
    startMs: nowMs + fromDays * DAY_MS,
    endMs: nowMs + toDays * DAY_MS,
    hasMore: toDays < reachDays,
  };
}

/** The page whose window holds `startMs`. A start in the past floors to 0 —
 *  the availability computed for that page then refuses it like any other
 *  stale start, so no separate "in the past" branch is needed. */
export function pageForStart(nowMs: number, startMs: number, horizonDays: number): number {
  return Math.max(0, Math.floor((startMs - nowMs) / (horizonDays * DAY_MS)));
}

/** Reject booking hours that can never yield a slot.
 *
 *  The schema bounds each field on its own; this is the cross-field rule it
 *  cannot express. `businessHoursIntervals` builds one interval per allowed day
 *  and drops any whose end is not after its start, so `start >= end` is
 *  silently an empty window: the PUT 200s and the page then offers nothing,
 *  with nothing anywhere pointing back at the config that caused it.
 *
 *  Both values are `HH:MM` by the time they arrive (the schema's pattern), so a
 *  lexicographic comparison is a chronological one. */
export function validateHours(hours: { start: string; end: string }): void {
  if (hours.start >= hours.end) {
    throw new HoursError(`hours start ${hours.start} must be before end ${hours.end}`);
  }
}

/** Optical places on a 15-minute grid, so a booking duration finer than that
 *  cannot be represented in the planner at all. */
export function validateDurations(durations: number[]): void {
  if (durations.length === 0) throw new DurationError("at least one duration is required");
  for (const d of durations) {
    if (!Number.isInteger(d) || d < 15 || d % 15 !== 0) {
      throw new DurationError(`duration ${d} must be a multiple of 15 minutes, minimum 15`);
    }
  }
}

/** Offered slot starts land on a 15-minute grid only when a 15-minute meeting is
 *  on offer; otherwise a half-hour grid keeps the list short. */
export function slotStepForDurations(durations: number[]): number {
  return durations.includes(15) ? 15 : 30;
}

export interface BookableSlotParams {
  tz: string;
  hours: BusinessHours | null;
  /** The instant the min-notice floor is measured from. */
  nowMs: number;
  minNoticeMinutes: number;
  /** The half-open span to offer starts in — one page (`pageWindow`), or
   *  whatever span the caller wants. Independent of `nowMs`: a later page
   *  starts well after now. */
  windowStartMs: number;
  windowEndMs: number;
  durationMinutes: number;
  slotStepMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  /** Busy blocks AND live bookings, both already in UTC ISO 8601. */
  busy: Array<{ startUtc: string; endUtc: string }>;
}

/** Bookable slot starts as UTC ISO strings.
 *
 *  free = (booking hours ∩ [floor, ceiling)) − buffer-expanded busy
 *  where floor = max(windowStart, now + notice) and ceiling = windowEnd.
 *  A start is offered when [start, start + duration) fits inside one free
 *  interval — so the whole meeting is free, not merely its first minute. */
export function computeBookableSlots(p: BookableSlotParams): string[] {
  const floor = Math.max(p.windowStartMs, p.nowMs, p.nowMs + p.minNoticeMinutes * 60_000);
  const ceiling = p.windowEndMs;
  if (ceiling <= floor) return [];

  const window: Interval[] = [{ s: floor, e: ceiling }];
  const domain = intersect(window, businessHoursIntervals(floor, ceiling, p.hours, p.tz));

  // W1 (round 2 — the round-1 fix below was refuted by adversarial review
  // against real D1 and is wrong; kept here as a record of what NOT to do):
  //
  //   (a) Against RAW busy (calendar events, pinned chunks — never claimed,
  //       never re-padded), the minimal correct expansion is asymmetric but
  //       SWAPPED from the original code: [s-after, e+before]. A candidate
  //       immediately before a busy block only needs ITS OWN `after`
  //       clearance past its own end; a candidate immediately after only
  //       needs ITS OWN `before` clearance before its own start. The
  //       original code applied `before` to the busy block's leading edge
  //       and `after` to its trailing edge — exactly backwards — which is
  //       the original defect.
  //   (b) Against a BOOKINGS row, claimSlot (worker/src/db/bookings.ts)
  //       computes its own guardStart/guardEnd from the candidate's
  //       before/after, then re-pads THAT by before/after again
  //       (probeEnd = guardEnd+before, probeStart = guardStart-after) —
  //       verified against real D1: {before:15,after:10}, an existing row
  //       01:45-02:15Z, candidate 01:00Z (15-min gap to the row, matching
  //       max(before,after)) is offered by (a)/max() but claimSlot still
  //       returns null. The two paddings COMPOSE, so the real required gap
  //       on EITHER side of a bookings row is before+after, not max(before,
  //       after) (max() < sum whenever both are >0 — round 1's max() fix
  //       still under-expanded and still offered claim-infeasible starts)
  //       and not just `before` or `after` alone. before+after is exactly
  //       tight: claimSlot's guard uses strict </> in SQL, so exact
  //       adjacency at the before+after boundary is accepted, no ±1ms hazard.
  //   (c) `busy` here mixes both raw busy AND bookings rows (see
  //       availability.ts / polls/grid.ts) with no way to tell them apart by
  //       the time this function sees them, so we apply the single
  //       before+after sum to ALL of them. That's sound for (b) (grid-
  //       offered is always claim-feasible) and over-suppresses (a) by
  //       min(before, after) per edge — a deliberate simplicity trade-off,
  //       zero under the shipped default {before:0, after:10}.
  //
  // Live evidence, 2026-08-17: HIDDEN poll p_930ec249 (before:0, after:10)
  // had two candidates — 23:00Z and 2026-08-18T01:30Z — each offered by the
  // (buggy) grid because they ended exactly `after` minutes short of an
  // adjacent same-owner booking row, then silently `slot_taken` at claim,
  // exhausting the walk into a spurious needs_attention escalation.
  const gapMs = (p.bufferBeforeMinutes + p.bufferAfterMinutes) * 60_000;
  const holes = mergeIntervals(
    p.busy.map((b) => ({
      s: Date.parse(b.startUtc) - gapMs,
      e: Date.parse(b.endUtc) + gapMs,
    })),
  );
  const free = subtract(domain, holes);

  const stepMs = p.slotStepMinutes * 60_000;
  const durMs = p.durationMinutes * 60_000;
  const out: string[] = [];
  for (const iv of free) {
    // First grid point at or after the interval start.
    let t = Math.ceil(iv.s / stepMs) * stepMs;
    while (t + durMs <= iv.e) {
      out.push(new Date(t).toISOString());
      t += stepMs;
    }
  }
  return out;
}
