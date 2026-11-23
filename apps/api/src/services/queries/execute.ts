import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { ServiceContext } from "../../context.js";
import {
  type DaxToken,
  DaxSyntaxError,
  measureMap,
  referencedMeasures,
  tokenize,
} from "../../dax/index.js";
import { metricVariant } from "../../db/schema/book.js";
import {
  powerbiApp,
  powerbiAppDataset,
  powerbiDataset,
  powerbiMeasure,
  powerbiTable,
  powerbiWorkspace,
} from "../../db/schema/mirror.js";
import type { QueryOrigin, QueryStatus } from "../../db/schema/queries.js";
import { NO_SUCH_DATASET, ServiceError } from "../../errors.js";
import { executeQuery, type QueryAnswer } from "../../powerbi/execute.js";
import { appServicePrincipalToken } from "../../powerbi/identity.js";
import { writeAudit } from "../audit/write.js";
import { personPowerBiGrant } from "../connection/tokens.js";
import { byIdOrName } from "../mirror/read.js";
import {
  checkQuery,
  checkResultColumns,
  hasPiiInDataset,
  hidesNothing,
  knownTablesOf,
  UNCHECKABLE,
} from "../pii/query-check.js";
import { withRelatedEnds } from "../pii/related.js";
import { piiNamesOf, readsPii } from "../pii/rules.js";
import { ensureModelDetails } from "../mirror/info-views.js";
import { countQuery, releaseRows, reserveRows } from "./limits.js";
import { logQuery, type QueryLogInput } from "./log.js";
import {
  createResultStore,
  PREVIEW_ROWS_MAX,
  type ResultAnchor,
} from "./store.js";

/*
 * The one way to run DAX, for the connector, the API and the CLI: decided by
 * Cerbos, checked, limited, run with the caller's own Power BI identity,
 * stored, and logged once whatever the outcome. The caller gets an anchor,
 * never the whole result.
 */

const DAX_BYTES_MAX = 100 * 1024;
const PURPOSE_CHARS_MAX = 2000;
const QUERY_TIMEOUT_MS = 300_000;
const MODEL_VIEW_FIELDS = {
  RELATIONSHIPS:
    "FromTable,FromColumn,FromCardinality,ToTable,ToColumn,ToCardinality,CrossFilteringBehavior,IsActive".split(
      ",",
    ),
  MEASURES: ["Name", "DisplayFolder"],
  COLUMNS: ["Table", "Name", "DisplayFolder"],
};
// Where the lexer and the engine could disagree on the end of a `//` or `--` comment.
const LINE_TERMINATORS = /\r(?!\n)|[\u2028\u2029\u0085\v\f]/u;

export type ExecuteInput = {
  /** An id or a name. */
  dataset: string;
  dax: string;
  purpose?: string | null;
  preview_rows?: number;
};

type Dataset = NonNullable<QueryLogInput["dataset"]>;
type Measures = Pick<QueryLogInput, "measure_names" | "metric_ids">;

export async function executeDax(
  context: ServiceContext,
  input: ExecuteInput,
): Promise<ResultAnchor> {
  return execute(context, input, "request");
}

const MODEL_VIEW_PURPOSE = {
  RELATIONSHIPS: "Read the dataset's relationships for the catalog",
  MEASURES: "Read the dataset's measures for the catalog",
  COLUMNS: "Read the dataset's columns for the catalog",
} as const;

/** A fixed catalog view, queried with the caller's own Power BI identity. */
export async function readModelView(
  context: ServiceContext,
  dataset_id: string,
  view: "RELATIONSHIPS" | "MEASURES" | "COLUMNS",
): Promise<ResultAnchor> {
  const dax = `EVALUATE SELECTCOLUMNS(INFO.VIEW.${view}(), ${MODEL_VIEW_FIELDS[
    view
  ]
    .map((field) => `"${field}", [${field}]`)
    .join(", ")})`;
  return execute(
    context,
    {
      dataset: dataset_id,
      dax,
      purpose: MODEL_VIEW_PURPOSE[view],
      preview_rows: 0,
    },
    "catalog",
  );
}

async function execute(
  context: ServiceContext,
  input: ExecuteInput,
  origin: QueryOrigin,
): Promise<ResultAnchor> {
  const started = performance.now();
  const at = context.clock();
  const query_id = randomUUID();
  let dataset: Dataset | null = null;
  let measures: Measures = { measure_names: [], metric_ids: [] };
  // What fails before Power BI is asked was refused; what fails after, failed.
  let failure: QueryStatus = "refused";

  let reservation: string | null = null;
  let grant: Awaited<ReturnType<typeof tokenFor>> | null = null;

  async function run(): Promise<ResultAnchor> {
    if (origin === "request") await countQuery(context, at);
    checkInput(input);
    const found = await describedDataset(context, input.dataset);
    dataset = {
      id: found.id,
      name: found.name,
      workspace_id: found.workspace_id,
    };
    await context.access.require(context.principal, found.resource, "query");
    // Power BI refuses it too, and a service account has no person's row-level security to hold it.
    // After Cerbos, so a principal refused the query does not learn how the model is secured.
    if (context.principal.kind === "service_account") {
      if (found.attr.has_row_level_security)
        throw new ServiceError(
          "refused",
          `${found.name} has row-level security, and Power BI answers a model with row-level security only to a person. Ask a person to run this query.`,
        );
      if (found.requires_effective_identity)
        throw new ServiceError(
          "refused",
          `${found.name} needs a person's identity in Power BI, through single sign-on to its source or a live connection's roles, so Power BI answers it only to a person. Ask a person to run this query.`,
        );
    }
    checkDax(input.dax);
    // A service account never reads PII, so it is always checked.
    let names =
      (await readsPii(context)) || origin === "catalog"
        ? null
        : await piiNamesOf(context.db, found.id);
    if (names !== null && !hidesNothing(names)) {
      const mirror = await knownTablesOf(context.db, found.id);
      if (mirror.names === null)
        await refuseIfPii(context, found.id, [UNCHECKABLE]);
      else {
        const details = await ensureModelDetails(context, found.id);
        if (
          !details.relationships_current &&
          (!mirror.trustworthy || hasPiiInDataset(names, mirror.names))
        )
          await refuseUnknownRelationships(context, found.id);
        names = await withRelatedEnds(context.db, found.id, names);
        await refuseIfPii(
          context,
          found.id,
          await checkQuery(context.db, input.dax, names, mirror.names),
        );
      }
    }
    measures = await measuresIn(context, found.id, input.dax);
    const preview_rows = await previewRows(context, input.preview_rows);
    if (origin === "request") reservation = await reserveRows(context, at);
    grant = await tokenFor(context, false);
    failure = "failed";
    const ran = await runQuery(context, grant, found.id, input.dax);
    grant = ran.grant;
    if ("error" in ran) throw ran.error;
    const answer = ran.answer;
    if (names !== null) {
      const hidden = await checkResultColumns(
        context.db,
        answer.columns,
        names,
      );
      if (hidden.length > 0) failure = "refused";
      await refuseIfPii(context, found.id, hidden);
    }
    return createResultStore(context).save(
      {
        query_id,
        owner: context.principal,
        dataset: { id: found.id, name: found.name },
        columns: answer.columns,
        truncation_note: answer.truncated ? answer.note : null,
        preview_rows,
      },
      answer.rows,
    );
  }

  /** The query's one log row; its rows then count in the log, and the reservation ends. */
  async function logged(
    rest: Pick<QueryLogInput, "status" | "error" | "result">,
  ): Promise<void> {
    try {
      await logQuery(context, {
        id: query_id,
        origin,
        at,
        powerbi_account: grant?.account ?? null,
        dataset,
        dax: input.dax,
        purpose: input.purpose ?? null,
        duration_ms: Math.round(performance.now() - started),
        ...measures,
        ...rest,
      });
    } finally {
      if (reservation !== null) await releaseRows(context, reservation);
    }
  }

  let anchor: ResultAnchor;
  try {
    anchor = await run();
  } catch (error) {
    const said =
      error instanceof ServiceError
        ? error.message
        : "The query failed inside the api.";
    await logged({ status: failure, error: said });
    throw error;
  }
  await logged({
    status: anchor.truncated ? "truncated" : "succeeded",
    error: anchor.truncation_note,
    // A catalog read's rows name the model's columns, personal data included, so the log never points to them.
    ...(origin === "request" && {
      result: {
        id: anchor.result_id,
        row_count: anchor.row_count,
        column_count: anchor.columns.length,
        bytes: anchor.bytes,
        expires_at: new Date(anchor.expires_at),
      },
    }),
  });
  return anchor;
}

/** A refusal for PII, audited as a deny row; nothing to do when no reference is PII. */
async function refuseIfPii(
  context: ServiceContext,
  dataset_id: string,
  references: string[],
): Promise<void> {
  if (references.length === 0) return;
  await writeAudit(context, {
    principal: context.principal,
    action: "query.pii_refused",
    resource: { kind: "dataset", id: dataset_id },
    decision: "deny",
    reason: "refused",
    detail: { dataset_id, references },
  });
  throw new ServiceError(
    "refused",
    `This query uses PII: ${references.join(", ")}. Use the table's other columns, or ask an admin for the pii_reader role.`,
  );
}

async function refuseUnknownRelationships(
  context: ServiceContext,
  dataset_id: string,
): Promise<never> {
  await writeAudit(context, {
    principal: context.principal,
    action: "query.pii_refused",
    resource: { kind: "dataset", id: dataset_id },
    decision: "deny",
    reason: "refused",
    detail: { dataset_id, references: ["unknown dataset relationships"] },
  });
  throw new ServiceError(
    "refused",
    "This query cannot be checked because the dataset's relationships are not known yet. Try again later, or ask an admin for the pii_reader role.",
  );
}

/** The dataset among those the principal may describe, with what Cerbos reads of it. */
async function describedDataset(context: ServiceContext, reference: string) {
  const allowed = await context.access.describableDatasets(context.principal);
  const [found, other] = await context.db
    .select({
      id: powerbiDataset.id,
      name: powerbiDataset.name,
      workspace_id: powerbiDataset.workspace_id,
      requires_effective_identity: powerbiDataset.requires_effective_identity,
      attr: {
        workspace_id: powerbiDataset.workspace_id,
        workspace_name: powerbiWorkspace.name,
        has_row_level_security: powerbiDataset.has_row_level_security,
        endorsement: powerbiDataset.endorsement,
        sensitivity_label: powerbiDataset.sensitivity_label,
        custom: powerbiDataset.custom,
        enabled: powerbiDataset.enabled,
      },
    })
    .from(powerbiDataset)
    .innerJoin(
      powerbiWorkspace,
      eq(powerbiWorkspace.id, powerbiDataset.workspace_id),
    )
    .where(
      and(
        allowed,
        byIdOrName(powerbiDataset, reference),
        isNull(powerbiDataset.removed_at),
      ),
    )
    .limit(2);
  if (found === undefined) throw new ServiceError("not_found", NO_SUCH_DATASET);
  if (other !== undefined)
    throw new ServiceError(
      "invalid",
      `Several datasets are named "${reference}". Use the id of the one to query.`,
    );
  const apps = await context.db
    .select({ id: powerbiApp.id, name: powerbiApp.name })
    .from(powerbiAppDataset)
    .innerJoin(powerbiApp, eq(powerbiApp.id, powerbiAppDataset.app_id))
    .where(eq(powerbiAppDataset.dataset_id, found.id));
  return {
    ...found,
    resource: {
      kind: "dataset" as const,
      id: found.id,
      attr: {
        ...found.attr,
        app_ids: apps.map((app) => app.id),
        app_names: apps.map((app) => app.name),
      },
    },
  };
}

/** Bounds on what the caller sent, checked before anything runs. */
function checkInput(input: ExecuteInput): void {
  if (Buffer.byteLength(input.dax) > DAX_BYTES_MAX)
    throw new ServiceError("invalid", "The DAX is longer than 100 KB.");
  if ((input.purpose?.length ?? 0) > PURPOSE_CHARS_MAX)
    throw new ServiceError(
      "invalid",
      "The purpose is longer than 2,000 characters.",
    );
  if (input.dax.includes("\0") || input.purpose?.includes("\0") === true)
    throw new ServiceError(
      "invalid",
      "The DAX and the purpose cannot hold a NUL character.",
    );
  if (LINE_TERMINATORS.test(input.dax))
    throw new ServiceError(
      "invalid",
      "The DAX cannot hold a lone carriage return, vertical tab, form feed or Unicode line separator; end lines with a line feed.",
    );
}

/** Checked, never rewritten: Power BI parses the rest, and DAX queries cannot write. */
function checkDax(dax: string): void {
  let tokens: DaxToken[];
  try {
    tokens = tokenize(dax);
  } catch (error) {
    if (error instanceof DaxSyntaxError)
      throw new ServiceError("invalid", error.message);
    throw error;
  }
  const [first] = tokens;
  if (first === undefined)
    throw new ServiceError("invalid", "The DAX is empty.");
  if (first.kind !== "keyword" || !["EVALUATE", "DEFINE"].includes(first.text))
    throw new ServiceError(
      "invalid",
      "A DAX query starts with EVALUATE or DEFINE, after any comments.",
    );
}

/** The dataset's measures the DAX names, and the metrics they are filed under. */
async function measuresIn(
  context: ServiceContext,
  dataset_id: string,
  dax: string,
): Promise<Measures> {
  const live = and(
    eq(powerbiMeasure.dataset_id, dataset_id),
    isNull(powerbiMeasure.removed_at),
  );
  const names = await context.db
    .select({ name: powerbiMeasure.name, table: powerbiTable.name })
    .from(powerbiMeasure)
    .innerJoin(powerbiTable, eq(powerbiTable.id, powerbiMeasure.table_id))
    .where(live);
  const measure_names = referencedMeasures(dax, measureMap(names));
  if (measure_names.length === 0) return { measure_names, metric_ids: [] };
  const metrics = await context.db
    .selectDistinct({ id: metricVariant.metric_id })
    .from(metricVariant)
    .innerJoin(powerbiMeasure, eq(powerbiMeasure.id, metricVariant.measure_id))
    .where(and(live, inArray(powerbiMeasure.name, measure_names)));
  return { measure_names, metric_ids: metrics.map((row) => row.id) };
}

async function previewRows(
  context: ServiceContext,
  asked: number | undefined,
): Promise<number> {
  if (asked === undefined)
    return Math.min(
      await context.settings.get("results.preview_rows"),
      PREVIEW_ROWS_MAX,
    );
  if (!Number.isInteger(asked) || asked < 0 || asked > PREVIEW_ROWS_MAX)
    throw new ServiceError(
      "invalid",
      `preview_rows is a whole number from 0 to ${String(PREVIEW_ROWS_MAX)}.`,
    );
  return asked;
}

/** A person's own delegated token; a service account's is the app's service principal, when an admin allows it. */
async function tokenFor(
  context: ServiceContext,
  force_refresh: boolean,
): Promise<{ token: string; account: string | null }> {
  if (context.principal.kind === "person")
    return personPowerBiGrant(context, { force_refresh });
  if (!(await context.settings.get("powerbi.service_account_queries")))
    throw new ServiceError(
      "refused",
      "Service accounts may not run queries here. An admin can turn on powerbi.service_account_queries in the admin section.",
    );
  return { token: await appServicePrincipalToken(context), account: null };
}

const isStale = (error: unknown) =>
  error instanceof ServiceError &&
  error.kind === "needs_connection" &&
  error.detail.status === 401;

/**
 * A 401 says Power BI no longer takes the token: it is refreshed once and the
 * query retried, and a second 401 answers as a missing dataset.
 */
async function runQuery(
  context: ServiceContext,
  grant: Awaited<ReturnType<typeof tokenFor>>,
  dataset_id: string,
  dax: string,
): Promise<
  { grant: typeof grant } & ({ answer: QueryAnswer } | { error: unknown })
> {
  const run = (bearer: string) =>
    executeQuery(context, {
      token: bearer,
      dataset_id,
      dax,
      timeout_ms: QUERY_TIMEOUT_MS,
    });
  try {
    return { grant, answer: await run(grant.token) };
  } catch (error) {
    if (!isStale(error)) return { grant, error };
  }
  const fresh = await tokenFor(context, true);
  try {
    return { grant: fresh, answer: await run(fresh.token) };
  } catch (error) {
    return {
      grant: fresh,
      error: isStale(error)
        ? new ServiceError("not_found", NO_SUCH_DATASET)
        : error,
    };
  }
}
