import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { authRefusal, refusalSentence } from "./refusals";

describe("refusalSentence", () => {
  it("explains how an admin can supply a missing Microsoft email", () => {
    expect(refusalSentence("email_not_found")).toBe(
      "Microsoft sent no email address for this account. An admin can add the email optional claim in the app registration's Token configuration.",
    );
  });

  it("says the page's own sentence for an error the api sends", () => {
    expect(refusalSentence("not_assigned")).toBe(
      "You do not have access yet. Ask an admin of Power BI Metrics Book to invite you.",
    );
    expect(refusalSentence("NOT_IN_TENANT")).toBe(
      "This Microsoft account is not in the company's Power BI tenant.",
    );
  });

  it("says one generic sentence for any other error", () => {
    for (const error of [
      "call_support",
      "constructor",
      "__proto__",
      "",
      "invalid_email_or_password",
    ])
      expect(refusalSentence(error)).toBe(
        "Sign-in did not finish. Try again, or ask one of this site's admins.",
      );
  });
});

it("uses the same sentence for any wrong email or password", () => {
  for (const message of ["Unknown email", "Wrong password"])
    expect(authRefusal(new ApiError(401, "unknown", message), true)).toBe(
      "The email or password is wrong; try again or reset your password.",
    );
});

it("names the brand and explains deactivation", () => {
  expect(refusalSentence("not_assigned", "Sample company")).toBe(
    "You do not have access yet. Ask an admin of Sample company to invite you.",
  );
  expect(refusalSentence("deactivated")).toBe(
    "An admin has deactivated your account. Ask an admin to reactivate it.",
  );
});
