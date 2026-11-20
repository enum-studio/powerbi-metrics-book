import { afterAll, expect, it } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  principals,
  TEST_PUBLIC_BASE_URL,
} from "../../../test/deps.js";
import { MemorySettings } from "../../../test/doubles.js";
import { startOAuth } from "../../../test/sign-in-support.js";

import { MAX_BODY_BYTES } from "../../http/security-headers.js";
import { assignRole } from "../../services/auth/roles.js";

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

for (const streamed of [false, true]) {
  it.each([
    ["PUT", "/api/v1/conventions"],
    ["POST", "/api/v1/conventions/diff"],
    ["POST", "/api/v1/conventions/apply"],
  ])(
    `authorizes before limiting a 9 MiB body (streamed: ${String(streamed)}) on %s %s`,
    async (method, path) => {
      for (const role of ["viewer", "admin"] as const) {
        const person = await oauth.person();
        if (role === "admin")
          await assignRole(
            oauth.deps.db,
            { role, subject_kind: "person", subject: person.email },
            principals.admin,
          );
        const response = await oauth.request(path, {
          ...oversizedBody(9 * MAX_BODY_BYTES, streamed),
          method,
          headers: {
            ...bodyHeaders(9 * MAX_BODY_BYTES, streamed),
            cookie: person.cookie,
            origin: TEST_PUBLIC_BASE_URL,
          },
        });
        expect(response.status, role).toBe(role === "viewer" ? 403 : 413);
      }
    },
  );

  it(`keeps the 1 MiB limit on other routes (streamed: ${String(streamed)})`, async () => {
    const viewer = await oauth.person();
    const response = await oauth.request("/api/v1/metrics", {
      ...oversizedBody(2 * MAX_BODY_BYTES, streamed),
      method: "POST",
      headers: {
        ...bodyHeaders(2 * MAX_BODY_BYTES, streamed),
        cookie: viewer.cookie,
        origin: TEST_PUBLIC_BASE_URL,
      },
    });
    expect(response.status).toBe(413);
  });
}

function bodyHeaders(size: number, streamed: boolean) {
  return {
    "content-type": "application/json",
    ...(!streamed ? { "content-length": String(size) } : {}),
  };
}

function oversizedBody(size: number, streamed: boolean) {
  const text = "x".repeat(size);
  return streamed
    ? {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
          },
        }),
        duplex: "half" as const,
      }
    : { body: text };
}
