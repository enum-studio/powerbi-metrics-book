import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createState } from "../entra/context.js";
import {
  GRAPH_AUDIENCE,
  POWER_BI_AUDIENCE,
  signToken,
} from "../entra/tokens.js";
import { createTestTenant } from "../test-tenant.js";
import { graphRoutes } from "./routes.js";

const ADA = "cccccccc-0000-4000-8000-000000000001";
const GRACE = "cccccccc-0000-4000-8000-000000000002";
const ISSUER = "http://mock.test/tenant/v2.0";
const URL_ME = "http://mock.test/graph/v1.0/me/transitiveMemberOf";

type Answer = {
  value?: unknown[];
  "@odata.nextLink"?: string;
  error?: { code: string; message: string };
};

function setup() {
  const state = createState(createTestTenant());
  const app = new Hono().route("/graph", graphRoutes(state));
  const get = async (url: string, token?: string) => {
    const response = await app.request(
      url,
      token ? { headers: { authorization: `Bearer ${token}` } } : {},
    );
    return { status: response.status, body: (await response.json()) as Answer };
  };
  const tokenFor = (
    claims: Record<string, unknown>,
    audience = GRAPH_AUDIENCE,
    lifetime?: number,
  ) => signToken(state, ISSUER, audience, claims, lifetime);
  return { get, tokenFor };
}

function group(id: string) {
  return {
    "@odata.type": "#microsoft.graph.group",
    id: `99999999-0000-4000-8000-00000000000${id}`,
  };
}

describe("GET /graph/v1.0/me/transitiveMemberOf", () => {
  it("pages the person's groups two at a time, following @odata.nextLink", async () => {
    const { get, tokenFor } = setup();
    const token = await tokenFor({ oid: ADA, scp: "User.Read" });

    const first = (await get(URL_ME, token)).body;
    expect(first.value).toEqual([group("1"), group("2")]);
    const next = first["@odata.nextLink"] ?? "";
    expect(next).toContain("/graph/v1.0/me/transitiveMemberOf?");

    const second = (await get(next, token)).body;
    expect(second.value).toEqual([group("3")]);
    expect(second).not.toHaveProperty("@odata.nextLink");
  });

  it("answers a person with no groups an empty list", async () => {
    const { get, tokenFor } = setup();

    const { body } = await get(
      URL_ME,
      await tokenFor({ oid: GRACE, scp: "User.Read" }),
    );

    expect(body.value).toEqual([]);
  });

  it("answers 401 InvalidAuthenticationToken without a token", async () => {
    const { status, body } = await setup().get(URL_ME);

    expect(status).toBe(401);
    expect(body.error).toMatchObject({ code: "InvalidAuthenticationToken" });
  });

  it("answers 401 for a token for another audience", async () => {
    const { get, tokenFor } = setup();

    const { status, body } = await get(
      URL_ME,
      await tokenFor({ oid: ADA, scp: "User.Read" }, POWER_BI_AUDIENCE),
    );

    expect(status).toBe(401);
    expect(body.error?.message).toContain("Invalid audience");
  });

  it("answers 401 for an expired token", async () => {
    const { get, tokenFor } = setup();

    const { status, body } = await get(
      URL_ME,
      await tokenFor({ oid: ADA, scp: "User.Read" }, GRAPH_AUDIENCE, -60),
    );

    expect(status).toBe(401);
    expect(body.error?.message).toContain("expired");
  });

  it("answers 401 for a token another key signed", async () => {
    const { get } = setup();
    const stranger = setup();

    const { status } = await get(
      URL_ME,
      await stranger.tokenFor({ oid: ADA, scp: "User.Read" }),
    );

    expect(status).toBe(401);
  });

  it("answers 400 to an app-only token, which has no person", async () => {
    const { get, tokenFor } = setup();

    const { status } = await get(
      URL_ME,
      await tokenFor({
        oid: "77777777-0000-4000-8000-0000000000a1",
        idtyp: "app",
      }),
    );

    expect(status).toBe(400);
  });

  it("answers 403 when the token lacks User.Read", async () => {
    const { get, tokenFor } = setup();

    const { status, body } = await get(
      URL_ME,
      await tokenFor({ oid: ADA, scp: "Mail.Read" }),
    );

    expect(status).toBe(403);
    expect(body.error).toMatchObject({ code: "Authorization_RequestDenied" });
  });
});
