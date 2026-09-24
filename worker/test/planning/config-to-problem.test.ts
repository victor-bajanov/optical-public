// Card D: TDD pins that the correct per-context curve and weights flow all
// the way from stored config rows into the solver payload (Problem.contexts /
// Problem.weights). See internal design notes, Card D.
//
// Pins 1-2 drive the actual production entrypoint, `runResolve`
// (src/planning/resolve-internal.ts), with a capturing solver stub and assert
// on the Problem it hands the solver — the same shape as
// test/merge-gate/per-user-config-gate.test.ts. This is deliberate: an
// earlier version of this file composed the lower-level loader
// (loadEffectiveContexts) directly with buildSolverProblem, which does NOT
// exercise resolve-internal's own private `loadContexts` wiring and stays
// green even if that wiring regresses to its pre-Card-A wholesale fallback —
// a mutation test proved it. Going through runResolve closes that gap.
//
// Pins 3-4 use `loadWeights` (exported from resolve-internal.ts and the exact
// function it calls internally) composed with buildSolverProblem — that IS
// the production seam for weights, so no capturing-solver indirection is
// needed there.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { runResolve, loadWeights } from "../../src/planning/resolve-internal";
import { buildSolverProblem } from "../../src/planning/build-problem";
import { MockCalendarProvider } from "../../src/providers/mock-calendar-provider";
import { upsertUser } from "../../src/db/users";
import type { ContextConfig, Weights } from "../../src/planning/solver-contract";
import type { Fetcher } from "@cloudflare/workers-types";
import { seedMissingDefaultContexts, defaultContextBody } from "../fixtures/seed-contexts";

const WINDOW = { start: "2026-05-18T00:00:00Z", end: "2026-05-25T00:00:00Z" };
const TZ = "Australia/Sydney";
const KNOWN_CONTEXTS = ["deep", "admin", "physical", "family", "meeting"] as const;

const CUSTOM_DEEP: ContextConfig = {
  context: "deep",
  fit_curve: { peak_start: "06:00", peak_end: "07:00", falloff_end: "08:00" },
  max_minutes_per_day: 60,
  max_contiguous_minutes: 30,
  over_daily_cap_penalty_per_15min: 999,
  over_streak_cap_penalty_per_15min: 999,
};

const DEFAULT_WEIGHTS: Weights = {
  time_of_day_fit_per_15min: 5,
  churn_per_15min_moved: 10,
  priority_unit: 1,
  base_drop_penalty: 200,
};

// A stub solver that records the Problem it was handed and returns an empty
// schedule — crib of test/merge-gate/per-user-config-gate.test.ts's
// capturingSolver.
function capturingSolver(captured: { problem?: any }): Fetcher {
  return {
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured.problem = JSON.parse(init!.body as string);
      return new Response(
        JSON.stringify({
          schedule: [],
          dropped: [],
          objective: { total: 0, components: { lateness: 0, fit: 0, churn: 0, daily_cap: 0, streak_cap: 0, drop: 0 } },
          diagnostics: { pass1_wall_seconds: 0, pass2_wall_seconds: 0, status: "OPTIMAL" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  } as unknown as Fetcher;
}

async function seedTask(subject: string, id: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO tasks (id, owner_subject, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', '2026-05-17T00:00:00Z', '2026-05-17T00:00:00Z')",
  )
    .bind(
      id,
      subject,
      JSON.stringify({
        id,
        title: "Deep work",
        context: "deep",
        priority: 80,
        duration_minutes: 90,
        earliest_start: "2026-05-18T00:00:00Z",
      }),
    )
    .run();
}

async function resolveAndCapture(owner: string): Promise<any> {
  const captured: { problem?: any } = {};
  await runResolve({
    env: { ...env, SOLVER: capturingSolver(captured) } as typeof env,
    calendar: new MockCalendarProvider(),
    windowStart: WINDOW.start,
    windowEnd: WINDOW.end,
    accountEmail: owner,
    trigger: "api",
  });
  return captured.problem;
}

describe("config-to-problem: effective config flows into the solver payload", () => {
  beforeEach(async () => {
    // Frozen inside the fixed window so runResolve's fully-past-week guard
    // never short-circuits before the solver call.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00.000Z"));
    for (const t of ["tasks", "task_templates", "proposed_plans", "config_weights", "config_contexts", "users"]) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
    await seedMissingDefaultContexts();
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify(DEFAULT_WEIGHTS))
      .run();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pin 1: a custom 'deep' row rides into Problem.contexts alongside the 4 defaults", async () => {
    await upsertUser(env.DB, "user@org");
    await env.DB.prepare(
      "INSERT INTO config_contexts (owner_subject, context, body) VALUES (?, 'deep', ?)",
    )
      .bind("user@org", JSON.stringify(CUSTOM_DEEP))
      .run();
    await seedTask("user@org", "t1");

    const problem = await resolveAndCapture("user@org");

    expect(problem.contexts).toHaveLength(5);
    const byContext = new Map<string, ContextConfig>(problem.contexts.map((c: ContextConfig) => [c.context, c]));
    expect(byContext.get("deep")).toEqual(CUSTOM_DEEP);
    // The custom deep config must actually differ from the default — otherwise
    // this pin wouldn't distinguish the merge path from a wholesale fallback.
    expect(byContext.get("deep")).not.toEqual(defaultContextBody("deep"));
    for (const ctx of ["admin", "physical", "family", "meeting"] as const) {
      expect(byContext.get(ctx)).toEqual(defaultContextBody(ctx));
    }
  });

  it("pin 2: a user with no custom rows gets the 5 defaults in Problem.contexts", async () => {
    await upsertUser(env.DB, "nobody@org");
    await seedTask("nobody@org", "t1");

    const problem = await resolveAndCapture("nobody@org");

    expect(problem.contexts).toHaveLength(5);
    const byContext = new Map<string, ContextConfig>(problem.contexts.map((c: ContextConfig) => [c.context, c]));
    for (const ctx of KNOWN_CONTEXTS) {
      expect(byContext.get(ctx)).toEqual(defaultContextBody(ctx));
    }
  });

  it("pin 3: a custom weights row's churn_per_15min_moved rides into Problem.weights", async () => {
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES (?, ?)")
      .bind("user@org", JSON.stringify({ ...DEFAULT_WEIGHTS, churn_per_15min_moved: 47 }))
      .run();

    const weights = await loadWeights(env.DB, "user@org");
    const problem = buildSolverProblem({
      tasks: [],
      externalEvents: [],
      previousSchedule: [],
      window: WINDOW,
      weights,
      contexts: KNOWN_CONTEXTS.map((c) => defaultContextBody(c)),
      tz: TZ,
    });

    expect(problem.weights.churn_per_15min_moved).toBe(47);
    // Must differ from the instance default to prove this isn't just reading
    // the '__default__' row back.
    expect(problem.weights.churn_per_15min_moved).not.toBe(DEFAULT_WEIGHTS.churn_per_15min_moved);
  });

  it("pin 4: per-resolve weights_override wins over the custom row, other custom fields survive", async () => {
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES (?, ?)")
      .bind(
        "user@org",
        JSON.stringify({ ...DEFAULT_WEIGHTS, churn_per_15min_moved: 47, base_drop_penalty: 555 }),
      )
      .run();

    const weights = await loadWeights(env.DB, "user@org");
    const problem = buildSolverProblem({
      tasks: [],
      externalEvents: [],
      previousSchedule: [],
      window: WINDOW,
      weights,
      contexts: KNOWN_CONTEXTS.map((c) => defaultContextBody(c)),
      tz: TZ,
      weightsOverride: { churn_per_15min_moved: 999 },
    });

    // Override wins for the field it names.
    expect(problem.weights.churn_per_15min_moved).toBe(999);
    // The custom row's other field survives the override merge (precedence
    // chain: default row < custom row < weights_override, field-by-field).
    expect(problem.weights.base_drop_penalty).toBe(555);
  });
});
