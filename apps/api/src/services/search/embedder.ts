import { setTimeout as sleep } from "node:timers/promises";
import type { AppDeps } from "../../context.js";
import {
  EMBEDDING_DIMENSIONS,
  embeddingUsage,
} from "../../db/schema/search.js";
import { EMBEDDING_HOSTS } from "../../deps.js";
import { type ErrorKind, ServiceError } from "../../errors.js";
import { retryAfterSeconds } from "../../powerbi/errors.js";
import { gemini } from "./gemini.js";
import { openAi } from "./openai.js";

/*
 * The embedding provider is a third party that sees the book's names,
 * descriptions, display folders and term values (never DAX, a query result or
 * a thread's text). What it answers is data: vectors and a token count are
 * read from it, and no other text of its is kept, logged or put in an error.
 * The key goes only in a request header.
 */

export type Provider = "openai" | "gemini";
export type Purpose = "document" | "query";

export interface Embedder {
  provider: Provider;
  model: string;
  dimensions: 1536;
  embed(texts: string[], purpose: Purpose): Promise<number[][]>;
}

/** What one provider's HTTP API looks like; openai.ts and gemini.ts each give one, and this module does the calling. */
export type Wire = {
  /** Splits texts into the calls the provider allows. */
  batches(texts: string[]): string[][];
  request(call: {
    texts: string[];
    purpose: Purpose;
    model: string;
    base: string;
    key: string;
  }): { url: string; headers: Record<string, string>; body: unknown };
  /** The vectors and the tokens billed, or null when the answer is not the shape the provider documents. */
  read(answer: unknown): { vectors: number[][]; tokens: number } | null;
};

/** The `detail.code` of every ServiceError this module throws; the setup check words each one. */
export const EMBEDDING_FAILURE_CODES = [
  "key_missing",
  "key_refused",
  "rate_limited",
  "provider_failed",
  "request_refused",
  "bad_answer",
] as const;
export type EmbeddingFailureCode = (typeof EMBEDDING_FAILURE_CODES)[number];

function failure(
  kind: ErrorKind,
  code: EmbeddingFailureCode,
  message: string,
  status?: number,
): ServiceError {
  return new ServiceError(
    kind,
    message,
    status === undefined ? { code } : { code, status },
  );
}

/** The code of one of this module's failures; null for any other error. */
export function failureCode(error: unknown): EmbeddingFailureCode | null {
  if (!(error instanceof ServiceError)) return null;
  return (
    EMBEDDING_FAILURE_CODES.find((code) => code === error.detail.code) ?? null
  );
}

/**
 * One fixed sentence with nothing of the company's in it. The setup check
 * embeds it to see that the provider answers, and the embed job embeds it to
 * tell a refused request from a refused text.
 */
export const EMBEDDING_PROBE_SENTENCE =
  "Net sales by month, in euros, for last year.";

export const DEFAULT_MODELS = {
  openai: "text-embedding-3-large",
  gemini: "gemini-embedding-2",
} as const satisfies Record<Provider, string>;

/**
 * Micro-dollars per million tokens, so a call's cost is an integer: OpenAI's
 * text-embedding-3-large is $0.13 and Google's gemini-embedding-2 is $0.20 per
 * million tokens. Read on 25 October 2026 (the spec's Search section). Another
 * model of the same provider is counted at its rate.
 */
const MICRO_USD_PER_MILLION_TOKENS = {
  openai: 130_000,
  gemini: 200_000,
} as const satisfies Record<Provider, number>;

/** Rounded up, so spend is never counted short. */
export function costMicroUsd(provider: Provider, tokens: number): number {
  return Math.ceil(
    (tokens * MICRO_USD_PER_MILLION_TOKENS[provider]) / 1_000_000,
  );
}

/** About four characters to a token, for the English most descriptions are in: an estimate of what a text costs, never what a call is limited by. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export type EmbedderDeps = Pick<
  AppDeps,
  "db" | "settings" | "secrets" | "fetcher" | "clock"
>;

const NAMES = { openai: "OpenAI", gemini: "Google" } as const;
const WIRES = { openai: openAi, gemini: gemini } as const;
const MIB = 1024 * 1024;
/** A batch of vectors is JSON, and 32 MiB is the guarded fetcher's ceiling. */
const LIMITS = { timeout_ms: 60_000, max_bytes: 32 * MIB };
/** A search waits on one query's vector: a slow provider costs it its meaning, not its answer. */
const QUERY_LIMITS = { timeout_ms: 5_000, max_bytes: MIB };
/** However long a provider says to wait, a run waits this long at most. */
const RETRY_AFTER_MAX_SECONDS = 60;
const RETRY_AFTER_DEFAULT_SECONDS = 1;
/** The largest number embedding_usage.tokens holds. */
const INT4_MAX = 2_147_483_647;

/** The sentence for a refusal: fixed text and the status, never the provider's body. */
function refusal(provider: Provider, status: number): ServiceError {
  const who = NAMES[provider];
  if (status === 401 || status === 403)
    return failure(
      "upstream",
      "key_refused",
      `${who} refused the API key.`,
      status,
    );
  if (status === 429)
    return failure(
      "rate_limited",
      "rate_limited",
      `${who} is rate limiting this key. Try again in a few minutes.`,
      status,
    );
  if (status >= 500)
    return failure(
      "upstream",
      "provider_failed",
      `${who} failed with HTTP ${String(status)}. Try again later.`,
      status,
    );
  return failure(
    "upstream",
    "request_refused",
    `${who} refused the request with HTTP ${String(status)}. Check the key, the model name and the address.`,
    status,
  );
}

const badAnswer = (provider: Provider, detail: string) =>
  failure("upstream", "bad_answer", `${NAMES[provider]} ${detail}`);

/**
 * POSTs JSON and answers the parsed body of a 2xx. Documents wait out one
 * 429; a query does not, as a person is waiting on it.
 */
async function post(
  deps: EmbedderDeps,
  provider: Provider,
  request: ReturnType<Wire["request"]>,
  purpose: Purpose,
): Promise<unknown> {
  const call = async () => {
    try {
      return await deps.fetcher.fetchFixed(request.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...request.headers },
        body: JSON.stringify(request.body),
        ...(purpose === "query" ? QUERY_LIMITS : LIMITS),
      });
    } catch (error) {
      // The fetcher's own sentence (a timeout, a redirect, a host off its
      // list) is kept for the setup check and the embed job's run, which an
      // admin reads; the code lets search answer by words without it.
      if (!(error instanceof ServiceError)) throw error;
      throw failure("upstream", "provider_failed", error.message);
    }
  };
  let response = await call();
  if (response.status === 429 && purpose === "document") {
    await response.body?.cancel();
    const seconds = retryAfterSeconds(response) ?? RETRY_AFTER_DEFAULT_SECONDS;
    await sleep(Math.min(seconds, RETRY_AFTER_MAX_SECONDS) * 1000);
    response = await call();
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw refusal(provider, response.status);
  }
  try {
    return await response.json();
  } catch {
    // A parse error's message quotes the start of the body, so it is not kept.
    throw badAnswer(provider, "answered with something that is not JSON.");
  }
}

/** One vector per text, of the width the book stores, every number a unit vector may hold, and a token count the usage row can hold. */
function acceptable(
  answer: ReturnType<Wire["read"]>,
  texts: number,
): answer is NonNullable<typeof answer> {
  return (
    answer !== null &&
    answer.vectors.length === texts &&
    Number.isInteger(answer.tokens) &&
    answer.tokens >= 0 &&
    answer.tokens <= INT4_MAX &&
    answer.vectors.every(
      (vector) =>
        vector.length === EMBEDDING_DIMENSIONS &&
        vector.every((value) => value >= -1 && value <= 1),
    )
  );
}

/**
 * The embedder the settings name, or null for provider `none`. Throws a
 * ServiceError (code `key_missing`) when the provider's key is not set.
 * `search.base_url` empty means the provider's own host. Every call is
 * counted in embedding_usage, after its answer has been checked.
 */
export async function createEmbedder(
  deps: EmbedderDeps,
): Promise<Embedder | null> {
  const provider = await deps.settings.get("search.provider");
  if (provider === "none") return null;
  const key = await deps.secrets.read(`${provider}_api_key`);
  if (key === null)
    throw failure(
      "conflict",
      "key_missing",
      `Enter the ${NAMES[provider]} API key first.`,
    );
  const model =
    (await deps.settings.get("search.model")) ?? DEFAULT_MODELS[provider];
  const base = (
    (await deps.settings.get("search.base_url")) ?? EMBEDDING_HOSTS[provider]
  ).replace(/\/+$/, "");
  const wire = WIRES[provider];
  return {
    provider,
    model,
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(texts, purpose) {
      const vectors: number[][] = [];
      for (const batch of wire.batches(texts)) {
        const request = wire.request({
          texts: batch,
          purpose,
          model,
          base,
          key,
        });
        const answer = wire.read(await post(deps, provider, request, purpose));
        if (!acceptable(answer, batch.length))
          throw badAnswer(
            provider,
            `did not answer ${String(batch.length)} vectors of ${String(EMBEDDING_DIMENSIONS)} numbers.`,
          );
        await deps.db.insert(embeddingUsage).values({
          at: deps.clock(),
          provider,
          model,
          tokens: answer.tokens,
          cost_micro_usd: costMicroUsd(provider, answer.tokens),
          purpose,
        });
        vectors.push(...answer.vectors);
      }
      return vectors;
    },
  };
}
