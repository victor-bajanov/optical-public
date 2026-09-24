// Per-user cost-model config: effective (per-context merged) context configs
// and solver weights. One row per (owner, context) in config_contexts and one
// per owner in config_weights; the '__default__' owner holds the
// migration-seeded instance defaults. Effective = the owner's row where
// present, else the default row — per context / per weights-row, so a user can
// customise some contexts and keep tracking the instance defaults on the rest.
// Saves store COMPLETE snapshots (partial merged over the effective value), so
// stored rows are self-contained and exactly what resolve ships to the solver;
// a customised row therefore stops tracking future default changes until
// deleted. Validation is the handlers' job — nothing here checks shapes.
import type { Context, ContextConfig, Weights as SolverWeights } from "../planning/solver-contract";
import { ContextEnum } from "../schema/common";

// Derived from the canonical schema enum so the context list has one source
// of truth; the order here is also the order loadEffectiveContexts returns.
export const KNOWN_CONTEXTS: readonly Context[] = ContextEnum.options;

export type ConfigSource = "custom" | "default";

/** The instance-default rows change only via migration; no runtime write path
 *  may target them. Unreachable through requireOwner today — this guards
 *  future callers. */
function assertNotDefaultOwner(owner: string): void {
  if (owner === "__default__") {
    throw new Error("refusing to modify '__default__' instance-default config rows");
  }
}

export interface EffectiveContext {
  context: Context;
  config: ContextConfig;
  source: ConfigSource;
}

export interface EffectiveWeights {
  // Required<>: loadEffectiveWeights back-fills the pre-migration-optional
  // preferred_* fields unconditionally, so callers always see all six.
  weights: Required<SolverWeights>;
  source: ConfigSource;
}

export async function loadEffectiveContexts(
  db: D1Database,
  owner: string,
): Promise<EffectiveContext[]> {
  const rows =
    (
      await db
        .prepare(
          "SELECT owner_subject, context, body FROM config_contexts WHERE owner_subject IN (?, '__default__')",
        )
        .bind(owner)
        .all<{ owner_subject: string; context: string; body: string }>()
    ).results ?? [];
  const own = new Map<string, string>();
  const defaults = new Map<string, string>();
  for (const r of rows) {
    (r.owner_subject === "__default__" ? defaults : own).set(r.context, r.body);
  }
  return KNOWN_CONTEXTS.map((context) => {
    // Unknown-context rows are ignored by construction: only the 5 known
    // contexts are ever looked up.
    const body = own.get(context) ?? defaults.get(context);
    if (!body) throw new Error(`config_contexts default row missing for '${context}'`);
    return {
      context,
      config: JSON.parse(body) as ContextConfig,
      source: own.has(context) ? "custom" : "default",
    };
  });
}

/** Merge `partial` over the owner's effective config and store the complete
 *  snapshot. `fit_curve`, when present, replaces atomically (shallow merge —
 *  the handler enforces the complete triple). No validation here. */
export async function saveContextConfig(
  db: D1Database,
  owner: string,
  context: Context,
  partial: Partial<ContextConfig>,
): Promise<EffectiveContext> {
  assertNotDefaultOwner(owner);
  const effective = (await loadEffectiveContexts(db, owner)).find((e) => e.context === context);
  if (!effective) throw new Error(`unknown context '${context}'`);
  // `context` inside the body is part of the solver wire shape; it must always
  // name the row's own context regardless of what the partial carries.
  const config: ContextConfig = { ...effective.config, ...partial, context };
  await db
    .prepare(
      `INSERT INTO config_contexts (owner_subject, context, body) VALUES (?, ?, ?)
       ON CONFLICT(owner_subject, context) DO UPDATE SET body = excluded.body`,
    )
    .bind(owner, context, JSON.stringify(config))
    .run();
  return { context, config, source: "custom" };
}

export async function deleteContextConfig(
  db: D1Database,
  owner: string,
  context: Context,
): Promise<void> {
  assertNotDefaultOwner(owner);
  await db
    .prepare("DELETE FROM config_contexts WHERE owner_subject = ? AND context = ?")
    .bind(owner, context)
    .run();
}

export async function loadEffectiveWeights(
  db: D1Database,
  owner: string,
): Promise<EffectiveWeights> {
  const row = await db
    .prepare(
      "SELECT owner_subject, body FROM config_weights WHERE owner_subject IN (?, '__default__') ORDER BY (owner_subject = ?) DESC LIMIT 1",
    )
    .bind(owner, owner)
    .first<{ owner_subject: string; body: string }>();
  if (!row) throw new Error("config_weights row missing");
  // Defaults for the soft preferred-window weights, so a pre-migration row
  // never sends `undefined` to the solver. Explicit row values win.
  return {
    weights: {
      preferred_day_miss: 40,
      preferred_time_miss_per_15min: 5,
      ...(JSON.parse(row.body) as SolverWeights),
    },
    source: row.owner_subject === owner && owner !== "__default__" ? "custom" : "default",
  };
}

/** Merge `partial` over the owner's effective weights and store the complete
 *  six-field snapshot. No validation here. */
export async function saveWeights(
  db: D1Database,
  owner: string,
  partial: Partial<SolverWeights>,
): Promise<EffectiveWeights> {
  assertNotDefaultOwner(owner);
  const { weights: effective } = await loadEffectiveWeights(db, owner);
  const weights: Required<SolverWeights> = { ...effective, ...partial };
  await db
    .prepare(
      `INSERT INTO config_weights (owner_subject, body) VALUES (?, ?)
       ON CONFLICT(owner_subject) DO UPDATE SET body = excluded.body`,
    )
    .bind(owner, JSON.stringify(weights))
    .run();
  return { weights, source: "custom" };
}

export async function deleteWeights(db: D1Database, owner: string): Promise<void> {
  assertNotDefaultOwner(owner);
  await db.prepare("DELETE FROM config_weights WHERE owner_subject = ?").bind(owner).run();
}
