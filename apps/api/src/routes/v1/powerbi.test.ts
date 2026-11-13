import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools, TEST_PUBLIC_BASE_URL } from "../../../test/deps.js";
import { startOAuth } from "../../../test/sign-in-support.js";

afterAll(closeTestPools);

const oauth = startOAuth();
const LONG = "a".repeat(600);

describe("the Power BI connection redirects", () => {
  it("refuse a token before they read the query, and read a browser's query after", async () => {
    const { cookie } = await oauth.person();
    const token = (await oauth.login(cookie)).access_token;
    for (const path of [
      `/api/v1/powerbi/connect?next=${LONG}`,
      `/api/v1/powerbi/callback?state=${LONG}`,
    ]) {
      const asToken = await oauth.request(path, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(asToken.status, path).toBe(403);
      const asBrowser = await oauth.request(path, {
        headers: { cookie, origin: TEST_PUBLIC_BASE_URL },
      });
      expect(asBrowser.status, path).toBe(400);
    }
  });
});
