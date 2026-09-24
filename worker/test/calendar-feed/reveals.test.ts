import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { createReveal, consumeReveal, pendingReveals, REVEAL_TTL_MS } from "../../src/db/calendar-feed-reveals";

const OWNER = "o@x";
const URL = "https://s.example/cal/sekrit/busy.ics";
const T0 = new Date("2026-07-23T00:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM calendar_feed_reveals").run();
});

describe("calendar_feed_reveals", () => {
  it("consume returns the plaintext exactly once", async () => {
    const token = await createReveal(env.DB, env, "f1", OWNER, URL, T0);
    expect(await consumeReveal(env.DB, env, token, later(1000))).toBe(URL);
    expect(await consumeReveal(env.DB, env, token, later(2000))).toBeNull();
  });

  it("consume nulls the ciphertext at rest", async () => {
    const token = await createReveal(env.DB, env, "f1", OWNER, URL, T0);
    await consumeReveal(env.DB, env, token, later(1000));
    const row = await env.DB.prepare("SELECT secret_ciphertext FROM calendar_feed_reveals").first<{ secret_ciphertext: ArrayBuffer | null }>();
    expect(row!.secret_ciphertext).toBeNull();
  });

  it("expired reveals never open", async () => {
    const token = await createReveal(env.DB, env, "f1", OWNER, URL, T0);
    expect(await consumeReveal(env.DB, env, token, later(REVEAL_TTL_MS + 1))).toBeNull();
  });

  it("unknown tokens return null", async () => {
    expect(await consumeReveal(env.DB, env, "nope", T0)).toBeNull();
  });

  it("a new reveal for the same feed replaces the pending one", async () => {
    const t1 = await createReveal(env.DB, env, "f1", OWNER, URL, T0);
    const t2 = await createReveal(env.DB, env, "f1", OWNER, URL, T0);
    expect(await consumeReveal(env.DB, env, t1, later(1000))).toBeNull();
    expect(await consumeReveal(env.DB, env, t2, later(1000))).toBe(URL);
  });

  it("creating any reveal purges expired ciphertexts at rest (spec: expiry deletes)", async () => {
    await createReveal(env.DB, env, "f1", OWNER, URL, T0);
    await createReveal(env.DB, env, "f2", OWNER, URL, later(REVEAL_TTL_MS + 1000)); // f1 now expired
    const row = await env.DB.prepare(
      "SELECT secret_ciphertext FROM calendar_feed_reveals WHERE feed_id = 'f1'",
    ).first<{ secret_ciphertext: ArrayBuffer | null }>();
    expect(row?.secret_ciphertext ?? null).toBeNull();
  });
});

describe("pendingReveals", () => {
  it("returns the pending reveal keyed by feed_id with its expires_at, for the owner", async () => {
    await createReveal(env.DB, env, "f1", OWNER, URL, T0);
    const pending = await pendingReveals(env.DB, OWNER, later(1000));
    expect(pending.get("f1")).toEqual({ expires_at: later(REVEAL_TTL_MS).toISOString() });
  });

  it("excludes consumed reveals", async () => {
    const token = await createReveal(env.DB, env, "f1", OWNER, URL, T0);
    await consumeReveal(env.DB, env, token, later(1000));
    const pending = await pendingReveals(env.DB, OWNER, later(2000));
    expect(pending.has("f1")).toBe(false);
  });

  it("excludes expired reveals, including the exact expires_at boundary", async () => {
    await createReveal(env.DB, env, "f1", OWNER, URL, T0);
    const atExpiry = await pendingReveals(env.DB, OWNER, later(REVEAL_TTL_MS));
    expect(atExpiry.has("f1")).toBe(false);
    const pastExpiry = await pendingReveals(env.DB, OWNER, later(REVEAL_TTL_MS + 1));
    expect(pastExpiry.has("f1")).toBe(false);
  });

  it("excludes other owners' reveals", async () => {
    await createReveal(env.DB, env, "f1", OWNER, URL, T0);
    const pending = await pendingReveals(env.DB, "someone-else@x", later(1000));
    expect(pending.has("f1")).toBe(false);
  });
});
