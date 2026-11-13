import { createHash } from "node:crypto";
import { conceptKey, tokens } from "./concepts.js";

/**
 * A unit-length vector that depends on the text's meaning alone, with no
 * model: each word, or the concept it shares with its synonyms (see
 * `CONCEPTS`), gets a hashed unit vector, and the answer is their normalised
 * sum. Texts sharing concepts have a high cosine similarity; unrelated texts
 * stay near zero. The same text always answers the same vector. A text with
 * no words left, or whose words cancel out, is hashed whole instead.
 */
export function embeddingFor(text: string, dimensions: number): number[] {
  const sum = new Array<number>(dimensions).fill(0);
  for (const word of tokens(text)) {
    hashedVector(conceptKey(word), dimensions).forEach((value, at) => {
      sum[at] = (sum[at] ?? 0) + value;
    });
  }
  if (Math.hypot(...sum) < 1e-9)
    return hashedVector(`text:${text}`, dimensions);
  return unit(sum);
}

function unit(values: number[]): number[] {
  const length = Math.hypot(...values);
  return values.map((value) => value / length);
}

/** The hashed unit vector of one key: its SHA-256 seeds a stream of further hashes, four bytes of which make a component. */
function hashedVector(key: string, dimensions: number): number[] {
  const seed = createHash("sha256").update(key).digest();
  const values: number[] = [];
  for (let block = 0; values.length < dimensions; block++) {
    const bytes = createHash("sha256")
      .update(seed)
      .update(String(block))
      .digest();
    for (let at = 0; at < bytes.length && values.length < dimensions; at += 4) {
      values.push(bytes.readUInt32BE(at) / 2 ** 31 - 1);
    }
  }
  return unit(values);
}

/** Words times 1.3, rounded up, in integers so that ten words are 13 and not 14. */
export function tokenCount(texts: string[]): number {
  const words = texts.reduce(
    (sum, text) => sum + text.split(/\s+/).filter(Boolean).length,
    0,
  );
  return Math.ceil((words * 13) / 10);
}
