import type { ServiceError } from "../errors.js";

/**
 * A tool's answer as MCP carries it. The services answer in the shape REST
 * also serves, snake_case already; this is the one place the connector turns
 * that into MCP's envelope.
 */
export type McpToolResult = {
  content: { type: "text"; text: string }[];
  isError?: true;
};

/** The spec's bound on one answer: 16 KiB of text, counted in UTF-8 bytes. */
export const ANSWER_LIMIT_BYTES = 16 * 1024;

/** The longest cursor a tool takes. A list orders by up to three names, and a name has no bound of its own. */
export const CURSOR_MAX_CHARACTERS = 2000;

/** What a list's answer needs beside its rows: a cursor, a count such as pii_hidden. */
const ENVELOPE_BYTES = CURSOR_MAX_CHARACTERS + 512;

export const CUT_SENTENCE =
  "This answer is longer than 16 KiB and stops here. If this tool takes filters or a limit, ask for less.";

export const CUT_ROW_SENTENCE =
  "One row is longer than 16 KiB, so this page stops inside it. Page on with next_cursor.";

export const rowsCutSentence = (shown: number, all: number) =>
  `Only the first ${String(shown)} of ${String(all)} fit in 16 KiB. If this tool takes filters, narrow them to reach the others.`;

const text = (payload: unknown) => ({
  type: "text" as const,
  text: JSON.stringify(payload),
});

const bytesOf = (payload: unknown) =>
  Buffer.byteLength(JSON.stringify(payload));

const withItems = (payload: unknown): payload is { items: unknown[] } =>
  typeof payload === "object" &&
  payload !== null &&
  "items" in payload &&
  Array.isArray(payload.items);

const isPage = (
  payload: unknown,
): payload is { items: unknown[]; next_cursor: string | null } =>
  withItems(payload) && "next_cursor" in payload;

/** How many rows, from the first, leave room in one answer for what goes beside them. */
function rowsThatFit(rows: unknown[]): number {
  let bytes = ENVELOPE_BYTES;
  const over = rows.findIndex((row) => {
    bytes += bytesOf(row) + 1;
    return bytes > ANSWER_LIMIT_BYTES;
  });
  return over === -1 ? rows.length : over;
}

/**
 * The limit to ask a list again with when its page is too long for one answer,
 * or null when it fits. Only the service can make a cursor from a row, so the
 * list is asked again rather than the page cut here. A row too long to fit on
 * its own still comes back alone, for toolAnswer to cut.
 */
export function pageSizeThatFits(answer: unknown): number | null {
  if (!isPage(answer) || bytesOf(answer) <= ANSWER_LIMIT_BYTES) return null;
  return Math.max(rowsThatFit(answer.items), 1);
}

/** The rows that fit, in the answer `answerWith` makes of them; null when not even the first does. */
function wholeRows(
  rows: unknown[],
  answerWith: (shown: unknown[]) => unknown,
): McpToolResult | null {
  const shown = rows.slice(0, rowsThatFit(rows));
  if (shown.length === 0) return null;
  return {
    content: [
      text(answerWith(shown)),
      text({
        truncated: true,
        message: rowsCutSentence(shown.length, rows.length),
      }),
    ],
  };
}

/**
 * A list with no cursor kept to its whole rows, never asked again: a search
 * counts against its rate limit and can pay for an embedding.
 */
function shortenedList(payload: unknown): McpToolResult | null {
  if (Array.isArray(payload)) return wholeRows(payload, (shown) => shown);
  if (withItems(payload) && !isPage(payload))
    return wholeRows(payload.items, (items) => ({ ...payload, items }));
  return null;
}

/** The first `limit` bytes of `serialised`, backed off to a character boundary. */
function cutAt(serialised: string, limit: number): string {
  const bytes = Buffer.from(serialised, "utf8");
  let end = limit;
  // A byte 10xxxxxx continues a character, so the cut would split it.
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * JSON rather than prose: a model reads a shape it can act on more reliably
 * than a sentence. A longer list keeps its whole rows; any other longer answer
 * is cut, and a block of its own says so and how to get the rest, the two
 * together within the bound. The cursor of a page of one row goes in that
 * block, since the cut would take it from the end. A longer page cut here grew
 * after it was measured, and its cursor would skip the rows the cut took.
 */
export function toolAnswer(payload: unknown): McpToolResult {
  const whole = text(payload);
  if (Buffer.byteLength(whole.text) <= ANSWER_LIMIT_BYTES)
    return { content: [whole] };
  const list = shortenedList(payload);
  if (list !== null) return list;
  const cursor =
    isPage(payload) && payload.items.length === 1 ? payload.next_cursor : null;
  const note =
    cursor !== null && cursor.length <= CURSOR_MAX_CHARACTERS
      ? { truncated: true, message: CUT_ROW_SENTENCE, next_cursor: cursor }
      : { truncated: true, message: CUT_SENTENCE };
  return {
    content: [
      {
        type: "text",
        text: cutAt(whole.text, ANSWER_LIMIT_BYTES - bytesOf(note)),
      },
      text(note),
    ],
  };
}

/**
 * A refusal the model can correct itself from: the error's kind and its
 * sentence, never its detail, as REST answers it.
 */
export function toolError(error: ServiceError): McpToolResult {
  return {
    content: [text({ error: error.kind, message: error.message })],
    isError: true,
  };
}
