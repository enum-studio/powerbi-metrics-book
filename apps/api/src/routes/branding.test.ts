import { afterAll, expect, it, vi } from "vitest";
import {
  cerbosAccess,
  closeTestPools,
  createTestDeps,
  principals,
  TEST_PUBLIC_BASE_URL,
} from "../../test/deps.js";
import { MemorySettings } from "../../test/doubles.js";
import { createApp } from "../app.js";
import { putLogo, deleteLogo } from "../services/admin/branding.js";
import { assignRole } from "../services/auth/roles.js";
import { startOAuth } from "../../test/sign-in-support.js";
import { PNG } from "../../test/images.js";

const deps = createTestDeps({ access: cerbosAccess(new MemorySettings()) });
const context = { ...deps, principal: principals.admin };
afterAll(closeTestPools);

it("serves a public logo with restrictive headers, caching and conditional requests", async () => {
  const app = createApp(deps);
  await deleteLogo(context);
  expect((await app.request("/api/branding/logo")).status).toBe(404);
  const bytes = PNG;
  try {
    await putLogo(context, bytes);
    const answer = await app.request("/api/branding/logo");
    expect(answer.status).toBe(200);
    expect(new Uint8Array(await answer.arrayBuffer())).toEqual(bytes);
    expect(answer.headers.get("content-type")).toBe("image/png");
    expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
    expect(answer.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(answer.headers.get("cache-control")).toBe("public, max-age=300");
    const etag = answer.headers.get("etag");
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    const selects = vi.spyOn(deps.db, "select");
    const cached = await app.request("/api/branding/logo", {
      headers: { "If-None-Match": String(etag) },
    });
    expect(cached.status).toBe(304);
    expect(selects.mock.calls).not.toEqual([]);
    expect(selects.mock.calls.every(([fields]) => !("bytes" in fields))).toBe(
      true,
    );
    selects.mockRestore();
    expect(await cached.text()).toBe("");
    expect(cached.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
  } finally {
    await deleteLogo(context);
  }
});

it("refuses a logo over 262144 bytes, including a streamed body without content length", async () => {
  const oauth = startOAuth();
  const person = await oauth.person();
  // The limit runs before authentication and before the global body buffer.
  for (const body of [
    new Uint8Array(262145),
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(262144));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    }),
  ]) {
    const answer = await oauth.request("/api/v1/admin/branding/logo", {
      method: "PUT",
      headers: { cookie: person.cookie },
      body,
      duplex: "half",
    });
    expect(answer.status).toBe(413);
  }
});

it("uploads PNG bytes as an admin and serves those exact bytes publicly", async () => {
  const oauth = startOAuth({ access: deps.access });
  const person = await oauth.person();
  await assignRole(
    oauth.deps.db,
    { role: "admin", subject_kind: "person", subject: person.email },
    principals.admin,
  );
  const bytes = PNG;
  try {
    const answer = await oauth.request("/api/v1/admin/branding/logo", {
      method: "PUT",
      headers: {
        cookie: person.cookie,
        origin: TEST_PUBLIC_BASE_URL,
        "content-type": "image/png",
      },
      body: bytes,
    });
    expect(answer.status).toBe(204);
    const logo = await oauth.request("/api/branding/logo");
    expect(logo.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await logo.arrayBuffer())).toEqual(bytes);
  } finally {
    await deleteLogo(context);
  }
});
