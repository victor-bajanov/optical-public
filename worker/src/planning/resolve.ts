import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../env";
import type { CalendarProvider } from "../providers/calendar-provider";
import type { NotificationProvider } from "../providers/notification-provider";
import { requireOwner } from "../middleware/owner-gate";
import { defaultCalendarProvider } from "../index-providers";
import { ResolveResponse } from "../schema/resolve-response";
import { D } from "../schema/descriptions";
import { IsoDateTime } from "../schema/common";
import type { SolverWeights } from "./build-problem";
import { runResolve } from "./resolve-internal";

// Maximum solvable window span. The solver builds its CP-SAT model with one pass
// per 15-minute slot across the whole window, OUTSIDE the 30s solve time-limit,
// so the span — not the task count — bounds model-construction compute/memory.
// 366 days (leap-safe) is generous headroom for multi-week planning while
// keeping the horizon bounded (~35k slots).
const MAX_WINDOW_SPAN_MS = 366 * 24 * 60 * 60 * 1000;

export const ResolveBodySchema = z.object({
  window_start: IsoDateTime.describe(D.resolve.window_start),
  window_end: IsoDateTime.describe(D.resolve.window_end),
  weights_override: z.record(z.number()).optional().describe(D.resolve.weights_override),
  account_email: z.string().optional().describe(D.resolve.account_email),
}).refine(
  (b) => {
    const start = Date.parse(b.window_start);
    const end = Date.parse(b.window_end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    if (end <= start) return false;
    return end - start <= MAX_WINDOW_SPAN_MS;
  },
  {
    message: "window must be ordered (window_end after window_start) and span at most 366 days",
    path: ["window_end"],
  },
);

type AppVars = {
  calendarProvider: CalendarProvider;
  notificationProvider: NotificationProvider;
  subject?: string;
  ownerSubject?: string;
};

const UnsatResponse = z.record(z.unknown());
const SolverErrorResponse = z.object({
  error: z.literal("solver_failed"),
  status: z.number().describe(D.error.solver_status),
  detail: z.string().describe(D.error.solver_detail),
});
const InternalErrorResponse = z.object({
  error: z.literal("internal_error"),
  detail: z.string().describe(D.error.internal_detail),
});

export function mountResolveRoute(
  v1: OpenAPIHono<{ Bindings: Env; Variables: AppVars }>,
) {
  const resolveRoute = createRoute({
    method: "post",
    path: "/resolve",
    operationId: "resolve",
    summary: "Solve the optimal weekly schedule for a window and return a proposed plan hash.",
    description: "Run the solver over a date window and return a proposed plan: a plan_hash plus the schedule and any dropped tasks. Does not modify the calendar — inspect the plan, then accept or commit it.",
    security: [{ BearerAuth: [] }],
    // Note: middleware field omitted — v0.19.10 causes TypeScript union-type
    // mismatch when requireBearer's Variables: Vars conflicts with AppVars.
    // Using inline requireBearer call in the handler instead.
    request: {
      body: { content: { "application/json": { schema: ResolveBodySchema } }, required: true },
    },
    responses: {
      200: {
        content: { "application/json": { schema: ResolveResponse } },
        description: "Resolved schedule plan",
      },
      400: {
        content: {
          "application/json": {
            schema: z.object({ error: z.string(), issues: z.array(z.unknown()) }),
          },
        },
        description: "Validation error",
      },
      403: {
        content: {
          "application/json": {
            schema: z.object({ error: z.string() }),
          },
        },
        description: "Caller has no resolvable subject (no_subject)",
      },
      422: {
        content: { "application/json": { schema: UnsatResponse } },
        description: "Unsatisfiable constraints",
      },
      502: {
        content: { "application/json": { schema: SolverErrorResponse } },
        description: "Solver service error",
      },
      500: {
        content: { "application/json": { schema: InternalErrorResponse } },
        description: "Unhandled internal error",
      },
    },
  });

  v1.openapi(resolveRoute, async (c) => {
    const owner = await requireOwner(c);
    if (owner instanceof Response) return owner;
    const parsed = c.req.valid("json");
    // Scope the provider to the authenticated owner. The ?? yields to a provider
    // injected by tests; in production c.var is unset (no pre-auth middleware).
    const cal = c.var.calendarProvider ?? await defaultCalendarProvider(c.env, owner);
    try {
      const result = await runResolve({
        env: c.env,
        calendar: cal,
        windowStart: parsed.window_start,
        windowEnd: parsed.window_end,
        // Owner is the authenticated token subject — NEVER the request body.
        // parsed.account_email is accepted for backward compatibility but
        // deliberately ignored for ownership (it was spoofable).
        accountEmail: owner,
        trigger: "api",
        weightsOverride: parsed.weights_override as Partial<SolverWeights> | undefined,
      });
      if (result.kind === "unsat") return c.json(result.unsatCore as Record<string, unknown>, 422) as any;
      if (result.kind === "solver_error") {
        return c.json({ error: "solver_failed" as const, status: result.status, detail: result.detail }, 502) as any;
      }
      return c.json(
        {
          plan_hash: result.planHash,
          schedule: result.body.schedule,
          dropped: result.body.dropped,
          window: result.body.window,
          ...(result.body.warnings && result.body.warnings.length > 0
            ? { warnings: result.body.warnings }
            : {}),
        } as z.infer<typeof ResolveResponse>,
        200,
      );
    } catch (e) {
      // Non-dotted message key so Cloudflare log-forwarding does not mangle it,
      // matching the resolve_window_shed / resolve_coordinator_* convention.
      console.error("resolve_failed", {
        error: String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
      return c.json({ error: "internal_error" as const, detail: String(e) }, 500) as any;
    }
  });
}
