import { describe, it, expect } from "vitest";
import { intersectClientScopes, applyRoleEntitlement } from "../../src/auth/scope-policy";

describe("intersectClientScopes", () => {
  it("returns the requested scopes when all are allowed", () => {
    expect(intersectClientScopes(["a", "b"], ["a", "b", "c"])).toEqual(["a", "b"]);
  });
  it("returns null (fail-loud) when a requested scope is not allowed", () => {
    expect(intersectClientScopes(["a", "admin"], ["a", "b"])).toBeNull();
  });
  it("allows an empty request", () => {
    expect(intersectClientScopes([], ["a"])).toEqual([]);
  });
});

describe("applyRoleEntitlement", () => {
  it("keeps admin for an admin subject", () => {
    expect(applyRoleEntitlement(["a", "admin"], true)).toEqual(["a", "admin"]);
  });
  it("drops admin for a non-admin subject", () => {
    expect(applyRoleEntitlement(["a", "admin"], false)).toEqual(["a"]);
  });
  it("leaves non-admin scopes untouched for a non-admin", () => {
    expect(applyRoleEntitlement(["a", "calendar:raw-token"], false)).toEqual(["a", "calendar:raw-token"]);
  });
});
