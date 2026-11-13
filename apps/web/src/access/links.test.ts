import { describe, expect, it } from "vitest";
import { safeNext, shownRedirect, signInTarget } from "./links";

const ORIGIN = "https://metrics.example.com";

describe("safeNext", () => {
  it("keeps a path of this origin, with its query and hash", () => {
    expect(safeNext("/settings/connections?tab=agents#x", ORIGIN)).toBe(
      "/settings/connections?tab=agents#x",
    );
  });

  it.each([
    null,
    "",
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example/",
    "\\\\evil.example",
    "javascript:alert(1)",
    "/ok\nLocation: https://evil.example",
    "settings",
  ])("sends %j to the start", (next) => {
    expect(safeNext(next, ORIGIN)).toBe("/");
  });
});

describe("signInTarget", () => {
  it("follows https, a path of this origin, and http on loopback", () => {
    expect(signInTarget("https://login.microsoftonline.com/x", ORIGIN)).toBe(
      "https://login.microsoftonline.com/x",
    );
    expect(signInTarget("/oauth/consent?a=1", ORIGIN)).toBe(
      `${ORIGIN}/oauth/consent?a=1`,
    );
    expect(
      signInTarget("http://powerbi-mock.localhost:30001/authorize", ORIGIN),
    ).toBe("http://powerbi-mock.localhost:30001/authorize");
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hi",
    "http://evil.example/",
    "http://localhost.evil.example/",
  ])("never follows %s", (url) => {
    expect(signInTarget(url, ORIGIN)).toBeNull();
  });
});

describe("shownRedirect", () => {
  const shown = { scheme: "https", host: "client.example" };

  it("follows an answer to the scheme and host the screen showed", () => {
    expect(shownRedirect("https://client.example/cb?code=1", shown)).toBe(
      "https://client.example/cb?code=1",
    );
    expect(
      shownRedirect("cursor://anysphere.cursor/cb?code=1", {
        scheme: "cursor",
        host: "anysphere.cursor",
      }),
    ).toBe("cursor://anysphere.cursor/cb?code=1");
  });

  it.each([
    "https://other.example/cb?code=1",
    "http://client.example/cb?code=1",
    "https://client.example.evil.example/cb",
    "javascript:alert(1)",
    "not a url",
  ])("refuses %s", (url) => {
    expect(shownRedirect(url, shown)).toBeNull();
  });

  it("refuses a scheme a browser runs, whatever the screen showed", () => {
    expect(
      shownRedirect("javascript:alert(1)", {
        scheme: "javascript",
        host: null,
      }),
    ).toBeNull();
  });
});
