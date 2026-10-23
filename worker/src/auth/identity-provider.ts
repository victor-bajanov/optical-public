export interface UpstreamTokens {
  refreshToken?: string;
  accessToken: string;
  expiresIn: number;
  scope: string;
  /** OIDC id_token from the token endpoint, when the IdP issues one. Microsoft
   *  derives identity from its claims (see MicrosoftIdentityProvider). */
  idToken?: string;
}

export interface IdentityProvider {
  readonly scopes: string[];
  authorizeUrl(p: { state: string; redirectUri: string }): string;
  exchangeCode(code: string, redirectUri: string): Promise<UpstreamTokens>;
  /** Resolve the signed-in identity. `opts.idToken` is the id_token returned by
   *  exchangeCode, when any; providers that key identity on it (Microsoft) MUST
   *  be given it, others (Google) ignore it.
   *
   *  `providerSubject` is the IdP's immutable subject identifier — Microsoft's
   *  `tid:oid`, Google userinfo's `id` — used to anchor a user's internal
   *  `subject` across email changes (identity-store.ts's resolveSubject). It
   *  is NOT the same as the `email` returned alongside it, which remains
   *  mutable and is used only for display/admission. */
  fetchIdentity(accessToken: string, opts?: { idToken?: string }): Promise<{ email: string; providerSubject: string }>;
  refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    expiresIn: number;
    /** Rotated refresh token (Microsoft rotates on EVERY refresh; Google never
     *  returns one). When present the caller MUST persist it. */
    refreshToken?: string;
  }>;
  /** Revoke this app's grant upstream so the provider stops honouring it.
   *  `token` may be a refresh token (offboard) or an access token (the OAuth
   *  callback refusing a fresh grant before any refresh token is stored);
   *  Google's revoke endpoint accepts either and revokes the whole grant.
   *  Resolves when the grant is gone (an already-revoked/expired token counts
   *  as gone); rejects on any other failure. Implementations MUST NOT put the
   *  token in a thrown error. Microsoft has no per-app revoke for a delegated
   *  grant, so its implementation is a documented no-op. */
  revokeGrant(token: string): Promise<void>;
}

// Test seam: lets tests swap in a MockIdentityProvider (mirrors
// auth-access.ts __setVerifierForTests).
let injected: IdentityProvider | null = null;
export function __setIdentityProviderForTests(p: IdentityProvider | null): void {
  injected = p;
}
export function injectedIdentityProvider(): IdentityProvider | null {
  return injected;
}
