import { Hono, type Context } from "hono";
import { isRecord, readJsonObject } from "../entra/context.js";
import { embeddingFor, tokenCount } from "./vector.js";

const OPENAI_MAX_TEXTS = 2048;
const OPENAI_MAX_TOKENS = 300_000;
const OPENAI_DEFAULT_DIMENSIONS = { "text-embedding-3-large": 3072 } as const;
/** The widest vector either provider's models make; also keeps Math.hypot inside its argument limit. */
const MAX_DIMENSIONS = 3072;

/**
 * OpenAI's error body. The type is always `invalid_request_error`, a 401 too:
 * OpenAI's pages show that type and `server_error` and never name an
 * `authentication_error`. The 401 causes are on
 * https://platform.openai.com/docs/guides/error-codes; the error object and
 * its types are in the spec at https://github.com/openai/openai-openapi.
 */
function openAiError(
  c: Context,
  status: 400 | 401,
  message: string,
  field: string | null = null,
): Response {
  return c.json(
    {
      error: {
        message,
        type: "invalid_request_error",
        param: field,
        code: null,
      },
    },
    status,
  );
}

/** Google's error body. */
function geminiError(
  c: Context,
  status: 400 | 401,
  label: "INVALID_ARGUMENT" | "UNAUTHENTICATED",
  message: string,
): Response {
  return c.json({ error: { code: status, message, status: label } }, status);
}

function isDimension(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_DIMENSIONS
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** The text of one batchEmbedContents request: its parts' texts, or null when the shape is wrong. */
function partsOf(request: unknown): string[] | null {
  if (
    !isRecord(request) ||
    !isRecord(request.content) ||
    !Array.isArray(request.content.parts)
  )
    return null;
  const texts = request.content.parts.map((part: unknown) =>
    isRecord(part) ? part.text : undefined,
  );
  return isStringArray(texts) && texts.length > 0 ? texts : null;
}

/** The two embedding providers, answering deterministic vectors for any key. */
export function embeddingRoutes(): Hono {
  const app = new Hono();

  // https://platform.openai.com/docs/api-reference/embeddings/create
  app.post("/openai/v1/embeddings", async (c) => {
    const key = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!key) {
      return openAiError(
        c,
        401,
        "You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth (i.e. Authorization: Bearer YOUR_KEY).",
      );
    }
    const body = await readJsonObject(c);
    if (!body || typeof body.model !== "string") {
      return openAiError(c, 400, "'model' is required.", "model");
    }
    const input = typeof body.input === "string" ? [body.input] : body.input;
    if (
      !isStringArray(input) ||
      input.length === 0 ||
      input.some((text) => text === "")
    ) {
      return openAiError(
        c,
        400,
        "'input' must be a non-empty string or a non-empty array of non-empty strings.",
        "input",
      );
    }
    if (input.length > OPENAI_MAX_TEXTS) {
      return openAiError(
        c,
        400,
        `'$.input' is invalid. An array may hold ${String(OPENAI_MAX_TEXTS)} inputs or fewer.`,
        "input",
      );
    }
    const tokens = tokenCount(input);
    if (tokens > OPENAI_MAX_TOKENS) {
      return openAiError(
        c,
        400,
        `Requested ${String(tokens)} tokens, max ${String(OPENAI_MAX_TOKENS)} tokens per request.`,
        "input",
      );
    }
    const defaults: Record<string, number> = OPENAI_DEFAULT_DIMENSIONS;
    const dimensions = body.dimensions ?? defaults[body.model] ?? 1536;
    if (!isDimension(dimensions)) {
      return openAiError(
        c,
        400,
        `'dimensions' must be an integer from 1 to ${String(MAX_DIMENSIONS)}.`,
        "dimensions",
      );
    }
    return c.json({
      object: "list",
      data: input.map((text, index) => ({
        object: "embedding",
        index,
        embedding: embeddingFor(text, dimensions),
      })),
      model: body.model,
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    });
  });

  // https://ai.google.dev/api/embeddings#method:-models.batchembedcontents
  app.post("/gemini/v1beta/models/:target", async (c) => {
    if (!c.req.param("target").endsWith(":batchEmbedContents")) {
      return geminiError(
        c,
        400,
        "INVALID_ARGUMENT",
        "Only batchEmbedContents is answered.",
      );
    }
    if (!c.req.header("x-goog-api-key")) {
      return geminiError(
        c,
        401,
        "UNAUTHENTICATED",
        "Request is missing required authentication credential. Expected OAuth 2 access token, login cookie or other valid authentication credential.",
      );
    }
    const body = await readJsonObject(c);
    if (!body || !Array.isArray(body.requests) || body.requests.length === 0) {
      return geminiError(
        c,
        400,
        "INVALID_ARGUMENT",
        "requests must be a non-empty array.",
      );
    }
    const requests: unknown[] = body.requests;
    const texts: string[] = [];
    const embeddings: { values: number[] }[] = [];
    for (const request of requests) {
      const parts = partsOf(request);
      if (!parts || !isRecord(request)) {
        return geminiError(
          c,
          400,
          "INVALID_ARGUMENT",
          "Every request needs content.parts[].text.",
        );
      }
      const dimensions = request.outputDimensionality ?? 3072;
      if (!isDimension(dimensions)) {
        return geminiError(
          c,
          400,
          "INVALID_ARGUMENT",
          `outputDimensionality must be an integer from 1 to ${String(MAX_DIMENSIONS)}.`,
        );
      }
      const joined = parts.join("\n");
      texts.push(joined);
      embeddings.push({ values: embeddingFor(joined, dimensions) });
    }
    const promptTokenCount = tokenCount(texts);
    return c.json({
      embeddings,
      usageMetadata: {
        promptTokenCount,
        promptTokenDetails: [
          { modality: "TEXT", tokenCount: promptTokenCount },
        ],
      },
    });
  });

  return app;
}
