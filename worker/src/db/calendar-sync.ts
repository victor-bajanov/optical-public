import { requireOwner } from "./d1";
import { isProviderName, type ProviderName } from "../providers/provider-name";

// v1 supports the PRIMARY Google calendar only. The calendar id is always the
// Google magic string "primary"; shared/secondary calendars are out of scope,
// which keeps channel_id → single-owner routing valid. Use PRIMARY_CALENDAR_ID
// at call sites instead of a bare string literal. Never accept a client-supplied
// calendar id.
export const PRIMARY_CALENDAR_ID = "primary";

export interface CalendarSyncRow {
  owner_subject: string;
  calendar_id: string;
  next_sync_token: string | null;
  channel_id: string | null;
  channel_token: string | null;
  channel_expires_at: string | null;
  channel_resource_id: string | null;
  channel_callback_url: string | null;
}

export async function getCalendarSync(
  db: D1Database,
  ownerSubject: string,
  calendarId: string,
): Promise<CalendarSyncRow | null> {
  const owner = requireOwner(ownerSubject);
  const row = await db
    .prepare(
      "SELECT owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url FROM calendar_sync WHERE owner_subject = ? AND calendar_id = ?",
    )
    .bind(owner, calendarId)
    .first<CalendarSyncRow>();
  return row ?? null;
}

// Owner-AGNOSTIC: how the webhook discovers the owner from an inbound push's
// x-goog-channel-id. channel_id is UNIQUE (migration 0014), so this maps to at
// most one owner.
export async function getCalendarSyncByChannelId(
  db: D1Database,
  channelId: string,
): Promise<CalendarSyncRow | null> {
  const row = await db
    .prepare(
      "SELECT owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url FROM calendar_sync WHERE channel_id = ?",
    )
    .bind(channelId)
    .first<CalendarSyncRow>();
  return row ?? null;
}

// Owners that have (or had) a live push channel: the sweep's RENEW pass. Rows
// without a channel_id are excluded here; first-time channels come from
// listGrantHoldersWithoutChannel below (the sweep's create pass) and from
// sign-in (webhooks/sign-in-subscribe.ts).
export async function listCalendarSyncChannelOwners(db: D1Database): Promise<string[]> {
  const rows = await db
    .prepare(
      "SELECT DISTINCT owner_subject FROM calendar_sync WHERE channel_id IS NOT NULL ORDER BY owner_subject",
    )
    .all<{ owner_subject: string }>();
  return rows.results.map((r) => r.owner_subject);
}

export async function upsertCalendarSync(
  db: D1Database,
  ownerSubject: string,
  calendarId: string,
  fields: Partial<Omit<CalendarSyncRow, "owner_subject" | "calendar_id">>,
): Promise<void> {
  const owner = requireOwner(ownerSubject);
  const existing = await getCalendarSync(db, owner, calendarId);
  const merged: CalendarSyncRow = {
    owner_subject: owner,
    calendar_id: calendarId,
    next_sync_token: fields.next_sync_token ?? existing?.next_sync_token ?? null,
    channel_id: fields.channel_id ?? existing?.channel_id ?? null,
    channel_token: fields.channel_token ?? existing?.channel_token ?? null,
    channel_expires_at: fields.channel_expires_at ?? existing?.channel_expires_at ?? null,
    channel_resource_id: fields.channel_resource_id ?? existing?.channel_resource_id ?? null,
    channel_callback_url: fields.channel_callback_url ?? existing?.channel_callback_url ?? null,
  };
  await db
    .prepare(
      `INSERT INTO calendar_sync (owner_subject, calendar_id, next_sync_token, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_subject, calendar_id) DO UPDATE SET
         next_sync_token = excluded.next_sync_token,
         channel_id = excluded.channel_id,
         channel_token = excluded.channel_token,
         channel_expires_at = excluded.channel_expires_at,
         channel_resource_id = excluded.channel_resource_id,
         channel_callback_url = excluded.channel_callback_url`,
    )
    .bind(
      merged.owner_subject,
      merged.calendar_id,
      merged.next_sync_token,
      merged.channel_id,
      merged.channel_token,
      merged.channel_expires_at,
      merged.channel_resource_id,
      merged.channel_callback_url,
    )
    .run();
}

export interface CalendarSyncChannelOwnerWithProvider {
  owner_subject: string;
  provider: ProviderName;
}

// Same owner set as listCalendarSyncChannelOwners (rows without a channel_id
// excluded — see that function's comment), but resolves each owner's
// provider in the same query via a LEFT JOIN on identity_tokens, instead of
// each caller doing a separate getSubjectProvider lookup per owner. An owner
// with no identity_tokens row (or an unrecognized stored value) coalesces to
// "google" — same default as getSubjectProvider.
export async function listCalendarSyncChannelOwnersWithProvider(
  db: D1Database,
): Promise<CalendarSyncChannelOwnerWithProvider[]> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT cs.owner_subject AS owner_subject, it.provider AS provider
       FROM calendar_sync cs
       LEFT JOIN identity_tokens it ON it.account_email = cs.owner_subject
       WHERE cs.channel_id IS NOT NULL
       ORDER BY cs.owner_subject`,
    )
    .all<{ owner_subject: string; provider: string | null }>();
  return rows.results.map((r) => ({
    owner_subject: r.owner_subject,
    provider: r.provider != null && isProviderName(r.provider) ? r.provider : "google",
  }));
}

// The renewal sweep's CREATE pass: active users who hold a stored grant
// (identity_tokens) but have no push channel on their primary calendar — no
// calendar_sync row at all, or a row whose channel_id is NULL (sync-token
// only, or nulled by a provider switch). Disjoint from the renew pass's set
// at read time. Provider coalesces to "google" exactly as above. The users
// join keeps a deactivated row out even if a grant row survived it, and a row
// whose credential an admin rebind wiped holds no grant (it is idle until the
// next sign-in, whose own subscribe then runs).
export async function listGrantHoldersWithoutChannel(
  db: D1Database,
): Promise<CalendarSyncChannelOwnerWithProvider[]> {
  const rows = await db
    .prepare(
      `SELECT it.account_email AS owner_subject, it.provider AS provider
       FROM identity_tokens it
       JOIN users u ON u.subject = it.account_email AND u.is_active = 1
       LEFT JOIN calendar_sync cs ON cs.owner_subject = it.account_email AND cs.calendar_id = ?
       WHERE cs.channel_id IS NULL AND length(it.refresh_token_encrypted) > 0
       ORDER BY it.account_email`,
    )
    .bind(PRIMARY_CALENDAR_ID)
    .all<{ owner_subject: string; provider: string | null }>();
  return rows.results.map((r) => ({
    owner_subject: r.owner_subject,
    provider: r.provider != null && isProviderName(r.provider) ? r.provider : "google",
  }));
}

/** Compare-and-set the push-channel fields: writes only while the stored
 *  channel_id still IS `expectedChannelId` (NULL included; a missing row is
 *  inserted) AND the subject still holds a stored grant (an identity_tokens
 *  row whose credential an admin rebind has not wiped). next_sync_token is
 *  never touched. Returns false when another writer changed the channel since
 *  `expectedChannelId` was read, or when the subject has no grant (offboarded
 *  while this caller was subscribing — the insert would otherwise recreate a
 *  row the offboard just deleted, keyed by email so it outlives the purge; or
 *  rebound, whose previous holder's channel must not land on the idle
 *  account). Either way the caller's channel lost and must be stopped
 *  (subscription-manager.ts). */
export async function casCalendarSyncChannel(
  db: D1Database,
  ownerSubject: string,
  calendarId: string,
  expectedChannelId: string | null,
  fields: {
    channel_id: string;
    channel_token: string;
    channel_expires_at: string;
    channel_resource_id: string;
    channel_callback_url: string;
  },
): Promise<boolean> {
  const owner = requireOwner(ownerSubject);
  const res = await db
    .prepare(
      `INSERT INTO calendar_sync (owner_subject, calendar_id, channel_id, channel_token, channel_expires_at, channel_resource_id, channel_callback_url)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM identity_tokens WHERE account_email = ? AND length(refresh_token_encrypted) > 0)
       ON CONFLICT(owner_subject, calendar_id) DO UPDATE SET
         channel_id = excluded.channel_id,
         channel_token = excluded.channel_token,
         channel_expires_at = excluded.channel_expires_at,
         channel_resource_id = excluded.channel_resource_id,
         channel_callback_url = excluded.channel_callback_url
       WHERE calendar_sync.channel_id IS ?`,
    )
    .bind(
      owner,
      calendarId,
      fields.channel_id,
      fields.channel_token,
      fields.channel_expires_at,
      fields.channel_resource_id,
      fields.channel_callback_url,
      owner,
      expectedChannelId,
    )
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Compare-and-set the expiry of an in-place renewed channel: an UPDATE only,
 *  applied while the stored channel_id still IS `channelId`. Never inserts, so
 *  an offboard that deleted the row while the renew was in flight is not
 *  undone, and a channel a concurrent rotation stored keeps its own expiry.
 *  Returns false when nothing was written (the renewed channel is no longer
 *  the stored one; the caller stops it best-effort). */
export async function casCalendarSyncChannelExpiry(
  db: D1Database,
  ownerSubject: string,
  calendarId: string,
  channelId: string,
  channelExpiresAt: string,
): Promise<boolean> {
  const owner = requireOwner(ownerSubject);
  const res = await db
    .prepare(
      `UPDATE calendar_sync SET channel_expires_at = ?
       WHERE owner_subject = ? AND calendar_id = ? AND channel_id IS ?`,
    )
    .bind(channelExpiresAt, owner, calendarId, channelId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}
