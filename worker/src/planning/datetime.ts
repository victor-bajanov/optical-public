import type { LocalNaive } from "./solver-contract";

function formatInZone(utcMillis: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(new Date(utcMillis));
  const get = (t: string) => {
    const p = parts.find((p) => p.type === t);
    if (!p) throw new Error(`missing part ${t}`);
    return p.value;
  };
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

function getOffsetMinutes(utcMillis: number, tz: string): number {
  const localStr = formatInZone(utcMillis, tz);
  const localUtcMillis = Date.parse(localStr + "Z");
  return Math.round((localUtcMillis - utcMillis) / 60_000);
}

export function toLocalNaive(iso: string, tz: string): LocalNaive {
  const instant = Date.parse(iso);
  if (Number.isNaN(instant)) {
    throw new Error(`invalid ISO datetime: ${iso}`);
  }
  const local = formatInZone(instant, tz);
  const [, , mm, ss] = local.match(/T(\d\d):(\d\d):(\d\d)$/) ?? [];
  if (mm === undefined || ss === undefined) {
    throw new Error(`unparseable local datetime: ${local}`);
  }
  if (parseInt(mm) % 15 !== 0 || parseInt(ss) !== 0) {
    throw new Error(
      `datetime ${iso} (${local} in ${tz}) is not aligned to a 15-minute boundary`,
    );
  }
  return local as LocalNaive;
}

/**
 * The [Monday 00:00, next Monday 00:00) window, expressed in `tz`, that
 * CONTAINS `iso`. "This Monday" semantics: a mid-week instant maps back to the
 * Monday on or before it — NOT the next Monday. Both boundaries are real instants
 * anchored to local midnight (Mon 00:00 in `tz`), so the window aligns with how
 * weeks are committed and stays correct across DST. Used to re-resolve the
 * calendar week an edited event falls in, and by the Monday cron to pick the
 * week it fires in. Anchoring locally matters: a 09:00 Monday-AEST chunk is
 * 23:00Z the prior Sunday, so a UTC-Monday window would wrongly exclude it.
 */
export function localWeekWindow(iso: string, tz: string): { start: string; end: string } {
  const instant = Date.parse(iso);
  if (Number.isNaN(instant)) {
    throw new Error(`invalid ISO datetime: ${iso}`);
  }
  // Local calendar date (YYYY-MM-DD) of the instant in `tz`.
  const localDate = formatInZone(instant, tz).slice(0, 10);
  const y = parseInt(localDate.slice(0, 4), 10);
  const m = parseInt(localDate.slice(5, 7), 10);
  const d = parseInt(localDate.slice(8, 10), 10);
  // Weekday of that bare calendar date. Date.UTC on Y-M-D is a pure calendar
  // computation (no zone involved), so getUTCDay gives the correct weekday.
  const dayMs = Date.UTC(y, m - 1, d);
  const daysSinceMonday = (new Date(dayMs).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const mondayMs = dayMs - daysSinceMonday * 86_400_000;
  const naiveMidnight = (ms: number): LocalNaive => {
    const dt = new Date(ms);
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    return `${dt.getUTCFullYear()}-${mm}-${dd}T00:00:00` as LocalNaive;
  };
  return {
    start: fromLocalNaive(naiveMidnight(mondayMs), tz),
    end: fromLocalNaive(naiveMidnight(mondayMs + 7 * 86_400_000), tz),
  };
}

const QUARTER_MS = 15 * 60_000;

/** Round an ISO-Z instant UP to the next 15-minute boundary, returned as ISO-Z.
 *  This is the instant-domain quarter rounding the placement floor needs: the
 *  current moment is snapped FORWARD to the next slot the solver can place into
 *  (an already-aligned instant is left unchanged). Also used for window.end and
 *  external-event end so the solver's cutoff/event-block fully covers the real
 *  range (no truncation). */
export function ceilToQuarter(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`invalid ISO datetime: ${iso}`);
  const rounded = Math.ceil(ms / QUARTER_MS) * QUARTER_MS;
  return new Date(rounded).toISOString();
}

/** Round an ISO-Z instant DOWN to the nearest 15-minute boundary, returned as
 *  ISO-Z. The floor twin of {@link ceilToQuarter}: used for window.start and
 *  external-event start so the solver sees a slot that fully CONTAINS the real
 *  start. */
export function floorToQuarter(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`invalid ISO datetime: ${iso}`);
  const rounded = Math.floor(ms / QUARTER_MS) * QUARTER_MS;
  return new Date(rounded).toISOString();
}

/** The placement floor for a resolve: the earliest instant the solver may place
 *  a chunk into. It is `max(weekStart, ceilToQuarter(now))` — i.e. the start of
 *  the week's window, but never earlier than the next quarter-hour slot from now.
 *
 *  SELECTION/FETCH stay week-wide; only PLACEMENT is floored. This keeps an
 *  undone Monday task selected on Wednesday while preventing it (or anything
 *  else) from being scheduled onto an already-elapsed day or slot.
 *
 *  - mid-week:      now > weekStart → floor = ceilToQuarter(now).
 *  - start-of-week: now <= weekStart → floor = weekStart (no narrowing).
 *  - future week:   now < weekStart → floor = weekStart (no behavior change).
 *
 *  Returned as ISO-Z. `windowStartISO` is assumed already quarter-aligned (it is
 *  a local-Monday-midnight boundary); we compare instants, so the larger wins. */
export function computePlacementFloor(windowStartISO: string, nowISO: string): string {
  const weekStartMs = Date.parse(windowStartISO);
  if (Number.isNaN(weekStartMs)) throw new Error(`invalid ISO datetime: ${windowStartISO}`);
  const ceilNow = ceilToQuarter(nowISO);
  const ceilNowMs = Date.parse(ceilNow);
  return ceilNowMs > weekStartMs ? ceilNow : new Date(weekStartMs).toISOString();
}

/** A week whose window has fully elapsed: `windowEnd <= now`. Resolving such a
 *  week is pointless and harmful — placementFloor would exceed windowEnd and the
 *  solver would mass-drop every task. The week-iterating callers (webhook replan,
 *  Monday cron) skip these weeks. Current/future weeks return false. */
export function isWeekFullyPast(windowEndISO: string, nowISO: string): boolean {
  const endMs = Date.parse(windowEndISO);
  const nowMs = Date.parse(nowISO);
  if (Number.isNaN(endMs)) throw new Error(`invalid ISO datetime: ${windowEndISO}`);
  if (Number.isNaN(nowMs)) throw new Error(`invalid ISO datetime: ${nowISO}`);
  return endMs <= nowMs;
}

export function fromLocalNaive(local: LocalNaive, tz: string): string {
  // Strategy: treat local as if it were UTC to get a starting instant,
  // then use the zone's offset at that instant to find the UTC candidate.
  // Verify each candidate by re-formatting in the zone.
  //
  // DST edge cases:
  //   - Spring-forward gap: the local time doesn't exist; no candidate verifies.
  //   - Fall-back overlap: the local time exists at two offsets; pick earlier UTC.
  const pretendUtcMillis = Date.parse(local + "Z");
  if (Number.isNaN(pretendUtcMillis)) {
    throw new Error(`invalid local datetime: ${local}`);
  }

  // Build a set of candidate UTC instants to try by probing both sides of any
  // DST transition.  We try the offset at pretendUtcMillis and also at
  // pretendUtcMillis ± the DST step (typically 60 min).
  const offset1 = getOffsetMinutes(pretendUtcMillis, tz);
  const candidate1 = pretendUtcMillis - offset1 * 60_000;
  const verify1 = formatInZone(candidate1, tz);

  // Probe additional offsets by sampling around candidate1 (±DST step = 60 min).
  // This handles:
  //   - Spring-forward gap: candidate1 lands post-gap; candidate from probing
  //     the pre-gap region also won't verify → neither valid → DST gap error.
  //   - Fall-back overlap: candidate1 lands post-transition; probing 60 min
  //     earlier finds the pre-transition candidate → both valid → pick earlier.
  const DST_STEP_MS = 60 * 60_000;
  const probeMillis = candidate1 - DST_STEP_MS;
  const offset2 = getOffsetMinutes(probeMillis, tz);
  const candidate2 = pretendUtcMillis - offset2 * 60_000;
  const verify2 = formatInZone(candidate2, tz);

  const valid: number[] = [];
  if (verify1 === local) valid.push(candidate1);
  if (verify2 === local && candidate2 !== candidate1) valid.push(candidate2);

  if (valid.length === 0) {
    // Neither offset produced the requested local time → DST gap.
    throw new Error(
      `local time ${local} does not exist in ${tz} (DST gap)`,
    );
  }

  // If two valid candidates, prefer the earlier UTC instant (pre-transition).
  const earlier = valid.reduce((a, b) => (a < b ? a : b));
  return new Date(earlier).toISOString();
}
