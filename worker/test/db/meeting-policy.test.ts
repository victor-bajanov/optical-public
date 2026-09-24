import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { loadMeetingPolicy } from "../../src/db/meeting-policy";

describe("loadMeetingPolicy", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM config_meeting_policy").run();
  });

  it("falls back to the __default__ seed value", async () => {
    await env.DB.prepare("INSERT INTO config_meeting_policy (owner_subject, body) VALUES ('__default__', ?)")
      .bind(JSON.stringify({ attendee_enforcement: "not_declined" })).run();
    expect(await loadMeetingPolicy(env.DB, "someone@x")).toBe("not_declined");
  });

  it("own row wins over __default__", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO config_meeting_policy (owner_subject, body) VALUES ('__default__', ?)")
        .bind(JSON.stringify({ attendee_enforcement: "not_declined" })),
      env.DB.prepare("INSERT INTO config_meeting_policy (owner_subject, body) VALUES ('me@x', ?)")
        .bind(JSON.stringify({ attendee_enforcement: "accepted" })),
    ]);
    expect(await loadMeetingPolicy(env.DB, "me@x")).toBe("accepted");
  });

  it("hardcoded fallback (not_declined) when no rows exist", async () => {
    expect(await loadMeetingPolicy(env.DB, "me@x")).toBe("not_declined");
  });
});
