import { z } from "zod";
import { getConventionsForAgents } from "../../services/conventions/service.js";
import { defineTool, type Tool } from "../registry.js";

export const conventionsTools: readonly Tool[] = [
  defineTool({
    name: "get_conventions",
    description:
      "The company's conventions for its metrics book: the guide in its own words and the rules as data. Read them before you name, describe, group or verify anything; every other answer is named and grouped by them.",
    input: z.strictObject({}),
    handler: (context) => getConventionsForAgents(context),
  }),
];
