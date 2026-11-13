import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { ServiceContext } from "../../context.js";
import { metric, metricVariant, TRUST_STATES } from "../../db/schema/book.js";
import { powerbiDataset } from "../../db/schema/mirror.js";
import {
  SEARCH_KINDS,
  type SearchKind,
  searchDocument,
} from "../../db/schema/search.js";
import { ServiceError } from "../../errors.js";
import { loadTree } from "../book/categories.js";
import { clientAddressKey } from "../auth/client-address-key.js";
import { readsPii } from "../pii/rules.js";
import {
  appsSeen,
  byIdOrName,
  inApp,
  inWorkspace,
  type Ref,
  visibleMetric,
} from "../mirror/read.js";
import { countRequest, type RateRule } from "../rate-limit.js";
import { logSearch } from "../usage/search-log.js";
import { createEmbedder, failureCode } from "./embedder.js";

/*
 * Search, as Metrics Book's: exact key, name or alias matches first, then
 * reciprocal rank fusion of pgvector's cosine order and Postgres full text.
 * What the caller may see is decided inside each order's own WHERE, before
 * it is cut to its pool, so a page is never thinned after ranking. A
 * document's copied dataset ids only say where to look: each is joined to
 * powerbi_dataset as it is now, and Cerbos's plan for dataset:describe
 * decides there. A metric is also checked live, by the rule every read of a
 * metric uses. A term is visible to everyone signed in, as the book shows it,
 * and so is a document in no dataset (a category, a metric with no variant).
 */

const RRF_K = 60;
const POOL = 30;
const LIMIT = 10;
const LIMIT_MAX = 50;
const SUMMARY_MAX = 240;
/**
 * Added to a fused score: with RRF_K 60 a verified hit rises about 6 ranks
 * and a human verified one about 10, and an exact hit's 1 stays above both.
 */
const AGENT_VERIFIED_LIFT = 0.0015;
const HUMAN_VERIFIED_LIFT = 0.0025;
/** pg_trgm's similarity a name or label needs to be found as a typo. */
const SIMILARITY_MIN = 0.3;
/** Per principal: an agent searching in a loop is stopped before it costs much. */
export const SEARCH_RATE: RateRule = { window_seconds: 60, max: 60 };
/** Index tuples a filtered vector scan may visit before it settles for fewer than its pool. */
const MAX_SCAN_TUPLES = 20_000;

export const WORDS_ONLY_NOTE =
  "Searched by words only: no embedding provider is set (search.provider is none), so nothing was matched by meaning.";
export const EMBEDDING_FAILED_NOTE =
  "Searched by words only: the embedding provider did not embed the query, so nothing was matched by meaning this time.";

/** Text Postgres can hold: no NUL. */
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !value.includes("\0"), "may not hold a NUL character");

/** The kinds a search may be asked for: the document kinds, and `measure`, which finds variant documents. */
export const SEARCH_QUERY_KINDS = [...SEARCH_KINDS, "measure"] as const;

/** What a search takes of custom fields; the route documents the same bounds. */
export const SEARCH_CUSTOM = { most: 16, value_max: 200 } as const;

const searchInput = z.object({
  query: text(500),
  kinds: z.array(z.enum(SEARCH_QUERY_KINDS)).optional(),
  /** Each an id or a name. */
  workspace: text(500).optional(),
  app: text(500).optional(),
  dataset: text(500).optional(),
  /** A category's key path; with include_children, the categories below it too. */
  category: text(500).optional(),
  include_children: z.boolean().optional(),
  trust_states: z.array(z.enum(TRUST_STATES)).optional(),
  unit: text(200).optional(),
  /** Custom fields to match, as text: { owner_team: "finance" }. */
  custom: z
    .record(text(64).regex(/^[a-z][a-z0-9_]*$/), text(SEARCH_CUSTOM.value_max))
    .refine(
      (custom) => Object.keys(custom).length <= SEARCH_CUSTOM.most,
      `at most ${String(SEARCH_CUSTOM.most)} keys`,
    )
    .optional(),
  /** Documents in removed datasets are left out unless this is true. */
  include_removed: z.boolean().optional(),
  limit: z.number().int().min(1).max(LIMIT_MAX).optional(),
});

export type SearchInput = z.input<typeof searchInput>;
type TrustState = (typeof TRUST_STATES)[number];

/** One level above a hit, from the root down. A folder's id is its path, its levels joined with a backslash. */
export type PathStep = {
  kind: "workspace" | "dataset" | "table" | "folder" | "category";
  id: string;
  name: string;
  /** A category's own key, which its page is found by; null for every other step. */
  key: string | null;
};

export type SearchHit = {
  kind: SearchKind;
  id: string;
  name: string;
  /** A category's own key; null for every other kind. */
  key: string | null;
  label: string;
  summary: string;
  /** The one dataset the caller may describe that holds it; null for none, or for several (a metric). */
  dataset: Ref | null;
  trust_state: TrustState | null;
  score: number;
  match: "exact" | "words" | "meaning";
  /** What holds it, root first; empty for a term, and for anything in a dataset the caller may not describe. */
  path: PathStep[];
  icon: string | null;
  /** The metric a variant belongs to; null for every other kind. */
  metric: { name: string; label: string } | null;
};

export type SearchAnswer = {
  search_id: string | null;
  items: SearchHit[];
  /** How many hits of each kind the caller may see, past the page: every exact, words and likeness match, before any order is cut to its pool, and the meaning order's pool. */
  counts: Partial<Record<SearchKind, number>>;
  search_mode: "hybrid" | "words_only";
  /** Why search ran on words alone; null when it did not. */
  note: string | null;
};

/** Words as Postgres's parser splits them: runs of letters, marks and digits. */
const WORD = /[\p{L}\p{M}\p{N}]+/gu;

/**
 * The words side's tsquery, in to_tsquery's syntax: every word of the query
 * ANDed, the last a prefix when it has 2 characters or more, so `net sal`
 * finds `net sales`. It is built from words alone, each quoted, so no
 * operator a person types reaches the syntax. Null for a query with no word.
 */
export function prefixQuery(asked: string): string | null {
  const words = asked.toLowerCase().match(WORD);
  if (words === null) return null;
  return words
    .map((word, at) =>
      at === words.length - 1 && Array.from(word).length >= 2
        ? `'${word}':*`
        : `'${word}'`,
    )
    .join(" & ");
}

/**
 * The levels of a display folder's first folder. Power BI nests folders with
 * a backslash and puts an element in more than one with a semicolon, as the
 * app's tree reads them.
 */
function folderSteps(folder: string | null): PathStep[] {
  const levels =
    (folder ?? "")
      .split(";")
      .map((one) =>
        one
          .split("\\")
          .map((level) => level.trim())
          .filter((level) => level !== ""),
      )
      .find((one) => one.length > 0) ?? [];
  return levels.map((name, at) => ({
    kind: "folder",
    id: levels.slice(0, at + 1).join("\\"),
    name,
    key: null,
  }));
}

type Named = { id: string; name: string };
/** Where a hit in a dataset sits; null when that dataset is not one the caller may reach. */
type Place = Record<"workspace" | "dataset", Named> & {
  table: Named | null;
  folder: string | null;
};

/** A hit as the query answers it, before its path is put together. */
type Row = Omit<SearchHit, "path"> & {
  more: {
    place: Place | null;
    categories: PathStep[] | null;
    counts: SearchAnswer["counts"] | null;
  };
};

/** A term has no place; a table's and a dataset's place names no table. */
function pathOf(
  kind: SearchKind,
  place: Place | null,
  categories: PathStep[] | null,
): PathStep[] {
  if (kind === "metric" || kind === "category") return categories ?? [];
  if (place === null) return [];
  const steps: PathStep[] = [
    { kind: "workspace", ...place.workspace, key: null },
  ];
  if (kind !== "dataset")
    steps.push({ kind: "dataset", ...place.dataset, key: null });
  if (place.table !== null)
    steps.push(
      { kind: "table", ...place.table, key: null },
      ...folderSteps(place.folder),
    );
  return steps;
}

type Asked =
  | { vector: number[]; model: string; note: null }
  | { vector: null; model: null; note: string };

/**
 * The query's vector. A provider that fails, however it fails, leaves the
 * person with results by words and a fixed sentence, never the provider's
 * words; any other error is a bug and is thrown.
 */
async function embedQuery(
  context: ServiceContext,
  query: string,
): Promise<Asked> {
  try {
    const embedder = await createEmbedder(context);
    if (embedder === null)
      return { vector: null, model: null, note: WORDS_ONLY_NOTE };
    const [vector] = await embedder.embed([query], "query");
    if (vector === undefined)
      throw new Error("the embedder answered no vector");
    return { vector, model: embedder.model, note: null };
  } catch (error) {
    const code = failureCode(error);
    if (code === null) throw error;
    context.logger.warn(
      "search ran on words alone: the query was not embedded",
      { code },
    );
    return { vector: null, model: null, note: EMBEDDING_FAILED_NOTE };
  }
}

/** The categories the filter names, as a condition on a document's category_id. */
async function inCategory(
  context: ServiceContext,
  path: string,
  withChildren: boolean,
): Promise<SQL> {
  const { id } = (await loadTree(context.db)).get(path);
  if (!withChildren) return eq(searchDocument.category_id, id);
  return sql`${searchDocument.category_id} in (
    with recursive below(id) as (
      select ${id}::uuid
      union all
      select c.id from category c join below on c.parent_id = below.id
    )
    select id from below)`;
}

/** Metrics of the unit, and the variants of those metrics. */
function ofUnit(context: ServiceContext, unit: string): SQL {
  const metrics = context.db
    .select({ id: metric.id })
    .from(metric)
    .where(eq(metric.unit, unit));
  const variants = context.db
    .select({ id: metricVariant.id })
    .from(metricVariant)
    .innerJoin(metric, eq(metric.id, metricVariant.metric_id))
    .where(eq(metric.unit, unit));
  return sql`((${searchDocument.kind} = 'metric' and ${inArray(searchDocument.element_id, metrics)})
    or (${searchDocument.kind} = 'variant' and ${inArray(searchDocument.element_id, variants)}))`;
}

function parsed(input: SearchInput) {
  const result = searchInput.safeParse(input);
  if (result.success) return result.data;
  const [issue] = result.error.issues;
  const field = issue?.path.join(".") ?? "input";
  throw new ServiceError(
    "invalid",
    `\`${field}\` is not valid: ${issue?.message ?? "check it"}.`,
  );
}

/**
 * Whose allowance a search counts against: the principal's, and in demo mode,
 * where every visitor is the one demo person, the client address's. A demo
 * search with no address is refused, so no key is shared by every such caller.
 */
function rateKey(context: ServiceContext): string {
  const { principal, client_address } = context;
  if (!context.config.demo_mode)
    return `search:${principal.kind}:${principal.id}`;
  if (client_address === undefined || client_address === null)
    throw new ServiceError(
      "refused",
      "The demo searches only for a request with a client address.",
    );
  return `search:demo:${clientAddressKey(client_address)}`;
}

/** Postgres's query_canceled, which statement_timeout raises; drizzle keeps it as a cause. */
function cancelled(error: unknown): boolean {
  for (let at: unknown = error; at instanceof Error; at = at.cause)
    if ((at as { code?: unknown }).code === "57014") return true;
  return false;
}

/**
 * Call it outside any transaction: its settings are `set local`, so in an
 * outer one they would last for the rest of it.
 */
export async function search(
  context: ServiceContext,
  raw: SearchInput,
  limits: { statement_timeout_ms: number } = { statement_timeout_ms: 5_000 },
): Promise<SearchAnswer> {
  const input = parsed(raw);
  const asked = input.query.trim().replace(/\s+/g, " ");
  if (asked === "")
    throw new ServiceError("invalid", "Say what to search for in `query`.");
  const { db, principal } = context;
  const verdict = await countRequest(
    db,
    rateKey(context),
    SEARCH_RATE,
    context.clock(),
  );
  if (!verdict.allowed)
    throw new ServiceError(
      "rate_limited",
      `Too many searches. Try again in ${String(verdict.retry_after_seconds)} seconds.`,
    );
  const limit = input.limit ?? LIMIT;
  // Each order keeps at least `limit`, so a page of 50 can be full by words alone.
  const pool = Math.max(POOL, limit);
  const allowed = await context.access.describableDatasets(principal);

  // A dataset of the document the caller may describe, still in Power BI, and
  // inside the workspace, app and dataset filters. A hidden or missing
  // dataset, workspace or app matches nothing, alike.
  const reachable = and(
    allowed,
    input.include_removed === true
      ? undefined
      : isNull(powerbiDataset.removed_at),
    input.dataset === undefined
      ? undefined
      : byIdOrName(powerbiDataset, input.dataset),
    input.workspace === undefined
      ? undefined
      : inWorkspace(db, input.workspace),
    input.app === undefined
      ? undefined
      : inApp(db, input.app, await appsSeen(context, allowed)),
  );
  const filtered =
    input.dataset !== undefined ||
    input.workspace !== undefined ||
    input.app !== undefined;
  const reached = sql`exists (select 1 from ${powerbiDataset} where ${powerbiDataset.id} = any(${searchDocument.dataset_ids}) and ${reachable})`;
  const visible = filtered
    ? reached
    : sql`(${searchDocument.kind} = 'term' or cardinality(${searchDocument.dataset_ids}) = 0 or ${reached})`;
  // A metric also answers to the rule every other read of a metric uses.
  const metricShown = visibleMetric(db, allowed, !(await readsPii(context)));
  const visibleAsMetric = sql`(${searchDocument.kind} <> 'metric' or exists (select 1 from ${metric} where ${metric.id} = ${searchDocument.element_id} and ${metricShown}))`;

  const kinds =
    input.kinds === undefined
      ? undefined
      : [
          ...new Set(
            input.kinds.map((kind) => (kind === "measure" ? "variant" : kind)),
          ),
        ];
  const where = and(
    visible,
    visibleAsMetric,
    kinds === undefined ? undefined : inArray(searchDocument.kind, kinds),
    input.trust_states === undefined
      ? undefined
      : inArray(searchDocument.trust_state, input.trust_states),
    input.category === undefined
      ? undefined
      : await inCategory(
          context,
          input.category,
          input.include_children === true,
        ),
    input.unit === undefined ? undefined : ofUnit(context, input.unit),
    ...Object.entries(input.custom ?? {}).map(
      ([key, value]) => sql`${searchDocument.custom} ->> ${key} = ${value}`,
    ),
  );

  const { vector, model, note } = await embedQuery(context, asked);
  const d = searchDocument;
  const lowered = sql`lower(${asked})`;
  const words = prefixQuery(asked);
  const exactly = sql`(lower(${d.name}) = ${lowered}
    or (${d.kind} = 'metric' and exists (
      select 1 from metric m where m.id = ${d.element_id} and (lower(m.label) = ${lowered}
        or exists (select 1 from unnest(m.aliases) alias where lower(alias) = ${lowered}))))
    or (${d.kind} = 'term' and exists (
      select 1 from term t where t.id = ${d.element_id}
        and exists (select 1 from unnest(t.aliases) alias where lower(alias) = ${lowered})))
    or (${d.kind} = 'category' and exists (
      select 1 from category c where c.id = ${d.element_id} and lower(c.key) = ${lowered})))`;
  // The filter sits in the scan's own WHERE, so the HNSW index is walked on
  // (iteratively, from pgvector 0.8) until the pool is full of what the
  // caller may see or the walk has visited MAX_SCAN_TUPLES index tuples, so
  // it can return fewer than the pool; the relaxed order is put right by
  // sorting on distance.
  const distance = sql`${d.embedding} <=> ${vector === null ? null : JSON.stringify(vector)}::vector`;
  const nearest =
    vector === null
      ? sql`select null::text as doc, null::text as kind, 0::bigint as rank where false`
      : sql`select doc, kind, row_number() over (order by distance, doc) as rank from (
          select ${d.id} as doc, ${d.kind}::text as kind, ${distance} as distance from ${d}
          where ${where} and ${d.embedding_model} = ${model}
          order by ${distance} limit ${pool}) as near`;
  // Every match by words and by likeness, before either is cut to its pool:
  // the counts are taken from these, so a count is never cut at a pool.
  const wordedAll =
    words === null
      ? sql`select null::text as doc, null::text as kind, 0::real as score where false`
      : sql`select ${d.id} as doc, ${d.kind}::text as kind, ts_rank(${d.search_tsv}, to_tsquery('simple', ${words})) as score from ${d}
          where ${where} and ${d.search_tsv} @@ to_tsquery('simple', ${words})`;
  const worded = sql`select doc, row_number() over (order by score desc, doc) as rank from (
      select doc, score, row_number() over (partition by kind order by score desc, doc) as within
      from worded_all) as w where within <= ${pool}`;
  // A name typed with a letter wrong. pg_trgm folds case, so its indexes serve
  // `%` (at the transaction's similarity_threshold) on the columns as they
  // are. Hits as alike share a rank: a metric and its variants' label tie.
  const likeness = sql`greatest(similarity(${d.name}, ${lowered}), similarity(${d.label}, ${lowered}))`;
  const likenedAll = sql`select ${d.id} as doc, ${d.kind}::text as kind, ${likeness} as likeness from ${d}
      where ${where} and (${d.name} % ${lowered} or ${d.label} % ${lowered})`;
  const likened = sql`select doc, rank() over (order by likeness desc) as rank from (
      select doc, likeness, row_number() over (partition by kind order by likeness desc, doc) as within
      from likened_all) as l where within <= ${pool}`;
  // The sections' order. Among exact hits it comes before the fused score, so
  // "net sales" leads with the metric of that name, not with a measure the
  // words order happened to rank higher; elsewhere it only breaks a tie.
  const kindOrder = sql`array_position(array['metric', 'variant', 'term', 'category', 'dataset', 'table', 'column'], ${d.kind}::text)`;
  const lifted = sql`case ${d.trust_state}
      when 'human_verified' then ${sql.raw(String(HUMAN_VERIFIED_LIFT))}
      when 'agent_verified' then ${sql.raw(String(AGENT_VERIFIED_LIFT))}
      else 0 end`;

  // Where a hit in a dataset sits, only through a dataset its document names
  // that the caller may reach, as `dataset` is decided: the element's own
  // dataset as it is now must be one of them, or the hit has no place.
  const place = sql`(select json_build_object(
        'workspace', json_build_object('id', w.id, 'name', w.name),
        'dataset', json_build_object('id', ${powerbiDataset.id}, 'name', ${powerbiDataset.name}),
        'table', case when t.id is null then null else json_build_object('id', t.id, 'name', t.name) end,
        'folder', held.folder)
      from (
        select pm.dataset_id, pm.table_id, pm.display_folder as folder
          from metric_variant mv join powerbi_measure pm on pm.id = mv.measure_id
          where ${d.kind} = 'variant' and mv.id = ${d.element_id}
        union all select pc.dataset_id, pc.table_id, pc.display_folder
          from powerbi_column pc where ${d.kind} = 'column' and pc.id = ${d.element_id}
        union all select pt.dataset_id, null, null
          from powerbi_table pt where ${d.kind} = 'table' and pt.id = ${d.element_id}
        union all select pd.id, null, null
          from powerbi_dataset pd where ${d.kind} = 'dataset' and pd.id = ${d.element_id}
      ) held
      join ${powerbiDataset} on ${powerbiDataset.id} = held.dataset_id
        and ${powerbiDataset.id} = any(${d.dataset_ids}) and ${reachable}
      join powerbi_workspace w on w.id = ${powerbiDataset.workspace_id}
      left join powerbi_table t on t.id = held.table_id)`;
  // A metric's categories, or a category's parents, root first. Categories
  // are shown to everyone signed in, as the book shows them. The curation
  // service refuses a cycle; the walk still stops at one, so a cycle in the
  // data cannot run a search to the statement timeout.
  const filed = sql`(with recursive up(id, parent_id, name, key, depth) as (
        select c.id, c.parent_id, c.name, c.key, 0 from category c
        where c.id = case ${d.kind}
          when 'metric' then (select m.category_id from metric m where m.id = ${d.element_id})
          when 'category' then (select p.parent_id from category p where p.id = ${d.element_id})
        end
        union all
        select c.id, c.parent_id, c.name, c.key, up.depth + 1 from category c join up on c.id = up.parent_id
      ) cycle id set is_cycle using walked
      select json_agg(json_build_object('kind', 'category', 'id', id, 'name', name, 'key', key) order by depth desc)
      from up where not is_cycle)`;
  const icon = sql`case ${d.kind}
      when 'metric' then (select m.icon from metric m where m.id = ${d.element_id})
      when 'term' then (select tm.icon from term tm where tm.id = ${d.element_id})
      when 'category' then (select c.icon from category c where c.id = ${d.element_id})
      when 'dataset' then (select pd.icon from powerbi_dataset pd where pd.id = ${d.element_id})
    end`;
  // A variant's metric, under the rule every read of a metric uses.
  const ofMetric = sql`case when ${d.kind} = 'variant' then (
      select json_build_object('name', ${metric.name}, 'label', ${metric.label})
      from ${metricVariant} join ${metric} on ${metric.id} = ${metricVariant.metric_id}
      where ${metricVariant.id} = ${d.element_id} and ${metricShown})
    end`;

  const searching = db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', ${String(limits.statement_timeout_ms)}, true), set_config('hnsw.ef_search', '100', true),
        set_config('pg_trgm.similarity_threshold', ${String(SIMILARITY_MIN)}, true)`,
    );
    // Before 0.8 pgvector has neither setting: the scan then stops at
    // ef_search candidates, and a selective filter leaves the meaning side
    // short while the words side still fills the page.
    await tx.execute(sql`select set_config('hnsw.iterative_scan', 'relaxed_order', true),
        set_config('hnsw.max_scan_tuples', ${String(MAX_SCAN_TUPLES)}, true)
      from pg_extension
      where extname = 'vector' and string_to_array(extversion, '.')::int[] >= array[0, 8]`);
    const { rows } = await tx.execute<Row>(sql`
      with exact as (
        select ${d.id} as doc, ${d.kind}::text as kind from ${d} where ${where} and ${exactly}
      ),
      nearest as (${nearest}),
      worded_all as materialized (${wordedAll}),
      worded as (${worded}),
      likened_all as materialized (${likenedAll}),
      likened as (${likened}),
      fused as (
        select doc, sum(1.0 / (${RRF_K} + rank)) as score, bool_or(by_words) as by_words
        from (select doc, rank, false as by_words from nearest
              union all select doc, rank, true from worded
              union all select doc, rank, true from likened) ranked
        group by doc
      ),
      hit as (
        select coalesce(f.doc, e.doc) as doc,
          coalesce(f.score, 0) + (e.doc is not null)::int as score,
          case when e.doc is not null then 'exact' when f.by_words then 'words' else 'meaning' end as match
        from fused f full join exact e on e.doc = f.doc
      ),
      counted as (
        select kind, count(*)::int as n
        from (select doc, kind from exact
              union select doc, kind from worded_all
              union select doc, kind from likened_all
              union select doc, kind from nearest) matched
        group by kind
      )
      select ${d.kind} as kind, ${d.element_id} as id, ${d.name} as name,
        case when ${d.kind} = 'category' then (select c.key from category c where c.id = ${d.element_id}) end as key,
        ${d.label} as label,
        left(${d.summary}, ${SUMMARY_MAX}) as summary, ${d.trust_state} as trust_state,
        (hit.score + ${lifted})::float8 as score, hit.match,
        (select json_build_object('kind', 'dataset', 'id', min(${powerbiDataset.id}::text), 'name', min(${powerbiDataset.name}))
          from ${powerbiDataset}
          where ${powerbiDataset.id} = any(${d.dataset_ids}) and ${reachable}
          having count(*) = 1) as dataset,
        ${icon} as icon, ${ofMetric} as metric,
        json_build_object('place', ${place}, 'categories', ${filed},
          'counts', (select json_object_agg(kind, n) from counted)) as more
      from hit join ${d} on ${d.id} = hit.doc
      order by hit.match = 'exact' desc,
        case when hit.match = 'exact' then ${kindOrder} end,
        hit.score + ${lifted} desc, ${kindOrder}, ${d.name}, ${d.id}
      limit ${limit}`);
    return rows;
  });
  const rows = await searching.catch((error: unknown) => {
    if (!cancelled(error)) throw error;
    throw new ServiceError(
      "upstream",
      "The search took too long and was stopped. Narrow it with a filter, or try again.",
    );
  });

  const answer: Omit<SearchAnswer, "search_id"> = {
    items: rows.map(({ more, ...hit }) => ({
      ...hit,
      path: pathOf(hit.kind, more.place, more.categories),
    })),
    counts: rows[0]?.more.counts ?? {},
    search_mode: vector === null ? "words_only" : "hybrid",
    note,
  };
  return { ...answer, search_id: await logSearch(context, input, answer) };
}
