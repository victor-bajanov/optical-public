// Card E (internal design notes): PreferredWindow.tz round-trips through
// the create schema, the response schema and the REST API.
import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { TaskCreate, TaskPatch } from "../../src/schema/task";
import { TaskResponse } from "../../src/schema/task-response";
import { hashToken } from "../../src/auth/tokens";

const base = { title: "T", context: "deep", priority: 50, duration_minutes: 60 };
const win = { days: ["tue"], start: "14:00", end: "16:00", hard: true, tz: "Australia/Sydney" };

describe("PreferredWindow.tz schema", () => {
  it("TaskCreate accepts and keeps a window tz", () => {
    const r = TaskCreate.safeParse({ ...base, preferred_windows: [win] });
    expect(r.success).toBe(true);
    expect(r.success && r.data.preferred_windows?.[0]?.tz).toBe("Australia/Sydney");
  });

  it("TaskCreate still accepts a window without tz", () => {
    const { tz: _tz, ...noTz } = win;
    const r = TaskCreate.safeParse({ ...base, preferred_windows: [noTz] });
    expect(r.success).toBe(true);
    expect(r.success && r.data.preferred_windows?.[0]).not.toHaveProperty("tz");
  });

  it("TaskCreate and TaskPatch reject an unknown zone", () => {
    expect(TaskCreate.safeParse({ ...base, preferred_windows: [{ ...win, tz: "Not/AZone" }] }).success).toBe(false);
    expect(TaskPatch.safeParse({ preferred_windows: [{ ...win, tz: "Not/AZone" }] }).success).toBe(false);
  });

  it("TaskResponse keeps a window tz", () => {
    const r = TaskResponse.partial().safeParse({ preferred_windows: [win] });
    expect(r.success && r.data.preferred_windows?.[0]?.tz).toBe("Australia/Sydney");
  });
});

describe("PreferredWindow.tz over REST", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM oauth_tokens").run();
    await env.DB.prepare("DELETE FROM oauth_clients").run();
    await env.DB.prepare("DELETE FROM tasks").run();
    await env.DB.prepare("INSERT INTO oauth_clients (id, name, type, redirect_uris, created_at) VALUES (?,?,?,?,?)")
      .bind("c1", "test", "pkce", null, "2026-01-01T00:00:00Z").run();
    const h = await hashToken("tok", env.TOKEN_HASH_PEPPER);
    await env.DB.prepare(
      "INSERT INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?,?,?,?,?,?,?)",
    ).bind(h, "c1", "scheduler:read scheduler:write", "2099-01-01T00:00:00Z", null, null, "seed@org").run();
  });

  it("POST then GET returns the window tz", async () => {
    const headers = { Authorization: "Bearer tok", "Content-Type": "application/json" };
    const r = await SELF.fetch("https://x/v1/tasks", {
      method: "POST", headers, body: JSON.stringify({ ...base, preferred_windows: [win] }),
    });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    const g = await SELF.fetch(`https://x/v1/tasks/${id}`, { headers });
    const body = (await g.json()) as { preferred_windows: Array<{ tz?: string }> };
    expect(body.preferred_windows[0]?.tz).toBe("Australia/Sydney");
  });
});
