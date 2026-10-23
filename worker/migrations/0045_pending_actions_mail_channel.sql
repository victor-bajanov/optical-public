-- 0045_pending_actions_mail_channel.sql — decision K (confirm-email flooding).
--
-- 'system' when a deferral's confirmation email went out through the shared
-- SMTP2GO system mailer because the user's own mailbox send failed; NULL
-- otherwise (sent from the user's mailbox, and every row before 0045). The
-- deferral path counts an owner's 'system' rows created in the last 24 h to
-- cap that fallback per owner (SYSTEM_FALLBACK_DAILY_LIMIT in
-- worker/src/db/pending-actions.ts), so a looping agent can't drain the
-- quota that every user's retention and deletion mail depends on.
ALTER TABLE pending_actions ADD COLUMN mail_channel TEXT;
