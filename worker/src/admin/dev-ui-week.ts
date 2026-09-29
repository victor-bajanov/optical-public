// Browser-side week helpers for the dev UI (admin/dev-ui-route.ts). Each
// function is inlined into the page VERBATIM via Function.prototype.toString,
// so the bodies must stay self-contained plain JS: no imports, no references
// to other module bindings, and no inner named functions or const-bound
// arrows (the bundler's keepNames would wrap those in a `__name` helper that
// doesn't exist in the browser). Types are erased at build time.
//
// The windows they build must be the caller's local Mon 00:00 in their
// effective tz (whoami.home_tz), the same week the server buckets in. A
// UTC-midnight window is Sunday afternoon/evening in the Americas and buckets
// into the PREVIOUS local week.

/** The local calendar date (YYYY-MM-DD) of instant `ms` in `tz`. */
export function devUiLocalYmd(ms: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  let y = "", m = "", d = "";
  for (const p of parts) {
    if (p.type === "year") y = p.value;
    else if (p.type === "month") m = p.value;
    else if (p.type === "day") d = p.value;
  }
  return y + "-" + m + "-" + d;
}

/** The Monday (YYYY-MM-DD) of the week containing bare date `ymd`, shifted
 *  by `weekOffset` weeks. Pure calendar arithmetic, no zone involved. */
export function devUiMondayYmd(ymd: string, weekOffset: number): string {
  const d = new Date(ymd + "T00:00:00Z");
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - sinceMonday + 7 * weekOffset);
  return d.toISOString().slice(0, 10);
}

/** The instant (ISO-Z, milliseconds) of 00:00 on bare date `ymd` in `tz`. */
export function devUiLocalMidnightIso(ymd: string, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const naive = Date.parse(ymd + "T00:00:00Z");
  let t = naive;
  // Fixed-point on the zone offset: two passes settle it across a DST change.
  for (let i = 0; i < 3; i++) {
    const v: Record<string, number> = {};
    for (const p of fmt.formatToParts(new Date(t))) if (p.type !== "literal") v[p.type] = Number(p.value);
    const localAsUtc = Date.UTC(v.year!, v.month! - 1, v.day!, v.hour!, v.minute!, v.second!);
    t = naive - (localAsUtc - t);
  }
  return new Date(t).toISOString();
}
