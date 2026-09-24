// worker/test/handlers/weights.test.ts
// Card C of internal design notes: GET/PATCH/DELETE /v1/weights.
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { v1 as app } from "../../src/v1";
import { seedTwoUsers, type SeededUser } from "../fixtures/owners";

// Seeded instance defaults after migrations 0002 -> 0011 (see
// test/db/context-config.test.ts for the same pin on the DB module).
const DEFAULT_WEIGHTS = {
  time_of_day_fit_per_15min: 5,
  churn_per_15min_moved: 10,
  priority_unit: 1,
  base_drop_penalty: 200,
  preferred_day_miss: 40,
  preferred_time_miss_per_15min: 5,
};

interface WeightsResponse {
  weights: typeof DEFAULT_WEIGHTS;
  source: "custom" | "default";
}

let a: SeededUser, b: SeededUser;

beforeEach(async () => {
  ({ a, b } = await seedTwoUsers());
  // seedTwoUsers only clears tasks/task_templates/projects/oauth_*; the
  // config tables are shared across the whole run and keyed by subject, so
  // clear any leftover custom rows for these subjects too.
  await env.DB.prepare("DELETE FROM config_weights WHERE owner_subject != '__default__'").run();
});

function get(u: SeededUser) {
  return app.request("/weights", { headers: { Authorization: `Bearer ${u.token}` } }, env);
}
function patch(u: SeededUser, body: unknown) {
  return app.request(
    "/weights",
    { method: "PATCH", headers: u.headers, body: JSON.stringify(body) },
    env,
  );
}
function del(u: SeededUser) {
  return app.request("/weights", { method: "DELETE", headers: { Authorization: `Bearer ${u.token}` } }, env);
}

describe("GET /v1/weights", () => {
  it("returns the seeded defaults with source:default when the caller has no custom row", async () => {
    const res = await get(a);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WeightsResponse;
    expect(body.source).toBe("default");
    expect(body.weights).toEqual(DEFAULT_WEIGHTS);
  });

  it("401 without a bearer", async () => {
    const res = await app.request("/weights", {});
    expect(res.status).toBe(401);
  });

  it("403 for a token carrying no subject", async () => {
    await env.DB.prepare("UPDATE oauth_tokens SET subject = NULL WHERE subject = ?").bind(a.subject).run();
    const res = await get(a);
    expect(res.status).toBe(403);
  });
});

describe("PATCH /v1/weights", () => {
  it("partially updates one field; GET then shows it plus the other five defaults, source:custom", async () => {
    const patchRes = await patch(a, { churn_per_15min_moved: 40 });
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as WeightsResponse;
    expect(patchBody.source).toBe("custom");
    expect(patchBody.weights).toEqual({ ...DEFAULT_WEIGHTS, churn_per_15min_moved: 40 });

    const getRes = await get(a);
    const getBody = (await getRes.json()) as WeightsResponse;
    expect(getBody.source).toBe("custom");
    expect(getBody.weights).toEqual({ ...DEFAULT_WEIGHTS, churn_per_15min_moved: 40 });
  });

  it("400s a negative value", async () => {
    const res = await patch(a, { churn_per_15min_moved: -1 });
    expect(res.status).toBe(400);
  });

  it("400s a fractional value (solver weights are ints)", async () => {
    const res = await patch(a, { churn_per_15min_moved: 2.5 });
    expect(res.status).toBe(400);
  });

  it("400s Infinity (would otherwise JSON-stringify to null in the stored row)", async () => {
    // Sent as a raw JSON literal, not JSON.stringify'd from a JS object:
    // JSON.stringify(Infinity) already collapses to `null` client-side, which
    // would defeat the point of this test — the wire value must actually be
    // the JSON exponent literal so the WORKER's parse produces Infinity and
    // .int() has something to reject.
    const res = await app.request(
      "/weights",
      { method: "PATCH", headers: a.headers, body: '{"churn_per_15min_moved":1e400}' },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("400s an unknown key even alongside a valid one (strict, not silently stripped)", async () => {
    // A body of ONLY the unknown key would also 400 via empty_update once the
    // key is stripped, which wouldn't distinguish stripping from rejection.
    // Pairing it with a valid field pins that the whole request is rejected.
    const res = await patch(a, { churn_per_15min_moved: 40, not_a_real_weight: 1 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_failed");
  });

  it("400s empty_update for an empty body", async () => {
    const res = await patch(a, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("empty_update");
  });

  it("401 without a bearer even when the body is malformed (auth runs before validation)", async () => {
    // Without the scoped gate, zod's request validator runs first and an
    // unauthenticated caller with a bad body gets 400 validation_failed —
    // leaking "malformed" vs "not allowed to be here at all". Mirrors the
    // contexts.ts pin.
    const res = await app.request("/weights", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ churn_per_15min_moved: -1, not_a_real_weight: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it("401 without a bearer", async () => {
    const res = await app.request("/weights", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ churn_per_15min_moved: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it("403 for a token carrying no subject", async () => {
    await env.DB.prepare("UPDATE oauth_tokens SET subject = NULL WHERE subject = ?").bind(a.subject).run();
    const res = await patch(a, { churn_per_15min_moved: 1 });
    expect(res.status).toBe(403);
  });

  it("a second PATCH merges over the caller's own custom row, not the default", async () => {
    await patch(a, { churn_per_15min_moved: 40 });
    await patch(a, { priority_unit: 2 });
    const res = await get(a);
    const body = (await res.json()) as WeightsResponse;
    expect(body.source).toBe("custom");
    expect(body.weights).toEqual({ ...DEFAULT_WEIGHTS, churn_per_15min_moved: 40, priority_unit: 2 });
  });
});

describe("DELETE /v1/weights", () => {
  it("reverts to defaults; idempotent", async () => {
    await patch(a, { churn_per_15min_moved: 40 });

    const first = await del(a);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as WeightsResponse;
    expect(firstBody.source).toBe("default");
    expect(firstBody.weights).toEqual(DEFAULT_WEIGHTS);

    const second = await del(a);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as WeightsResponse;
    expect(secondBody.source).toBe("default");
    expect(secondBody.weights).toEqual(DEFAULT_WEIGHTS);

    const getRes = await get(a);
    const getBody = (await getRes.json()) as WeightsResponse;
    expect(getBody.source).toBe("default");
  });

  it("401 without a bearer", async () => {
    const res = await app.request("/weights", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("403 for a token carrying no subject", async () => {
    await env.DB.prepare("UPDATE oauth_tokens SET subject = NULL WHERE subject = ?").bind(a.subject).run();
    const res = await del(a);
    expect(res.status).toBe(403);
  });
});

describe("owner isolation", () => {
  it("A's PATCH is invisible to B", async () => {
    await patch(a, { churn_per_15min_moved: 999 });
    const res = await get(b);
    const body = (await res.json()) as WeightsResponse;
    expect(body.source).toBe("default");
    expect(body.weights).toEqual(DEFAULT_WEIGHTS);
  });
});
