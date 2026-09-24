// Single source of truth for D1 tables scoped to one user. Drives offboardUser's
// DELETE batch (policy: "delete") and the schema-introspection guard test, which
// fails if a table exposing an owner_subject/subject/account_email column is not
// listed here — forcing an explicit delete/keep decision on every new table.
//
// `column` is the per-user scoping column. `extraDeletes` carries additional
// DELETE statements (one `?` each, bound to the subject), run BEFORE the primary
// keyed delete for this table — needed both for extra rows on the SAME table
// (e.g. proposed_plans' legacy NULL-subject rows) and for CHILD tables that carry
// no owner column of their own and are scoped only transitively through this
// table's rows (e.g. poll_invitees/poll_responses via poll_id -> polls.subject;
// a child delete must run while the parent rows it joins against still exist).
// `keep` records tables that are owner-scoped but intentionally retained, with a
// reason; the guard accepts these too.
export type OwnerScopedTable =
  | { table: string; column: string; policy: "delete"; extraDeletes?: string[] }
  | { table: string; column: string; policy: "keep"; reason: string };

export const OWNER_SCOPED_TABLES: readonly OwnerScopedTable[] = [
  { table: "tasks", column: "owner_subject", policy: "delete" },
  { table: "task_templates", column: "owner_subject", policy: "delete" },
  { table: "template_exclusions", column: "owner_subject", policy: "delete" },
  { table: "chunk_completions", column: "owner_subject", policy: "delete" },
  { table: "projects", column: "owner_subject", policy: "delete" },
  { table: "calendar_sync", column: "owner_subject", policy: "delete" },
  { table: "identity_tokens", column: "account_email", policy: "delete" },
  { table: "oauth_tokens", column: "subject", policy: "delete" },
  { table: "oauth_codes", column: "subject", policy: "delete" },
  { table: "calendar_feed_tokens", column: "owner_subject", policy: "delete" }, // OS2
  { table: "calendar_feed_reveals", column: "owner_subject", policy: "delete" },
  { table: "config_weights", column: "owner_subject", policy: "delete" }, // L9
  { table: "config_contexts", column: "owner_subject", policy: "delete" }, // L9
  { table: "config_business_hours", column: "owner_subject", policy: "delete" }, // L9
  { table: "config_meeting_policy", column: "owner_subject", policy: "delete" },
  { table: "config_booking_page", column: "owner_subject", policy: "delete" },
  { table: "bookings", column: "owner_subject", policy: "delete" },
  {
    table: "polls",
    column: "subject",
    policy: "delete",
    extraDeletes: [
      // Two levels transitive: poll_responses -> poll_invitees -> polls.subject.
      "DELETE FROM poll_responses WHERE invitee_id IN (SELECT pi.id FROM poll_invitees pi JOIN polls p ON p.id = pi.poll_id WHERE p.subject = ?)",
      "DELETE FROM poll_invitees WHERE poll_id IN (SELECT id FROM polls WHERE subject = ?)",
      // One level transitive: poll_join_attempts -> polls.subject (0034).
      // poll_join_attempts.poll_id REFERENCES polls(id), so without this the
      // primary `polls` delete below would fail its FK constraint outright
      // (rather than merely leaving orphans) whenever the offboarded subject
      // had a poll with any recorded join attempts.
      "DELETE FROM poll_join_attempts WHERE poll_id IN (SELECT id FROM polls WHERE subject = ?)",
    ],
  },
  {
    table: "proposed_plans",
    column: "subject",
    policy: "delete",
    extraDeletes: [
      "DELETE FROM proposed_plans WHERE subject IS NULL AND json_extract(body, '$.account_email') = ?",
    ],
  },
  { table: "audit_log", column: "subject", policy: "keep", reason: "history intentionally retained" },
  { table: "users", column: "subject", policy: "keep", reason: "deactivated via deactivateUser, not hard-deleted" },
] as const;

/** Columns that mark a table as scoped to a single user. The guard scans the live
 *  schema for any of these; every match must appear in OWNER_SCOPED_TABLES. */
export const OWNER_SCOPING_COLUMNS = ["owner_subject", "subject", "account_email"] as const;
