-- 0024_oauth_clients_allowed_scopes.sql — per-client granted-scope allowlist.
-- The space-separated set of OAuth scopes a client may be granted at
-- /authorize. Privileged scopes (calendar:raw-token, admin) are withheld from
-- any client whose row does not list them; `admin` additionally requires the
-- authenticated subject's admin role (applied at /auth/callback). See
-- internal design notes.
ALTER TABLE oauth_clients
  ADD COLUMN allowed_scopes TEXT NOT NULL DEFAULT 'scheduler:read scheduler:write';
