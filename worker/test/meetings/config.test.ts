import { describe, it, expect } from "vitest";
import { readMeetingConfig } from "../../src/meetings/config";

describe("readMeetingConfig commitStabilityMinutes", () => {
  it("parses MEETING_COMMIT_STABILITY_MINUTES", () => {
    const cfg = readMeetingConfig({ MEETING_COMMIT_STABILITY_MINUTES: "30" } as any);
    expect(cfg.commitStabilityMinutes).toBe(30);
  });
  it("defaults to 60 when unset", () => {
    const cfg = readMeetingConfig({} as any);
    expect(cfg.commitStabilityMinutes).toBe(60);
  });
});
