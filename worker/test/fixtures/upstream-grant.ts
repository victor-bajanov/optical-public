// A token-response `scope` that grants every product scope Optical can
// request from EITHER provider with every harness flag on (O6 checks the
// callback's grant against the requested product scopes). Literal, not
// derived from src/auth/scope-check.ts, so a test that uses it stays an
// independent statement of "the person ticked every box".
//
// Mixed on purpose: Google full URLs, Graph-prefixed and bare Microsoft names.
// Extras are harmless (the check is a superset test).
export const FULL_UPSTREAM_GRANT = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.acls",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://graph.microsoft.com/Calendars.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
  "Mail.Read",
].join(" ");
