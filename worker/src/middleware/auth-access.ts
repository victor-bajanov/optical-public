import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Env } from "../env";

export interface AccessPayload extends JWTPayload {
  email?: string;
  type?: string;
}

type Verifier = (token: string, teamDomain: string, aud: string) => Promise<{ payload: AccessPayload }>;

let injected: Verifier | null = null;
export function __setVerifierForTests(v: Verifier | null): void {
  injected = v;
}

const defaultVerifier: Verifier = async (token, teamDomain, aud) => {
  const jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
  const { payload } = await jwtVerify(token, jwks, { issuer: teamDomain, audience: aud });
  return { payload: payload as AccessPayload };
};

type Vars = { accessEmail: string; accessPayload: AccessPayload };

export const requireAccess: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const token = c.req.header("cf-access-jwt-assertion");
  if (!token) return c.json({ error: "missing_access_jwt" }, 401);
  const verify = injected ?? defaultVerifier;
  try {
    const { payload } = await verify(token, c.env.ACCESS_TEAM_DOMAIN, c.env.ACCESS_POLICY_AUD);
    c.set("accessPayload", payload);
    c.set("accessEmail", payload.email ?? "");
    await next();
  } catch {
    return c.json({ error: "invalid_access_jwt" }, 401);
  }
};
