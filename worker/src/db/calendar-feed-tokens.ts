import type { Env } from "../env";
import { generateOpaqueToken, hashToken } from "../auth/tokens";
import { hashingKey } from "../auth/crypto-keys";

export const MAX_ACTIVE_FEEDS = 10;

export class FeedError extends Error {
  constructor(public readonly code: "feed_limit" | "label_taken", message: string) {
    super(message);
    this.name = "FeedError";
  }
}

export interface FeedEndpoint {
  id: string;
  label: string;
  revealRegexes: string[];
  created_at: string;
  last_used_at: string | null;
}

function parseRegexes(revealRules: string | null): string[] {
  if (!revealRules) return [];
  try {
    const v = JSON.parse(revealRules);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function labelTaken(db: D1Database, owner: string, label: string, excludeId?: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM calendar_feed_tokens WHERE owner_subject = ? AND label = ? AND revoked_at IS NULL AND id != ?")
    .bind(owner, label, excludeId ?? "")
    .first();
  return row !== null;
}

/** Create a new endpoint with a fresh secret. Caller passes ALREADY-VALIDATED
 *  regexes (validateRevealRegexes). Returns the plaintext secret for the
 *  reveal flow — it must never reach an API response body. */
export async function createFeed(
  db: D1Database, env: Env, owner: string, label: string, revealRegexes: string[],
): Promise<{ id: string; secret: string }> {
  const active = await db
    .prepare("SELECT COUNT(*) AS n FROM calendar_feed_tokens WHERE owner_subject = ? AND revoked_at IS NULL")
    .bind(owner)
    .first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_ACTIVE_FEEDS) throw new FeedError("feed_limit", `at most ${MAX_ACTIVE_FEEDS} active endpoints`);
  if (await labelTaken(db, owner, label)) throw new FeedError("label_taken", `label already in use: ${label}`);
  const secret = generateOpaqueToken();
  const id = crypto.randomUUID();
  const hash = await hashToken(secret, hashingKey(env));
  await db
    .prepare("INSERT INTO calendar_feed_tokens (id, owner_subject, token_hash, label, reveal_rules, created_at) VALUES (?,?,?,?,?,?)")
    .bind(id, owner, hash, label, JSON.stringify(revealRegexes), new Date().toISOString())
    .run();
  return { id, secret };
}

export async function listFeeds(db: D1Database, owner: string): Promise<FeedEndpoint[]> {
  const r = await db
    .prepare("SELECT id, label, reveal_rules, created_at, last_used_at FROM calendar_feed_tokens WHERE owner_subject = ? AND revoked_at IS NULL ORDER BY created_at")
    .bind(owner)
    .all<{ id: string; label: string; reveal_rules: string | null; created_at: string; last_used_at: string | null }>();
  return (r.results ?? []).map((row) => ({
    id: row.id,
    label: row.label,
    revealRegexes: parseRegexes(row.reveal_rules),
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  }));
}

/** Patch label and/or regexes on an active endpoint. Null for unknown /
 *  revoked / foreign ids. Never touches token_hash. */
export async function updateFeed(
  db: D1Database, owner: string, id: string,
  patch: { label?: string; revealRegexes?: string[] },
): Promise<FeedEndpoint | null> {
  const existing = await db
    .prepare("SELECT id FROM calendar_feed_tokens WHERE id = ? AND owner_subject = ? AND revoked_at IS NULL")
    .bind(id, owner)
    .first();
  if (!existing) return null;
  if (patch.label !== undefined && (await labelTaken(db, owner, patch.label, id)))
    throw new FeedError("label_taken", `label already in use: ${patch.label}`);
  if (patch.label !== undefined) {
    const r = await db
      .prepare("UPDATE calendar_feed_tokens SET label = ? WHERE id = ? AND owner_subject = ? AND revoked_at IS NULL")
      .bind(patch.label, id, owner)
      .run();
    if ((r.meta.changes ?? 0) === 0) return null;
  }
  if (patch.revealRegexes !== undefined) {
    const r = await db
      .prepare("UPDATE calendar_feed_tokens SET reveal_rules = ? WHERE id = ? AND owner_subject = ? AND revoked_at IS NULL")
      .bind(JSON.stringify(patch.revealRegexes), id, owner)
      .run();
    if ((r.meta.changes ?? 0) === 0) return null;
  }
  const rows = await listFeeds(db, owner);
  return rows.find((f) => f.id === id) ?? null;
}

/** Rotate the endpoint's secret IN PLACE (id and config stable). The old
 *  secret stops resolving immediately. Null for unknown/revoked/foreign. */
export async function regenerateFeed(
  db: D1Database, env: Env, owner: string, id: string,
): Promise<{ secret: string } | null> {
  const secret = generateOpaqueToken();
  const hash = await hashToken(secret, hashingKey(env));
  const r = await db
    .prepare("UPDATE calendar_feed_tokens SET token_hash = ? WHERE id = ? AND owner_subject = ? AND revoked_at IS NULL")
    .bind(hash, id, owner)
    .run();
  return (r.meta.changes ?? 0) === 1 ? { secret } : null;
}

/** Soft-revoke one endpoint. True if a row transitioned to revoked. */
export async function revokeFeed(db: D1Database, owner: string, id: string): Promise<boolean> {
  const r = await db
    .prepare("UPDATE calendar_feed_tokens SET revoked_at = ? WHERE id = ? AND owner_subject = ? AND revoked_at IS NULL")
    .bind(new Date().toISOString(), id, owner)
    .run();
  return (r.meta.changes ?? 0) === 1;
}

/** Resolve a presented plaintext token to its endpoint, or null. Hash-and-
 *  match on the UNIQUE token_hash index is inherently timing-safe. */
export async function resolveFeedToken(
  db: D1Database, env: Env, secret: string,
): Promise<{ id: string; ownerSubject: string; revealRegexes: string[] } | null> {
  const hash = await hashToken(secret, hashingKey(env));
  const row = await db
    .prepare("SELECT id, owner_subject, reveal_rules FROM calendar_feed_tokens WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(hash)
    .first<{ id: string; owner_subject: string; reveal_rules: string | null }>();
  return row ? { id: row.id, ownerSubject: row.owner_subject, revealRegexes: parseRegexes(row.reveal_rules) } : null;
}

/** Best-effort last_used_at stamp on a poll. */
export async function touchFeedToken(db: D1Database, id: string, now: string): Promise<void> {
  await db.prepare("UPDATE calendar_feed_tokens SET last_used_at = ? WHERE id = ?").bind(now, id).run();
}

