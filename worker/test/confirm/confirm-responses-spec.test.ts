import { describe, it, expect } from "vitest";
import { buildOpenApiDocument } from "../../src/schema/openapi-document";

// Decision K: every agent-confirm gated op documents the live-action cap's
// 429, and commit/acceptPlan's 202 action_id is described as the plan_hash.
const doc = JSON.parse(JSON.stringify(buildOpenApiDocument())) as any;

function gatedOps(): Array<{ id: string; responses: Record<string, any> }> {
  const out: Array<{ id: string; responses: Record<string, any> }> = [];
  for (const ops of Object.values<any>(doc.paths)) {
    for (const op of Object.values<any>(ops)) {
      const r202 = op?.responses?.["202"];
      if (r202 && /awaiting_confirmation/.test(r202.description ?? "")) out.push({ id: op.operationId, responses: op.responses });
    }
  }
  return out;
}

describe("gated ops in the published spec", () => {
  it("finds every gated op", () => {
    expect(gatedOps().map((o) => o.id).sort()).toEqual([
      "acceptPlan", "cancelMeetingPoll", "commit", "createMeetingPoll", "deleteAccount",
      "nudgeMeetingPoll", "resolveMeetingPoll", "updateBookingPage", "updateMeetingPoll",
    ]);
  });

  it("each documents 429 too_many_pending_actions", () => {
    const missing = gatedOps().filter((o) => !String(o.responses["429"]?.description ?? "").includes("too_many_pending_actions"));
    expect(missing.map((o) => o.id)).toEqual([]);
  });

  it("the 429 says a plan's accept email frees its slot once accepted or superseded", () => {
    for (const o of gatedOps()) {
      expect(String(o.responses["429"].description), o.id).toMatch(/accepted or superseded, else after 72 hours/);
    }
  });

  it("commit's and acceptPlan's 202 action_id is described as the plan_hash, not an opaque id", () => {
    for (const o of gatedOps().filter((x) => x.id === "commit" || x.id === "acceptPlan")) {
      const d = o.responses["202"].content["application/json"].schema.properties.action_id.description as string;
      expect(d, o.id).toMatch(/plan_hash/);
      expect(d, o.id).not.toMatch(/opaque/i);
    }
  });

  it("other gated ops keep the opaque action_id wording", () => {
    const o = gatedOps().find((x) => x.id === "createMeetingPoll")!;
    expect(o.responses["202"].content["application/json"].schema.properties.action_id.description).toMatch(/opaque/i);
  });
});
