// Card E of internal design notes: a task's preferred window may carry
// its own `tz` (stamped when the user's tz changes, or set via the API). The
// solver and the in-process engine read every window as wall-clock time in the
// PROBLEM tz, so a window in another zone is re-expressed here before it goes
// on the wire. The wire itself stays tz-free.
//
// Windows with no tz, or with the problem tz, pass through untouched (the
// no-tz case returns the very same array, so existing data is byte-identical).
//
// A stored "24:00" reads as end of day. A foreign window with any other
// unparseable time passes through unprojected (tz stripped, one warning per
// build), so it can never fail a resolve.
//
// A foreign-tz window is expanded into concrete intervals: every date in its
// own zone that can overlap the horizon, [start, end) converted to instants
// (a nonexistent local time moves forward to the transition; an ambiguous one
// takes the earlier instant, as fromLocalNaive does), then to problem-local
// naive wall-clock (the solver's slot model is naive local time).
//
// - SOFT windows become per-shape {days, start, end} windows, split at
//   problem-local midnight (a piece ending at midnight ends "23:59": the
//   solver's `time` type has no 24:00, and its soft cost floors the 1-minute
//   overhang to zero, so this is exact for zero-cost placement).
// - HARD windows must stay exact. The solver INTERSECTS a task's hard windows
//   (each is its own constraint), so a split cannot be expressed as several
//   hard windows. A hard window that maps to one problem-local shape with no
//   midnight contact becomes one hard window; otherwise its intervals become an
//   `availability_windows` mask (union semantics, concrete naive datetimes),
//   intersected across such windows. A mask with no room left is emitted as a
//   single out-of-horizon quarter, so the chunk can only drop (as a hard
//   window with no slot in the horizon does today).
import type { AvailabilityWindow, LocalNaive, PreferredWindow } from "./solver-contract";
import { fromLocalNaive, localNaiveMs } from "./datetime";

type Weekday = PreferredWindow["days"][number];

export interface StoredPreferredWindow {
  days: Weekday[];
  start: string;
  end: string;
  hard: boolean;
  tz?: string;
}

export interface ProjectedWindows {
  preferred_windows: PreferredWindow[];
  /** Naive problem-local hard mask from foreign-tz hard windows that don't
   *  reduce to one problem-tz window; null when there are none. */
  availability_windows: AvailabilityWindow[] | null;
}

const MIN = 60_000;
const DAY = 86_400_000;
const QUARTER = 15 * MIN;
// Date.getUTCDay() order.
const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEK_ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

interface Iv {
  s: number;
  e: number;
}

function canonicalZone(tz: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function naiveString(naiveMs: number): LocalNaive {
  return new Date(naiveMs).toISOString().slice(0, 19) as LocalNaive;
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Minutes of day for "HH:MM" (00:00–23:59), with "24:00" read as end of day
 *  (TimeOfDay and the engine accept it). null for anything else. */
function parseHHMM(t: string): number | null {
  if (t === "24:00") return 1440;
  const m = HHMM.exec(t);
  return m ? parseInt(m[1]!, 10) * 60 + parseInt(m[2]!, 10) : null;
}

/** Instant (ms) of naive local `naiveMs` in `tz`. A nonexistent local time
 *  (DST gap) resolves to the first existing quarter hour after it, i.e. the
 *  transition instant; an ambiguous one to the earlier instant. */
function instantOf(naiveMs: number, tz: string): number {
  try {
    return Date.parse(fromLocalNaive(naiveString(naiveMs), tz));
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("DST gap")) throw err;
  }
  const first = Math.ceil(naiveMs / QUARTER) * QUARTER;
  for (let t = first === naiveMs ? first + QUARTER : first; t <= naiveMs + 4 * 60 * MIN; t += QUARTER) {
    try {
      return Date.parse(fromLocalNaive(naiveString(t), tz));
    } catch {
      // still inside the gap
    }
  }
  throw new Error(`no existing local time after ${naiveString(naiveMs)} in ${tz}`);
}

/** Problem-local naive intervals of a foreign window over the source dates that
 *  can touch [h0, h1) (instants), unclipped. */
function naiveIntervals(
  w: StoredPreferredWindow,
  startMin: number,
  endMin: number,
  srcTz: string,
  problemTz: string,
  h0: number,
  h1: number,
): Iv[] {
  const days = new Set<string>(w.days);
  // Source-local dates spanning the horizon with a 2-day margin either side
  // (UTC offsets differ by at most 26 h), stepped as pure calendar days.
  const firstDay = Math.floor(localNaiveMs(h0, srcTz) / DAY) * DAY - 2 * DAY;
  const lastDay = Math.floor(localNaiveMs(h1, srcTz) / DAY) * DAY + 2 * DAY;
  const out: Iv[] = [];
  for (let d = firstDay; d <= lastDay; d += DAY) {
    if (!days.has(WEEKDAYS[new Date(d).getUTCDay()]!)) continue;
    const s = instantOf(d + startMin * MIN, srcTz);
    const e = instantOf(d + endMin * MIN, srcTz);
    if (e <= s || e <= h0 || s >= h1) continue;
    const ns = localNaiveMs(s, problemTz);
    let ne = localNaiveMs(e, problemTz);
    // Inside a fall-back overlap naive time can run backwards: keep the real length.
    if (ne <= ns) ne = ns + (e - s);
    out.push({ s: ns, e: ne });
  }
  return out;
}

interface Piece {
  day: number; // naive midnight ms
  s: number; // minutes of day
  e: number; // minutes of day, ≤ 1440
}

function splitAtMidnight(iv: Iv): Piece[] {
  const out: Piece[] = [];
  let cur = iv.s;
  while (cur < iv.e) {
    const day = Math.floor(cur / DAY) * DAY;
    const end = Math.min(iv.e, day + DAY);
    out.push({ day, s: (cur - day) / MIN, e: (end - day) / MIN });
    cur = end;
  }
  return out;
}

function clip(ivs: Iv[], h: Iv): Iv[] {
  return ivs
    .map((iv) => ({ s: Math.max(iv.s, h.s), e: Math.min(iv.e, h.e) }))
    .filter((iv) => iv.e > iv.s)
    .sort((a, b) => a.s - b.s);
}

function orderDays(days: Set<Weekday>): Weekday[] {
  return WEEK_ORDER.filter((d) => days.has(d));
}

/** Group pieces into {days, start, end} windows by shape, in first-seen order.
 *  A midnight end is written "23:59"; a piece that collapses is dropped. */
function groupPieces(pieces: Piece[], hard: boolean): PreferredWindow[] {
  const byShape = new Map<string, { days: Set<Weekday>; start: string; end: string }>();
  for (const p of pieces) {
    const start = hhmm(p.s);
    const end = p.e >= 1440 ? "23:59" : hhmm(p.e);
    if (end <= start) continue;
    const key = `${start}-${end}`;
    const g = byShape.get(key) ?? { days: new Set<Weekday>(), start, end };
    g.days.add(WEEKDAYS[new Date(p.day).getUTCDay()]!);
    byShape.set(key, g);
  }
  return [...byShape.values()].map((g) => ({ days: orderDays(g.days), start: g.start, end: g.end, hard }));
}

/** The one hard window exactly equivalent to `ivs` within the horizon, or null. */
function asSingleHardWindow(ivs: Iv[], horizon: Iv): PreferredWindow | null {
  const clipped = clip(ivs, horizon);
  if (clipped.length === 0) return null;
  const pieces = ivs.flatMap(splitAtMidnight).filter((p) => p.day + p.e * MIN > horizon.s && p.day + p.s * MIN < horizon.e);
  const first = pieces[0];
  if (!first || first.e >= 1440 || pieces.some((p) => p.s !== first.s || p.e !== first.e)) return null;
  const days = new Set(pieces.map((p) => WEEKDAYS[new Date(p.day).getUTCDay()]!));
  // What the solver would allow for {days, start, end} over the horizon.
  const implied: Iv[] = [];
  for (let d = Math.floor(horizon.s / DAY) * DAY; d < horizon.e; d += DAY) {
    if (days.has(WEEKDAYS[new Date(d).getUTCDay()]!)) implied.push({ s: d + first.s * MIN, e: d + first.e * MIN });
  }
  const b = clip(implied, horizon);
  const same = b.length === clipped.length && b.every((iv, i) => iv.s === clipped[i]!.s && iv.e === clipped[i]!.e);
  return same ? { days: orderDays(days), start: hhmm(first.s), end: hhmm(first.e), hard: true } : null;
}

/** Quarter-rounded inward (a chunk starts and ends on quarter hours), with
 *  anything too short for one quarter dropped. */
function toMask(ivs: Iv[]): Iv[] {
  return ivs
    .map((iv) => ({ s: Math.ceil(iv.s / QUARTER) * QUARTER, e: Math.floor(iv.e / QUARTER) * QUARTER }))
    .filter((iv) => iv.e > iv.s);
}

export function intersectMasks(a: Iv[], b: Iv[]): Iv[] {
  const out: Iv[] = [];
  for (const x of a) {
    for (const y of b) {
      const s = Math.max(x.s, y.s);
      const e = Math.min(x.e, y.e);
      if (e > s) out.push({ s, e });
    }
  }
  return out.sort((p, q) => p.s - q.s);
}

/** Naive-ms interval list ↔ wire AvailabilityWindow list. */
export function maskFromWire(ws: AvailabilityWindow[]): Iv[] {
  return ws.map((w) => ({ s: Date.parse(w.start + "Z"), e: Date.parse(w.end + "Z") }));
}
export function maskToWire(ivs: Iv[], horizonEndNaive: number): AvailabilityWindow[] {
  // An empty mask would read as "unconstrained": emit one quarter past the
  // horizon instead, which no chunk can fit inside.
  const list = ivs.length > 0 ? ivs : [{ s: horizonEndNaive, e: horizonEndNaive + QUARTER }];
  return list.map((iv) => ({ start: naiveString(iv.s), end: naiveString(iv.e) }));
}

export function projectPreferredWindows(
  windows: StoredPreferredWindow[] | undefined,
  problemTz: string,
  horizonStartISO: string,
  horizonEndISO: string,
): ProjectedWindows {
  const ws = windows ?? [];
  if (!ws.some((w) => w.tz !== undefined)) return { preferred_windows: ws as PreferredWindow[], availability_windows: null };

  const problemCanon = canonicalZone(problemTz);
  const h0 = Date.parse(horizonStartISO);
  const h1 = Date.parse(horizonEndISO);
  const horizon: Iv = { s: localNaiveMs(h0, problemTz), e: localNaiveMs(h1, problemTz) };

  const out: PreferredWindow[] = [];
  let mask: Iv[] | null = null;
  let foreign = false;
  const unparseable: string[] = [];
  for (const w of ws) {
    const { tz, ...rest } = w;
    if (tz === undefined || canonicalZone(tz) === problemCanon) {
      out.push(rest);
      continue;
    }
    const startMin = parseHHMM(w.start);
    const endMin = parseHHMM(w.end);
    if (startMin === null || endMin === null) {
      // Can't be converted: pass it through as stored (minus tz) rather than
      // fail every resolve for this user; the solver judges it as it always has.
      unparseable.push(`${w.start}-${w.end}`);
      out.push(rest);
      continue;
    }
    foreign = true;
    const ivs = naiveIntervals(w, startMin, endMin, tz, problemTz, h0, h1);
    if (!w.hard) {
      out.push(...groupPieces(ivs.flatMap(splitAtMidnight).filter((p) => p.day + p.e * MIN > horizon.s && p.day + p.s * MIN < horizon.e), false));
      continue;
    }
    const single = asSingleHardWindow(ivs, horizon);
    if (single) {
      out.push(single);
      continue;
    }
    const m = toMask(clip(ivs, horizon));
    mask = mask === null ? m : intersectMasks(mask, m);
  }

  if (unparseable.length > 0) {
    console.warn(JSON.stringify({ msg: "preferred_window_unprojectable", tz: problemTz, windows: unparseable }));
  }
  let preferred = out;
  if (foreign) {
    const seen = new Set<string>();
    preferred = out.filter((w) => {
      const k = JSON.stringify(w);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return {
    preferred_windows: preferred,
    availability_windows: mask === null ? null : maskToWire(mask, horizon.e),
  };
}
