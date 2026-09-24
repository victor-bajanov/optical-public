import type { BusyInterval } from "../providers/calendar-provider";
import type { BusinessHours } from "../planning/solver-contract";
import { mergeIntervals, subtract, intersect, type Interval } from "../planning/intervals";
import { businessHoursIntervals } from "../planning/business-hours-intervals";

export interface AvailabilityWindowISO {
  start: string; // ISO-Z
  end: string; // ISO-Z
}

export interface ComputeAvailabilityParams {
  tz: string;
  businessHours: BusinessHours | null | undefined;
  windowStartMs: number; // resolve window (placement floor already applied upstream is fine too)
  windowEndMs: number;
  nowMs: number;
  minNoticeMs: number;
  currentStartMs: number; // the meeting's live calendar start
  currentEndMs: number;
  durationMinutes: number;
  acceptedBusy: BusyInterval[]; // union of accepted attendees' busy intervals
  /** True when one or more accepted attendees' free/busy was unreadable; the
   *  caller passes this through so the warning is surfaced in the diff. */
  hasUnknownAttendees?: boolean;
}

export interface ComputeAvailabilityResult {
  windows: AvailabilityWindowISO[];
  warnings: string[];
}

const Q = 15 * 60_000;
const ceilQ = (ms: number) => Math.ceil(ms / Q) * Q;
const floorQ = (ms: number) => Math.floor(ms / Q) * Q;

export function computeAvailabilityWindows(
  p: ComputeAvailabilityParams,
): ComputeAvailabilityResult {
  const warnings: string[] = [];
  if (p.hasUnknownAttendees) {
    warnings.push("attendee_availability_unknown");
  }

  const placeFloor = Math.max(p.windowStartMs, p.nowMs + p.minNoticeMs);
  const movableBase: Interval[] = placeFloor < p.windowEndMs ? [{ s: placeFloor, e: p.windowEndMs }] : [];

  // free = placement window − busy, ∩ business hours
  const free = subtract(movableBase, p.acceptedBusy.map((b) => ({ s: Date.parse(b.start), e: Date.parse(b.end) })));
  const bh = businessHoursIntervals(placeFloor, p.windowEndMs, p.businessHours, p.tz);
  const movable = intersect(free, bh);

  // Round each genuinely-free window so the chunk fits: start up, end down; drop
  // any too short to hold the reserved (quarter-rounded) chunk. The solver
  // reserves a chunk's length rounded UP to a quarter, so a window must clear
  // `reservedMs`, not the raw duration, to be a real placement option.
  const durMs = p.durationMinutes * 60_000;
  const reservedMs = ceilQ(durMs);
  const ivs: Interval[] = [];
  for (const iv of movable) {
    const s = ceilQ(iv.s);
    const e = floorQ(iv.e);
    if (e - s >= reservedMs) ivs.push({ s, e });
  }

  // ∪ current slot — the C1 always-feasible fallback. The meeting may ALWAYS
  // stay where it is, even if an attendee is "busy" then (that busy block IS this
  // meeting), even outside BH, even inside the min-notice horizon. The solver
  // places on a quarter grid and reserves the chunk rounded UP to a quarter, so
  // the stay-put window must be quarter-aligned and at least `reservedMs` long:
  // floor the start and add the reserved length — i.e. expand OUTWARD. Rounding
  // the raw slot INWARD (as the free windows above) collapses an off-grid or
  // non-15-multiple "speedy" (25/50-min) meeting below its duration and drops it,
  // leaving the mask EMPTY — which the solver reads as UNCONSTRAINED, freely
  // relocating the meeting onto attendee-busy time (bug 2026-06-27). The mask
  // must never be empty for a meeting; this guarantees it.
  const cs = floorQ(p.currentStartMs);
  const merged = mergeIntervals([...ivs, { s: cs, e: cs + reservedMs }]);

  const windows: AvailabilityWindowISO[] = merged.map((iv) => ({
    start: new Date(iv.s).toISOString().replace(".000Z", "Z"),
    end: new Date(iv.e).toISOString().replace(".000Z", "Z"),
  }));
  return { windows, warnings };
}
