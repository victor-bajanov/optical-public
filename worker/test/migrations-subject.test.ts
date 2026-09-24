import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("0008 subject columns", () => {
  it("oauth_codes, oauth_tokens, and proposed_plans have a subject column", async () => {
    const codeCols = await env.DB.prepare("PRAGMA table_info(oauth_codes)").all();
    const tokCols = await env.DB.prepare("PRAGMA table_info(oauth_tokens)").all();
    const planCols = await env.DB.prepare("PRAGMA table_info(proposed_plans)").all();
    const names = (r: { results: unknown[] }) => r.results.map((c: any) => c.name);
    expect(names(codeCols)).toContain("subject");
    expect(names(tokCols)).toContain("subject");
    expect(names(planCols)).toContain("subject");
  });
});
