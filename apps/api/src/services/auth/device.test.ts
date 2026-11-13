import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools, TEST_PUBLIC_BASE_URL } from "../../../test/deps.js";
import { startOAuth } from "../../../test/sign-in-support.js";
import { deviceCode } from "../../db/schema/auth.js";

afterAll(closeTestPools);

const f = startOAuth();
const V1 = `${TEST_PUBLIC_BASE_URL}/api/v1`;

async function start() {
  const answer = await f.startLogin();
  expect(answer.status).toBe(200);
  return (await answer.json()) as Record<string, unknown> & {
    device_code: string;
    user_code: string;
  };
}

async function poll(device_code: string) {
  const answer = await f.poll(device_code);
  return {
    status: answer.status,
    body: (await answer.json()) as Record<string, unknown>,
  };
}

describe("pbmb login", () => {
  it("gives the CLI an access and a refresh token for /api/v1 once the person allows the code", async () => {
    const { email, cookie } = await f.person();
    const started = await start();
    expect(started).toMatchObject({
      verification_uri: `${TEST_PUBLIC_BASE_URL}/device`,
      expires_in: 600,
      interval: 5,
    });
    const shown = await f.showCode(cookie, started.user_code);
    expect(await shown.json()).toMatchObject({
      person: { email },
      user_code: started.user_code,
      client_id: "pbmb-cli",
      client_name: "pbmb, the command line",
    });
    expect((await f.answerCode(cookie, started.user_code, true)).status).toBe(
      204,
    );

    const tokens = await poll(started.device_code);
    expect(tokens).toMatchObject({
      status: 200,
      body: {
        token_type: "Bearer",
        expires_in: 3600,
        scope: "api offline_access",
      },
    });
    const me = await f.bearer("/api/v1/me", String(tokens.body.access_token));
    expect(await me.json()).toMatchObject({ via: "cli", roles: ["viewer"] });
    const refreshed = await f.token({
      grant_type: "refresh_token",
      refresh_token: String(tokens.body.refresh_token),
      client_id: "pbmb-cli",
      resource: V1,
    });
    expect(refreshed.status).toBe(200);
    expect((await poll(started.device_code)).body).toMatchObject({
      error: "invalid_grant",
    });
  });

  it("refuses a request that names another resource or too little scope", async () => {
    const refused = async (fields: Record<string, string>) =>
      (await (await f.startLogin(fields)).json()) as { error: string };
    expect(await refused({ resource: "" })).toMatchObject({
      error: "invalid_target",
    });
    expect(
      await refused({ resource: `${TEST_PUBLIC_BASE_URL}/api/mcp` }),
    ).toMatchObject({ error: "invalid_target" });
    expect(await refused({ scope: "api" })).toMatchObject({
      error: "invalid_scope",
    });
  });

  it("tells the CLI access_denied when the person denies the code, and grants nothing", async () => {
    const { cookie } = await f.person();
    const started = await start();
    expect((await f.answerCode(cookie, started.user_code, false)).status).toBe(
      204,
    );
    expect(await poll(started.device_code)).toMatchObject({
      status: 400,
      body: { error: "access_denied" },
    });
    const listed = await f.request("/api/v1/me/grants", {
      headers: { cookie },
    });
    expect(await listed.json()).toEqual({ grants: [] });
  });

  it("tells the CLI expired_token once the code has expired", async () => {
    const { cookie } = await f.person();
    const started = await start();
    await f.deps.db
      .update(deviceCode)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(deviceCode.deviceCode, started.device_code));
    expect((await f.showCode(cookie, started.user_code)).status).toBe(404);
    expect(await poll(started.device_code)).toMatchObject({
      status: 400,
      body: { error: "expired_token" },
    });
  });

  it("asks the CLI to slow down when it polls before the interval has passed", async () => {
    const started = await start();
    expect((await poll(started.device_code)).body).toMatchObject({
      error: "authorization_pending",
    });
    expect((await poll(started.device_code)).body).toMatchObject({
      error: "slow_down",
    });
  });
});
