import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { closeTestPools, createTestDeps, principals } from "../../test/deps.js";
import { ServiceError } from "../errors.js";
import { defineTool } from "./registry.js";
import { ANSWER_LIMIT_BYTES, CUT_SENTENCE } from "./result.js";

afterAll(closeTestPools);

const context = { ...createTestDeps(), principal: principals.viewer };

const named = {
  name: "echo",
  description: "Answers what it was given.",
  input: z.strictObject({
    filters: z.strictObject({ limit: z.number().int().max(50) }),
    text: z.string().default(""),
  }),
};
const echo = defineTool({
  ...named,
  handler: (_, input) => Promise.resolve({ echoed: input }),
});

const texts = (result: { content: { text: string }[] }) =>
  result.content.map(({ text }) => text);

describe("defineTool", () => {
  it("refuses an invalid input as invalid, naming the path of each problem, before the handler runs", async () => {
    let ran = false;
    const guarded = defineTool({
      ...named,
      input: z.strictObject({ filters: z.strictObject({ limit: z.number() }) }),
      handler: () => {
        ran = true;
        return Promise.resolve(null);
      },
    });
    const result = await guarded.call(context, {
      filters: { limit: "ten" },
      extra: 1,
    });
    expect(ran).toBe(false);
    expect(result.isError).toBe(true);
    const [body = ""] = texts(result);
    const { error, message } = JSON.parse(body) as Record<string, string>;
    expect(error).toBe("invalid");
    expect(message).toMatch(
      /^The arguments to echo are not valid \(filters\.limit: Invalid input: expected number[^;]*; Unrecognized key: "extra"\)\. Fix them and call it again\.$/,
    );
  });

  it("answers a ServiceError as a tool error carrying its sentence and never its detail", async () => {
    const refusing = defineTool({
      ...named,
      handler: () =>
        Promise.reject(
          new ServiceError("not_found", "There is no dataset named Sales.", {
            sql: "select secret",
          }),
        ),
    });
    const result = await refusing.call(context, { filters: { limit: 1 } });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "not_found",
            message: "There is no dataset named Sales.",
          }),
        },
      ],
      isError: true,
    });
  });

  it("cuts an answer over 16 KiB at a character boundary and says how to get the rest", async () => {
    // Three bytes a character in UTF-8, so the limit falls inside one.
    const long = "€".repeat(ANSWER_LIMIT_BYTES);
    const result = await echo.call(context, {
      filters: { limit: 1 },
      text: long,
    });
    const [cut = "", note = ""] = texts(result);
    expect(result.content).toHaveLength(2);
    const whole = JSON.stringify({
      echoed: { filters: { limit: 1 }, text: long },
    });
    expect(whole.startsWith(cut)).toBe(true);
    const room = ANSWER_LIMIT_BYTES - Buffer.byteLength(note);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(room);
    expect(Buffer.byteLength(cut)).toBeGreaterThan(room - 3);
    expect(cut).not.toContain("\uFFFD");
    expect(JSON.parse(note)).toEqual({
      truncated: true,
      message: CUT_SENTENCE,
    });
  });
});
