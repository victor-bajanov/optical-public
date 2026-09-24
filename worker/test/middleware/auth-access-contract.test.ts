import { describe, it, expect } from "vitest";
import { requireAccess } from "../../src/middleware/auth-access";

describe("plan-c access middleware contract", () => {
  it("requireAccess is exported as a function (created by Plan B Task 7)", () => {
    expect(typeof requireAccess).toBe("function");
  });
});
