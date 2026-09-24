import type { Env } from "../env";
import { generateOpaqueToken, hashToken } from "../auth/tokens";
import { hashingKey, encryptionKey } from "../auth/crypto-keys";
import { encryptString, decryptString } from "../auth/encryption";

export const REVEAL_TTL_MS = 60 * 60 * 1000; // 1 hour
const PURPOSE = "feed-reveal";

/** Stage a single-use reveal of `plaintextUrl` for a feed. Replaces any
 *  pending reveal for that feed. Returns the pre-signed reveal token — the
 *  only place it exists in plaintext is the URL handed to the user. */
export async function createReveal(
  db: D1Database, env: Env, feedId: string, owner: string, plaintextUrl: string, now: Date,
): Promise<string> {
  // Opportunistic hygiene: expired-but-unconsumed reveals lose their
  // ciphertext (spec: expiry deletes the secret at rest, not just consume).
  await db.prepare("UPDATE calendar_feed_reveals SET secret_ciphertext = NULL WHERE expires_at <= ? AND secret_ciphertext IS NOT NULL")
    .bind(now.toISOString()).run();
  await db.prepare("DELETE FROM calendar_feed_reveals WHERE feed_id = ?").bind(feedId).run();
  const token = generateOpaqueToken();
  const hash = await hashToken(token, hashingKey(env));
  const ct = await encryptString(plaintextUrl, encryptionKey(env), PURPOSE);
  await db
    .prepare(
      "INSERT INTO calendar_feed_reveals (id, feed_id, owner_subject, reveal_token_hash, secret_ciphertext, created_at, expires_at) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(
      crypto.randomUUID(), feedId, owner, hash, ct,
      now.toISOString(), new Date(now.getTime() + REVEAL_TTL_MS).toISOString(),
    )
    .run();
  return token;
}

/** Atomically consume a reveal token: exactly one caller ever gets the
 *  plaintext (UPDATE ... WHERE consumed_at IS NULL is the race gate), and the
 *  ciphertext is nulled immediately after decryption. Null on unknown,
 *  expired, or already-consumed tokens — indistinguishable by design.
 *
 *  The race-gate UPDATE and the ciphertext SELECT run in a single db.batch()
 *  so nothing can interleave between them — a concurrent createReveal() for
 *  the same feed (which DELETEs the row before inserting the replacement)
 *  could otherwise land between an un-batched UPDATE and SELECT and cost the
 *  legitimate race winner its plaintext. */
export async function consumeReveal(
  db: D1Database, env: Env, token: string, now: Date,
): Promise<string | null> {
  const hash = await hashToken(token, hashingKey(env));
  const nowIso = now.toISOString();
  const results = await db.batch<{ id: string; secret_ciphertext: ArrayBuffer | null }>([
    db
      .prepare(
        "UPDATE calendar_feed_reveals SET consumed_at = ? WHERE reveal_token_hash = ? AND consumed_at IS NULL AND expires_at > ?",
      )
      .bind(nowIso, hash, nowIso),
    db.prepare("SELECT id, secret_ciphertext FROM calendar_feed_reveals WHERE reveal_token_hash = ?").bind(hash),
  ]);
  const upd = results[0]!;
  const sel = results[1]!;
  if ((upd.meta.changes ?? 0) !== 1) return null;
  const row = sel.results[0];
  if (!row?.secret_ciphertext) return null;
  const plain = await decryptString(row.secret_ciphertext, encryptionKey(env), PURPOSE);
  await db.prepare("UPDATE calendar_feed_reveals SET secret_ciphertext = NULL WHERE id = ?").bind(row.id).run();
  return plain;
}

/** Pending (unconsumed, unexpired) reveal per feed id, for list status. */
export async function pendingReveals(
  db: D1Database, owner: string, now: Date,
): Promise<Map<string, { expires_at: string }>> {
  const r = await db
    .prepare(
      "SELECT feed_id, expires_at FROM calendar_feed_reveals WHERE owner_subject = ? AND consumed_at IS NULL AND expires_at > ?",
    )
    .bind(owner, now.toISOString())
    .all<{ feed_id: string; expires_at: string }>();
  return new Map((r.results ?? []).map((row) => [row.feed_id, { expires_at: row.expires_at }]));
}
