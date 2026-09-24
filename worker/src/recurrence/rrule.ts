import { RRule, Frequency } from "rrule";

export class UnsupportedRRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedRRuleError";
  }
}

const ALLOWED_PARTS = new Set(["FREQ", "BYDAY", "COUNT", "UNTIL", "INTERVAL", "WKST"]);
const ALLOWED_FREQ = new Set(["DAILY", "WEEKLY"]);

/**
 * Expand an RFC 5545 RRULE into the set of UTC date-strings (YYYY-MM-DD) on which
 * occurrences fall, restricted to [windowStart, windowEnd). dtstart is the
 * template's `active_from` (a YYYY-MM-DD string).
 *
 * Supported subset: FREQ in {DAILY, WEEKLY}, BYDAY, COUNT, UNTIL, INTERVAL, WKST.
 * Anything else throws UnsupportedRRuleError.
 */
export function expandRRule(
  rruleStr: string,
  dtstart: string,
  windowStart: string,
  windowEnd: string,
): string[] {
  const parts = rruleStr.split(";").map((p) => p.trim()).filter(Boolean);
  const map = new Map<string, string>();
  for (const p of parts) {
    const [k, v] = p.split("=");
    if (!k || v === undefined) throw new UnsupportedRRuleError(`malformed part "${p}"`);
    if (!ALLOWED_PARTS.has(k)) throw new UnsupportedRRuleError(`unsupported part "${k}"`);
    map.set(k, v);
  }
  const freq = map.get("FREQ");
  if (!freq || !ALLOWED_FREQ.has(freq)) {
    throw new UnsupportedRRuleError(`FREQ must be DAILY or WEEKLY, got "${freq}"`);
  }

  // dtstart is "YYYY-MM-DD" UTC midnight.
  const dt = new Date(`${dtstart}T00:00:00Z`);
  const start = new Date(windowStart);
  const end = new Date(windowEnd);

  const rule = new RRule({
    freq: freq === "DAILY" ? Frequency.DAILY : Frequency.WEEKLY,
    dtstart: dt,
    interval: map.has("INTERVAL") ? parseInt(map.get("INTERVAL")!, 10) : 1,
    count: map.has("COUNT") ? parseInt(map.get("COUNT")!, 10) : undefined,
    until: map.has("UNTIL") ? parseRfc5545Until(map.get("UNTIL")!) : undefined,
    byweekday: map.has("BYDAY") ? parseByDay(map.get("BYDAY")!) : undefined,
    tzid: null, // floating; we treat dtstart as UTC midnight
  });

  // rrule's `between(after, before, inc=true)` includes both endpoints. We want
  // [start, end): inclusive of start, exclusive of end. Filter accordingly.
  const occurrences = rule.between(start, end, true).filter((d) => d.getTime() < end.getTime());
  return occurrences.map(toIsoDate);
}

function toIsoDate(d: Date): string {
  // d is UTC; take the date portion.
  return d.toISOString().slice(0, 10);
}

function parseRfc5545Until(s: string): Date {
  // Accepts "20260523T000000Z" and "2026-05-23T00:00:00Z".
  if (/^\d{8}T\d{6}Z$/.test(s)) {
    const y = s.slice(0, 4);
    const mo = s.slice(4, 6);
    const d = s.slice(6, 8);
    const h = s.slice(9, 11);
    const mi = s.slice(11, 13);
    const se = s.slice(13, 15);
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}Z`);
  }
  return new Date(s);
}

const BYDAY_MAP: Record<string, number> = {
  MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6,
};

function parseByDay(s: string): number[] {
  return s.split(",").map((t) => {
    const code = t.trim().toUpperCase();
    const n = BYDAY_MAP[code];
    if (n === undefined) throw new UnsupportedRRuleError(`unknown BYDAY token "${code}"`);
    return n;
  });
}
