import { escAttr, escText } from "../util/html-escape";
import { SIGN_IN_PAGE_STYLE } from "./provider-chooser-page";

// Terminal page for a sign-in the callback refuses AFTER the IdP consent (the
// grant has been revoked best-effort when UPSTREAM_REVOKE_ENABLED, and nothing was stored). Rendered
// in place of a redirect to the client: the client can do nothing useful with
// the refusal, and the person needs to read why. Plain HTML, no client JS,
// styled like the provider chooser.
//
//  - not_invited (O4): the membership gate refused the identity.
//  - missing_scopes (O6): the user unticked a permission Optical needs.
//  - account_bound (REFUSE_PROVIDER_REBIND, trial): the email already belongs
//    to an account bound to a different IdP identity (another Google or
//    Microsoft account). Never says which provider the account is bound to.
//
// Never names the operator: who to ask comes from INVITE_CONTACT (free text,
// escaped). With no contact configured the ask sentence is omitted.

export type SignInRefusal =
  | {
      kind: "not_invited";
      /** INVITE_CONTACT. Blank/unset omits the "Ask … for an invite." line. */
      contact?: string;
      /** DEPLOYMENT_LABEL badge beside the wordmark. */
      label?: string;
    }
  | {
      kind: "missing_scopes";
      /** Human-readable names of the permissions that were not granted. */
      missing: string[];
      /** Same-origin path to restart sign-in (must start with a single "/"). */
      retryUrl?: string;
      label?: string;
    }
  | {
      kind: "account_bound";
      /** INVITE_CONTACT. Blank/unset omits the "ask … for help" clause. */
      contact?: string;
      label?: string;
    };

const EXTRA_STYLE = `ul.missing{margin:0 0 20px;padding-left:20px}ul.missing li{margin:0 0 4px}`;

/** Only a same-origin absolute path is linked; anything else is dropped.
 *  Browsers normalise "\" to "/" and strip tab/newline inside URLs, so
 *  "/\evil.com" or "/\t/evil.com" would become protocol-relative: any
 *  backslash or control character rejects the value outright. */
function safePath(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(v)) return null;
  return /^\/(?![/\\])/.test(v) ? v : null;
}

function body(r: SignInRefusal): string {
  if (r.kind === "not_invited") {
    const contact = (r.contact ?? "").trim();
    return (
      `<h1>Invitation only</h1>` +
      `<p class="lead">Optical is invitation-only, and this account hasn&rsquo;t been invited.` +
      (contact ? ` Ask ${escText(contact)} for an invite.` : "") +
      `</p>` +
      `<p class="fine">Nothing from this sign-in was stored.</p>`
    );
  }
  if (r.kind === "account_bound") {
    const contact = (r.contact ?? "").trim();
    return (
      `<h1>Account already linked</h1>` +
      `<p class="lead">This email address is already linked to a different Google or Microsoft account on Optical. ` +
      `Sign in with the account you used first` +
      (contact ? `, or ask ${escText(contact)} for help` : "") +
      `.</p>` +
      `<p class="fine">Nothing from this sign-in was stored.</p>`
    );
  }
  const retry = safePath(r.retryUrl);
  return (
    `<h1>Permissions needed</h1>` +
    `<p class="lead">Optical needs all of the permissions it asked for. These weren&rsquo;t granted:</p>` +
    `<ul class="missing">${r.missing.map((m) => `<li>${escText(m)}</li>`).join("")}</ul>` +
    (retry ? `<a class="btn" href="${escAttr(retry)}">Try again</a>` : "") +
    `<p class="fine">Nothing from this sign-in was stored.</p>`
  );
}

/** Full HTML document for a refused sign-in. All dynamic text is escaped. */
export function renderSignInRefusedPage(r: SignInRefusal): string {
  const label = (r.label ?? "").trim();
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Sign-in refused &middot; Optical</title><style>${SIGN_IN_PAGE_STYLE}${EXTRA_STYLE}</style></head><body>` +
    `<main class="card">` +
    `<div class="brand"><span class="dot"></span><span>Optical</span>` +
    (label ? `<span class="badge">${escText(label)}</span>` : "") +
    `</div>` +
    body(r) +
    `</main></body></html>`
  );
}
