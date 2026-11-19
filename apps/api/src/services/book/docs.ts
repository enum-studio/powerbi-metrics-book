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
import { appsSeen } from "../mirror/read.js";
import { piiColumn, piiMeasure, readsPii } from "../pii/rules.js";
import { recordBookChange, requireCurator } from "./changes.js";
import { checkCustom } from "./checks.js";

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

/** Where each kind is kept, Power BI's own description (a workspace has none) and how it is reached through a dataset. */
export const KINDS: Record<
  string,
  {
    table: DocTable;
    pbi: PgColumn | null;
    /** The built-in fields of the kind, each with its column; a kind without any has none. */
    built: Record<string, TextColumn>;
    reach: (db: Db, allowed: SQL, apps: SQL | undefined) => SQL | undefined;
  }
> = {
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
};

const DOC_KINDS = Object.keys(KINDS);

export type BuiltInField =
  | "when_to_use"
  | "owner"
  | "freshness"
  | "caveats"
  | "grain_and_filters"
  | "unit"
  | "blank_means";
export type BuiltInValues = Partial<Record<BuiltInField, string | null>>;

/** Every built-in field of any kind. */
const ALL_FIELDS = [
  ...new Set(Object.values(KINDS).flatMap((k) => Object.keys(k.built))),
] as BuiltInField[];

const fieldsOf = (kind: string): BuiltInField[] =>
  Object.keys(
    (Object.hasOwn(KINDS, kind) ? KINDS[kind]?.built : undefined) ?? {},
  ) as BuiltInField[];

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
  const kind = Object.hasOwn(KINDS, element.kind)
    ? KINDS[element.kind]
    : undefined;
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
  const built: Record<string, PgColumn> = {};
  for (const field of fieldsOf(element.kind)) {
    const column = (table as unknown as Record<string, PgColumn>)[field];
    if (column !== undefined) built[field] = column;
  }
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
  const fields: BuiltInValues = {};
  for (const field of fieldsOf(element.kind))
    fields[field] = row.built[field] ?? null;
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
 * the conventions' element_fields; one the conventions require and the
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
  for (const field of ALL_FIELDS) {
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
    const { element_fields } = await currentConventions(context.db);
    checkCustom(element_fields.custom, input.custom);
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
