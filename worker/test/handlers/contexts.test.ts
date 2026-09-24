import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { v1 as app } from "../../src/v1";
import { hashToken } from "../../src/auth/tokens";
import { hashingKey } from "../../src/auth/crypto-keys";
import { upsertUser } from "../../src/db/users";
import type { ContextConfig } from "../../src/planning/solver-contract";

async function seedBearer(token: string, subject: string) {
  const h = await hashToken(token, hashingKey(env));
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_clients (id,name,type,redirect_uris,allowed_scopes,created_at) VALUES ('c','t','pkce',NULL,'scheduler:read scheduler:write','2026-01-01')`,
  ).run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_tokens (hashed_token,client_id,scopes,expires_at,refresh_of,revoked_at,subject) VALUES (?,?,?,?,?,?,?)`,
  )
    .bind(h, "c", "scheduler:read scheduler:write", "2099-01-01T00:00:00Z", null, null, subject)
    .run();
}

async function auth(subject: string, token = `tok-${subject}`) {
  await upsertUser(env.DB, subject);
  await seedBearer(token, subject);
  return { Authorization: `Bearer ${token}` };
}

/** A bearer token that authenticates but carries no subject — exercises the
 *  403 no_subject branch (distinct from 401 missing/invalid bearer). */
async function authNoSubject(token: string) {
  const h = await hashToken(token, hashingKey(env));
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_clients (id,name,type,redirect_uris,allowed_scopes,created_at) VALUES ('c','t','pkce',NULL,'scheduler:read scheduler:write','2026-01-01')`,
  ).run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_tokens (hashed_token,client_id,scopes,expires_at,refresh_of,revoked_at,subject) VALUES (?,?,?,?,?,?,?)`,
  )
    .bind(h, "c", "scheduler:read scheduler:write", "2099-01-01T00:00:00Z", null, null, null)
    .run();
  return { Authorization: `Bearer ${token}` };
}

type ContextsResponse = {
  contexts: { context: string; body: ContextConfig; source: "custom" | "default" }[];
};

const DEFAULT_DEEP: ContextConfig = {
  context: "deep",
  fit_curve: { peak_start: "12:00", peak_end: "16:00", falloff_end: "17:00" },
  max_minutes_per_day: 240,
  max_contiguous_minutes: 90,
  over_daily_cap_penalty_per_15min: 25,
  over_streak_cap_penalty_per_15min: 25,
};

beforeEach(async () => {
  for (const t of ["oauth_tokens", "oauth_clients", "users"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.DB.prepare("DELETE FROM config_contexts WHERE owner_subject != '__default__'").run();
});

describe("GET /v1/contexts", () => {
  it("401 without bearer", async () => {
    expect((await app.request("/contexts", {}, env)).status).toBe(401);
  });

  it("default user sees 5 contexts, all source:default", async () => {
    const headers = await auth("u1@org");
    const res = await app.request("/contexts", { headers }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ContextsResponse;
    expect(body.contexts).toHaveLength(5);
    for (const c of body.contexts) expect(c.source).toBe("default");
    expect(body.contexts.find((c) => c.context === "deep")!.body).toEqual(DEFAULT_DEEP);
  });

  it("after a PATCH, that context flips to custom, others stay default", async () => {
    const headers = await auth("u2@org");
    await app.request(
      "/contexts/deep",
      {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ max_minutes_per_day: 300 }),
      },
      env,
    );
    const res = await app.request("/contexts", { headers }, env);
    const body = (await res.json()) as ContextsResponse;
    expect(body.contexts.find((c) => c.context === "deep")!.source).toBe("custom");
    for (const c of body.contexts.filter((x) => x.context !== "deep")) {
      expect(c.source).toBe("default");
    }
  });

  it("403 with bearer but no subject", async () => {
    const headers = await authNoSubject("tok-nosub-get");
    const res = await app.request("/contexts", { headers }, env);
    expect(res.status).toBe(403);
  });
});

describe("PATCH /v1/contexts/{context}", () => {
  it("401 without bearer", async () => {
    const res = await app.request(
      "/contexts/deep",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ max_minutes_per_day: 100 }) },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("403 with bearer but no subject", async () => {
    const headers = await authNoSubject("tok-nosub-patch");
    const res = await app.request(
      "/contexts/deep",
      {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ max_minutes_per_day: 100 }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("no bearer + malformed body -> 401, not 400 (auth runs before body validation)", async () => {
    const res = await app.request(
      "/contexts/deep",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fit_curve: { peak_start: "not-a-time" } }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("no bearer + unknown context in path -> 401, not 400", async () => {
    const res = await app.request(
      "/contexts/not-a-context",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ max_minutes_per_day: 100 }) },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("unknown context -> 400", async () => {
    const headers = await auth("u3@org");
    const res = await app.request(
      "/contexts/not-a-context",
      { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ max_minutes_per_day: 100 }) },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("malformed HH:MM -> 400", async () => {
    const headers = await auth("u4@org");
    const res = await app.request(
      "/contexts/deep",
      {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ fit_curve: { peak_start: "9:00", peak_end: "12:00", falloff_end: "15:00" } }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("peak_end < peak_start -> 400", async () => {
    const headers = await auth("u5@org");
    const res = await app.request(
      "/contexts/deep",
      {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ fit_curve: { peak_start: "12:00", peak_end: "11:00", falloff_end: "15:00" } }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("falloff_end < peak_end -> 400", async () => {
    const headers = await auth("u6@org");
    const res = await app.request(
      "/contexts/deep",
      {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ fit_curve: { peak_start: "09:00", peak_end: "12:00", falloff_end: "10:00" } }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("incomplete fit_curve triple -> 400", async () => {
    const headers = await auth("u7@org");
    const res = await app.request(
      "/contexts/deep",
      {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ fit_curve: { peak_start: "09:00", peak_end: "12:00" } }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("negative penalty -> 400", async () => {
    const headers = await auth("u8@org");
    const res = await app.request(
      "/contexts/deep",
      {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ over_daily_cap_penalty_per_15min: -1 }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("fractional penalty -> 400 (solver requires int)", async () => {
    const headers = await auth("u8b@org");
    const res = await app.request(
      "/contexts/deep",
      {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ over_daily_cap_penalty_per_15min: 12.5 }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("whole-number-valued float penalty (12.0) accepted", async () => {
    const headers = await auth("u8c@org");
    const res = await app.request(
      "/contexts/deep",
      {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ over_daily_cap_penalty_per_15min: 12.0 }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { context: string; body: ContextConfig; source: string };
    expect(body.body.over_daily_cap_penalty_per_15min).toBe(12);
  });

  it("unknown field in PATCH body -> 400 validation_failed, not empty_update", async () => {
    const headers = await auth("u8d@org");
    const res = await app.request(
      "/contexts/deep",
      {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ max_minutes_per_days: 100 }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_failed");
  });

  it("zero/negative cap -> 400", async () => {
    const headers = await auth("u9@org");
    const res = await app.request(
      "/contexts/deep",
      { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ max_minutes_per_day: 0 }) },
      env,
    );
    expect(res.status).toBe(400);
    const res2 = await app.request(
      "/contexts/deep",
      { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ max_contiguous_minutes: -5 }) },
      env,
    );
    expect(res2.status).toBe(400);
  });

  it("null cap accepted, and persists as the stored snapshot", async () => {
    const headers = await auth("u10@org");
    const res = await app.request(
      "/contexts/deep",
      { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ max_minutes_per_day: null }) },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { context: string; body: ContextConfig; source: string };
    expect(body.body.max_minutes_per_day).toBeNull();

    const getRes = await app.request("/contexts", { headers }, env);
    const getBody = (await getRes.json()) as ContextsResponse;
    const deep = getBody.contexts.find((c) => c.context === "deep")!;
    expect(deep.body.max_minutes_per_day).toBeNull();
    expect(deep.source).toBe("custom");
  });

  it("empty body -> 400 empty_update", async () => {
    const headers = await auth("u11@org");
    const res = await app.request(
      "/contexts/deep",
      { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({}) },
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("empty_update");
  });

  it("caps-only PATCH leaves the default fit curve intact in the stored snapshot", async () => {
    const headers = await auth("u12@org");
    const res = await app.request(
      "/contexts/deep",
      { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ max_minutes_per_day: 300 }) },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { context: string; body: ContextConfig; source: string };
    expect(body.body.fit_curve).toEqual(DEFAULT_DEEP.fit_curve);
    expect(body.body.max_minutes_per_day).toBe(300);
    expect(body.source).toBe("custom");

    // Re-read from D1 via GET rather than trusting only the PATCH response.
    const getRes = await app.request("/contexts", { headers }, env);
    const getBody = (await getRes.json()) as ContextsResponse;
    const deep = getBody.contexts.find((c) => c.context === "deep")!;
    expect(deep.source).toBe("custom");
    expect(deep.body.fit_curve).toEqual(DEFAULT_DEEP.fit_curve);
    expect(deep.body.max_minutes_per_day).toBe(300);
  });

  it("curve-only PATCH leaves default caps intact", async () => {
    const headers = await auth("u13@org");
    const res = await app.request(
      "/contexts/deep",
      {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ fit_curve: { peak_start: "06:00", peak_end: "07:00", falloff_end: "08:00" } }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { context: string; body: ContextConfig; source: string };
    expect(body.body.max_minutes_per_day).toBe(DEFAULT_DEEP.max_minutes_per_day);
    expect(body.body.max_contiguous_minutes).toBe(DEFAULT_DEEP.max_contiguous_minutes);
    expect(body.body.fit_curve).toEqual({ peak_start: "06:00", peak_end: "07:00", falloff_end: "08:00" });

    // Re-read from D1 via GET rather than trusting only the PATCH response.
    const getRes = await app.request("/contexts", { headers }, env);
    const getBody = (await getRes.json()) as ContextsResponse;
    const deep = getBody.contexts.find((c) => c.context === "deep")!;
    expect(deep.source).toBe("custom");
    expect(deep.body.max_minutes_per_day).toBe(DEFAULT_DEEP.max_minutes_per_day);
    expect(deep.body.max_contiguous_minutes).toBe(DEFAULT_DEEP.max_contiguous_minutes);
    expect(deep.body.fit_curve).toEqual({ peak_start: "06:00", peak_end: "07:00", falloff_end: "08:00" });
  });
});

describe("DELETE /v1/contexts/{context}", () => {
  it("401 without bearer", async () => {
    expect((await app.request("/contexts/deep", { method: "DELETE" }, env)).status).toBe(401);
  });

  it("403 with bearer but no subject", async () => {
    const headers = await authNoSubject("tok-nosub-delete");
    const res = await app.request("/contexts/deep", { method: "DELETE", headers }, env);
    expect(res.status).toBe(403);
  });

  it("no bearer + unknown context in path -> 401, not 400 (auth runs before param validation)", async () => {
    const res = await app.request("/contexts/not-a-context", { method: "DELETE" }, env);
    expect(res.status).toBe(401);
  });

  it("reverts GET to source:default", async () => {
    const headers = await auth("u14@org");
    await app.request(
      "/contexts/deep",
      { method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ max_minutes_per_day: 300 }) },
      env,
    );
    const del = await app.request("/contexts/deep", { method: "DELETE", headers }, env);
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as { context: string; body: ContextConfig; source: string };
    expect(delBody.source).toBe("default");
    expect(delBody.body).toEqual(DEFAULT_DEEP);

    const res = await app.request("/contexts", { headers }, env);
    const body = (await res.json()) as ContextsResponse;
    expect(body.contexts.find((c) => c.context === "deep")!.source).toBe("default");
  });

  it("idempotent 200 on second delete", async () => {
    const headers = await auth("u15@org");
    const first = await app.request("/contexts/deep", { method: "DELETE", headers }, env);
    expect(first.status).toBe(200);
    const second = await app.request("/contexts/deep", { method: "DELETE", headers }, env);
    expect(second.status).toBe(200);
  });

  it("unknown context -> 400", async () => {
    const headers = await auth("u16@org");
    const res = await app.request("/contexts/not-a-context", { method: "DELETE", headers }, env);
    expect(res.status).toBe(400);
  });
});

describe("owner isolation", () => {
  it("user A's PATCH is invisible to user B", async () => {
    const headersA = await auth("userA@org");
    const headersB = await auth("userB@org");
    await app.request(
      "/contexts/deep",
      { method: "PATCH", headers: { ...headersA, "content-type": "application/json" }, body: JSON.stringify({ max_minutes_per_day: 999 }) },
      env,
    );
    const resB = await app.request("/contexts", { headers: headersB }, env);
    const bodyB = (await resB.json()) as ContextsResponse;
    const deepB = bodyB.contexts.find((c) => c.context === "deep")!;
    expect(deepB.source).toBe("default");
    expect(deepB.body.max_minutes_per_day).toBe(DEFAULT_DEEP.max_minutes_per_day);
  });
});
