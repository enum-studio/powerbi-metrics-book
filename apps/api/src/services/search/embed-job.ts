import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, lte, max, or } from "drizzle-orm";
import { z } from "zod";
import type { AppDeps } from "../../context.js";
import { bookChange } from "../../db/schema/book.js";
import {
  EMBEDDED_KINDS,
  searchDocument,
  searchState,
} from "../../db/schema/search.js";
import { enqueueUnlessQueued } from "../jobs/queue.js";
import { registerJob } from "../jobs/registry.js";
import { buildDocuments, inScope } from "./documents.js";
import {
  createEmbedder,
  EMBEDDING_PROBE_SENTENCE,
  type Embedder,
  failureCode,
} from "./embedder.js";

/*
 * The embed job. It brings the search documents up to what the book and the
 * mirror hold, then embeds the documents whose text, model or provider differs
 * from what their vector was made from. Words-only search needs no key:
 * documents are built before the embedder is.
 *
 * The sync queues it with no arguments, and it then compares the whole mirror
 * and book, because the mirror changes without a book_change. A change to the
 * book queues it with `changes_only` (services/book/changes.ts), and it then
 * looks only at what book_change names past its cursor, search_state's
 * book_change_id. The cursor moves last, after every vector is stored: a run
 * that fails leaves it, and the next run reads the same changes again. The
 * documents and vectors it stored stay, and their hashes keep them from being
 * paid for twice. They are not held in one transaction with the cursor,
 * because the provider calls would hold it open for minutes, and a rollback
 * would undo embedding_usage, the record of money already spent.
 *
 * A book_change id is given when a change is written and seen when it
 * commits, so a change can commit after a later one was read, with an id below
 * the cursor. The cursor therefore keeps the highest `at` it applied as well,
 * and a run also reads again what was written within LOOKBACK_MS before it.
 */

const PAGE = 500;
/**
 * A curation transaction never stays open this long, so a change that
 * commits late is still within it of the cursor's time; and the sync's own
 * run compares everything anyway. Reading a change again costs nothing: the
 * documents compare equal and the hashes keep a vector from being paid for
 * twice.
 */
const LOOKBACK_MS = 10 * 60 * 1000;
/**
 * How long one run may go on. A run that has spent it stops between two pages
 * with what it has stored, and queues its successor: the hashes tell the
 * successor where to carry on.
 */
export const RUN_BUDGET_MS = 10 * 60 * 1000;

/** What a vector was made from, so a changed text, model or provider is found by comparing. */
export function embeddingHash(
  embedder: Pick<Embedder, "provider" | "model">,
  text: string,
): string {
  return createHash("sha256")
    .update(`${embedder.provider}\n${embedder.model}\n${text}`)
    .digest("hex");
}

export type EmbedRun = {
  documents: number;
  written: number;
  deleted: number;
  embedded: number;
  /** The run spent its budget and queued another for the rest. */
  queued_rest: boolean;
};

type Pending = { id: string; kind: string; element_id: string; text: string };

/**
 * One vector for each document, or null for a document the provider refuses.
 * A refused batch is no proof that a text is at fault: a wrong path, a model
 * the provider does not know, or a key it rejects refuses every request, and a
 * document blamed then would lose its vector for good. So a probe sentence is
 * embedded first. If the probe is refused too, the request is what is wrong,
 * and the run stops with the provider's refusal, keeping no hash on any
 * document. Only when the probe passes are the texts still refused held to be
 * at fault, found by halving the batch. A refusal is logged by element id and
 * kind, never by the text.
 */
async function embedDocuments(
  deps: AppDeps,
  embedder: Embedder,
  rows: Pending[],
): Promise<(number[] | null)[]> {
  try {
    return await embedder.embed(
      rows.map((row) => row.text),
      "document",
    );
  } catch (error) {
    if (failureCode(error) !== "request_refused") throw error;
    try {
      await embedder.embed([EMBEDDING_PROBE_SENTENCE], "document");
    } catch (probe) {
      throw failureCode(probe) === "request_refused" ? error : probe;
    }
    return embedHalves(deps, embedder, rows);
  }
}

/** Halves a batch known to be refused until the texts at fault stand alone: one bad text in 500 costs about 2 * 9 calls. */
async function embedHalves(
  deps: AppDeps,
  embedder: Embedder,
  rows: Pending[],
): Promise<(number[] | null)[]> {
  const [only] = rows;
  if (only !== undefined && rows.length === 1) {
    deps.logger.warn("the provider refused a document", {
      element_id: only.element_id,
      kind: only.kind,
    });
    return [null];
  }
  const middle = Math.ceil(rows.length / 2);
  const vectors: (number[] | null)[] = [];
  for (const half of [rows.slice(0, middle), rows.slice(middle)]) {
    try {
      vectors.push(
        ...(await embedder.embed(
          half.map((row) => row.text),
          "document",
        )),
      );
    } catch (error) {
      if (failureCode(error) !== "request_refused") throw error;
      vectors.push(...(await embedHalves(deps, embedder, half)));
    }
  }
  return vectors;
}

const termColumns = z.object({ columns: z.array(z.string()) });

/**
 * The mirror elements the changes name: a column's, table's or dataset's own
 * documents (a PII rule's `pii_changed` rows name the columns and measures it
 * covers, so their documents leave the index or return), and for a term the
 * columns it linked or unlinked, whose text holds the terms they back. The
 * book's own documents are always compared.
 */
function mirrorElements(
  changes: {
    element_kind: string;
    element_id: string;
    before: unknown;
    after: unknown;
  }[],
): string[] {
  const ids = new Set<string>();
  for (const change of changes) {
    ids.add(change.element_id);
    if (change.element_kind !== "term") continue;
    for (const state of [change.before, change.after]) {
      const parsed = termColumns.safeParse(state);
      for (const column of parsed.success ? parsed.data.columns : [])
        ids.add(column);
    }
  }
  return [...ids].filter((id) => z.guid().safeParse(id).success);
}

export async function runEmbed(
  deps: AppDeps,
  options: { changes_only: boolean },
): Promise<EmbedRun> {
  const deadline = deps.clock().getTime() + RUN_BUDGET_MS;
  const [state] = await deps.db.select().from(searchState);
  const cursor = state?.book_change_id ?? 0;
  const cursorAt = state?.book_change_at ?? null;
  const [latest] = await deps.db
    .select({ id: max(bookChange.id), at: max(bookChange.at) })
    .from(bookChange);
  const upTo = latest?.id ?? cursor;
  let scope: string[] | undefined;
  if (options.changes_only) {
    const lookback =
      cursorAt === null
        ? undefined
        : gt(bookChange.at, new Date(cursorAt.getTime() - LOOKBACK_MS));
    const changes = await deps.db
      .select({
        element_kind: bookChange.element_kind,
        element_id: bookChange.element_id,
        before: bookChange.before,
        after: bookChange.after,
      })
      .from(bookChange)
      .where(
        and(lte(bookChange.id, upTo), or(gt(bookChange.id, cursor), lookback)),
      );
    if (changes.length === 0)
      return {
        documents: 0,
        written: 0,
        deleted: 0,
        embedded: 0,
        queued_rest: false,
      };
    scope = mirrorElements(changes);
  }

  const built = await buildDocuments(deps.db, { element_ids: scope });
  const embedder = await createEmbedder(deps);
  let embedded = 0;
  // A scoped run also takes documents with no hash: after a failed run, or a
  // switch from `none` to a provider, they need not wait for the sync.
  const wanted =
    scope === undefined
      ? undefined
      : or(inScope(scope), isNull(searchDocument.embedding_hash));
  if (embedder !== null) {
    let after = "";
    for (;;) {
      const page = await deps.db
        .select({
          id: searchDocument.id,
          text: searchDocument.search_text,
          kind: searchDocument.kind,
          element_id: searchDocument.element_id,
          hash: searchDocument.embedding_hash,
        })
        .from(searchDocument)
        .where(
          and(
            inArray(searchDocument.kind, EMBEDDED_KINDS),
            gt(searchDocument.id, after),
            wanted,
          ),
        )
        .orderBy(asc(searchDocument.id))
        .limit(PAGE);
      const last = page.at(-1);
      if (last === undefined) break;
      // Only with a page still to do: a run that has just done the last page
      // has nothing to hand on.
      if (deps.clock().getTime() > deadline) {
        // The cursor stays, so the successor reads these changes again.
        await enqueueUnlessQueued(deps.db, {
          job: "embed",
          runner: "worker",
          args: options.changes_only ? { changes_only: true } : {},
          trigger: "schedule",
        });
        return { ...built, embedded, queued_rest: true };
      }
      after = last.id;
      const stale = page
        .map((row) => ({ ...row, expected: embeddingHash(embedder, row.text) }))
        .filter((row) => row.hash !== row.expected);
      if (stale.length === 0) continue;
      const vectors = await embedDocuments(deps, embedder, stale);
      await deps.db.transaction(async (tx) => {
        for (const [at, row] of stale.entries()) {
          const embedding = vectors[at];
          if (embedding === undefined)
            throw new Error(`the embedder gave no vector for ${row.id}`);
          // A refused text keeps a null vector, and its hash, so it is not
          // asked for again until its text or the model changes.
          await tx
            .update(searchDocument)
            .set({
              embedding,
              embedding_model: embedder.model,
              embedding_hash: row.expected,
            })
            .where(eq(searchDocument.id, row.id));
        }
      });
      embedded += vectors.filter((vector) => vector !== null).length;
    }
  }
  await deps.db
    .insert(searchState)
    .values({ book_change_id: upTo, book_change_at: latest?.at ?? cursorAt })
    .onConflictDoUpdate({
      target: searchState.id,
      set: { book_change_id: upTo, book_change_at: latest?.at ?? cursorAt },
    });
  return { ...built, embedded, queued_rest: false };
}

registerJob("embed", "worker", async (deps, parameters) => {
  const run = await runEmbed(deps, {
    changes_only: parameters.changes_only === true,
  });
  deps.logger.info("search documents are current", run);
});
