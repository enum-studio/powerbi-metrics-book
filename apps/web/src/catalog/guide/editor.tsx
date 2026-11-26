import { formText } from "./form";
import { useDemo } from "../../shell/demo";
import { useState, type SubmitEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, read } from "../../api/client";
import type { Me } from "../../api/me";
import type { Metric } from "../../review/queries";
import { mayCurate } from "../../review/format";
import { conventionsQuery } from "../../admin/access/api";
import { Relationships } from "./relationships";
import { TEXT_FIELDS } from "./documentation";

const INPUT =
  "rounded border border-line-control bg-surface px-3 py-2 text-body text-ink";
export function DocumentationEditor({
  metric,
  me,
}: {
  metric: Metric;
  me: Me;
}) {
  const demo = useDemo();
  const client = useQueryClient();
  const conventions = useQuery(conventionsQuery);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function change(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      await client.invalidateQueries({ queryKey: ["metric", metric.name] });
      await client.invalidateQueries({ queryKey: ["guide"] });
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The change could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const value = (key: string) => formText(data, key);
    void change(() =>
      read(
        api.PATCH("/api/v1/metrics/{name}", {
          params: { path: { name: metric.name } },
          body: {
            ...Object.fromEntries(
              TEXT_FIELDS.map(([key]) => [key, value(key)]),
            ),
            tier: value("tier"),
            importance: value("importance"),
            direction: value("direction"),
            primary_dimensions: value("primary_dimensions")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            building_block: data.has("building_block"),
          },
        }),
      ),
    );
  }
  if (demo) return null;
  return (
    <section className="flex flex-col gap-3 print:hidden">
      <button
        className="self-start text-accent underline"
        disabled={busy}
        onClick={() => {
          void change(() =>
            read(
              api.PUT("/api/v1/metrics/{name}/follow", {
                params: { path: { name: metric.name } },
                body: { following: !metric.following },
              }),
            ),
          );
        }}
      >
        {metric.following ? "Unfollow metric" : "Follow metric"}
      </button>
      {error && (
        <p role="alert" className="text-body text-ink-2">
          {error}
        </p>
      )}
      {mayCurate(me) && (
        <details>
          <summary className="cursor-pointer text-accent">
            Edit documentation
          </summary>
          <form onSubmit={save} className="mt-4 grid gap-4">
            {(["tier", "importance", "direction"] as const).map((key) => (
              <label key={key} className="grid gap-1 text-ui text-ink">
                {key}
                <select name={key} defaultValue={metric[key]} className={INPUT}>
                  <option value="">Not set</option>
                  {conventions.data?.rules.metric_fields[key].values.map(
                    (value) => (
                      <option key={value} value={value}>
                        {value.replaceAll("_", " ")}
                      </option>
                    ),
                  )}
                </select>
              </label>
            ))}
            {TEXT_FIELDS.map(([key, label]) => (
              <label key={key} className="grid gap-1 text-ui text-ink">
                {label}
                <textarea
                  name={key}
                  defaultValue={metric[key] ?? ""}
                  className={INPUT}
                  rows={3}
                />
              </label>
            ))}
            <label className="grid gap-1 text-ui">
              Primary dimensions (term names, separated by commas)
              <input
                name="primary_dimensions"
                defaultValue={metric.primary_dimensions.join(", ")}
                className={INPUT}
              />
            </label>
            <label className="flex gap-2 text-ui">
              <input
                type="checkbox"
                name="building_block"
                defaultChecked={metric.building_block}
              />
              Building block
            </label>
            <button
              disabled={busy}
              className="justify-self-start rounded border border-line-control px-4 py-2 text-ui text-ink"
            >
              Save documentation
            </button>
          </form>
          <form
            className="mt-6 flex flex-wrap gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const email = formText(
                new FormData(event.currentTarget),
                "email",
              );
              void change(() =>
                read(
                  api.PUT("/api/v1/metrics/{name}/owner", {
                    params: { path: { name: metric.name } },
                    body: { email: email || null },
                  }),
                ),
              );
            }}
          >
            <label className="grid gap-1 text-ui">
              Owner email (empty to clear)
              <input name="email" type="email" className={INPUT} />
            </label>
            <button disabled={busy} className="self-end text-accent underline">
              Assign owner
            </button>
          </form>
          <Relationships metric={metric} busy={busy} change={change} />
        </details>
      )}
    </section>
  );
}
