import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools, TEST_PUBLIC_BASE_URL } from "../../../test/deps.js";
import { cookies, fromSpa, startOAuth } from "../../../test/sign-in-support.js";

/*
 * A person signs out of their other browser sessions through Better Auth's
 * /revoke-other-sessions: the session that asks stays, every other one of
 * theirs ends, and no bearer token, other person or signed-out request
 * reaches it.
 */

afterAll(closeTestPools);

const PATH = "/api/auth/revoke-other-sessions";

describe("signing out of other sessions", () => {
  const o = startOAuth();
  const me = (cookie: string) =>
    o.request("/api/v1/me", { headers: { cookie } });
  /** A second browser of the same person, through the same dev sign-in. */
  async function againAs(email: string): Promise<string> {
    const signedIn = await o.request(
      "/api/auth/dev/sign-in",
      fromSpa("", { email }),
    );
    expect(signedIn.status).toBe(200);
    return cookies(signedIn);
  }

  it("ends the person's other sessions and keeps the one that asked", async () => {
    const person = await o.person();
    const laptop = await againAs(person.email);
    const someoneElse = await o.person();
    expect((await me(laptop)).status).toBe(200);
    const answer = await o.request(PATH, fromSpa(person.cookie, {}));
    expect(answer.status, await answer.clone().text()).toBe(200);
    expect((await me(laptop)).status).toBe(401);
    expect((await me(person.cookie)).status).toBe(200);
    expect((await me(someoneElse.cookie)).status).toBe(200);
  });

  it("keeps the person's MCP and CLI grants: they end under Connections", async () => {
    const person = await o.person();
    const mcp = await o.connect(person.cookie, o.client());
    const cli = await o.login(person.cookie);
    expect((await o.request(PATH, fromSpa(person.cookie, {}))).status).toBe(
      200,
    );
    expect((await o.whoami(mcp.access_token)).status).toBe(200);
    expect((await o.bearer("/api/v1/me", cli.access_token)).status).toBe(200);
  });

  it("refuses an MCP token, a CLI token and a signed-out request, and ends nothing", async () => {
    const person = await o.person();
    const laptop = await againAs(person.email);
    const mcp = await o.connect(person.cookie, o.client());
    const cli = await o.login(person.cookie);
    for (const headers of [
      { authorization: `Bearer ${mcp.access_token}` },
      { authorization: `Bearer ${cli.access_token}` },
      {},
    ]) {
      const answer = await o.request(PATH, {
        method: "POST",
        headers: {
          ...headers,
          origin: TEST_PUBLIC_BASE_URL,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(answer.status).toBe(401);
    }
    expect((await me(laptop)).status).toBe(200);
    expect((await me(person.cookie)).status).toBe(200);
  });

  it("refuses a session cookie sent from another site", async () => {
    const person = await o.person();
    const laptop = await againAs(person.email);
    const answer = await o.request(PATH, {
      method: "POST",
      headers: {
        cookie: person.cookie,
        origin: "https://attacker.example.net",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(answer.status).toBe(403);
    expect((await me(laptop)).status).toBe(200);
  });
});
