import { and, eq, isNull } from "drizzle-orm";
import type { ServiceContext } from "../../context.js";
import { metric } from "../../db/schema/book.js";
import { visibleMetric } from "../mirror/read.js";
import { readsPii } from "../pii/rules.js";
import { requireCurator } from "./changes.js";
import { amendMetric } from "./metrics.js";

export function splitWhenToUse(text: string, otherNames: string[]) {
  const sentences = text.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [];
  const cut = sentences.findIndex((sentence) =>
    otherNames.some(
      (name) =>
        name.length > 0 &&
        sentence.toLocaleLowerCase().includes(name.toLocaleLowerCase()),
    ),
  );
  return {
    use_for: (cut < 0 ? text : sentences.slice(0, cut).join("")).trim(),
    dont_use_for: cut < 0 ? "" : sentences.slice(cut).join("").trim(),
  };
}

export async function upgradeDocumentation(context: ServiceContext) {
  await requireCurator(context);
  const allowed = await context.access.describableDatasets(context.principal);
  const rows = await context.db
    .select({ id: metric.id, name: metric.name, label: metric.label })
    .from(metric)
    .where(
      and(
        visibleMetric(context.db, allowed, !(await readsPii(context))),
        isNull(metric.dismissed_at),
      ),
    );
  const updated: string[] = [];
  for (const row of rows)
    await amendMetric(
      context,
      row.id,
      "upgrade_documentation",
      async ({ tx }, before) => {
        if (
          !before.when_to_use.trim() ||
          before.use_for.trim() ||
          before.dont_use_for.trim()
        )
          return;
        const fields = splitWhenToUse(
          before.when_to_use,
          rows
            .filter((other) => other.id !== row.id)
            .flatMap((other) => [other.name, other.label]),
        );
        await tx
          .update(metric)
          .set({
            ...fields,
            trust_state: "draft",
            verified_by: null,
            verified_at: null,
          })
          .where(eq(metric.id, row.id));
        updated.push(row.name);
      },
    );
  return {
    updated,
    note: "Review these drafts. The original when_to_use text is preserved.",
  };
}
