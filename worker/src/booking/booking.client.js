// Browser-side module for the public booking page. Plain ESM — no build
// step, no TypeScript: this file is served verbatim as a static asset and
// executed unbundled by the booker's browser.
//
// PRIVACY: the booker may load their own .ics calendar to see which offered
// slots clash with their existing commitments. That file is parsed HERE, in
// their browser, and never leaves it. Nothing in this module performs network
// I/O — do not add any.
//
// The parser is a minimal RFC 5545 VEVENT reader. The scope is deliberately
// tight: start/end in UTC for each VEVENT inside the requested window, plus a
// small subset of RRULE expansions. Everything exotic (RDATE, VTIMEZONE
// overrides, BYDAY/BYMONTH-heavy rules, VTODO/VJOURNAL components) is ignored
// or collapsed to the first instance with a warning. That biases towards
// over-reporting busy time, which costs a dot; under-reporting would offer a
// slot the booker is not actually free for.
//
// That bias does NOT extend to properties that state availability outright.
// TRANSP:TRANSPARENT means "this event does not consume time" and
// STATUS:CANCELLED means it is not happening, so honouring both is accuracy,
// not under-reporting. Ignoring TRANSP was a real bug: Google exports
// working-location markers, birthdays and due-date reminders as all-day
// TRANSPARENT events, and counting seven of them as 24-hour blocks merged into
// one 107-hour wall that greyed out a booker's entire week. EXDATE is honoured
// for the same reason — a deleted occurrence is not busy time.
//
// The overlay is only the booker's convenience view. The owner's true
// availability is enforced server-side at claim time, so an overlay that reads
// slightly free can never actually double-book anyone.
//
// The repo depends on `rrule@^2.8.1`, but it is deliberately not used here:
// this file ships to the browser unbundled, with no build step to resolve a
// bare specifier or tree-shake the ~40 KB library, and the supported subset
// below is a few dozen lines.
//
// Browsers provide IANA TZ data through Intl.DateTimeFormat. We use
// formatToParts() to invert wall time → UTC for TZID-bound DTSTART values.

/** Warnings from the most recent parseIcsBusy() call. Cleared at the start of
 *  each parse; the array identity is stable so consumers may hold a reference. */
export const warnings = [];

/** Counts from the most recent parseIcsBusy() call. Object identity is stable
 *  so consumers may hold a reference.
 *
 *  `blocks` is what parseIcsBusy returns — intervals AFTER merging. `events` is
 *  how many VEVENTs actually contributed busy time inside the window. The two
 *  diverge sharply on a real calendar (a working week of back-to-back meetings
 *  merges to a handful of blocks), and reporting only `blocks` once read as
 *  "we barely understood your file" when the truth was the opposite. */
export const stats = { events: 0, blocks: 0 };

/** The status line shown after a booker loads their .ics.
 *
 *  Pure so it can be tested: the surrounding mount() DOM closures cannot run in
 *  the workers pool, the same reason resetTurnstile/claimOutcome are extracted.
 *
 *  Deliberately does NOT say anything "could not be read" unless that is true.
 *  Most warnings are degraded-but-read (an unsupported FREQ collapsed to its
 *  first occurrence), and calling those a failure sent a booker hunting for a
 *  corrupt file that did not exist. */
export function overlayStatusText(parseStats, parseWarnings) {
  const { events, blocks } = parseStats;
  let text;
  if (blocks === 0) {
    text = "✓ No busy time found in that calendar";
  } else {
    text = `✓ ${blocks} busy block${blocks === 1 ? "" : "s"} read locally`;
    // Only worth saying when merging actually collapsed something, otherwise
    // it is noise.
    if (events > blocks) text += ` (from ${events} events)`;
  }
  const n = parseWarnings.length;
  if (n > 0) text += ` · ${n} warning${n === 1 ? "" : "s"} — hover for details`;
  return text;
}

/** Most instances a single RRULE may expand to. */
export const MAX_RULE_INSTANCES = 3700;
/** Most instances one parse may produce across every VEVENT combined. Without
 *  this the per-rule cap multiplies by the number of events: an ordinary
 *  300-event export could block the main thread for the better part of a
 *  minute. */
export const MAX_TOTAL_INSTANCES = 20_000;
/** Wall-clock budget for one parse. Checked between events, so a parse may
 *  overrun by at most one event's expansion. */
export const PARSE_BUDGET_MS = 2_000;
/** Largest .ics we will even attempt. Ordinary exports are tens of KB to a
 *  few MB; beyond this the string work alone would jank the tab. */
export const MAX_ICS_CHARS = 5_000_000;

// ---------- timezone formatters ----------

// Constructing an Intl.DateTimeFormat is expensive (~0.2 ms) and both the
// parser and the dot counter build them in hot loops, so they are cached by
// (timeZone + shape). Cache keys come from TZID values in a user-supplied
// file, so the cache is bounded by the number of distinct zones in it.
const fmtCache = new Map();

/** Timezones that were not recognised during the current parse, so each is
 *  warned about once rather than once per property. */
const unknownTzids = new Set();

/** Whether Intl accepts a zone name. Persistent across parses (the answer
 *  cannot change), unlike the per-parse `unknownTzids` warn-once set. */
const tzValidity = new Map();

function isValidTz(tz) {
  const hit = tzValidity.get(tz);
  if (hit !== undefined) return hit;
  let ok = true;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  } catch {
    ok = false;
  }
  tzValidity.set(tz, ok);
  return ok;
}

/** Map a TZID onto a zone Intl will accept. Exchange and Outlook routinely
 *  emit Windows zone names ("W. Europe Standard Time") which Intl rejects with
 *  a RangeError; falling back skews the event by an hour or two, whereas
 *  letting the error propagate would drop the event entirely and report the
 *  booker as free. Over-reporting busy is the safe direction. Warned once per
 *  distinct zone per parse. */
function resolveTz(tz, fallbackTz) {
  if (isValidTz(tz)) return tz;
  if (!unknownTzids.has(tz)) {
    unknownTzids.add(tz);
    warnings.push(
      `Unknown timezone "${tz}"; times read as ${fallbackTz} instead ` +
        `(may be off by the difference between the two zones)`,
    );
  }
  return isValidTz(fallbackTz) ? fallbackTz : "UTC";
}

/** Build (or reuse) a formatter for an already-resolved zone. */
function tzFormatter(tz, shape, spec) {
  const key = `${tz} ${shape}`;
  const hit = fmtCache.get(key);
  if (hit !== undefined) return hit;
  const fmt = new Intl.DateTimeFormat(spec.locale, { ...spec.options, timeZone: tz });
  fmtCache.set(key, fmt);
  return fmt;
}

const WALL_PARTS_OPTS = {
  locale: "en-CA",
  options: {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  },
};

const LOCAL_DATE_OPTS = {
  locale: "en-CA",
  options: { year: "numeric", month: "2-digit", day: "2-digit" },
};

// ---------- line-level utilities ----------

/** Normalise CRLF/CR to LF, then collapse RFC 5545 continuation lines:
 *  a line starting with whitespace continues the previous line with the
 *  leading whitespace stripped. */
export function unfoldLines(raw) {
  const normalised = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const out = [];
  for (const line of normalised.split("\n")) {
    if (line.length > 0 && (line[0] === " " || line[0] === "\t")) {
      if (out.length > 0) {
        out[out.length - 1] = (out[out.length - 1] ?? "") + line.slice(1);
        continue;
      }
    }
    out.push(line);
  }
  return out;
}

/** Parse a property line like `DTSTART;TZID=America/New_York:20260501T090000`
 *  into name/params/value. Splits on the FIRST `:`. */
export function parseProperty(line) {
  const colonIdx = line.indexOf(":");
  if (colonIdx < 0) throw new Error(`Missing ':' in property line: ${line}`);
  const head = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);

  const parts = head.split(";");
  const nameToken = parts[0];
  if (nameToken === undefined || nameToken.length === 0) {
    throw new Error(`Empty property name: ${line}`);
  }
  const name = nameToken.toUpperCase();
  const params = {};
  for (let i = 1; i < parts.length; i += 1) {
    const p = parts[i];
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name, params, value };
}

// ---------- datetime conversion ----------

function parseIcsLiteralUtc(value) {
  // Accepts YYYYMMDDTHHMMSSZ. Returns a UTC instant in ms.
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (m === null) throw new Error(`Invalid UTC DT literal: ${value}`);
  return Date.UTC(
    parseInt(m[1], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[3], 10),
    parseInt(m[4], 10),
    parseInt(m[5], 10),
    parseInt(m[6], 10),
  );
}

function parseIcsLocal(value) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (m === null) throw new Error(`Invalid local DT literal: ${value}`);
  return {
    y: parseInt(m[1], 10),
    mo: parseInt(m[2], 10),
    d: parseInt(m[3], 10),
    h: parseInt(m[4], 10),
    mi: parseInt(m[5], 10),
    s: parseInt(m[6], 10),
  };
}

function parseIcsDate(value) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m === null) throw new Error(`Invalid DATE literal: ${value}`);
  return { y: parseInt(m[1], 10), mo: parseInt(m[2], 10), d: parseInt(m[3], 10) };
}

/** Given a wall-time {y,mo,d,h,mi,s} in the named IANA timezone, return the
 *  corresponding UTC instant in ms. Uses the formatToParts idiom: compute the
 *  TZ offset at a guessed UTC instant, then iterate to refine. */
function wallTimeInTzToUtc(y, mo, d, h, mi, s, tz) {
  // Initial guess: treat the wall time as UTC.
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  // Measure how `tz` would label that instant. `tz` is already resolved by the
  // caller, so the formatter cannot throw here.
  const fmt = tzFormatter(tz, "wall", WALL_PARTS_OPTS);
  function tzParts(instant) {
    const parts = {};
    for (const p of fmt.formatToParts(new Date(instant))) {
      if (p.type !== "literal") parts[p.type] = p.value;
    }
    return {
      y: parseInt(parts.year, 10),
      mo: parseInt(parts.month, 10),
      d: parseInt(parts.day, 10),
      h: parseInt(parts.hour === "24" ? "0" : parts.hour, 10),
      mi: parseInt(parts.minute, 10),
      s: parseInt(parts.second, 10),
    };
  }
  // Iterate twice — once is enough except for DST edge cases.
  let instant = guess;
  for (let i = 0; i < 2; i += 1) {
    const tp = tzParts(instant);
    const tpUtc = Date.UTC(tp.y, tp.mo - 1, tp.d, tp.h, tp.mi, tp.s);
    const offset = tpUtc - instant; // how many ms UTC is behind tz
    instant = guess - offset;
  }
  return instant;
}

/** Inverse of wallTimeInTzToUtc: given a UTC instant in ms, return the
 *  wall-clock parts in the named timezone. Used by expandRRule to advance
 *  wall-clock components across DST boundaries. */
function utcToWallParts(ms, tz) {
  const fmt = tzFormatter(tz, "wall", WALL_PARTS_OPTS);
  const parts = {};
  for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  // Intl returns "24" for midnight in some locales; normalise.
  const h = parseInt(parts.hour ?? "0", 10);
  return {
    y: parseInt(parts.year ?? "0", 10),
    mo: parseInt(parts.month ?? "0", 10),
    d: parseInt(parts.day ?? "0", 10),
    h: h === 24 ? 0 : h,
    mi: parseInt(parts.minute ?? "0", 10),
    s: parseInt(parts.second ?? "0", 10),
  };
}

/** Convert an ICS date-time value + optional TZID parameter into a UTC
 *  instant in ms, flagging DATE (all-day) values. */
export function toUtcMs(value, tzid, defaultTz) {
  if (value.endsWith("Z")) {
    return { ms: parseIcsLiteralUtc(value), allDay: false };
  }
  if (value.length === 8) {
    // DATE — all-day. Treat the date as 00:00:00 in tzid or defaultTz.
    const ymd = parseIcsDate(value);
    const tz = resolveTz(tzid ?? defaultTz, defaultTz);
    return { ms: wallTimeInTzToUtc(ymd.y, ymd.mo, ymd.d, 0, 0, 0, tz), allDay: true };
  }
  // Floating or TZID-bound local time.
  const local = parseIcsLocal(value);
  const tz = resolveTz(tzid ?? defaultTz, defaultTz);
  const ms = wallTimeInTzToUtc(local.y, local.mo, local.d, local.h, local.mi, local.s, tz);
  return { ms, allDay: false };
}

// ---------- RRULE expansion ----------

function parseRRule(value) {
  const out = {};
  for (const pair of value.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    out[pair.slice(0, eq).toUpperCase()] = pair.slice(eq + 1);
  }
  return out;
}

/** Expand a DTSTART under the given RRULE, clipped to the window. Only
 *  FREQ=DAILY|WEEKLY with optional INTERVAL/COUNT/UNTIL are supported;
 *  anything else keeps the first instance only and warns. Returns a list of
 *  `{ s, e }` millisecond intervals. */
export function expandRRule(startMs, duration, rule, fromMs, toMs, warn, tzid, defaultTz) {
  const freq = rule.FREQ;
  if (freq !== "DAILY" && freq !== "WEEKLY") {
    warn(`Unsupported RRULE FREQ=${freq ?? "(missing)"}; keeping first instance only`);
    return [{ s: startMs, e: startMs + duration }];
  }
  const interval = rule.INTERVAL ? Math.max(1, parseInt(rule.INTERVAL, 10)) : 1;
  const count = rule.COUNT ? parseInt(rule.COUNT, 10) : undefined;
  let until;
  if (rule.UNTIL !== undefined) {
    // Accept either UTC literal or date form.
    if (rule.UNTIL.endsWith("Z")) {
      until = parseIcsLiteralUtc(rule.UNTIL);
    } else if (rule.UNTIL.length === 8) {
      const ymd = parseIcsDate(rule.UNTIL);
      until = Date.UTC(ymd.y, ymd.mo - 1, ymd.d, 23, 59, 59);
    }
  }

  // For TZID-bound recurrences we advance wall-clock components and
  // re-project, so DST shifts don't drift the UTC instant. For UTC-literal
  // DTSTARTs (no TZID) there's no wall clock to reconstruct, so the original
  // ms-step path stays.
  const useWallClock = tzid !== null && tzid !== undefined && tzid !== "UTC";
  const projTz = resolveTz(useWallClock ? tzid : defaultTz, defaultTz);
  const stepMs = (freq === "DAILY" ? 1 : 7) * 24 * 60 * 60 * 1000 * interval;
  const stepDays = (freq === "DAILY" ? 1 : 7) * interval;

  // Seek to the window instead of stepping to it. A daily standup that has run
  // since 2015 is >3700 steps before a window in 2026, so stepping exhausted
  // the safety cap before ever arriving and reported the booker as free.
  //
  // An instance is kept when `t + duration > fromMs`, so seek against that
  // target rather than fromMs — otherwise an event straddling the window start
  // is skipped. The estimate uses the fixed stepMs, which drifts by up to an
  // hour against wall-clock stepping across a DST boundary, so undershoot by
  // one step and let the loop walk the remainder.
  const target = fromMs - duration;
  let ordinal = 0; // position in the recurrence, for COUNT
  let t = startMs;
  if (startMs <= target) {
    ordinal = Math.max(0, Math.floor((target - startMs) / stepMs) - 1);
    if (ordinal > 0) {
      if (useWallClock) {
        const w = utcToWallParts(startMs, projTz);
        t = wallTimeInTzToUtc(w.y, w.mo, w.d + ordinal * stepDays, w.h, w.mi, w.s, projTz);
      } else {
        t = startMs + ordinal * stepMs;
      }
    }
  }

  const instances = [];
  let steps = 0; // work done here, bounded separately from the recurrence ordinal
  for (;;) {
    if (count !== undefined && ordinal >= count) break;
    if (until !== undefined && t > until) break;
    if (t >= toMs) break;
    const endT = t + duration;
    if (endT > fromMs) instances.push({ s: t, e: endT });
    ordinal += 1;
    steps += 1;
    // Safety cap. Counted in steps taken, not in recurrence ordinal: a seek can
    // legitimately start at ordinal 4000 having done no work at all.
    if (steps >= MAX_RULE_INSTANCES) {
      warn(`RRULE expansion stopped at ${MAX_RULE_INSTANCES} instances (safety cap)`);
      break;
    }
    if (useWallClock) {
      const wall = utcToWallParts(t, projTz);
      t = wallTimeInTzToUtc(wall.y, wall.mo, wall.d + stepDays, wall.h, wall.mi, wall.s, projTz);
    } else {
      t += stepMs;
    }
  }
  return instances;
}

// ---------- parseIcsBusy ----------

function browserTz() {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Merge overlapping/touching intervals in place-agnostic fashion, sorted by
 *  start. Input need not be sorted. */
function mergeBusy(intervals) {
  const sorted = intervals.slice().sort((a, b) => a.s - b.s);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && iv.s <= last.e) {
      if (iv.e > last.e) last.e = iv.e;
      continue;
    }
    out.push({ s: iv.s, e: iv.e });
  }
  return out;
}

/** Parse an .ics document into merged, sorted `{ s, e }` millisecond busy
 *  intervals clipped to `[fromMs, toMs)`.
 *
 *  Never throws: the input is a file the booker picked, so malformed content
 *  is expected. Junk in, `[]` out, with the reason in `warnings`. */
export function parseIcsBusy(text, options) {
  warnings.length = 0;
  unknownTzids.clear();
  stats.events = 0;
  stats.blocks = 0;
  const fromMs = options.fromMs;
  const toMs = options.toMs;
  const defaultTz = options.defaultTz ?? browserTz();

  const warn = (msg) => {
    warnings.push(msg);
  };

  const source = String(text);
  if (source.length > MAX_ICS_CHARS) {
    // Bail before the string work: unfolding a file this size would itself
    // freeze the tab. The UI must surface this — an empty overlay silently
    // reads as "free all week".
    warn(
      `Calendar file is too large to read (${Math.round(source.length / 1e6)} MB, ` +
        `limit ${Math.round(MAX_ICS_CHARS / 1e6)} MB); no availability was loaded from it`,
    );
    return [];
  }

  // Total work budget across every VEVENT. The per-rule cap alone multiplies
  // by the number of events, so an ordinary 300-event export could block the
  // main thread for the better part of a minute.
  const deadline = Date.now() + PARSE_BUDGET_MS;
  let totalInstances = 0;
  let exhausted = false;

  const busy = [];
  try {
    const lines = unfoldLines(source);

    let inEvent = false;
    let dtstart = null;
    let dtstartTzid = null;
    let dtend = null;
    let rrule = null;
    let transp = null;
    let status = null;
    let exdates = null;

    for (const raw of lines) {
      if (raw.length === 0) continue;
      if (raw === "BEGIN:VEVENT") {
        inEvent = true;
        dtstart = null;
        dtstartTzid = null;
        dtend = null;
        rrule = null;
        transp = null;
        status = null;
        exdates = null;
        continue;
      }
      if (raw === "END:VEVENT") {
        inEvent = false;
        // Availability first, before any date work: an event that consumes no
        // time cannot contribute busy intervals, whatever its dates say. This
        // also means an unsupported FREQ on a TRANSPARENT event never warns —
        // a yearly birthday should be silent, not a scary parse notice.
        if (transp === "TRANSPARENT" || status === "CANCELLED") continue;
        if (dtstart === null) {
          warn("VEVENT missing DTSTART");
          continue;
        }
        // Some real-world files omit DTEND: all-day → start + 24h, else + 1h.
        const startMs = dtstart.ms;
        const endMs =
          dtend !== null
            ? dtend.ms
            : startMs + (dtstart.allDay ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000);
        const duration = endMs - startMs;
        if (duration <= 0) {
          warn("VEVENT DTEND is not after DTSTART");
          continue;
        }

        if (totalInstances >= MAX_TOTAL_INSTANCES || Date.now() > deadline) {
          exhausted = true;
          break;
        }

        const instances =
          rrule !== null
            ? expandRRule(startMs, duration, rrule, fromMs, toMs, warn, dtstartTzid, defaultTz)
            : [{ s: startMs, e: endMs }];
        totalInstances += instances.length;

        let contributed = false;
        for (const inst of instances) {
          // A deleted occurrence is not busy time. Matched on the resolved UTC
          // instant rather than the literal text: EXDATE may be written in a
          // different form from DTSTART (a Z literal against a TZID-bound
          // start is common), so string comparison would silently miss it.
          if (exdates !== null && exdates.has(inst.s)) continue;
          // Clip to the window; drop anything fully outside it.
          const s = Math.max(inst.s, fromMs);
          const e = Math.min(inst.e, toMs);
          if (e > s) {
            busy.push({ s, e });
            contributed = true;
          }
        }
        if (contributed) stats.events += 1;
        continue;
      }
      if (!inEvent) continue;

      let prop;
      try {
        prop = parseProperty(raw);
      } catch (err) {
        warn(`parseProperty failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      try {
        if (prop.name === "DTSTART") {
          const tzid = prop.params.TZID ?? null;
          dtstart = toUtcMs(prop.value, tzid, defaultTz);
          dtstartTzid = tzid;
        } else if (prop.name === "DTEND") {
          dtend = toUtcMs(prop.value, prop.params.TZID ?? null, defaultTz);
        } else if (prop.name === "RRULE") {
          rrule = parseRRule(prop.value);
        } else if (prop.name === "TRANSP") {
          transp = prop.value.trim().toUpperCase();
        } else if (prop.name === "STATUS") {
          status = prop.value.trim().toUpperCase();
        } else if (prop.name === "EXDATE") {
          // One property may carry several comma-separated dates, and a VEVENT
          // may carry several EXDATE properties; both accumulate.
          const exTzid = prop.params.TZID ?? null;
          if (exdates === null) exdates = new Set();
          for (const part of prop.value.split(",")) {
            const value = part.trim();
            if (value.length === 0) continue;
            exdates.add(toUtcMs(value, exTzid, defaultTz).ms);
          }
        }
      } catch (err) {
        warn(`${prop.name} parse failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    warn(`ICS parse aborted: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  if (exhausted) {
    // Partial busy data is still worth showing — it is strictly better than
    // none — but the booker must be told the rest was not read.
    warn(
      "Calendar was too large to read fully; later events were skipped and " +
        "may not be shown as busy",
    );
  }

  const merged = mergeBusy(busy);
  stats.blocks = merged.length;
  return merged;
}

// ---------- slot filtering and day dots ----------

export const MAX_DOTS = 4;

function overlaps(startMs, endMs, intervals) {
  return intervals.some((iv) => iv.s < endMs && iv.e > startMs);
}

/** Annotate each slot with whether it clashes with the booker's own busy time.
 *  Clashing slots stay in the list — they are dimmed, not hidden, so the booker
 *  can still choose to double-book themselves. */
export function filterSlots(slots, durationMinutes, overlay) {
  const durMs = durationMinutes * 60_000;
  return slots.map((iso) => {
    const s = Date.parse(iso);
    return { iso, clashes: overlaps(s, s + durMs, overlay) };
  });
}

function localDate(iso, tz) {
  return tzFormatter(resolveTz(tz, "UTC"), "date", LOCAL_DATE_OPTS).format(new Date(iso));
}

/** Group slot ISO strings by their LOCAL calendar date.
 *
 *  `dotCount` over a raw array is O(days x slots) in Intl formatting, which on
 *  a three-week grid costs ~160 ms per render — repaid on every duration toggle
 *  and overlay load. Bucket once, then pass the Map to `dotCount` instead of
 *  the array. The caller owns the Map, so there is no staleness risk from
 *  caching it against a mutated array. */
export function bucketSlotsByLocalDate(slots, tz) {
  const fmt = tzFormatter(resolveTz(tz, "UTC"), "date", LOCAL_DATE_OPTS);
  const buckets = new Map();
  for (const iso of slots) {
    const key = fmt.format(new Date(iso));
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [iso]);
    else bucket.push(iso);
  }
  return buckets;
}

/** How many slots on `isoDate` (a LOCAL YYYY-MM-DD) work for BOTH parties,
 *  capped at MAX_DOTS. Loading an overlay therefore reduces the dots — a day
 *  with no mutual availability shows none and can be skipped.
 *
 *  `slots` may be an array of ISO strings, or the Map returned by
 *  `bucketSlotsByLocalDate` for the same `tz` (which skips the per-slot date
 *  formatting entirely). */
export function dotCount(isoDate, slots, durationMinutes, overlay, tz) {
  const durMs = durationMinutes * 60_000;
  const bucketed = slots instanceof Map;
  const candidates = bucketed ? (slots.get(isoDate) ?? []) : slots;
  let n = 0;
  for (const iso of candidates) {
    if (!bucketed && localDate(iso, tz) !== isoDate) continue;
    const s = Date.parse(iso);
    if (overlaps(s, s + durMs, overlay)) continue;
    if (++n === MAX_DOTS) break;
  }
  return n;
}

/** Days offered in the strip, in order, from the Map `bucketSlotsByLocalDate`
 *  returns.
 *
 *  Every bookable day appears: the strip is the only way to select one, so a
 *  cap here would make the tail of the horizon (21 days by default, up to 120)
 *  unreachable even though /slots returns it. `.strip` scrolls horizontally. */
export function stripDays(buckets) {
  return [...buckets.keys()];
}

/** The strip's days grouped by calendar month, in order: `[{ month, days }]`
 *  with `month` a `YYYY-MM` key.
 *
 *  A strip spanning `max_horizon_days` can cross several months, and a
 *  scrolled row of bare day numbers ("29 30 1 2 5 6") does not say which
 *  month "1" is in. Each group is drawn with its own month label, which
 *  sticks to the strip's left edge while any of the group's days are in
 *  view, so the month is always readable wherever the strip is scrolled. */
export function stripMonths(days) {
  const groups = [];
  for (const d of days) {
    const month = d.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last && last.month === month) last.days.push(d);
    else groups.push({ month, days: [d] });
  }
  return groups;
}

/** Text for a month group's label: "Sep", or "Jan 2027" once the year no
 *  longer matches the strip's first month's — a 365-day reach can cross a
 *  year boundary, and a bare "Jan" after "Dec" is ambiguous. `first` is the
 *  first group's `YYYY-MM` key. Formatted in UTC against the key's noon on
 *  the 1st, as the strip's weekday labels are, so no zone can roll it.
 *  `locale` is the booker's browser locale when omitted (as every other label
 *  on the page is); tests pin one so "Sep" vs "Sept" is not the runner's. */
export function monthLabel(month, first, locale) {
  const date = new Date(`${month}-01T12:00:00Z`);
  const withYear = month.slice(0, 4) !== first.slice(0, 4);
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(date);
}

/** The seven LOCAL date keys of the calendar week (Monday first) containing
 *  `isoDate`.
 *
 *  Aligned to the week rather than starting at the selected day so that moving
 *  between days of one week only moves the highlight — a rolling seven-day
 *  window would reshuffle every column under the booker on each click. */
export function weekOf(isoDate) {
  // Noon UTC against the date key: far enough from either midnight that the
  // arithmetic below cannot roll onto a neighbouring date.
  const noon = Date.parse(`${isoDate}T12:00:00Z`);
  const mondayOffset = (new Date(noon).getUTCDay() + 6) % 7;
  const monday = noon - mondayOffset * 86_400_000;
  return Array.from({ length: 7 }, (_, i) =>
    new Date(monday + i * 86_400_000).toISOString().slice(0, 10),
  );
}

/** Columns for the desktop week grid: one per day of the week containing
 *  `isoDate`, each holding that day's slots already marked against the
 *  overlay. An empty `slots` array is a day with nothing on offer, which the
 *  grid draws as the hatched `.none` cell.
 *
 *  Nothing is capped here. The week shown follows the day the strip selected,
 *  and the strip lists every bookable day, so a 21-day default horizon — or
 *  the 120 the config allows — stays wholly reachable. */
export function weekColumns(isoDate, buckets, durationMinutes, overlay) {
  if (isoDate === null || isoDate === undefined) return [];
  return weekOf(isoDate).map((day) => ({
    day,
    slots: filterSlots(buckets.get(day) ?? [], durationMinutes, overlay),
  }));
}

// ---------- per-duration slot cache ----------

// `/slots` returns ONE PAGE (`horizon_days` of availability) for one duration,
// and serving a page costs a full calendar read on the server. Each page is
// therefore fetched once and kept: toggling 30 → 60 → 30 is two round-trips,
// not three, and "Show more dates" only ever fetches the next page. Entries
// are `{ slots, timezone, pages, hasMore }`, keyed by duration in minutes:
// `slots` is the sorted UNION of the `pages` pages held so far, always page 0
// through `pages - 1` with no gaps, and `hasMore` is whether the server has a
// page after them.

/** The cached entry for `duration`, or null if it has never been fetched. */
export function readSlotCache(cache, duration) {
  return cache.get(duration) ?? null;
}

/** Store an entry as given. `pages`/`hasMore` default to "one page, no more",
 *  which is what a pre-paging shaped entry means. */
export function writeSlotCache(cache, duration, entry) {
  cache.set(duration, { pages: 1, hasMore: false, ...entry });
}

/** Sorted, ms-ordered. Pages are millisecond-exact windows off the server's
 *  `now`, so a local day can straddle two of them: the union must be sorted
 *  before the strip buckets it by date, or the split day's afternoon lands
 *  after the following week. */
function sortedIso(slots) {
  return [...slots].sort((a, b) => Date.parse(a) - Date.parse(b));
}

/** Fold one `/slots` response (`{ slots, timezone, page, has_more }`) into
 *  the entry for `duration`. Only the NEXT page is accepted — page 0 into an
 *  empty entry, page `pages` into one holding `pages` — so a duplicate
 *  response, or one that arrives after the entry was reset, is ignored rather
 *  than doubling the list or leaving a gap. Returns the entry, or null when
 *  the page was not appended. */
export function appendSlotPage(cache, duration, body) {
  const held = cache.get(duration) ?? null;
  const next = held === null ? 0 : held.pages;
  if (body.page !== next) return null;
  const entry = {
    slots: sortedIso([...(held?.slots ?? []), ...(body.slots ?? [])]),
    timezone: typeof body.timezone === "string" ? body.timezone : (held?.timezone ?? "UTC"),
    pages: next + 1,
    hasMore: body.has_more === true,
  };
  cache.set(duration, entry);
  return entry;
}

/** Fold a 409's fresh slot list into the cache. The cached list is now known
 *  to be wrong for the page the response names, so that page is spliced out
 *  and the fresh list put in its place — otherwise the booker who lost the
 *  race is offered the taken slot again on the next duration switch. The
 *  other pages held are kept, as is the reach: a booker who has paged out to
 *  week six must not be thrown back to week one by someone else's booking.
 *
 *  The splice is by the response's own `window` (a half-open [start, end)
 *  span), which was computed off the server's `now` at claim time, not at
 *  fetch time, so it is shifted from the cached page's span by however long
 *  the booker sat on the page. That leaves a sliver of the old page just
 *  before the fresh one; it is stale but harmless — every claim is
 *  re-verified server-side, and the next 409 or refetch clears it. A
 *  response with no window (a server that predates paging) replaces the
 *  whole entry as before.
 *
 *  A response carrying no list leaves nothing worth caching, so the entry is
 *  dropped and the next selection refetches from page 0. Returns the entry's
 *  list after the splice, or null when there was none. */
export function applyConflictSlots(cache, duration, slots, timezone, window) {
  if (!Array.isArray(slots)) {
    cache.delete(duration);
    return null;
  }
  const held = cache.get(duration) ?? null;
  const start = window ? Date.parse(window.start) : Number.NaN;
  const end = window ? Date.parse(window.end) : Number.NaN;
  if (held === null || !Number.isFinite(start) || !Number.isFinite(end)) {
    writeSlotCache(cache, duration, { slots: sortedIso(slots), timezone });
    return slots;
  }
  const kept = held.slots.filter((iso) => {
    const t = Date.parse(iso);
    return t < start || t >= end;
  });
  const merged = sortedIso([...kept, ...slots]);
  cache.set(duration, { ...held, slots: merged, timezone });
  return merged;
}

/** Forget every duration. A booking blocks more than the start it was made on
 *  — a 60-minute booking also kills the 30-minute starts inside it, and the
 *  buffers either side — so no cached list survives one. */
export function clearSlotCache(cache) {
  cache.clear();
}

// ---------- overlay window ----------

/** Headroom past the last offered slot when parsing the booker's .ics.
 *
 *  The list in hand covers ONE duration, and the booker may switch duration
 *  after loading the file: a shorter meeting fits a start later in the last
 *  bookable day than a longer one does. The bound that is identical for every
 *  duration is the last bookable DAY, so a day of slack (doubled, for the hours
 *  that follow the final start) covers every list the page can go on to show. */
export const OVERLAY_HEADROOM_MS = 2 * 86_400_000;

/** Ceiling on the parsed span: the furthest day the config can put a slot on
 *  — the largest `max_horizon_days` it permits (365), since a booker can page
 *  out that far — plus the headroom. Also the span used before any slot list
 *  has arrived, so a file dropped in during the first fetch is still parsed
 *  over everything that fetch, or any later page, could return. */
export const OVERLAY_MAX_SPAN_MS = 367 * 86_400_000;

/** The window to parse the booker's calendar over, derived from the slots the
 *  page is actually offering.
 *
 *  This was a hardcoded 90 days, which silently under-reported for any owner
 *  whose `horizon_days` exceeds it: slots on days 91-120 clashed with nothing,
 *  so a booker who had uploaded their calendar was told they were free when
 *  they were not. Under-reporting busy is the one direction this file must
 *  never take (see the header comment). */
export function overlayWindow(slots, nowMs) {
  let last = nowMs;
  for (const iso of slots) {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms) && ms > last) last = ms;
  }
  const ceiling = nowMs + OVERLAY_MAX_SPAN_MS;
  const toMs = last === nowMs ? ceiling : Math.min(last + OVERLAY_HEADROOM_MS, ceiling);
  return { fromMs: nowMs, toMs };
}

// ---------- confirm pane ----------

/** Whether #confirm must be rebuilt from scratch.
 *
 *  Only when the slot it belongs to changes. The pane holds what the booker has
 *  typed AND a solved Turnstile challenge, and `render()` runs on an overlay
 *  load, a timezone switch and every crossing of the layout breakpoint (a phone
 *  rotation) — rebuilding on any of those threw away the lot and made them
 *  solve the challenge again. Everything in the form that depends on anything
 *  other than the slot is refreshed in place instead.
 *
 *  `null === null` deliberately answers "no": that is the state after a
 *  conflict message has replaced the form, and the message must survive a
 *  resize. */
export function confirmNeedsRebuild(shownFor, selected) {
  return shownFor !== selected;
}

/** The summary line at the top of the confirm form: the last thing the booker
 *  reads before committing, spelled out in full in the zone on screen, because
 *  a misread zone is a missed meeting. Kept separate from the form markup so a
 *  zone switch can refresh it without rebuilding the inputs around it. */
export function confirmWhenText(selectedIso, durationMinutes, viewTz) {
  const when = new Date(selectedIso).toLocaleString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    // isValidTz rather than resolveTz: this runs on every render, and
    // resolveTz's fallback pushes into the shared parse `warnings` array, which
    // belongs to the .ics overlay and is reported to the booker as such.
    timeZone: isValidTz(viewTz) ? viewTz : "UTC",
  });
  return `${when} · ${durationMinutes} min (${viewTz.replace(/_/g, " ")})`;
}

// ---------- Turnstile readiness ----------

/** The global Turnstile calls once its API is ready. `page.ts` names it in the
 *  script URL (`?onload=...&render=explicit`); the two must agree. */
export const TURNSTILE_READY_CALLBACK = "opticalTurnstileReady";

/** Run `cb` once the Turnstile API is usable on `w` (the window).
 *
 *  api.js is `async defer`, so it may execute after this module: a booker on a
 *  slow connection could select a slot while `w.turnstile` was still undefined,
 *  and nothing ever retried — the widget never appeared, the POST carried an
 *  empty token, and the booker got a bare 403 with no challenge on screen to
 *  complete. Either order works now: if the script has already run we call
 *  straight through, otherwise we chain onto the documented onload callback.
 *  Existing registrations are preserved rather than clobbered. */
export function onTurnstileReady(w, cb) {
  if (w.turnstile && typeof w.turnstile.render === "function") {
    cb();
    return;
  }
  const previous = w[TURNSTILE_READY_CALLBACK];
  let fired = false;
  w[TURNSTILE_READY_CALLBACK] = function () {
    if (typeof previous === "function") previous();
    if (fired) return;
    fired = true;
    cb();
  };
}

/** Reset a rendered Turnstile widget so a fresh challenge can be solved.
 *
 *  siteverify tokens are single-use, and the server verifies the token
 *  BEFORE any failure path runs (route.ts), so by the time a non-201 claim
 *  response reaches the browser the solved token is already dead. Without a
 *  reset, retrying resubmits that dead token and 403s again — the booker's
 *  only way out was reselecting the slot or reloading. Mirrors the guards on
 *  `w`/`widgetId` that `removeTurnstile` uses, and — like it — never lets a
 *  missing container or vanished API surface as an unhandled throw. Takes
 *  `w` (the window) as a parameter, like `onTurnstileReady`, so this is
 *  testable without a DOM. Returns whether a reset was actually issued. */
export function resetTurnstile(w, widgetId) {
  if (!widgetId || !w || !w.turnstile || typeof w.turnstile.reset !== "function") return false;
  try {
    w.turnstile.reset(widgetId);
    return true;
  } catch {
    return false;
  }
}

/** Decide what the submit handler should do with a claim attempt's outcome.
 *
 *  `outcome` is either `{ status, body }` from a completed response, or
 *  `{ networkError: true }` when the fetch itself rejected (or the response
 *  body could not be read) — the same dead-end a flaky mobile connection
 *  produces. Every branch other than 201/409 asks for a Turnstile reset: the
 *  token was already consumed by the server's pre-failure verify, so leaving
 *  the widget alone would make every retry fail the same way. */
export function claimOutcome(outcome) {
  if (outcome.networkError) {
    return { kind: "error", message: "Could not reach the server. Please try again.", resetTurnstile: true };
  }
  const { status, body } = outcome;
  if (status === 201) {
    return { kind: "booked" };
  }
  if (status === 409) {
    // A 409 whose recompute failed carries no list at all; applyConflictSlots
    // (called by the handler) drops the cached one so the next selection
    // refetches. The token is still spent here too, but the form is about to
    // be torn down for the "just taken" message, so there is no widget left
    // to reset.
    // `window` names the page the list is for, so the handler splices that
    // page rather than replacing every page the booker has loaded.
    return {
      kind: "conflict",
      slots: body?.slots,
      window: body?.window,
      message: "That time was just taken. Please choose another.",
    };
  }
  return {
    kind: "error",
    message: status === 403 ? "Please complete the verification and try again." : "Something went wrong. Please try again.",
    resetTurnstile: true,
  };
}

/** The zones offered in the timezone `<select>`: the booker's own browser
 *  zone (captured once at page load, so it can never be re-render away),
 *  the owner's zone, and whichever the booker currently has selected —
 *  deduped and filtered to whatever Intl actually accepts.
 *
 *  This used to be built from `[state.viewTz, state.tz]` alone. Once the
 *  booker switched viewTz to the owner's zone, a later re-render (a duration
 *  chip click, an overlay load, a phone rotation) recomputed a one-entry set
 *  and the browser's own zone vanished from the dropdown, with no way back
 *  short of reloading the page. */
export function tzSelectZones(browserZone, ownerTz, viewTz) {
  return [...new Set([browserZone, ownerTz, viewTz])].filter(
    (z) => typeof z === "string" && isValidTz(z),
  );
}

// ---------- Meeting location ----------

/** What, if anything, the chosen meeting type needs from the booker. */
export function locationFieldFor(kind) {
  if (kind === "phone") {
    return { needed: true, label: "Your phone number", type: "tel", placeholder: "" };
  }
  if (kind === "in_person") {
    // No default: in practice the place is agreed out of band, and "TBC" is a
    // perfectly good answer at booking time.
    return { needed: true, label: "Where should we meet?", type: "text", placeholder: "TBC" };
  }
  return { needed: false, label: "", type: "text", placeholder: "" };
}

/** The two claim fields. An empty string would fail the server's "no detail for
 *  a kind that collects none" check, so it is normalised to null here. */
export function locationPayload(kind, raw) {
  const detail = (raw ?? "").trim();
  return { location_kind: kind, location_detail: detail.length > 0 ? detail : null };
}

// ---------- DOM wiring ----------

/** Attribute/text escaping for the fragments built below. Most of what lands
 *  in innerHTML here is machine-generated (ISO instants, IANA zone names), but
 *  it arrives over the wire from a config row someone else owns, so it is
 *  escaped rather than trusted. */
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Wire the server-rendered shell. Kept deliberately thin: every decision
 *  (which slots clash, how many dots a day gets) lives in the pure functions
 *  above, which are unit-tested; this only touches the DOM. */
export function mount(root = document.getElementById("app")) {
  if (!root) return;
  const slug = root.dataset.slug ?? "";
  const durations = (root.dataset.durations ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  const siteKey = root.dataset.sitekey ?? "";
  // Captured once, immutably: viewTz below starts equal to it but is then
  // reassigned as the booker switches zones. Without a separate, untouched
  // copy, tzSelectZones has no way to offer the browser's own zone again
  // once viewTz has moved away from it. See tzSelectZones for the bug this
  // fixes.
  const browserZone = browserTz();
  const state = {
    duration: durations[0] ?? 30,
    slots: [],
    tz: "UTC", // the owner's zone, from the slots response
    viewTz: browserZone, // the zone the booker READS times in
    overlay: [],
    selected: null,
    day: null,
    cache: new Map(), // duration → { slots, timezone }
    // The slot the confirm form currently on screen belongs to, or null when
    // #confirm holds something else (nothing, or a message). Drives
    // confirmNeedsRebuild — see there for why the form is not rebuilt blindly.
    confirmFor: null,
    // Id of the Turnstile widget mounted in #ts, so the old one can be removed
    // before its container is replaced rather than leaked.
    tsWidget: null,
    // Set once a booking succeeds: #confirm is terminal from then on, and no
    // later render may put the form back over the confirmation.
    booked: false,
    // Whether the server has a page of dates beyond the ones on screen for
    // the current duration (drives the strip's "Later →" cell), and whether
    // that next page is being fetched right now.
    hasMore: false,
    loadingMore: false,
  };

  // The breakpoint from page.ts's media query. Which layout to draw is a DOM
  // decision, not a CSS one — the two arrangements are different markup, not
  // one arrangement restyled — so the value is matched here rather than
  // rendering both and hiding one.
  const narrow = window.matchMedia("(max-width:720px)");

  const $ = (id) => document.getElementById(id);

  async function loadSlots() {
    const requested = state.duration;
    const cached = readSlotCache(state.cache, requested);
    if (cached !== null) {
      show(cached);
      return;
    }
    const entry = await fetchPage(requested, 0);
    // Another chip was clicked while this was in flight: the payload is
    // still worth caching, but the screen now belongs to the newer duration.
    if (entry === null || requested !== state.duration) return;
    show(entry);
  }

  /** "Show more dates": fetch the page after the ones held for the current
   *  duration and redraw with the union. One page per press — each is a
   *  calendar read on the server, so nothing here prefetches. */
  async function loadMore() {
    const requested = state.duration;
    const held = readSlotCache(state.cache, requested);
    if (held === null || !held.hasMore || state.loadingMore) return;
    state.loadingMore = true;
    render(); // disables the button while the fetch is out
    try {
      const entry = await fetchPage(requested, held.pages);
      if (entry === null || requested !== state.duration) return;
      show(entry);
    } finally {
      state.loadingMore = false;
      render();
    }
  }

  /** GET one page of `/slots` and fold it into the cache. Returns the entry
   *  it produced, or null on any failure (already reported on #tzline). */
  async function fetchPage(duration, page) {
    try {
      const res = await fetch(
        `/book/${encodeURIComponent(slug)}/slots?duration=${duration}&page=${page}`,
      );
      if (!res.ok) {
        $("tzline").textContent = "Availability is unavailable right now.";
        return null;
      }
      const body = await res.json();
      // A response that is not the next page (see appendSlotPage) is dropped;
      // whatever the cache holds is still right, so show that.
      return appendSlotPage(state.cache, duration, body) ?? readSlotCache(state.cache, duration);
    } catch {
      // Network failure, or a response body that was not valid JSON. Without
      // this the page is left on "Loading availability…" forever with no way
      // to recover short of a reload.
      $("tzline").textContent = "Availability is unavailable right now.";
      return null;
    }
  }

  function show(entry) {
    state.slots = entry.slots;
    state.tz = entry.timezone;
    state.hasMore = entry.hasMore === true;
    fillTzOptions();
    render();
  }

  /** The booker's own zone, the owner's, and whichever is currently
   *  selected — see tzSelectZones for why all three are needed rather than
   *  just the latter two. */
  function fillTzOptions() {
    const sel = $("tzsel");
    if (!sel) return;
    const zones = tzSelectZones(browserZone, state.tz, state.viewTz);
    sel.innerHTML = zones
      .map(
        (z) =>
          `<option value="${esc(z)}"${z === state.viewTz ? " selected" : ""}>` +
          `${esc(z.replace(/_/g, " "))}</option>`,
      )
      .join("");
  }

  function render() {
    // Grouping follows the SELECTED zone, not the machine's: a booker who has
    // switched zones must see each slot filed under the day it falls on THERE.
    // Bucketing once (rather than formatting per slot) keeps a three-week grid
    // off the ~160 ms Intl path.
    const buckets = bucketSlotsByLocalDate(state.slots, state.viewTz);
    const days = stripDays(buckets);
    if (!state.day || !days.includes(state.day)) state.day = days[0] ?? null;

    $("tzline").textContent = state.slots.length === 0
      // With more pages on the server, an empty page is not "nothing at all":
      // the strip still offers "Later →", and the line must not contradict it.
      ? (state.hasMore ? "No times in this range — try later dates." : "No times are currently available.")
      : `${state.duration} min · times shown in ${state.viewTz.replace(/_/g, " ")}`;

    // One formatter per render, reused across every cell. The weekday label is
    // read off the date KEY, so it is formatted in UTC against that key's noon
    // — formatting it in viewTz would roll far-eastern zones onto the next day.
    const wdFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" });
    const dayCell = (d) => {
      const n = dotCount(d, buckets, state.duration, state.overlay, state.viewTz);
      const date = new Date(`${d}T12:00:00Z`);
      return (
        `<button class="dcell${n === 0 ? " empty" : ""}" type="button" data-day="${esc(d)}" ` +
        `aria-pressed="${d === state.day}">` +
        `<div class="dwd">${esc(wdFmt.format(date))}</div>` +
        `<div class="dnum">${Number(d.slice(8, 10))}</div>` +
        `<div class="dots">${'<i class="dot"></i>'.repeat(n)}</div></button>`
      );
    };
    // One group per month, each headed by a label that sticks to the strip's
    // left edge while the group is in view (see stripMonths), so a booker
    // scrolled deep into a long reach can always tell which month "1 2 5 6"
    // are in.
    const months = stripMonths(days);
    $("strip").innerHTML = months
      .map(
        (g) =>
          `<div class="mgroup"><div class="mlabel">${esc(monthLabel(g.month, months[0].month))}</div>` +
          `<div class="mdays">${g.days.map(dayCell).join("")}</div></div>`,
      )
      .join("") + moreButton();

    const timeFmt = new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: state.viewTz,
    });

    $("slots").innerHTML = narrow.matches ? dayList(buckets, timeFmt) : weekGrid(buckets, timeFmt, wdFmt);

    renderConfirm();
  }

  /** Draw #confirm, preserving a form the booker is already filling in.
   *
   *  render() runs on an overlay load, a timezone switch and every crossing of
   *  the layout breakpoint, none of which change WHICH slot is selected — so
   *  rebuilding the form on them would wipe the name, email and note typed into
   *  it and force the challenge to be solved again. The summary line is the
   *  only part that depends on anything but the slot, so it is refreshed in
   *  place instead. */
  function renderConfirm() {
    const box = $("confirm");
    if (!box || state.booked) return;
    if (!confirmNeedsRebuild(state.confirmFor, state.selected)) {
      const line = box.querySelector("#bookwhen");
      if (line && state.selected) {
        line.textContent = confirmWhenText(state.selected, state.duration, state.viewTz);
      }
      return;
    }
    // The container is about to be replaced, so the widget inside it has to go
    // first — dropping it with innerHTML leaks the challenge's own state.
    removeTurnstile();
    box.innerHTML = state.selected ? confirmForm() : "";
    state.confirmFor = state.selected;
    drawLocationDetail();
    renderTurnstile();
  }

  /** Replace the form with a terminal message (booked, or lost the race). */
  function showConfirmMessage(html) {
    removeTurnstile();
    const box = $("confirm");
    if (box) box.innerHTML = html;
    state.confirmFor = null;
  }

  function removeTurnstile() {
    const id = state.tsWidget;
    state.tsWidget = null;
    if (!id) return;
    try {
      window.turnstile.remove(id);
    } catch {
      // Already gone with its container, or the API vanished — nothing to undo.
    }
  }

  /** Put the challenge in the form, or leave a marker until api.js arrives.
   *  Safe to call repeatedly: a widget is only ever rendered once per form. */
  function renderTurnstile() {
    if (!state.selected || !siteKey || state.tsWidget !== null) return;
    const holder = $("ts");
    if (!holder) return;
    if (!window.turnstile || typeof window.turnstile.render !== "function") {
      // onTurnstileReady (registered below) comes back here once it loads.
      holder.textContent = "Loading verification…";
      return;
    }
    holder.textContent = "";
    // `render` returns undefined if the container already holds a widget;
    // "" still reads as "rendered" to the guard above, with nothing to remove.
    state.tsWidget = window.turnstile.render("#ts", { sitekey: siteKey }) ?? "";
  }

  /** The strip's trailing "Show more dates" cell, present only while the
   *  server has a page beyond the ones held. Lives in the strip because the
   *  strip is the only day picker at both widths, so it is where a booker
   *  looking for a later day already is. Disabled, not removed, while a page
   *  is in flight — the strip must not reflow under the pointer. */
  function moreButton() {
    if (!state.hasMore) return "";
    return (
      `<button class="dcell more" type="button" id="more"${state.loadingMore ? " disabled" : ""}>` +
      `<div class="dwd">${state.loadingMore ? "Loading" : "Later"}</div>` +
      `<div class="dnum">&rarr;</div><div class="dots"></div></button>`
    );
  }

  /** `placement` is an already-built attribute fragment (empty in the narrow
   *  layout, a grid position in the wide one). */
  function slotButton(m, timeFmt, placement) {
    return (
      `<button class="slot${m.clashes ? " clash" : ""}" type="button" data-iso="${esc(m.iso)}" ` +
      `aria-pressed="${m.iso === state.selected}"${placement}>${esc(timeFmt.format(new Date(m.iso)))}</button>`
    );
  }

  const at = (col, row) => `style="grid-column:${col};grid-row:${row}"`;

  /** Narrow layout: the day the strip has selected, wrapped so the cells fill
   *  the width. The media query overrides the column count on this grid. */
  function dayList(buckets, timeFmt) {
    const marked = filterSlots(
      state.day === null ? [] : (buckets.get(state.day) ?? []),
      state.duration,
      state.overlay,
    );
    if (marked.length === 0) return `<p class="muted">No times available on this day.</p>`;
    return (
      `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(92px,1fr))">` +
      marked.map((m) => slotButton(m, timeFmt, "")).join("") +
      `</div>`
    );
  }

  /** Wide layout: a column per day of the selected day's week. Every cell is
   *  placed explicitly rather than left to auto-flow — a day with fewer slots
   *  must leave the space below it empty instead of letting the next day's
   *  times ride up into the gap and sit under the wrong heading. */
  function weekGrid(buckets, timeFmt, wdFmt) {
    const cols = weekColumns(state.day, buckets, state.duration, state.overlay);
    if (cols.length === 0) return `<p class="muted">No times are currently available.</p>`;
    const cells = [];
    cols.forEach((col, i) => {
      const date = new Date(`${col.day}T12:00:00Z`);
      cells.push(`<div class="colh" ${at(i + 1, 1)}>${esc(wdFmt.format(date))} ${Number(col.day.slice(8, 10))}</div>`);
      if (col.slots.length === 0) {
        cells.push(`<div class="none" ${at(i + 1, 2)} title="No availability"></div>`);
        return;
      }
      col.slots.forEach((m, row) => cells.push(slotButton(m, timeFmt, ` ${at(i + 1, row + 2)}`)));
    });
    return `<div class="grid" style="grid-template-columns:repeat(7,1fr)">${cells.join("")}</div>`;
  }

  function confirmForm() {
    // The summary line carries an id so a zone switch can rewrite it without
    // rebuilding the inputs below it. The location picker is rendered
    // server-side into a <template> (page.ts/route.ts) so the owner's custom
    // text goes through the server's HTML escaping rather than a second path
    // via a JSON data attribute; that template does not exist on every page
    // (no locations configured), hence the guard.
    const loctpl = document.getElementById("loctpl");
    const locHtml = loctpl ? loctpl.innerHTML : "";
    return (
      `<form id="bookform"><div class="msg" id="bookwhen">` +
      `${esc(confirmWhenText(state.selected, state.duration, state.viewTz))}</div>` +
      `<label for="name">Your name</label><input type="text" id="name" required maxlength="120">` +
      `<label for="email">Your email</label><input type="email" id="email" required>` +
      locHtml +
      `<div id="locdetail"></div>` +
      `<label for="note">Anything I should know? (optional)</label><textarea id="note" rows="3" maxlength="2000"></textarea>` +
      `<div id="ts"></div><button class="go" type="submit">Confirm booking</button><div id="result"></div></form>`
    );
  }

  /** Which location kind is currently selected: the checked radio if the
   *  server rendered a group, the single fixed kind if it rendered exactly
   *  one option with nothing to choose between, or "meet" as the fallback
   *  when no picker exists on the page at all (no locations configured). */
  function selectedLocationKind() {
    const checked = document.querySelector('input[name="location_kind"]:checked');
    if (checked) return checked.value;
    const single = document.querySelector(".locpick[data-single]");
    return single ? single.dataset.single : "meet";
  }

  /** Redraw the field asking for whatever the selected kind collects (a
   *  phone number, a place) — or nothing, when it collects nothing. */
  function drawLocationDetail() {
    const box = $("locdetail");
    if (!box) return;
    const field = locationFieldFor(selectedLocationKind());
    box.innerHTML = field.needed
      ? `<label for="locinput">${esc(field.label)}</label>` +
        `<input type="${esc(field.type)}" id="locinput" required maxlength="200"` +
        (field.placeholder ? ` placeholder="${esc(field.placeholder)}"` : "") +
        `>`
      : "";
  }

  document.addEventListener("click", async (e) => {
    if (!(e.target instanceof Element)) return;
    const chip = e.target.closest(".chip");
    if (chip) {
      state.duration = Number(chip.dataset.duration);
      state.selected = null;
      for (const c of document.querySelectorAll(".chip")) c.setAttribute("aria-pressed", String(c === chip));
      await loadSlots();
      return;
    }
    // Before `.dcell`: the more-button shares that class for its styling.
    if (e.target.closest("#more")) {
      await loadMore();
      return;
    }
    const day = e.target.closest(".dcell");
    if (day) {
      state.day = day.dataset.day;
      state.selected = null;
      render();
      return;
    }
    const slot = e.target.closest(".slot");
    if (slot) {
      state.selected = slot.dataset.iso;
      render();
    }
  });

  document.addEventListener("change", async (e) => {
    if (e.target.name === "location_kind") {
      drawLocationDetail();
      return;
    }
    if (e.target.id === "tzsel") {
      // Ignore a zone Intl would reject: everything downstream formats against
      // it, and a throw here would leave the grid frozen on the old zone.
      if (!isValidTz(e.target.value)) return;
      state.viewTz = e.target.value;
      render();
      return;
    }
    if (e.target.id !== "overlay") return;
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    // Derived from what this page actually offers, not a constant: an owner
    // with horizon_days past the old hardcoded 90 published slots that clashed
    // with nothing, which reads to the booker as free time they do not have.
    state.overlay = parseIcsBusy(text, overlayWindow(state.slots, Date.now()));
    // Parsed in the browser; the file is never uploaded.
    // Warnings are surfaced, not swallowed: a file we only half-read shows
    // fewer busy blocks, which silently reads as "free all week".
    $("overlay-state").textContent = overlayStatusText(stats, warnings);
    if (warnings.length > 0) $("overlay-state").title = warnings.join("\n");
    render();
  });

  document.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.querySelector("button.go");
    if (btn) btn.disabled = true;
    let outcome;
    try {
      const res = await fetch(`/book/${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          start: state.selected,
          duration_minutes: state.duration,
          name: $("name").value,
          email: $("email").value,
          note: $("note").value || null,
          ...locationPayload(selectedLocationKind(), $("locinput") ? $("locinput").value : ""),
          turnstile_token: document.querySelector('[name="cf-turnstile-response"]')?.value ?? "",
        }),
      });
      const body = await res.json().catch(() => ({}));
      outcome = { status: res.status, body };
    } catch {
      // A rejected fetch (flaky mobile) used to leave the button disabled
      // forever with no message and no re-enable. Treat it the same as a
      // failed claim: it is one, just without a status code.
      outcome = { networkError: true };
    }
    const decision = claimOutcome(outcome);
    if (decision.kind === "booked") {
      // Every cached list still offers the slot just taken — and, for the
      // longer durations, the ones it now overlaps.
      clearSlotCache(state.cache);
      state.booked = true;
      showConfirmMessage(`<div class="msg">Booked. A calendar invitation is on its way to your inbox.</div>`);
      return;
    }
    if (btn) btn.disabled = false;
    if (decision.resetTurnstile) {
      // The token siteverify just consumed (or, on a network failure, the
      // one from an earlier attempt) cannot be resubmitted — a solved widget
      // with a dead token behind it would just 403 again on retry.
      resetTurnstile(window, state.tsWidget);
    }
    if (decision.kind === "conflict") {
      const fresh = applyConflictSlots(state.cache, state.duration, decision.slots, state.tz, decision.window);
      if (fresh !== null) state.slots = fresh;
      state.selected = null;
      render();
      showConfirmMessage(`<div class="msg">${decision.message}</div>`);
      return;
    }
    $("result").innerHTML = `<div class="msg">${decision.message}</div>`;
  });

  // Crossing the breakpoint swaps the layout, not just its styling, so the
  // markup has to be rebuilt.
  narrow.addEventListener("change", render);

  // api.js is `async defer` and may execute after this module. Register before
  // the first paint so a slot selected during the wait still gets a widget.
  onTurnstileReady(window, renderTurnstile);

  loadSlots();
}

// Guarded so importing this module under vitest (no DOM) does not execute it.
if (typeof document !== "undefined") mount();
