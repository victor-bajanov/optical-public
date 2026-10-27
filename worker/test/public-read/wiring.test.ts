/// <reference types="vite/client" />
// The public read cache and limiter are only safe where they are wired: the
// cache on the three anonymous/capability availability reads and nowhere
// else (the claim's re-verify, poll booking, resolve, commit and every
// authenticated path read live), and the limiter bindings in every
// deployable env block (bindings do not inherit into [env.*]).
import { describe, it, expect } from "vitest";

const sources = import.meta.glob("../../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const tomlFiles = import.meta.glob("../../wrangler.toml", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const workspaceFiles = import.meta.glob("../../vitest.workspace.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function vitestWorkspace(): string {
  const entry = Object.values(workspaceFiles)[0];
  if (entry === undefined) throw new Error("vitest.workspace.ts not found via import.meta.glob");
  return entry;
}

function wranglerToml(): string {
  const entry = Object.values(tomlFiles)[0];
  if (entry === undefined) throw new Error("wrangler.toml not found via import.meta.glob");
  return entry;
}

describe("public read cache call sites", () => {
  it("only the public booking and poll routes wrap a reader in the cache", () => {
    const users = Object.entries(sources)
      .filter(([path]) => !path.endsWith("/public-read/events-cache.ts"))
      .filter(([, text]) => /\bcachedEventsReader\s*\(/.test(text))
      .map(([path]) => path.replace(/^.*\/src\//, "src/"))
      .sort();
    expect(users).toEqual(["src/booking/route.ts", "src/polls/route.ts"]);
  });

  it("the booking claim handler never touches the cache", () => {
    const route = Object.entries(sources).find(([p]) => p.endsWith("/src/booking/route.ts"))![1];
    const claim = route.slice(route.indexOf('app.post("/book/:slug"'));
    expect(claim.length).toBeGreaterThan(0);
    expect(claim).not.toMatch(/publicEventsReader|cachedEventsReader/);
  });

  it("the poll booking engine and the authenticated poll handlers never touch the cache", () => {
    for (const file of ["/src/polls/booking.ts", "/src/handlers/polls.ts"]) {
      const text = Object.entries(sources).find(([p]) => p.endsWith(file))![1];
      expect(text, file).not.toMatch(/public-read\/events-cache/);
    }
  });
});

// Splits the toml on table headers and keeps each section's raw body.
function sections(toml: string): Array<{ header: string; body: string }> {
  const out: Array<{ header: string; body: string }> = [{ header: "", body: "" }];
  for (const line of toml.split("\n")) {
    const h = line.match(/^\s*(\[\[?[^\]]+\]\]?)\s*(#.*)?$/);
    if (h) {
      out.push({ header: h[1]!, body: "" });
      continue;
    }
    out[out.length - 1]!.body += `${line}\n`;
  }
  return out;
}

interface Limiter {
  env: string;
  name: string;
  namespaceId: string;
  limit: number;
  period: number;
}

function limiters(toml: string): Limiter[] {
  return sections(toml)
    .map((s) => ({ s, m: s.header.match(/^\[\[(?:env\.([a-z0-9_-]+)\.)?ratelimits\]\]$/) }))
    .filter(({ m }) => m !== null)
    .map(({ s, m }) => ({
      env: m![1] ?? "",
      name: s.body.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? "",
      namespaceId: s.body.match(/^\s*namespace_id\s*=\s*"([^"]+)"/m)?.[1] ?? "",
      limit: Number(s.body.match(/simple\s*=\s*\{[^}]*\blimit\s*=\s*(\d+)/)?.[1]),
      period: Number(s.body.match(/simple\s*=\s*\{[^}]*\bperiod\s*=\s*(\d+)/)?.[1]),
    }));
}

describe("public read limiter bindings in wrangler.toml", () => {
  const toml = wranglerToml();
  const envs = ["", ...[...toml.matchAll(/^\[env\.([a-z0-9_-]+)\]\s*$/gm)].map((m) => m[1]!)];
  const all = limiters(toml);

  it("finds the env blocks", () => {
    expect(envs).toContain("");
    expect(envs).toContain("dev");
  });

  for (const env of envs) {
    const label = env === "" ? "top level (prod)" : `[env.${env}]`;
    it(`${label} declares both limiters at the documented defaults`, () => {
      const mine = all.filter((l) => l.env === env);
      expect(mine.map((l) => l.name).sort()).toEqual(["PUBLIC_READ_IP_LIMITER", "PUBLIC_READ_TARGET_LIMITER"]);
      const ip = mine.find((l) => l.name === "PUBLIC_READ_IP_LIMITER")!;
      const target = mine.find((l) => l.name === "PUBLIC_READ_TARGET_LIMITER")!;
      expect([ip.limit, ip.period]).toEqual([30, 60]);
      expect([target.limit, target.period]).toEqual([120, 60]);
    });
  }

  it("declares no unsafe bindings (wrangler warns on every deploy for them)", () => {
    expect(sections(toml).map((s) => s.header).filter((h) => /unsafe/.test(h))).toEqual([]);
    expect(toml).not.toMatch(/^\s*unsafe\s*=/m);
  });

  it("the vitest pool's miniflare limiters match the top-level (prod) declaration", () => {
    // The pool's bundled wrangler 3 does not read [[ratelimits]], so
    // vitest.workspace.ts declares the same two bindings by hand.
    const top = all.filter((l) => l.env === "");
    expect(top).toHaveLength(2);
    for (const l of top) {
      const m = vitestWorkspace().match(
        new RegExp(`${l.name}:\\s*\\{\\s*simple:\\s*\\{\\s*limit:\\s*(\\d+),\\s*period:\\s*(\\d+)`),
      );
      expect(m, `${l.name} missing from vitest.workspace.ts miniflare ratelimits`).not.toBeNull();
      expect([Number(m![1]), Number(m![2])]).toEqual([l.limit, l.period]);
    }
  });

  it("every limiter has its own positive-integer namespace_id, so no two deployments share counters", () => {
    const ids = all.map((l) => l.namespaceId);
    for (const id of ids) expect(id).toMatch(/^[1-9]\d*$/);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
