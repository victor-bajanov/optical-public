// Browser-side module for the public invitee-facing meeting-poll page. Plain
// ESM — no build step, no TypeScript: this file is served verbatim as a
// static asset and executed unbundled by the invitee's browser.
//
// DUPLICATION NOTICE: the ICS parser (parseIcsBusy and its RFC 5545 helpers)
// and the timezone/day-bucketing helpers below (through the "END DUPLICATED
// SECTION" marker) are copied VERBATIM from
// worker/src/booking/booking.client.js. Both booking.client.js and this file
// ship unbundled to the browser with no build step, so there is no way to
// share a module between them without introducing one — see
// internal design notes §2.6 for
// why the duplication is an explicit, accepted decision rather than an
// oversight. worker/test/polls/client-parity.test.ts runs the same fixture
// corpus booking's ics-fixtures.test.ts uses through BOTH copies of
// parseIcsBusy and asserts identical output, so the two cannot silently
// drift apart. If you are editing parser/bucketing behaviour, change BOTH
// files and re-run that test.
//
// PRIVACY: an invitee may load their own .ics calendar to pre-paint their
// working hours. That file is parsed HERE, in their browser, and never
// leaves it. Nothing in this module performs network I/O other than the
// poll's own grid/response endpoints — do not add any.

/** Warnings from the most recent parseIcsBusy() call. Cleared at the start of
 *  each parse; the array identity is stable so consumers may hold a reference. */
export const warnings = [];

/** Counts from the most recent parseIcsBusy() call. Object identity is stable
 *  so consumers may hold a reference. */
export const stats = { events: 0, blocks: 0 };

/** Most instances a single RRULE may expand to. */
export const MAX_RULE_INSTANCES = 3700;
/** Most instances one parse may produce across every VEVENT combined. */
export const MAX_TOTAL_INSTANCES = 20_000;
/** Wall-clock budget for one parse. */
export const PARSE_BUDGET_MS = 2_000;
/** Largest .ics we will even attempt. */
export const MAX_ICS_CHARS = 5_000_000;

// ---------- timezone formatters ----------

const fmtCache = new Map();
const unknownTzids = new Set();
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

function wallTimeInTzToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
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
  let instant = guess;
  for (let i = 0; i < 2; i += 1) {
    const tp = tzParts(instant);
    const tpUtc = Date.UTC(tp.y, tp.mo - 1, tp.d, tp.h, tp.mi, tp.s);
    const offset = tpUtc - instant;
    instant = guess - offset;
  }
  return instant;
}

function utcToWallParts(ms, tz) {
  const fmt = tzFormatter(tz, "wall", WALL_PARTS_OPTS);
  const parts = {};
  for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
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

export function toUtcMs(value, tzid, defaultTz) {
  if (value.endsWith("Z")) {
    return { ms: parseIcsLiteralUtc(value), allDay: false };
  }
  if (value.length === 8) {
    const ymd = parseIcsDate(value);
    const tz = resolveTz(tzid ?? defaultTz, defaultTz);
    return { ms: wallTimeInTzToUtc(ymd.y, ymd.mo, ymd.d, 0, 0, 0, tz), allDay: true };
  }
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
    if (rule.UNTIL.endsWith("Z")) {
      until = parseIcsLiteralUtc(rule.UNTIL);
    } else if (rule.UNTIL.length === 8) {
      const ymd = parseIcsDate(rule.UNTIL);
      until = Date.UTC(ymd.y, ymd.mo - 1, ymd.d, 23, 59, 59);
    }
  }

  const useWallClock = tzid !== null && tzid !== undefined && tzid !== "UTC";
  const projTz = resolveTz(useWallClock ? tzid : defaultTz, defaultTz);
  const stepMs = (freq === "DAILY" ? 1 : 7) * 24 * 60 * 60 * 1000 * interval;
  const stepDays = (freq === "DAILY" ? 1 : 7) * interval;

  const target = fromMs - duration;
  let ordinal = 0;
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
  let steps = 0;
  for (;;) {
    if (count !== undefined && ordinal >= count) break;
    if (until !== undefined && t > until) break;
    if (t >= toMs) break;
    const endT = t + duration;
    if (endT > fromMs) instances.push({ s: t, e: endT });
    ordinal += 1;
    steps += 1;
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
    warn(
      `Calendar file is too large to read (${Math.round(source.length / 1e6)} MB, ` +
        `limit ${Math.round(MAX_ICS_CHARS / 1e6)} MB); no availability was loaded from it`,
    );
    return [];
  }

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
        if (transp === "TRANSPARENT" || status === "CANCELLED") continue;
        if (dtstart === null) {
          warn("VEVENT missing DTSTART");
          continue;
        }
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
          if (exdates !== null && exdates.has(inst.s)) continue;
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
    warn(
      "Calendar was too large to read fully; later events were skipped and " +
        "may not be shown as busy",
    );
  }

  const merged = mergeBusy(busy);
  stats.blocks = merged.length;
  return merged;
}

// ---------- day/week bucketing + tz-select helpers ----------

function localDate(iso, tz) {
  return tzFormatter(resolveTz(tz, "UTC"), "date", LOCAL_DATE_OPTS).format(new Date(iso));
}

/** Group cell ISO strings by their LOCAL calendar date. Same idiom as
 *  booking.client.js's slot bucketing — bucket once rather than formatting
 *  per cell on every render. */
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

/** The seven LOCAL date keys of the calendar week (Monday first) containing
 *  `isoDate`. Feeds weekColumns() below — the week grid (M2) groups a day's
 *  cells into a column, and this is what decides which seven columns are on
 *  screen at once. */
export function weekOf(isoDate) {
  const noon = Date.parse(`${isoDate}T12:00:00Z`);
  const mondayOffset = (new Date(noon).getUTCDay() + 6) % 7;
  const monday = noon - mondayOffset * 86_400_000;
  return Array.from({ length: 7 }, (_, i) =>
    new Date(monday + i * 86_400_000).toISOString().slice(0, 10),
  );
}

/** Columns for the week grid (M2): one per day of the calendar week
 *  (Monday first) containing `anchorDay`, each holding that day's
 *  already-bucketed cells in chronological order. An empty `cells` array is
 *  a day with nothing paintable — rendered as its own (empty) column rather
 *  than omitted, so the week's shape stays stable as cells are painted.
 *
 *  Deliberately does NOT try to align rows across columns by a shared time
 *  axis: each column's row count is exactly `bucket.get(day)?.length`,
 *  never an assumed 48 — a DST-short/long day, or a day with a narrower
 *  bookable window than its neighbours, legitimately has a different
 *  number of rows, and this must show that rather than paper over it. */
export function weekColumns(anchorDay, buckets) {
  if (anchorDay === null || anchorDay === undefined) return [];
  return weekOf(anchorDay).map((day) => ({ day, cells: buckets.get(day) ?? [] }));
}

/** The Monday key of the calendar week containing `day`, or null when there
 *  is no day to anchor on. Shared by prevWeekAnchor/nextWeekAnchor below. */
function weekStartOf(day) {
  return day === null || day === undefined ? null : weekOf(day)[0];
}

/** Week pagination (M2): the latest entry in `days` (sorted ascending, the
 *  same order bucketSlotsByLocalDate's keys already come in) that falls in
 *  a calendar week EARLIER than the one containing `anchorDay` — i.e. what
 *  clicking "previous week" should jump the grid's anchor to. Null when
 *  `anchorDay`'s week is already the earliest one `days` covers (no
 *  pagination target — the caller omits the button entirely rather than
 *  relying on `disabled` semantics the fake/real DOM might not agree on). */
export function prevWeekAnchor(days, anchorDay) {
  const curStart = weekStartOf(anchorDay);
  if (curStart === null) return null;
  let best = null;
  for (const d of days) {
    if (d < curStart) best = d; // ascending input: the last hit is the closest one
  }
  return best;
}

/** Symmetric to prevWeekAnchor: the earliest entry in `days` that falls in
 *  a calendar week LATER than `anchorDay`'s. Null at the range boundary. */
export function nextWeekAnchor(days, anchorDay) {
  const curStart = weekStartOf(anchorDay);
  if (curStart === null) return null;
  const curEnd = weekOf(anchorDay)[6];
  for (const d of days) {
    if (d > curEnd) return d; // ascending input: the first hit is the closest one
  }
  return null;
}

/** A short, curated list of globally-recognisable IANA zones offered in the
 *  poll timezone selector alongside the viewer's own zone and the
 *  organiser's zone (M3) — picked for broad name recognition, not
 *  completeness. Exported so it can be asserted against directly rather than
 *  hardcoded a second time in tests. */
export const COMMON_TZ_ZONES = [
  "UTC",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Australia/Sydney",
];

/** The zones offered in the timezone `<select>`: the invitee's own browser
 *  zone, the poll's organiser zone (M3 — the grid payload's top-level
 *  `ownerTz`, `undefined` on an older payload or a poll with none), and
 *  whichever they currently have selected, plus a short common-zone list —
 *  deduped and filtered to whatever Intl actually accepts. Same idiom as
 *  booking.client.js's tzSelectZones, extended with the common-zone list
 *  polls need because (unlike a single booking page) a poll's invitees may
 *  be scattered across zones none of them chose. */
export function tzSelectZones(browserZone, ownerTz, viewTz) {
  return [...new Set([browserZone, ownerTz, viewTz, ...COMMON_TZ_ZONES])].filter(
    (z) => typeof z === "string" && isValidTz(z),
  );
}

// ---------------------------------------------------------------------------
// END DUPLICATED SECTION — everything below is poll-specific, not copied
// from booking.client.js.
// ---------------------------------------------------------------------------

/** Single source of truth on the client for the cell granularity, but only
 *  as a DEFAULT: the server (worker/src/polls/grid.ts CELL_MINUTES) is the
 *  real source of truth, and this file must read the bootstrap value rather
 *  than assume it never changes (plan §5). */
const DEFAULT_CELL_MINUTES = 30;

/** Read the page shell's bootstrap from `#app`'s data- attributes. Pure over
 *  anything with a `dataset`, so it is testable without a DOM. The shell
 *  cannot use an inline `<script>` — the page's CSP is `script-src 'self'`
 *  with no inline allowance — so the values travel as attributes, exactly as
 *  the booking page's client reads `root.dataset.slug` etc. Dataset values
 *  are always plain strings (the browser never interprets them as markup),
 *  so no escaping happens here — that is the renderer's job, not the
 *  reader's. */
export function readBootstrap(root) {
  const ds = root && typeof root === "object" ? root.dataset : undefined;
  if (!ds || typeof ds !== "object") {
    return { id: null, token: null, cellMinutes: DEFAULT_CELL_MINUTES };
  }
  const cellMinutes = Number(ds.cellMinutes);
  return {
    id: typeof ds.pollId === "string" && ds.pollId.length > 0 ? ds.pollId : null,
    token: typeof ds.token === "string" && ds.token.length > 0 ? ds.token : null,
    cellMinutes: Number.isFinite(cellMinutes) && cellMinutes > 0 ? cellMinutes : DEFAULT_CELL_MINUTES,
  };
}

/** Whether a cell may be painted at all — only cells the server marked as
 *  paintable (the organiser's live bookable region) respond to drag/erase. */
export function isPaintable(cellIso, paintableSet) {
  return paintableSet.has(cellIso);
}

/** What a drag stroke should do to every cell it crosses, decided once from
 *  the anchor cell (the one under pointerdown): an unpainted anchor paints
 *  with the active tool; an already-painted anchor erases, regardless of
 *  which tool is active — mirroring the tools-branch grid.js toggle idiom
 *  but fixing the mode for the whole stroke rather than per-cell, so a drag
 *  that crosses cells in different states does not flip back and forth.
 *  Returns the paint value to apply ("free"|"if_needed"), or null to erase. */
export function strokeMode(anchorCellState, activeTool) {
  return anchorCellState ? null : activeTool;
}

/** Split an .ics document's VEVENTs into two documents by STATUS: those
 *  marked STATUS:TENTATIVE, and everything else (including no STATUS at
 *  all, which RFC 5545 defaults to CONFIRMED). Each half is then fed
 *  through the UNMODIFIED parseIcsBusy above, so the pre-paint rule below
 *  never touches the parity-locked parser itself — only which VEVENT text
 *  reaches it. Splitting is done on already-unfolded lines so a STATUS
 *  property folded across two lines is still recognised. */
export function splitIcsByStatus(text) {
  const lines = unfoldLines(String(text));
  const confirmed = [];
  const tentative = [];
  let block = [];
  let inEvent = false;
  let isTentative = false;
  // Depth of BEGIN:*/END:* blocks nested INSIDE the current VEVENT (VALARM
  // is the common case). A STATUS property only describes the VEVENT itself
  // at depth 0 — a STATUS inside a nested VALARM describes the alarm, not
  // the event, and must not flip the whole event to tentative.
  let nestDepth = 0;

  for (const line of lines) {
    if (!inEvent) {
      if (line === "BEGIN:VEVENT") {
        inEvent = true;
        isTentative = false;
        nestDepth = 0;
        block = [line];
      }
      continue;
    }
    block.push(line);
    if (line === "END:VEVENT" && nestDepth === 0) {
      inEvent = false;
      const target = isTentative ? tentative : confirmed;
      target.push(...block);
      block = [];
      continue;
    }
    if (line.startsWith("BEGIN:") && line !== "BEGIN:VEVENT") {
      nestDepth += 1;
      continue;
    }
    if (line.startsWith("END:") && line !== "END:VEVENT") {
      nestDepth = Math.max(0, nestDepth - 1);
      continue;
    }
    if (nestDepth === 0 && line.toUpperCase().startsWith("STATUS")) {
      try {
        const prop = parseProperty(line);
        if (prop.name === "STATUS" && prop.value.trim().toUpperCase() === "TENTATIVE") {
          isTentative = true;
        }
      } catch {
        // Malformed STATUS line: leave isTentative alone, parseIcsBusy
        // will surface the same malformed property itself.
      }
    }
    // Outside any VEVENT (VCALENDAR/VTIMEZONE wrapper lines): parseIcsBusy
    // ignores everything outside BEGIN:VEVENT/END:VEVENT, so those lines
    // don't need to be duplicated into both halves at all — handled above
    // by the `!inEvent` branch's `continue`.
  }

  return { confirmedText: confirmed.join("\r\n"), tentativeText: tentative.join("\r\n") };
}

function cellOverlapsAny(cellStartIso, cellMinutes, intervals) {
  const s = Date.parse(cellStartIso);
  const e = s + cellMinutes * 60_000;
  return intervals.some((iv) => iv.s < e && iv.e > s);
}

/** The pre-paint rule (plan §T6 item 5): a paintable cell not overlapped by
 *  ANY busy time (confirmed or tentative) pre-paints free; a cell overlapped
 *  ONLY by tentative busy pre-paints if_needed; a cell overlapped by
 *  confirmed busy (whether or not it is also tentative) is left out of the
 *  map entirely — the caller must not paint it. Returns a fresh Map, cell
 *  ISO -> "free"|"if_needed", containing only cells from `paintableCells`. */
export function prePaintFromIcs(paintableCells, cellMinutes, confirmedBusy, tentativeBusy) {
  const out = new Map();
  for (const cell of paintableCells) {
    if (cellOverlapsAny(cell, cellMinutes, confirmedBusy)) continue;
    out.set(cell, cellOverlapsAny(cell, cellMinutes, tentativeBusy) ? "if_needed" : "free");
  }
  return out;
}

/** Merge ICS-derived suggestions into the invitee's current paint, WITHOUT
 *  ever overwriting a cell they already painted this session — the
 *  "busy-never-clobbers-paint" rule carried over from the tools-branch
 *  reference (see the design doc's prior-art section). Returns a new Map;
 *  neither input is mutated. */
export function applyPrePaint(currentPaint, prePaint) {
  const merged = new Map(currentPaint);
  for (const [cell, state] of prePaint) {
    if (!merged.has(cell)) merged.set(cell, state);
  }
  return merged;
}

/** End-to-end ICS pre-paint: split by STATUS, parse each half with the
 *  parity-locked parser, derive the pre-paint suggestions, and merge them
 *  into the current paint without clobbering it. This is what the file-input
 *  change handler calls. */
export function computeIcsPrePaint(text, paintableCells, cellMinutes, currentPaint, windowOpts) {
  const source = String(text);
  if (source.length > MAX_ICS_CHARS) {
    // Checked here, not just inside parseIcsBusy: splitIcsByStatus unfolds
    // the WHOLE document before either half is parsed, and the per-half
    // checks downstream would let a file twice the limit through in two
    // pieces (each half individually under the cap). Returning the current
    // paint unchanged is the right failure mode — the ICS upload is an
    // accelerator, never a source of truth.
    warnings.length = 0;
    warnings.push(
      `Calendar file is too large to read (${Math.round(source.length / 1e6)} MB, ` +
        `limit ${Math.round(MAX_ICS_CHARS / 1e6)} MB); no availability was loaded from it`,
    );
    stats.events = 0;
    stats.blocks = 0;
    return new Map(currentPaint);
  }
  const { confirmedText, tentativeText } = splitIcsByStatus(source);
  const confirmedBusy = parseIcsBusy(confirmedText, windowOpts);
  const confirmedWarnings = warnings.slice();
  const confirmedStats = { events: stats.events, blocks: stats.blocks };
  const tentativeBusy = parseIcsBusy(tentativeText, windowOpts);
  // parseIcsBusy resets both module globals on entry, so without this the
  // CONFIRMED half's diagnostics are silently destroyed by the TENTATIVE
  // pass — which is usually the empty, warning-free half, leaving nothing.
  warnings.unshift(...confirmedWarnings);
  stats.events += confirmedStats.events;
  stats.blocks += confirmedStats.blocks;
  const pre = prePaintFromIcs(paintableCells, cellMinutes, confirmedBusy, tentativeBusy);
  return applyPrePaint(currentPaint, pre);
}

/** Per-cell heatmap intensity in [0,1]: free counts as a full respondent,
 *  if_needed as half (plan §T6 item 4). Normalised against the total invited
 *  (not just responded) so the shade reflects "how much of the group",
 *  filling in gradually as votes arrive rather than jumping once everyone
 *  has answered. Clamped defensively — an aggregate should never exceed the
 *  invitee count, but a clamp costs nothing and avoids a >1 CSS value. */
export function cellIntensity(cellAggregate, totalInvitees) {
  if (!Number.isFinite(totalInvitees) || totalInvitees <= 0) return 0;
  const free = Number.isFinite(cellAggregate?.free) ? cellAggregate.free : 0;
  const ifNeeded = Number.isFinite(cellAggregate?.ifNeeded) ? cellAggregate.ifNeeded : 0;
  const weight = free * 1.0 + ifNeeded * 0.5;
  return Math.max(0, Math.min(1, weight / totalInvitees));
}

/** The cell's hover/tap tooltip (decision D3 / M1). When the grid payload
 *  carries per-cell viewer-appropriate labels (`freeWho`/`ifNeededWho` —
 *  real name or pseudonym, via the server's hidden->pseudonym rule), builds
 *  "Free: A, B · If needed: C" from whichever of the two lists is non-empty.
 *  An empty list just drops its segment; if every segment drops, the return
 *  is "" and the caller omits the title attribute entirely.
 *
 *  Defensive against an older payload with neither field (T11's server half
 *  of this contract may not have shipped, or the poll predates it): falls
 *  back to the previous counts-only summary rather than showing an empty
 *  tooltip. Presence of `freeWho` or `ifNeededWho` as an array (even empty)
 *  is what selects "new" behaviour — an aggregate with counts but no arrays
 *  at all is the "old" shape. */
export function buildCellTitle(agg) {
  const hasNamedLabels = Array.isArray(agg?.freeWho) || Array.isArray(agg?.ifNeededWho);
  if (!hasNamedLabels) {
    const free = Number.isFinite(agg?.free) ? agg.free : 0;
    const ifNeeded = Number.isFinite(agg?.ifNeeded) ? agg.ifNeeded : 0;
    return `${free} free, ${ifNeeded} if needed`;
  }
  const freeWho = Array.isArray(agg?.freeWho) ? agg.freeWho : [];
  const ifNeededWho = Array.isArray(agg?.ifNeededWho) ? agg.ifNeededWho : [];
  const segments = [];
  if (freeWho.length > 0) segments.push(`Free: ${freeWho.join(", ")}`);
  if (ifNeededWho.length > 0) segments.push(`If needed: ${ifNeededWho.join(", ")}`);
  return segments.join(" · ");
}

/** Build the PUT /poll/:id/response body from the in-memory paint map, per
 *  the fixed grid-endpoint contract (plan §5): `{cells, hideName, name}`. */
export function buildResponsePayload(paintMap, hideName, name) {
  const cells = [];
  for (const [cell, state] of paintMap) cells.push({ cell, state });
  return { cells, hideName: Boolean(hideName), name };
}

/** Whether the grid payload describes a poll that is no longer open, so the
 *  page must render the read-only outcome view instead of the paint UI. */
export function shouldRenderOutcome(gridPayload) {
  return gridPayload?.status !== undefined && gridPayload.status !== "open";
}

/** The #status text once a PUT /response succeeds for a poll that is STILL
 *  OPEN — the submit handler only calls this after checking
 *  shouldRenderOutcome() itself is false; a closed/booked payload takes the
 *  outcome view instead, which has its own messaging this must never
 *  clobber. Appends the same responded-of-total summary renderStatus()
 *  shows, so the invitee sees a plain acknowledgement first ("this saved")
 *  followed by where the group currently stands, rather than losing the
 *  respondent summary entirely once they save. */
export function saveSuccessStatusText(gridPayload) {
  const respondents = Array.isArray(gridPayload?.respondents) ? gridPayload.respondents : [];
  const total = respondents.length;
  if (total === 0) return "Your availability has been saved.";
  const responded = respondents.filter((r) => r && r.responded).length;
  // Mirrors renderStatus()'s own label list (same source data), so saving
  // doesn't remove information the invitee could already see a moment ago.
  const labels = respondents.map((r) => (r && typeof r.label === "string" ? r.label : "")).join(", ");
  return `Your availability has been saved. ${responded} of ${total} responded: ${labels}`;
}

// ---------- DOM wiring ----------

/** Attribute/text escaping for the fragments built below. */
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Wire the server-rendered shell. Kept deliberately thin, the same house
 *  style as booking.client.js's mount(): every decision (pre-paint, stroke
 *  mode, heatmap shade, payload shape) lives in the pure functions above,
 *  which are unit-tested; this only touches the DOM. */
export function mount(root = document.getElementById("app")) {
  if (!root) return;
  const boot = readBootstrap(root);
  if (!boot.id || !boot.token) return;

  const browserZone = browserTz();
  const state = {
    pollId: boot.id,
    token: boot.token,
    cellMinutes: boot.cellMinutes,
    tool: "free", // active paint tool: "free" | "if_needed"
    paint: new Map(), // cell ISO -> "free" | "if_needed", this invitee's own
    // Cells in `paint` whose CURRENT value came from the last ICS upload
    // (not yet overwritten by the invitee's own hand). Lets a fresh upload
    // replace its predecessor's suggestions while still protecting hand
    // paint via applyPrePaint's non-clobber rule (Fix 5).
    fromIcs: new Set(),
    paintable: new Set(),
    aggregate: {}, // cell ISO -> { free, ifNeeded }
    respondents: [],
    totalInvitees: 0,
    viewTz: browserZone,
    // Organiser IANA zone from the grid payload (M3), undefined on an older
    // payload — tzSelectZones already treats `undefined` as "no extra zone
    // to offer" rather than throwing.
    ownerTz: undefined,
    // The week grid (M2) shows the calendar week CONTAINING `day`, not just
    // `day` itself — "day" is an anchor for week selection, not a filter.
    // prev-week/next-week move it to a day in an adjacent week; a tz switch
    // may invalidate it (render() re-picks the first day when it does).
    day: null,
    // Populated by render() each pass; read by the prev-week/next-week click
    // handlers so they don't recompute the Intl bucketing themselves.
    buckets: new Map(),
    days: [],
    dragging: false,
    dragMode: null,
    outcome: null, // set once the grid GET reports a non-open status
    // True for the duration of an in-flight PUT /response — guards against a
    // second submit (e.g. a fast double-click) firing a duplicate request
    // while the first is still outstanding.
    saving: false,
  };

  const $ = (id) => document.getElementById(id);

  // L3: static placeholder for calendar-linking, not yet built server-side.
  // page.ts's shell is out of this module's fence (it carries no poll data
  // per its own guardrail comment), so the stub is inserted here at mount
  // time rather than baked into the static HTML — appended right after the
  // ICS upload control, its nearest sibling in the tools row.
  function addCalendarLinkStub() {
    const icsInput = $("ics-upload");
    if (!icsInput || !icsInput.parentElement) return;
    const btn = document.createElement("button");
    btn.setAttribute("type", "button");
    btn.setAttribute("disabled", "disabled");
    btn.setAttribute("aria-disabled", "true");
    btn.setAttribute("data-action", "link-calendar-stub");
    btn.textContent = "Link my calendar (coming soon)";
    icsInput.parentElement.appendChild(btn);
  }
  addCalendarLinkStub();

  /** Returns "open" when the refreshed grid is still an open, paintable
   *  poll; "outcome" when it turned out closed/booked/cancelled
   *  (applyGridPayload already routed that to renderOutcome(), which owns
   *  #status's message from here on — a caller must leave #status alone in
   *  this case); or "failed" on any request/parse failure (loadGrid's own
   *  failure branches below already set #status describing what went
   *  wrong, which a caller with a message of its own to protect — e.g. "the
   *  save committed, only the refresh failed" — must overwrite again).
   *  Callers that don't care about any of this (the initial mount-time
   *  load) simply ignore the return value. */
  async function loadGrid() {
    try {
      const res = await fetch(`/poll/${encodeURIComponent(state.pollId)}/grid?t=${encodeURIComponent(state.token)}`);
      if (!res.ok) {
        if ($("status")) $("status").textContent = "This poll is unavailable right now.";
        return "failed";
      }
      const body = await res.json();
      applyGridPayload(body);
      return shouldRenderOutcome(body) ? "outcome" : "open";
    } catch {
      if ($("status")) $("status").textContent = "Could not reach the server. Please try again.";
      return "failed";
    }
  }

  function applyGridPayload(body) {
    if (shouldRenderOutcome(body)) {
      state.outcome = body.status;
      renderOutcome();
      return;
    }
    state.paintable = new Set(body.paintableCells ?? []);
    state.aggregate = body.aggregate ?? {};
    state.respondents = Array.isArray(body.respondents) ? body.respondents : [];
    state.totalInvitees = state.respondents.length;
    state.ownerTz = typeof body.ownerTz === "string" ? body.ownerTz : undefined;
    if (body.you && Array.isArray(body.you.cells)) {
      const paint = new Map();
      for (const c of body.you.cells) {
        if (c && typeof c.cell === "string") paint.set(c.cell, c.state);
      }
      state.paint = paint;
      // Every cell now reflects the server's saved truth, not a client-side
      // ICS suggestion — the provenance tracking that lets a fresh upload
      // replace a stale one no longer applies to any of them.
      state.fromIcs = new Set();
    }
    // FINAL-REVIEW HIGH: the submit handler reads #hideName/#name straight
    // off the DOM, and the server applies hideName on EVERY PUT — so
    // without this, a hidden invitee who reopens their link to revise sees
    // an unchecked box (the control's untouched default) despite being
    // hidden server-side. Any edit + save then submits hideName:false and
    // silently unhides them to every peer (respondents + freeWho labels),
    // defeating spec decision 7 on its main revision path. Restoring these
    // on every applyGridPayload call (not just the initial load) also keeps
    // the form correct after a save round-trips back through here.
    if (body.you) {
      const hideNameEl = $("hideName");
      if (hideNameEl) hideNameEl.checked = Boolean(body.you.hideName);
      const nameEl = $("name");
      if (nameEl) nameEl.value = body.you.name ?? "";
    }
    render();
  }

  function renderOutcome() {
    const label =
      state.outcome === "booked"
        ? "This meeting has been booked."
        : state.outcome === "cancelled"
          ? "This poll was cancelled."
          : "This poll is closed.";
    // #status lives in page.ts's `.head` block, OUTSIDE #app-body — the
    // innerHTML rewrite below never touches it. Without this, #status is
    // stuck on whatever it said before the poll turned out to be closed:
    // "Loading…" on first load, or "Saving…" if the poll closed/booked
    // between the invitee submitting and the PUT resolving.
    if ($("status")) $("status").textContent = label;
    const box = $("app-body");
    if (!box) return;
    box.innerHTML = `<div class="outcome">${esc(label)}</div>`;
  }

  /** Full re-render of #status, #tzsel, the tool buttons' aria-pressed, and
   *  #grid's week-nav + week-grid markup. This is a small grid and the house
   *  style favours an obvious full rebuild over incremental patching
   *  (mirrors booking.client.js's render()). Every decision here — which
   *  cells to show, their paint/heat class, the status summary — comes from
   *  the pure functions above (bucketSlotsByLocalDate, weekColumns,
   *  prevWeekAnchor/nextWeekAnchor, cellIntensity, isPaintable,
   *  tzSelectZones, ...), which are unit-tested; this only builds DOM nodes
   *  from their output. */
  function render() {
    // Cached on state, not just a local, so the week-pagination click
    // handlers below (prev-week/next-week) can consult the same
    // buckets/days a render just computed without redoing the Intl work.
    state.buckets = bucketSlotsByLocalDate([...state.paintable], state.viewTz);
    state.days = [...state.buckets.keys()];
    if (!state.day || !state.days.includes(state.day)) state.day = state.days[0] ?? null;

    renderStatus();
    renderTzSelect();
    renderToolButtons();
    renderGrid(state.buckets, state.days);
  }

  /** Uses textContent, not innerHTML — plain text never needs escaping, and
   *  the respondent labels arrive from the server already pseudonymised (or
   *  as the invitee's own real name), so there is nothing here to sanitise
   *  beyond what textContent already guarantees. */
  function renderStatus() {
    const el = $("status");
    if (!el) return;
    const total = state.respondents.length;
    let next;
    if (total === 0) {
      next = "Waiting on the organiser to add invitees.";
    } else {
      const responded = state.respondents.filter((r) => r.responded).length;
      const labels = state.respondents.map((r) => r.label).join(", ");
      next = `${responded} of ${total} responded: ${labels}`;
    }
    // #status now carries aria-live="polite" (page.ts) — render() (and so
    // renderStatus) reruns on every drag-paint cell, and reassigning
    // identical text would spam assistive tech with an announcement per
    // cell painted even though nothing status-relevant changed.
    if (el.textContent !== next) el.textContent = next;
  }

  function renderTzSelect() {
    const sel = $("tzsel");
    if (!sel) return;
    sel.textContent = ""; // clears prior <option> children too
    for (const zone of tzSelectZones(browserZone, state.ownerTz, state.viewTz)) {
      const opt = document.createElement("option");
      opt.setAttribute("value", zone);
      if (zone === state.viewTz) opt.setAttribute("selected", "selected");
      opt.textContent = zone.replace(/_/g, " ");
      sel.appendChild(opt);
    }
  }

  /** The tool buttons are part of the server-rendered static shell (unlike
   *  the grid, which this module owns entirely) — their aria-pressed is
   *  stamped once by page.ts and, before this fix, never updated again, so
   *  the stylesheet's `[aria-pressed="true"]` active-pill styling silently
   *  lied after the first click. Update in place rather than recreate. */
  function renderToolButtons() {
    for (const btn of document.querySelectorAll("[data-tool]")) {
      btn.setAttribute("aria-pressed", String(btn.getAttribute("data-tool") === state.tool));
    }
  }

  /** M2 — week grid: columns per day, rows per time cell, with prev/next
   *  week navigation when the poll's paintable range spans more than one
   *  calendar week. `days` is state.days (ascending local-date keys); the
   *  currently displayed week is the one containing `state.day` (the "week
   *  anchor" — see its declaration in `state` above).
   *
   *  page.ts (out of this file's fence) supplies no grid-layout CSS, so the
   *  column layout is set via inline `style=""` here — CSP-safe: page.ts's
   *  `style-src 'unsafe-inline'` covers style ATTRIBUTES as well as the
   *  <style> block (confirmed by booking/page.ts's CSP comment, which
   *  permits the identical directive for booking.client.js's own
   *  grid-placement styles). A nonce is deliberately not used instead:
   *  under CSP3 a nonce makes 'unsafe-inline' be ignored, which would kill
   *  these attributes.
   *
   *  Rows are NOT aligned across columns by a shared time axis — each
   *  column is simply its own day's cells stacked in order, so a
   *  DST-short/long day or a day with fewer bookable hours than its
   *  neighbours legitimately has a different row count (plan rule: derive
   *  rows from the actual cells, never an assumed 48). */
  function renderGrid(buckets, days) {
    const grid = $("grid");
    if (!grid) return;
    grid.textContent = ""; // full rebuild, clears prior children too

    const weekNav = document.createElement("div");
    weekNav.setAttribute("class", "weeknav");

    const prevAnchor = prevWeekAnchor(days, state.day);
    if (prevAnchor !== null) {
      const btn = document.createElement("button");
      btn.setAttribute("type", "button");
      btn.setAttribute("data-action", "prev-week");
      btn.textContent = "‹ Previous week";
      weekNav.appendChild(btn);
    }

    const nextAnchor = nextWeekAnchor(days, state.day);
    if (nextAnchor !== null) {
      const btn = document.createElement("button");
      btn.setAttribute("type", "button");
      btn.setAttribute("data-action", "next-week");
      btn.textContent = "Next week ›";
      weekNav.appendChild(btn);
    }
    grid.appendChild(weekNav);

    const cols = weekColumns(state.day, buckets);
    const weekGridEl = document.createElement("div");
    weekGridEl.setAttribute("class", "weekgrid");
    weekGridEl.setAttribute(
      "style",
      "display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px;align-items:start",
    );

    // Weekday label formatted in UTC against the date key's noon, same
    // reasoning as booking.client.js's wdFmt: formatting a date-only key in
    // viewTz could roll a far-eastern zone onto the neighbouring day.
    const wdFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" });
    const timeFmt = new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: state.viewTz,
    });

    for (const col of cols) {
      const colEl = document.createElement("div");
      colEl.setAttribute("class", "weekcol");
      colEl.setAttribute("data-col-day", col.day);
      colEl.setAttribute("style", "display:flex;flex-direction:column;gap:6px");

      const header = document.createElement("div");
      header.setAttribute("class", "colh");
      const date = new Date(`${col.day}T12:00:00Z`);
      header.textContent = `${wdFmt.format(date)} ${Number(col.day.slice(8, 10))}`;
      colEl.appendChild(header);

      if (col.cells.length === 0) {
        const none = document.createElement("div");
        none.setAttribute("class", "none");
        none.setAttribute("title", "No availability");
        colEl.appendChild(none);
        weekGridEl.appendChild(colEl);
        continue;
      }

      for (const cell of col.cells) {
        const btn = document.createElement("button");
        btn.setAttribute("type", "button");
        btn.setAttribute("data-cell", cell);
        const paintState = state.paint.get(cell);
        if (paintState) btn.classList.add(paintState);
        const agg = state.aggregate[cell] ?? { free: 0, ifNeeded: 0 };
        // Quantised into 5 buckets; T7's stylesheet defines .heat-0 .. .heat-4.
        const heat = Math.round(cellIntensity(agg, state.totalInvitees) * 4);
        btn.classList.add(`heat-${heat}`);
        btn.setAttribute("aria-pressed", String(Boolean(paintState)));
        // `title` is a plain-text attribute value, never parsed as markup —
        // safe without esc(). buildCellTitle prefers per-cell viewer-
        // appropriate names (decision D3 / M1) and degrades to the counts-only
        // summary on an older payload; an empty return means no segment had
        // anything to show, so no title attribute is set at all.
        const cellTitle = buildCellTitle(agg);
        if (cellTitle) btn.setAttribute("title", cellTitle);
        btn.textContent = timeFmt.format(new Date(cell));
        colEl.appendChild(btn);
      }
      weekGridEl.appendChild(colEl);
    }
    grid.appendChild(weekGridEl);
  }

  function endStroke() {
    state.dragging = false;
    state.dragMode = null;
  }

  document.addEventListener("pointerdown", (e) => {
    if (!(e.target instanceof Element)) return;
    const cellEl = e.target.closest("[data-cell]");
    if (!cellEl) return;
    const cell = cellEl.getAttribute("data-cell");
    if (!cell || !isPaintable(cell, state.paintable)) return;
    // Touch input implicitly captures the pointer to the anchor element,
    // which would retarget every subsequent pointermove back to it and make
    // a drag paint exactly one cell. Releasing restores per-element hit
    // testing so the drag can cross into neighbouring cells.
    if (cellEl.hasPointerCapture && cellEl.hasPointerCapture(e.pointerId)) {
      cellEl.releasePointerCapture(e.pointerId);
    }
    const mode = strokeMode(state.paint.get(cell) ?? null, state.tool);
    state.dragging = true;
    state.dragMode = mode;
    state.fromIcs.delete(cell); // now hand-authored, whether painted or erased
    if (mode === null) state.paint.delete(cell);
    else state.paint.set(cell, mode);
    render();
  });

  document.addEventListener("pointermove", (e) => {
    if (!state.dragging || !(e.target instanceof Element)) return;
    const cellEl = e.target.closest("[data-cell]");
    if (!cellEl) return;
    const cell = cellEl.getAttribute("data-cell");
    if (!cell || !isPaintable(cell, state.paintable)) return;
    state.fromIcs.delete(cell);
    if (state.dragMode === null) state.paint.delete(cell);
    else state.paint.set(cell, state.dragMode);
    render();
  });

  document.addEventListener("pointerup", endStroke);
  document.addEventListener("pointercancel", endStroke);

  document.addEventListener("click", (e) => {
    if (!(e.target instanceof Element)) return;
    const tool = e.target.closest("[data-tool]");
    if (tool) {
      state.tool = tool.getAttribute("data-tool");
      render(); // syncs both [data-tool] buttons' aria-pressed
      return;
    }
    // M2 week pagination. Anchors moved with prevWeekAnchor/nextWeekAnchor
    // against state.days — the same list the render just displayed came
    // from, so this can't jump anywhere render() itself would then reject.
    const prevWeek = e.target.closest("[data-action='prev-week']");
    if (prevWeek) {
      const anchor = prevWeekAnchor(state.days, state.day);
      if (anchor !== null) {
        state.day = anchor;
        render();
      }
      return;
    }
    const nextWeek = e.target.closest("[data-action='next-week']");
    if (nextWeek) {
      const anchor = nextWeekAnchor(state.days, state.day);
      if (anchor !== null) {
        state.day = anchor;
        render();
      }
      return;
    }
    const clear = e.target.closest("[data-action='clear']");
    if (clear) {
      state.paint = new Map();
      state.fromIcs = new Set();
      render();
    }
  });

  document.addEventListener("change", async (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.id === "tzsel") {
      state.viewTz = e.target.value;
      render();
      return;
    }
    if (e.target.id !== "ics-upload") return;
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const text = await file.text();
    // Reset the input's value so re-selecting the SAME file still fires a
    // change event — browsers only fire `change` when the selection
    // differs from what is already there.
    e.target.value = "";

    // Cells the PREVIOUS upload suggested are no longer "suggested" once a
    // new file lands — strip them so this file's suggestions can replace
    // them. Any cell the invitee painted BY HAND is never in `fromIcs`
    // (the pointer handlers remove it on the first hand edit), so it stays
    // protected by applyPrePaint's non-clobber rule below.
    for (const cell of state.fromIcs) state.paint.delete(cell);

    const now = Date.now();
    const cells = [...state.paintable];
    const lastCellMs = cells.reduce((max, iso) => Math.max(max, Date.parse(iso)), now);
    const windowOpts = { fromMs: now, toMs: lastCellMs + state.cellMinutes * 60_000, defaultTz: state.viewTz };
    const before = new Set(state.paint.keys());
    const merged = computeIcsPrePaint(text, cells, state.cellMinutes, state.paint, windowOpts);
    const newFromIcs = new Set();
    for (const cell of merged.keys()) {
      if (!before.has(cell)) newFromIcs.add(cell);
    }
    state.paint = merged;
    state.fromIcs = newFromIcs;
    render();
  });

  document.addEventListener("submit", async (e) => {
    if (!(e.target instanceof Element) || e.target.id !== "responseform") return;
    e.preventDefault();
    // Guards a fast double-submit (e.g. a double-click landing before the
    // button's `disabled` attribute takes visual effect) from firing a
    // second, duplicate PUT while the first is still outstanding.
    if (state.saving) return;

    const submitBtn = $("submit-btn");
    // Once a 409 poll_closed lands below, the button must stay disabled on
    // EVERY exit path (including the shared `finally`) — the poll is
    // permanently closed, so re-enabling it would only invite a retry that
    // can never succeed.
    let staysDisabled = false;

    try {
      state.saving = true;
      if (submitBtn) submitBtn.setAttribute("disabled", "disabled");
      // Immediate feedback while the request is in flight — without this
      // the save looked like a no-op: it worked, but nothing on screen
      // changed until the respondent summary re-rendered underneath it.
      if ($("status")) $("status").textContent = "Saving…";

      const hideName = $("hideName") ? Boolean($("hideName").checked) : false;
      const name = $("name") ? $("name").value : "";
      const payload = buildResponsePayload(state.paint, hideName, name);
      const res = await fetch(
        `/poll/${encodeURIComponent(state.pollId)}/response?t=${encodeURIComponent(state.token)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        if (res.status === 400) {
          // The organiser's availability moved under us: some cell painted
          // in this session is no longer offerable. Re-fetch so the grid
          // shows the live region rather than resubmitting the identical
          // rejected body forever. loadGrid() replaces state.paint from the
          // server's `you.cells`, so the rejected cells drop out naturally.
          // Only layer this message on top when the refresh shows the poll
          // is still open — a refresh that reveals the poll has closed in
          // the meantime routes to renderOutcome() instead (inside
          // loadGrid), and "check and save again" would be nonsense
          // clobbering that outcome message on a poll that can no longer be
          // saved to at all.
          const refreshResult = await loadGrid();
          if (refreshResult === "open" && $("status")) {
            $("status").textContent =
              "Some times you picked are no longer available — the grid has been refreshed. Please check and save again.";
          }
          return;
        }
        if (res.status === 409) {
          // The poll closed (deadline passed, booked, or cancelled)
          // between the invitee loading the grid and submitting — a
          // specific, actionable message beats the generic fallback below,
          // same idea as the 400 handling above.
          let errorCode;
          try {
            const errBody = await res.json();
            errorCode = errBody && typeof errBody.error === "string" ? errBody.error : undefined;
          } catch {
            errorCode = undefined;
          }
          if (errorCode === "poll_closed") {
            staysDisabled = true;
            if ($("status")) {
              $("status").textContent = "This poll has closed — responses can no longer be changed.";
            }
            return;
          }
        }
        if ($("status")) $("status").textContent = "Something went wrong. Please try again.";
        return;
      }

      // Parsing the body and applying it are wrapped together, in their OWN
      // try/catch, separately from the fetch() call above: res.ok being
      // true means the PUT already COMMITTED server-side, so a malformed or
      // truncated response body here must never fall through to the outer
      // catch's "Could not reach the server" message — that would tell the
      // invitee their save failed when it actually succeeded. Recovering by
      // refreshing via loadGrid() gets the grid back in sync regardless.
      let body;
      try {
        body = await res.json();
        applyGridPayload(body);
      } catch {
        // The PUT already committed (res.ok was true) — set the
        // confirmation FIRST, so it's already showing regardless of how
        // the refresh below goes, then let a successful refresh improve on
        // it. Three outcomes: "open" upgrades to the full confirmation
        // (with the freshly-refreshed respondent summary, since this
        // malformed body never gave us one); "outcome" means loadGrid()
        // already routed to renderOutcome(), which owns #status from here
        // — leave it untouched; "failed" means loadGrid() itself clobbered
        // #status with its OWN failure message (network/HTTP error on the
        // refresh GET) even though the original save succeeded, so restore
        // the confirmation over it — the save committing must never read
        // as "could not reach the server".
        if ($("status")) $("status").textContent = "Your availability was saved.";
        const refreshResult = await loadGrid();
        if (refreshResult === "open" && $("status")) {
          $("status").textContent = saveSuccessStatusText({ respondents: state.respondents });
        } else if (refreshResult === "failed" && $("status")) {
          $("status").textContent = "Your availability was saved.";
        }
        return;
      }
      // Set AFTER applyGridPayload, and only when the poll is still open:
      // applyGridPayload's render() -> renderStatus() would otherwise
      // clobber this back to the plain respondent summary, and for a
      // closed/booked payload applyGridPayload already routed to
      // renderOutcome(), which owns #status's message in that case — this
      // must not overwrite it with "saved".
      if (!shouldRenderOutcome(body) && $("status")) {
        $("status").textContent = saveSuccessStatusText(body);
      }
    } catch {
      if ($("status")) $("status").textContent = "Could not reach the server. Please try again.";
    } finally {
      state.saving = false;
      if (submitBtn && !staysDisabled) submitBtn.removeAttribute("disabled");
    }
  });

  loadGrid();
}

// Guarded so importing this module under vitest (no DOM) does not execute it.
if (typeof document !== "undefined") mount();
