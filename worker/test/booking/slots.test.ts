import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  computeBookableSlots,
  slotStepForDurations,
  validateDurations,
  DurationError,
  validateHorizons,
  HorizonError,
  pageWindow,
  pageForStart,
} from "../../src/booking/slots";
import { claimSlot, failBooking } from "../../src/db/bookings";

const TZ = "Australia/Sydney";
const HOURS = { days: ["mon", "tue", "wed", "thu", "fri"], start: "10:00", end: "16:00" } as any;

// Mon 2026-08-03 10:00 +10 == 2026-08-03T00:00:00Z
const MONDAY_10AM = Date.parse("2026-08-03T00:00:00Z");
const NOW = Date.parse("2026-08-01T00:00:00Z"); // Sat
const DAY = 86_400_000;

function params(over: Record<string, unknown> = {}) {
  return {
    tz: TZ,
    hours: HOURS,
    nowMs: NOW,
    minNoticeMinutes: 0,
    windowStartMs: NOW,
    windowEndMs: NOW + 3 * DAY,
    durationMinutes: 30,
    slotStepMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    busy: [] as Array<{ startUtc: string; endUtc: string }>,
    ...over,
  } as Parameters<typeof computeBookableSlots>[0];
}

describe("slotStepForDurations", () => {
  it("uses a 15-minute grid only when 15 is offered", () => {
    expect(slotStepForDurations([30, 60])).toBe(30);
    expect(slotStepForDurations([15, 60])).toBe(15);
  });
});

describe("validateDurations", () => {
  it("rejects non-multiples of 15 and anything under 15", () => {
    expect(() => validateDurations([30])).not.toThrow();
    expect(() => validateDurations([20])).toThrow(DurationError);
    expect(() => validateDurations([0])).toThrow(DurationError);
    expect(() => validateDurations([])).toThrow(DurationError);
  });
});

describe("validateHorizons", () => {
  it("accepts a null reach (no paging) and a reach at or beyond one page", () => {
    expect(() => validateHorizons(21, null)).not.toThrow();
    expect(() => validateHorizons(21, 21)).not.toThrow();
    expect(() => validateHorizons(21, 180)).not.toThrow();
  });

  it("rejects a reach shorter than one page", () => {
    // The schema bounds each field alone; a max below the page size would
    // clamp page 0 to less than what the owner set horizon_days to, and
    // nothing on the page would say why.
    expect(() => validateHorizons(21, 20)).toThrow(HorizonError);
  });
});

describe("pageWindow", () => {
  // Pages are contiguous, half-open, ms-exact windows off `now`, so page 0 is
  // byte-for-byte today's single window and a day straddling a boundary is
  // split, never duplicated or dropped.
  it("page 0 is [now, now + horizon), and hasMore reflects the reach", () => {
    expect(pageWindow(NOW, 0, 21, null)).toEqual({ startMs: NOW, endMs: NOW + 21 * DAY, hasMore: false });
    expect(pageWindow(NOW, 0, 21, 21)).toEqual({ startMs: NOW, endMs: NOW + 21 * DAY, hasMore: false });
    expect(pageWindow(NOW, 0, 21, 22)).toEqual({ startMs: NOW, endMs: NOW + 21 * DAY, hasMore: true });
  });

  it("page k is [now + k*horizon, now + (k+1)*horizon), clamped to the reach", () => {
    expect(pageWindow(NOW, 1, 21, 180)).toEqual({ startMs: NOW + 21 * DAY, endMs: NOW + 42 * DAY, hasMore: true });
    // 180 / 21 = 8.57 pages: page 8 is the short tail [168, 180).
    expect(pageWindow(NOW, 8, 21, 180)).toEqual({ startMs: NOW + 168 * DAY, endMs: NOW + 180 * DAY, hasMore: false });
  });

  it("is null past the reach, and for anything that is not a non-negative integer", () => {
    expect(pageWindow(NOW, 9, 21, 180)).toBeNull();
    expect(pageWindow(NOW, 1, 21, null)).toBeNull();
    expect(pageWindow(NOW, 1, 21, 21)).toBeNull();
    expect(pageWindow(NOW, -1, 21, 180)).toBeNull();
    expect(pageWindow(NOW, 1.5, 21, 180)).toBeNull();
    expect(pageWindow(NOW, Number.NaN, 21, 180)).toBeNull();
  });
});

describe("pageForStart", () => {
  it("names the page whose window holds the start", () => {
    expect(pageForStart(NOW, NOW, 21)).toBe(0);
    expect(pageForStart(NOW, NOW + 21 * DAY - 1, 21)).toBe(0);
    expect(pageForStart(NOW, NOW + 21 * DAY, 21)).toBe(1);
    expect(pageForStart(NOW, NOW + 100 * DAY, 21)).toBe(4);
  });

  it("floors a start in the past to page 0 — availability then refuses it as any other stale start", () => {
    expect(pageForStart(NOW, NOW - DAY, 21)).toBe(0);
  });
});

describe("computeBookableSlots", () => {
  it("offers slots only inside business hours, on the grid", () => {
    const slots = computeBookableSlots(params());
    expect(slots[0]).toBe("2026-08-03T00:00:00.000Z");        // Mon 10:00
    expect(slots).toContain("2026-08-03T05:30:00.000Z");      // Mon 15:30 (last that fits)
    expect(slots).not.toContain("2026-08-03T06:00:00.000Z");  // Mon 16:00 — would end at 16:30
    // Saturday and Sunday are excluded entirely.
    expect(slots.every((s) => !s.startsWith("2026-08-01") && !s.startsWith("2026-08-02"))).toBe(true);
  });

  it("subtracts busy time", () => {
    const slots = computeBookableSlots(params({
      busy: [{ startUtc: "2026-08-03T00:00:00Z", endUtc: "2026-08-03T01:00:00Z" }],
    }));
    expect(slots).not.toContain("2026-08-03T00:00:00.000Z");
    expect(slots).not.toContain("2026-08-03T00:30:00.000Z");
    expect(slots).toContain("2026-08-03T01:00:00.000Z");
  });

  it("applies asymmetric buffers around busy time", () => {
    const slots = computeBookableSlots(params({
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 30,
      busy: [{ startUtc: "2026-08-03T00:00:00Z", endUtc: "2026-08-03T01:00:00Z" }],
    }));
    expect(slots).not.toContain("2026-08-03T01:00:00.000Z"); // inside the after-buffer
    expect(slots).toContain("2026-08-03T01:30:00.000Z");
  });

  it("respects the minimum-notice floor", () => {
    const slots = computeBookableSlots(params({
      nowMs: MONDAY_10AM,          // Mon 10:00
      minNoticeMinutes: 120,       // nothing before Mon 12:00
    }));
    expect(slots[0]).toBe("2026-08-03T02:00:00.000Z");
  });

  it("respects the window ceiling", () => {
    const slots = computeBookableSlots(params({ windowEndMs: NOW + 1 * DAY }));
    expect(slots).toHaveLength(0); // Sat + 1 day is still the weekend
  });

  it("respects the window floor: a later page offers nothing before its own start", () => {
    // Page 1 of a 3-day horizon: [Tue 00:00Z, Fri 00:00Z). Monday is inside the
    // hours and busy-free, but belongs to page 0 — it must not appear here.
    const slots = computeBookableSlots(params({
      windowStartMs: NOW + 3 * DAY,
      windowEndMs: NOW + 6 * DAY,
    }));
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((s) => Date.parse(s) >= NOW + 3 * DAY)).toBe(true);
    expect(slots.every((s) => Date.parse(s) < NOW + 6 * DAY)).toBe(true);
    expect(slots).not.toContain("2026-08-03T00:00:00.000Z"); // Mon 10:00 — page 0's
  });

  it("the min-notice floor still wins over a window start that precedes it", () => {
    // now = Mon 10:00, notice 120 min, window starts at now: the floor is
    // max(windowStart, now + notice) = Mon 12:00, exactly as before paging.
    const slots = computeBookableSlots(params({
      nowMs: MONDAY_10AM,
      windowStartMs: MONDAY_10AM,
      windowEndMs: MONDAY_10AM + 3 * DAY,
      minNoticeMinutes: 120,
    }));
    expect(slots[0]).toBe("2026-08-03T02:00:00.000Z");
  });

  it("uses a 15-minute grid when asked", () => {
    const slots = computeBookableSlots(params({ durationMinutes: 15, slotStepMinutes: 15 }));
    expect(slots).toContain("2026-08-03T00:15:00.000Z");
  });

  it("only offers a start whose whole duration fits one free interval", () => {
    const slots = computeBookableSlots(params({
      durationMinutes: 60,
      busy: [{ startUtc: "2026-08-03T00:30:00Z", endUtc: "2026-08-03T01:00:00Z" }],
    }));
    expect(slots).not.toContain("2026-08-03T00:00:00.000Z"); // 60 min would hit the busy block
    expect(slots).toContain("2026-08-03T01:00:00.000Z");
  });

  // W1 — the grid must never offer a start that claimSlot's guard would then
  // reject. claimSlot's overlap probe (worker/src/db/bookings.ts) re-pads a
  // same-owner row on top of the new candidate's own guard, so the clearance
  // it actually requires from a bookings row is `before + after` on BOTH
  // sides — not `before` on one edge and `after` on the other (the original
  // defect: the two were swapped), and not max(before, after) either (an
  // earlier, refuted fix — max() is strictly less than the sum whenever both
  // buffers are > 0, so it still under-expands and still offers claim-
  // infeasible starts; live-D1-verified against claimSlot). We apply the
  // same before+after sum to ALL busy sources (raw calendar busy included),
  // not just bookings rows — sound (grid-offered is always claim-feasible),
  // and it over-suppresses calendar-adjacent slots by min(before, after) per
  // edge, which is zero under the shipped default {before:0, after:10}.
  // Live evidence, 2026-08-17: HIDDEN poll p_930ec249 (before:0, after:10)
  // had two candidates — 23:00Z and 2026-08-18T01:30Z — each offered by the
  // (buggy) grid because they ended exactly `after` minutes short of an
  // adjacent same-owner booking row, then silently `slot_taken` at claim,
  // exhausting the walk into a spurious needs_attention escalation.
  describe("W1: busy expansion matches claimSlot's before+after guard", () => {
    it("does not offer a candidate ending exactly at a busy block's start (before=0, after=10)", () => {
      const slots = computeBookableSlots(params({
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 10,
        // Candidate 00:00-00:30 would end exactly where this busy block
        // starts. Pre-fix: expansion is [start-0, end+10] = [00:30, ...], so
        // 00:00 is offered (bug — claimSlot's guard rejects it: the row sits
        // only 0 min after the candidate's end, less than before+after=10).
        busy: [{ startUtc: "2026-08-03T00:30:00Z", endUtc: "2026-08-03T01:00:00Z" }],
      }));
      expect(slots).not.toContain("2026-08-03T00:00:00.000Z");
    });

    it("does not offer a candidate starting exactly at a busy block's end — mirror case, before > after", () => {
      const slots = computeBookableSlots(params({
        bufferBeforeMinutes: 10,
        bufferAfterMinutes: 0,
        // Candidate 00:30-01:00 would start exactly where this busy block
        // ends. Pre-fix: expansion is [start-10, end+0] = [..., 00:30], so
        // 00:30 is offered (bug — claimSlot's guard rejects it: the row ends
        // only 0 min before the candidate's start, less than before+after=10).
        busy: [{ startUtc: "2026-08-03T00:00:00Z", endUtc: "2026-08-03T00:30:00Z" }],
      }));
      expect(slots).not.toContain("2026-08-03T00:30:00.000Z");
    });

    it("symmetric buffers (before == after) still compose to the SUM, not the shared value", () => {
      // W1 round 2 (adversarial review): an earlier version of this test
      // asserted a 30-min clearance was enough here — that WAS WRONG, and it
      // silently pinned the very bug max() still had. claimSlot re-pads a
      // bookings row on top of the candidate's own guard, so even when
      // before == after the real required gap is before+after (60 here),
      // not the shared 30-min value max() would suggest.
      const slots = computeBookableSlots(params({
        bufferBeforeMinutes: 30,
        bufferAfterMinutes: 30,
        busy: [{ startUtc: "2026-08-03T01:00:00Z", endUtc: "2026-08-03T01:30:00Z" }],
      }));
      // sum = 30+30 = 60min. Hole = [01:00-60, 01:30+60] = [00:00, 02:30] —
      // NOT [00:30, 02:00], which is what max(30,30)=30 would give.
      expect(slots).not.toContain("2026-08-03T00:00:00.000Z"); // would end 00:30 — only 30 min clear (max()'s bound), needs 60
      expect(slots).not.toContain("2026-08-03T02:00:00.000Z"); // would start 02:00 — only 30 min clear after busy end, needs 60
      expect(slots).toContain("2026-08-03T02:30:00.000Z");     // the full 60-min sum gap after busy end
    });
  });
});

// W1 round 2 (adversarial review, live-D1-verified) — the invariant the grid
// actually has to satisfy is a CONJUNCTION with claimSlot, not something
// computeBookableSlots can be trusted to get right by inspection alone:
// every start the grid offers, when actually claimed against a real
// same-owner bookings row in D1, must succeed. max(before, after) fails this
// property whenever before AND after are both > 0 (it only happened to hold
// under W1 round 1's boundary tests because one of the two was always 0).
// This exercises claimSlot for real, the same way test/booking/claim.test.ts
// does, rather than re-deriving its SQL by hand.
describe("W1: conjunction — every grid-offered start survives a real claimSlot", () => {
  const CONJ_OWNER = "w1-conjunction@org";
  // A same-owner booking already on the calendar, Mon 2026-08-03 11:45-12:15
  // Sydney (01:45-02:15Z) — inside the 10:00-16:00 business-hours fixture.
  const ROW = { startUtc: "2026-08-03T01:45:00.000Z", endUtc: "2026-08-03T02:15:00.000Z" };

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM bookings WHERE owner_subject = ?").bind(CONJ_OWNER).run();
  });

  // Reviewer's probe values (before:15/after:10, and its mirror), plus the
  // shipped default (before:0/after:10) and a fully symmetric pair — every
  // combination where max(before, after) and before+after actually diverge.
  const PAIRS = [
    { before: 15, after: 10 },
    { before: 10, after: 15 },
    { before: 0, after: 10 },
    { before: 20, after: 5 },
  ];

  for (const { before, after } of PAIRS) {
    it(`before:${before}/after:${after} — no grid-offered start against the fixture row is claim-infeasible`, async () => {
      // The blocking row itself: its OWN guard doesn't matter to this test —
      // claimSlot's guard against OTHER claims is derived entirely from
      // THEIR before/after, never from how the row itself was claimed.
      const rowClaim = await claimSlot(env.DB, {
        ownerSubject: CONJ_OWNER,
        slug: "w1-conj-row",
        startUtc: ROW.startUtc,
        endUtc: ROW.endUtc,
        durationMinutes: 30,
        bookerName: "Existing",
        bookerEmail: "existing@x.com",
        bookerNote: null,
        locationKind: "meet",
        locationDetail: null,
        ipHash: "row",
        guardStartUtc: ROW.startUtc,
        guardEndUtc: ROW.endUtc,
        now: new Date(NOW),
      });
      expect(rowClaim).not.toBeNull();

      const slots = computeBookableSlots({
        tz: TZ,
        hours: HOURS,
        nowMs: NOW,
        minNoticeMinutes: 0,
        windowStartMs: NOW,
        windowEndMs: NOW + 7 * DAY,
        durationMinutes: 30,
        slotStepMinutes: 30,
        bufferBeforeMinutes: before,
        bufferAfterMinutes: after,
        busy: [ROW],
      });

      // Only candidates near the blocking row can possibly be affected —
      // restricting to a 3-hour window around it keeps this fast without
      // weakening the property (anything further away is trivially clear).
      const rowStartMs = Date.parse(ROW.startUtc);
      const near = slots.filter((s) => Math.abs(Date.parse(s) - rowStartMs) <= 3 * 3_600_000);
      expect(near.length).toBeGreaterThan(0); // sanity: the fixture is actually exercising the boundary

      for (const candidate of near) {
        const startMs = Date.parse(candidate);
        const endMs = startMs + 30 * 60_000;
        const claim = await claimSlot(env.DB, {
          ownerSubject: CONJ_OWNER,
          slug: "w1-conj-candidate",
          startUtc: candidate,
          endUtc: new Date(endMs).toISOString(),
          durationMinutes: 30,
          bookerName: "Candidate",
          bookerEmail: "candidate@x.com",
          bookerNote: null,
          locationKind: "meet",
          locationDetail: null,
          ipHash: "candidate",
          guardStartUtc: new Date(startMs - before * 60_000).toISOString(),
          guardEndUtc: new Date(endMs + after * 60_000).toISOString(),
          now: new Date(NOW),
        });
        expect(claim, `grid offered ${candidate} (before:${before}/after:${after}) but claimSlot rejected it`).not.toBeNull();
        // Release immediately so it doesn't shadow the NEXT candidate in
        // this same loop (a real ordinary-overlap guard, unrelated to the
        // property under test).
        if (claim) await failBooking(env.DB, claim.id, new Date(NOW));
      }
    });
  }
});
