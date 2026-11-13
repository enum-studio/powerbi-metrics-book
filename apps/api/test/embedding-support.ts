import {
  type MockPowerBiHandle,
  sampleTenant,
  startMockPowerBi,
} from "@powerbi-metrics-book/powerbi-mock";
import { afterAll, beforeAll } from "vitest";
import type {
  Container,
  Db,
  GuardedFetcher,
  SecretName,
  SettingValues,
} from "../src/context.js";
import { createGuardedFetcher } from "../src/http/fetcher.js";
import type { Provider } from "../src/services/search/embedder.js";
import { closeTestPools, createTestDeps } from "./deps.js";
import { MemorySecrets, MemorySettings, refusingFetcher } from "./doubles.js";

/*
 * The embedders' tests: the mock's embedding routes, and deps whose guarded
 * fetcher reaches only the mock and remembers each request it was given.
 */

// Invented, and only ever sent to the mock or a test double.
export const KEY = "test-key-not-a-secret";
/** What a provider might say in an error body, which no error or log may repeat. */
export const WORDS = "SAMPLE-PROVIDER-WORDS";

let mock: MockPowerBiHandle | undefined;

/** Starts the mock for the file's tests, and ends it and the pools after them. */
export function useEmbeddingMock(): void {
  beforeAll(async () => {
    mock = await startMockPowerBi({ tenant: sampleTenant() });
  });
  afterAll(async () => {
    await mock?.close();
    mock = undefined;
    await closeTestPools();
  });
}

export function mockOrigin(): string {
  if (mock === undefined) throw new Error("useEmbeddingMock is not set up");
  return mock.url;
}

export type Sent = {
  url: string;
  headers: Record<string, string>;
  body: { model?: string; input?: string[]; requests?: unknown[] };
};

/** How many texts a request carries, in either provider's shape. */
export function sizeOf(call: Sent | undefined): number {
  if (call === undefined) throw new Error("the provider was not called");
  return (call.body.input ?? call.body.requests ?? []).length;
}

/** Deps whose fetcher reaches the mock's embedding routes, and remembers each request. */
export function embeddingDeps(
  tx: Db,
  provider: Provider | "none",
  more: Partial<SettingValues> = {},
  keys: [SecretName, string][] = [
    ["openai_api_key", KEY],
    ["gemini_api_key", KEY],
  ],
  container: Container = "worker",
) {
  const origin = mockOrigin();
  const sent: Sent[] = [];
  const inner = createGuardedFetcher({
    allowedOrigins: () => Promise.resolve([origin]),
    nodeEnv: "test",
  });
  const fetcher: GuardedFetcher = {
    ...inner,
    fetchFixed(url, init) {
      if (typeof init?.body !== "string")
        throw new Error("the embedder sent no JSON body");
      sent.push({
        url: String(url),
        headers: init.headers as Record<string, string>,
        body: JSON.parse(init.body) as Sent["body"],
      });
      return inner.fetchFixed(url, init);
    },
  };
  const settings = new MemorySettings({
    "search.provider": provider,
    "search.base_url": `${origin}/${provider}`,
    ...more,
  });
  return {
    sent,
    settings,
    deps: createTestDeps({
      container,
      db: tx,
      fetcher,
      settings,
      secrets: new MemorySecrets(keys),
    }),
  };
}

/** A fetcher that answers each call with the next response, and counts them. */
export function scripted(...responses: Response[]) {
  let calls = 0;
  const fetcher: GuardedFetcher = {
    ...refusingFetcher,
    fetchFixed() {
      const response = responses[calls++];
      if (response === undefined) throw new Error("more calls than answers");
      return Promise.resolve(response);
    },
  };
  return { fetcher, calls: () => calls };
}

/** Unit vectors: pgvector's cosine index takes no zero vector. */
export const unitVectors = (n: number) =>
  Array.from({ length: n }, () =>
    Array.from({ length: 1536 }, (_, at): number => (at === 0 ? 1 : 0)),
  );

/** An OpenAI answer for n texts, as the provider documents it. */
export const openAiAnswer = (n: number, tokens = 5) =>
  Response.json({
    data: unitVectors(n).map((embedding, index) => ({ index, embedding })),
    usage: { total_tokens: tokens },
  });
