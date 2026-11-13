import { afterEach, expect, it, vi } from "vitest";
import { addPasskey } from "./passkey";

afterEach(() => vi.unstubAllGlobals());

it("asks a person to sign in again when their session is too old to add a passkey", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { code: "SESSION_NOT_FRESH", message: "Session is not fresh" },
          { status: 403 },
        ),
      ),
  );
  await expect(addPasskey()).rejects.toMatchObject({
    status: 403,
    message: "Sign in again to add a passkey.",
  });
});

it("passes on any other refusal as the api said it", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { code: "UNAUTHORIZED", message: "Unauthorized" },
          { status: 401 },
        ),
      ),
  );
  await expect(addPasskey()).rejects.toMatchObject({
    status: 401,
    message: "Unauthorized",
  });
});
