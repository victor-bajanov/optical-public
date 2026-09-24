// Unit tests for poll.client.js's exported pure helpers: the bootstrap
// reader, paintable-region gating, drag-paint stroke-mode determination,
// the ICS pre-paint rule (including the "never clobber user paint" guard),
// DST-safe cell bucketing, and heatmap intensity mapping. mount()'s DOM
// wiring is exercised only indirectly (it is guarded the same way
// booking.client.js's mount() is, so importing this module under vitest,
// which has no DOM in the workers pool, does not execute it).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  readBootstrap,
  isPaintable,
  strokeMode,
  splitIcsByStatus,
  prePaintFromIcs,
  applyPrePaint,
  computeIcsPrePaint,
  cellIntensity,
  buildCellTitle,
  tzSelectZones,
  COMMON_TZ_ZONES,
  buildResponsePayload,
  shouldRenderOutcome,
  saveSuccessStatusText,
  bucketSlotsByLocalDate,
  weekOf,
  weekColumns,
  prevWeekAnchor,
  nextWeekAnchor,
  parseIcsBusy,
  warnings,
  stats,
  MAX_ICS_CHARS,
  mount,
} from "../../src/polls/poll.client.js";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

describe("readBootstrap", () => {
  // The page shell's CSP is `script-src 'self'` with no inline allowance, so
  // an inline `<script>window.__POLL__ = …</script>` never runs in a real
  // browser. The bootstrap travels as data- attributes on #app instead — the
  // same idiom booking.client.js's mount() uses for `root.dataset.slug`.
  it("reads id/token/cellMinutes from the root element's dataset", () => {
    const root = { dataset: { pollId: "p_abc", token: "tok123", cellMinutes: "30" } };
    expect(readBootstrap(root)).toEqual({ id: "p_abc", token: "tok123", cellMinutes: 30 });
  });

  it("defaults cellMinutes to 30 when the dataset omits it", () => {
    const root = { dataset: { pollId: "p_abc", token: "tok123" } };
    expect(readBootstrap(root)).toEqual({ id: "p_abc", token: "tok123", cellMinutes: 30 });
  });

  it("falls back to 30 when cellMinutes is not a positive number", () => {
    expect(readBootstrap({ dataset: { pollId: "p", token: "t", cellMinutes: "not-a-number" } }).cellMinutes).toBe(30);
    expect(readBootstrap({ dataset: { pollId: "p", token: "t", cellMinutes: "0" } }).cellMinutes).toBe(30);
    expect(readBootstrap({ dataset: { pollId: "p", token: "t", cellMinutes: "-5" } }).cellMinutes).toBe(30);
  });

  it("treats a missing or empty token as absent", () => {
    expect(readBootstrap({ dataset: { pollId: "p_abc", token: "" } }).token).toBeNull();
    expect(readBootstrap({ dataset: { pollId: "p_abc" } }).token).toBeNull();
  });

  it("returns nulls when there is no dataset at all", () => {
    expect(readBootstrap(undefined)).toEqual({ id: null, token: null, cellMinutes: 30 });
    expect(readBootstrap({})).toEqual({ id: null, token: null, cellMinutes: 30 });
  });

  it("never interprets a hostile bootstrap value as markup — it is read as plain data", () => {
    // dataset values are always strings from HTML attributes; even a value
    // containing markup must pass through readBootstrap untouched (escaping,
    // if any, is the caller's job when rendering, not the reader's).
    const root = { dataset: { pollId: "<script>alert(1)</script>", token: "t", cellMinutes: "30" } };
    expect(readBootstrap(root).id).toBe("<script>alert(1)</script>");
  });
});

// ---------------------------------------------------------------------------
// Paintable-region gating
// ---------------------------------------------------------------------------

describe("isPaintable", () => {
  const paintable = new Set(["2026-08-03T00:00:00.000Z", "2026-08-03T00:30:00.000Z"]);

  it("is true for a cell the server marked paintable", () => {
    expect(isPaintable("2026-08-03T00:00:00.000Z", paintable)).toBe(true);
  });

  it("is false for a cell outside the paintable set", () => {
    expect(isPaintable("2026-08-03T01:00:00.000Z", paintable)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Drag-paint stroke mode: pointerdown on an unpainted cell paints with the
// active tool; pointerdown on an already-painted cell erases for the whole
// stroke, whatever tool is active.
// ---------------------------------------------------------------------------

describe("strokeMode", () => {
  it("paints with the active tool when the anchor cell is unpainted", () => {
    expect(strokeMode(null, "free")).toBe("free");
    expect(strokeMode(undefined, "if_needed")).toBe("if_needed");
  });

  it("erases when the anchor cell is already painted free", () => {
    expect(strokeMode("free", "free")).toBeNull();
    expect(strokeMode("free", "if_needed")).toBeNull();
  });

  it("erases when the anchor cell is already painted if_needed", () => {
    expect(strokeMode("if_needed", "free")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ICS pre-paint rule.
// ---------------------------------------------------------------------------

const CELL_MIN = 30;
const CELLS = [
  "2026-08-03T00:00:00.000Z", // free — nothing overlaps
  "2026-08-03T00:30:00.000Z", // overlapped by confirmed busy
  "2026-08-03T01:00:00.000Z", // overlapped only by a tentative event
  "2026-08-03T01:30:00.000Z", // free
];

describe("splitIcsByStatus", () => {
  it("separates a TENTATIVE VEVENT from a confirmed one", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "DTSTART:20260803T003000Z",
      "DTEND:20260803T010000Z",
      "STATUS:CONFIRMED",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART:20260803T010000Z",
      "DTEND:20260803T013000Z",
      "STATUS:TENTATIVE",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const { confirmedText, tentativeText } = splitIcsByStatus(ics);
    const W = { fromMs: Date.parse("2026-08-01T00:00:00Z"), toMs: Date.parse("2026-08-10T00:00:00Z") };
    expect(parseIcsBusy(confirmedText, W)).toEqual([
      { s: Date.parse("2026-08-03T00:30:00Z"), e: Date.parse("2026-08-03T01:00:00Z") },
    ]);
    expect(parseIcsBusy(tentativeText, W)).toEqual([
      { s: Date.parse("2026-08-03T01:00:00Z"), e: Date.parse("2026-08-03T01:30:00Z") },
    ]);
  });

  it("puts an event with no STATUS in the confirmed bucket (RFC 5545 default)", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "DTSTART:20260803T003000Z",
      "DTEND:20260803T010000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const { confirmedText, tentativeText } = splitIcsByStatus(ics);
    const W = { fromMs: Date.parse("2026-08-01T00:00:00Z"), toMs: Date.parse("2026-08-10T00:00:00Z") };
    expect(parseIcsBusy(confirmedText, W)).toHaveLength(1);
    expect(parseIcsBusy(tentativeText, W)).toHaveLength(0);
  });

  it("Fix 7: a STATUS:TENTATIVE inside a nested VALARM does not tentative-ise the VEVENT", () => {
    // splitIcsByStatus tracked `inEvent` but not nesting depth, so a
    // TENTATIVE alarm reminder nested inside a perfectly normal confirmed
    // VEVENT mis-classified the whole event as tentative.
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "DTSTART:20260803T003000Z",
      "DTEND:20260803T010000Z",
      "STATUS:CONFIRMED",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "STATUS:TENTATIVE",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const { confirmedText, tentativeText } = splitIcsByStatus(ics);
    const W = { fromMs: Date.parse("2026-08-01T00:00:00Z"), toMs: Date.parse("2026-08-10T00:00:00Z") };
    expect(parseIcsBusy(confirmedText, W)).toHaveLength(1);
    expect(parseIcsBusy(tentativeText, W)).toHaveLength(0);
  });
});

describe("prePaintFromIcs", () => {
  const confirmedBusy = [{ s: Date.parse("2026-08-03T00:30:00Z"), e: Date.parse("2026-08-03T01:00:00Z") }];
  const tentativeBusy = [{ s: Date.parse("2026-08-03T01:00:00Z"), e: Date.parse("2026-08-03T01:30:00Z") }];

  it("marks a cell untouched by any busy time as free", () => {
    const pre = prePaintFromIcs(CELLS, CELL_MIN, confirmedBusy, tentativeBusy);
    expect(pre.get("2026-08-03T00:00:00.000Z")).toBe("free");
    expect(pre.get("2026-08-03T01:30:00.000Z")).toBe("free");
  });

  it("marks a cell overlapped only by a tentative event as if_needed", () => {
    const pre = prePaintFromIcs(CELLS, CELL_MIN, confirmedBusy, tentativeBusy);
    expect(pre.get("2026-08-03T01:00:00.000Z")).toBe("if_needed");
  });

  it("leaves a cell overlapped by confirmed busy unpainted (not in the map)", () => {
    const pre = prePaintFromIcs(CELLS, CELL_MIN, confirmedBusy, tentativeBusy);
    expect(pre.has("2026-08-03T00:30:00.000Z")).toBe(false);
  });

  it("confirmed busy wins over an overlapping tentative claim on the same cell", () => {
    // A cell overlapped by BOTH a confirmed and a tentative event must stay
    // unpainted, not fall through to if_needed.
    const busyBoth = [{ s: Date.parse("2026-08-03T00:00:00Z"), e: Date.parse("2026-08-03T00:30:00Z") }];
    const tentBoth = [{ s: Date.parse("2026-08-03T00:00:00Z"), e: Date.parse("2026-08-03T00:30:00Z") }];
    const pre = prePaintFromIcs(["2026-08-03T00:00:00.000Z"], CELL_MIN, busyBoth, tentBoth);
    expect(pre.has("2026-08-03T00:00:00.000Z")).toBe(false);
  });

  it("only pre-paints cells that are in the paintable list", () => {
    const pre = prePaintFromIcs([], CELL_MIN, confirmedBusy, tentativeBusy);
    expect(pre.size).toBe(0);
  });
});

describe("applyPrePaint (busy-never-clobbers-paint)", () => {
  it("fills unpainted cells from the pre-paint map", () => {
    const current = new Map();
    const pre = new Map([["c1", "free"], ["c2", "if_needed"]]);
    const merged = applyPrePaint(current, pre);
    expect(merged.get("c1")).toBe("free");
    expect(merged.get("c2")).toBe("if_needed");
  });

  it("never overwrites a cell the user already painted this session", () => {
    const current = new Map([["c1", "if_needed"]]); // user's own choice
    const pre = new Map([["c1", "free"], ["c2", "free"]]); // ICS suggests differently for c1
    const merged = applyPrePaint(current, pre);
    expect(merged.get("c1")).toBe("if_needed"); // untouched
    expect(merged.get("c2")).toBe("free"); // filled in
  });

  it("does not mutate the input maps", () => {
    const current = new Map([["c1", "free"]]);
    const pre = new Map([["c2", "free"]]);
    applyPrePaint(current, pre);
    expect(current.has("c2")).toBe(false);
  });
});

describe("computeIcsPrePaint — Fix 3: the size cap must be checked before splitIcsByStatus unfolds the whole document", () => {
  it("refuses an oversize file without unfolding/splitting/parsing it, and leaves the paint unchanged", () => {
    // splitIcsByStatus calls unfoldLines on the WHOLE document, and
    // MAX_ICS_CHARS was previously only checked inside parseIcsBusy, against
    // each half separately — so a file twice the limit sailed through as two
    // halves each individually under the cap. The cap must be enforced
    // before the split, on the whole document.
    const huge = "X".repeat(MAX_ICS_CHARS + 1);
    const current = new Map([["2026-08-03T00:00:00.000Z", "free"]]);
    const merged = computeIcsPrePaint(huge, CELLS, CELL_MIN, current, {
      fromMs: Date.parse("2026-08-01T00:00:00Z"),
      toMs: Date.parse("2026-08-10T00:00:00Z"),
    });
    expect(merged).toEqual(current); // unchanged — ICS is an accelerator, never a source of truth
    expect(merged).not.toBe(current); // still a fresh Map per the function's existing contract
    expect(warnings.join(" ")).toMatch(/too large/i);
  });
});

describe("computeIcsPrePaint — Fix 4: the confirmed half's diagnostics must survive the tentative parse", () => {
  it("keeps a warning raised while parsing the CONFIRMED half after the TENTATIVE half parses clean", () => {
    // parseIcsBusy resets the module-global warnings/stats on entry.
    // computeIcsPrePaint calls it twice (confirmed half, then tentative
    // half), so without snapshot-and-merge the confirmed half's warning is
    // wiped by the tentative pass — which is usually the empty, warning-free
    // half, so what survives is nothing.
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      // Missing DTSTART on the confirmed half -> "VEVENT missing DTSTART" warning.
      "STATUS:CONFIRMED",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART:20260803T010000Z",
      "DTEND:20260803T013000Z",
      "STATUS:TENTATIVE",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    computeIcsPrePaint(ics, CELLS, CELL_MIN, new Map(), {
      fromMs: Date.parse("2026-08-01T00:00:00Z"),
      toMs: Date.parse("2026-08-10T00:00:00Z"),
    });
    expect(warnings.some((w) => w.includes("missing DTSTART"))).toBe(true);
    // The tentative half's one contributing event must still be counted.
    expect(stats.events).toBe(1);
  });
});

describe("computeIcsPrePaint (end-to-end: split + parse + overlap + merge)", () => {
  it("pre-paints a real .ics upload without clobbering existing user paint", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "DTSTART:20260803T003000Z",
      "DTEND:20260803T010000Z",
      "STATUS:CONFIRMED",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "DTSTART:20260803T010000Z",
      "DTEND:20260803T013000Z",
      "STATUS:TENTATIVE",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const current = new Map([["2026-08-03T00:00:00.000Z", "if_needed"]]); // pre-existing user paint
    const merged = computeIcsPrePaint(ics, CELLS, CELL_MIN, current, {
      fromMs: Date.parse("2026-08-01T00:00:00Z"),
      toMs: Date.parse("2026-08-10T00:00:00Z"),
    });
    expect(merged.get("2026-08-03T00:00:00.000Z")).toBe("if_needed"); // preserved
    expect(merged.get("2026-08-03T00:30:00.000Z")).toBeUndefined(); // confirmed busy, unpainted
    expect(merged.get("2026-08-03T01:00:00.000Z")).toBe("if_needed"); // tentative-only
    expect(merged.get("2026-08-03T01:30:00.000Z")).toBe("free"); // untouched by busy
  });
});

// ---------------------------------------------------------------------------
// DST-safe cell bucketing (2026-10-04 02:00 Sydney clocks skip to 03:00).
// ---------------------------------------------------------------------------

describe("bucketSlotsByLocalDate across a DST week", () => {
  it("buckets 30-minute cells around the Sydney spring-forward into the correct local dates", () => {
    // 2026-10-03T15:00Z .. 2026-10-04T17:00Z UTC, 30-min steps. AEST (+10)
    // applies until 2026-10-04T02:00 local, then AEDT (+11).
    const cells: string[] = [];
    for (let t = Date.parse("2026-10-03T15:00:00Z"); t <= Date.parse("2026-10-04T17:00:00Z"); t += 30 * 60_000) {
      cells.push(new Date(t).toISOString());
    }
    const buckets = bucketSlotsByLocalDate(cells, "Australia/Sydney");
    // 2026-10-03T15:00Z is 2026-10-04T01:00 AEST — already the 4th locally.
    expect(buckets.get("2026-10-04")).toContain("2026-10-03T15:00:00.000Z");
    // 2026-10-04T16:00Z is 2026-10-05T03:00 AEDT — the 5th locally, even
    // though it is still the 4th in UTC.
    expect(buckets.get("2026-10-05")).toContain("2026-10-04T16:00:00.000Z");
  });

  it("gives the DST-transition day a different (not assumed-48) cell count in weekColumns, driven by its own bucket", () => {
    // Same fixture as above: 2026-10-04 is the Sydney spring-forward day, one
    // wall-clock hour short. weekColumns must report whatever bucketSlotsByLocalDate
    // actually produced for that day, never a hardcoded row count.
    const cells: string[] = [];
    for (let t = Date.parse("2026-10-03T15:00:00Z"); t <= Date.parse("2026-10-04T17:00:00Z"); t += 30 * 60_000) {
      cells.push(new Date(t).toISOString());
    }
    const buckets = bucketSlotsByLocalDate(cells, "Australia/Sydney");
    const cols = weekColumns("2026-10-04", buckets); // week Mon 2026-09-28 .. Sun 2026-10-04
    const oct4 = cols.find((c) => c.day === "2026-10-04")!;
    expect(oct4.cells.length).toBe(buckets.get("2026-10-04")!.length);
    expect(oct4.cells.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Week grid (M2 / T6b item 5): weekOf, weekColumns, and pagination between
// weeks when the poll's paintable range spans more than one calendar week.
// ---------------------------------------------------------------------------

describe("weekOf", () => {
  it("returns the seven Monday-first local date keys of the week containing isoDate", () => {
    // 2026-10-04 (the DST-transition day) falls on a Sunday, so the week
    // containing it runs Monday 2026-09-28 through Sunday 2026-10-04.
    expect(weekOf("2026-10-04")).toEqual([
      "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01",
      "2026-10-02", "2026-10-03", "2026-10-04",
    ]);
  });

  it("is stable for a day already at the start of its week (a Monday)", () => {
    expect(weekOf("2026-08-17")[0]).toBe("2026-08-17");
    expect(weekOf("2026-08-17")).toHaveLength(7);
  });
});

describe("weekColumns", () => {
  it("returns one column per day of the calendar week containing anchorDay, in Monday-first order", () => {
    const buckets = new Map([
      ["2026-08-18", ["2026-08-18T09:00:00.000Z"]],
      ["2026-08-20", ["2026-08-20T09:00:00.000Z", "2026-08-20T09:30:00.000Z"]],
    ]);
    const cols = weekColumns("2026-08-19", buckets); // Wed, week Mon 08-17 .. Sun 08-23
    expect(cols.map((c) => c.day)).toEqual([
      "2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20",
      "2026-08-21", "2026-08-22", "2026-08-23",
    ]);
    expect(cols.find((c) => c.day === "2026-08-18")!.cells).toEqual(["2026-08-18T09:00:00.000Z"]);
    expect(cols.find((c) => c.day === "2026-08-20")!.cells).toHaveLength(2);
  });

  it("gives an empty cells array (not a missing column) for a day in the week with nothing bucketed", () => {
    const cols = weekColumns("2026-08-19", new Map());
    expect(cols).toHaveLength(7);
    expect(cols.every((c) => c.cells.length === 0)).toBe(true);
  });

  it("returns no columns when there is no anchor day", () => {
    expect(weekColumns(null, new Map())).toEqual([]);
    expect(weekColumns(undefined, new Map())).toEqual([]);
  });
});

describe("prevWeekAnchor / nextWeekAnchor (week pagination at range boundaries)", () => {
  // A poll open across four distinct calendar weeks:
  //   [08-03 Mon .. 08-09 Sun]: 08-03, 08-04
  //   [08-17 Mon .. 08-23 Sun]: 08-17
  //   [08-24 Mon .. 08-30 Sun]: 08-24
  //   [08-31 Mon .. 09-06 Sun]: 08-31
  const days = ["2026-08-03", "2026-08-04", "2026-08-17", "2026-08-24", "2026-08-31"];

  it("prevWeekAnchor finds the latest day from an earlier calendar week", () => {
    expect(prevWeekAnchor(days, "2026-08-24")).toBe("2026-08-17");
    expect(prevWeekAnchor(days, "2026-08-17")).toBe("2026-08-04");
  });

  it("nextWeekAnchor finds the earliest day from a later calendar week", () => {
    expect(nextWeekAnchor(days, "2026-08-04")).toBe("2026-08-17");
    expect(nextWeekAnchor(days, "2026-08-17")).toBe("2026-08-24");
  });

  it("is null at the range boundaries — no earlier/later week available", () => {
    expect(prevWeekAnchor(days, "2026-08-03")).toBeNull();
    expect(nextWeekAnchor(days, "2026-08-31")).toBeNull();
  });

  it("treats two days in the SAME calendar week as not needing pagination", () => {
    expect(prevWeekAnchor(days, "2026-08-04")).toBeNull(); // 08-03 is the same week as 08-04
    expect(nextWeekAnchor(days, "2026-08-03")).toBe("2026-08-17"); // 08-04 is the same week, skip past it
  });

  it("returns null defensively when there is no anchor day", () => {
    expect(prevWeekAnchor(days, null)).toBeNull();
    expect(nextWeekAnchor(days, undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Heatmap intensity mapping.
// ---------------------------------------------------------------------------

describe("cellIntensity", () => {
  it("weights free as 1.0 and if_needed as 0.5", () => {
    expect(cellIntensity({ free: 2, ifNeeded: 0 }, 4)).toBeCloseTo(0.5);
    expect(cellIntensity({ free: 0, ifNeeded: 2 }, 4)).toBeCloseTo(0.25);
  });

  it("combines free and if_needed weights", () => {
    expect(cellIntensity({ free: 1, ifNeeded: 2 }, 4)).toBeCloseTo((1 + 1) / 4); // 1*1.0 + 2*0.5 = 2
  });

  it("is 0 for a cell with no responses", () => {
    expect(cellIntensity({ free: 0, ifNeeded: 0 }, 4)).toBe(0);
  });

  it("clamps at 1 even if weights exceed the invitee count (defensive)", () => {
    expect(cellIntensity({ free: 5, ifNeeded: 5 }, 4)).toBe(1);
  });

  it("is 0 when there are no invitees at all, never NaN or Infinity", () => {
    expect(cellIntensity({ free: 0, ifNeeded: 0 }, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Hover-who tooltip text (decision D3 client half / M1). aggregate[cell] may or
// may not carry freeWho/ifNeededWho depending on whether T11's server half of
// the grid-payload extension has shipped — this must degrade to the older
// counts-only summary rather than throw.
// ---------------------------------------------------------------------------

describe("buildCellTitle", () => {
  it("falls back to the counts-only summary when freeWho/ifNeededWho are absent (older payload)", () => {
    expect(buildCellTitle({ free: 2, ifNeeded: 1 })).toBe("2 free, 1 if needed");
  });

  it("defaults missing counts to 0 in the fallback form, and never throws on a missing aggregate", () => {
    expect(buildCellTitle({})).toBe("0 free, 0 if needed");
    expect(buildCellTitle(undefined)).toBe("0 free, 0 if needed");
  });

  it("builds a Free/If-needed tooltip from the named lists when the payload carries them", () => {
    expect(
      buildCellTitle({ free: 2, ifNeeded: 1, freeWho: ["Alice", "quiet-heron"], ifNeededWho: ["Bob"] }),
    ).toBe("Free: Alice, quiet-heron · If needed: Bob");
  });

  it("omits a segment whose list is empty rather than printing 'Free: '", () => {
    expect(buildCellTitle({ free: 0, ifNeeded: 1, freeWho: [], ifNeededWho: ["Bob"] })).toBe("If needed: Bob");
    expect(buildCellTitle({ free: 1, ifNeeded: 0, freeWho: ["Alice"], ifNeededWho: [] })).toBe("Free: Alice");
  });

  it("returns an empty string (caller omits the title attribute) when both named lists are present but empty", () => {
    expect(buildCellTitle({ free: 0, ifNeeded: 0, freeWho: [], ifNeededWho: [] })).toBe("");
  });

  it("switches to named-label mode from freeWho alone, treating a missing ifNeededWho as empty", () => {
    expect(buildCellTitle({ free: 1, ifNeeded: 0, freeWho: ["Alice"] })).toBe("Free: Alice");
  });
});

// ---------------------------------------------------------------------------
// Timezone select options (M3): viewer zone, organiser zone, and a short
// common-zone list, deduped and filtered to valid IANA zones.
// ---------------------------------------------------------------------------

describe("tzSelectZones", () => {
  it("offers the viewer's browser zone, the organiser's zone, and the current selection, deduped", () => {
    const zones = tzSelectZones("Australia/Sydney", "America/New_York", "Australia/Sydney");
    expect(zones.filter((z) => z === "Australia/Sydney")).toHaveLength(1);
    expect(zones).toContain("America/New_York");
  });

  it("includes the common-zone list", () => {
    const zones = tzSelectZones("UTC", undefined, "UTC");
    for (const zone of COMMON_TZ_ZONES) expect(zones).toContain(zone);
  });

  it("degrades gracefully when ownerTz is absent (older payload, or a poll with no organiser tz)", () => {
    const zones = tzSelectZones("Australia/Sydney", undefined, "Australia/Sydney");
    expect(zones).toContain("Australia/Sydney");
    expect(zones.every((z) => typeof z === "string" && z.length > 0)).toBe(true);
  });

  it("filters out an invalid tz string without throwing", () => {
    const zones = tzSelectZones("Not/AZone", "UTC", "UTC");
    expect(zones).not.toContain("Not/AZone");
  });
});

// ---------------------------------------------------------------------------
// Submit payload builder (PUT /poll/:id/response contract, plan §5).
// ---------------------------------------------------------------------------

describe("buildResponsePayload", () => {
  it("serialises the paint map, hideName and name per the fixed grid contract", () => {
    const paint = new Map([
      ["2026-08-03T00:00:00.000Z", "free"],
      ["2026-08-03T00:30:00.000Z", "if_needed"],
    ]);
    expect(buildResponsePayload(paint, true, "Alex")).toEqual({
      cells: [
        { cell: "2026-08-03T00:00:00.000Z", state: "free" },
        { cell: "2026-08-03T00:30:00.000Z", state: "if_needed" },
      ],
      hideName: true,
      name: "Alex",
    });
  });

  it("sends an empty cells array when nothing is painted", () => {
    expect(buildResponsePayload(new Map(), false, "Sam")).toEqual({
      cells: [],
      hideName: false,
      name: "Sam",
    });
  });
});

// ---------------------------------------------------------------------------
// Outcome view gating.
// ---------------------------------------------------------------------------

describe("shouldRenderOutcome", () => {
  it("is false for an open poll", () => {
    expect(shouldRenderOutcome({ status: "open" })).toBe(false);
  });

  it("is true once the poll is booked, cancelled, or needs_attention", () => {
    expect(shouldRenderOutcome({ status: "booked" })).toBe(true);
    expect(shouldRenderOutcome({ status: "cancelled" })).toBe(true);
    expect(shouldRenderOutcome({ status: "needs_attention" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Post-save #status confirmation text (save-feedback fix): the submit
// handler must tell the invitee their save actually happened, rather than
// silently letting renderStatus's respondent summary stand in for an
// acknowledgement. Only ever composed for a still-OPEN poll — a
// closed/booked payload takes the outcome view instead (see the mount()
// describe block below), so this function is never even called in that
// case.
// ---------------------------------------------------------------------------

describe("saveSuccessStatusText", () => {
  it("is a plain confirmation when there are no respondents to summarise", () => {
    expect(saveSuccessStatusText({ respondents: [] })).toBe("Your availability has been saved.");
  });

  it("defaults to the plain confirmation when respondents is absent entirely (defensive)", () => {
    expect(saveSuccessStatusText({})).toBe("Your availability has been saved.");
    expect(saveSuccessStatusText(undefined)).toBe("Your availability has been saved.");
  });

  it("appends the responded-of-total summary, WITH respondent labels (mirrors renderStatus), when respondents are present", () => {
    // Reviewer MINOR: an earlier version of this function dropped the
    // respondent labels renderStatus() shows — saving removed information
    // instead of just adding a confirmation on top of it.
    const payload = {
      respondents: [{ label: "Alex", responded: true }, { label: "Sam", responded: false }],
    };
    expect(saveSuccessStatusText(payload)).toBe(
      "Your availability has been saved. 1 of 2 responded: Alex, Sam",
    );
  });
});

// ---------------------------------------------------------------------------
// Minimal fake DOM for mount()'s DOM-wiring tests.
//
// No DOM library is an actual dependency of this repo — jsdom/happy-dom show
// up only as vitest's own optional peers in package-lock.json, never
// installed in node_modules — and the correction card forbids adding a new
// one. This hand-rolled subset implements exactly what poll.client.js's
// mount() touches: getElementById, addEventListener (delegated at the
// document level, the same pattern booking.client.js's mount() uses),
// closest/querySelectorAll over the small attribute-selector subset mount()
// actually uses, dataset, classList, and the input/select properties mount()
// reads (value, checked, files).
// ---------------------------------------------------------------------------

class FakeElement {
  tagName: string;
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  value = "";
  checked = false;
  files: Array<{ text: () => Promise<string> }> | null = null;
  hasPointerCapture?: (pointerId: number) => boolean;
  releasePointerCapture?: (pointerId: number) => void;
  private _classes = new Set<string>();
  private _text = "";

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.has(name) ? this.attributes.get(name)! : null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  // Real DOM elements mirror the "id" attribute as a direct `.id` property,
  // and poll.client.js reads `e.target.id` directly (not getAttribute) in
  // its change/submit handlers — this must match or those checks silently
  // never fire.
  get id(): string {
    return this.attributes.get("id") ?? "";
  }
  set id(v: string) {
    this.attributes.set("id", v);
  }
  appendChild(child: FakeElement) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  get dataset(): Record<string, string> {
    const ds: Record<string, string> = {};
    for (const [k, v] of this.attributes) {
      if (k.startsWith("data-")) {
        const camel = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        ds[camel] = v;
      }
    }
    return ds;
  }
  get classList() {
    const self = this;
    return {
      add: (...names: string[]) => names.forEach((n) => self._classes.add(n)),
      remove: (...names: string[]) => names.forEach((n) => self._classes.delete(n)),
      contains: (n: string) => self._classes.has(n),
    };
  }
  set textContent(v: string) {
    this._text = String(v);
    this.children = [];
  }
  get textContent(): string {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join("");
  }
  closest(selector: string): FakeElement | null {
    let el: FakeElement | null = this;
    while (el) {
      if (matchesSelector(el, selector)) return el;
      el = el.parentElement;
    }
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const c of el.children) {
        if (matchesSelector(c, selector)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

/** Supports exactly the selector shapes mount() uses: `[attr]` and
 *  `[attr='value']`/`[attr="value"]`. */
function matchesSelector(el: FakeElement, selector: string): boolean {
  const m = selector.match(/^\[([\w-]+)(?:=(['"])(.*?)\2)?\]$/);
  if (!m) return false;
  const [, attr, , value] = m;
  const actual = el.getAttribute(attr!);
  if (actual === null) return false;
  return value === undefined || actual === value;
}

function makeFakeDocument(root: FakeElement) {
  const byId = new Map<string, FakeElement>();
  const indexIds = (el: FakeElement) => {
    const id = el.getAttribute("id");
    if (id) byId.set(id, el);
    for (const c of el.children) indexIds(c);
  };
  indexIds(root);
  const listeners = new Map<string, Array<(e: any) => any>>();
  return {
    getElementById: (id: string) => byId.get(id) ?? null,
    addEventListener: (type: string, fn: (e: any) => any) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type)!.push(fn);
    },
    createElement: (tag: string) => new FakeElement(tag),
    querySelectorAll: (sel: string) => root.querySelectorAll(sel),
    querySelector: (sel: string) => root.querySelector(sel),
    dispatch: async (type: string, event: any) => {
      const withDefaults = { preventDefault: () => {}, ...event };
      for (const fn of listeners.get(type) ?? []) await fn(withDefaults);
    },
  };
}

/** The real shell page.ts renders (per the pinned Fix-1a contract): #app
 *  carries data-poll-id/data-token/data-cell-minutes; the tools row has the
 *  two static [data-tool] buttons, [data-action=clear], #tzsel, and
 *  #ics-upload; #app-body wraps #grid and #responseform (#name, #hideName). */
function buildFakeShell(bootstrap: { pollId: string; token: string; cellMinutes: string }) {
  const app = new FakeElement("div");
  app.setAttribute("id", "app");
  app.setAttribute("data-poll-id", bootstrap.pollId);
  app.setAttribute("data-token", bootstrap.token);
  app.setAttribute("data-cell-minutes", bootstrap.cellMinutes);

  const status = new FakeElement("p");
  status.setAttribute("id", "status");
  status.textContent = "Loading\u2026";
  app.appendChild(status);

  const toolFree = new FakeElement("button");
  toolFree.setAttribute("type", "button");
  toolFree.setAttribute("data-tool", "free");
  toolFree.setAttribute("aria-pressed", "true");
  app.appendChild(toolFree);

  const toolIfNeeded = new FakeElement("button");
  toolIfNeeded.setAttribute("type", "button");
  toolIfNeeded.setAttribute("data-tool", "if_needed");
  toolIfNeeded.setAttribute("aria-pressed", "false");
  app.appendChild(toolIfNeeded);

  const clearBtn = new FakeElement("button");
  clearBtn.setAttribute("type", "button");
  clearBtn.setAttribute("data-action", "clear");
  app.appendChild(clearBtn);

  const tzsel = new FakeElement("select");
  tzsel.setAttribute("id", "tzsel");
  app.appendChild(tzsel);

  const icsUpload = new FakeElement("input");
  icsUpload.setAttribute("id", "ics-upload");
  icsUpload.setAttribute("type", "file");
  app.appendChild(icsUpload);

  const appBody = new FakeElement("div");
  appBody.setAttribute("id", "app-body");
  app.appendChild(appBody);

  const grid = new FakeElement("div");
  grid.setAttribute("id", "grid");
  appBody.appendChild(grid);

  const form = new FakeElement("form");
  form.setAttribute("id", "responseform");
  appBody.appendChild(form);

  const name = new FakeElement("input");
  name.setAttribute("id", "name");
  form.appendChild(name);

  const hideName = new FakeElement("input");
  hideName.setAttribute("id", "hideName");
  hideName.setAttribute("type", "checkbox");
  form.appendChild(hideName);

  const submitBtn = new FakeElement("button");
  submitBtn.setAttribute("id", "submit-btn");
  submitBtn.setAttribute("type", "submit");
  submitBtn.textContent = "Save my availability";
  form.appendChild(submitBtn);

  return { app, status, toolFree, toolIfNeeded, clearBtn, tzsel, icsUpload, grid, form, name, hideName, submitBtn };
}

async function withFakeDom(
  root: FakeElement,
  fetchMock: (...args: any[]) => any,
  run: (doc: ReturnType<typeof makeFakeDocument>) => Promise<void>,
) {
  const doc = makeFakeDocument(root);
  const g = globalThis as any;
  const prev = { Element: g.Element, document: g.document, fetch: g.fetch };
  g.Element = FakeElement;
  g.document = doc;
  g.fetch = fetchMock;
  try {
    await run(doc);
  } finally {
    g.Element = prev.Element;
    g.document = prev.document;
    g.fetch = prev.fetch;
  }
}

/** Flushes pending microtasks (a `setTimeout(…, 0)` macrotask only runs once
 *  every microtask ahead of it has drained), so any depth of chained
 *  `await`s inside mount()'s async handlers has settled by the time this
 *  returns. */
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

/** Cell ISO strings safely in the future relative to whenever this suite
 *  actually runs — mount()'s ICS pre-paint window is anchored on
 *  `Date.now()` (by design: it should not offer to pre-paint the past), so
 *  fixture dates hardcoded against "today" would silently go stale and make
 *  these tests flaky months later. */
function futureCell(daysAhead: number, minutesOffset = 0): string {
  const base = Date.now() + daysAhead * 86_400_000;
  const aligned = Math.floor(base / (30 * 60_000)) * 30 * 60_000;
  return new Date(aligned + minutesOffset * 60_000).toISOString();
}

/** UTC ms for local wall-clock time `h:00:00` on `y-mo-d` in `tz`. Mirrors
 *  poll.client.js's own (non-exported) wallTimeInTzToUtc — duplicated in
 *  miniature here for test fixtures that need a KNOWN, deterministic local
 *  time rather than "future relative to whenever this runs" (see the "Fix
 *  5" describe block below, whose historical flake was exactly this: a
 *  fixture computed from the real Date.now() straddling a local-day
 *  boundary depending on what wall-clock time the suite happened to run
 *  at). */
function utcForLocalHour(y: number, mo: number, d: number, h: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, 0, 0);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: tz,
  });
  const partsAt = (instant: number) => {
    const parts: Record<string, string> = {};
    for (const p of fmt.formatToParts(new Date(instant))) if (p.type !== "literal") parts[p.type] = p.value;
    return Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) === 24 ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second),
    );
  };
  let instant = guess;
  for (let i = 0; i < 2; i += 1) {
    const offset = partsAt(instant) - instant;
    instant = guess - offset;
  }
  return instant;
}

function fakeFile(text: string) {
  return { text: async () => text };
}

/** A fixed, safe "now" for tests whose fixture cells must never depend on
 *  the real wall-clock date: Monday 2026-08-24, 09:00 local in whatever
 *  IANA zone this environment resolves. Comfortably mid-week and
 *  mid-morning, so every `futureCell(daysAhead, …)` used against it across
 *  this file (5, 6, 10, 12) lands on a predictable day with hours of margin
 *  before the nearest local-day or local-week boundary — see the "Fix 5"
 *  describe block below for the flake this eliminates, and its own
 *  describe block for why "Fix 1c" and "Fix 6" needed the same treatment
 *  but "Fix 1b" (audited, not vulnerable) did not. */
const PINNED_NOW_MS = utcForLocalHour(2026, 8, 24, 9, Intl.DateTimeFormat().resolvedOptions().timeZone);

describe("mount() — Fix 1b: render() actually draws the invitee grid", () => {
  // Audited for the same real-Date.now() week/day-boundary risk as "Fix 1c"
  // and "Fix 6" below: NOT pinned, because none of this test's assertions
  // require C3 specifically to be present (only `cellButtons[0]`, whichever
  // that is, and a generic `.length > 0`) — C3 landing in a different day,
  // or even a different week, from C1/C2 cannot fail this test.
  it("renders week columns, paintable cells, tz options and a live status line, and paints on pointerdown", async () => {
    const C1 = futureCell(5, 0);
    const C2 = futureCell(5, 30);
    const C3 = futureCell(6, 0); // a different local day under UTC — by design, not a boundary bug
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [C1, C2, C3],
      durationMin: 30,
      aggregate: { [C1]: { free: 1, ifNeeded: 0 } },
      respondents: [
        { label: "Alex", responded: true },
        { label: "anonymous sea otter", responded: false },
      ],
      you: { cells: [], hideName: false, name: "" },
    };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => gridPayload }));

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();

      // Week grid: exactly 7 column headers (Monday-first), always, whether
      // or not every day in the week has paintable cells.
      const colHeaders = doc.querySelectorAll("[data-col-day]");
      expect(colHeaders.length).toBe(7);

      const cellButtons = doc.querySelectorAll("[data-cell]");
      expect(cellButtons.length).toBeGreaterThan(0);

      expect(shell.tzsel.children.length).toBeGreaterThan(0);

      expect(shell.status.textContent).not.toMatch(/Loading/);
      expect(shell.status.textContent).toMatch(/Alex/);

      const cellIso = cellButtons[0]!.getAttribute("data-cell")!;
      await doc.dispatch("pointerdown", { target: cellButtons[0]!, pointerId: 1 });

      const after = doc.querySelectorAll("[data-cell]").find((el) => el.getAttribute("data-cell") === cellIso)!;
      expect(after.classList.contains("free")).toBe(true);

      await doc.dispatch("click", { target: shell.toolIfNeeded });
      expect(shell.toolIfNeeded.getAttribute("aria-pressed")).toBe("true");
      expect(shell.toolFree.getAttribute("aria-pressed")).toBe("false");
    });
  });
});

describe("mount() — Fix 1c: touch drag releases implicit pointer capture", () => {
  // C1/C2 are 30 minutes apart and both must be found in the DOM (see
  // below) — same latent week/day-boundary risk as "Fix 5" (real
  // Date.now(), a narrow but non-zero window near local midnight on a
  // Sunday could split them across days or weeks). Pinned for the same
  // reason; see PINNED_NOW_MS's own comment.
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(PINNED_NOW_MS);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("releases capture on the anchor cell, and a drag paints every cell it crosses", async () => {
    const C1 = futureCell(5, 0);
    const C2 = futureCell(5, 30);
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [C1, C2],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      you: { cells: [], hideName: false, name: "" },
    };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => gridPayload }));

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();

      const cells = doc.querySelectorAll("[data-cell]");
      const cellA = cells.find((el) => el.getAttribute("data-cell") === C1)!;
      const cellB = cells.find((el) => el.getAttribute("data-cell") === C2)!;
      const released: number[] = [];
      cellA.hasPointerCapture = () => true;
      cellA.releasePointerCapture = (id: number) => released.push(id);

      await doc.dispatch("pointerdown", { target: cellA, pointerId: 7 });
      expect(released).toEqual([7]);

      await doc.dispatch("pointermove", { target: cellB, pointerId: 7 });

      const after = doc.querySelectorAll("[data-cell]");
      const paintedA = after.find((el) => el.getAttribute("data-cell") === C1)!;
      const paintedB = after.find((el) => el.getAttribute("data-cell") === C2)!;
      expect(paintedA.classList.contains("free")).toBe(true);
      expect(paintedB.classList.contains("free")).toBe(true);
    });
  });
});

describe("mount() — Fix 5: a second ICS upload actually replaces the first's suggestions", () => {
  // ROOT CAUSE of this suite's historical flake ("Cannot read properties of
  // undefined (reading 'classList')" on C3, intermittently): C1/C2/C3 are
  // offsets of a single futureCell(10, …) base up to one hour apart, and
  // futureCell reads the REAL Date.now() — so whenever the suite happened
  // to run late in the local day, that one-hour spread could straddle local
  // midnight and land C3 on a different LOCAL DAY than C1/C2. Before the
  // week grid (M2, T6b item 5), the invitee UI rendered only ONE selected
  // day at a time, so a cell pushed onto a neighbouring day was never in
  // the DOM at all — hence `c3` coming back `undefined`. This was a
  // date-dependent TEST FIXTURE bug, not a bug in the suggestion-precedence
  // logic itself (applyPrePaint/computeIcsPrePaint have their own direct,
  // deterministic unit tests above and were never at fault).
  //
  // The week grid closes the immediate gap (every day of the week renders
  // at once), but the fixture was still nondeterministic on principle — a
  // sufficiently unlucky run could in theory straddle a Sunday->Monday WEEK
  // boundary instead. Pin the clock (PINNED_NOW_MS, shared with "Fix 1c"
  // and "Fix 6" below, which have the same vulnerability) so this suite
  // never depends on real wall-clock time again, in either direction.
  // Provably safe: PINNED_NOW_MS is Monday 09:00 local, and +10 days lands
  // on a Thursday (verified: 2026-09-03) — the +0/+30/+60min spread stays
  // hours away from the nearest midnight, so C1/C2/C3 can never disagree on
  // local day, let alone local week, regardless of which zone runs this
  // suite (PINNED_NOW_MS is computed against the environment's own
  // resolved zone, not hardcoded to UTC or any particular zone).
  let C1: string, C2: string, C3: string;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(PINNED_NOW_MS);
    C1 = futureCell(10, 0);
    C2 = futureCell(10, 30);
    C3 = futureCell(10, 60);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const stamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");

  /** One VEVENT's worth of lines (no VCALENDAR wrapper) covering
   *  `[startIso, startIso+30min)` with the given STATUS. */
  function icsEvent(startIso: string, status: string): string {
    const startMs = Date.parse(startIso);
    return [
      "BEGIN:VEVENT",
      `DTSTART:${stamp(startIso)}`,
      `DTEND:${stamp(new Date(startMs + 30 * 60_000).toISOString())}`,
      `STATUS:${status}`,
      "END:VEVENT",
    ].join("\r\n");
  }

  const emptyIcs = ["BEGIN:VCALENDAR", "VERSION:2.0", "END:VCALENDAR"].join("\r\n");

  async function runTwoUploads(doc: ReturnType<typeof makeFakeDocument>, shell: ReturnType<typeof buildFakeShell>) {
    // Upload A: nothing busy -> all three cells pre-paint free.
    shell.icsUpload.files = [fakeFile(emptyIcs)];
    await doc.dispatch("change", { target: shell.icsUpload });
    await flush();

    // Hand-erase C2 (currently ICS-free, so the anchor is painted -> erase),
    // switch tool, then hand-paint C2 as if_needed. Two independent strokes,
    // matching the real drag model (a painted anchor always erases).
    const cellsAfterA = doc.querySelectorAll("[data-cell]");
    const c2 = cellsAfterA.find((el) => el.getAttribute("data-cell") === C2)!;
    await doc.dispatch("pointerdown", { target: c2, pointerId: 1 });
    await doc.dispatch("click", { target: shell.toolIfNeeded });
    const c2Again = doc.querySelectorAll("[data-cell]").find((el) => el.getAttribute("data-cell") === C2)!;
    await doc.dispatch("pointerdown", { target: c2Again, pointerId: 1 });

    // Upload B: confirmed busy over C1, tentative over C3; nothing over C2.
    const combined = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      icsEvent(C1, "CONFIRMED"),
      icsEvent(C3, "TENTATIVE"),
      "END:VCALENDAR",
    ].join("\r\n");
    shell.icsUpload.files = [fakeFile(combined)];
    await doc.dispatch("change", { target: shell.icsUpload });
    await flush();
  }

  it("(a) upload B's suggestions win over upload A's stale ones", async () => {
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [C1, C2, C3],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      you: { cells: [], hideName: false, name: "" },
    };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => gridPayload }));

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();
      await runTwoUploads(doc, shell);

      const cells = doc.querySelectorAll("[data-cell]");
      const c1 = cells.find((el) => el.getAttribute("data-cell") === C1);
      const c3 = cells.find((el) => el.getAttribute("data-cell") === C3)!;
      // C1 was A's stale "free" suggestion; B's confirmed busy means it must
      // no longer be painted at all.
      expect(c1 === undefined || (!c1.classList.contains("free") && !c1.classList.contains("if_needed"))).toBe(true);
      // C3 was A's stale "free" suggestion; B's tentative event moves it to if_needed.
      expect(c3.classList.contains("if_needed")).toBe(true);
      expect(c3.classList.contains("free")).toBe(false);
    });
  });

  it("(b) the hand-painted cell survives upload B unchanged", async () => {
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [C1, C2, C3],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      you: { cells: [], hideName: false, name: "" },
    };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => gridPayload }));

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();
      await runTwoUploads(doc, shell);

      const c2 = doc.querySelectorAll("[data-cell]").find((el) => el.getAttribute("data-cell") === C2)!;
      expect(c2.classList.contains("if_needed")).toBe(true); // the invitee's own choice, untouched by B
    });
  });

  it("(c) the file input's value is cleared after each upload", async () => {
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [C1, C2, C3],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      you: { cells: [], hideName: false, name: "" },
    };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => gridPayload }));

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();
      shell.icsUpload.value = "C:\\fakepath\\a.ics";
      shell.icsUpload.files = [fakeFile(emptyIcs)];
      await doc.dispatch("change", { target: shell.icsUpload });
      await flush();
      expect(shell.icsUpload.value).toBe("");
    });
  });
});

describe("mount() — Fix 6: a 400 on submit refreshes the grid instead of retrying the same body forever", () => {
  // Same latent risk as "Fix 1c": C1/C2 are 30 minutes apart, both must be
  // found in the DOM below, and futureCell reads the real Date.now(). Pinned
  // for the same reason; see PINNED_NOW_MS's own comment.
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(PINNED_NOW_MS);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-fetches the grid on a 400 and adopts the server's fresh cells", async () => {
    const C1 = futureCell(12, 0);
    const C2 = futureCell(12, 30);
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const initialPayload = {
      paintableCells: [C1],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      you: { cells: [], hideName: false, name: "" },
    };
    const refreshedPayload = {
      paintableCells: [C1, C2],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      you: { cells: [{ cell: C2, state: "free" }], hideName: false, name: "" },
    };
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, opts?: any) => {
      call += 1;
      if (opts && opts.method === "PUT") {
        return { ok: false, status: 400, json: async () => ({ error: "cell_not_paintable", cells: [C1] }) };
      }
      // GET calls: first is the initial load, second is the post-400 refresh.
      const body = call === 1 ? initialPayload : refreshedPayload;
      return { ok: true, status: 200, json: async () => body };
    });

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();

      const c1 = doc.querySelectorAll("[data-cell]").find((el) => el.getAttribute("data-cell") === C1)!;
      await doc.dispatch("pointerdown", { target: c1, pointerId: 1 });

      await doc.dispatch("submit", { target: shell.form });
      await flush();

      // initial GET, PUT (400), refresh GET.
      expect(fetchMock.mock.calls.length).toBe(3);
      const afterRefresh = doc.querySelectorAll("[data-cell]");
      const c2 = afterRefresh.find((el) => el.getAttribute("data-cell") === C2)!;
      expect(c2.classList.contains("free")).toBe(true); // adopted from the server's refreshed `you.cells`
    });
  });
});

// ---------------------------------------------------------------------------
// T6b work items, wired end-to-end through mount().
// ---------------------------------------------------------------------------

describe("mount() — T6b hover-who tooltips", () => {
  it("renders named Free/If-needed labels in the cell title when the grid payload carries them", async () => {
    const C1 = futureCell(5, 0);
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [C1],
      durationMin: 30,
      aggregate: { [C1]: { free: 2, ifNeeded: 1, freeWho: ["Alice", "quiet-heron"], ifNeededWho: ["Bob"] } },
      respondents: [],
      you: { cells: [], hideName: false, name: "" },
    };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => gridPayload }));

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();
      const cell = doc.querySelectorAll("[data-cell]").find((el) => el.getAttribute("data-cell") === C1)!;
      expect(cell.getAttribute("title")).toBe("Free: Alice, quiet-heron · If needed: Bob");
    });
  });

  it("falls back to the counts-only title for an older payload without freeWho/ifNeededWho", async () => {
    const C1 = futureCell(5, 0);
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [C1],
      durationMin: 30,
      aggregate: { [C1]: { free: 1, ifNeeded: 0 } },
      respondents: [],
      you: { cells: [], hideName: false, name: "" },
    };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => gridPayload }));

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();
      const cell = doc.querySelectorAll("[data-cell]").find((el) => el.getAttribute("data-cell") === C1)!;
      expect(cell.getAttribute("title")).toBe("1 free, 0 if needed");
    });
  });
});

describe("mount() — T6b M3 tz selector wiring", () => {
  it("populates the tz select with the viewer zone (default), ownerTz, and the common-zone list", async () => {
    const C1 = futureCell(5, 0);
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [C1],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      ownerTz: "America/New_York",
      you: { cells: [], hideName: false, name: "" },
    };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => gridPayload }));
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();
      const values = shell.tzsel.children.map((c) => c.getAttribute("value"));
      expect(values).toContain("America/New_York");
      expect(values).toContain(browserZone);
      for (const zone of COMMON_TZ_ZONES) expect(values).toContain(zone);
      const selected = shell.tzsel.children.find((c) => c.getAttribute("selected") === "selected");
      expect(selected?.getAttribute("value")).toBe(browserZone); // viewer's own zone is the default
    });
  });

  it("re-renders cell time labels in the newly selected zone via Intl, not manual offset arithmetic", async () => {
    const C1 = futureCell(5, 0);
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [C1],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      ownerTz: "America/New_York",
      you: { cells: [], hideName: false, name: "" },
    };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => gridPayload }));

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();
      shell.tzsel.value = "America/New_York";
      await doc.dispatch("change", { target: shell.tzsel });

      const after = doc.querySelectorAll("[data-cell]").find((el) => el.getAttribute("data-cell") === C1)!.textContent;
      const expected = new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/New_York",
      }).format(new Date(C1));
      expect(after).toBe(expected);
    });
  });
});

describe("mount() — L3 calendar-link stub", () => {
  it("adds a disabled 'Link my calendar (coming soon)' button next to the ICS upload control", async () => {
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      you: { cells: [], hideName: false, name: "" },
    };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => gridPayload }));

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();
      const stub = doc.querySelectorAll("[data-action='link-calendar-stub']");
      expect(stub).toHaveLength(1);
      expect(stub[0]!.getAttribute("disabled")).not.toBeNull();
      expect(stub[0]!.textContent).toMatch(/Link my calendar/i);
      expect(stub[0]!.textContent).toMatch(/coming soon/i);
      // Placed alongside the ICS upload control, not buried elsewhere.
      expect(stub[0]!.parentElement).toBe(shell.icsUpload.parentElement);
    });
  });
});

describe("mount() — F11 tool-button aria-pressed stays correct after other T6b changes", () => {
  it("keeps exactly one [data-tool] button pressed after switching tools", async () => {
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      you: { cells: [], hideName: false, name: "" },
    };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => gridPayload }));

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();
      await doc.dispatch("click", { target: shell.toolIfNeeded });
      const pressed = doc.querySelectorAll("[data-tool]").filter((el) => el.getAttribute("aria-pressed") === "true");
      expect(pressed).toHaveLength(1);
      expect(pressed[0]).toBe(shell.toolIfNeeded);
    });
  });
});

describe("mount() — T6b M2 week grid: pagination across weeks", () => {
  // Not pinned, unlike "Fix 1c"/"Fix 5"/"Fix 6" above: safe by construction
  // regardless of real Date.now(), because 7 calendar days is EXACTLY one
  // week — adding 7/14 days to any date always lands in the next/next-next
  // calendar week, never the same one, whatever day of the week the suite
  // happens to run on. The three weeks below are provably always distinct.
  it("shows prev/next week buttons only when an adjacent week has data, and pagination swaps which week's cells are shown", async () => {
    const C1 = futureCell(5, 0); // week W0 (earliest)
    const C2 = futureCell(12, 0); // week W1 — exactly one week after C1
    const C3 = futureCell(19, 0); // week W2 — exactly two weeks after C1
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [C1, C2, C3],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      you: { cells: [], hideName: false, name: "" },
    };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => gridPayload }));

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();

      // W0 (the earliest): C1 visible; no "previous week" at the range start.
      let cells = doc.querySelectorAll("[data-cell]").map((el) => el.getAttribute("data-cell"));
      expect(cells).toContain(C1);
      expect(cells).not.toContain(C2);
      expect(cells).not.toContain(C3);
      expect(doc.querySelectorAll("[data-action='prev-week']")).toHaveLength(0);
      expect(doc.querySelectorAll("[data-action='next-week']")).toHaveLength(1);

      // -> W1: C2 visible, both directions available.
      await doc.dispatch("click", { target: doc.querySelectorAll("[data-action='next-week']")[0]! });
      cells = doc.querySelectorAll("[data-cell]").map((el) => el.getAttribute("data-cell"));
      expect(cells).toContain(C2);
      expect(cells).not.toContain(C1);
      expect(cells).not.toContain(C3);
      expect(doc.querySelectorAll("[data-action='prev-week']")).toHaveLength(1);
      expect(doc.querySelectorAll("[data-action='next-week']")).toHaveLength(1);

      // -> W2 (the latest): C3 visible; no "next week" at the range end.
      await doc.dispatch("click", { target: doc.querySelectorAll("[data-action='next-week']")[0]! });
      cells = doc.querySelectorAll("[data-cell]").map((el) => el.getAttribute("data-cell"));
      expect(cells).toContain(C3);
      expect(cells).not.toContain(C1);
      expect(cells).not.toContain(C2);
      expect(doc.querySelectorAll("[data-action='prev-week']")).toHaveLength(1);
      expect(doc.querySelectorAll("[data-action='next-week']")).toHaveLength(0);

      // <- back to W1 via "previous week".
      await doc.dispatch("click", { target: doc.querySelectorAll("[data-action='prev-week']")[0]! });
      cells = doc.querySelectorAll("[data-cell]").map((el) => el.getAttribute("data-cell"));
      expect(cells).toContain(C2);
      expect(cells).not.toContain(C1);
      expect(cells).not.toContain(C3);
    });
  });
});

describe("mount() — T6b M2 week grid: tz switch re-groups a cell into a different column", () => {
  it("moves a cell into a different day column when the viewer changes timezone", async () => {
    // Pacific/Honolulu is a fixed UTC-10 (no DST) and Pacific/Kiritimati a
    // fixed UTC+14 (no DST) — a 24-hour offset gap, so for ANY UTC instant
    // Kiritimati's local date is exactly one calendar day ahead of
    // Honolulu's, always, regardless of what zone this test happens to run
    // in (unlike comparing against the host's own default zone, which is
    // whatever `Intl.DateTimeFormat().resolvedOptions().timeZone` resolves
    // to whichever machine — this fixture must not depend on that).
    const cellIso = "2027-01-13T12:00:00.000Z";
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [cellIso],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      you: { cells: [], hideName: false, name: "" },
    };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => gridPayload }));
    // Mirrors bucketSlotsByLocalDate's own date-key format (en-CA -> YYYY-MM-DD).
    const localDateIn = (tz: string) =>
      new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz }).format(
        new Date(cellIso),
      );

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();

      const findColumnOf = () =>
        doc
          .querySelectorAll("[data-col-day]")
          .find((el) => el.querySelectorAll("[data-cell]").some((c) => c.getAttribute("data-cell") === cellIso));

      shell.tzsel.value = "Pacific/Honolulu";
      await doc.dispatch("change", { target: shell.tzsel });
      const beforeDay = localDateIn("Pacific/Honolulu");
      expect(findColumnOf()?.getAttribute("data-col-day")).toBe(beforeDay);

      shell.tzsel.value = "Pacific/Kiritimati";
      await doc.dispatch("change", { target: shell.tzsel });
      const afterDay = localDateIn("Pacific/Kiritimati");
      // The fixture's whole point: the two zones must actually disagree on
      // the local date, or the assertion below would pass vacuously.
      expect(afterDay).not.toBe(beforeDay);
      expect(findColumnOf()?.getAttribute("data-col-day")).toBe(afterDay);
    });
  });
});

// ---------------------------------------------------------------------------
// Final-review fixes.
// ---------------------------------------------------------------------------

describe("mount() — HIGH: reopening a hidden invitee's link must not silently unhide them", () => {
  it("restores you.hideName/you.name into the form, so an untouched re-submit still carries hideName:true", async () => {
    // The bug: applyGridPayload never wrote body.you.hideName/body.you.name
    // into the #hideName checkbox / #name input, so a hidden invitee who
    // reopened their link saw an UNCHECKED box (default) despite being
    // hidden server-side. Any edit + save then submitted hideName:false —
    // unhiding them to every peer (respondents + freeWho labels) with no
    // warning. This defeats spec decision 7 on its main revision path.
    const C1 = futureCell(5, 0);
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [C1],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      you: { cells: [{ cell: C1, state: "free" }], hideName: true, name: "Carol" },
    };
    let putBody: any = null;
    const fetchMock = vi.fn(async (_url: string, opts?: any) => {
      if (opts && opts.method === "PUT") {
        putBody = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => gridPayload };
      }
      return { ok: true, status: 200, json: async () => gridPayload };
    });

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();

      // Deliberately untouched: no click on #hideName, no edit to #name —
      // the form must already reflect the server's saved values.
      expect(shell.hideName.checked).toBe(true);
      expect(shell.name.value).toBe("Carol");

      await doc.dispatch("submit", { target: shell.form });
      await flush();

      expect(putBody).not.toBeNull();
      expect(putBody.hideName).toBe(true);
      expect(putBody.name).toBe("Carol");
    });
  });

  it("defaults to unchecked/empty when you.hideName/you.name are absent (never throws)", async () => {
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      you: { cells: [], hideName: false, name: "" },
    };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => gridPayload }));

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();
      expect(shell.hideName.checked).toBe(false);
      expect(shell.name.value).toBe("");
    });
  });
});

describe("mount() — LOW: PUT 409 poll_closed gets a specific message", () => {
  it("shows a poll-closed message instead of the generic error", async () => {
    const C1 = futureCell(5, 0);
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [C1],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      you: { cells: [], hideName: false, name: "" },
    };
    const fetchMock = vi.fn(async (_url: string, opts?: any) => {
      if (opts && opts.method === "PUT") {
        return { ok: false, status: 409, json: async () => ({ error: "poll_closed" }) };
      }
      return { ok: true, status: 200, json: async () => gridPayload };
    });

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();
      const c1 = doc.querySelectorAll("[data-cell]").find((el) => el.getAttribute("data-cell") === C1)!;
      await doc.dispatch("pointerdown", { target: c1, pointerId: 1 });
      await doc.dispatch("submit", { target: shell.form });
      await flush();
      expect(shell.status.textContent).toMatch(/poll has closed/i);
      expect(shell.status.textContent).not.toMatch(/something went wrong/i);
    });
  });

  it("still falls back to the generic message for an unrecognised error code", async () => {
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      you: { cells: [], hideName: false, name: "" },
    };
    const fetchMock = vi.fn(async (_url: string, opts?: any) => {
      if (opts && opts.method === "PUT") {
        return { ok: false, status: 409, json: async () => ({ error: "plan_superseded" }) };
      }
      return { ok: true, status: 200, json: async () => gridPayload };
    });

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();
      await doc.dispatch("submit", { target: shell.form });
      await flush();
      expect(shell.status.textContent).toMatch(/something went wrong/i);
    });
  });
});

// ---------------------------------------------------------------------------
// Save feedback (poll-save-feedback fix): pressing Save gave no visible
// acknowledgement — the PUT worked, but applyGridPayload's render() ->
// renderStatus() silently overwrote #status with the respondent summary, so
// nothing ever told the invitee their click did anything. Covers the
// in-flight state, the success confirmation, every error branch re-enabling
// the button, and double-submit protection.
// ---------------------------------------------------------------------------

describe("mount() — save feedback: in-flight state and success confirmation", () => {
  it("shows 'Saving…' and disables the submit button while the PUT is in flight, then confirms success", async () => {
    const C1 = futureCell(5, 0);
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [C1],
      durationMin: 30,
      aggregate: {},
      respondents: [{ label: "Alex", responded: true }],
      you: { cells: [], hideName: false, name: "" },
    };
    let resolvePut: (v: unknown) => void;
    const putPromise = new Promise((resolve) => {
      resolvePut = resolve;
    });
    const fetchMock = vi.fn(async (_url: string, opts?: any) => {
      if (opts && opts.method === "PUT") return putPromise;
      return { ok: true, status: 200, json: async () => gridPayload };
    });

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();

      expect(shell.submitBtn.getAttribute("disabled")).toBeNull();

      const c1 = doc.querySelectorAll("[data-cell]").find((el) => el.getAttribute("data-cell") === C1)!;
      await doc.dispatch("pointerdown", { target: c1, pointerId: 1 });

      const dispatchPromise = doc.dispatch("submit", { target: shell.form });
      await Promise.resolve();
      await Promise.resolve();

      // In flight: immediate feedback, button disabled so a second click is
      // visibly (not just logically) blocked.
      expect(shell.status.textContent).toBe("Saving…");
      expect(shell.submitBtn.getAttribute("disabled")).not.toBeNull();

      resolvePut!({ ok: true, status: 200, json: async () => gridPayload });
      await dispatchPromise;
      await flush();

      // Success: confirmation set AFTER applyGridPayload, so renderStatus's
      // respondent summary doesn't clobber it back — and it keeps the
      // respondent labels too, not just the counts.
      expect(shell.status.textContent).toBe("Your availability has been saved. 1 of 1 responded: Alex");
      expect(shell.submitBtn.getAttribute("disabled")).toBeNull();
    });
  });

  it("re-enables the button and shows an error on a 400 (organiser's availability moved)", async () => {
    const C1 = futureCell(5, 0);
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [C1],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      you: { cells: [], hideName: false, name: "" },
    };
    const fetchMock = vi.fn(async (_url: string, opts?: any) => {
      if (opts && opts.method === "PUT") {
        return { ok: false, status: 400, json: async () => ({ error: "cell_not_paintable", cells: [C1] }) };
      }
      return { ok: true, status: 200, json: async () => gridPayload };
    });

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();
      const c1 = doc.querySelectorAll("[data-cell]").find((el) => el.getAttribute("data-cell") === C1)!;
      await doc.dispatch("pointerdown", { target: c1, pointerId: 1 });
      await doc.dispatch("submit", { target: shell.form });
      await flush();

      expect(shell.status.textContent).toMatch(/no longer available/i);
      expect(shell.submitBtn.getAttribute("disabled")).toBeNull();
    });
  });

  it("leaves the submit button DISABLED after a 409 poll_closed error — retrying is pointless", async () => {
    // Reviewer MINOR: unlike every other error branch (400/generic/network),
    // a 409 poll_closed means the poll is permanently closed. Re-enabling
    // the button here would invite a retry that can never succeed.
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      you: { cells: [], hideName: false, name: "" },
    };
    const fetchMock = vi.fn(async (_url: string, opts?: any) => {
      if (opts && opts.method === "PUT") {
        return { ok: false, status: 409, json: async () => ({ error: "poll_closed" }) };
      }
      return { ok: true, status: 200, json: async () => gridPayload };
    });

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();
      await doc.dispatch("submit", { target: shell.form });
      await flush();

      expect(shell.status.textContent).toMatch(/poll has closed/i);
      expect(shell.submitBtn.getAttribute("disabled")).not.toBeNull();
    });
  });

  it("re-enables the button on a generic (unrecognised) error response", async () => {
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      you: { cells: [], hideName: false, name: "" },
    };
    const fetchMock = vi.fn(async (_url: string, opts?: any) => {
      if (opts && opts.method === "PUT") return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => gridPayload };
    });

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();
      await doc.dispatch("submit", { target: shell.form });
      await flush();

      expect(shell.status.textContent).toMatch(/something went wrong/i);
      expect(shell.submitBtn.getAttribute("disabled")).toBeNull();
    });
  });

  it("re-enables the button when the PUT itself throws (network failure)", async () => {
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      you: { cells: [], hideName: false, name: "" },
    };
    const fetchMock = vi.fn(async (_url: string, opts?: any) => {
      if (opts && opts.method === "PUT") throw new Error("network down");
      return { ok: true, status: 200, json: async () => gridPayload };
    });

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();
      await doc.dispatch("submit", { target: shell.form });
      await flush();

      expect(shell.status.textContent).toMatch(/could not reach the server/i);
      expect(shell.submitBtn.getAttribute("disabled")).toBeNull();
    });
  });

  it("ignores a second submit fired while the first PUT is still in flight (no duplicate request)", async () => {
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      you: { cells: [], hideName: false, name: "" },
    };
    const fetchMock = vi.fn(async (_url: string, opts?: any) => {
      if (opts && opts.method === "PUT") return { ok: true, status: 200, json: async () => gridPayload };
      return { ok: true, status: 200, json: async () => gridPayload };
    });

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();

      const p1 = doc.dispatch("submit", { target: shell.form });
      const p2 = doc.dispatch("submit", { target: shell.form });
      await Promise.all([p1, p2]);
      await flush();

      const putCalls = fetchMock.mock.calls.filter(([, opts]) => opts && opts.method === "PUT");
      expect(putCalls.length).toBe(1);
    });
  });

  it("shows the full save confirmation (with the freshly-refreshed respondent summary) when the success body fails to parse but the refresh succeeds and the poll is still open", async () => {
    // Reviewer MINOR: a malformed/truncated JSON body after a 2xx PUT
    // response means the save still COMMITTED server-side — falling into
    // the generic network-error catch ("Could not reach the server") would
    // tell the invitee their save failed when it actually succeeded. Also
    // drops the stale "Refreshing the page…" wording (re-review NIT): by
    // the time this text is visible, the refresh has already finished.
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const refreshedPayload = {
      paintableCells: [],
      durationMin: 30,
      aggregate: {},
      respondents: [{ label: "Alex", responded: true }],
      you: { cells: [], hideName: false, name: "" },
    };
    let getCalls = 0;
    const fetchMock = vi.fn(async (_url: string, opts?: any) => {
      if (opts && opts.method === "PUT") {
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("truncated body");
          },
        };
      }
      getCalls += 1;
      return { ok: true, status: 200, json: async () => refreshedPayload };
    });

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();
      await doc.dispatch("submit", { target: shell.form });
      await flush();

      expect(shell.status.textContent).toBe("Your availability has been saved. 1 of 1 responded: Alex");
      expect(shell.status.textContent).not.toMatch(/could not reach the server/i);
      expect(shell.status.textContent).not.toMatch(/refreshing/i);
      expect(getCalls).toBe(2); // initial load, then the post-save refresh
      expect(shell.submitBtn.getAttribute("disabled")).toBeNull();
    });
  });

  it("keeps the 'saved' message (not loadGrid's own network-error text) when the malformed-body refresh ITSELF fails", async () => {
    // Reviewer MINOR (re-review): the recovery path could still end at
    // "Could not reach the server. Please try again." when the refresh GET
    // also failed — contradicting its own comment, since the original PUT
    // DID commit. The pre-refresh "saved" message must survive a failed
    // refresh, not get clobbered by loadGrid()'s own failure message.
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    let getCalls = 0;
    const fetchMock = vi.fn(async (_url: string, opts?: any) => {
      if (opts && opts.method === "PUT") {
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("truncated body");
          },
        };
      }
      getCalls += 1;
      if (getCalls === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            paintableCells: [],
            durationMin: 30,
            aggregate: {},
            respondents: [],
            you: { cells: [], hideName: false, name: "" },
          }),
        };
      }
      throw new Error("network down"); // the post-save refresh GET fails
    });

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();
      await doc.dispatch("submit", { target: shell.form });
      await flush();

      expect(shell.status.textContent).toBe("Your availability was saved.");
      expect(shell.status.textContent).not.toMatch(/could not reach the server/i);
    });
  });

  it("does not show the 'no longer available' message when a 400 refresh reveals the poll has closed", async () => {
    // Reviewer MINOR (re-review): the 400 handler unconditionally
    // overwrote #status after refreshing, even when the refresh revealed
    // the poll had closed in the meantime — clobbering renderOutcome()'s
    // message with an instruction to "check and save again" on a poll
    // that can no longer be saved to at all.
    const C1 = futureCell(5, 0);
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const openPayload = {
      paintableCells: [C1],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      you: { cells: [], hideName: false, name: "" },
    };
    const bookedPayload = { status: "booked" };
    let getCalls = 0;
    const fetchMock = vi.fn(async (_url: string, opts?: any) => {
      if (opts && opts.method === "PUT") {
        return { ok: false, status: 400, json: async () => ({ error: "cell_not_paintable", cells: [C1] }) };
      }
      getCalls += 1;
      // Initial load: open. Post-400 refresh: turns out to be booked.
      return { ok: true, status: 200, json: async () => (getCalls === 1 ? openPayload : bookedPayload) };
    });

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();
      const c1 = doc.querySelectorAll("[data-cell]").find((el) => el.getAttribute("data-cell") === C1)!;
      await doc.dispatch("pointerdown", { target: c1, pointerId: 1 });
      await doc.dispatch("submit", { target: shell.form });
      await flush();

      expect(shell.status.textContent).toBe("This meeting has been booked.");
      expect(shell.status.textContent).not.toMatch(/no longer available/i);
      expect(shell.status.textContent).not.toMatch(/check and save again/i);
    });
  });

  it("does not reassign #status.textContent when renderStatus recomputes the SAME text (aria-live spam guard, NIT)", async () => {
    // #status now carries aria-live="polite" (page.ts) — every drag-paint
    // stroke calls render() -> renderStatus(), and an assistive-tech
    // announcement on every single cell painted (even though the
    // respondent summary never changed) would be spam. Guard by comparing
    // before assigning.
    const C1 = futureCell(5, 0);
    const C2 = futureCell(5, 30);
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const gridPayload = {
      paintableCells: [C1, C2],
      durationMin: 30,
      aggregate: {},
      respondents: [{ label: "Alex", responded: true }],
      you: { cells: [], hideName: false, name: "" },
    };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => gridPayload }));

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();

      // Wrap the instance's textContent setter (after the initial load has
      // already set its baseline text) so subsequent renders that recompute
      // the SAME text can be counted without touching FakeElement itself.
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(shell.status), "textContent")!;
      let setCount = 0;
      Object.defineProperty(shell.status, "textContent", {
        configurable: true,
        get: descriptor.get,
        set(v: string) {
          setCount += 1;
          descriptor.set!.call(this, v);
        },
      });

      const cells = doc.querySelectorAll("[data-cell]");
      const cellA = cells.find((el) => el.getAttribute("data-cell") === C1)!;
      const cellB = cells.find((el) => el.getAttribute("data-cell") === C2)!;
      // Two paint strokes in a row: the respondent summary (what #status
      // shows) never changes across either — only grid cells do.
      await doc.dispatch("pointerdown", { target: cellA, pointerId: 1 });
      await doc.dispatch("pointerdown", { target: cellB, pointerId: 2 });

      expect(setCount).toBe(0);
      expect(shell.status.textContent).toBe("1 of 1 responded: Alex");
    });
  });
});

// ---------------------------------------------------------------------------
// renderOutcome() must update #status itself (save feedback fix, reviewer
// MAJOR): #status lives in page.ts's `.head` block, OUTSIDE #app-body (which
// is all renderOutcome used to rewrite) — so without this, #status is stuck
// on whatever it said before the poll turned out to be closed: "Loading…"
// on first load, or "Saving…" if the poll closed/booked mid-save.
// ---------------------------------------------------------------------------

describe("mount() — renderOutcome() must update #status, not leave it stuck", () => {
  it("replaces a stuck 'Loading…' with the outcome message when the poll is ALREADY closed on first load", async () => {
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const closedPayload = { status: "cancelled" };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => closedPayload }));

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();

      expect(shell.status.textContent).toBe("This poll was cancelled.");
      expect(shell.status.textContent).not.toMatch(/Loading/);
    });
  });

  it("replaces a stuck 'Saving…' with the outcome message when the poll closes/books DURING the save", async () => {
    const C1 = futureCell(5, 0);
    const shell = buildFakeShell({ pollId: "p_1", token: "tok", cellMinutes: "30" });
    const openPayload = {
      paintableCells: [C1],
      durationMin: 30,
      aggregate: {},
      respondents: [],
      you: { cells: [], hideName: false, name: "" },
    };
    const bookedPayload = { status: "booked" };
    const fetchMock = vi.fn(async (_url: string, opts?: any) => {
      if (opts && opts.method === "PUT") return { ok: true, status: 200, json: async () => bookedPayload };
      return { ok: true, status: 200, json: async () => openPayload };
    });

    await withFakeDom(shell.app, fetchMock, async (doc) => {
      mount(shell.app);
      await flush();
      const c1 = doc.querySelectorAll("[data-cell]").find((el) => el.getAttribute("data-cell") === C1)!;
      await doc.dispatch("pointerdown", { target: c1, pointerId: 1 });
      await doc.dispatch("submit", { target: shell.form });
      await flush();

      expect(shell.status.textContent).toBe("This meeting has been booked.");
      expect(shell.status.textContent).not.toBe("Saving…");
      expect(shell.status.textContent).not.toMatch(/saved/i);
      expect(shell.submitBtn.getAttribute("disabled")).toBeNull();
    });
  });
});
