import { z } from "zod";
import type { ServiceContext } from "../context.js";
import { ServiceError } from "../errors.js";
import {
  type McpToolResult,
  pageSizeThatFits,
  toolAnswer,
  toolError,
} from "./result.js";

/** A tool as the server lists and calls it, whatever its input. */
export type Tool = {
  readonly requires?: "questions.enabled";
  readonly name: string;
  readonly description: string;
  /** The input as JSON Schema, which tools/list announces. */
  readonly inputSchema: z.core.JSONSchema.BaseSchema;
  /** Validates the arguments, runs the handler and wraps its answer. Throws only what is not a ServiceError. */
  call(context: ServiceContext, received: unknown): Promise<McpToolResult>;
};

export type ToolDefinition<Input extends z.ZodObject> = {
  /** snake_case, and on the spec's list (connector_surface_security_test.ts). */
  requires?: "questions.enabled";
  name: string;
  cutSentence?: string;
  /** Says when to use the tool, which is how a model chooses it. */
  description: string;
  /** Tools take named arguments, so the input is an object. */
  input: Input;
  /** A thin adapter over a service; what it answers is serialised as it is. */
  handler: (
    context: ServiceContext,
    input: z.output<Input>,
  ) => Promise<unknown>;
};

/**
 * A tool, from its definition. The arguments are parsed before the handler
 * runs, so a handler only ever sees its own input type; a ServiceError the
 * handler throws becomes a tool error carrying its sentence. A tool that takes
 * a cursor and a limit is a list, and asking one again changes nothing a caller
 * sees (at most it refreshes the mirror, in list_measures), so a page too long
 * for one answer is asked for again at the size that fits.
 */
export function defineTool<Input extends z.ZodObject>(
  definition: ToolDefinition<Input>,
): Tool {
  const { name, description, input, handler } = definition;
  const lists = "cursor" in input.shape && "limit" in input.shape;
  return {
    name,
    ...(definition.requires === undefined
      ? {}
      : { requires: definition.requires }),
    description,
    inputSchema: z.toJSONSchema(input, { io: "input" }),
    async call(context, received) {
      const parsed = input.safeParse(received);
      if (!parsed.success) return toolError(invalidInput(name, parsed.error));
      try {
        const answer = await handler(context, parsed.data);
        const fitting = lists ? pageSizeThatFits(answer) : null;
        return toolAnswer(
          fitting === null
            ? answer
            : await handler(
                context,
                Object.assign({}, parsed.data, { limit: fitting }),
              ),
          definition.cutSentence,
        );
      } catch (error) {
        if (error instanceof ServiceError) return toolError(error);
        throw error;
      }
    },
  };
}

/** Each problem with the path to it, so the model can fix that argument and call again. */
function invalidInput(name: string, error: z.ZodError): ServiceError {
  const problems = error.issues.map(({ path, message }) =>
    path.length === 0 ? message : `${path.map(String).join(".")}: ${message}`,
  );
  return new ServiceError(
    "invalid",
    `The arguments to ${name} are not valid (${problems.join("; ")}). Fix them and call it again.`,
  );
}
