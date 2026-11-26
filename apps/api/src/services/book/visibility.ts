import type { SettingValue } from "../../context.js";

export function metricVisibility(
  mode: SettingValue<"access.metadata_visibility">,
  datasets: string[],
): string {
  const names = [...new Set(datasets)].sort();
  if (!names.length)
    return "Access to this metric's documentation follows this deployment's book and personal-data permissions.";
  const rule =
    mode === "everyone"
      ? "Signed-in people may read dataset documentation."
      : mode === "powerbi"
        ? "People may read documentation for datasets they can read in Power BI."
        : "The deployment's access policy decides who may read dataset documentation.";
  return `${rule} Book and personal-data permissions also apply. Visible variants are in: ${names.join(", ")}.`;
}
