import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ServiceError } from "../errors.js";
import { errorResponse } from "./error-response.js";

async function answer(error: ServiceError) {
  const app = new Hono();
  app.get("/", (c) => errorResponse(c, error));
  const response = await app.request("/");
  return { status: response.status, body: await response.json() };
}

describe("errorResponse", () => {
  it("sends a code on the public list", async () => {
    const sent = await answer(
      new ServiceError("invalid", "No.", { code: "docs.field_not_on_kind" }),
    );
    expect(sent.body).toEqual({
      error: "invalid",
      message: "No.",
      code: "docs.field_not_on_kind",
    });
  });

  it("sends no code of an upstream error, so a missing dataset and a refused one answer alike", async () => {
    const missing = await answer(
      new ServiceError("not_found", "No such dataset.", {
        code: "PowerBIEntityNotFound",
      }),
    );
    const refused = await answer(
      new ServiceError("not_found", "No such dataset.", { code: "Forbidden" }),
    );
    expect(missing.body).toEqual({
      error: "not_found",
      message: "No such dataset.",
    });
    expect(refused).toEqual(missing);
  });
});
