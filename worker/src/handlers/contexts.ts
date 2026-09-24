// worker/src/handlers/contexts.ts
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { AppVariables } from "../index-providers";
import { mountOwnerGate } from "../middleware/owner-gate";
import { loadEffectiveContexts, saveContextConfig, deleteContextConfig } from "../db/context-config";
import { ContextEnum, CLOCK_TIME } from "../schema/common";
import { D } from "../schema/descriptions";

const FitCurveSchema = z.object({
  peak_start: z.string().regex(CLOCK_TIME).describe("Local HH:MM where the fit score is best. <= peak_end."),
  peak_end: z.string().regex(CLOCK_TIME).describe("Local HH:MM where the peak plateau ends. >= peak_start, <= falloff_end."),
  falloff_end: z.string().regex(CLOCK_TIME).describe("Local HH:MM where the fit score reaches its floor. >= peak_end."),
}).describe(
  "Time-of-day fit curve for this context, local to the caller's home timezone (matching the solve window). Atomic: a PATCH supplying fit_curve must carry the complete triple.",
);

// Penalties are `int = Field(ge=0)` on the solver side (schema.py:60-61);
// Pydantic's lax mode rejects a fractional float (12.5) but accepts a
// whole-valued one (12.0) — `.int()` mirrors that exactly, and also rejects
// Infinity/NaN, which `.min(0)` alone would let through the wire.
const PenaltySchema = z.number().int().min(0);

const ContextConfigBody = z.object({
  fit_curve: FitCurveSchema.optional(),
  max_minutes_per_day: z.number().int().positive().nullable().optional().describe(
    "Cap on minutes of this context scheduled per day. null = uncapped. Positive only — 0 is deliberately rejected (the solver would accept it, but a zero-cap context should be expressed by not scheduling tasks in it, not by a cap that silently drops everything).",
  ),
  max_contiguous_minutes: z.number().int().positive().nullable().optional().describe(
    "Cap on a single contiguous block of this context. null = uncapped. Positive only — 0 is deliberately rejected.",
  ),
  over_daily_cap_penalty_per_15min: PenaltySchema.optional().describe(
    "Non-negative integer soft-cost weight per 15 minutes over max_minutes_per_day. Only meaningful when that cap is set.",
  ),
  over_streak_cap_penalty_per_15min: PenaltySchema.optional().describe(
    "Non-negative integer soft-cost weight per 15 minutes over max_contiguous_minutes. Only meaningful when that cap is set.",
  ),
}).strict().describe("Partial context scheduling config. Every field is optional; at least one must be supplied. Unknown fields are rejected.");

const ContextConfigResponseBody = z.object({
  context: ContextEnum.describe("The context name."),
  fit_curve: FitCurveSchema,
  max_minutes_per_day: z.number().int().positive().nullable()
    .describe("Daily soft cap in minutes for this context; null = uncapped."),
  max_contiguous_minutes: z.number().int().positive().nullable()
    .describe("Contiguous-streak soft cap in minutes for this context; null = uncapped."),
  over_daily_cap_penalty_per_15min: PenaltySchema
    .describe("Non-negative integer soft-cost weight per 15 minutes over max_minutes_per_day."),
  over_streak_cap_penalty_per_15min: PenaltySchema
    .describe("Non-negative integer soft-cost weight per 15 minutes over max_contiguous_minutes."),
}).describe("The context's full scheduling config (fit curve, caps, penalties).");

// One shape for both the GET list's entries and the PATCH/DELETE single-item
// response — a context's effective config always looks the same regardless
// of which verb produced it.
const ContextEntry = z.object({
  context: ContextEnum.describe("The context name (e.g. 'admin', 'deep')."),
  body: ContextConfigResponseBody.describe("The context's scheduling config (fit curve, caps)."),
  source: z.enum(["custom", "default"]).describe(
    "'custom' if the caller has their own row for this context, else 'default' (tracking the instance default).",
  ),
});

const ErrorResponse = z.object({
  error: z.string().describe("Machine-readable error code."),
  detail: z.string().optional().describe("Human-readable detail; not machine-readable."),
});

const errs = {
  401: { content: { "application/json": { schema: ErrorResponse } }, description: "Missing/invalid bearer" },
  403: { content: { "application/json": { schema: ErrorResponse } }, description: "Token carries no subject" },
} as const;

class ValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** Cross-field checks the Zod shape can't express: fit_curve ordering.
 *  Mirrors the solver's Pydantic validator (schema.py) so the worker rejects
 *  everything the solver would. */
function validateFitCurveOrdering(curve: { peak_start: string; peak_end: string; falloff_end: string }) {
  if (curve.peak_start > curve.peak_end) {
    throw new ValidationError("invalid_fit_curve", "peak_start must be <= peak_end");
  }
  if (curve.peak_end > curve.falloff_end) {
    throw new ValidationError("invalid_fit_curve", "peak_end must be <= falloff_end");
  }
}

export function mountContextsRoute(
  v1: OpenAPIHono<{ Bindings: Env; Variables: AppVariables }>,
) {
  // Both path patterns are needed: the exact GET path and the wildcard for
  // the {context} routes.
  mountOwnerGate(v1, "/contexts", "/contexts/*");

  const getRoute = createRoute({
    method: "get",
    path: "/contexts",
    operationId: "getContexts",
    tags: ["config"],
    summary: "The caller's effective context configuration.",
    description: D.contextConfig.getContexts,
    security: [{ BearerAuth: [] }],
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              contexts: z.array(ContextEntry).describe(
                "The caller's 5 effective per-context configs, each independently either their own customisation or the instance default.",
              ),
            }),
          },
        },
        description: "Effective contexts",
      },
      ...errs,
    },
  });
  v1.openapi(getRoute, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner gate above
    const effective = await loadEffectiveContexts(c.env.DB, owner);
    return c.json(
      { contexts: effective.map((e) => ({ context: e.context, body: e.config, source: e.source })) },
      200,
    );
  });

  const patchRoute = createRoute({
    method: "patch",
    path: "/contexts/{context}",
    operationId: "updateContext",
    tags: ["config"],
    summary: "Update one context's scheduling config.",
    description: D.contextConfig.updateContext,
    security: [{ BearerAuth: [] }],
    request: {
      params: z.object({ context: ContextEnum.describe("The context name.") }),
      body: { content: { "application/json": { schema: ContextConfigBody } } },
    },
    responses: {
      200: {
        content: { "application/json": { schema: ContextEntry } },
        description: "The context's new effective config.",
      },
      400: {
        content: { "application/json": { schema: ErrorResponse } },
        description:
          "validation_failed for anything the request schema itself rejects (malformed HH:MM, an incomplete fit_curve triple, an unknown context, a non-integer/negative penalty, a non-positive cap, or an unknown field — the body is strict); invalid_fit_curve for a fit_curve that parses but is out of order (peak_start > peak_end, or peak_end > falloff_end); empty_update for a body with no fields at all.",
      },
      ...errs,
    },
  });
  v1.openapi(patchRoute, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner gate above
    const { context } = c.req.valid("param");
    const patch = c.req.valid("json");

    // Cross-field, so the schema cannot state it: at least one field required.
    // Key-count, not a per-field chain, so a future ContextConfigBody field
    // can't silently break the guard (matches weights.ts).
    if (Object.keys(patch).length === 0) {
      return c.json({ error: "empty_update", detail: "at least one field must be supplied" }, 400) as any;
    }

    try {
      if (patch.fit_curve !== undefined) validateFitCurveOrdering(patch.fit_curve);
    } catch (err) {
      if (err instanceof ValidationError) return c.json({ error: err.code, detail: err.message }, 400) as any;
      throw err;
    }

    const result = await saveContextConfig(c.env.DB, owner, context, patch);
    return c.json({ context: result.context, body: result.config, source: result.source }, 200);
  });

  const deleteRoute = createRoute({
    method: "delete",
    path: "/contexts/{context}",
    operationId: "resetContext",
    tags: ["config"],
    summary: "Reset one context to the instance default.",
    description: D.contextConfig.resetContext,
    security: [{ BearerAuth: [] }],
    request: {
      params: z.object({ context: ContextEnum.describe("The context name.") }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: ContextEntry } },
        description: "The context's effective (default) config.",
      },
      400: {
        content: { "application/json": { schema: ErrorResponse } },
        description: "validation_failed: unknown context in the path.",
      },
      ...errs,
    },
  });
  v1.openapi(deleteRoute, async (c) => {
    const owner = c.var.ownerSubject!; // set by the scoped requireOwner gate above
    const { context } = c.req.valid("param");
    await deleteContextConfig(c.env.DB, owner, context);
    const effective = (await loadEffectiveContexts(c.env.DB, owner)).find((e) => e.context === context)!;
    return c.json({ context: effective.context, body: effective.config, source: effective.source }, 200);
  });
}
