import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
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
 * writes these columns (description, described_by, described_at, custom), and
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

/** Where each kind is kept, Power BI's own description (a workspace has none) and how it is reached through a dataset. */
export const KINDS: Record<
  string,
  {
    table: DocTable;
    pbi: PgColumn | null;
    reach: (db: Db, allowed: SQL, apps: SQL | undefined) => SQL | undefined;
  }
> = {
  workspace: {
    table: powerbiWorkspace,
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
    pbi: powerbiDataset.description_pbi,
    reach: (db, allowed) => inArray(powerbiDataset.id, seen(db, allowed)),
  },
  table: {
    table: powerbiTable,
    pbi: powerbiTable.description_pbi,
    reach: (db, allowed) => inArray(powerbiTable.dataset_id, seen(db, allowed)),
  },
  column: {
    table: powerbiColumn,
    pbi: powerbiColumn.description_pbi,
    reach: (db, allowed) =>
      inArray(powerbiColumn.dataset_id, seen(db, allowed)),
  },
  measure: {
    table: powerbiMeasure,
    pbi: powerbiMeasure.description_pbi,
    reach: (db, allowed) =>
      inArray(powerbiMeasure.dataset_id, seen(db, allowed)),
  },
};

const DOC_KINDS = Object.keys(KINDS);
export type DocElement = { kind: string; id: string };
export type Docs = {
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
  const [row] = await db
    .select({
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
  return {
    table,
    docs: {
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
  input: { description?: string | null; custom?: Record<string, unknown> },
): Promise<Docs> {
  await requireCurator(context);
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
    if (
      description === before.description &&
      isDeepStrictEqual(custom, before.custom)
    ) {
      return before;
    }
    const written = {
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
