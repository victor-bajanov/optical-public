-- 0036_identity_provider.sql — per-user IdP selection (Outlook 365 support).
-- Ends the "one IdP per deployment" model from migration 0009.
ALTER TABLE identity_tokens ADD COLUMN provider TEXT NOT NULL DEFAULT 'google';
