import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";
import { defineProject } from "vitest/config";
import { kCurrentWorker } from "miniflare";

export default [
  // Existing workers project (all tests except contract and engine)
  defineWorkersProject({
    test: {
      name: "workers",
      include: ["test/**/*.test.ts"],
      exclude: [
        "test/planning/solver-contract.test.ts",
        "test/planning/resolve-window-shed-log.test.ts",
        "test/engine/**",
      ],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: {
            d1Databases: ["DB"],
            kvNamespaces: ["GOOGLE_TOKEN_CACHE"],
            r2Buckets: ["SOLVER_CAPTURE"],
            // The public read limiters (public-read/rate-limit.ts). The pool's
            // bundled wrangler 3 does not map wrangler.toml's [[ratelimits]],
            // so they are declared here at the top-level (prod) values;
            // test/public-read/wiring.test.ts fails if the two drift.
            ratelimits: {
              PUBLIC_READ_IP_LIMITER: { simple: { limit: 30, period: 60 } },
              PUBLIC_READ_TARGET_LIMITER: { simple: { limit: 120, period: 60 } },
            },
            serviceBindings: {
              SOLVER: () =>
                new Response(JSON.stringify({ error: "solver_stub_unimplemented" }), {
                  status: 501,
                  headers: { "content-type": "application/json" },
                }),
              // Card E: the fan-out leaf, bound back to this same worker's
              // EngineRpc entrypoint exactly as wrangler.toml binds it in
              // every env block. kCurrentWorker is what makes it a REAL
              // cross-isolate RPC hop under vitest, so the sub-solve wire
              // shapes (Int32Array through structured clone) are exercised by
              // the runtime rather than simulated.
              ENGINE_RPC: { name: kCurrentWorker, entrypoint: "EngineRpc" },
            },
            bindings: {
              ACCESS_TEAM_DOMAIN: "https://test.cloudflareaccess.com",
              ACCESS_POLICY_AUD: "test-aud",
              OAUTH_ISSUER: "https://scheduler.test",
              GOOGLE_OAUTH_REDIRECT_URI: "https://scheduler.test/auth/google/callback",
              GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
              GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
              TOKEN_HASH_PEPPER: "test-pepper-deadbeef",
              OPERATOR_EMAIL: "operator@example.com,second@example.com",
              CALENDAR_FEED_ENABLED: "true",
              // The engine flags in wrangler.toml's top-level [vars] track the
              // LIVE prod posture (shadow → fallback → worker), but this suite
              // is written against the container-serves baseline: resolve
              // tests mock the container's HTTP responses, and under a serving
              // engine mode the in-process engine would answer first, so the
              // mock never gets served (the 2026-08-27 fallback promotion
              // broke exactly those tests). Mode-specific tests build their
              // own env with SOLVER_ENGINE set explicitly; pin the inherited
              // value here so a prod flag flip can never change what the rest
              // of the suite exercises.
              SOLVER_ENGINE: "container",
              SOLVER_ENGINE_FANOUT: "false",
              // The public read cache (public-read/events-cache.ts) is OFF
              // for the suite: the Cache API outlives a test, and the booking
              // and poll suites rewrite a mock calendar between requests for
              // one owner and expect the next read to see it. The cache's own
              // tests (test/public-read/, test/*/public-read.test.ts) set a
              // TTL explicitly. Deployments leave it unset (60 s).
              PUBLIC_READ_CACHE_TTL_SECONDS: "0",
            },
          },
        },
      },
      setupFiles: ["./test/setup.ts"],
    },
  }),
  // Node-environment project for solver contract tests and log contracts
  defineProject({
    test: {
      name: "contract",
      include: ["test/planning/solver-contract.test.ts", "test/planning/resolve-window-shed-log.test.ts"],
      environment: "node",
    },
  }),
  // Node-environment project for the engine unit suite. The engine is pure
  // TypeScript with no cloudflare: imports, and its tests block the thread
  // with multi-second synchronous solves — under the workers pool that starves
  // the pool's keepalive on slow CI runners and kills a random in-flight test
  // with "Network connection lost". The one engine test that needs a real
  // workerd RPC hop (test/planning/engine-fanout.test.ts) stays in the
  // workers project above.
  defineProject({
    test: {
      name: "engine",
      include: ["test/engine/**/*.test.ts"],
      environment: "node",
      // Heavy solves legitimately run for tens of seconds on CI hardware.
      testTimeout: 120_000,
    },
  }),
];
