import { isNotNull, sql } from "drizzle-orm";
import { beforeAll } from "vitest";
import type {
  AppDeps,
  Db,
  ServiceContext,
  SettingValues,
} from "../src/context.js";
import { createDb } from "../src/db/client.js";
import { searchDocument } from "../src/db/schema/search.js";
import type { Principal } from "../src/principal.js";
import { draftDatasets } from "../src/services/book/drafter.js";
import { runEmbed } from "../src/services/search/embed-job.js";
import { TEST_RUNNER } from "./database.js";
import { cerbosAccess, createTestDeps, principals, testPool } from "./deps.js";
import { embeddingDeps, useEmbeddingMock } from "./embedding-support.js";
import {
  loadSampleMirror,
  rolledBack,
  type SampleMirror,
  setRole,
} from "./sample-mirror.js";

/*
 * Search's tests: the sample tenant as a full sync stores it, drafted under
 * the default conventions, its documents built and embedded by the worker's
 * job through the mock, and contexts that search as the api does, asking
 * this checkout's Cerbos. A test file using it calls useSearchable().
 *
 * Building that takes about 1,000 statements, one after another, and each one
 * crosses Docker's published port. At 30 ms a round trip, which a busy machine
 * reaches, they spend a test's whole 30 seconds. So a file builds it once and
 * commits it to its own database (test/file-database.ts), and each test runs in
 * a transaction that is rolled back.
 */

/** A build's own limit, not a test's: no assertion runs under it. */
const BUILD_TIMEOUT_MS = 120_000;

let built: SampleMirror | undefined;

/** Starts the mock and builds the sample for the file's tests. */
export function useSearchable(): void {
  useEmbeddingMock();
  beforeAll(async () => {
    await createDb(testPool(TEST_RUNNER)).transaction(async (tx) => {
      await setRole(tx, "worker_rw");
      const sample = await loadSampleMirror(tx);
      await draftDatasets(
        createTestDeps({ container: "worker", db: tx }),
        sample.tenant.datasets.map((dataset) => dataset.id),
      );
      await runEmbed(embeddingDeps(tx, "openai").deps, {
        changes_only: false,
      });
      // Every test's planner reads these, not what autovacuum's analyze finds
      // part way through the file.
      await tx.execute(sql`set local role migrator`);
      await tx.execute(sql`analyze`);
      built = sample;
    });
  }, BUILD_TIMEOUT_MS);
}

type Lists = Partial<
  Record<
    "powerbi_workspace_ids" | "powerbi_app_ids" | "powerbi_dataset_ids",
    string[]
  >
>;

/** A signed-in viewer who reaches what the lists name. */
export const person = (lists: Lists = {}): Principal => ({
  ...principals.viewer,
  attributes: { ...principals.viewer.attributes, ...lists },
});

/** A service account its admin gave the workspaces and apps the lists name. */
export const serviceAccount = (lists: Lists): Principal => ({
  ...person(lists),
  kind: "service_account",
  id: "test-service-account",
  via: "api",
});

export type Searchable = {
  /** The test's transaction, acting as api_rw. */
  tx: Db;
  sample: SampleMirror;
  /** The id of the sample's workspace, app or dataset of that name. */
  idOf(kind: "workspaces" | "apps" | "datasets", name: string): string;
  /** Runs the embed job again as the worker, after a change to the book or the mirror. */
  index(): Promise<void>;
  /** A context of the api, searching as the principal. */
  as(principal: Principal, overrides?: Partial<AppDeps>): ServiceContext;
};

export function searchable(
  options: {
    provider: "openai" | "none";
    mode?: SettingValues["access.metadata_visibility"];
    policies?: "defaults" | "override";
  },
  work: (s: Searchable) => Promise<void>,
): Promise<void> {
  const sample = built;
  if (sample === undefined)
    throw new Error("this test file must call useSearchable()");
  return rolledBack(TEST_RUNNER, async (tx) => {
    await setRole(tx, "worker_rw");
    // With no provider the job embeds nothing, so a document has no vector.
    if (options.provider === "none")
      await tx
        .update(searchDocument)
        .set({ embedding: null, embedding_model: null, embedding_hash: null })
        .where(isNotNull(searchDocument.embedding_hash));
    const worker = embeddingDeps(tx, options.provider).deps;
    const index = async () => {
      await setRole(tx, "worker_rw");
      await runEmbed(worker, { changes_only: false });
      await setRole(tx, "api_rw");
    };
    await setRole(tx, "api_rw");
    const api = embeddingDeps(
      tx,
      options.provider,
      { "access.metadata_visibility": options.mode ?? "powerbi" },
      undefined,
      "api",
    );
    const access = cerbosAccess(api.settings, options.policies);
    await work({
      tx,
      sample,
      idOf(kind, name) {
        const found = sample.tenant[kind].find((item) => item.name === name);
        if (found === undefined) throw new Error(`The sample has no ${name}`);
        return found.id;
      },
      index,
      as: (principal, overrides = {}) => ({
        ...api.deps,
        access,
        ...overrides,
        principal,
      }),
    });
  });
}
