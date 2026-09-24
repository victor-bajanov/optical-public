import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { runRecurrenceSweep } from "../../src/recurrence/sweep";

describe("runRecurrenceSweep", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare("DELETE FROM task_templates").run();
    await env.DB.prepare("DELETE FROM template_exclusions").run();
  });

  it("creates one task per active occurrence", async () => {
    await env.DB.prepare("INSERT INTO task_templates (id, owner_subject, body, active_from, active_until) VALUES (?, ?, ?, ?, NULL)")
      .bind("tpl-pilates", "owner-a", JSON.stringify({
        title: "Pilates",
        context: "physical",
        rrule: "FREQ=WEEKLY;BYDAY=FR",
        pinned_time: "19:00",
        duration_minutes: 90,
        active_from: "2026-01-01",
      }), "2026-01-01").run();

    const result = await runRecurrenceSweep(env.DB, "owner-a", "2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z", "UTC");
    expect(result.created).toBe(1);

    const rows = await env.DB.prepare("SELECT id, template_id, status, body FROM tasks WHERE owner_subject = 'owner-a'").all<{ id: string; template_id: string; status: string; body: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results![0]!.template_id).toBe("tpl-pilates");
    expect(rows.results![0]!.status).toBe("pending");
    expect(JSON.parse(rows.results![0]!.body).pinned_at).toBe("2026-05-22T19:00:00.000Z");
  });

  it("is idempotent across repeated sweeps", async () => {
    await env.DB.prepare("INSERT INTO task_templates (id, owner_subject, body, active_from, active_until) VALUES (?, ?, ?, ?, NULL)")
      .bind("tpl-pilates", "owner-a", JSON.stringify({
        title: "Pilates",
        context: "physical",
        rrule: "FREQ=WEEKLY;BYDAY=FR",
        pinned_time: "19:00",
        duration_minutes: 90,
        active_from: "2026-01-01",
      }), "2026-01-01").run();

    await runRecurrenceSweep(env.DB, "owner-a", "2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z", "UTC");
    const second = await runRecurrenceSweep(env.DB, "owner-a", "2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z", "UTC");
    expect(second.created).toBe(0);

    const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM tasks WHERE owner_subject = 'owner-a'").first<{ c: number }>();
    expect(count?.c).toBe(1);
  });

  it("does not touch tasks whose status is no longer 'pending'", async () => {
    await env.DB.prepare("INSERT INTO task_templates (id, owner_subject, body, active_from, active_until) VALUES (?, ?, ?, ?, NULL)")
      .bind("tpl-pilates", "owner-a", JSON.stringify({
        title: "Pilates",
        context: "physical",
        rrule: "FREQ=WEEKLY;BYDAY=FR",
        pinned_time: "19:00",
        duration_minutes: 90,
        active_from: "2026-01-01",
      }), "2026-01-01").run();

    // First sweep materialises 2026-05-22.
    await runRecurrenceSweep(env.DB, "owner-a", "2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z", "UTC");
    await env.DB.prepare("UPDATE tasks SET status = 'done' WHERE template_id = ?").bind("tpl-pilates").run();

    // Second sweep over the same window must not re-create.
    const second = await runRecurrenceSweep(env.DB, "owner-a", "2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z", "UTC");
    expect(second.created).toBe(0);

    const rows = await env.DB.prepare("SELECT status FROM tasks WHERE owner_subject = 'owner-a'").all<{ status: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results![0]!.status).toBe("done");
  });

  it("skips templates whose active_until has passed", async () => {
    await env.DB.prepare("INSERT INTO task_templates (id, owner_subject, body, active_from, active_until) VALUES (?, ?, ?, ?, ?)")
      .bind("tpl-old", "owner-a", JSON.stringify({
        title: "Retired",
        context: "admin",
        rrule: "FREQ=DAILY",
        duration_minutes: 15,
        active_from: "2025-01-01",
        active_until: "2025-12-31",
      }), "2025-01-01", "2025-12-31").run();

    const result = await runRecurrenceSweep(env.DB, "owner-a", "2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z", "UTC");
    expect(result.created).toBe(0);
  });

  it("only materialises templates owned by the given subject", async () => {
    await env.DB.prepare("INSERT INTO task_templates (id, owner_subject, body, active_from, active_until) VALUES (?, ?, ?, ?, NULL)")
      .bind("tpl-a", "owner-a", JSON.stringify({
        title: "A's standup",
        context: "physical",
        rrule: "FREQ=WEEKLY;BYDAY=FR",
        pinned_time: "19:00",
        duration_minutes: 90,
        active_from: "2026-01-01",
      }), "2026-01-01").run();
    await env.DB.prepare("INSERT INTO task_templates (id, owner_subject, body, active_from, active_until) VALUES (?, ?, ?, ?, NULL)")
      .bind("tpl-b", "owner-b", JSON.stringify({
        title: "B's standup",
        context: "physical",
        rrule: "FREQ=WEEKLY;BYDAY=FR",
        pinned_time: "19:00",
        duration_minutes: 90,
        active_from: "2026-01-01",
      }), "2026-01-01").run();

    const result = await runRecurrenceSweep(env.DB, "owner-a", "2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z", "UTC");
    expect(result.created).toBe(1);

    const rows = await env.DB.prepare("SELECT template_id, owner_subject FROM tasks WHERE owner_subject = 'owner-a'").all<{ template_id: string; owner_subject: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results![0]!.template_id).toBe("tpl-a");
    expect(rows.results![0]!.owner_subject).toBe("owner-a");
  });

  it("throws owner_scope_missing on an empty owner", async () => {
    await expect(
      runRecurrenceSweep(env.DB, "", "2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z", "UTC"),
    ).rejects.toThrow("owner_scope_missing");
  });

  it("is idempotent across sweeps for a Sydney pre-10:00 pin (RC1)", async () => {
    await env.DB.prepare("INSERT INTO task_templates (id, owner_subject, body, active_from, active_until) VALUES (?, ?, ?, ?, NULL)")
      .bind("tpl-standup", "owner-syd", JSON.stringify({
        title: "Standup", context: "meeting", rrule: "FREQ=WEEKLY;BYDAY=MO",
        pinned_time: "09:30", duration_minutes: 15, active_from: "2026-01-01",
      }), "2026-01-01").run();

    const first = await runRecurrenceSweep(env.DB, "owner-syd", "2026-06-14T00:00:00Z", "2026-06-21T00:00:00Z", "Australia/Sydney");
    const second = await runRecurrenceSweep(env.DB, "owner-syd", "2026-06-14T00:00:00Z", "2026-06-21T00:00:00Z", "Australia/Sydney");

    expect(first.created).toBe(1);
    expect(second.created).toBe(0); // RC1: was non-zero before the fix
    const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM tasks WHERE owner_subject = 'owner-syd'").first<{ c: number }>();
    expect(count?.c).toBe(1);
    const row = await env.DB.prepare("SELECT occurrence_date FROM tasks WHERE owner_subject = 'owner-syd'").first<{ occurrence_date: string }>();
    expect(row?.occurrence_date).toBe("2026-06-15");
  });

  it("does not re-create an occurrence present in template_exclusions (EXDATE)", async () => {
    await env.DB.prepare("INSERT INTO task_templates (id, owner_subject, body, active_from, active_until) VALUES (?, ?, ?, ?, NULL)")
      .bind("tpl-pilates", "owner-a", JSON.stringify({
        title: "Pilates", context: "physical", rrule: "FREQ=WEEKLY;BYDAY=FR",
        pinned_time: "19:00", duration_minutes: 90, active_from: "2026-01-01",
      }), "2026-01-01").run();
    await env.DB.prepare("INSERT INTO template_exclusions (owner_subject, template_id, occurrence_date, created_at) VALUES (?, ?, ?, ?)")
      .bind("owner-a", "tpl-pilates", "2026-05-22", "2026-05-20T00:00:00Z").run();

    const result = await runRecurrenceSweep(env.DB, "owner-a", "2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z", "UTC");
    expect(result.created).toBe(0);
    const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM tasks WHERE owner_subject = 'owner-a'").first<{ c: number }>();
    expect(count?.c).toBe(0);
  });
});
