import { z } from "zod";
import { EMBEDDING_DIMENSIONS } from "../../db/schema/search.js";
import type { Wire } from "./embedder.js";

/*
 * https://ai.google.dev/api/embeddings (models.batchEmbedContents) and
 * https://ai.google.dev/gemini-api/docs/embeddings, read on 26 October 2026.
 * gemini-embedding-2 takes no task_type: its guide says to put the task in the
 * text, `task: search result | query: {content}` for a query and
 * `title: {title} | text: {content}` for a document, `title: none` when there
 * is no title. A truncated output (outputDimensionality 1536) comes
 * normalised. A text over 8,192 tokens is cut short silently.
 */

/** The API refuses a batch of more than 100 requests. */
const MAX_TEXTS_PER_CALL = 100;

const PREFIXES = {
  query: "task: search result | query: ",
  document: "title: none | text: ",
} as const;

function batches(texts: string[]): string[][] {
  const calls: string[][] = [];
  for (let at = 0; at < texts.length; at += MAX_TEXTS_PER_CALL)
    calls.push(texts.slice(at, at + MAX_TEXTS_PER_CALL));
  return calls;
}

const answerSchema = z.object({
  embeddings: z.array(z.object({ values: z.array(z.number()) })),
  usageMetadata: z.object({ promptTokenCount: z.number().int().nonnegative() }),
});

export const gemini: Wire = {
  batches,
  request: ({ texts, purpose, model, base, key }) => ({
    url: `${base}/v1beta/models/${encodeURIComponent(model)}:batchEmbedContents`,
    headers: { "x-goog-api-key": key },
    body: {
      requests: texts.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text: PREFIXES[purpose] + text }] },
        outputDimensionality: EMBEDDING_DIMENSIONS,
      })),
    },
  }),
  read(answer) {
    const parsed = answerSchema.safeParse(answer);
    if (!parsed.success) return null;
    return {
      vectors: parsed.data.embeddings.map((item) => item.values),
      tokens: parsed.data.usageMetadata.promptTokenCount,
    };
  },
};
