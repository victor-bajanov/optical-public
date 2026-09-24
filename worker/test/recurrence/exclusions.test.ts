import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Hono } from "hono";
import { runRecurrenceSweep } from "../../src/recurrence/sweep";
import { tasksApp } from "../../src/handlers/tasks";
import { templatesApp } from "../../src/handlers/templates";

// tasksApp itself carries no auth/subject middleware (that lives on the parent
// /v1 app via requireSubject). Mirror the production wiring with a thin parent
// app whose middleware sets ownerSubject, then drive it with the real env so
// the DELETE handler sees c.get("ownerSubject") === "owner-a".
function makeApp(ownerSubject: string) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("ownerSubject" as never, ownerSubject as never);
    await next();
  });
  app.route("/", tasksApp);
  return app;
}

describe("DELETE of a recurring instance → EXDATE", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare("DELETE FROM task_templates").run();
    await env.DB.prepare("DELETE FROM template_exclusions").run();
  });

  it("hard-deletes the row, records an exclusion, and the next sweep does not recreate it", async () => {
    await env.DB.prepare("INSERT INTO task_templates (id, owner_subject, body, active_from, active_until) VALUES (?, ?, ?, ?, NULL)")
      .bind("tpl-pilates", "owner-a", JSON.stringify({
        title: "Pilates", context: "physical", rrule: "FREQ=WEEKLY;BYDAY=FR",
        pinned_time: "19:00", duration_minutes: 90, active_from: "2026-01-01",
      }), "2026-01-01").run();

    await runRecurrenceSweep(env.DB, "owner-a", "2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z", "UTC");
    const created = await env.DB.prepare("SELECT id, occurrence_date FROM tasks WHERE owner_subject='owner-a'").first<{ id: string; occurrence_date: string }>();
    expect(created?.occurrence_date).toBe("2026-05-22");

    const app = makeApp("owner-a");
    const res = await app.request(`/${created!.id}`, { method: "DELETE" }, env);
    expect(res.status).toBe(204);

    const excl = await env.DB.prepare("SELECT occurrence_date FROM template_exclusions WHERE owner_subject='owner-a' AND template_id='tpl-pilates'").first<{ occurrence_date: string }>();
    expect(excl?.occurrence_date).toBe("2026-05-22");

    const again = await runRecurrenceSweep(env.DB, "owner-a", "2026-05-18T00:00:00Z", "2026-05-25T00:00:00Z", "UTC");
    expect(again.created).toBe(0); // RC2: was 1 (resurrected) before the fix
  });
});

// Same parent-app/ownerSubject wrapper pattern as makeApp above, but mounting
// templatesApp so its DELETE handler sees c.get("ownerSubject") === ownerSubject.
function makeTemplatesApp(ownerSubject: string) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("ownerSubject" as never, ownerSubject as never);
    await next();
  });
  app.route("/", templatesApp);
  return app;
}

describe("template delete cleans up its exclusions", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM task_templates").run();
    await env.DB.prepare("DELETE FROM template_exclusions").run();
  });

  it("DELETE /templates/:id removes the template's exclusion rows (no orphans)", async () => {
    await env.DB.prepare("INSERT INTO task_templates (id, owner_subject, body, active_from, active_until) VALUES (?, ?, ?, ?, NULL)")
      .bind("tpl-x", "owner-a", JSON.stringify({
        title: "X", context: "admin", rrule: "FREQ=WEEKLY;BYDAY=MO",
        duration_minutes: 30, active_from: "2026-01-01",
      }), "2026-01-01").run();
    await env.DB.prepare("INSERT INTO template_exclusions (owner_subject, template_id, occurrence_date, created_at) VALUES (?, ?, ?, ?)")
      .bind("owner-a", "tpl-x", "2026-06-15", "2026-06-10T00:00:00Z").run();

    const app = makeTemplatesApp("owner-a");
    const res = await app.request("/tpl-x", { method: "DELETE" }, env);
    expect(res.status).toBe(204);

    const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM template_exclusions WHERE owner_subject='owner-a' AND template_id='tpl-x'").first<{ c: number }>();
    expect(count?.c).toBe(0);
  });
});
