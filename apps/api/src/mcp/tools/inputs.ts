import { z } from "zod";
import { TRUST_STATES } from "../../db/schema/book.js";
import { CURSOR_MAX_CHARACTERS } from "../result.js";

/** The inputs several tools take, worded once so a model reads the same thing the same way. */

export const cursor = z
  .string()
  .max(CURSOR_MAX_CHARACTERS)
  .optional()
  .describe(
    "The next_cursor of the page before. Leave it out for the first page.",
  );

export const pageLimit = z
  .int()
  .min(1)
  .max(100)
  .default(25)
  .describe(
    "The most items to return: 25 when left out, 100 at most. A page also ends at 16 KiB, so it can hold fewer; next_cursor goes on from there.",
  );

/** What narrows the metrics and terms a list or a search returns. */
export const bookFilters = {
  workspace: z
    .string()
    .max(500)
    .optional()
    .describe("Only items with something in this workspace (name or id)."),
  app: z
    .string()
    .max(500)
    .optional()
    .describe("Only items with something in this Power BI app (name or id)."),
  dataset: z
    .string()
    .max(500)
    .optional()
    .describe("Only items with something in this dataset (name or id)."),
  trust_states: z
    .array(z.enum(TRUST_STATES))
    .max(TRUST_STATES.length)
    .optional()
    .describe(
      "Only items in one of these trust states. human_verified is the only one a person has approved.",
    ),
  custom: z
    .record(z.string().max(500), z.string().max(500))
    .refine((fields) => Object.keys(fields).length <= 20, {
      message: "At most 20 custom fields.",
    })
    .meta({ maxProperties: 20 })
    .optional()
    .describe(
      'Custom fields to match, each as text, for example {"owner_team": "finance"}. get_conventions lists the fields.',
    ),
};
