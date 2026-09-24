import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { tasksApp } from "../../src/handlers/tasks";
import { runRecurrenceSweep } from "../../src/recurrence/sweep";

// Mirror the production wiring: tasksApp has no auth/subject middleware, so
// wrap it in a thin parent app that sets ownerSubject — same pattern as
// worker/test/recurrence/exclusions.test.ts.
function makeApp(ownerSubject: string) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("ownerSubject" as never, ownerSubject as never);
    await next();
  });
  app.route("/", tasksApp);
  return app;
}

describe("PATCH preserves occurrence_date (RC3)", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare("DELETE FROM task_templates").run();
    await env.DB.prepare("DELETE FROM template_exclusions").run();
  });

  it("a timing PATCH leaves occurrence_date intact and the sweep stays idempotent", async () => {
    // Use a real UUID for the template so the merged body passes TaskCreate's
    // UUID validation on template_id when the PATCH handler re-validates it.
    const tplId = "00000000-0000-0000-0000-000000000001";

    // Insert a weekly recurring template and materialise one instance.
    await env.DB
      .prepare(
        "INSERT INTO task_templates (id, owner_subject, body, active_from, active_until) VALUES (?, ?, ?, ?, NULL)",
      )
      .bind(
        tplId,
        "owner-a",
        JSON.stringify({
          title: "Pilates",
          context: "physical",
          rrule: "FREQ=WEEKLY;BYDAY=FR",
          pinned_time: "19:00",
          duration_minutes: 90,
          active_from: "2026-01-01",
        }),
        "2026-01-01",
      )
      .run();

    await runRecurrenceSweep(env.DB, "owner-a", "2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z", "UTC");

    const before = await env.DB
      .prepare("SELECT id, occurrence_date FROM tasks WHERE owner_subject='owner-a'")
      .first<{ id: string; occurrence_date: string }>();

    expect(before).not.toBeNull();
    expect(before!.occurrence_date).toBe("2026-05-22");

    // PATCH a timing field (earliest_start) via the wrapper app so the handler
    // sees ownerSubject correctly.
    const app = makeApp("owner-a");
    const res = await app.request(
      `/${before!.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ earliest_start: "2026-05-19T08:00:00.000Z" }),
      },
      env,
    );
    expect(res.status).toBe(200);

    // RC3 invariant: occurrence_date must survive the PATCH unchanged.
    // putTaskRow's ON CONFLICT DO UPDATE SET list deliberately excludes
    // occurrence_date (alongside scheduled_for and created_at), so the column
    // written by the sweep is never overwritten by a user edit.
    const after = await env.DB
      .prepare("SELECT occurrence_date FROM tasks WHERE id = ?")
      .bind(before!.id)
      .first<{ occurrence_date: string }>();

    expect(after?.occurrence_date).toBe(before!.occurrence_date); // must be "2026-05-22"

    // Idempotency: a second sweep over the same window must not re-materialise
    // the instance because the row still carries occurrence_date = "2026-05-22".
    const again = await runRecurrenceSweep(
      env.DB,
      "owner-a",
      "2026-05-18T00:00:00Z",
      "2026-05-25T00:00:00Z",
      "UTC",
    );
    expect(again.created).toBe(0);
  });
});
