import { SELF, env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { seedTwoUsers, type SeededUser } from "../fixtures/owners";
import { seedMissingDefaultContexts } from "../fixtures/seed-contexts";
import { upsertUser } from "../../src/db/users";

// A future window so the fully-past-week guard (resolve-internal.ts:225) does not
// short-circuit before the calendar fetch (resolve-internal.ts:257) that triggers
// getAccessToken and the identity-token lookup. Far-future keeps it date-robust.
const BODY = JSON.stringify({
  window_start: "2099-01-05T00:00:00Z",
  window_end: "2099-01-12T00:00:00Z",
});

describe("/v1/resolve binds the provider to the bearer, not the first active user", () => {
  let a: SeededUser, b: SeededUser;

  beforeEach(async () => {
    // Deterministic active-user + credential state.
    await env.DB.prepare("DELETE FROM users").run();
    await env.DB.prepare("DELETE FROM identity_tokens").run();
    await env.DB.prepare("DELETE FROM config_weights").run();
    await env.DB.prepare("DELETE FROM config_contexts").run();
    // Default solver config so resolve reaches the calendar fetch (loadWeights /
    // loadContexts run before fetchEventsInWindow) rather than erroring earlier.
    await env.DB.prepare("INSERT INTO config_weights (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify({ time_of_day_fit_per_15min: 5, churn_per_15min_moved: 10, priority_unit: 1, base_drop_penalty: 200 })).run();
    await seedMissingDefaultContexts();

    ({ a, b } = await seedTwoUsers()); // a = user0@org (tok-0), b = user1@org (tok-1)

    // Activate BOTH; make A sort FIRST by `last_seen DESC` so a buggy
    // resolveActiveSubject() picks A — the wrong, token-less user.
    await upsertUser(env.DB, a.subject);
    await upsertUser(env.DB, b.subject);
    await env.DB.prepare("UPDATE users SET last_seen = ? WHERE subject = ?").bind("2099-01-02T00:00:00Z", a.subject).run();
    await env.DB.prepare("UPDATE users SET last_seen = ? WHERE subject = ?").bind("2099-01-01T00:00:00Z", b.subject).run();
    // Neither user has identity_tokens, so resolve fails at the token lookup
    // naming WHICHEVER subject the provider was scoped to.
  });

  async function resolveAsB() {
    const res = await SELF.fetch("https://x/v1/resolve", { method: "POST", headers: b.headers, body: BODY });
    const json = (await res.json()) as { error?: string; detail?: string };
    return { res, json };
  }

  it("Test 1 — does not bind to a non-caller active user (isolation)", async () => {
    const { res, json } = await resolveAsB();
    expect(res.status).toBe(500);
    expect(json.detail ?? "").not.toContain(a.subject); // never A (user0@org)
  });

  it("Test 2 — binds to the bearer subject (correct scoping)", async () => {
    const { res, json } = await resolveAsB();
    expect(res.status).toBe(500);
    expect(json.detail ?? "").toContain(b.subject); // names B (user1@org)
  });
});
