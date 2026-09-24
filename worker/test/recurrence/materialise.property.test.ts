import { test, fc } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { materialiseTemplate, type TemplateRow } from "../../src/recurrence/materialise";

const TZS = ["UTC", "Australia/Sydney", "America/New_York", "Asia/Kolkata", "Pacific/Chatham"];
const RRULES = [
  "FREQ=DAILY",
  "FREQ=WEEKLY;BYDAY=MO",
  "FREQ=WEEKLY;BYDAY=MO,WE,FR",
  "FREQ=WEEKLY;BYDAY=SA,SU",
];
// 15-min-aligned times safely clear of the Sydney DST spring gap (02:00–03:00).
const PIN_TIMES = [null, "06:00", "09:30", "13:15", "19:00", "23:45"];

const tzArb = fc.constantFrom(...TZS);
const rruleArb = fc.constantFrom(...RRULES);
const pinArb = fc.constantFrom(...PIN_TIMES);

function tpl(rrule: string, pinned_time: string | null): TemplateRow {
  return {
    id: "tpl-prop",
    body: {
      title: "Prop", context: "admin", rrule, pinned_time,
      duration_minutes: 30, active_from: "2026-01-01",
    },
  };
}

// A fixed week-long window; varied across a year to span DST in Step assertions.
const WINDOW_START = "2026-06-15T00:00:00Z";
const WINDOW_END = "2026-06-22T00:00:00Z";

// materialise can legitimately throw on a DST spring-forward gap for a given tz;
// discard those samples so the property only judges non-throwing runs.
function safeMat(t: TemplateRow, tz: string, existing = new Set<string>(), excluded = new Set<string>()) {
  try {
    return materialiseTemplate(t, WINDOW_START, WINDOW_END, existing, tz, excluded);
  } catch {
    // fc.pre(false) aborts this sample as a precondition failure. It is typed
    // `asserts expectTruthy`, so tsc treats everything after it as unreachable —
    // no return/throw is needed to satisfy the function's return type.
    fc.pre(false);
  }
}

describe("materialiseTemplate — properties", () => {
  test.prop([rruleArb, pinArb, tzArb, tzArb])(
    "occurrence_date set is tz-invariant (RC1)",
    (rrule, pin, tzA, tzB) => {
      const t = tpl(rrule, pin);
      const a = safeMat(t, tzA).map((r) => r.occurrence_date).sort();
      const b = safeMat(t, tzB).map((r) => r.occurrence_date).sort();
      expect(a).toEqual(b);
    },
  );

  test.prop([rruleArb, pinArb, tzArb])(
    "feeding run-1 occurrence_dates back as existing makes run-2 empty (idempotency)",
    (rrule, pin, tz) => {
      const t = tpl(rrule, pin);
      const first = safeMat(t, tz);
      const existing = new Set(first.map((r) => r.occurrence_date));
      const second = materialiseTemplate(t, WINDOW_START, WINDOW_END, existing, tz);
      expect(second).toEqual([]);
    },
  );

  test.prop([rruleArb, pinArb, tzArb])(
    "exclusion monotonicity: excluding never adds output and excluded dates never appear",
    (rrule, pin, tz) => {
      const t = tpl(rrule, pin);
      const base = safeMat(t, tz).map((r) => r.occurrence_date);
      if (base.length === 0) return;
      const excluded = new Set([base[0]!]);
      const withExcl = safeMat(t, tz, new Set(), excluded).map((r) => r.occurrence_date);
      expect(withExcl.length).toBeLessThanOrEqual(base.length);
      expect(withExcl).not.toContain(base[0]!);
    },
  );

  // Adversarial but schema-valid task_body: reserved timing/identity keys carry
  // plausible-but-wrong values, while any non-reserved key (priority) stays type-
  // valid so the merged body PASSES TaskCreate. This guarantees surviving rows
  // exist, so the assertions below actually run (not vacuously skipped) — the
  // override path is genuinely exercised.
  const ADVERSARIAL = {
    pinned_at: "2000-01-01T00:00:00.000Z",
    earliest_start: "2000-01-01T00:00:00.000Z",
    template_id: "evil",
    source: { kind: "webhook", external_id: "evil" },
  } as const;

  const taskBodyArb = fc
    .record({
      pinned_at: fc.constant(ADVERSARIAL.pinned_at),
      earliest_start: fc.constant(ADVERSARIAL.earliest_start),
      template_id: fc.constant(ADVERSARIAL.template_id),
      source: fc.constant(ADVERSARIAL.source),
      priority: fc.integer({ min: 0, max: 100 }), // non-reserved, kept type-valid
    }, {
      // include each reserved key with adversarial value or omit it, but keep
      // priority always present-and-valid so the body never fails TaskCreate.
      requiredKeys: ["priority"],
    });

  test.prop([rruleArb, pinArb, tzArb, taskBodyArb])(
    "RC4: reserved timing/identity keys in task_body are never honoured",
    (rrule, pin, tz, taskBody) => {
      const t = tpl(rrule, pin);
      t.body.task_body = taskBody;
      const baseline = safeMat(tpl(rrule, pin), tz); // same template without task_body
      const withBody = safeMat(t, tz);

      // The adversarial body is schema-valid, so materialise must emit the same
      // occurrence set as the baseline — surviving rows MUST exist to assert on.
      expect(withBody.map((r) => r.occurrence_date).sort())
        .toEqual(baseline.map((r) => r.occurrence_date).sort());
      if (baseline.length > 0) expect(withBody.length).toBeGreaterThan(0);

      // Surviving rows keep computed timing + true identity, never the adversarial
      // task_body values.
      for (const row of withBody) {
        expect(row.body.template_id).toBe("tpl-prop");
        expect(row.body.template_id).not.toBe(ADVERSARIAL.template_id);
        expect(row.body.earliest_start).not.toBe(ADVERSARIAL.earliest_start);
        const match = baseline.find((b) => b.occurrence_date === row.occurrence_date);
        if (match) {
          expect(row.body.earliest_start).toBe(match.body.earliest_start);
          expect(row.body.pinned_at).toBe(match.body.pinned_at);
          expect(row.body.source).toEqual(match.body.source);
        }
      }
    },
  );
});
