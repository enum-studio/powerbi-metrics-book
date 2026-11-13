import { describe, expect, it } from "vitest";
import { excerpt } from "./text.js";

describe("excerpt", () => {
  it.each([
    ["", 5, "", false],
    ["short", 8, "short", false],
    ["exact", 5, "exact", false],
    ["one two three", 8, "one two…", true],
    ["one two three", 7, "one…", true],
    ["one \t\n two three", 8, "one…", true],
    ["unbrokenword", 5, "unbr…", true],
    ["😀😀😀", 3, "😀😀😀", false],
    ["😀😀😀😀", 3, "😀😀…", true],
    ["😀 one two", 6, "😀 one…", true],
    ["long", 1, "…", true],
  ])("cuts %j within %i code points", (text, max, expected, truncated) => {
    expect(excerpt(text, max)).toEqual({ text: expected, truncated });
    expect(Array.from(excerpt(text, max).text).length).toBeLessThanOrEqual(max);
  });
});
