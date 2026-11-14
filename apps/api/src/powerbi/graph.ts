import { z } from "zod";
import { connectAgain } from "../config.js";
import { ServiceError } from "../errors.js";
import {
  parseAnswer,
  readJson,
  readMicrosoftError,
  upstreamFailure,
} from "./errors.js";
import { endpoint, type PowerBiDeps } from "./identity.js";

const GRAPH = "Microsoft Graph";
const page = z.object({
  value: z.array(z.object({ "@odata.type": z.string(), id: z.string() })),
  "@odata.nextLink": z.string().optional(),
});

/**
 * The object ids of every group the person belongs to, nested ones
 * included, read with their own Graph token. Directory roles and
 * administrative units in the same list are left out: access lists name
 * groups.
 * https://learn.microsoft.com/en-us/graph/api/user-list-transitivememberof
 */
export async function myGroupIds(
  deps: Pick<PowerBiDeps, "fetcher" | "settings" | "config">,
  graphToken: string,
): Promise<string[]> {
  const first = new URL(
    await endpoint(deps, "powerbi.graph_url", "/v1.0/me/transitiveMemberOf"),
  );
  first.searchParams.set("$select", "id");
  first.searchParams.set("$top", "999");
  const ids: string[] = [];
  for (let next: URL | null = first; next !== null;) {
    const response = await deps.fetcher.fetchFixed(next, {
      headers: { authorization: `Bearer ${graphToken}` },
    });
    const body = await readJson(response);
    const error = readMicrosoftError(body);
    if (response.status === 401 || response.status === 403) {
      throw new ServiceError(
        "needs_connection",
        `Microsoft Graph refused your Power BI connection's token. ${connectAgain(deps.config)}`,
        { status: response.status, ...error },
      );
    }
    if (!response.ok) throw upstreamFailure(GRAPH, response.status, error);
    const answer = parseAnswer(page, body, GRAPH);
    for (const entry of answer.value) {
      if (entry["@odata.type"] === "#microsoft.graph.group") ids.push(entry.id);
    }
    next = nextPage(answer["@odata.nextLink"], first.origin);
  }
  return ids;
}

/** The token goes with the next page, so the link must stay on Graph's own origin. */
function nextPage(link: string | undefined, origin: string): URL | null {
  if (link === undefined) return null;
  const url = URL.parse(link);
  if (url?.origin !== origin) {
    throw new ServiceError(
      "upstream",
      `${GRAPH} pointed its next page away from ${origin}, so it was not followed.`,
    );
  }
  return url;
}
