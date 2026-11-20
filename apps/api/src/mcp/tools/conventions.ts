import { z } from "zod";
import { getConventionsForAgents } from "../../services/conventions/service.js";
import { defineTool, type Tool } from "../registry.js";

export const conventionsTools: readonly Tool[] = [
  defineTool({
    name: "get_conventions",
    description:
      "The company's conventions for its metrics book: the guide in its own words, the rules as data, and how many exceptions each rule has. Read them before you name, describe, group or verify anything; every other answer is named and grouped by them. An element's checks show its own exception and the reason.",
    input: z.strictObject({}),
    handler: (context) => getConventionsForAgents(context),
  }),
];
