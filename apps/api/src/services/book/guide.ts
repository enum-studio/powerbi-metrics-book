import { hash } from "node:crypto";
import { asc, inArray } from "drizzle-orm";
import type { ServiceContext } from "../../context.js";
import { term, termMetric } from "../../db/schema/book.js";
import { ServiceError } from "../../errors.js";
import { writeAudit } from "../audit/write.js";
import { currentConventions } from "../conventions/store.js";
import { guideDocuments } from "./guide-documents.js";
import { loadTree } from "./categories.js";
import { getMetric } from "./metrics.js";

type Metric = Awaited<ReturnType<typeof guideDocuments>>[number];
export const DOCUMENTATION_FIELDS = [
  ["importance_why", "Why it matters"],
  ["use_for", "Use for"],
  ["dont_use_for", "Don't use for"],
  ["decisions", "Decisions"],
  ["actions", "Actions"],
  ["primary_dimensions", "Primary dimensions"],
  ["formula", "Calculation in the model"],
  ["not_the_same_as", "Not the same as"],
  ["caveats", "Caveats"],
  ["aliases", "Aliases"],
  ["who_may_see", "Who may see it"],
  ["owner_team", "Owning team"],
  ["when_to_use", "When to use"],
  ["grain_and_filters", "Grain and filters"],
  ["unit", "Unit"],
  ["tier", "Tier"],
  ["importance", "Importance"],
  ["direction", "Direction"],
] as const;

export async function exportSettings(context: ServiceContext) {
  return {
    markdown: await context.settings.get("exports.markdown"),
    pdf: await context.settings.get("exports.pdf"),
    guide: await context.settings.get("guide.enabled"),
  };
}

export async function getGuide(context: ServiceContext) {
  if (!(await context.settings.get("guide.enabled")))
    throw new ServiceError("not_found", "The reading page is switched off.");
  const metrics = await guideDocuments(context);
  const conventions = await currentConventions(context.db);
  const rank = (values: string[], value: string) => {
    const found = values.indexOf(value);
    return found < 0 ? values.length : found;
  };
  metrics.sort(
    (a, b) =>
      rank(conventions.metric_fields.importance.values, a.importance) -
        rank(conventions.metric_fields.importance.values, b.importance) ||
      rank(conventions.metric_fields.tier.values, a.tier) -
        rank(conventions.metric_fields.tier.values, b.tier) ||
      a.name.localeCompare(b.name),
  );
  const tree = await loadTree(context.db);
  const beneath = (id: string): string[] => [
    id,
    ...tree.children(id).flatMap((child) => beneath(child.id)),
  ];
  const areas = tree
    .children(null)
    .map((row) => {
      const categories = new Set(beneath(row.id));
      const members = metrics.filter(
        (m) =>
          m.category_id !== null &&
          categories.has(m.category_id) &&
          !m.building_block,
      );
      const critical = members.filter((m) => m.importance === "critical");
      const headlines = critical.length
        ? critical
        : members.filter((m) => m.tier === "north_star" || m.tier === "driver");
      return {
        ...tree.anchor(row),
        metrics: members,
        headlines: headlines.slice(0, 3),
      };
    })
    .filter((area) => area.metrics.length);
  const find = (reference: string | null) =>
    metrics.find((m) => m.id === reference || m.name === reference) ?? null;
  const featured =
    find(await context.settings.get("guide.featured_metric")) ??
    metrics.find((m) => m.tier === "north_star") ??
    null;
  const result = find(await context.settings.get("guide.result_metric"));
  const sum = result && result.edges.length > 0 ? result : null;
  const terms = await context.db
    .select({
      id: term.id,
      name: term.name,
      group: term.group,
      definition: term.definition,
    })
    .from(term)
    .orderBy(asc(term.group), asc(term.name));
  const links = metrics.length
    ? await context.db
        .select()
        .from(termMetric)
        .where(
          inArray(
            termMetric.metric_id,
            metrics.map((m) => m.id),
          ),
        )
        .orderBy(asc(termMetric.metric_id))
    : [];
  const visible = new Map(metrics.map((m) => [m.id, m]));
  const glossary = terms.map((row) => ({
    ...row,
    kind: "term" as const,
    metrics: links
      .filter((link) => link.term_id === row.id)
      .flatMap((link) => {
        const m = visible.get(link.metric_id);
        return m ? [{ kind: "metric" as const, id: m.id, name: m.name }] : [];
      }),
  }));
  return {
    areas,
    metrics,
    sum,
    featured,
    glossary,
    naming: conventions.naming,
    exports: await exportSettings(context),
  };
}

// Markdown destinations are our own paths. Escape book text, including raw HTML.
const escape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\`*_{}\[\]#!|]/g, "\\$&");
export function metricMarkdown(row: Metric, level = 2): string {
  const heading = "#".repeat(level);
  const section = heading + "#";
  const lines = [
    `${heading} ${escape(row.label)}`,
    "",
    `Key: ${escape(row.name)}`,
    "",
    escape(row.definition),
  ];
  for (const [key, label] of DOCUMENTATION_FIELDS) {
    const raw = row[key];
    const value = Array.isArray(raw) ? raw.join(", ") : raw;
    if (value) lines.push("", `${section} ${label}`, "", escape(value));
  }
  if (row.edges.length)
    lines.push(
      "",
      `${section} Formula`,
      "",
      escape(
        `${row.label} = ${row.edges.map((edge, i) => `${edge.operation === "product" ? `${i ? "times " : ""}${edge.sign === -1 ? "negative " : ""}` : edge.sign === -1 ? "minus " : i ? "plus " : ""}${edge.metric.label}${edge.note ? ` (${edge.note})` : ""}`).join(" ")}`,
      ),
    );
  if (row.category) lines.push("", `Category: ${escape(row.category.path)}`);
  for (const [key, value] of Object.entries(row.custom))
    lines.push(
      "",
      `${section} ${escape(key)}`,
      "",
      escape(typeof value === "string" ? value : JSON.stringify(value)),
    );
  if (!row.owner_person && row.owner)
    lines.push("", `${section} Owner`, "", escape(row.owner));
  if (row.owner_person)
    lines.push(
      "",
      `${section} Owner`,
      "",
      escape(
        `${row.owner_person.name}${row.owner_person.title ? `, ${row.owner_person.title}` : ""}${row.owner_person.left ? " (left)" : ""}`,
      ),
    );
  if (row.moves_with.length)
    lines.push(
      "",
      `${section} Moves with`,
      "",
      ...row.moves_with.map(
        (link) =>
          `- ${escape(link.metric.label)} (${link.movement}): ${escape(link.reason)}`,
      ),
    );
  lines.push("", `Building block: ${row.building_block ? "yes" : "no"}`);
  return lines.join("\n");
}

export function guideMarkdown(guide: Awaited<ReturnType<typeof getGuide>>) {
  const lines = ["# Metrics book"];
  if (guide.sum)
    lines.push("## How the result adds up", metricMarkdown(guide.sum, 3));
  lines.push("## The areas at a glance");
  for (const area of guide.areas)
    lines.push(
      `### ${escape(area.name)}`,
      escape(area.question ?? ""),
      `Headlines: ${area.headlines.map((m) => escape(m.label)).join(", ")}`,
      `${String(area.metrics.length)} metrics`,
    );
  if (guide.naming.case !== "none")
    lines.push(
      "## How to read a name",
      `Case: ${escape(guide.naming.case)}`,
      `Kinds: ${guide.naming.kinds.map(escape).join(", ")}`,
      `Qualifier order: ${guide.naming.qualifier_order.map(escape).join(", ")}`,
      `Money qualifiers: ${guide.naming.money_qualifier.values.map(escape).join(", ")}`,
    );
  const included = new Set<string>();
  for (const area of guide.areas) {
    lines.push(
      `## ${escape(area.name)}`,
      escape(area.kicker ?? ""),
      escape(area.description ?? ""),
      escape(area.question ?? ""),
    );
    for (const m of area.metrics) {
      lines.push(metricMarkdown(m, 3));
      included.add(m.id);
    }
  }
  const remaining = guide.metrics.filter((m) => !included.has(m.id));
  if (remaining.length)
    lines.push(
      "## Other metrics and building blocks",
      ...remaining.map((m) => metricMarkdown(m, 3)),
    );
  if (guide.featured)
    lines.push("## A closer look", metricMarkdown(guide.featured, 3));
  lines.push("## Glossary");
  for (const group of new Set(guide.glossary.map((t) => t.group))) {
    lines.push(`### ${escape(group ?? "Other terms")}`);
    for (const t of guide.glossary.filter((t) => t.group === group))
      lines.push(
        `#### ${escape(t.name)}`,
        escape(t.definition),
        t.metrics.map((m) => escape(m.name)).join(", "),
      );
  }
  return lines.filter(Boolean).join("\n\n");
}

async function recordBookExport(
  context: ServiceContext,
  format: "markdown" | "pdf",
  id: string,
) {
  if (await context.settings.get("usage.capture"))
    await writeAudit(context, {
      principal: context.principal,
      action: "book.export",
      resource: { kind: id === "guide" ? "guide" : "metric", id },
      decision: "allow",
      detail: { format },
    });
}

export async function exportBook(
  context: ServiceContext,
  format: "markdown" | "pdf",
  reference?: string,
  options: { offset?: number; revision?: string } = {},
) {
  if (
    !(await context.settings.get(
      format === "markdown" ? "exports.markdown" : "exports.pdf",
    ))
  )
    throw new ServiceError(
      "refused",
      `This deployment has switched off ${format} exports.`,
    );
  let markdown: string;
  let id: string;
  if (reference !== undefined) {
    const row = await getMetric(context, reference);
    id = row.id;
    markdown = metricMarkdown(row);
  } else {
    id = "guide";
    markdown = guideMarkdown(await getGuide(context));
  }
  if (options.revision && options.revision !== hash("sha256", markdown))
    throw new ServiceError(
      "conflict",
      "The guide changed. Start again at offset 0.",
    );
  if ((options.offset ?? 0) === 0 || !options.revision)
    await recordBookExport(context, format, id);
  return { markdown: format === "markdown" ? markdown : "" };
}
