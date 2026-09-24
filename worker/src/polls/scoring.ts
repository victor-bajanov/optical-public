// Pure meeting-poll scoring. No I/O, no Date.now, no env or db access —
// importable from both route handlers and the cron sweep with zero setup.
// Structural input types only (see FitCurve below); callers own the concrete
// shapes and adapt. CELL_MINUTES is imported from ./grid (itself pure
// interval math over booking/slots.ts) rather than duplicated as a literal.

import { CELL_MINUTES } from "./grid";

/** Structural mirror of worker/src/planning/solver-contract.ts's FitCurve —
 *  defined locally (not imported) to keep this module dependency-free. */
export interface FitCurve {
  peak_start: string; // "HH:MM"
  peak_end: string;
  falloff_end: string;
}

export type PaintState = "free" | "if_needed";
export type CoverageResult = "free" | "if_needed" | "none";

export interface InviteeResponse {
  inviteeId: string;
  cells: Map<string, PaintState>; // cellStartUtc (ISO) -> painted state
}

export interface WeightEntry {
  inviteeId: string;
  weight: number;
}

export interface SlotScore {
  score: number;
  organiserFit: number;
  weights: WeightEntry[];
}

export interface CandidateScore extends SlotScore {
  slotStartUtc: string;
}

const MAX_SCORE = 100;
// Matches solver/src/solver/slots.py SLOT_MINUTES — the fit curve's own
// granularity, independent of the poll grid's 30-min paint cells below.
const FIT_SLOT_MINUTES = 15;

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

const HH_MM = /^\d{2}:\d{2}$/;

/** Parses a `config_contexts.body` value (already `JSON.parse`d — pass
 *  `unknown` straight from a DB read) into a FitCurve, or null if it does
 *  not match the evaluator's single-window `{peak_start, peak_end,
 *  falloff_end}` shape.
 *
 *  NOTE ON GROUND TRUTH: worker/migrations/0002_seed_config.sql originally
 *  seeded the 'meeting' context with a DIFFERENT, richer shape
 *  (`{peak_windows: [...], allowed_start, allowed_end}`) that this function
 *  deliberately does NOT accept — multiple peak windows have no lossless
 *  single-window representation, and guessing one is a scoring-semantics
 *  decision this module does not make unilaterally. That shape is not
 *  reachable in practice, though: worker/migrations/0005_fix_config_contexts.sql
 *  immediately collapses every context (including 'meeting') to the plain
 *  triple via `INSERT ... ON CONFLICT DO UPDATE`, 0007_update_fit_curves.sql
 *  explicitly leaves 'meeting' as 0005 set it, and 0017_per_user_config.sql's
 *  owner_subject re-key carries the body over verbatim. Verified empirically
 *  against the full migration chain: the live ('__default__','meeting') row
 *  is `{"peak_start":"10:00","peak_end":"11:00","falloff_end":"17:00"}`. So
 *  in production this function's only real job is defensive validation, not
 *  translation — there is no runtime peak_windows-to-single-peak transform
 *  to reproduce because none exists; the data was fixed once, at rest. */
export function fitCurveFromContextConfig(raw: unknown): FitCurve | null {
  if (typeof raw !== "object" || raw === null) return null;
  const fitCurve = (raw as { fit_curve?: unknown }).fit_curve;
  if (typeof fitCurve !== "object" || fitCurve === null) return null;
  const { peak_start, peak_end, falloff_end } = fitCurve as Record<string, unknown>;
  if (
    typeof peak_start === "string" &&
    typeof peak_end === "string" &&
    typeof falloff_end === "string" &&
    HH_MM.test(peak_start) &&
    HH_MM.test(peak_end) &&
    HH_MM.test(falloff_end)
  ) {
    return { peak_start, peak_end, falloff_end };
  }
  return null;
}

/** Python's round() rounds half-to-even on the true binary value of its
 *  argument; JS's Math.round rounds half-away-from-zero. The fit curve's
 *  arithmetic reproduces the exact same IEEE-754 double as the Python
 *  evaluator (same operations, same order), so exact .5 ties do occur (e.g.
 *  25/200*100 == 12.5 precisely) and only this rounding rule reproduces
 *  Python's `int(round(ratio * MAX_SCORE))` byte-for-byte. Inputs here are
 *  always non-negative. */
function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Exact TS port of solver/src/solver/fit_curve.py's
 *  FitCurveEvaluator.score_at_minute_of_day. 0 = best (inside the peak
 *  window), 100 = worst (past falloff_end). Do not "improve" this formula —
 *  parity with the Python semantics is the acceptance bar. */
export function fitScoreAtMinute(curve: FitCurve, minuteOfDay: number): number {
  const peakStart = timeToMinutes(curve.peak_start);
  const peakEnd = timeToMinutes(curve.peak_end);
  const falloffEnd = timeToMinutes(curve.falloff_end);

  if (minuteOfDay >= peakStart && minuteOfDay <= peakEnd) return 0;

  if (minuteOfDay < peakStart) {
    if (peakStart === 0) return 0;
    const ratio = (peakStart - minuteOfDay) / peakStart;
    return pyRound(ratio * MAX_SCORE);
  }

  // minuteOfDay > peakEnd
  if (minuteOfDay >= falloffEnd) return MAX_SCORE;
  const span = falloffEnd - peakEnd;
  if (span <= 0) return MAX_SCORE;
  const ratio = (minuteOfDay - peakEnd) / span;
  return pyRound(ratio * MAX_SCORE);
}

/** Port of score_for_chunk: sums the per-15-min-slot scores across the
 *  chunk. Caller must ensure the chunk does not cross midnight (same
 *  obligation as the Python original). */
export function fitScoreForChunk(
  curve: FitCurve,
  startMinuteOfDay: number,
  durationMinutes: number,
): number {
  let total = 0;
  for (let offset = 0; offset < durationMinutes; offset += FIT_SLOT_MINUTES) {
    total += fitScoreAtMinute(curve, startMinuteOfDay + offset);
  }
  return total;
}

// Intl.DateTimeFormat construction is not free; cache by timezone the same
// way booking.client.js caches its formatters.
const minuteFormatters = new Map<string, Intl.DateTimeFormat>();

function minuteFormatter(timeZone: string): Intl.DateTimeFormat {
  const hit = minuteFormatters.get(timeZone);
  if (hit !== undefined) return hit;
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  minuteFormatters.set(timeZone, fmt);
  return fmt;
}

/** Minute-of-day for a UTC instant, read from Intl.DateTimeFormat parts in
 *  the given IANA zone — never manual offset arithmetic, so DST transitions
 *  (including skipped wall-clock hours) resolve correctly. */
function minuteOfDayInTz(utcMs: number, timeZone: string): number {
  const parts = minuteFormatter(timeZone).formatToParts(new Date(utcMs));
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === "hour") hour = Number(part.value);
    else if (part.type === "minute") minute = Number(part.value);
  }
  // Intl returns "24" for midnight with hour12:false in some locales; normalise.
  return (hour % 24) * 60 + minute;
}

/** organiser_fit(s) = (100*n - score_for_chunk(s, d)) / (100*n), normalised
 *  to [0,1] with higher meaning better (inverse of the raw Python score,
 *  which is 0-best/100-worst). Minute-of-day is computed in the organiser's
 *  own timezone, per `timeZone` — never the host TZ. */
export function organiserFit(
  curve: FitCurve,
  slotStartUtc: string,
  durationMin: number,
  timeZone: string,
): number {
  const minuteOfDay = minuteOfDayInTz(Date.parse(slotStartUtc), timeZone);
  const n = durationMin / FIT_SLOT_MINUTES;
  const chunkScore = fitScoreForChunk(curve, minuteOfDay, durationMin);
  return (MAX_SCORE * n - chunkScore) / (MAX_SCORE * n);
}

/** The 30-min cell starts that overlap [slotStartUtc, slotStartUtc+durationMin),
 *  including a partial overlap at the tail (e.g. a 45-min slot spans a third
 *  cell it only half-covers) — matches T4's paintable-cell tail rule. Cells
 *  are epoch-aligned (every UTC instant that is a multiple of CELL_MINUTES
 *  from 1970-01-01T00:00Z), so this is well-defined even for a slot start
 *  that isn't itself cell-aligned. */
function cellsOverlappingSlot(slotStartUtc: string, durationMin: number): string[] {
  const startMs = Date.parse(slotStartUtc);
  const endMs = startMs + durationMin * 60_000;
  const cellMs = CELL_MINUTES * 60_000;
  const firstCellStartMs = Math.floor(startMs / cellMs) * cellMs;
  const cells: string[] = [];
  for (let c = firstCellStartMs; c < endMs; c += cellMs) {
    cells.push(new Date(c).toISOString());
  }
  return cells;
}

/** An invitee covers a slot iff [s, s+d) is a subset of the union of their
 *  painted cells. Weight-relevant state is "if_needed" if any covering cell
 *  is if_needed, else "free"; "none" if any covering cell is unpainted. */
export function inviteeCoverage(
  cells: Map<string, PaintState>,
  slotStartUtc: string,
  durationMin: number,
): CoverageResult {
  let anyIfNeeded = false;
  for (const cellStart of cellsOverlappingSlot(slotStartUtc, durationMin)) {
    const state = cells.get(cellStart);
    if (state === undefined) return "none";
    if (state === "if_needed") anyIfNeeded = true;
  }
  return anyIfNeeded ? "if_needed" : "free";
}

/** score(s) = organiser_fit(s) x product of every required invitee's
 *  weight (1.0 free / 0.5 if_needed). Null when any required invitee's
 *  coverage is "none" — the slot does not qualify. */
export function scoreSlot(
  curve: FitCurve,
  slotStartUtc: string,
  durationMin: number,
  timeZone: string,
  responses: InviteeResponse[],
  requiredInviteeIds: string[],
): SlotScore | null {
  const cellsById = new Map(responses.map((r) => [r.inviteeId, r.cells]));
  const weights: WeightEntry[] = [];
  let weightProduct = 1;

  for (const inviteeId of requiredInviteeIds) {
    const cells = cellsById.get(inviteeId) ?? new Map<string, PaintState>();
    const coverage = inviteeCoverage(cells, slotStartUtc, durationMin);
    if (coverage === "none") return null;
    const weight = coverage === "free" ? 1.0 : 0.5;
    weights.push({ inviteeId, weight });
    weightProduct *= weight;
  }

  const fit = organiserFit(curve, slotStartUtc, durationMin, timeZone);
  return { score: fit * weightProduct, organiserFit: fit, weights };
}

/** Ranks every qualifying candidate best-first (highest score), ties broken
 *  by earliest start. Non-qualifying candidates (scoreSlot -> null) are
 *  dropped. Feeds getMeetingPoll's per-slot score breakdown. */
export function rankCandidates(
  candidates: string[],
  responses: InviteeResponse[],
  requiredInviteeIds: string[],
  curve: FitCurve,
  durationMin: number,
  timeZone: string,
): CandidateScore[] {
  const scored: CandidateScore[] = [];
  for (const slotStartUtc of candidates) {
    const result = scoreSlot(curve, slotStartUtc, durationMin, timeZone, responses, requiredInviteeIds);
    if (result !== null) scored.push({ ...result, slotStartUtc });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.slotStartUtc < b.slotStartUtc ? -1 : a.slotStartUtc > b.slotStartUtc ? 1 : 0;
  });
  return scored;
}
