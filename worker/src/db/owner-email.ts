/**
 * The address to send OWNER-addressed email to: the verified email from the
 * owner's most recent sign-in (identity_tokens.login_email, migration 0046),
 * falling back to the subject when the column is NULL or empty, or the
 * subject has no identity_tokens row.
 *
 * Don't address owner mail to the bare subject. The subject is the email the
 * account was first created under and is kept for life (0037 anchors identity
 * on provider_subject), so after an IdP-side rename it can belong to someone
 * else, who would then receive every owner notification, accept links
 * included. The subject stays the key for everything else. Invitee, booker
 * and attendee addresses are not owner addresses and don't come through here.
 */
export async function ownerNotificationEmail(db: D1Database, subject: string): Promise<string> {
  const row = await db
    .prepare("SELECT login_email FROM identity_tokens WHERE account_email = ?")
    .bind(subject)
    .first<{ login_email: string | null }>();
  return row?.login_email || subject;
}
