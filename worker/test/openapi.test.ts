import { describe, it, expect } from "vitest";
import { v1 } from "../src/v1";
import { API_OVERVIEW } from "../src/schema/descriptions";
import { buildOpenApiDocument } from "../src/schema/openapi-document";
import published from "../../schema/openapi.json";

// Property names that legitimately carry no description: error envelopes and
// discriminated-union discriminators (rendered as const enums).
const ALLOWLIST = new Set([
  "error", // error-envelope code (e.g. "not_found", "solver_failed")
  "issues", // zod validation issue list on a 400 error envelope
  "type", // discriminated-union discriminator, rendered as a const enum
  "ok", // ack-envelope flag on accept/webhook 200 responses (always true)
]);

/** Recursively assert every object property in a JSON-Schema fragment has a
 *  non-empty description. Returns the list of dotted paths that are missing.
 *  Assumes all schemas are inlined: it does NOT follow `$ref`, so a named
 *  component would be silently skipped. The "inlines all schemas" test below
 *  guards that assumption — if components.schemas ever becomes non-empty, that
 *  test fails loudly and this walker must be taught to resolve `$ref`. */
function findUndescribed(schema: any, path: string, missing: string[]): void {
  if (!schema || typeof schema !== "object") return;
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    if (Array.isArray(schema[key])) schema[key].forEach((s: any, i: number) => findUndescribed(s, `${path}/${key}[${i}]`, missing));
  }
  if (schema.type === "array" && schema.items) findUndescribed(schema.items, `${path}[]`, missing);
  if (schema.properties) {
    for (const [prop, sub] of Object.entries<any>(schema.properties)) {
      if (!ALLOWLIST.has(prop) && (!sub.description || sub.description.trim() === "")) {
        missing.push(`${path}.${prop}`);
      }
      findUndescribed(sub, `${path}.${prop}`, missing);
    }
  }
}

const doc: any = v1.getOpenAPIDocument({
  openapi: "3.1.0",
  info: { title: "Weekly Scheduling Assistant", version: "0.1.0", description: API_OVERVIEW },
});

describe("OpenAPI spec descriptions", () => {
  it("has a non-empty info.description", () => {
    expect(doc.info.description?.length ?? 0).toBeGreaterThan(0);
  });

  it("gives every operation a summary and a description", () => {
    const bare: string[] = [];
    for (const [p, ops] of Object.entries<any>(doc.paths)) {
      for (const [m, op] of Object.entries<any>(ops)) {
        if (!["get", "post", "patch", "delete", "put"].includes(m)) continue;
        if (!op.summary?.trim()) bare.push(`${m.toUpperCase()} ${p} (summary)`);
        if (!op.description?.trim()) bare.push(`${m.toUpperCase()} ${p} (description)`);
      }
    }
    expect(bare).toEqual([]);
  });

  it("describes every property in request and JSON response bodies", () => {
    const missing: string[] = [];
    for (const [p, ops] of Object.entries<any>(doc.paths)) {
      for (const [m, op] of Object.entries<any>(ops)) {
        if (!["get", "post", "patch", "delete", "put"].includes(m)) continue;
        const reqSchema = op.requestBody?.content?.["application/json"]?.schema;
        if (reqSchema) findUndescribed(reqSchema, `${m.toUpperCase()} ${p} req`, missing);
        for (const [code, resp] of Object.entries<any>(op.responses ?? {})) {
          const rs = resp?.content?.["application/json"]?.schema;
          if (rs) findUndescribed(rs, `${m.toUpperCase()} ${p} res.${code}`, missing);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("inlines all schemas (guard assumes no $ref)", () => {
    expect(Object.keys(doc.components?.schemas ?? {})).toEqual([]);
  });

  it("states the movable-verdict requirement in the bookable_over_movable_meetings contract", () => {
    // This description is published (schema/openapi.json) and read by a
    // downstream MCP connector, so it IS the contract. Listing only "owned,
    // unpinned, outside the notice window, not a booking" understates the gate:
    // a meeting's time is offered ONLY on a fresh positive movable_verdict from
    // a recent resolve. See src/booking/bookable-over.ts.
    const found: string[] = [];
    const walk = (schema: any): void => {
      if (!schema || typeof schema !== "object") return;
      for (const key of ["allOf", "anyOf", "oneOf"]) {
        if (Array.isArray(schema[key])) schema[key].forEach(walk);
      }
      if (schema.type === "array" && schema.items) walk(schema.items);
      if (schema.properties) {
        for (const [prop, sub] of Object.entries<any>(schema.properties)) {
          if (prop === "bookable_over_movable_meetings" && sub.description) found.push(sub.description);
          walk(sub);
        }
      }
    };
    for (const ops of Object.values<any>(doc.paths)) {
      for (const op of Object.values<any>(ops)) {
        walk(op?.requestBody?.content?.["application/json"]?.schema);
        for (const resp of Object.values<any>(op?.responses ?? {})) {
          walk(resp?.content?.["application/json"]?.schema);
        }
      }
    }
    expect(found.length).toBeGreaterThan(0);
    for (const desc of found) {
      expect(desc).toMatch(/verdict/i);
      expect(desc).toMatch(/resolve/i);
    }
  });

  it("has no drift between the live routes and the PUBLISHED schema/openapi.json", () => {
    // Every other test here builds the document in memory from the live Zod
    // routes, so all of them pass against a stale published file. But
    // schema/openapi.json is the artefact a downstream MCP connector reads —
    // editing src/schema/descriptions.ts without re-running `npm run
    // openapi:build` silently ships a contract that disagrees with the worker.
    // That has now happened twice on this branch, so assert it here.
    //
    // Reports differing dotted paths rather than deep-equalling two ~280 KB
    // objects, whose diff would be unreadable. Fix a failure by running
    // `cd worker && npm run openapi:build`, never by editing the JSON by hand.
    const drift: string[] = [];
    const walk = (a: unknown, b: unknown, path: string): void => {
      if (drift.length >= 20) return; // cap: the first few name the stale field
      if (a === b) return;
      const objA = a !== null && typeof a === "object";
      const objB = b !== null && typeof b === "object";
      if (!objA || !objB) {
        if (JSON.stringify(a) !== JSON.stringify(b)) drift.push(path);
        return;
      }
      const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
      for (const k of keys) {
        walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      }
    };
    // Round-trip the generated doc: JSON.stringify drops undefined-valued keys,
    // so this compares what would actually be WRITTEN, not the in-memory object.
    walk(JSON.parse(JSON.stringify(buildOpenApiDocument())), published, "$");
    expect(drift).toEqual([]);
  });

  it("describes every operation parameter", () => {
    const bare: string[] = [];
    for (const [p, ops] of Object.entries<any>(doc.paths)) {
      for (const [m, op] of Object.entries<any>(ops)) {
        if (!["get", "post", "patch", "delete", "put"].includes(m)) continue;
        for (const param of (op.parameters ?? []) as any[]) {
          const desc = param.description ?? param.schema?.description;
          if (!desc || !desc.trim()) bare.push(`${m.toUpperCase()} ${p} param ${param.name}`);
        }
      }
    }
    expect(bare).toEqual([]);
  });
});
