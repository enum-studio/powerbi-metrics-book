import { expect, it } from "vitest";
import { buildMock } from "./server.js";
import { sampleTenant } from "./sample/tenant.js";

it("requires a bearer key and keeps the email in its outbox", async () => {
  const { app, outbox } = buildMock({ tenant: sampleTenant() });
  const body = {
    from: "invites@sample.example",
    to: "person@sample.example",
    subject: "Set your password",
    text: "https://sample.example/set-password?token=sample",
    html: "<p>Set your password</p>",
  };
  expect(
    (
      await app.request("/emails", {
        method: "POST",
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await app.request("/emails", {
        method: "POST",
        headers: {
          authorization: "Bearer sample-key",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(200);
  expect(outbox).toEqual([body]);
});
