import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  KNOWN_CONTEXTS,
  loadEffectiveContexts,
  saveContextConfig,
  deleteContextConfig,
  loadEffectiveWeights,
  saveWeights,
  deleteWeights,
} from "../../src/db/context-config";
import type { ContextConfig } from "../../src/planning/solver-contract";

// Seeded instance defaults after migrations 0002 → 0005 → 0007 (see those files).
const DEFAULT_DEEP: ContextConfig = {
  context: "deep",
  fit_curve: { peak_start: "12:00", peak_end: "16:00", falloff_end: "17:00" },
  max_minutes_per_day: 240,
  max_contiguous_minutes: 90,
  over_daily_cap_penalty_per_15min: 25,
  over_streak_cap_penalty_per_15min: 25,
};
const DEFAULT_ADMIN: ContextConfig = {
  context: "admin",
  fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "15:00" },
  max_minutes_per_day: 120,
  max_contiguous_minutes: 60,
  over_daily_cap_penalty_per_15min: 25,
  over_streak_cap_penalty_per_15min: 25,
};

// Default weights after 0002 → 0011.
const DEFAULT_WEIGHTS = {
  time_of_day_fit_per_15min: 5,
  churn_per_15min_moved: 10,
  priority_unit: 1,
  base_drop_penalty: 200,
  preferred_day_miss: 40,
  preferred_time_miss_per_15min: 5,
};

const OWNER = "user@org";

function customConfig(context: string, peak = "06:00"): ContextConfig {
  return {
    context: context as ContextConfig["context"],
    fit_curve: { peak_start: peak, peak_end: "07:00", falloff_end: "08:00" },
    max_minutes_per_day: 999,
    max_contiguous_minutes: 111,
    over_daily_cap_penalty_per_15min: 3,
    over_streak_cap_penalty_per_15min: 4,
  };
}

async function insertContextRow(owner: string, context: string, body: unknown) {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO config_contexts (owner_subject, context, body) VALUES (?, ?, ?)",
  )
    .bind(owner, context, JSON.stringify(body))
    .run();
}

beforeEach(async () => {
  // Keep the migration-seeded '__default__' rows; clear everything user-owned.
  await env.DB.prepare("DELETE FROM config_contexts WHERE owner_subject != '__default__'").run();
  await env.DB.prepare("DELETE FROM config_weights WHERE owner_subject != '__default__'").run();
});

describe("loadEffectiveContexts", () => {
  it("returns 5 default configs (seeded values) when the owner has no custom rows", async () => {
    const rows = await loadEffectiveContexts(env.DB, OWNER);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.context).sort()).toEqual(
      ["admin", "deep", "family", "meeting", "physical"],
    );
    for (const r of rows) expect(r.source).toBe("default");
    const deep = rows.find((r) => r.context === "deep")!;
    expect(deep.config).toEqual(DEFAULT_DEEP);
    const admin = rows.find((r) => r.context === "admin")!;
    expect(admin.config).toEqual(DEFAULT_ADMIN);
  });

  it("merges per-context: one custom context leaves the other four on defaults", async () => {
    const custom = customConfig("deep");
    await insertContextRow(OWNER, "deep", custom);
    const rows = await loadEffectiveContexts(env.DB, OWNER);
    expect(rows).toHaveLength(5);
    const deep = rows.find((r) => r.context === "deep")!;
    expect(deep.source).toBe("custom");
    expect(deep.config).toEqual(custom);
    for (const r of rows.filter((x) => x.context !== "deep")) {
      expect(r.source).toBe("default");
    }
    expect(rows.find((r) => r.context === "admin")!.config).toEqual(DEFAULT_ADMIN);
  });

  it("returns all five custom when every context is customised", async () => {
    for (const ctx of KNOWN_CONTEXTS) await insertContextRow(OWNER, ctx, customConfig(ctx));
    const rows = await loadEffectiveContexts(env.DB, OWNER);
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.source).toBe("custom");
      expect(r.config.max_minutes_per_day).toBe(999);
    }
  });

  it("ignores unknown-context rows defensively", async () => {
    await insertContextRow(OWNER, "gym", customConfig("gym"));
    const rows = await loadEffectiveContexts(env.DB, OWNER);
    expect(rows).toHaveLength(5);
    expect(rows.find((r) => (r.context as string) === "gym")).toBeUndefined();
  });

  it("throws when a default row is missing and the owner has no custom row for it", async () => {
    const saved = await env.DB.prepare(
      "SELECT body FROM config_contexts WHERE owner_subject = '__default__' AND context = 'deep'",
    ).first<{ body: string }>();
    await env.DB.prepare(
      "DELETE FROM config_contexts WHERE owner_subject = '__default__' AND context = 'deep'",
    ).run();
    try {
      await expect(loadEffectiveContexts(env.DB, OWNER)).rejects.toThrow(/deep/);
    } finally {
      await insertContextRow("__default__", "deep", JSON.parse(saved!.body));
    }
  });
});

describe("saveContextConfig", () => {
  it("stores a complete snapshot when given a partial body", async () => {
    await saveContextConfig(env.DB, OWNER, "deep", { max_minutes_per_day: 300 });
    const row = await env.DB.prepare(
      "SELECT body FROM config_contexts WHERE owner_subject = ? AND context = 'deep'",
    )
      .bind(OWNER)
      .first<{ body: string }>();
    expect(row).not.toBeNull();
    // Full snapshot: default curve + caps, with only the patched field changed.
    expect(JSON.parse(row!.body)).toEqual({ ...DEFAULT_DEEP, max_minutes_per_day: 300 });
    const deep = (await loadEffectiveContexts(env.DB, OWNER)).find((r) => r.context === "deep")!;
    expect(deep.source).toBe("custom");
    expect(deep.config.max_minutes_per_day).toBe(300);
    expect(deep.config.fit_curve).toEqual(DEFAULT_DEEP.fit_curve);
  });

  it("merges over the owner's existing custom row, replacing fit_curve atomically", async () => {
    await saveContextConfig(env.DB, OWNER, "deep", { max_minutes_per_day: 300 });
    const curve = { peak_start: "05:00", peak_end: "06:00", falloff_end: "07:00" };
    await saveContextConfig(env.DB, OWNER, "deep", { fit_curve: curve });
    const deep = (await loadEffectiveContexts(env.DB, OWNER)).find((r) => r.context === "deep")!;
    expect(deep.config.fit_curve).toEqual(curve);
    expect(deep.config.max_minutes_per_day).toBe(300); // earlier patch survives
    expect(deep.config.max_contiguous_minutes).toBe(DEFAULT_DEEP.max_contiguous_minutes);
  });

  it("returns the new effective config", async () => {
    const out = await saveContextConfig(env.DB, OWNER, "admin", { over_daily_cap_penalty_per_15min: 7 });
    expect(out.source).toBe("custom");
    expect(out.context).toBe("admin");
    expect(out.config).toEqual({ ...DEFAULT_ADMIN, over_daily_cap_penalty_per_15min: 7 });
  });
});

describe("deleteContextConfig", () => {
  it("reverts the context to default and is idempotent", async () => {
    await saveContextConfig(env.DB, OWNER, "deep", { max_minutes_per_day: 300 });
    await deleteContextConfig(env.DB, OWNER, "deep");
    const deep = (await loadEffectiveContexts(env.DB, OWNER)).find((r) => r.context === "deep")!;
    expect(deep.source).toBe("default");
    expect(deep.config).toEqual(DEFAULT_DEEP);
    // Second delete of a row that no longer exists must not throw.
    await deleteContextConfig(env.DB, OWNER, "deep");
    // Other contexts untouched.
    await saveContextConfig(env.DB, OWNER, "admin", { max_minutes_per_day: 60 });
    await deleteContextConfig(env.DB, OWNER, "deep");
    const admin = (await loadEffectiveContexts(env.DB, OWNER)).find((r) => r.context === "admin")!;
    expect(admin.source).toBe("custom");
  });
});

describe("weights", () => {
  it("loads the seeded defaults with source 'default'", async () => {
    const { weights, source } = await loadEffectiveWeights(env.DB, OWNER);
    expect(source).toBe("default");
    expect(weights).toEqual(DEFAULT_WEIGHTS);
  });

  it("partial save snapshots all six fields; load shows source 'custom'", async () => {
    await saveWeights(env.DB, OWNER, { churn_per_15min_moved: 40 });
    const row = await env.DB.prepare("SELECT body FROM config_weights WHERE owner_subject = ?")
      .bind(OWNER)
      .first<{ body: string }>();
    expect(JSON.parse(row!.body)).toEqual({ ...DEFAULT_WEIGHTS, churn_per_15min_moved: 40 });
    const { weights, source } = await loadEffectiveWeights(env.DB, OWNER);
    expect(source).toBe("custom");
    expect(weights).toEqual({ ...DEFAULT_WEIGHTS, churn_per_15min_moved: 40 });
  });

  it("delete reverts to default and is idempotent", async () => {
    await saveWeights(env.DB, OWNER, { churn_per_15min_moved: 40 });
    await deleteWeights(env.DB, OWNER);
    const { weights, source } = await loadEffectiveWeights(env.DB, OWNER);
    expect(source).toBe("default");
    expect(weights).toEqual(DEFAULT_WEIGHTS);
    await deleteWeights(env.DB, OWNER); // no throw
  });

  it("back-fills preferred_* on a pre-migration default row", async () => {
    const saved = await env.DB.prepare(
      "SELECT body FROM config_weights WHERE owner_subject = '__default__'",
    ).first<{ body: string }>();
    const bare = {
      time_of_day_fit_per_15min: 5,
      churn_per_15min_moved: 10,
      priority_unit: 1,
      base_drop_penalty: 200,
    };
    await env.DB.prepare("UPDATE config_weights SET body = ? WHERE owner_subject = '__default__'")
      .bind(JSON.stringify(bare))
      .run();
    try {
      const { weights, source } = await loadEffectiveWeights(env.DB, OWNER);
      expect(source).toBe("default");
      expect(weights.preferred_day_miss).toBe(40);
      expect(weights.preferred_time_miss_per_15min).toBe(5);
    } finally {
      await env.DB.prepare("UPDATE config_weights SET body = ? WHERE owner_subject = '__default__'")
        .bind(saved!.body)
        .run();
    }
  });

  it("refuses to write or delete the '__default__' sentinel rows", async () => {
    await expect(saveWeights(env.DB, "__default__", { churn_per_15min_moved: 1 })).rejects.toThrow(
      /__default__/,
    );
    await expect(deleteWeights(env.DB, "__default__")).rejects.toThrow(/__default__/);
    await expect(
      saveContextConfig(env.DB, "__default__", "deep", { max_minutes_per_day: 1 }),
    ).rejects.toThrow(/__default__/);
    await expect(deleteContextConfig(env.DB, "__default__", "deep")).rejects.toThrow(/__default__/);
    // The sentinel rows are untouched.
    const { weights, source } = await loadEffectiveWeights(env.DB, OWNER);
    expect(source).toBe("default");
    expect(weights).toEqual(DEFAULT_WEIGHTS);
    const deep = (await loadEffectiveContexts(env.DB, OWNER)).find((r) => r.context === "deep")!;
    expect(deep.source).toBe("default");
    expect(deep.config).toEqual(DEFAULT_DEEP);
  });

  it("returns the new effective weights from save", async () => {
    const out = await saveWeights(env.DB, OWNER, { base_drop_penalty: 555 });
    expect(out.source).toBe("custom");
    expect(out.weights).toEqual({ ...DEFAULT_WEIGHTS, base_drop_penalty: 555 });
  });
});
