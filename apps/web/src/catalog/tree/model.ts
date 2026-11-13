import type { components, operations } from "../../api/schema";

export type Category = components["schemas"]["CategoryNode"];
export type Metric = components["schemas"]["Metric"];
export type MetricListItem =
  operations["getApiV1Metrics"]["responses"][200]["content"]["application/json"]["items"][number];

/** Each category's own metrics, as the api counts them, and those of its subcategories. */
export function categoryCounts(categories: Category[]): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (category: Category): number => {
    const count =
      category.metric_count +
      category.children.reduce((sum, child) => sum + visit(child), 0);
    counts.set(category.path, count);
    return count;
  };
  categories.forEach(visit);
  return counts;
}

export function categoryTrail(categories: Category[], path: string): string[] {
  const parts = path.split("/");
  return parts
    .map((_, index) => parts.slice(0, index + 1).join("/"))
    .filter((candidate) => findCategory(categories, candidate) !== undefined);
}

export function findCategory(
  categories: Category[],
  path: string,
): Category | undefined {
  for (const category of categories) {
    if (category.path === path) return category;
    const found = findCategory(category.children, path);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** A category's names from the top down, such as Sales / Orders, found by its id. */
export function categoryNamesById(
  categories: Category[],
  id: string,
): string | undefined {
  for (const category of categories) {
    if (category.id === id) return category.name;
    const below = categoryNamesById(category.children, id);
    if (below !== undefined) return `${category.name} / ${below}`;
  }
  return undefined;
}
