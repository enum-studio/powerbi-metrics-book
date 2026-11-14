import { sampleTenant } from "@powerbi-metrics-book/powerbi-mock";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemorySecrets } from "../../test/doubles.js";
import {
  connect,
  find,
  samplePerson,
  startPowerBi,
  type PowerBiFixture,
} from "../../test/powerbi-support.js";
import { myGroupIds } from "./graph.js";
import { refresh, scannerToken } from "./identity.js";

const reconnectMessage: unknown = expect.stringContaining(
  "Connect Power BI again at https://metrics.example.com/settings/connections, then run this again.",
);

const tenant = sampleTenant();
const person = (mailbox: string) => samplePerson(tenant, mailbox);
const groupId = (name: string) =>
  find(tenant.groups, (g) => g.name === name).object_id;
// A third group, so Graph answers the Leader's list in two pages.
person("leader").group_ids.push(groupId("Analysts"));

let power: PowerBiFixture;
let now = Date.now();

beforeAll(async () => {
  power = await startPowerBi(tenant, () => new Date(now));
});

afterAll(() => power.mock.close());

describe("client credentials", () => {
  it("keeps the scanner's token until five minutes before it expires", async () => {
    const first = await scannerToken(power.deps);
    power.mock.failNext(`/${tenant.tenant_id}/oauth2/v2.0/token`, 500);

    expect(await scannerToken(power.deps)).toBe(first);

    now += 56 * 60_000;
    await expect(scannerToken(power.deps)).rejects.toMatchObject({
      kind: "upstream",
      detail: { status: 500 },
    });
  });

  it("asks Microsoft again once the secret changes, never answering the old token", async () => {
    const scanner = find(
      tenant.service_principals,
      (sp) => sp.may_call_admin_apis,
    );
    const secrets = new MemorySecrets([
      ["powerbi_scanner_client_secret", scanner.secret],
    ]);
    const deps = { ...power.deps, secrets };
    await scannerToken(deps);
    await secrets.write("powerbi_scanner_client_secret", "not-the-secret");
    await expect(scannerToken(deps)).rejects.toMatchObject({
      kind: "conflict",
      detail: { code: "invalid_client" },
    });
  });
});

describe("a person's connection", () => {
  it("redeems the code for tokens and reads who connected from the ID token", async () => {
    const redeemed = await connect(power, person("leader"));

    expect(redeemed).toMatchObject({
      tid: tenant.tenant_id,
      oid: person("leader").object_id,
      email: null,
      preferred_username: "leader@sample.example",
      expires_at: new Date(now + 3600 * 1000),
    });
    expect(redeemed.scopes).toContain(
      "https://analysis.windows.net/powerbi/api/Dataset.Read.All",
    );
    expect(redeemed.refresh_token).not.toBe("");
    const noEmail = structuredClone(person("outsider"));
    noEmail.email = "";
    noEmail.object_id = crypto.randomUUID();
    tenant.people.push(noEmail);
    expect((await connect(power, noEmail)).email).toBeNull();
    expect(person("outsider").email).toBe("outsider@sample.example");
  });

  it("refreshes for Graph and reads the person's groups across pages", async () => {
    const redeemed = await connect(power, person("leader"));
    const graph = await refresh(power.deps, redeemed.refresh_token, "graph");

    expect(graph.refresh_token).not.toBe(redeemed.refresh_token);
    expect(await myGroupIds(power.deps, graph.access_token)).toEqual([
      groupId("Directors"),
      groupId("Leadership"),
      groupId("Analysts"),
    ]);
  });

  it.each([401, 403])(
    "names the connections page when Graph refuses %s",
    async (status) => {
      power.mock.failNext("/graph/v1.0/me/transitiveMemberOf", status);
      await expect(
        myGroupIds(power.deps, "refused-token"),
      ).rejects.toMatchObject({
        kind: "needs_connection",
        message: reconnectMessage,
      });
    },
  );

  it("turns a refresh token spent twice into needs_connection", async () => {
    const { refresh_token } = await connect(power, person("analyst"));
    await refresh(power.deps, refresh_token, "powerbi");

    await expect(
      refresh(power.deps, refresh_token, "powerbi"),
    ).rejects.toMatchObject({
      kind: "needs_connection",
      message: reconnectMessage,
      detail: { code: "invalid_grant" },
    });
  });

  it("answers the app's refused client secret as the admin's to fix, never naming it", async () => {
    const { refresh_token } = await connect(power, person("analyst"));
    const wrong = "not-the-app-secret";
    const secrets = new MemorySecrets([["powerbi_app_client_secret", wrong]]);
    const refused = refresh(
      { ...power.deps, secrets },
      refresh_token,
      "powerbi",
    );

    await expect(refused).rejects.toMatchObject({
      kind: "conflict",
      message:
        "Microsoft refused the app registration's client id or secret. Check them in the admin section.",
      detail: { code: "invalid_client" },
    });
    await expect(refused).rejects.not.toHaveProperty(
      "message",
      expect.stringContaining(wrong),
    );
  });
});
