import { describe, expect, it } from "vitest";
import { STEPS } from "./steps.js";

describe("setup steps", () => {
  it("link to pages under the docs site's set-up part", () => {
    for (const step of STEPS)
      expect(step.docs_path).toMatch(/^\/docs\/set-up\/[a-z-]+\/$/);
  });
});
