import { describe, it, expect } from "vitest";
import { materialiseTemplate, type TemplateRow } from "../../src/recurrence/materialise";

const pilates: TemplateRow = {
  id: "tpl-pilates",
  body: {
    title: "Pilates",
    context: "physical",
    rrule: "FREQ=WEEKLY;BYDAY=FR",
    pinned_time: "19:00",
    duration_minutes: 90,
    active_from: "2026-01-01",
  },
};

describe("materialiseTemplate", () => {
  it("emits one task per occurrence with pinned_at and template_id", () => {
    const out = materialiseTemplate(pilates, "2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z", new Set(), "UTC");
    expect(out).toHaveLength(1);
    expect(out[0]!.body.title).toBe("Pilates");
    expect(out[0]!.body.context).toBe("physical");
    expect(out[0]!.body.duration_minutes).toBe(90);
    expect(out[0]!.body.pinned_at).toBe("2026-05-22T19:00:00.000Z");
    expect(out[0]!.template_id).toBe("tpl-pilates");
    expect(out[0]!.body.template_id).toBe("tpl-pilates");
    expect(out[0]!.body.status).toBeUndefined(); // status is a column, not in body
    expect(out[0]!.status).toBe("pending");
  });

  it("skips occurrences that already have a materialised instance", () => {
    const existing = new Set(["2026-05-22"]);
    const out = materialiseTemplate(pilates, "2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z", existing, "UTC");
    expect(out).toEqual([]);
  });

  it("respects active_until", () => {
    const tpl: TemplateRow = {
      id: "tpl-x",
      body: {
        title: "X",
        context: "admin",
        rrule: "FREQ=DAILY",
        duration_minutes: 30,
        active_from: "2026-05-01",
        active_until: "2026-05-20",
      },
    };
    const out = materialiseTemplate(tpl, "2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z", new Set(), "UTC");
    // 2026-05-18, 2026-05-19, 2026-05-20 fall within active_until inclusive.
    expect(out.map((t) => t.body.pinned_at ?? t.body.earliest_start)).toEqual([
      "2026-05-18T00:00:00.000Z",
      "2026-05-19T00:00:00.000Z",
      "2026-05-20T00:00:00.000Z",
    ]);
  });

  it("merges task_body overrides into the instance body", () => {
    const tpl: TemplateRow = {
      id: "tpl-merge",
      body: {
        title: "Stand-up",
        context: "meeting",
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        pinned_time: "09:30",
        duration_minutes: 15,
        active_from: "2026-01-01",
        task_body: { priority: 50, preferred_windows: [{ days: ["mon"], start: "09:00", end: "10:00", hard: false }] },
      },
    };
    const out = materialiseTemplate(tpl, "2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z", new Set(), "UTC");
    expect(out).toHaveLength(1);
    expect(out[0]!.body.priority).toBe(50);
    expect(out[0]!.body.preferred_windows).toHaveLength(1);
  });

  it("omits pinned_at and uses earliest_start when pinned_time is absent", () => {
    const tpl: TemplateRow = {
      id: "tpl-unpinned",
      body: {
        title: "Read papers",
        context: "deep",
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        duration_minutes: 45,
        active_from: "2026-05-01",
      },
    };
    const out = materialiseTemplate(tpl, "2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z", new Set(), "UTC");
    expect(out).toHaveLength(1);
    expect(out[0]!.body.pinned_at).toBeNull();
    expect(out[0]!.body.earliest_start).toBe("2026-05-18T00:00:00.000Z");
  });

  it("stamps occurrence_date with the expander's local date (Sydney, pinned pre-10:00)", () => {
    // The prod RC1 case: Sydney 09:30 occurrence on 2026-06-15 stores an instant
    // dated 2026-06-14Z, but occurrence_date must be the local date 2026-06-15.
    const tpl: TemplateRow = {
      id: "tpl-standup",
      body: {
        title: "Standup", context: "meeting", rrule: "FREQ=WEEKLY;BYDAY=MO",
        pinned_time: "09:30", duration_minutes: 15, active_from: "2026-01-01",
      },
    };
    const out = materialiseTemplate(tpl, "2026-06-14T00:00:00Z", "2026-06-21T00:00:00Z", new Set(), "Australia/Sydney");
    expect(out).toHaveLength(1);
    expect(out[0]!.occurrence_date).toBe("2026-06-15");
    expect(out[0]!.body.pinned_at).toBe("2026-06-14T23:30:00.000Z"); // instant dated the day before
  });

  it("skips occurrences in the excluded set (EXDATE)", () => {
    const out = materialiseTemplate(
      pilates, "2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z", new Set(), "UTC",
      new Set(["2026-05-22"]),
    );
    expect(out).toEqual([]);
  });

  it("strips reserved keys from task_body — timing and identity are not overridable", () => {
    const tpl: TemplateRow = {
      id: "tpl-rc4",
      body: {
        title: "RC4", context: "admin", rrule: "FREQ=WEEKLY;BYDAY=FR",
        pinned_time: "19:00", duration_minutes: 30, active_from: "2026-01-01",
        task_body: {
          pinned_at: "2000-01-01T00:00:00.000Z",
          earliest_start: "2000-01-01T00:00:00.000Z",
          template_id: "evil",
          source: { kind: "manual", external_id: "x" },
          priority: 99, // non-reserved: allowed to override
        },
      },
    };
    const out = materialiseTemplate(tpl, "2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z", new Set(), "UTC");
    expect(out).toHaveLength(1);
    expect(out[0]!.body.pinned_at).toBe("2026-05-22T19:00:00.000Z"); // computed, not 2000
    expect(out[0]!.body.template_id).toBe("tpl-rc4");                 // identity, not "evil"
    expect(out[0]!.body.priority).toBe(99);                           // non-reserved override survives
  });

  it("skips and does not throw when task_body makes the row fail TaskCreate", () => {
    const tpl: TemplateRow = {
      id: "tpl-bad",
      body: {
        title: "Bad", context: "admin", rrule: "FREQ=WEEKLY;BYDAY=FR",
        pinned_time: "19:00", duration_minutes: 30, active_from: "2026-01-01",
        task_body: { chunks: [{ duration_minutes: 10 }] }, // duration_minutes + chunks is invalid together
      },
    };
    const out = materialiseTemplate(tpl, "2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z", new Set(), "UTC");
    expect(out).toEqual([]); // skipped, not inserted
  });
});
