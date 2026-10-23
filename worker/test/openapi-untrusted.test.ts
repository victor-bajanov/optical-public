import { describe, it, expect } from "vitest";
import { buildOpenApiDocument } from "../src/schema/openapi-document";
import { UNTRUSTED_EXTENSION } from "../src/schema/untrusted";

// O9.6 / inventory §6 (b): every response field that can carry third-party
// controlled text is tagged `x-optical-untrusted: true`, so an MCP gateway
// (codemode-mcp C9.1) can fence it before an LLM reads it.

const doc: any = buildOpenApiDocument();

/** Walk a dotted path through a JSON-Schema fragment. `[]` steps into array
 *  items; anyOf/oneOf branches are searched for the first that has the step. */
function at(schema: any, path: string): any {
  let cur = schema;
  for (const raw of path.split(".")) {
    const isArray = raw.endsWith("[]");
    const key = isArray ? raw.slice(0, -2) : raw;
    cur = unwrap(cur);
    cur = cur?.properties?.[key];
    if (cur === undefined) throw new Error(`no property ${key} in ${path}`);
    if (isArray) cur = unwrap(cur).items;
  }
  return cur;
}
function unwrap(s: any): any {
  if (!s) return s;
  if (s.properties || s.items) return s;
  for (const k of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(s[k])) {
      const hit = s[k].find((b: any) => b.properties || b.items);
      if (hit) return hit;
    }
  }
  return s;
}
const res = (path: string, method: string, code = "200") =>
  doc.paths[path][method].responses[code].content["application/json"].schema;

const MARKED: Array<[string, string, string]> = [
  // [path, method, dotted field]
  ["/v1/bookings", "get", "bookings[].booker_name"],
  ["/v1/bookings", "get", "bookings[].booker_email"],
  ["/v1/bookings", "get", "bookings[].booker_note"],
  ["/v1/bookings", "get", "bookings[].location_detail"],
  ["/v1/polls/{id}", "get", "invitees[].name"],
  ["/v1/polls/{id}", "get", "invitees[].email"],
  ["/v1/polls/{id}", "patch", "invitees[].name"],
  ["/v1/polls/{id}", "patch", "invitees[].email"],
  ["/v1/tasks", "get", "tasks[].title"],
  ["/v1/tasks", "get", "tasks[].location"],
  ["/v1/tasks/{id}", "get", "title"],
  ["/v1/resolve", "post", "dropped[].title"],
  ["/v1/resolve", "post", "warnings"],
  ["/v1/plans/{plan_hash}", "get", "body.dropped[].title"],
  ["/v1/schedule", "get", "dropped[].title"],
  ["/v1/plans/latest", "get", "plan.render_snapshot.days[].before[].title"],
  ["/v1/plans/latest", "get", "plan.render_snapshot.days[].after[].title"],
  ["/v1/plans/latest", "get", "plan.render_snapshot.dropped[].title"],
  ["/v1/plans/latest", "get", "plan.render_snapshot.warnings"],
  ["/v1/replan-now", "post", "model.days[].before[].title"],
  ["/v1/replan-now", "post", "model.days[].after[].title"],
  ["/v1/replan-now", "post", "model.dropped[].title"],
  ["/v1/replan-now", "post", "model.warnings"],
  ["/v1/polls/{id}/nudge", "post", "nudged"],
];

describe("x-optical-untrusted markers (O9.6)", () => {
  it("uses the documented extension name", () => {
    expect(UNTRUSTED_EXTENSION).toBe("x-optical-untrusted");
  });

  it.each(MARKED)("%s %s marks %s", (path, method, field) => {
    expect(doc.paths[path]?.[method], `${method} ${path} missing`).toBeDefined();
    expect(at(res(path, method), field)?.["x-optical-untrusted"]).toBe(true);
  });

  it("marks the snapshot trigger's inviteTitle (webhook branch)", () => {
    for (const [path, method, root] of [["/v1/plans/latest", "get", "plan.render_snapshot"], ["/v1/replan-now", "post", "model"]] as const) {
      const trigger = at(res(path, method), `${root}.trigger`);
      const branches: any[] = trigger.anyOf ?? trigger.oneOf ?? [trigger];
      const webhook = branches.find((b) => b.properties?.inviteTitle);
      expect(webhook?.properties.inviteTitle["x-optical-untrusted"], `${path}`).toBe(true);
    }
  });

  it("does not mark first-party fields", () => {
    expect(at(res("/v1/bookings", "get"), "bookings[].id")["x-optical-untrusted"]).toBeUndefined();
    expect(at(res("/v1/bookings", "get"), "bookings[].start_utc")["x-optical-untrusted"]).toBeUndefined();
    expect(at(res("/v1/polls/{id}", "get"), "invitees[].id")["x-optical-untrusted"]).toBeUndefined();
  });

  it("explains the extension in info.description", () => {
    expect(doc.info.description).toContain("x-optical-untrusted");
  });
});
