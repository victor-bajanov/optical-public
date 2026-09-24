// worker/src/handlers/weights.ts
// Card C of internal design notes: GET/PATCH/DELETE
// /v1/weights — the caller's effective solver weights (six global soft
// weights), owner-scoped, precedence-chained under a per-resolve
// weights_override. No feature flag: this rides the always-on config tables.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { mountOwnerGate } from "../middleware/owner-gate";
import { loadEffectiveWeights, saveWeights, deleteWeights } from "../db/context-config";
import type { Weights as SolverWeights } from "../planning/solver-contract";
import { D } from "../schema/descriptions";

const WeightsSchema = z.object({
  time_of_day_fit_per_15min: z.number().describe("Cost per 15 minutes a task is placed outside its context's fit-curve peak."),
  churn_per_15min_moved: z.number().describe("Cost per 15 minutes an already-scheduled task is moved from its prior slot. Like every weight, also overridable per-resolve via weights_override."),
  priority_unit: z.number().describe("Cost scale per unit of task priority when weighing drop order."),
  base_drop_penalty: z.number().describe("Flat cost charged whenever a task is dropped from the week, on top of its priority-weighted cost."),
  preferred_day_miss: z.number().describe("Soft cost when a task lands on a day outside its preferred-window days."),
  preferred_time_miss_per_15min: z.number().describe("Soft cost per 15 minutes a task's placement sits outside its preferred-window time-of-day range."),
}).describe("The six global soft weights the solver applies to every resolve.");

const WeightsResponse = z.object({
  weights: WeightsSchema,
  source: z.enum(["custom", "default"]).describe(
    "'custom' if the caller has ever PATCHed their weights (and not since reset), else 'default'. Row-level: a PATCH stores a complete six-field snapshot, so per-field provenance isn't tracked.",
  ),
});

const PatchWeightsBody = z
  .object({
    time_of_day_fit_per_15min: z.number().int().min(0).optional().describe("Cost per 15 minutes a task is placed outside its context's fit-curve peak. Non-negative integer — the solver types every weight as int."),
    churn_per_15min_moved: z.number().int().min(0).optional().describe("Cost per 15 minutes an already-scheduled task is moved from its prior slot. Non-negative integer — the solver types every weight as int."),
    priority_unit: z.number().int().min(0).optional().describe("Cost scale per unit of task priority when weighing drop order. Non-negative integer — the solver types every weight as int."),
    base_drop_penalty: z.number().int().min(0).optional().describe("Flat cost charged whenever a task is dropped from the week, on top of its priority-weighted cost. Non-negative integer — the solver types every weight as int."),
    preferred_day_miss: z.number().int().min(0).optional().describe("Soft cost when a task lands on a day outside its preferred-window days. Non-negative integer — the solver types every weight as int."),
    preferred_time_miss_per_15min: z.number().int().min(0).optional().describe("Soft cost per 15 minutes a task's placement sits outside its preferred-window time-of-day range. Non-negative integer — the solver types every weight as int."),
  })
  .strict()
  .describe("Only the supplied fields change; each must be a non-negative integer (the solver's Weights model types every field int = Field(ge=0), so a fractional or infinite value here would poison a later resolve). Unknown keys are rejected (400), not silently ignored. At least one field is required.");

const ErrorResponse = z.object({
  error: z.string().describe("Machine-readable error code."),
  detail: z.string().optional().describe("Human-readable detail; not machine-readable."),
});

const errs = {
  401: { content: { "application/json": { schema: ErrorResponse } }, description: "Missing/invalid bearer" },
  403: { content: { "application/json": { schema: ErrorResponse } }, description: "Token carries no subject" },
} as const;

export function mountWeightsRoutes(
  v1: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>,
) {
  // `/weights` has no sub-paths, so one pattern suffices.
  mountOwnerGate(v1, "/weights");

  const get = createRoute({
    method: "get",
    path: "/weights",
    operationId: "getWeights",
    tags: ["config"],
    summary: "The caller's effective solver weights.",
    description: D.weightsConfig.getWeights,
    security: [{ BearerAuth: [] }],
    responses: {
      200: { content: { "application/json": { schema: WeightsResponse } }, description: "Effective weights" },
      ...errs,
    },
  });
  v1.openapi(get, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner gate above
    const effective = await loadEffectiveWeights(c.env.DB, owner);
    return c.json(effective, 200);
  });

  const patch = createRoute({
    method: "patch",
    path: "/weights",
    operationId: "updateWeights",
    tags: ["config"],
    summary: "Update the caller's solver weights.",
    description: D.weightsConfig.updateWeights,
    security: [{ BearerAuth: [] }],
    request: { body: { content: { "application/json": { schema: PatchWeightsBody } } } },
    responses: {
      200: { content: { "application/json": { schema: WeightsResponse } }, description: "New effective weights." },
      400: {
        content: { "application/json": { schema: ErrorResponse } },
        description: "Validation error: empty_update (no fields supplied), or validation_failed for a negative, fractional, or non-finite value, or an unknown key.",
      },
      ...errs,
    },
  });
  v1.openapi(patch, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner gate above
    const body = c.req.valid("json");
    // Cross-field, so the schema cannot state it: at least one field required.
    if (Object.keys(body).length === 0) {
      return c.json({ error: "empty_update", detail: "at least one field must be supplied" }, 400) as any;
    }
    const result = await saveWeights(c.env.DB, owner, body as Partial<SolverWeights>);
    return c.json(result, 200);
  });

  const del = createRoute({
    method: "delete",
    path: "/weights",
    operationId: "resetWeights",
    tags: ["config"],
    summary: "Reset the caller's solver weights to the instance defaults.",
    description: D.weightsConfig.resetWeights,
    security: [{ BearerAuth: [] }],
    responses: {
      200: { content: { "application/json": { schema: WeightsResponse } }, description: "Default weights." },
      ...errs,
    },
  });
  v1.openapi(del, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner gate above
    await deleteWeights(c.env.DB, owner);
    const effective = await loadEffectiveWeights(c.env.DB, owner);
    return c.json(effective, 200);
  });
}
