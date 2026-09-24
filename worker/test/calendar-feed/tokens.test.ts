import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  createFeed, listFeeds, updateFeed, regenerateFeed, revokeFeed,
  resolveFeedToken, touchFeedToken, FeedError, MAX_ACTIVE_FEEDS,
} from "../../src/db/calendar-feed-tokens";

const OWNER = "o@x";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM calendar_feed_tokens").run();
  await env.DB.prepare("DELETE FROM calendar_feed_reveals").run();
});

describe("createFeed / resolveFeedToken", () => {
  it("creates an endpoint whose secret resolves with its regexes", async () => {
    const { id, secret } = await createFeed(env.DB, env, OWNER, "northwinds", ["Northwinds hold .*"]);
    const r = await resolveFeedToken(env.DB, env, secret);
    expect(r).toEqual({ id, ownerSubject: OWNER, revealRegexes: ["Northwinds hold .*"] });
  });
  it("two endpoints have independent secrets", async () => {
    const a = await createFeed(env.DB, env, OWNER, "a", []);
    const b = await createFeed(env.DB, env, OWNER, "b", []);
    expect((await resolveFeedToken(env.DB, env, a.secret))!.id).toBe(a.id);
    expect((await resolveFeedToken(env.DB, env, b.secret))!.id).toBe(b.id);
  });
  it("rejects a duplicate ACTIVE label with code label_taken", async () => {
    await createFeed(env.DB, env, OWNER, "a", []);
    await expect(createFeed(env.DB, env, OWNER, "a", [])).rejects.toMatchObject({ code: "label_taken" });
  });
  it("allows reusing a REVOKED endpoint's label", async () => {
    const { id } = await createFeed(env.DB, env, OWNER, "a", []);
    await revokeFeed(env.DB, OWNER, id);
    await expect(createFeed(env.DB, env, OWNER, "a", [])).resolves.toBeTruthy();
  });
  it("enforces the active-endpoint cap with code feed_limit", async () => {
    for (let i = 0; i < MAX_ACTIVE_FEEDS; i++) await createFeed(env.DB, env, OWNER, `l${i}`, []);
    await expect(createFeed(env.DB, env, OWNER, "over", [])).rejects.toMatchObject({ code: "feed_limit" });
  });
});

describe("listFeeds", () => {
  it("lists active endpoints without hashes and never secrets", async () => {
    await createFeed(env.DB, env, OWNER, "a", ["X .*"]);
    const rows = await listFeeds(env.DB, OWNER);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "a", revealRegexes: ["X .*"] });
    expect(JSON.stringify(rows)).not.toMatch(/token_hash|secret/);
  });
  it("omits revoked endpoints and other owners", async () => {
    const { id } = await createFeed(env.DB, env, OWNER, "a", []);
    await revokeFeed(env.DB, OWNER, id);
    await createFeed(env.DB, env, "other@x", "b", []);
    expect(await listFeeds(env.DB, OWNER)).toHaveLength(0);
  });
});

describe("updateFeed", () => {
  it("updates regexes without touching the secret", async () => {
    const { id, secret } = await createFeed(env.DB, env, OWNER, "a", []);
    const updated = await updateFeed(env.DB, OWNER, id, { revealRegexes: ["Y .*"] });
    expect(updated!.revealRegexes).toEqual(["Y .*"]);
    expect((await resolveFeedToken(env.DB, env, secret))!.revealRegexes).toEqual(["Y .*"]);
  });
  it("renames, returns null for unknown/foreign ids, rejects taken labels", async () => {
    const { id } = await createFeed(env.DB, env, OWNER, "a", []);
    await createFeed(env.DB, env, OWNER, "b", []);
    expect((await updateFeed(env.DB, OWNER, id, { label: "c" }))!.label).toBe("c");
    expect(await updateFeed(env.DB, OWNER, "nope", { label: "z" })).toBeNull();
    expect(await updateFeed(env.DB, "other@x", id, { label: "z" })).toBeNull();
    await expect(updateFeed(env.DB, OWNER, id, { label: "b" })).rejects.toMatchObject({ code: "label_taken" });
  });
  // Belt-and-braces: the WHERE clauses on both UPDATE statements now repeat
  // the "id AND owner_subject AND revoked_at IS NULL" guard used by
  // regenerateFeed/revokeFeed, instead of relying solely on the earlier
  // existence SELECT. This test doesn't force that guard specifically (the
  // existence SELECT alone already returns null here) — it just pins the
  // observable contract: a revoked row's stored label/regexes never change.
  it("does not write to an already-revoked row", async () => {
    const { id } = await createFeed(env.DB, env, OWNER, "a", ["orig .*"]);
    await revokeFeed(env.DB, OWNER, id);
    const result = await updateFeed(env.DB, OWNER, id, { label: "renamed", revealRegexes: ["new .*"] });
    expect(result).toBeNull();
    const row = await env.DB
      .prepare("SELECT label, reveal_rules FROM calendar_feed_tokens WHERE id = ?")
      .bind(id)
      .first<{ label: string; reveal_rules: string }>();
    expect(row!.label).toBe("a");
    expect(row!.reveal_rules).toBe(JSON.stringify(["orig .*"]));
  });
});

describe("regenerateFeed / revokeFeed", () => {
  it("rotates the secret in place: old dies, id stable", async () => {
    const { id, secret } = await createFeed(env.DB, env, OWNER, "a", []);
    const r = await regenerateFeed(env.DB, env, OWNER, id);
    expect(await resolveFeedToken(env.DB, env, secret)).toBeNull();
    expect((await resolveFeedToken(env.DB, env, r!.secret))!.id).toBe(id);
  });
  it("regenerate returns null for unknown/revoked/foreign ids", async () => {
    const { id } = await createFeed(env.DB, env, OWNER, "a", []);
    await revokeFeed(env.DB, OWNER, id);
    expect(await regenerateFeed(env.DB, env, OWNER, id)).toBeNull();
    expect(await regenerateFeed(env.DB, env, "other@x", id)).toBeNull();
  });
  it("revoke kills the secret and returns false the second time", async () => {
    const { id, secret } = await createFeed(env.DB, env, OWNER, "a", []);
    expect(await revokeFeed(env.DB, OWNER, id)).toBe(true);
    expect(await resolveFeedToken(env.DB, env, secret)).toBeNull();
    expect(await revokeFeed(env.DB, OWNER, id)).toBe(false);
  });
});

describe("touchFeedToken", () => {
  it("stamps last_used_at on the endpoint", async () => {
    const { id } = await createFeed(env.DB, env, OWNER, "a", []);
    expect((await listFeeds(env.DB, OWNER))[0]!.last_used_at).toBeNull();
    await touchFeedToken(env.DB, id, "2026-07-23T00:00:00Z");
    expect((await listFeeds(env.DB, OWNER))[0]!.last_used_at).toBe("2026-07-23T00:00:00Z");
  });
});
