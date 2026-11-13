import { describe, expect, it } from "vitest";
import { embeddingRoutes } from "./routes.js";

const app = embeddingRoutes();

type OpenAiAnswer = {
  data: { index: number; embedding: number[] }[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
  error?: {
    type: string;
    message: string;
    param: string | null;
    code: string | null;
  };
};
type GeminiAnswer = {
  embeddings: { values: number[] }[];
  usageMetadata: { promptTokenCount: number };
  error?: { code: number; status: string };
};

async function openAi(
  body: unknown,
  headers: Record<string, string> = { authorization: "Bearer sk-test" },
) {
  const response = await app.request("http://mock.test/openai/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as OpenAiAnswer,
  };
}

async function gemini(
  body: unknown,
  headers: Record<string, string> = { "x-goog-api-key": "key" },
) {
  const response = await app.request(
    "http://mock.test/gemini/v1beta/models/gemini-embedding-2:batchEmbedContents",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
  );
  return {
    status: response.status,
    body: (await response.json()) as GeminiAnswer,
  };
}

const length = (vector: number[]) => Math.hypot(...vector);

describe("POST /openai/v1/embeddings", () => {
  it("answers one unit vector of the asked dimension for a string, the same every time", async () => {
    const request = {
      model: "text-embedding-3-large",
      input: "total net sales",
      dimensions: 1536,
    };

    const first = await openAi(request);
    const second = await openAi(request);

    expect(first.status).toBe(200);
    const [only] = first.body.data;
    expect(only?.embedding).toHaveLength(1536);
    expect(length(only?.embedding ?? [])).toBeCloseTo(1, 6);
    expect(second.body.data[0]?.embedding).toEqual(only?.embedding);
    expect(first.body.model).toBe("text-embedding-3-large");
  });

  it("answers an array in order, one vector per text, and counts tokens as words times 1.3 rounded up", async () => {
    const { body } = await openAi({
      model: "text-embedding-3-large",
      input: [
        "one two three four five six seven eight nine ten",
        "gross margin",
      ],
      dimensions: 8,
    });

    expect(body.data.map((item) => item.index)).toEqual([0, 1]);
    expect(body.data[0]?.embedding).not.toEqual(body.data[1]?.embedding);
    // 12 words * 1.3 = 15.6, rounded up. Ten words alone would be exactly 13.
    expect(body.usage).toEqual({ prompt_tokens: 16, total_tokens: 16 });
  });

  it("gives text-embedding-3-large its own default of 3072 dimensions", async () => {
    const { body } = await openAi({
      model: "text-embedding-3-large",
      input: "x",
    });

    expect(body.data[0]?.embedding).toHaveLength(3072);
  });

  it("answers 401 in OpenAI's error shape without a key", async () => {
    const { status, body } = await openAi({ model: "m", input: "x" }, {});

    expect(status).toBe(401);
    expect(body.error).toMatchObject({
      type: "invalid_request_error",
      param: null,
      code: null,
    });
  });

  it("refuses an empty input and more than 2048 texts", async () => {
    const empty = await openAi({ model: "m", input: [] });
    const many = await openAi({
      model: "m",
      input: Array.from({ length: 2049 }, () => "x"),
      dimensions: 4,
    });

    expect(empty.status).toBe(400);
    expect(empty.body.error).toMatchObject({
      type: "invalid_request_error",
      param: "input",
    });
    expect(many.status).toBe(400);
  });

  it("refuses a request with no model", async () => {
    const { status, body } = await openAi({ input: "x" });

    expect(status).toBe(400);
    expect(body.error?.param).toBe("model");
  });

  it("refuses dimensions below 1 or above 3072, and answers the edges", async () => {
    const ask = (dimensions: number) =>
      openAi({ model: "text-embedding-3-large", input: "x", dimensions });

    for (const dimensions of [0, -1, 1.5, 3073, 200_000]) {
      const { status, body } = await ask(dimensions);
      expect(status, `dimensions ${String(dimensions)}`).toBe(400);
      expect(body.error).toMatchObject({
        type: "invalid_request_error",
        param: "dimensions",
      });
    }
    expect((await ask(1)).body.data[0]?.embedding).toHaveLength(1);
    expect((await ask(3072)).body.data[0]?.embedding).toHaveLength(3072);
  });
});

describe("POST /gemini/v1beta/models/{model}:batchEmbedContents", () => {
  const request = (text: string, outputDimensionality = 1536) => ({
    model: "models/gemini-embedding-2",
    content: { parts: [{ text }] },
    outputDimensionality,
  });

  it("answers one unit vector per request, of the dimension each asked, with usage", async () => {
    const { status, body } = await gemini({
      requests: [request("net sales"), request("gross margin", 16)],
    });

    expect(status).toBe(200);
    expect(body.embeddings.map((embedding) => embedding.values.length)).toEqual(
      [1536, 16],
    );
    expect(length(body.embeddings[0]?.values ?? [])).toBeCloseTo(1, 6);
    expect(body.usageMetadata.promptTokenCount).toBe(6);
  });

  it("answers the same vector for the same text, and another for another", async () => {
    const { body } = await gemini({
      requests: [
        request("net sales", 32),
        request("net sales", 32),
        request("margin", 32),
      ],
    });

    expect(body.embeddings[1]?.values).toEqual(body.embeddings[0]?.values);
    expect(body.embeddings[2]?.values).not.toEqual(body.embeddings[0]?.values);
  });

  it("answers 401 in Google's error shape without a key", async () => {
    const { status, body } = await gemini({ requests: [request("x")] }, {});

    expect(status).toBe(401);
    expect(body.error).toMatchObject({ code: 401, status: "UNAUTHENTICATED" });
  });

  it("refuses a request with no text", async () => {
    const { status, body } = await gemini({
      requests: [{ content: { parts: [{}] } }],
    });

    expect(status).toBe(400);
    expect(body.error?.status).toBe("INVALID_ARGUMENT");
  });

  it("refuses outputDimensionality below 1 or above 3072, and answers the edges", async () => {
    for (const dimensionality of [0, -1, 1.5, 3073, 200_000]) {
      const { status, body } = await gemini({
        requests: [request("x", dimensionality)],
      });
      expect(status, `outputDimensionality ${String(dimensionality)}`).toBe(
        400,
      );
      expect(body.error).toMatchObject({
        code: 400,
        status: "INVALID_ARGUMENT",
      });
    }
    const edge = await gemini({ requests: [request("x", 3072)] });
    expect(edge.body.embeddings[0]?.values).toHaveLength(3072);
  });
});
