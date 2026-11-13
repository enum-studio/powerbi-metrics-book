// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ForgotPassword } from "./forgot-password";
import { fill, mount, submit } from "./form-test-support";

afterEach(() => vi.unstubAllGlobals());
it.each([{ status: true }, { message: "No account" }, null])(
  "answers every 200 with the same sentence: %j",
  async (answer) => {
    const request = vi.fn().mockResolvedValue(Response.json(answer));
    vi.stubGlobal("fetch", request);
    const page = await mount(createElement(ForgotPassword));
    try {
      await fill(page.host, "email", "reader@sample.example");
      await submit(page.host);
      expect(request).toHaveBeenCalledWith(
        "/api/auth/email/forgot-password",
        expect.objectContaining({
          body: JSON.stringify({ email: "reader@sample.example" }),
        }),
      );
      await vi.waitFor(() => {
        expect(page.host.textContent).toContain(
          "If that email has an account, a link to set a new password is on its way.",
        );
      });
    } finally {
      page.close();
    }
  },
);
