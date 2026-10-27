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
 * Expand an RFC 5545 RRULE into the set of calendar dates (YYYY-MM-DD) on which
 * occurrences fall, restricted to [fromDate, toDate). dtstart is the
 * template's `active_from` (a YYYY-MM-DD string).
 *
 * Everything here is a floating calendar date: no zone, no instant. The caller
 * turns its window into the user's LOCAL dates first (materialise.ts
 * localDateRange). Expanding against the window's instants instead read a
 * west-of-UTC local week (Mon 00:00 local = Mon 07:00Z in Los Angeles) as
 * Tue..next Mon, dropping this week's Monday and creating next Monday a week
 * early.
 *
 * Supported subset: FREQ in {DAILY, WEEKLY}, BYDAY, COUNT, UNTIL, INTERVAL, WKST.
 * Anything else throws UnsupportedRRuleError.
 */
export function expandRRule(
  rruleStr: string,
  dtstart: string,
  fromDate: string,
  toDate: string,
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

  // rrule's floating mode works on Date objects; each calendar date is carried
  // as its UTC midnight, so UTC date arithmetic is plain calendar arithmetic.
  const dt = floatingDate(dtstart);
  const start = floatingDate(fromDate);
  const end = floatingDate(toDate);

  const rule = new RRule({
    freq: freq === "DAILY" ? Frequency.DAILY : Frequency.WEEKLY,
    dtstart: dt,
    interval: map.has("INTERVAL") ? parseInt(map.get("INTERVAL")!, 10) : 1,
    count: map.has("COUNT") ? parseInt(map.get("COUNT")!, 10) : undefined,
    until: map.has("UNTIL") ? parseRfc5545Until(map.get("UNTIL")!) : undefined,
    byweekday: map.has("BYDAY") ? parseByDay(map.get("BYDAY")!) : undefined,
    tzid: null, // floating
  });

  // rrule's `between(after, before, inc=true)` includes both endpoints. We want
  // [start, end): inclusive of start, exclusive of end. Filter accordingly.
  const occurrences = rule.between(start, end, true).filter((d) => d.getTime() < end.getTime());
  return occurrences.map(toIsoDate);
}

function floatingDate(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`expected YYYY-MM-DD, got "${date}"`);
  return new Date(`${date}T00:00:00Z`);
}

function toIsoDate(d: Date): string {
  // d is a floating date carried as UTC midnight; take the date portion.
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
