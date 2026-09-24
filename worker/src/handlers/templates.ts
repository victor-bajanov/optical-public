import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import { TemplateCreate } from "../schema/template";
import { TemplateResponse } from "../schema/template-response";
import { D } from "../schema/descriptions";
import { getJsonRow, listJsonRows } from "../db/d1";

type Vars = { ownerSubject: string };

export const templatesApp = new OpenAPIHono<{ Bindings: Env; Variables: Vars }>();

// ── POST /templates ────────────────────────────────────────────────────────

const postTemplateRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "createTemplate",
  summary: "Create a recurring task template.",
  description: "Create a recurring task template. The rrule drives which dates generate tasks; task_body carries the partial task spec stamped onto each occurrence.",
  security: [{ BearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: TemplateCreate } }, required: true },
  },
  responses: {
    201: {
      content: { "application/json": { schema: TemplateResponse } },
      description: "Created template",
    },
    400: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string(), issues: z.array(z.unknown()).optional() }),
        },
      },
      description: "Validation error",
    },
  },
});

templatesApp.openapi(postTemplateRoute, async (c) => {
  const parsed = c.req.valid("json");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const body = { ...parsed, id, created_at: now };
  await c.env.DB.prepare(
    `INSERT INTO task_templates (id, owner_subject, body, active_from, active_until) VALUES (?,?,?,?,?)`,
  )
    .bind(id, c.var.ownerSubject, JSON.stringify(body), parsed.active_from, parsed.active_until ?? null)
    .run();
  return c.json(body as z.infer<typeof TemplateResponse>, 201);
});

// ── GET /templates ─────────────────────────────────────────────────────────

const getTemplatesRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "listTemplates",
  summary: "List recurring task templates.",
  description: "List all recurring task templates.",
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ templates: z.array(TemplateResponse).describe(D.response.templates) }) },
      },
      description: "List of templates",
    },
  },
});

templatesApp.openapi(getTemplatesRoute, async (c) => {
  const ownerSubject = c.get("ownerSubject") as string;
  const rows = await listJsonRows<Record<string, unknown>>(c.env.DB, ownerSubject, "task_templates");
  return c.json({
    templates: rows.map((r) => r.body) as z.infer<typeof TemplateResponse>[],
  });
});

// ── DELETE /templates/:id ──────────────────────────────────────────────────

const deleteTemplateRoute = createRoute({
  method: "delete",
  path: "/{id}",
  operationId: "deleteTemplate",
  summary: "Delete a recurring task template by id.",
  description: "Delete a recurring task template by id. Does not remove already-generated tasks.",
  security: [{ BearerAuth: [] }],
  responses: {
    204: { description: "Deleted" },
    404: {
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
      description: "Not found",
    },
  },
});

templatesApp.openapi(deleteTemplateRoute, async (c) => {
  const ownerSubject = c.get("ownerSubject") as string;
  const id = c.req.param("id");
  const existing = await getJsonRow(c.env.DB, ownerSubject, "task_templates", id);
  if (!existing) return c.json({ error: "not_found" }, 404) as any;
  // Delete the template and its companion exclusion rows together so deletions
  // don't leave orphaned template_exclusions behind (which would otherwise be
  // dead weight keyed on a template_id that no longer exists).
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM task_templates WHERE id = ? AND owner_subject = ?").bind(id, ownerSubject),
    c.env.DB.prepare("DELETE FROM template_exclusions WHERE owner_subject = ? AND template_id = ?").bind(ownerSubject, id),
  ]);
  return c.body(null, 204);
});
