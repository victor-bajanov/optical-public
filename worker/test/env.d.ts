/// <reference types="@cloudflare/vitest-pool-workers" />

import type { Env } from "../src/env";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
