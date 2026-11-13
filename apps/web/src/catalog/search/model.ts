import { linkOptions } from "@tanstack/react-router";
import type { paths } from "../../api/schema";
import { folderParam, hasDotName } from "../tree/folders";

export type SearchHit =
  paths["/api/v1/search"]["get"]["responses"][200]["content"]["application/json"]["items"][number];

export type SearchAnswer =
  paths["/api/v1/search"]["get"]["responses"][200]["content"]["application/json"];
export const SEARCH_KINDS = [
  "metric",
  "measure",
  "term",
  "category",
  "dataset",
  "table",
  "column",
] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];
export type SearchFilters = {
  kind?: SearchKind;
  trust?: string[];
  workspace?: string;
  dataset?: string;
  category?: string;
};
export type HomeSearch = SearchFilters & { q?: string };
export const SECTIONS = [
  { kind: "metric", label: "Metrics" },
  { kind: "variant", label: "Metric variants" },
  { kind: "term", label: "Terms" },
  { kind: "category", label: "Categories" },
  { kind: "dataset", label: "Datasets" },
  { kind: "table", label: "Tables" },
  { kind: "column", label: "Columns" },
] as const;
/** What a hit is called: a metric variant by its measure's name (its label is its metric's), anything else by its label. */
export function hitTitle(hit: SearchHit): string {
  return hit.kind === "variant" ? hit.name : hit.label;
}
/** A hit's kind as one word, as the sections name it. */
export const KIND_NAME: Record<SearchHit["kind"], string> = {
  metric: "Metric",
  variant: "Metric variant",
  term: "Term",
  category: "Category",
  dataset: "Dataset",
  table: "Table",
  column: "Column",
};
export function groupSearchHits(items: SearchHit[]) {
  return SECTIONS.map(({ kind, label }) => ({
    kind,
    label,
    hits: items.filter((hit) => hit.kind === kind),
  })).filter((group) => group.hits.length > 0);
}
/** A category's key path, from its own and its parents' keys; none when one is missing. */
function categoryPath(keys: (string | null)[]) {
  return keys.every((key) => key !== null) ? keys.join("/") : undefined;
}

/** The page a hit opens; none when the hit does not say enough to build its address. */
export function hitPage(hit: SearchHit) {
  if (hit.kind === "metric")
    return linkOptions({
      to: "/catalog/metrics/$name",
      params: { name: hit.name },
      search: { variant: undefined },
    });
  if (hit.kind === "variant") {
    if (!hit.metric) return undefined;
    return linkOptions({
      to: "/catalog/metrics/$name",
      params: { name: hit.metric.name },
      search: { variant: hit.id },
    });
  }
  if (hit.kind === "term")
    return linkOptions({
      to: "/catalog/terms/$term",
      params: { term: hit.name },
    });
  if (hit.kind === "category") {
    const splat = categoryPath([
      ...hit.path
        .filter((part) => part.kind === "category")
        .map((part) => part.key),
      hit.key,
    ]);
    if (splat === undefined) return undefined;
    return linkOptions({
      to: "/catalog/categories/$",
      params: { _splat: splat },
    });
  }
  if (hit.kind === "dataset")
    return linkOptions({
      to: "/catalog/datasets/$id",
      params: { id: hit.id },
      search: { tab: "diagram", table: undefined },
    });
  const id = hit.path.find((part) => part.kind === "dataset")?.id;
  if (id === undefined) return undefined;
  if (hit.kind === "table") {
    if (hasDotName(hit.name)) return undefined;
    return linkOptions({
      to: "/catalog/datasets/$id/tables/$table",
      params: { id, table: hit.name },
    });
  }
  const table = hit.path.find((part) => part.kind === "table")?.name;
  if (table === undefined || hasDotName(table, hit.name)) return undefined;
  return linkOptions({
    to: "/catalog/datasets/$id/tables/$table/columns/$column",
    params: { id, table, column: hit.name },
  });
}

/** The page of one level in a hit's path; none for the workspace, which Home filters by. */
export function stepPage(hit: SearchHit, at: number) {
  const step = hit.path[at];
  if (step === undefined || step.kind === "workspace") return undefined;
  const above = hit.path.slice(0, at);
  if (step.kind === "folder") {
    const dataset = above.find((part) => part.kind === "dataset")?.id;
    const table = above.find((part) => part.kind === "table")?.name;
    if (dataset === undefined || table === undefined) return undefined;
    const levels = hit.path
      .slice(0, at + 1)
      .filter((part) => part.kind === "folder")
      .map((part) => part.name);
    if (hasDotName(table, ...levels)) return undefined;
    return linkOptions({
      to: "/catalog/datasets/$id/tables/$table/folders/$folder",
      params: { id: dataset, table, folder: folderParam(levels) },
    });
  }
  return hitPage({
    ...hit,
    kind: step.kind,
    id: step.id,
    name: step.name,
    key: step.key,
    metric: null,
    path: above,
  });
}

/** A text cut where the searched words appear, so a page can mark them without any HTML. */
export function markWords(
  text: string,
  query: string,
): { text: string; marked: boolean }[] {
  const words = query.split(/\s+/).filter((word) => word.length >= 2);
  if (words.length === 0) return [{ text, marked: false }];
  const pattern = words
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const searched = new Set(words.map((word) => word.toLowerCase()));
  return text
    .split(new RegExp(`(${pattern})`, "gi"))
    .filter((part) => part !== "")
    .map((part) => ({
      text: part,
      marked: searched.has(part.toLowerCase()),
    }));
}
