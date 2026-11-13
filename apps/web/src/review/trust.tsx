import { Check } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Me } from "../api/me";
import { useDemo } from "../shell/demo";
import { Button } from "../admin/layout/ui";
import { formatTime } from "../shell/time";
import { CheckMessage } from "./check-message";
import { mayCurate, TRUST_WORDS } from "./format";
import { approve, checksQuery, type Metric, metricQuery } from "./queries";

/** The trust state in words and as the api names it, with who set it and when. */
export function TrustState({ metric }: { metric: Metric }) {
  const { trust_state, verified_by_name, verified_at } = metric;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui text-ink-2">
      <span
        className={`inline-flex items-center gap-1 font-medium ${trust_state === "human_verified" ? "text-accent" : trust_state === "draft" ? "text-ink-3" : "text-ink-2"}`}
      >
        {trust_state === "human_verified" && (
          <Check size={13} aria-hidden="true" />
        )}
        {TRUST_WORDS[trust_state]}
      </span>
      <span className="sr-only">{trust_state}</span>
      {verified_by_name !== null && verified_at !== null && (
        <span>
          {verified_by_name},{" "}
          <time dateTime={verified_at}>{formatTime(verified_at)}</time>
        </span>
      )}
    </p>
  );
}

/**
 * The one place `human_verified` is set, from a browser session. Off while a
 * check fails, with each failing check's sentence; absent for a person whose
 * role may not approve, and once the metric is approved.
 */
export function Approve({ metric, me }: { metric: Metric; me: Me }) {
  const queryClient = useQueryClient();
  const approving = useMutation({
    mutationFn: () => approve(metric.name),
    onSuccess: async (approved) => {
      queryClient.setQueryData(metricQuery(metric.name).queryKey, approved);
      await queryClient.invalidateQueries({
        queryKey: ["metric", metric.name],
      });
    },
  });
  const demo = useDemo();
  const shown =
    !demo && mayCurate(me) && metric.trust_state !== "human_verified";
  const all = useQuery({ ...checksQuery(metric.name), enabled: shown });
  if (!shown) return null;
  const failing =
    all.data === undefined || all.isError
      ? metric.failing_checks
      : all.data.filter((check) => !check.passed);
  return (
    <section
      aria-labelledby="approve-heading"
      className="flex flex-col items-start gap-3 rounded border border-line bg-surface p-4"
    >
      <h2 id="approve-heading" className="text-heading font-semibold text-ink">
        Approve this metric
      </h2>
      <p className="text-ui text-ink-2">
        Agents will treat this metric as checked by a person.
      </p>
      {failing.length > 0 && (
        <div className="text-ui text-ink-2">
          <p>Approve is off while a check fails:</p>
          <ul className="mt-1 flex list-disc flex-col gap-2 pl-5">
            {failing.map(({ check, message, other_labels }) => (
              <li key={check}>
                <CheckMessage message={message} otherLabels={other_labels} />
              </li>
            ))}
          </ul>
        </div>
      )}
      <Button
        primary
        disabled={failing.length > 0 || approving.isPending}
        onClick={() => {
          approving.mutate();
        }}
      >
        {approving.isPending ? "Approving" : "Approve"}
      </Button>
      {approving.error !== null && (
        <p role="alert" className="text-ui text-ink">
          {approving.error.message}
        </p>
      )}
    </section>
  );
}
