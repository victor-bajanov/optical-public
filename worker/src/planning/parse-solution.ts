import { z } from "zod";
import { fromLocalNaive } from "./datetime";
import type {
  LocalNaive,
  ObjectiveComponents,
  Diagnostics,
} from "./solver-contract";

const SolverScheduleEntrySchema = z.object({
  task_id: z.string(),
  chunk_id: z.string().regex(/^.+#\d+$/, "chunk_id must match <task_id>#<index>"),
  start: z.string(),
  duration_minutes: z.number().int().positive(),
  context: z.string(),
});

const SolverDroppedEntrySchema = z.object({
  task_id: z.string(),
  title: z.string(),
  drop_cost: z.number(),
  reason: z.string(),
  contributing_constraints: z.array(z.string()),
});

const SolverObjectiveSchema = z.object({
  total: z.number(),
  components: z.object({
    lateness: z.number(),
    fit: z.number(),
    churn: z.number(),
    daily_cap: z.number(),
    streak_cap: z.number(),
    drop: z.number(),
    preferred_window: z.number().optional().default(0),
  }),
});

const SolverDiagnosticsSchema = z.object({
  pass1_wall_seconds: z.number(),
  pass2_wall_seconds: z.number(),
  status: z.string(),
});

const SolverResponseSchema = z.object({
  schedule: z.array(SolverScheduleEntrySchema),
  dropped: z.array(SolverDroppedEntrySchema),
  objective: SolverObjectiveSchema,
  diagnostics: SolverDiagnosticsSchema,
});

const UnsatCoreEntrySchema = z.object({
  type: z.string(),
  // pydantic emits null for unset optional fields, not undefined; accept both.
  task_id: z.string().nullish(),
  value: z.string().nullish(),
  ref: z.string().nullish(),
});

const UnsatResponseSchema = z.object({
  unsat_core: z.array(UnsatCoreEntrySchema),
});

export type SolverDroppedEntry = z.infer<typeof SolverDroppedEntrySchema>;

export interface ParsedSolution {
  schedule: Array<{
    task_id: string;
    chunk_id: string;
    start: string; // ISO-Z
    end: string;   // ISO-Z
    context: string;
  }>;
  dropped: SolverDroppedEntry[];
  objective: { total: number; components: ObjectiveComponents };
  diagnostics: Diagnostics;
}

export function parseSolution(
  body: unknown,
  tz: string,
  realDurationByChunkId: Map<string, number>,
): ParsedSolution {
  const parsed = SolverResponseSchema.parse(body);
  const schedule = parsed.schedule.map((e) => {
    const startISO = fromLocalNaive(e.start as LocalNaive, tz);
    // The solver schedules in 15-min blocks, so e.duration_minutes is the
    // rounded-up reservation. Render the event end from the task's REAL
    // (unrounded) duration when known; fall back to the solver value otherwise.
    const realDur = realDurationByChunkId.get(e.chunk_id) ?? e.duration_minutes;
    const endISO = new Date(Date.parse(startISO) + realDur * 60_000).toISOString();
    return {
      task_id: e.task_id,
      chunk_id: e.chunk_id,
      start: startISO,
      end: endISO,
      context: e.context,
    };
  });
  return {
    schedule,
    dropped: parsed.dropped,
    objective: parsed.objective,
    diagnostics: parsed.diagnostics,
  };
}

export function parseUnsatCore(body: unknown): { unsat_core: z.infer<typeof UnsatCoreEntrySchema>[] } {
  return UnsatResponseSchema.parse(body);
}
