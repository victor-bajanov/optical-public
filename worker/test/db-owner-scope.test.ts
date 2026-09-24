// worker/test/db-owner-scope.test.ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  putTaskRow, getTaskRow, listTasks, deleteRow,
  putJsonRow, getJsonRow, listJsonRows,
} from "../src/db/d1";

const A = "a@org", B = "b@org";
const taskRow = (id: string) => ({
  id, body: { id, title: "x" }, template_id: null, project_id: null,
  status: "pending", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM tasks").run();
  await env.DB.prepare("DELETE FROM projects").run();
  await env.DB.prepare("DELETE FROM task_templates").run();
});

describe("owner-scoped task helpers", () => {
  it("getTaskRow returns the row to its owner and null to others", async () => {
    await putTaskRow(env.DB, A, taskRow("t1"));
    expect(await getTaskRow(env.DB, A, "t1")).not.toBeNull();
    expect(await getTaskRow(env.DB, B, "t1")).toBeNull();
  });

  it("listTasks only returns the caller's rows", async () => {
    await putTaskRow(env.DB, A, taskRow("t1"));
    await putTaskRow(env.DB, B, taskRow("t2"));
    expect(await listTasks(env.DB, A, {})).toHaveLength(1);
    expect(await listTasks(env.DB, B, {})).toHaveLength(1);
  });

  it("deleteRow cannot delete another owner's row", async () => {
    await putTaskRow(env.DB, A, taskRow("t1"));
    await deleteRow(env.DB, B, "tasks", "t1");      // wrong owner: no-op
    expect(await getTaskRow(env.DB, A, "t1")).not.toBeNull();
    await deleteRow(env.DB, A, "tasks", "t1");       // right owner: gone
    expect(await getTaskRow(env.DB, A, "t1")).toBeNull();
  });

  it("putTaskRow cannot overwrite a row owned by someone else", async () => {
    await putTaskRow(env.DB, A, taskRow("t1"));
    await putTaskRow(env.DB, B, { ...taskRow("t1"), body: { id: "t1", title: "hijack" } });
    const a = await getTaskRow<{ title: string }>(env.DB, A, "t1");
    expect(a?.body.title).toBe("x");                 // A's row untouched
    expect(await getTaskRow(env.DB, B, "t1")).toBeNull();
  });

  it("fails closed when the owner is empty", async () => {
    await expect(getTaskRow(env.DB, "", "t1")).rejects.toThrow(/owner_scope_missing/);
    await expect(listTasks(env.DB, "", {})).rejects.toThrow(/owner_scope_missing/);
  });
});

describe("owner-scoped JSON helpers (projects/templates)", () => {
  it("isolates getJsonRow / listJsonRows by owner", async () => {
    await putJsonRow(env.DB, A, "projects", "p1", { id: "p1" });
    await putJsonRow(env.DB, B, "projects", "p2", { id: "p2" });
    expect(await getJsonRow(env.DB, A, "projects", "p1")).not.toBeNull();
    expect(await getJsonRow(env.DB, B, "projects", "p1")).toBeNull();
    expect(await listJsonRows(env.DB, A, "projects")).toHaveLength(1);
  });

  it("putJsonRow cannot overwrite another owner's row", async () => {
    await putJsonRow(env.DB, A, "projects", "p1", { id: "p1", title: "x" });
    await putJsonRow(env.DB, B, "projects", "p1", { id: "p1", title: "hijack" });
    const a = await getJsonRow<{ title: string }>(env.DB, A, "projects", "p1");
    expect(a?.title).toBe("x");
  });
});
