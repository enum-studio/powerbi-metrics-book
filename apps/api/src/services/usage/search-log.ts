import { randomUUID } from "node:crypto";
import type { ServiceContext } from "../../context.js";
import { searchLog } from "../../db/schema/usage.js";
import type { SearchAnswer, SearchInput } from "../search/query.js";

export async function logSearch(
  context: ServiceContext,
  input: SearchInput,
  answer: Omit<SearchAnswer, "search_id">,
): Promise<string | null> {
  const { principal } = context;
  if (
    principal.via === "browser" ||
    !(await context.settings.get("usage.capture"))
  )
    return null;
  const id = randomUUID();
  const { query, ...filters } = input;
  await context.auditDb.insert(searchLog).values({
    id,
    at: context.clock(),
    principal_kind: principal.kind,
    principal_id: principal.id,
    via: principal.via,
    client_id: principal.client_id,
    query,
    filters,
    search_mode: answer.search_mode,
    hit_count: answer.items.length,
    metric_hit: answer.items.some(
      ({ kind }) => kind === "metric" || kind === "variant",
    ),
    top_hits: answer.items
      .slice(0, 10)
      .map(({ kind, id, score, match }) => ({ kind, id, score, match })),
  });
  return id;
}
