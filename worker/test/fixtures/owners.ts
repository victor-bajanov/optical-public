import { env } from "cloudflare:test";
import { hashToken } from "../../src/auth/tokens";

export interface SeededUser { token: string; subject: string; headers: Record<string, string>; }

// Seed N users: subjects user0@org … user{n-1}@org, tokens tok-0 … tok-{n-1}.
export async function seedUsers(n: number): Promise<SeededUser[]> {
  await env.DB.prepare("DELETE FROM oauth_tokens").run();
  await env.DB.prepare("DELETE FROM oauth_clients").run();
  await env.DB.prepare("DELETE FROM tasks").run();
  await env.DB.prepare("DELETE FROM task_templates").run();
  await env.DB.prepare("DELETE FROM projects").run();
  await env.DB.prepare(
    "INSERT INTO oauth_clients (id, name, type, redirect_uris, created_at) VALUES (?,?,?,?,?)",
  ).bind("c1", "test", "pkce", null, "2026-01-01T00:00:00Z").run();
  const out: SeededUser[] = [];
  for (let i = 0; i < n; i++) {
    const token = `tok-${i}`, subject = `user${i}@org`;
    const h = await hashToken(token, env.TOKEN_HASH_PEPPER);
    await env.DB.prepare(
      "INSERT INTO oauth_tokens (hashed_token, client_id, scopes, expires_at, refresh_of, revoked_at, subject) VALUES (?,?,?,?,?,?,?)",
    ).bind(h, "c1", "scheduler:read scheduler:write", "2099-01-01T00:00:00Z", null, null, subject).run();
    out.push({ token, subject, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  }
  return out;
}

// Seeds one oauth_client and two bearer tokens bound to distinct subjects.
// Reused by later plans (resolve/webhook isolation) — keep generic.
export async function seedTwoUsers(): Promise<{ a: SeededUser; b: SeededUser }> {
  const users = await seedUsers(2);
  const a = users[0], b = users[1];
  if (!a || !b) throw new Error(`seedTwoUsers expected 2 users, got ${users.length}`);
  return { a, b };
}
