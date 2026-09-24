// Test seeding helper: backfill '__default__' config_contexts rows for any of
// the five known contexts a test didn't seed explicitly. loadEffectiveContexts
// (src/db/context-config.ts) resolves per context and throws when a context
// has neither a custom nor a default row — a config invariant migrations
// guarantee in real deployments — so tests that clear config_contexts must
// seed all five, not just the contexts they use. INSERT OR IGNORE keeps any
// row the test seeded explicitly (call this AFTER explicit seeding).
import { env } from "cloudflare:test";
import type { Context, ContextConfig } from "../../src/planning/solver-contract";
import { KNOWN_CONTEXTS } from "../../src/db/context-config";

/** The default body seedMissingDefaultContexts inserts for `context`. Exported
 *  so tests asserting on a context's default value (e.g. an unmodified-context
 *  check) restate this constant instead of duplicating the literal. */
export function defaultContextBody(context: Context): ContextConfig {
  return {
    context,
    fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "17:00" },
    max_minutes_per_day: null,
    max_contiguous_minutes: null,
    over_daily_cap_penalty_per_15min: 0,
    over_streak_cap_penalty_per_15min: 0,
  };
}

export async function seedMissingDefaultContexts(): Promise<void> {
  for (const context of KNOWN_CONTEXTS) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO config_contexts (owner_subject, context, body) VALUES ('__default__', ?, ?)",
    )
      .bind(context, JSON.stringify(defaultContextBody(context)))
      .run();
  }
}
