-- Provider-neutral name: one IdP per deployment, account_email is the subject.
ALTER TABLE google_oauth_tokens RENAME TO identity_tokens;
