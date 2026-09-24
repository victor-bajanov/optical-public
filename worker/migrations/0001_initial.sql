-- 0001_initial.sql — Tasks, templates, projects, OAuth, Google tokens, config.

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,            -- JSON: full Task spec (§3.1)
  template_id TEXT,
  project_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_status ON tasks(status);
CREATE INDEX tasks_template ON tasks(template_id);
CREATE INDEX tasks_project ON tasks(project_id);

CREATE TABLE task_templates (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,            -- JSON: full TaskTemplate (§3.2)
  active_from TEXT,
  active_until TEXT
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL             -- JSON: full Project (§3.3)
);

CREATE TABLE config_weights (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL             -- JSON
);

CREATE TABLE config_contexts (
  context TEXT PRIMARY KEY,
  body TEXT NOT NULL             -- JSON
);

-- OAuth (provider role)
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,            -- 'pkce' | 'device'
  redirect_uris TEXT,            -- JSON array, nullable for device clients
  created_at TEXT NOT NULL
);

CREATE TABLE oauth_tokens (
  hashed_token TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL,          -- space-delimited
  expires_at TEXT,               -- null = no expiry (refresh tokens)
  refresh_of TEXT,               -- hashed_token of the access token a refresh token rotates
  revoked_at TEXT
);
CREATE INDEX oauth_tokens_client ON oauth_tokens(client_id);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- 'auth' | 'device'
  user_code TEXT,                -- short human code for device flow, null for auth codes
  pkce_challenge TEXT,           -- S256 challenge for auth codes, null for device
  pkce_method TEXT,              -- 'S256'
  redirect_uri TEXT,
  scopes TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  authorized_at TEXT,            -- device flow: set when user approves
  used_at TEXT
);
CREATE INDEX oauth_codes_user_code ON oauth_codes(user_code);

-- OAuth (client-to-Google role)
CREATE TABLE google_oauth_tokens (
  account_email TEXT PRIMARY KEY,
  refresh_token_encrypted BLOB NOT NULL,
  scopes TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
