// Card E (internal design notes): a preferred window carrying its own
// `tz` is re-expressed in the problem tz, so a user-tz change never moves it.
import { describe, it, expect, vi, afterEach } from "vitest";
import { projectPreferredWindows } from "../../src/planning/window-projection";

const SYD = "Australia/Sydney";
const LON = "Europe/London";
const LA = "America/Los_Angeles";

// Problem horizons: the local Mon 00:00 → next Mon 00:00 week, as ISO instants.
const LON_MAY = { start: "2026-05-17T23:00:00.000Z", end: "2026-05-24T23:00:00.000Z" }; // BST all week
const LA_MAY = { start: "2026-05-18T07:00:00.000Z", end: "2026-05-25T07:00:00.000Z" };
// London week of Mon 30 Mar 2026: London already BST; Sydney AEDT until Sun 5 Apr 03:00.
const LON_APR = { start: "2026-03-29T23:00:00.000Z", end: "2026-04-05T23:00:00.000Z" };
// Sydney week of Mon 23 Mar 2026 (AEDT): London goes BST on Sun 29 Mar 01:00.
const SYD_MAR = { start: "2026-03-22T13:00:00.000Z", end: "2026-03-29T13:00:00.000Z" };

const project = (ws: unknown[], tz: string, h: { start: string; end: string }) =>
  projectPreferredWindows(ws as never, tz, h.start, h.end);

describe("projectPreferredWindows: pass-through", () => {
  it("returns the same array when no window carries a tz (byte-identical wire)", () => {
    const ws = [{ days: ["tue"], start: "14:00", end: "16:00", hard: false }];
    const out = project(ws, LON, LON_MAY);
    expect(out.preferred_windows).toBe(ws);
    expect(out.availability_windows).toBeNull();
  });

  it("strips tz when it equals the problem tz (canonically)", () => {
    const ws = [
      { days: ["tue"], start: "14:00", end: "16:00", hard: true, tz: LON },
      { days: ["wed"], start: "09:00", end: "10:00", hard: false, tz: "europe/london" },
    ];
    const out = project(ws, LON, LON_MAY);
    expect(out.preferred_windows).toEqual([
      { days: ["tue"], start: "14:00", end: "16:00", hard: true },
      { days: ["wed"], start: "09:00", end: "10:00", hard: false },
    ]);
    expect(JSON.stringify(out.preferred_windows)).not.toContain("tz");
    expect(out.availability_windows).toBeNull();
  });

  it("empty/undefined windows project to an empty list", () => {
    expect(project(undefined as never, LON, LON_MAY).preferred_windows).toEqual([]);
  });
});

describe("projectPreferredWindows: foreign tz", () => {
  it("Sydney Tue 14:00–16:00 → London Tue 05:00–07:00 (soft and hard)", () => {
    for (const hard of [false, true]) {
      const out = project([{ days: ["tue"], start: "14:00", end: "16:00", hard, tz: SYD }], LON, LON_MAY);
      expect(out.preferred_windows).toEqual([{ days: ["tue"], start: "05:00", end: "07:00", hard }]);
      expect(out.availability_windows).toBeNull();
    }
  });

  it("Sydney Tue 14:00–16:00 → Los Angeles Mon 21:00–23:00 (weekday shifts back)", () => {
    const out = project([{ days: ["tue"], start: "14:00", end: "16:00", hard: true, tz: SYD }], LA, LA_MAY);
    expect(out.preferred_windows).toEqual([{ days: ["mon"], start: "21:00", end: "23:00", hard: true }]);
    expect(out.availability_windows).toBeNull();
  });

  it("a window ending at problem-local midnight: soft ends 23:59, hard becomes an exact mask", () => {
    // Sydney Tue 31 Mar 08:00–10:00 AEDT = London Mon 30 Mar 22:00–24:00 BST.
    const soft = project([{ days: ["tue"], start: "08:00", end: "10:00", hard: false, tz: SYD }], LON, LON_APR);
    expect(soft.preferred_windows).toEqual([{ days: ["mon"], start: "22:00", end: "23:59", hard: false }]);
    expect(soft.availability_windows).toBeNull();

    const hard = project([{ days: ["tue"], start: "08:00", end: "10:00", hard: true, tz: SYD }], LON, LON_APR);
    expect(hard.preferred_windows).toEqual([]);
    expect(hard.availability_windows).toEqual([{ start: "2026-03-30T22:00:00", end: "2026-03-31T00:00:00" }]);
  });

  it("a window crossing problem-local midnight: soft splits into two, hard stays one contiguous mask interval", () => {
    // Sydney Tue 31 Mar 09:00–11:00 AEDT = London Mon 30 Mar 23:00 → Tue 01:00 BST.
    const soft = project([{ days: ["tue"], start: "09:00", end: "11:00", hard: false, tz: SYD }], LON, LON_APR);
    expect(soft.preferred_windows).toEqual([
      { days: ["mon"], start: "23:00", end: "23:59", hard: false },
      { days: ["tue"], start: "00:00", end: "01:00", hard: false },
    ]);
    const hard = project([{ days: ["tue"], start: "09:00", end: "11:00", hard: true, tz: SYD }], LON, LON_APR);
    expect(hard.preferred_windows).toEqual([]);
    expect(hard.availability_windows).toEqual([{ start: "2026-03-30T23:00:00", end: "2026-03-31T01:00:00" }]);
  });

  it("clips to the horizon: Sydney Mon 08:00–10:00 lands on London Sun 23:00 at the week's end", () => {
    // Mon 30 Mar 08:00 AEDT = Sun 29 Mar 22:00 BST (before the week); Mon 6 Apr
    // 08:00 AEST = Sun 5 Apr 23:00 BST → Mon 01:00, clipped at the week end.
    const soft = project([{ days: ["mon"], start: "08:00", end: "10:00", hard: false, tz: SYD }], LON, LON_APR);
    expect(soft.preferred_windows).toEqual([{ days: ["sun"], start: "23:00", end: "23:59", hard: false }]);
    const hard = project([{ days: ["mon"], start: "08:00", end: "10:00", hard: true, tz: SYD }], LON, LON_APR);
    expect(hard.availability_windows).toEqual([{ start: "2026-04-05T23:00:00", end: "2026-04-06T00:00:00" }]);
  });

  it("a DST change mid-week yields two shapes: soft windows grouped by shape, hard an exact mask", () => {
    const all = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    // Sydney leaves AEDT on Sun 5 Apr: 14:00 is 04:00 BST Mon–Sat, 05:00 BST on Sunday.
    const soft = project([{ days: all, start: "14:00", end: "16:00", hard: false, tz: SYD }], LON, LON_APR);
    expect(soft.preferred_windows).toEqual([
      { days: ["mon", "tue", "wed", "thu", "fri", "sat"], start: "04:00", end: "06:00", hard: false },
      { days: ["sun"], start: "05:00", end: "07:00", hard: false },
    ]);
    const hard = project([{ days: all, start: "14:00", end: "16:00", hard: true, tz: SYD }], LON, LON_APR);
    expect(hard.preferred_windows).toEqual([]);
    expect(hard.availability_windows).toEqual([
      { start: "2026-03-30T04:00:00", end: "2026-03-30T06:00:00" },
      { start: "2026-03-31T04:00:00", end: "2026-03-31T06:00:00" },
      { start: "2026-04-01T04:00:00", end: "2026-04-01T06:00:00" },
      { start: "2026-04-02T04:00:00", end: "2026-04-02T06:00:00" },
      { start: "2026-04-03T04:00:00", end: "2026-04-03T06:00:00" },
      { start: "2026-04-04T04:00:00", end: "2026-04-04T06:00:00" },
      { start: "2026-04-05T05:00:00", end: "2026-04-05T07:00:00" },
    ]);
  });

  it("a nonexistent source time (DST gap) moves forward to the transition", () => {
    // London Sun 29 Mar 01:00 does not exist (01:00 GMT → 02:00 BST): 01:00–03:00
    // is the instants 01:00Z–02:00Z = Sydney Sun 12:00–13:00 AEDT.
    const out = project([{ days: ["sun"], start: "01:00", end: "03:00", hard: false, tz: LON }], SYD, SYD_MAR);
    expect(out.preferred_windows).toEqual([{ days: ["sun"], start: "12:00", end: "13:00", hard: false }]);
  });

  it("a hard window whose days miss the horizon entirely can never be satisfied", () => {
    // Horizon = Wed 20 May only (London); a Sydney Mon window never overlaps it.
    const h = { start: "2026-05-19T23:00:00.000Z", end: "2026-05-20T23:00:00.000Z" };
    const out = project([{ days: ["mon"], start: "09:00", end: "10:00", hard: true, tz: SYD }], LON, h);
    expect(out.preferred_windows).toEqual([]);
    // A mask with no in-horizon room: every start is excluded, so the chunk drops.
    expect(out.availability_windows).toEqual([{ start: "2026-05-21T00:00:00", end: "2026-05-21T00:15:00" }]);
  });

  it("intersects several foreign hard windows into one mask", () => {
    const out = project(
      [
        { days: ["tue"], start: "08:00", end: "10:00", hard: true, tz: SYD }, // Mon 22:00–24:00 BST
        { days: ["tue"], start: "08:30", end: "11:00", hard: true, tz: SYD }, // Mon 22:30–Tue 01:00
      ],
      LON,
      LON_APR,
    );
    expect(out.availability_windows).toEqual([{ start: "2026-03-30T22:30:00", end: "2026-03-31T00:00:00" }]);
  });

  it("keeps pass-through windows alongside projected ones and merges identical results", () => {
    const out = project(
      [
        { days: ["wed"], start: "09:00", end: "10:00", hard: false },
        { days: ["tue"], start: "14:00", end: "16:00", hard: false, tz: SYD },
        { days: ["tue"], start: "05:00", end: "07:00", hard: false, tz: LON },
      ],
      LON,
      LON_MAY,
    );
    expect(out.preferred_windows).toEqual([
      { days: ["wed"], start: "09:00", end: "10:00", hard: false },
      { days: ["tue"], start: "05:00", end: "07:00", hard: false },
    ]);
  });

  it("rounds a mask inward to quarter hours (a 23:59 source end)", () => {
    // Sydney Tue 00:00–23:59 hard in May = London Mon 15:00 → Tue 14:59 BST.
    const out = project([{ days: ["tue"], start: "00:00", end: "23:59", hard: true, tz: SYD }], LON, LON_MAY);
    expect(out.availability_windows).toEqual([{ start: "2026-05-18T15:00:00", end: "2026-05-19T14:45:00" }]);
  });
});

describe("projectPreferredWindows: odd stored times", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads an end of 24:00 as end of day (Sydney Tue 14:00–24:00 → London Tue 05:00–15:00)", () => {
    for (const hard of [false, true]) {
      const out = project([{ days: ["tue"], start: "14:00", end: "24:00", hard, tz: SYD }], LON, LON_MAY);
      expect(out.preferred_windows).toEqual([{ days: ["tue"], start: "05:00", end: "15:00", hard }]);
      expect(out.availability_windows).toBeNull();
    }
  });

  it("a 24:00 end that lands on problem-local midnight splits like any other window", () => {
    // Sydney Tue 31 Mar 00:00–24:00 AEDT = London Mon 30 Mar 14:00 → Tue 14:00 BST.
    const out = project([{ days: ["tue"], start: "00:00", end: "24:00", hard: false, tz: SYD }], LON, LON_APR);
    expect(out.preferred_windows).toEqual([
      { days: ["mon"], start: "14:00", end: "23:59", hard: false },
      { days: ["tue"], start: "00:00", end: "14:00", hard: false },
    ]);
  });

  it("an unparseable time never throws: the window passes through unprojected (tz stripped), logged once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ws = [
      { days: ["tue"], start: "9am", end: "16:00", hard: true, tz: SYD },
      { days: ["wed"], start: "10:00", end: "25:00", hard: false, tz: SYD },
      { days: ["tue"], start: "14:00", end: "16:00", hard: false, tz: SYD },
    ];
    const out = project(ws, LON, LON_MAY);
    expect(out.preferred_windows).toEqual([
      { days: ["tue"], start: "9am", end: "16:00", hard: true },
      { days: ["wed"], start: "10:00", end: "25:00", hard: false },
      { days: ["tue"], start: "05:00", end: "07:00", hard: false },
    ]);
    expect(out.availability_windows).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
