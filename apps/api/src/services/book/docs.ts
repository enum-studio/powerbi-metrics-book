import { z } from "zod";
import { visibleExceptions } from "../conventions/service.js";
import {
  checkedElements,
  unusedExceptions,
  type CheckedElement,
} from "./whole-book-checks.js";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgColumn } from "drizzle-orm/pg-core";
import type { Db, ServiceContext } from "../../context.js";
import {
  powerbiApp,
  powerbiAppDataset,
  powerbiColumn,
  powerbiDataset,
  powerbiMeasure,
  powerbiTable,
  powerbiWorkspace,
} from "../../db/schema/mirror.js";
import { NO_SUCH_DATASET, ServiceError } from "../../errors.js";
import { currentConventions } from "../conventions/store.js";
import { withEvents } from "../events/feed.js";
import { appsSeen, pageBy, sizeOf } from "../mirror/read.js";
import { piiColumn, piiMeasure, readsPii } from "../pii/rules.js";
import { recordBookChange, requireCurator } from "./changes.js";
import { checkCustom, exceptionIndex } from "./checks.js";

/*
 * Our description of a mirror element, beside Power BI's. The sync never
 * writes these columns (description, described_by, described_at, custom and the built-in fields), and
 * api_rw writes nothing else of the mirror. An element the caller may not
 * describe answers like one that does not exist: a workspace or an app is
 * seen through the datasets in it the caller may describe, a table, column or
 * measure through its dataset.
 */

type DocTable =
  | typeof powerbiWorkspace
  | typeof powerbiApp
  | typeof powerbiDataset
  | typeof powerbiTable
  | typeof powerbiColumn
  | typeof powerbiMeasure;

const seen = (db: Db, allowed: SQL) =>
  db
    .select({ id: powerbiDataset.id })
    .from(powerbiDataset)
    .where(and(allowed, isNull(powerbiDataset.removed_at)));

/** A nullable text column of the mirror. */
type TextColumn = AnyPgColumn<{ data: string; notNull: false }>;

interface KindSpec {
  table: DocTable;
  pbi: PgColumn | null;
  /** The built-in fields of the kind, each with its column; a kind without any has none. */
  built: Record<string, TextColumn>;
  reach: (db: Db, allowed: SQL, apps: SQL | undefined) => SQL | undefined;
}

/** Where each kind is kept, Power BI's own description (a workspace has none) and how it is reached through a dataset. */
export const KINDS = {
  workspace: {
    table: powerbiWorkspace,
    built: {},
    pbi: null,
    reach: (db, allowed) =>
      inArray(
        powerbiWorkspace.id,
        db
          .select({ id: powerbiDataset.workspace_id })
          .from(powerbiDataset)
          .where(and(allowed, isNull(powerbiDataset.removed_at))),
      ),
  },
  app: {
    table: powerbiApp,
    built: {},
    pbi: powerbiApp.description_pbi,
    // An app is seen as the app lists show it (appsSeen), and through a dataset the caller may describe.
    reach: (db, allowed, apps) =>
      and(
        apps,
        inArray(
          powerbiApp.id,
          db
            .select({ id: powerbiAppDataset.app_id })
            .from(powerbiAppDataset)
            .where(inArray(powerbiAppDataset.dataset_id, seen(db, allowed))),
        ),
      ),
  },
  dataset: {
    table: powerbiDataset,
    built: {
      when_to_use: powerbiDataset.when_to_use,
      owner: powerbiDataset.owner,
      freshness: powerbiDataset.freshness,
      caveats: powerbiDataset.caveats,
    },
    pbi: powerbiDataset.description_pbi,
    reach: (db, allowed) => inArray(powerbiDataset.id, seen(db, allowed)),
  },
  table: {
    table: powerbiTable,
    built: {
      grain_and_filters: powerbiTable.grain_and_filters,
      caveats: powerbiTable.caveats,
    },
    pbi: powerbiTable.description_pbi,
    reach: (db, allowed) => inArray(powerbiTable.dataset_id, seen(db, allowed)),
  },
  column: {
    table: powerbiColumn,
    built: { unit: powerbiColumn.unit, blank_means: powerbiColumn.blank_means },
    pbi: powerbiColumn.description_pbi,
    reach: (db, allowed) =>
      inArray(powerbiColumn.dataset_id, seen(db, allowed)),
  },
  measure: {
    table: powerbiMeasure,
    built: {},
    pbi: powerbiMeasure.description_pbi,
    reach: (db, allowed) =>
      inArray(powerbiMeasure.dataset_id, seen(db, allowed)),
  },
} satisfies Record<string, KindSpec>;

type DocKind = keyof typeof KINDS;
const DOC_KINDS = Object.keys(KINDS);
const isDocKind = (kind: string): kind is DocKind => Object.hasOwn(KINDS, kind);

/** The kind's spec, or undefined for a kind that has no documentation. */
export function docKind(kind: string): KindSpec | undefined {
  return isDocKind(kind) ? KINDS[kind] : undefined;
}

export type BuiltInField = {
  [K in DocKind]: keyof (typeof KINDS)[K]["built"];
}[DocKind];
export type BuiltInValues = Partial<Record<BuiltInField, string | null>>;

/** Every built-in field of any kind. */
const ALL_FIELDS: ReadonlySet<string> = new Set(
  Object.values(KINDS).flatMap((kind: KindSpec) => Object.keys(kind.built)),
);
const isBuiltInField = (field: string): field is BuiltInField =>
  ALL_FIELDS.has(field);

const fieldsOf = (kind: string): BuiltInField[] =>
  Object.keys(docKind(kind)?.built ?? {}).filter(isBuiltInField);

export type DocElement = { kind: string; id: string };
export type Docs = BuiltInValues & {
  element: { kind: string; id: string; name: string };
  /** Ours; it wins over Power BI's where both exist. */
  description: string | null;
  description_pbi: string | null;
  described_by: string | null;
  described_at: Date | null;
  custom: Record<string, unknown>;
};

/** Whether a rule marks the column or measure as PII; other kinds never are. */
async function isPii(db: Db, element: DocElement): Promise<boolean> {
  if (element.kind !== "column" && element.kind !== "measure") return false;
  const source = element.kind === "column" ? powerbiColumn : powerbiMeasure;
  const [row] = await db
    .select({
      pii:
        element.kind === "column"
          ? piiColumn(powerbiColumn, powerbiTable)
          : piiMeasure(powerbiMeasure),
    })
    .from(source)
    .innerJoin(powerbiTable, eq(powerbiTable.id, source.table_id))
    .where(eq(source.id, element.id));
  return row?.pii === true;
}

async function load(db: Db, context: ServiceContext, element: DocElement) {
  const kind = docKind(element.kind);
  if (kind === undefined) {
    throw new ServiceError(
      "invalid",
      `${element.kind} has no documentation. Document a ${DOC_KINDS.join(", ")}.`,
    );
  }
  const { table } = kind;
  const allowed = await context.access.describableDatasets(context.principal);
  const apps = await appsSeen(context, allowed);
  // Only the kind's own built-in columns are selected, so the answer carries just those.
  const [row] = await db
    .select({
      built: kind.built,
      id: table.id,
      name: table.name,
      description: table.description,
      description_pbi: kind.pbi ?? sql<string | null>`null`,
      described_by: table.described_by,
      described_at: table.described_at,
      custom: table.custom,
    })
    .from(table)
    .where(
      and(
        eq(table.id, element.id),
        isNull(table.removed_at),
        kind.reach(db, allowed, apps),
      ),
    );
  // A PII column or measure answers like one that is not there.
  if (
    row === undefined ||
    (!(await readsPii(context)) && (await isPii(db, element)))
  ) {
    throw new ServiceError(
      "not_found",
      element.kind === "dataset" ? NO_SUCH_DATASET : `No such ${element.kind}.`,
    );
  }
  const fields: BuiltInValues = row.built;
  return {
    table,
    docs: {
      ...fields,
      element: { kind: element.kind, id: row.id, name: row.name },
      description: row.description,
      description_pbi: row.description_pbi,
      described_by: row.described_by,
      described_at: row.described_at,
      custom: row.custom,
    } satisfies Docs,
  };
}

export async function getDocs(
  context: ServiceContext,
  element: DocElement,
): Promise<Docs> {
  return (await load(context.db, context, element)).docs;
}

/**
 * Sets what is given: a description (blank clears it) and the custom fields
 * (the whole object, replacing the old). The custom fields are checked against
 * the conventions' fields for the kind; one the conventions require and the
 * element lacks is for the checks to report, not a reason to refuse the write.
 */
export async function setDocs(
  context: ServiceContext,
  element: DocElement,
  input: {
    description?: string | null;
    custom?: Record<string, unknown>;
  } & BuiltInValues,
): Promise<Docs> {
  await requireCurator(context);
  const own = fieldsOf(element.kind);
  for (const field of [...ALL_FIELDS].filter(isBuiltInField)) {
    if (input[field] === undefined || own.includes(field)) continue;
    throw new ServiceError(
      "invalid",
      `${field} is not a field of a ${element.kind}. ${
        own.length === 0
          ? `A ${element.kind} has no built-in fields.`
          : `A ${element.kind} has ${own.join(", ")}.`
      }`,
      { code: "docs.field_not_on_kind", field, kind: element.kind },
    );
  }
  if (input.custom !== undefined) {
    const rules = await currentConventions(context.db);
    const fields =
      element.kind === "dataset"
        ? rules.dataset_fields.custom
        : element.kind === "table"
          ? rules.table_fields.custom
          : element.kind === "column"
            ? rules.column_fields.custom
            : [];
    checkCustom(fields, input.custom);
  }
  if (input.unit?.trim()) {
    const { column_fields } = await currentConventions(context.db);
    if (!column_fields.unit.values.includes(input.unit.trim()))
      throw new ServiceError(
        "invalid",
        `Use one of these units: ${column_fields.unit.values.join(", ")}.`,
        {
          code: "docs.unit_not_allowed",
          values: column_fields.unit.values,
        },
      );
  }
  return withEvents(context.db, async (tx) => {
    const { table, docs: before } = await load(tx, context, element);
    const description =
      input.description === undefined
        ? before.description
        : input.description?.trim() || null;
    const custom = input.custom ?? before.custom;
    const fields: BuiltInValues = {};
    for (const field of own) {
      const given = input[field];
      fields[field] =
        given === undefined ? (before[field] ?? null) : given?.trim() || null;
    }
    if (
      description === before.description &&
      isDeepStrictEqual(custom, before.custom) &&
      own.every((field) => fields[field] === before[field])
    ) {
      return before;
    }
    const written = {
      ...fields,
      description,
      custom,
      described_by: context.principal.id,
      described_at: context.clock(),
    };
    await tx.update(table).set(written).where(eq(table.id, element.id));
    const after = { ...before, ...written };
    await recordBookChange(tx, {
      principal: context.principal,
      element_kind: element.kind,
      element_id: element.id,
      action: "docs",
      before,
      after,
    });
    return after;
  });
}

/** The visible documentation gaps, with a stable name/id keyset like the mirror lists. */
export async function docsChecks(
  context: ServiceContext,
  filters: { dataset?: string; limit?: number; cursor?: string } = {},
) {
  const allowed = await context.access.describableDatasets(context.principal);
  const conventions = await currentConventions(context.db);
  const rows = await checkedElements(
    context,
    { conventions, exceptions: exceptionIndex(conventions) },
    allowed,
    !(await readsPii(context)),
  );
  let dataset: string | undefined;
  if (filters.dataset !== undefined) {
    const found = rows.find(
      (row) =>
        row.kind === "dataset" &&
        (row.name === filters.dataset || row.id === filters.dataset),
    );
    if (found === undefined)
      throw new ServiceError("not_found", NO_SUCH_DATASET);
    dataset = found.name;
  }
  const failures = rows.filter(
    (row) =>
      (dataset === undefined || row.dataset === dataset) &&
      row.results.some((result) => !result.passed),
  );
  const nameOf = (row: CheckedElement) =>
    JSON.stringify([row.dataset, row.kind, row.table ?? "", row.name]);
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  failures.sort((a, b) => compare(nameOf(a), nameOf(b)) || compare(a.id, b.id));
  let after: [string, string] | undefined;
  if (filters.cursor !== undefined) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        Buffer.from(filters.cursor, "base64url").toString("utf8"),
      );
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    const parsed = z
      .tuple([z.string().refine((value) => !value.includes("\0")), z.guid()])
      .safeParse(decoded);
    if (!parsed.success)
      throw new ServiceError(
        "invalid",
        "That cursor is not one a list gave. Ask again without it.",
      );
    after = parsed.data;
  }
  const remaining =
    after === undefined
      ? failures
      : failures.filter((row) => {
          const order = compare(nameOf(row), after[0]);
          return order > 0 || (order === 0 && compare(row.id, after[1]) > 0);
        });
  const exceptions = await visibleExceptions(context, conventions.exceptions);
  const unused = await unusedExceptions(
    context,
    { ...conventions, exceptions },
    dataset === undefined ? undefined : { dataset },
  );
  const page = pageBy(remaining, sizeOf(filters.limit), nameOf);
  return {
    ...page,
    items: page.items.map(({ kind, id, name, dataset, table, results }) => ({
      kind,
      id,
      name,
      dataset,
      ...(table === undefined ? {} : { table }),
      results,
    })),
    failing: failures.length,
    unused_exceptions: unused,
  };
}
