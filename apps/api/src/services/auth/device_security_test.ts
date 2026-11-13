import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools } from "../../../test/deps.js";
import { startOAuth } from "../../../test/sign-in-support.js";

afterAll(closeTestPools);

const f = startOAuth();

/** One sentence for every failure to answer a code, so answering reveals none. */
const NO_CODE = {
  error: "not_found",
  message:
    "No sign-in waits for this code. Check the code, or run pbmb login again.",
};

describe("device codes against phishing", () => {
  it("bring no link with the code, and no request may bind one to a person", async () => {
    const started = await f.startLogin();
    expect(await started.json()).not.toHaveProperty(
      "verification_uri_complete",
    );
    const { id } = await f.person();
    expect(await (await f.startLogin({ user_id: id })).json()).toMatchObject({
      error: "invalid_request",
    });
  });

  it("show when and from which address the request started", async () => {
    const { cookie } = await f.person();
    const { user_code } = (await (await f.startLogin()).json()) as {
      user_code: string;
    };
    const shown = (await (await f.showCode(cookie, user_code)).json()) as {
      started_at: string;
      started_from: string;
    };
    expect(shown.started_from).toMatch(/^198\.1[89]\./);
    expect(Date.now() - Date.parse(shown.started_at)).toBeLessThan(60_000);
  });

  it("are claimed by the person who answers, never one who only looks, and every failure answers alike", async () => {
    const first = await f.person();
    const second = await f.person();
    const { user_code } = (await (await f.startLogin()).json()) as {
      user_code: string;
    };
    expect((await f.showCode(first.cookie, user_code)).status).toBe(200);
    expect((await f.showCode(second.cookie, user_code)).status).toBe(200);
    expect((await f.answerCode(first.cookie, user_code, true)).status).toBe(
      204,
    );
    expect((await f.showCode(second.cookie, user_code)).status).toBe(404);
    for (const code of [user_code, "ZZZZZZZZ"]) {
      const refused = await f.answerCode(second.cookie, code, true);
      expect(refused.status, code).toBe(404);
      expect(await refused.json(), code).toEqual(NO_CODE);
    }
    const listed = await f.request("/api/v1/me/grants", {
      headers: { cookie: second.cookie },
    });
    expect(await listed.json()).toEqual({ grants: [] });
  });
});
