import { v1 } from "../v1";
import { API_OVERVIEW } from "./descriptions";

/** The v1 sub-app is mounted under /v1 in worker/src/index.ts, but the OpenAPI
 *  generator only sees the sub-app's local paths — so every paths key is
 *  prefixed here, making the document match the live routes a client hits. */
const V1_MOUNT_PREFIX = "/v1";

/** THE published API document, built from the live Zod route definitions.
 *
 *  Shared by `scripts/build-openapi.ts` (which writes it to schema/openapi.json)
 *  and `test/openapi.test.ts` (which asserts the committed file still matches).
 *  Both must build it the same way or the drift test is meaningless, so the
 *  construction lives here rather than being duplicated in the script. */
export function buildOpenApiDocument(): Record<string, unknown> {
  const doc = v1.getOpenAPIDocument({
    openapi: "3.1.0",
    info: {
      title: "Weekly Scheduling Assistant",
      version: "0.1.0",
      description: API_OVERVIEW,
    },
  });

  const prefixedPaths: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(doc.paths ?? {})) {
    prefixedPaths[`${V1_MOUNT_PREFIX}${path}`] = value;
  }
  doc.paths = prefixedPaths as typeof doc.paths;
  return doc as unknown as Record<string, unknown>;
}

/** The exact bytes that belong in schema/openapi.json. */
export function serializeOpenApiDocument(): string {
  return JSON.stringify(buildOpenApiDocument(), null, 2) + "\n";
}
