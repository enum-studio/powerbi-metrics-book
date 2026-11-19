import { renderToStaticMarkup } from "react-dom/server";
import { type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { metricRoute } from "../routes/catalog/metric";
import { Variants } from "./variants";
import { type VariantAnchor } from "./queries";

vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ isPending: true, error: null }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

it("marks the row selected by ?variant and keeps every variant's DAX open", () => {
  const variants: VariantAnchor[] = ["v1", "v2"].map((id) => ({
    id,
    dataset: { kind: "dataset", id: "d1", name: "Sales" },
    workspace: { kind: "workspace", id: "w1", name: "Commerce" },
    measure: { kind: "measure", id, name: "Sales" },
    measure_reference: "[Sales]",
    shift: {
      period: "current",
      comparison: "none",
      comparison_period: null,
      currency: null,
      shift_note: null,
      custom_axes: {},
    },
  }));
  const search = Object.fromEntries(new URLSearchParams("?variant=v2"));
  const validate = metricRoute.options.validateSearch;
  if (typeof validate !== "function")
    throw new Error("Missing search validator");
  expect(validate(search)).toEqual({ variant: search.variant });
  const variant = search.variant;
  const html = renderToStaticMarkup(
    <Variants variants={variants} currentVariant={variant} />,
  );
  expect(html.match(/<ul/g)).toHaveLength(1);
  expect(html.match(/data-current-variant/g)).toHaveLength(1);
  expect(html).toMatch(/data-current-variant="v2"[^>]*bg-accent-soft/);
  expect(html).not.toContain('aria-expanded="false"');
  expect(html.match(/aria-expanded="true"/g)).toHaveLength(2);
  expect(html.match(/Loading the DAX/g)).toHaveLength(2);
});
