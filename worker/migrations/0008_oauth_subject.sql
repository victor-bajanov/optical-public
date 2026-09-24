-- IdP account email captured at login; links an issued optical token (and the
-- plan it commits) to the Google/identity account it acts on. Nullable: legacy
-- rows predate federation, and the phase-1 single-operator check treats null as
-- "no isolation".
ALTER TABLE oauth_codes     ADD COLUMN subject TEXT;
ALTER TABLE oauth_tokens    ADD COLUMN subject TEXT;
ALTER TABLE proposed_plans  ADD COLUMN subject TEXT;
