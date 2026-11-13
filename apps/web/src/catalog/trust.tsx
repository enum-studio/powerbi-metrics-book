import { Check } from "lucide-react";

export function Trust({
  state,
}: {
  state: "draft" | "agent_verified" | "human_verified";
}) {
  return (
    <span
      className={`text-meta ${state === "human_verified" ? "text-accent" : state === "draft" ? "text-ink-3" : "text-ink-2"}`}
    >
      {state === "human_verified" && (
        <Check size={13} className="mr-1 inline" aria-hidden="true" />
      )}
      {state === "human_verified"
        ? "Approved by a person"
        : state === "agent_verified"
          ? "Checked by an agent"
          : "Draft"}
    </span>
  );
}
