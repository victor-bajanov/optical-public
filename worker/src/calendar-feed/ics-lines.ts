/**
 * Unfold RFC 5545 continuation lines. Lines starting with a space or tab are
 * continuations of the previous line.
 */
export function unfoldLines(input: string): string[] {
  if (!input) return [];
  const rawLines = input.replace(/\r\n/g, "\n").split("\n");
  const result: string[] = [];
  for (const raw of rawLines) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && result.length > 0) {
      result[result.length - 1] += raw.slice(1);
    } else if (raw.length > 0) {
      result.push(raw);
    }
  }
  return result;
}

/**
 * Fold a single logical line to comply with the RFC 5545 75-octet limit,
 * never splitting a multi-byte UTF-8 character.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(line);
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let offset = 0;
  let maxBytes = 75;
  while (offset < bytes.length) {
    let end = Math.min(offset + maxBytes, bytes.length);
    while (end < bytes.length && end > offset && (bytes[end]! & 0xc0) === 0x80) {
      end--;
    }
    const chunk = new TextDecoder().decode(bytes.slice(offset, end));
    parts.push(chunk);
    offset = end;
    maxBytes = 74;
  }
  return parts.join("\r\n ");
}

/** RFC 5545 §3.3.11 TEXT escaping: backslash first, then ; , and newlines. */
export function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}
