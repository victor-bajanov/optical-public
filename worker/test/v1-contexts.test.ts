import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { v1 as app } from "../src/v1";
import { hashToken } from "../src/auth/tokens";
import { hashingKey } from "../src/auth/crypto-keys";
import { upsertUser } from "../src/db/users";

async function seedBearer(token: string, subject: string) {
  const h = await hashToken(token, hashingKey(env));
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_clients (id,name,type,redirect_uris,allowed_scopes,created_at) VALUES ('c','t','pkce',NULL,'scheduler:read scheduler:write','2026-01-01')`,
  ).run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO oauth_tokens (hashed_token,client_id,scopes,expires_at,refresh_of,revoked_at,subject) VALUES (?,?,?,?,?,?,?)`,
  )
    .bind(
      h,
      "c",
      "scheduler:read scheduler:write",
      "2099-01-01T00:00:00Z",
      null,
      null,
      subject,
    )
    .run();
}

beforeEach(async () => {
  for (const t of ["oauth_tokens", "oauth_clients", "users"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});

describe("GET /v1/contexts", () => {
  it("401 without bearer", async () => {
    expect((await app.request("/contexts", {}, env)).status).toBe(401);
  });
  it("falls back to default contexts when the caller has none", async () => {
    await upsertUser(env.DB, "u@org");
    await seedBearer("tok", "u@org");
    const res = await app.request(
      "/contexts",
      { headers: { Authorization: "Bearer tok" } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      contexts: { context: string; body: unknown }[];
    };
    expect(Array.isArray(body.contexts)).toBe(true);
    expect(body.contexts.length).toBeGreaterThan(0);
  });
});
