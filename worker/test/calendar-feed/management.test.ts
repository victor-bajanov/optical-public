import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { hashToken } from "../../src/auth/tokens";
import { v1 } from "../../src/v1";
import { resolveFeedToken, MAX_ACTIVE_FEEDS } from "../../src/db/calendar-feed-tokens";
import { consumeReveal } from "../../src/db/calendar-feed-reveals";

const SUBJECT = "seed@org";

async function seedBearer() {
  await env.DB.prepare("DELETE FROM oauth_tokens").run();
  await env.DB.prepare("DELETE FROM oauth_clients").run();
  await env.DB.prepare("DELETE FROM calendar_feed_tokens").run();
  await env.DB.prepare("DELETE FROM calendar_feed_reveals").run();
  await env.DB.prepare(
    "INSERT INTO oauth_clients (id, name, type, redirect_uris, created_at) VALUES (?,?,?,?,?)",
  ).bind("c1", "test", "pkce", null, "2026-01-01T00:00:00Z").run();
  const h = await hashToken("tok", env.TOKEN_HASH_PEPPER);
  await env.DB.prepare(
    "INSERT INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?,?,?,?,?,?,?)",
  ).bind(h, "c1", "scheduler:read scheduler:write", "2099-01-01T00:00:00Z", null, null, SUBJECT).run();
}

const authed = { Authorization: "Bearer tok", "Content-Type": "application/json" };
const offEnv = Object.assign(Object.create(env), { CALENDAR_FEED_ENABLED: "false" });

const create = (body: object) =>
  v1.request("/calendar-feeds", { method: "POST", headers: authed, body: JSON.stringify(body) }, env);

describe("/v1/calendar-feeds", () => {
  beforeEach(async () => { await seedBearer(); });

  it("401s without a bearer; 403 when the flag is off", async () => {
    expect((await v1.request("/calendar-feeds", { method: "POST" }, env)).status).toBe(401);
    expect((await v1.request("/calendar-feeds", { method: "POST", headers: authed, body: "{}" }, offEnv)).status).toBe(403);
  });

  it("POST creates an endpoint and returns a reveal URL — never the secret", async () => {
    const res = await create({ label: "northwinds", reveal_regexes: ["Northwinds hold .*"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; label: string; reveal_regexes: string[]; reveal_url: string; instructions: string };
    expect(body.reveal_url).toMatch(/\/cal-reveal\/.+$/);
    expect(body.instructions).toMatch(/browser/i);
    expect(JSON.stringify(body)).not.toContain("busy.ics"); // feed URL (with secret) must not appear
    // The reveal token in the URL opens to a feed URL that resolves to the caller.
    const revealToken = body.reveal_url.split("/cal-reveal/")[1]!;
    const feedUrl = await consumeReveal(env.DB, env, revealToken, new Date());
    const secret = feedUrl!.split("/cal/")[1]!.replace("/busy.ics", "");
    expect((await resolveFeedToken(env.DB, env, secret))?.ownerSubject).toBe("seed@org");
  });

  it("POST validates label and regexes", async () => {
    expect((await create({ label: "" })).status).toBe(400);
    const badRegex = await create({ label: "x", reveal_regexes: ["("] });
    expect(badRegex.status).toBe(400);
    const badBody = (await badRegex.json()) as { error: string; detail?: string };
    expect(badBody.error).toBe("invalid_regexes");
    expect(badBody.detail).toBeTruthy();
    await create({ label: "dup" });
    const conflict = await create({ label: "dup" });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: string }).error).toBe("label_taken");
  });

  it("POST 409s with feed_limit once MAX_ACTIVE_FEEDS is reached", async () => {
    for (let i = 0; i < MAX_ACTIVE_FEEDS; i++) {
      expect((await create({ label: `l${i}` })).status).toBe(200);
    }
    const over = await create({ label: "over" });
    expect(over.status).toBe(409);
    expect(((await over.json()) as { error: string }).error).toBe("feed_limit");
  });

  it("GET lists endpoints with pending-reveal status and no secrets", async () => {
    await create({ label: "a" });
    const res = await v1.request("/calendar-feeds", { headers: authed }, env);
    expect(res.status).toBe(200);
    const { feeds } = (await res.json()) as { feeds: Array<{ label: string; pending_reveal: { expires_at: string } | null }> };
    expect(feeds).toHaveLength(1);
    expect(feeds[0]!.pending_reveal).not.toBeNull();
    expect(JSON.stringify(feeds)).not.toMatch(/secret|busy\.ics/);
  });

  it("PATCH edits regexes; 404 unknown id; 409 taken label", async () => {
    const { id } = (await (await create({ label: "a" })).json()) as { id: string };
    await create({ label: "b" });
    const res = await v1.request(`/calendar-feeds/${id}`, {
      method: "PATCH", headers: authed, body: JSON.stringify({ reveal_regexes: ["Z .*"] }),
    }, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reveal_regexes: string[] }).reveal_regexes).toEqual(["Z .*"]);
    expect((await v1.request("/calendar-feeds/nope", { method: "PATCH", headers: authed, body: JSON.stringify({ label: "q" }) }, env)).status).toBe(404);
    expect((await v1.request(`/calendar-feeds/${id}`, { method: "PATCH", headers: authed, body: JSON.stringify({ label: "b" }) }, env)).status).toBe(409);
  });

  it("POST :id/regenerate rotates and returns a fresh reveal URL", async () => {
    const created = (await (await create({ label: "a" })).json()) as { id: string; reveal_url: string };
    const res = await v1.request(`/calendar-feeds/${created.id}/regenerate`, { method: "POST", headers: authed }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reveal_url: string };
    expect(body.reveal_url).not.toBe(created.reveal_url);
    // The original (pre-rotation) reveal is dead — replaced by the new one.
    const oldToken = created.reveal_url.split("/cal-reveal/")[1]!;
    expect(await consumeReveal(env.DB, env, oldToken, new Date())).toBeNull();
  });

  it("DELETE revokes; unknown id 404", async () => {
    const { id } = (await (await create({ label: "a" })).json()) as { id: string };
    expect((await v1.request(`/calendar-feeds/${id}`, { method: "DELETE", headers: authed }, env)).status).toBe(200);
    expect((await v1.request(`/calendar-feeds/${id}`, { method: "DELETE", headers: authed }, env)).status).toBe(404);
  });
});
