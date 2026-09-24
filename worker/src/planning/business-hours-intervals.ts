import type { BusinessHours } from "./solver-contract";
import type { LocalNaive } from "./solver-contract";
import { fromLocalNaive } from "./datetime";
import { mergeIntervals, type Interval } from "./intervals";

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Expand business hours into concrete [start,end) instant intervals over the
 *  window, one per allowed weekday/day. Returns the whole window if BH absent. */
export function businessHoursIntervals(
  windowStartMs: number,
  windowEndMs: number,
  bh: BusinessHours | null | undefined,
  tz: string,
): Interval[] {
  if (!bh) return [{ s: windowStartMs, e: windowEndMs }];
  const out: Interval[] = [];
  const dayMs = 86_400_000;
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // Iterate LOCAL calendar dates overlapping the window (plus one day of
  // margin either side), stepping by pure calendar arithmetic — never by a
  // fixed 24h UTC increment, which drifts across a DST transition and can
  // skip or repeat a local date (e.g. the local clock jumping forward on
  // spring-forward makes two consecutive 24h-UTC samples straddle a whole
  // local day). For each date, derive the weekday and (if allowed) the BH
  // instant interval.
  const firstLocalDate = fmt.format(new Date(windowStartMs - dayMs)); // YYYY-MM-DD
  const lastLocalDate = fmt.format(new Date(windowEndMs + dayMs));
  const firstDayMs = Date.UTC(
    parseInt(firstLocalDate.slice(0, 4), 10),
    parseInt(firstLocalDate.slice(5, 7), 10) - 1,
    parseInt(firstLocalDate.slice(8, 10), 10),
  );
  const lastDayMs = Date.UTC(
    parseInt(lastLocalDate.slice(0, 4), 10),
    parseInt(lastLocalDate.slice(5, 7), 10) - 1,
    parseInt(lastLocalDate.slice(8, 10), 10),
  );
  for (let t = firstDayMs; t <= lastDayMs; t += dayMs) {
    const dt = new Date(t);
    const localDate = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
    const weekdayIdx = dt.getUTCDay();
    const dayName = WEEKDAYS[weekdayIdx];
    if (!dayName || !(bh.days as string[]).includes(dayName)) continue;
    const startIso = fromLocalNaive(`${localDate}T${bh.start}:00` as LocalNaive, tz);
    const endIso = fromLocalNaive(`${localDate}T${bh.end}:00` as LocalNaive, tz);
    const s = Date.parse(startIso);
    const e = Date.parse(endIso);
    const clippedS = Math.max(s, windowStartMs);
    const clippedE = Math.min(e, windowEndMs);
    if (clippedE > clippedS) out.push({ s: clippedS, e: clippedE });
  }
  return mergeIntervals(out);
}
