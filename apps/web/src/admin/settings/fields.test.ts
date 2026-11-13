import { describe, expect, it } from "vitest";
import { type FieldSpec, fromDraft, toDraft } from "./fields";

const spec = (kind: "text" | "number" | "list" | "include" | "cron" | "bool") =>
  ({ key: `k.${kind}`, label: kind, kind }) satisfies FieldSpec;

describe("toDraft", () => {
  it("shows null as empty, a number as text, and a list one id to a line", () => {
    expect(toDraft(spec("text"), null)).toBe("");
    expect(toDraft(spec("number"), 20)).toBe("20");
    expect(toDraft(spec("list"), ["a", "b"])).toBe("a\nb");
    expect(toDraft(spec("include"), "all")).toBe("all");
    expect(toDraft(spec("include"), ["a"])).toBe("a");
    expect(toDraft(spec("bool"), false)).toBe(false);
  });

  it("refuses a value of another shape, which is a fault in the api", () => {
    expect(() => toDraft(spec("bool"), "yes")).toThrow(/cannot show/);
    expect(() => toDraft(spec("list"), "a")).toThrow(/cannot show/);
    expect(() => toDraft(spec("text"), { a: 1 })).toThrow(/cannot show/);
  });
});

describe("fromDraft", () => {
  it("turns text back into the value the api takes", () => {
    expect(fromDraft(spec("number"), " 40 ")).toBe(40);
    expect(fromDraft(spec("number"), "")).toBeNull();
    expect(fromDraft(spec("text"), "  ")).toBeNull();
    expect(fromDraft(spec("text"), " x ")).toBe("x");
    expect(fromDraft(spec("list"), "a\n b,\n\nc")).toEqual(["a", "b", "c"]);
    expect(fromDraft(spec("include"), " ALL ")).toBe("all");
    expect(fromDraft(spec("include"), "a\nb")).toEqual(["a", "b"]);
    expect(fromDraft(spec("cron"), " 0 * * * * ")).toBe("0 * * * *");
    expect(fromDraft(spec("bool"), true)).toBe(true);
  });

  it("sends a number that is not one as typed, so the api says why", () => {
    expect(fromDraft(spec("number"), "twelve")).toBe("twelve");
    expect(fromDraft(spec("number"), "1.5")).toBe("1.5");
  });

  it("sends a provider's empty issuer as null", () => {
    const providers = fromDraft(
      { key: "sign_in.providers", label: "p", kind: "providers" },
      [
        { id: "g", kind: "google", label: "G", client_id: "c", issuer: "" },
        {
          id: "o",
          kind: "oidc",
          label: "O",
          client_id: "c",
          issuer: " https://o.test ",
        },
      ],
    );
    expect(providers).toMatchObject([
      { issuer: null },
      { issuer: "https://o.test" },
    ]);
  });
});
