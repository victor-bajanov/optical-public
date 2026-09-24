// Presentation-only local formatting. Instant math lives in planning/datetime.ts.

function parts(iso: string, tz: string, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`invalid ISO datetime: ${iso}`);
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-AU", { timeZone: tz, ...opts }).formatToParts(new Date(ms))) {
    out[p.type] = p.value;
  }
  return out;
}

/** "2:45 PM" in `tz`. */
export function formatLocalTime(iso: string, tz: string): string {
  const p = parts(iso, tz, { hour: "numeric", minute: "2-digit", hour12: true });
  const period = p.dayPeriod ?? p.ampm ?? "";
  return `${p.hour}:${p.minute} ${period.toUpperCase()}`;
}

/** "Mon 15 June" in `tz`. */
export function formatLocalDate(iso: string, tz: string): string {
  const p = parts(iso, tz, { weekday: "short", day: "numeric", month: "long" });
  return `${p.weekday} ${p.day} ${p.month}`;
}

/** Local calendar day key "YYYY-MM-DD" in `tz`, for grouping. */
export function localDayKey(iso: string, tz: string): string {
  const p = parts(iso, tz, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${p.year}-${p.month}-${p.day}`;
}
