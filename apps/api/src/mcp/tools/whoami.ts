import { connectionsPage } from "../../config.js";
import { z } from "zod";
import { summarizeBook } from "../../services/book/metrics.js";
import { recordConnectorReached } from "../../services/audit/connector.js";
import { onTheMock } from "../../services/auth/sign-in-config.js";
import { connectionState } from "../../services/connection/store.js";
import { weakenedBy } from "../../services/conventions/service.js";
import { defineTool, type Tool } from "../registry.js";

export const whoamiTools: readonly Tool[] = [
  defineTool({
    name: "whoami",
    description:
      "Who you are acting for: the person or service account, their roles, whether their Power BI connection is ready, with the page where they connect it, and sample_data, true when this deployment runs on the invented sample tenant, whose names and numbers are not the company's, and usage, whether searches and requests are captured and how many days they are kept, and book_metrics, how many of the metrics you may see are draft, agent_verified and human_verified, and conventions, how many rules are off and how many exceptions let an element keep failing a rule. Use it when a query is refused for want of a connection.",
    input: z.strictObject({}),
    handler: async (context) => {
      const { db, config, principal, settings } = context;
      await recordConnectorReached(context);
      return {
        id: principal.id,
        kind: principal.kind,
        roles: principal.roles,
        via: principal.via,
        client_id: principal.client_id,
        // A service account queries as the app's service principal, never through a connection.
        powerbi_connection:
          principal.kind === "person"
            ? await connectionState(db, principal.id)
            : null,
        powerbi_connect_url: connectionsPage(config),
        usage: {
          capture: await settings.get("usage.capture"),
          retention_days: await settings.get("usage.retention_days"),
        },
        questions: await settings.get("questions.enabled"),
        sample_data: onTheMock(await settings.get("powerbi.authority")),
        book_metrics: (await summarizeBook(context)).metrics,
        conventions: await weakenedBy(context),
      };
    },
  }),
];
