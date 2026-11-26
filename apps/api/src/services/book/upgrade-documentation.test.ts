import { expect, it } from "vitest";
import { splitWhenToUse } from "./upgrade-documentation.js";
it("splits at a sentence naming another metric and preserves the complete text", () => {
  const old =
    "Use for basket size. For volume, use Orders. Read both together.";
  expect(splitWhenToUse(old, ["Orders"])).toEqual({
    use_for: "Use for basket size.",
    dont_use_for: "For volume, use Orders. Read both together.",
  });
  expect(splitWhenToUse(old, [])).toEqual({ use_for: old, dont_use_for: "" });
});
