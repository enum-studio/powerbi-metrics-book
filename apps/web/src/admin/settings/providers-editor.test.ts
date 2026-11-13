import { describe, expect, it } from "vitest";
import { uriPurpose } from "./providers-editor";

describe("uriPurpose", () => {
  it("labels Microsoft's two redirect URIs by what each is for", () => {
    expect(
      uriPurpose("https://book.example.com/api/auth/callback/microsoft").label,
    ).toBe("Sign-in redirect URI");
    expect(
      uriPurpose("https://book.example.com/api/v1/powerbi/callback").label,
    ).toBe("Power BI connection redirect URI");
  });

  it("keeps the plain label for another provider's", () => {
    expect(
      uriPurpose("https://book.example.com/api/auth/callback/google").label,
    ).toBe("Redirect URI");
  });
});
