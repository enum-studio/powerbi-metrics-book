import { z } from "zod";
import { EMBEDDING_DIMENSIONS } from "../../db/schema/search.js";
import type { Wire } from "./embedder.js";

/*
 * https://platform.openai.com/docs/api-reference/embeddings/create: one POST
 * to /v1/embeddings takes up to 2,048 texts and 300,000 tokens in all, and
 * `dimensions` shortens text-embedding-3's vector to the width the book stores.
 */

const MAX_TOKENS_PER_CALL = 300_000;
/**
 * Fewer than the 2,048 OpenAI allows: a vector is about 30 KB of JSON, and the
 * guarded fetcher reads at most 32 MiB of an answer.
 */
const MAX_TEXTS_PER_CALL = 500;

/**
 * A tokenizer makes at most one token of each UTF-8 byte, so a call whose
 * texts hold 300,000 bytes cannot pass the token limit, in any language.
 */
function batches(texts: string[]): string[][] {
  const calls: string[][] = [];
  let bytes = 0;
  for (const text of texts) {
    const size = Buffer.byteLength(text);
    const last = calls.at(-1);
    if (
      last === undefined ||
      last.length === MAX_TEXTS_PER_CALL ||
      bytes + size > MAX_TOKENS_PER_CALL
    ) {
      calls.push([text]);
      bytes = size;
    } else {
      last.push(text);
      bytes += size;
    }
  }
  return calls;
}

const answerSchema = z.object({
  data: z.array(
    z.object({ index: z.number().int(), embedding: z.array(z.number()) }),
  ),
  usage: z.object({ total_tokens: z.number().int().nonnegative() }),
});

export const openAi: Wire = {
  batches,
  request: ({ texts, model, base, key }) => ({
    url: `${base}/v1/embeddings`,
    headers: { authorization: `Bearer ${key}` },
    body: { model, input: texts, dimensions: EMBEDDING_DIMENSIONS },
  }),
  read(answer) {
    const parsed = answerSchema.safeParse(answer);
    if (!parsed.success) return null;
    const ordered = [...parsed.data.data].sort((a, b) => a.index - b.index);
    // The indexes are exactly 0..n-1, or a vector could end up on another text.
    if (ordered.some((item, at) => item.index !== at)) return null;
    return {
      vectors: ordered.map((item) => item.embedding),
      tokens: parsed.data.usage.total_tokens,
    };
  },
};
