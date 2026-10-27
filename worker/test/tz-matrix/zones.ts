// Timezone matrix for the permanent tz-parametrised suite (CLAUDE.md
// "Timezones": a new tz behaviour adds its case here). One representative IANA zone per whole-hour UTC offset -11..+12, the
// off-grid offsets, and the zones whose DST transition happens AT local
// midnight (so local 00:00 does not exist on the spring-forward date).
//
// The oracle below is deliberately brute force and independent of
// src/planning/datetime.ts: every zone's offsets and transitions sit on a
// 15-minute grid, so "the first instant of local date D" is simply the first
// quarter-hour instant whose local calendar date is D. Intl is the only ground
// truth used.

export const WHOLE_HOUR_ZONES = [
  "Pacific/Pago_Pago", // -11
  "Pacific/Honolulu", // -10
  "America/Anchorage", // -9 / -8
  "America/Los_Angeles", // -8 / -7
  "America/Denver", // -7 / -6
  "America/Chicago", // -6 / -5
  "America/New_York", // -5 / -4
  "America/Halifax", // -4 / -3
  "America/Sao_Paulo", // -3
  "Atlantic/South_Georgia", // -2
  "Atlantic/Azores", // -1 / 0
  "UTC", // 0
  "Europe/London", // 0 / +1
  "Europe/Berlin", // +1 / +2
  "Africa/Cairo", // +2 / +3
  "Europe/Moscow", // +3
  "Asia/Dubai", // +4
  "Asia/Karachi", // +5
  "Asia/Dhaka", // +6
  "Asia/Bangkok", // +7
  "Asia/Shanghai", // +8
  "Asia/Tokyo", // +9
  "Australia/Sydney", // +10 / +11
  "Pacific/Auckland", // +12 / +13
] as const;

export const OFF_GRID_ZONES = [
  "Asia/Kolkata", // +5:30
  "Asia/Kathmandu", // +5:45
  "Australia/Adelaide", // +9:30 / +10:30
  "Pacific/Kiritimati", // +14
] as const;

export const MATRIX_ZONES: string[] = [...WHOLE_HOUR_ZONES, ...OFF_GRID_ZONES];

/** Zones whose spring-forward happens at local midnight (00:00 -> 01:00). */
export const MIDNIGHT_GAP_ZONES = ["America/Santiago", "Asia/Beirut", "Africa/Cairo"] as const;

const QUARTER = 15 * 60_000;
const DAY = 86_400_000;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  naive: string; // YYYY-MM-DDTHH:MM:SS
  weekday: number; // 0=Sun..6=Sat
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function local(ms: number, tz: string): LocalParts {
  const parts = fmt(tz).formatToParts(new Date(ms));
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  const date = `${g("year")}-${g("month")}-${g("day")}`;
  const time = `${g("hour")}:${g("minute")}`;
  return { date, time, naive: `${date}T${time}:${g("second")}`, weekday: WD[g("weekday")]! };
}

export function offsetMinutes(ms: number, tz: string): number {
  return Math.round((Date.parse(local(ms, tz).naive + "Z") - ms) / 60_000);
}

export function addDays(date: string, n: number): string {
  const ms = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) + n * DAY;
  return new Date(ms).toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  return new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10))).getUTCDay();
}

/** Every quarter-hour instant whose local wall clock is `date`T`time`
 *  (0 in a gap, 2 in an overlap), ascending. */
export function wallInstants(date: string, time: string, tz: string): number[] {
  const pretend = Date.parse(`${date}T${time}:00Z`);
  const out: number[] = [];
  for (let t = pretend - 15 * 3_600_000; t <= pretend + 15 * 3_600_000; t += QUARTER) {
    const l = local(t, tz);
    if (l.date === date && l.time === time) out.push(t);
  }
  return out;
}

/** Earliest instant at wall clock date/time; throws in a gap. */
export function wall(date: string, time: string, tz: string): number {
  const c = wallInstants(date, time, tz);
  if (c.length === 0) throw new Error(`oracle: ${date}T${time} does not exist in ${tz}`);
  return c[0]!;
}

export function wallIso(date: string, time: string, tz: string): string {
  return new Date(wall(date, time, tz)).toISOString();
}

/** First instant of local calendar date `date` (01:00 on a midnight-gap day). */
export function dayStart(date: string, tz: string): number {
  const base = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
  for (let t = base - 15 * 3_600_000; t <= base + 15 * 3_600_000; t += QUARTER) {
    if (local(t, tz).date === date) return t;
  }
  throw new Error(`oracle: no instant on ${date} in ${tz}`);
}

export function dayStartIso(date: string, tz: string): string {
  return new Date(dayStart(date, tz)).toISOString();
}

/** Monday on or before the local date of `ms`. */
export function localMonday(ms: number, tz: string): string {
  const l = local(ms, tz);
  return addDays(l.date, -((l.weekday + 6) % 7));
}

/** The local week [Mon first instant, next Mon first instant) containing ms. */
export function weekContaining(ms: number, tz: string): { start: string; end: string } {
  const mon = localMonday(ms, tz);
  return { start: dayStartIso(mon, tz), end: dayStartIso(addDays(mon, 7), tz) };
}

export interface Transition {
  atMs: number; // first instant at the new offset
  before: number; // offset minutes before
  after: number; // offset minutes after
  localBefore: string; // wall clock (naive) of the last quarter before
  localAfter: string; // wall clock (naive) of atMs
}

/** All offset transitions of `tz` in calendar `year` (UTC), quarter-exact. */
export function transitions(tz: string, year: number): Transition[] {
  const out: Transition[] = [];
  const startMs = Date.UTC(year, 0, 1);
  const endMs = Date.UTC(year + 1, 0, 1);
  let prev = offsetMinutes(startMs, tz);
  const H = 3_600_000;
  for (let t = startMs + H; t <= endMs; t += H) {
    const o = offsetMinutes(t, tz);
    if (o !== prev) {
      let q = t - H;
      while (offsetMinutes(q + QUARTER, tz) === prev) q += QUARTER;
      out.push({
        atMs: q + QUARTER,
        before: prev,
        after: o,
        localBefore: local(q, tz).naive,
        localAfter: local(q + QUARTER, tz).naive,
      });
      prev = o;
    }
  }
  return out;
}

/** The local date whose midnight is skipped by the zone's spring-forward in
 *  `year` (i.e. the gap starts at 00:00), or null. */
export function midnightGapDate(tz: string, year: number): string | null {
  for (const tr of transitions(tz, year)) {
    if (tr.after > tr.before && tr.localAfter.endsWith("T01:00:00")) return tr.localAfter.slice(0, 10);
  }
  return null;
}
