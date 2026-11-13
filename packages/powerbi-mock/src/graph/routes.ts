import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { findPerson, originOf, type MockState } from "../entra/context.js";
import { GRAPH_AUDIENCE, verifyBearer } from "../entra/tokens.js";

const PAGE_SIZE = 2;
const SCOPES_THAT_READ_OWN_GROUPS = [
  "User.Read",
  "User.Read.All",
  "Directory.Read.All",
  "Group.Read.All",
  "GroupMember.Read.All",
];

/**
 * Graph's error body.
 * https://learn.microsoft.com/en-us/graph/errors
 */
function graphError(
  c: Context,
  status: 400 | 401 | 403,
  code: string,
  message: string,
): Response {
  return c.json(
    {
      error: {
        code,
        message,
        innerError: {
          date: new Date().toISOString(),
          "request-id": randomUUID(),
          "client-request-id": randomUUID(),
        },
      },
    },
    status,
  );
}

/**
 * GET /v1.0/me/transitiveMemberOf, as the sync reads a person's groups with
 * their own Graph token: a delegated token only, groups as directory objects
 * with their @odata.type and id, in pages that carry @odata.nextLink.
 * https://learn.microsoft.com/en-us/graph/api/user-list-transitivememberof
 */
export function graphRoutes(state: MockState): Hono {
  const app = new Hono();

  app.get("/v1.0/me/transitiveMemberOf", async (c) => {
    const bearer = await verifyBearer(
      state,
      c.req.header("authorization"),
      GRAPH_AUDIENCE,
    );
    if ("error" in bearer)
      return graphError(c, 401, "InvalidAuthenticationToken", bearer.error);

    // "me" is the person the token was issued to, not whoever is acting now.
    const { oid, scp } = bearer.claims;
    const person = typeof oid === "string" ? findPerson(state, oid) : undefined;
    if (!person) {
      return graphError(
        c,
        400,
        "BadRequest",
        "/me request is only valid with delegated authentication flow.",
      );
    }
    const granted = typeof scp === "string" ? scp.split(" ") : [];
    if (!SCOPES_THAT_READ_OWN_GROUPS.some((scope) => granted.includes(scope))) {
      return graphError(
        c,
        403,
        "Authorization_RequestDenied",
        "Insufficient privileges to complete the operation.",
      );
    }

    const offset = Number(c.req.query("$skiptoken") ?? 0);
    const body: Record<string, unknown> = {
      "@odata.context": `${originOf(state, c)}/graph/v1.0/$metadata#directoryObjects`,
      value: person.group_ids
        .slice(offset, offset + PAGE_SIZE)
        .map((id) => ({ "@odata.type": "#microsoft.graph.group", id })),
    };
    if (offset + PAGE_SIZE < person.group_ids.length) {
      const next = new URL(c.req.path, originOf(state, c));
      next.search = new URL(c.req.url).search;
      next.searchParams.set("$skiptoken", String(offset + PAGE_SIZE));
      body["@odata.nextLink"] = next.href;
    }
    return c.json(body);
  });

  return app;
}
