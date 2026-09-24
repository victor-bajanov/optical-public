import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { seedTwoUsers, type SeededUser } from "./fixtures/owners";
import { atomicTask } from "./fixtures/tasks";

let a: SeededUser, b: SeededUser;
beforeEach(async () => { ({ a, b } = await seedTwoUsers()); });

async function createTaskAs(u: SeededUser): Promise<string> {
  const r = await SELF.fetch("https://x/v1/tasks", { method: "POST", headers: u.headers, body: JSON.stringify(atomicTask) });
  expect(r.status).toBe(201);
  return ((await r.json()) as { id: string }).id;
}

describe("cross-user isolation on /v1/tasks", () => {
  it("A's task is invisible in B's list", async () => {
    await createTaskAs(a);
    const r = await SELF.fetch("https://x/v1/tasks", { headers: { Authorization: `Bearer ${b.token}` } });
    expect(((await r.json()) as { tasks: unknown[] }).tasks).toHaveLength(0);
  });

  it("B cannot GET / PATCH / DELETE A's task by id (404)", async () => {
    const id = await createTaskAs(a);
    const get = await SELF.fetch(`https://x/v1/tasks/${id}`, { headers: { Authorization: `Bearer ${b.token}` } });
    expect(get.status).toBe(404);
    const patch = await SELF.fetch(`https://x/v1/tasks/${id}`, { method: "PATCH", headers: b.headers, body: JSON.stringify({ priority: 99 }) });
    expect(patch.status).toBe(404);
    const del = await SELF.fetch(`https://x/v1/tasks/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${b.token}` } });
    expect(del.status).toBe(404);
    // A still sees it intact.
    const aGet = await SELF.fetch(`https://x/v1/tasks/${id}`, { headers: { Authorization: `Bearer ${a.token}` } });
    expect(aGet.status).toBe(200);
  });

  it("a token with no subject is rejected (403)", async () => {
    // Re-point B's token to a NULL subject to simulate a legacy/identity-less token.
    const { env } = await import("cloudflare:test");
    await env.DB.prepare("UPDATE oauth_tokens SET subject = NULL WHERE subject = ?").bind(b.subject).run();
    const r = await SELF.fetch("https://x/v1/tasks", { headers: { Authorization: `Bearer ${b.token}` } });
    expect(r.status).toBe(403);
  });
});
