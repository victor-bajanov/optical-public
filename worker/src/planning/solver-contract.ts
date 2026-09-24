// Canonical wire-shape types between the Worker and the Python solver.
// Mirrors solver/src/solver/schema.py 1:1. Types-only — no runtime
// validation here. build-problem.ts produces these; parse-solution.ts
// consumes them. The contract test in test/planning/solver-contract.test.ts
// pipes serialized output through the actual Pydantic validator.

export type LocalNaive = string & { readonly __brand: "LocalNaive" };
// Format: "YYYY-MM-DDTHH:MM:SS" — no zone suffix; aligned to 15-min boundary.

export type Context = "deep" | "admin" | "physical" | "family" | "meeting";
export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface Window {
  start: LocalNaive;
  end: LocalNaive;
  tz: string;
}

export interface Weights {
  time_of_day_fit_per_15min: number;
  churn_per_15min_moved: number;
  priority_unit: number;
  base_drop_penalty: number;
  // Soft preferred-window preference (distance-graded). Optional on the wire:
  // loadWeights always populates them at runtime; the solver defaults to 0.
  preferred_day_miss?: number;
  preferred_time_miss_per_15min?: number;
}

export interface FitCurve {
  peak_start: string;   // "HH:MM"
  peak_end: string;
  falloff_end: string;
}

export interface ContextConfig {
  context: Context;
  fit_curve: FitCurve;
  max_minutes_per_day: number | null;
  max_contiguous_minutes: number | null;
  over_daily_cap_penalty_per_15min: number;
  over_streak_cap_penalty_per_15min: number;
}

export interface Chunk {
  chunk_id: string;
  duration_minutes: number;
}

export interface GroupPolicy {
  same_day: boolean;
  ordered: boolean;
}

export interface Deadline {
  at: LocalNaive;
  hard: boolean;
  penalty_per_15min: number;
}

export interface PreferredWindow {
  days: Weekday[];
  start: string;
  end: string;
  hard: boolean;
}

/**
 * Global business-hours policy, stored singleton-style in
 * config_business_hours. Passed through to the solver as Problem.business_hours
 * and applied as a presence-gated placement floor: a task with no pin and no
 * preferred_windows of its own must, if scheduled, land inside these hours.
 * It does NOT make tasks mandatory — unfittable work drops.
 */
export interface BusinessHours {
  days: Weekday[];
  start: string; // "HH:MM"
  end: string;   // "HH:MM"
}

export interface Dependency {
  type: "after_task" | "before_event" | "after_event" | "before_task";
  ref: string;
  hard: boolean;
}

export interface PreviousPlacement {
  chunk_id: string;
  start: LocalNaive;
}

export interface AvailabilityWindow {
  start: LocalNaive;
  end: LocalNaive;
}

export interface WireTask {
  id: string;
  title: string;
  context: Context;
  priority: number;
  chunks: Chunk[];
  group_policy: GroupPolicy;
  deadline?: Deadline;
  earliest_start: LocalNaive;
  preferred_windows: PreferredWindow[];
  dependencies: Dependency[];
  pinned_at?: LocalNaive;
  previous_placement: PreviousPlacement[];
  must_include: boolean;
  // Hard allowed-placement mask (concrete intervals). Optional on the wire:
  // ordinary tasks omit it; the solver defaults to [] (unconstrained).
  availability_windows?: AvailabilityWindow[];
  // Per-task churn coefficient multiplier (attendee-count scaling). Optional:
  // solver defaults to 1.
  churn_multiplier?: number;
}

export interface ExternalPinned {
  id: string;
  title: string;
  start: LocalNaive;
  duration_minutes: number;
  context: Context;
}

export interface Problem {
  window: Window;
  weights: Weights;
  contexts: ContextConfig[];
  tasks: WireTask[];
  external_pinned: ExternalPinned[];
  business_hours?: BusinessHours | null;
}

export interface ScheduledChunk {
  task_id: string;
  chunk_id: string;
  start: LocalNaive;
  duration_minutes: number;
  context: Context;
}

export interface DroppedTask {
  task_id: string;
  title: string;
  drop_cost: number;
  reason: string;
  contributing_constraints: string[];
}

export interface ObjectiveComponents {
  lateness: number;
  fit: number;
  churn: number;
  daily_cap: number;
  streak_cap: number;
  drop: number;
  preferred_window: number;
}

export interface Objective {
  total: number;
  components: ObjectiveComponents;
}

export interface Diagnostics {
  pass1_wall_seconds: number;
  pass2_wall_seconds: number;
  status: string;
  /** Bespoke engine only (additive): incumbent cost − best proven bound.
   * 0 whenever the status is a certificate (OPTIMAL). */
  bound_gap?: number;
  /** Bespoke engine only (additive): total search nodes across passes. */
  nodes?: number;
  // Search-strengthening instrumentation (additive, engine only; log line +
  // internal, never exposed by worker/src/schema/ —
  // internal design notes card A):
  /** Pass 2's root lower bound. Absent when pass 2 produced no root scan. */
  root_bound?: number;
  /** Cost of the pre-search (greedy/warm) incumbent. Absent when none. */
  root_incumbent?: number;
  /** Lagrangian root bound minus the separable root bound (D1; 0 when the
   * root shortcut closes before the dual runs). */
  bound_lift?: number;
  /** Improvement-phase iterations run (D3; hard 0 on every solve where the
   * phase did not run, certified solves included). */
  improve_iterations?: number;
  /** Improvement-phase strict improvements kept (D3; hard 0 as above). */
  improve_accepted?: number;
  /** Sub-solve requests ISSUED to the fan-out escape hatch's external batch
   * driver (card E; 0 on the in-process path). On a degraded session some
   * of these were recomputed sequentially — the engine_fanout /
   * engine_fanout_degraded log lines carry the consumed-vs-degraded split. */
  fanout_subsolves?: number;
}

export interface Solution {
  schedule: ScheduledChunk[];
  dropped: DroppedTask[];
  objective: Objective;
  diagnostics: Diagnostics;
}

export interface UnsatItem {
  type: string;
  task_id?: string;
  ref?: string;
  value?: string;
}

export interface UnsatResponse {
  unsat_core: UnsatItem[];
}
