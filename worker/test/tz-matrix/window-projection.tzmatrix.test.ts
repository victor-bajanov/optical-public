// tz-matrix mirror of test/planning/window-projection.test.ts: a hard
// preferred window stored in zone SRC, projected into problem zone P, must
// allow exactly the real instants the SRC window covers. Checked on every
// quarter-hour of the horizon by reading each instant's P-local naive time the
// way the solver does (its slot model is P-local naive wall clock).
//
// The slot model decides what "exactly" can mean on a fall-back day: a naive
// slot inside the repeated hour always lands on the EARLIER instant
// (parseSolution -> fromLocalNaiveCompatible), so the second instance of that
// hour is unreachable for every window. A slot is therefore judged at the
// instant a placement there actually lands, not at the instant being iterated.
import { describe, it, expect } from "vitest";
import { projectPreferredWindows } from "../../src/planning/window-projection";
import { MATRIX_ZONES, MIDNIGHT_GAP_ZONES, addDays, dayStart, local, localMonday, transitions, wallInstants } from "./zones";

const ALL_ZONES = [...new Set([...MATRIX_ZONES, ...MIDNIGHT_GAP_ZONES])];
const Q = 15 * 60_000;
const WD = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function srcAllowed(q: number, src: string, w: { days: string[]; start: string; end: string }): boolean {
  const l = local(q, src);
  return w.days.includes(WD[l.weekday]!) && l.time >= w.start && l.time < w.end;
}

function projectedAllowed(q: number, p: string, out: ReturnType<typeof projectPreferredWindows>): boolean {
  const l = local(q, p);
  const naive = Date.parse(l.naive + "Z");
  const hardWins = out.preferred_windows.filter((w) => w.hard);
  const inWins = hardWins.every((w) => (w.days as string[]).includes(WD[l.weekday]!) && l.time >= w.start && l.time < w.end);
  const inMask = out.availability_windows === null
    ? true
    : out.availability_windows.some((m) => naive >= Date.parse(m.start + "Z") && naive < Date.parse(m.end + "Z"));
  return inWins && inMask;
}

function horizons(p: string): Array<[string, number, number]> {
  const mons = new Set<string>(["2026-07-13"]);
  for (const t of transitions(p, 2026)) mons.add(localMonday(t.atMs, p));
  return [...mons].map((m) => [m, dayStart(m, p), dayStart(addDays(m, 7), p)]);
}

function mismatches(src: string, p: string): string[] {
  const w = { days: ["tue", "sat"] as Array<"tue" | "sat">, start: "14:00", end: "16:00", hard: true, tz: src };
  const bad: string[] = [];
  for (const [mon, h0, h1] of horizons(p)) {
    const out = projectPreferredWindows([w], p, new Date(h0).toISOString(), new Date(h1).toISOString());
    for (let q = h0; q < h1; q += Q) {
      const l = local(q, p);
      const landsAt = wallInstants(l.date, l.time, p)[0]!;
      const want = srcAllowed(landsAt, src, w);
      const got = projectedAllowed(q, p, out);
      if (want !== got) bad.push(`${mon}: ${new Date(q).toISOString()} (${local(q, p).naive} ${p}) want=${want} got=${got}`);
    }
  }
  return bad;
}

describe.each(ALL_ZONES)("projectPreferredWindows, window stored in %s", (src) => {
  it.each(["Australia/Sydney", "America/Los_Angeles", "UTC"])("projected into %s allows exactly the source instants", (p) => {
    if (src === p) return;
    expect(mismatches(src, p).slice(0, 6).join("\n")).toBe("");
  });
});

describe.each(ALL_ZONES)("projectPreferredWindows, problem zone %s", (p) => {
  it.each(["Australia/Sydney", "America/Los_Angeles", "Asia/Kathmandu"])("a window stored in %s allows exactly its source instants", (src) => {
    if (src === p) return;
    expect(mismatches(src, p).slice(0, 6).join("\n")).toBe("");
  });
});

describe("oracle", () => {
  it("Santiago 2026-09-06 00:30 does not exist", () => {
    expect(wallInstants("2026-09-06", "00:30", "America/Santiago")).toEqual([]);
  });
});
