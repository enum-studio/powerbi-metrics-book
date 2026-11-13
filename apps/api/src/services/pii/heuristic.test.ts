import { describe, expect, it } from "vitest";
import { suspectedPii } from "./heuristic.js";

describe("the PII name heuristic", () => {
  it.each([
    ["Email", "email"],
    ["Customer Email", "email"],
    ["phone_number", "phone_number"],
    ["DateOfBirth", "date_of_birth"],
    ["IPAddress", "ip_address"],
    ["Billing Street", "street"],
    ["SSN", "ssn"],
    ["CustomerFirstName", "first_name"],
  ])("matches %s", (name, matched) => {
    expect(suspectedPii(name)).toBe(matched);
  });

  it.each([
    "is_email_verified",
    "HasPhone",
    "email_domain",
    "Phone Type",
    "address_count",
    "Name",
    "City",
    "country_code",
    "Emailer",
    "",
  ])("does not match '%s'", (name) => {
    expect(suspectedPii(name)).toBeNull();
  });
});
