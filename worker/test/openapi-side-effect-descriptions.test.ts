import { describe, it, expect } from "vitest";
import { v1 } from "../src/v1";

// O9.7: these op descriptions are published (schema/openapi.json) and are what
// an MCP-driven agent reads to decide whether an op is safe to call unattended.
// The agentic-action inventory (internal design notes
// §1 rows 1, 11, 13) found three of them understating their side effects.
const doc: any = v1.getOpenAPIDocument({
  openapi: "3.1.0",
  info: { title: "t", version: "0" },
});

function opById(id: string): any {
  for (const ops of Object.values<any>(doc.paths)) {
    for (const op of Object.values<any>(ops)) if (op?.operationId === id) return op;
  }
  throw new Error(`no op ${id}`);
}

describe("side-effect disclosure in op descriptions", () => {
  it("getCalendarAccessToken says it hands the raw IdP credential to the caller, for either provider", () => {
    const op = opById("getCalendarAccessToken");
    const text = `${op.summary} ${op.description}`;
    // Not Google-only: Microsoft users get a Graph token from the same op.
    expect(text).toMatch(/Microsoft/);
    expect(text).toMatch(/Google/);
    expect(text).toMatch(/raw/i);
    // What the token can do outside Optical, spelled out.
    expect(op.description).toMatch(/send (e-?mail|mail)/i);
    expect(op.description).toMatch(/gmail\.send/);
    expect(op.description).toMatch(/Mail\.Send/);
    expect(op.description).toMatch(/Calendars\.ReadWrite/);
    expect(op.description).toMatch(/calendar\.events/);
    // The 200 field must not claim Google-only either.
    const field =
      op.responses["200"].content["application/json"].schema.properties.access_token.description;
    expect(field).toMatch(/Microsoft/);
  });

  it("commit says it notifies attendees of moved owned meetings and writes to the calendar", () => {
    const op = opById("commit");
    const text = `${op.summary} ${op.description}`;
    expect(text).not.toMatch(/to Google Calendar/); // provider-neutral (Outlook too)
    expect(op.description).toMatch(/attendees/i);
    expect(op.description).toMatch(/notif/i);
    expect(op.description).toMatch(/delet/i);
    expect(op.description).toMatch(/no confirmation|without (a |any )?(human )?confirm/i);
  });

  it("resolve does not claim it leaves the calendar untouched, and names what it writes", () => {
    const op = opById("resolve");
    expect(op.description).not.toMatch(/Does not modify the calendar/);
    // It tags newly imported owned meetings with a private extended property.
    expect(op.description).toMatch(/extended property/i);
    // It never moves events or notifies anyone; commit/accept does.
    expect(op.description).toMatch(/never (moves|creates)/i);
    expect(op.description).toMatch(/notif/i);
    // It persists the proposed plan and supersedes older pending plans for the week.
    expect(op.description).toMatch(/supersede/i);
  });
});
