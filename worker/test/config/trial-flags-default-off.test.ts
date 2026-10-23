/// <reference types="vite/client" />
// Hosted-trial card S0: pins the trial-only config surface off everywhere it
// isn't wanted. SELF_SERVE_DELETE_ENABLED and SYSTEM_MAIL_ENABLED must be an
// explicit "false" in every non-trial env (named envs inherit no vars, so absence
// would be correct today but invisible), and the trial's legal URLs must never
// leak into a non-trial block — PRIVACY_URL also switches the /authorize
// chooser into disclosure mode, so it is trial-only by construction.
import { describe, it, expect } from "vitest";
import type { Env } from "../../src/env";

const files = import.meta.glob("../../wrangler.toml", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function wranglerToml(): string {
  const entry = Object.values(files)[0];
  if (entry === undefined) throw new Error("wrangler.toml not found via import.meta.glob");
  return entry;
}

// Not a general TOML parser — splits on table headers (`[x]` / `[[x]]`) and
// collects `KEY = "value"` lines under each. Good enough for wrangler.toml's
// flat string vars.
type Section = { header: string; vars: Map<string, string> };
function sections(toml: string): Section[] {
  const out: Section[] = [{ header: "", vars: new Map() }];
  for (const line of toml.split("\n")) {
    const h = line.match(/^\s*(\[\[?[^\]]+\]\]?)\s*(#.*)?$/);
    if (h) {
      out.push({ header: h[1]!, vars: new Map() });
      continue;
    }
    const kv = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"/);
    if (kv) out[out.length - 1]!.vars.set(kv[1]!, kv[2]!);
  }
  return out;
}

function varsOf(header: string, toml: string): Map<string, string> {
  const s = sections(toml).find((x) => x.header === header);
  if (!s) throw new Error(`section ${header} not found in wrangler.toml`);
  return s.vars;
}

// Compile-time pin: every S0 member exists on Env, optional, string-typed.
// A missing, renamed or required member fails `npm run typecheck`.
type S0Member =
  | "PRIVACY_URL"
  | "TERMS_URL"
  | "DEPLOYMENT_LABEL"
  | "INVITE_CONTACT"
  | "SELF_SERVE_DELETE_ENABLED"
  | "SYSTEM_MAIL_ENABLED"
  | "SYSTEM_MAIL_FROM"
  | "SYSTEM_MAIL_API_KEY";
const _s0Optional: Pick<Env, S0Member> = {};
const _s0Members: Required<Pick<Env, S0Member>> = {
  PRIVACY_URL: "",
  TERMS_URL: "",
  DEPLOYMENT_LABEL: "",
  INVITE_CONTACT: "",
  SELF_SERVE_DELETE_ENABLED: "",
  SYSTEM_MAIL_ENABLED: "",
  SYSTEM_MAIL_FROM: "",
  SYSTEM_MAIL_API_KEY: "",
};
void _s0Members;
void _s0Optional;

// Compile-time pin: every phase-2 S1 member exists on Env, optional, string-typed.
type S1Member =
  | "AGENT_CONFIRM_CLIENT_IDS"
  | "OUTBOUND_MAIL_DAILY_CAP"
  | "REFUSE_PROVIDER_REBIND"
  | "REQUIRE_EXACT_PROVIDER_SCOPES"
  | "DELETED_ACCOUNT_RETENTION_DAYS";
const _s1Optional: Pick<Env, S1Member> = {};
const _s1Members: Required<Pick<Env, S1Member>> = {
  AGENT_CONFIRM_CLIENT_IDS: "",
  OUTBOUND_MAIL_DAILY_CAP: "",
  REFUSE_PROVIDER_REBIND: "",
  REQUIRE_EXACT_PROVIDER_SCOPES: "",
  DELETED_ACCOUNT_RETENTION_DAYS: "",
};
void _s1Members;
void _s1Optional;

// Every non-trial vars block. The public tree has prod + dev only.
const NON_TRIAL_VARS = ["[vars]", "[env.dev.vars]"];

describe("hosted-trial flags default off outside the trial env", () => {
  const toml = wranglerToml();

  for (const header of NON_TRIAL_VARS) {
    it(`${header} pins SELF_SERVE_DELETE_ENABLED and SYSTEM_MAIL_ENABLED to "false"`, () => {
      const vars = varsOf(header, toml);
      expect(vars.get("SELF_SERVE_DELETE_ENABLED")).toBe("false");
      expect(vars.get("SYSTEM_MAIL_ENABLED")).toBe("false");
    });
  }

  for (const header of NON_TRIAL_VARS) {
    it(`${header} keeps deactivated users rows indefinitely and leaves the trial-only gates unset`, () => {
      const vars = varsOf(header, toml);
      // "0" = keep indefinitely; explicit so the posture is visible.
      expect(vars.get("DELETED_ACCOUNT_RETENTION_DAYS")).toBe("0");
      // Absent = off / no client gated; also absent: the mail cap and
      // exact-scopes requirement, which take their code defaults.
      for (const k of ["REFUSE_PROVIDER_REBIND", "AGENT_CONFIRM_CLIENT_IDS", "OUTBOUND_MAIL_DAILY_CAP", "REQUIRE_EXACT_PROVIDER_SCOPES"]) {
        expect(vars.has(k), k).toBe(false);
      }
    });
  }

  it("PRIVACY_URL and TERMS_URL appear only under [env.trial*] blocks", () => {
    const offenders = sections(toml)
      .filter((s) => !/^\[\[?env\.trial\b/.test(s.header))
      .flatMap((s) =>
        ["PRIVACY_URL", "TERMS_URL"]
          .filter((k) => s.vars.has(k))
          .map((k) => `${k} under ${s.header || "(top of file)"}`),
      );
    expect(offenders).toEqual([]);
  });
});
