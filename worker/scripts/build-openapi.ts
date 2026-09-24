import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeOpenApiDocument } from "../src/schema/openapi-document.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const outDir = join(__dirname, "../../schema");
const outPath = join(outDir, "openapi.json");

mkdirSync(outDir, { recursive: true });
// Document construction lives in src/schema/openapi-document.ts so that the
// drift test (test/openapi.test.ts) builds it identically to this script.
writeFileSync(outPath, serializeOpenApiDocument());
console.log(`Generated ${outPath}`);
