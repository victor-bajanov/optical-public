import { describe, it, expect } from "vitest";
import { D } from "../../src/schema/descriptions";

// O14 #9: the deleteAccount contract must claim only what offboard does. The
// calendar sweep removes UPCOMING Optical work blocks only (offboard.ts,
// isSchedulerOwned + horizon), and the kept users row holds the email address
// alone (deactivateUser clears home_tz and done_color_id).
describe("deleteAccount description — deletion truthfulness", () => {
  const desc = D.account.deleteAccount;

  it("scopes the calendar sweep to upcoming work blocks", () => {
    expect(desc).toContain("best-effort removes upcoming Optical-placed work blocks (past ones and booked meetings stay)");
    expect(desc).not.toContain("best-effort removes Optical-placed events");
  });

  // Decision F: the kept row holds more than the address (role, timestamps),
  // and DELETED_ACCOUNT_RETENTION_DAYS bounds how long it and the audit
  // log's copy of the address are kept.
  it("says what the retained users row keeps, without the 'email address only' overclaim", () => {
    expect(desc).not.toContain("keeps the email address only");
    expect(desc).toContain("keeps the email address, role and timestamps");
  });

  it("says for how long: purged after DELETED_ACCOUNT_RETENTION_DAYS when set, else kept indefinitely", () => {
    expect(desc).toContain("DELETED_ACCOUNT_RETENTION_DAYS");
    expect(desc).toContain("pseudonym");
    expect(desc).toContain("kept indefinitely");
  });

  // Decision B: agent-confirm clients only defer; the human's click deletes.
  it("says an agent-confirm client gets 202 awaiting_confirmation and the deletion waits for the emailed link", () => {
    expect(desc).toContain("AGENT_CONFIRM_CLIENT_IDS");
    expect(desc).toContain("202 awaiting_confirmation");
    expect(desc).toContain("nothing is deleted on this call");
    expect(desc).toContain("503 confirmation_unavailable");
  });
});
