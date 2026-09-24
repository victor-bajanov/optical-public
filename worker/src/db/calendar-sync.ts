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

// Owners that have (or had) a live push channel. Rows without a channel_id are
// feed/sync-token-only and are deliberately excluded: the renewal sweep must
// keep existing subscriptions alive, never create first-time ones (subscribe-on-
// onboard stays an explicit /admin/webhook/subscribe decision).
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

/** Forget everything provider-shaped for an owner: sync token AND push channel
 *  fields. Used on an identity-provider switch — a Google sync token handed to
 *  Graph (or a Graph deltaLink handed to Google) is not a 410, it is a hard
 *  error on every replan forever. The row is kept (nulled), not deleted. */
export async function resetCalendarSyncForOwner(db: D1Database, ownerSubject: string): Promise<void> {
  const owner = requireOwner(ownerSubject);
  await db
    .prepare(
      `UPDATE calendar_sync SET next_sync_token = NULL, channel_id = NULL, channel_token = NULL,
         channel_expires_at = NULL, channel_resource_id = NULL, channel_callback_url = NULL
       WHERE owner_subject = ?`,
    )
    .bind(owner)
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
