import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import { ProjectCreate, ProjectPatch } from "../schema/project";
import { ProjectResponse } from "../schema/project-response";
import { D } from "../schema/descriptions";
import { putJsonRow, getJsonRow, listJsonRows } from "../db/d1";

type Vars = { ownerSubject: string };

export const projectsApp = new OpenAPIHono<{ Bindings: Env; Variables: Vars }>();

// ── POST /projects ─────────────────────────────────────────────────────────

const postProjectRoute = createRoute({
  method: "post",
  path: "/",
  operationId: "createProject",
  summary: "Create a new project.",
  description: "Create a project to group tasks and apply a shared deadline and priority floor.",
  security: [{ BearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: ProjectCreate } }, required: true },
  },
  responses: {
    201: {
      content: { "application/json": { schema: ProjectResponse } },
      description: "Created project",
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

projectsApp.openapi(postProjectRoute, async (c) => {
  const ownerSubject = c.get("ownerSubject") as string;
  const parsed = c.req.valid("json");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const body = { ...parsed, id, created_at: now };
  await putJsonRow(c.env.DB, ownerSubject, "projects", id, body);
  return c.json(body as z.infer<typeof ProjectResponse>, 201);
});

// ── GET /projects ──────────────────────────────────────────────────────────

const getProjectsRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "listProjects",
  summary: "List projects.",
  description: "List all projects.",
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ projects: z.array(ProjectResponse).describe(D.response.projects) }) },
      },
      description: "List of projects",
    },
  },
});

projectsApp.openapi(getProjectsRoute, async (c) => {
  const ownerSubject = c.get("ownerSubject") as string;
  const rows = await listJsonRows<Record<string, unknown>>(c.env.DB, ownerSubject, "projects");
  return c.json({
    projects: rows.map((r) => r.body) as z.infer<typeof ProjectResponse>[],
  });
});

// ── PATCH /projects/:id ────────────────────────────────────────────────────

const patchProjectRoute = createRoute({
  method: "patch",
  path: "/{id}",
  operationId: "updateProject",
  summary: "Update fields on an existing project.",
  description: "Patch fields on an existing project (title, deadline, priority_floor).",
  security: [{ BearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: ProjectPatch } }, required: true },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ProjectResponse } },
      description: "Updated project",
    },
    400: {
      content: {
        "application/json": {
          schema: z.object({ error: z.string(), issues: z.array(z.unknown()).optional() }),
        },
      },
      description: "Validation error",
    },
    404: {
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
      description: "Not found",
    },
  },
});

projectsApp.openapi(patchProjectRoute, async (c) => {
  const ownerSubject = c.get("ownerSubject") as string;
  const id = c.req.param("id");
  const existing = await getJsonRow<Record<string, unknown>>(c.env.DB, ownerSubject, "projects", id);
  if (!existing) return c.json({ error: "not_found" }, 404) as any;
  const patch = c.req.valid("json");
  const merged = { ...existing, ...patch, id, updated_at: new Date().toISOString() };
  await putJsonRow(c.env.DB, ownerSubject, "projects", id, merged);
  return c.json(merged as z.infer<typeof ProjectResponse>);
});
