import { describe, expect, it } from "vitest";
import { microsoftClaims } from "./sign-in.js";
const expected = {
  tenant_id: "tenant",
  app_client_id: "app",
  authority: "https://login.example.com",
  google_id: null,
};
const token = {
  tid: "tenant",
  aud: "app",
  oid: "person",
  iss: "https://login.example.com/tenant/v2.0",
  email: "invited@untrusted.example",
};
describe("Microsoft email domain verification", () => {
  it.each([false, undefined, "true"])(
    "does not trust email with xms_edov %s and no UPN",
    (xms_edov) => {
      expect(
        microsoftClaims({ ...token, xms_edov }, expected)?.domain_verified,
      ).toBe(false);
    },
  );
  it("trusts a verified email or a usable UPN", () => {
    expect(
      microsoftClaims({ ...token, xms_edov: true }, expected)?.domain_verified,
    ).toBe(true);
    expect(
      microsoftClaims(
        { ...token, preferred_username: "person@tenant.example" },
        expected,
      )?.domain_verified,
    ).toBe(true);
  });
});
