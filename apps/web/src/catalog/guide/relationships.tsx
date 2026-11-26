import { formText } from "./form";
import type { SubmitEvent } from "react";
import { api, read } from "../../api/client";
import type { Metric } from "../../review/queries";

const INPUT =
  "rounded border border-line-control bg-surface px-3 py-2 text-body text-ink";

export function Relationships({
  metric,
  busy,
  change,
}: {
  metric: Metric;
  busy: boolean;
  change: (work: () => Promise<unknown>) => Promise<void>;
}) {
  function saveLink(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const movement = data.get("movement");
    if (
      movement !== "same" &&
      movement !== "opposite" &&
      movement !== "depends"
    )
      return;
    void change(() =>
      read(
        api.PUT("/api/v1/metrics/{name}/links/{other}", {
          params: {
            path: { name: metric.name, other: formText(data, "other") },
          },
          body: {
            movement,
            reason: formText(data, "reason"),
            other_reason: formText(data, "other_reason"),
          },
        }),
      ),
    );
  }
  function saveEdge(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const operation = data.get("operation");
    if (operation !== "sum" && operation !== "product") return;
    void change(() =>
      read(
        api.PUT("/api/v1/metrics/{name}/edges/{other}", {
          params: {
            path: { name: metric.name, other: formText(data, "other") },
          },
          body: {
            operation,
            sign: data.get("sign") === "-1" ? -1 : 1,
            note: formText(data, "note") || null,
          },
        }),
      ),
    );
  }
  return (
    <div className="mt-6 grid gap-6">
      <section className="grid gap-3">
        <h3 className="text-heading text-ink">Moves with</h3>
        <ul className="grid gap-2">
          {metric.moves_with.map((link) => (
            <li key={link.metric.id}>
              {link.metric.label}: {link.movement}. {link.reason}{" "}
              <button
                type="button"
                disabled={busy}
                className="text-accent underline"
                onClick={() => {
                  void change(() =>
                    read(
                      api.DELETE("/api/v1/metrics/{name}/links/{other}", {
                        params: {
                          path: { name: metric.name, other: link.metric.name },
                        },
                      }),
                    ),
                  );
                }}
              >
                Remove link to {link.metric.label}
              </button>
            </li>
          ))}
        </ul>
        <form onSubmit={saveLink} className="grid gap-3">
          <label className="grid gap-1 text-ui">
            Related metric key
            <input name="other" required className={INPUT} />
          </label>
          <label className="grid gap-1 text-ui">
            Movement
            <select name="movement" className={INPUT}>
              <option value="same">Same</option>
              <option value="opposite">Opposite</option>
              <option value="depends">Depends</option>
            </select>
          </label>
          <label className="grid gap-1 text-ui">
            Reason from this metric
            <textarea name="reason" required className={INPUT} />
          </label>
          <label className="grid gap-1 text-ui">
            Reason from the other metric (optional)
            <textarea name="other_reason" className={INPUT} />
          </label>
          <button
            disabled={busy}
            className="justify-self-start text-accent underline"
          >
            Save link
          </button>
        </form>
      </section>
      <section className="grid gap-3">
        <h3 className="text-heading text-ink">Formula</h3>
        <ul className="grid gap-2">
          {metric.edges.map((edge) => (
            <li key={edge.metric.id}>
              {edge.metric.label} ({edge.operation}, {edge.sign}). {edge.note}{" "}
              <button
                type="button"
                disabled={busy}
                className="text-accent underline"
                onClick={() => {
                  void change(() =>
                    read(
                      api.DELETE("/api/v1/metrics/{name}/edges/{other}", {
                        params: {
                          path: { name: metric.name, other: edge.metric.name },
                        },
                      }),
                    ),
                  );
                }}
              >
                Remove {edge.metric.label} from formula
              </button>
            </li>
          ))}
        </ul>
        <form onSubmit={saveEdge} className="grid gap-3">
          <label className="grid gap-1 text-ui">
            Child metric key
            <input name="other" required className={INPUT} />
          </label>
          <label className="grid gap-1 text-ui">
            Operation for this formula
            <select name="operation" className={INPUT}>
              <option value="sum">Sum</option>
              <option value="product">Product</option>
            </select>
          </label>
          <label className="grid gap-1 text-ui">
            Sign
            <select name="sign" className={INPUT}>
              <option value="1">Positive</option>
              <option value="-1">Negative</option>
            </select>
          </label>
          <label className="grid gap-1 text-ui">
            Formula note
            <textarea name="note" className={INPUT} />
          </label>
          <button
            disabled={busy}
            className="justify-self-start text-accent underline"
          >
            Save formula child
          </button>
        </form>
      </section>
    </div>
  );
}
