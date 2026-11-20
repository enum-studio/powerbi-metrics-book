import { afterAll, expect, it } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  TEST_PUBLIC_BASE_URL,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { startOAuth } from "../../../test/sign-in-support.js";

afterAll(closeTestPools);
const settings = new MemorySettings();
const oauth = startOAuth({ settings, access: cerbosAccess(settings) });

it.each([
  ["PUT", "/api/v1/conventions"],
  ["POST", "/api/v1/conventions/diff"],
  ["POST", "/api/v1/conventions/apply"],
])(
  "refuses a viewer before parsing a 2 MiB body on %s %s",
  async (method, path) => {
    const viewer = await oauth.person();
    const response = await oauth.request(path, {
      method,
      headers: {
        cookie: viewer.cookie,
        origin: TEST_PUBLIC_BASE_URL,
        "content-type": "application/json",
      },
      // Malformed JSON would answer 400 if the validator read it first.
      body: "x".repeat(2 * 1024 * 1024),
    });
    expect(response.status).toBe(403);
  },
);
