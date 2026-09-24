// Shared HTML-escaping helpers for the server-rendered pages and emails
// (booking page, accept/confirm/notice pages, diff calendar HTML, Gmail diff
// HTML). These previously existed as four independently hand-rolled copies
// that had already diverged — worker/src/web/accept-page.ts's escAttr, in
// particular, escaped only `&` and `"`, silently dropping `<` and `>` from a
// double-quoted attribute value. There is exactly one escaping policy now:
// escape the full `& < > " '` set, in both text and attribute contexts, so
// no call site can end up weaker than any other by picking the "wrong" one.

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeAll(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] as string);
}

/** Element-content (text node) context. */
export function escText(s: string): string {
  return escapeAll(s);
}

/** Quoted-attribute context (single or double quotes). */
export function escAttr(s: string): string {
  return escapeAll(s);
}
