import type { AppDeps } from "../../context.js";

/** Whether the include and exclude settings choose a workspace. Power BI's ids may differ in case from a saved one. */
export async function chosenBySettings(
  deps: AppDeps,
): Promise<(id: string) => boolean> {
  const include = await deps.settings.get("powerbi.sync.workspaces.include");
  const exclude = await deps.settings.get("powerbi.sync.workspaces.exclude");
  const lower = (ids: string[]) => new Set(ids.map((id) => id.toLowerCase()));
  const wanted = include === "all" ? null : lower(include);
  const unwanted = lower(exclude);
  return (id) => {
    const key = id.toLowerCase();
    return (wanted === null || wanted.has(key)) && !unwanted.has(key);
  };
}
