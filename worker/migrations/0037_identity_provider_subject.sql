-- 0037_identity_provider_subject.sql — anchor identity on the IdP's immutable
-- subject (Microsoft tid:oid, Google userinfo id), not the mutable email.
--
-- Nullable: pre-existing rows carry no provider_subject until their next
-- login backfills it (identity-store.ts resolveSubject). Partial unique index
-- so multiple NULLs coexist (SQLite treats NULL as distinct in a unique
-- index) while a real (provider, provider_subject) pair can only ever back
-- one row.
ALTER TABLE identity_tokens ADD COLUMN provider_subject TEXT;

CREATE UNIQUE INDEX idx_identity_tokens_provider_subject
  ON identity_tokens(provider, provider_subject)
  WHERE provider_subject IS NOT NULL;
