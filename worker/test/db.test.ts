import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { putJsonRow, getJsonRow, deleteRow, listJsonRows } from "../src/db/d1";

const OWNER = "test@org";

describe("d1 helpers", () => {
  it("round-trips a JSON row in projects", async () => {
    await putJsonRow(env.DB, OWNER, "projects", "p1", { title: "x" });
    const row = await getJsonRow<{ title: string }>(env.DB, OWNER, "projects", "p1");
    expect(row).toEqual({ title: "x" });
  });

  it("returns null for missing row", async () => {
    const row = await getJsonRow(env.DB, OWNER, "projects", "missing");
    expect(row).toBeNull();
  });

  it("deletes a row", async () => {
    await putJsonRow(env.DB, OWNER, "projects", "p2", { title: "y" });
    await deleteRow(env.DB, OWNER, "projects", "p2");
    expect(await getJsonRow(env.DB, OWNER, "projects", "p2")).toBeNull();
  });

  it("lists rows", async () => {
    await putJsonRow(env.DB, OWNER, "projects", "p3", { title: "a" });
    await putJsonRow(env.DB, OWNER, "projects", "p4", { title: "b" });
    const rows = await listJsonRows<{ title: string }>(env.DB, OWNER, "projects");
    const titles = rows.map((r) => r.body.title).sort();
    expect(titles).toEqual(expect.arrayContaining(["a", "b"]));
  });
});
