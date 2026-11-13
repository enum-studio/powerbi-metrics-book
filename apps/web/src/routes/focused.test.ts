import { expect, it } from "vitest";
import { deviceRoute } from "./device";
import { forgotPasswordRoute } from "./forgot-password";
import { oauthConsentRoute } from "./oauth-consent";
import { setPasswordRoute } from "./set-password";
import { setupRoute } from "./setup";
import { signInRoute } from "./sign-in";

// The shell keeps the left lanes and search off a screen with this flag, so a
// consent or the setup never offers a way to something else.
it.each([
  ["sign-in", signInRoute],
  ["forgot-password", forgotPasswordRoute],
  ["set-password", setPasswordRoute],
  ["oauth/consent", oauthConsentRoute],
  ["device", deviceRoute],
  ["setup", setupRoute],
])("/%s is a screen with one job", (_, route) => {
  expect(route.options.staticData?.focused).toBe(true);
});
