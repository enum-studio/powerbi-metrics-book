import { readFileSync } from "node:fs";

// Read rather than imported: package.json sits outside src, which tsc keeps
// as the root of the build. src and dist are at the same depth, so the path
// holds for both.
const manifest: unknown = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
if (
  typeof manifest !== "object" ||
  manifest === null ||
  !("version" in manifest) ||
  typeof manifest.version !== "string"
) {
  throw new Error("apps/api/package.json has no version");
}

export const VERSION: string = manifest.version;
