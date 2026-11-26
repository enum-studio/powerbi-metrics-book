import { z } from "zod";
import {
  Metric as MetricResponse,
  Variant as VariantResponse,
} from "../../routes/v1/schemas.js";
import { call, type Send } from "./book.js";
import {
  measureKey,
  readingContent,
  READING_TERMS,
} from "./reading-content.js";

const Metric = MetricResponse.omit({
  created_at: true,
  updated_at: true,
  touched_at: true,
  dismissed_at: true,
  verified_at: true,
});
const Variant = VariantResponse.omit({ assigned_at: true });

const AREAS = {
  sales: {
    question: "Are more customers buying, and what is each basket worth?",
    kicker: "Demand and baskets",
    team: "Sales",
  },
  web_analytics: {
    question: "Does traffic turn into orders?",
    kicker: "The path to purchase",
    team: "Digital",
  },
  marketing: {
    question: "What does paid demand cost, and what does it return?",
    kicker: "Spend and return",
    team: "Marketing",
  },
  retail: {
    question: "Are stores meeting demand without excess stock or margin loss?",
    kicker: "Stores and stock",
    team: "Retail operations",
  },
  finance: {
    question: "What revenue and margin can Finance report?",
    kicker: "The result",
    team: "Finance",
  },
};

export async function seedSampleReadingPage(send: Send): Promise<string> {
  let changed = 0;
  const page = z.object({
    items: z.array(z.object({ name: z.string() })),
    next_cursor: z.string().nullable(),
  });
  const metrics: z.infer<typeof Metric>[] = [];
  let cursor: string | null = null;
  do {
    const found = page.parse(
      await call(
        send,
        "GET",
        `/metrics?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    );
    for (const item of found.items)
      metrics.push(
        Metric.parse(
          await call(send, "GET", `/metrics/${encodeURIComponent(item.name)}`),
        ),
      );
    cursor = found.next_cursor;
  } while (cursor !== null);
  const categories = z
    .array(
      z.object({
        path: z.string(),
        question: z.string().nullable(),
        kicker: z.string().nullable(),
      }),
    )
    .parse(await call(send, "GET", "/categories"));
  for (const [path, wanted] of Object.entries(AREAS)) {
    const have = categories.find((c) => c.path === path);
    if (have && (!have.question || !have.kicker)) {
      await call(send, "PATCH", `/categories/${path}`, {
        question: have.question || wanted.question,
        kicker: have.kicker || wanted.kicker,
      });
      changed++;
    }
  }
  const people = z
    .object({
      people: z.array(
        z.object({
          id: z.string(),
          email: z.string(),
          title: z.string().optional(),
        }),
      ),
    })
    .parse(await call(send, "GET", "/admin/people"));
  for (const person of people.people)
    if (!person.title) {
      await call(
        send,
        "PUT",
        `/people/${encodeURIComponent(person.id)}/title`,
        {
          title: person.email.startsWith("leader")
            ? "Finance lead"
            : person.email.startsWith("analyst")
              ? "Commercial analyst"
              : "Sample book reader",
        },
      );
      changed++;
    }
  for (const { name, ...fields } of READING_TERMS) {
    const path = `/terms/${encodeURIComponent(name)}`;
    if ((await call(send, "GET", path, undefined, [200, 404])) === null) {
      await call(send, "POST", path, fields, [201]);
      changed++;
    }
  }
  const byMeasure = new Map(
    metrics.flatMap((row) =>
      row.base_variants.map(
        (base) =>
          [measureKey([base.dataset.name, base.measure.name]), row] as const,
      ),
    ),
  );
  const existingLinks = new Set(
    metrics.flatMap((row) =>
      row.moves_with.map((link) =>
        [row.name, link.metric.name].sort().join("/"),
      ),
    ),
  );
  const links = new Map<
    string,
    {
      from: string;
      to: string;
      movement: "same" | "opposite" | "depends";
      reason: string;
      other_reason: string;
    }
  >();
  for (const row of metrics) {
    const base = row.base_variants[0];
    if (!base)
      throw new Error(
        `Sample metric ${row.name} has no base measure to document.`,
      );
    const variant = Variant.parse(
      await call(send, "GET", `/variants/${base.id}`),
    );
    const { category, related, building_block, ...content } = readingContent([
      base.dataset.name,
      base.measure.name,
    ]);
    const definition =
      row.definition || variant.description || variant.description_pbi;
    if (!definition)
      throw new Error(`Write a definition for sample metric ${row.name}.`);
    const desired = { definition, ...content };
    const patch = Object.fromEntries(
      Object.entries(desired).filter(([key]) => {
        const value = row[key as keyof typeof row];
        return (
          value === "" ||
          value === null ||
          (Array.isArray(value) && value.length === 0)
        );
      }),
    );
    if (!row.category) Object.assign(patch, { category });
    if (!row.tier && building_block) Object.assign(patch, { building_block });
    if (Object.keys(patch).length) {
      await call(
        send,
        "PATCH",
        `/metrics/${encodeURIComponent(row.name)}`,
        patch,
      );
      changed++;
    }
    if (!row.owner_person) {
      await call(
        send,
        "PUT",
        `/metrics/${encodeURIComponent(row.name)}/owner`,
        {
          email:
            content.owner_team === "Finance"
              ? "leader@sample.example"
              : "analyst@sample.example",
        },
      );
      changed++;
    }
    for (const peer of related) {
      const other = byMeasure.get(measureKey(peer.measure));
      if (!other)
        throw new Error(
          `Missing related sample measure ${measureKey(peer.measure)}.`,
        );
      if (other.name === row.name)
        throw new Error(`Sample metric ${row.name} links to itself.`);
      const key = [row.name, other.name].sort().join("/");
      if (existingLinks.has(key)) continue;
      const pair = links.get(key);
      if (pair) {
        pair.other_reason = peer.reason;
        // A conditional direction on either side makes the pair conditional.
        if (pair.movement !== peer.movement) pair.movement = "depends";
      } else
        links.set(key, {
          from: row.name,
          to: other.name,
          movement: peer.movement,
          reason: peer.reason,
          other_reason: "",
        });
    }
  }
  for (const { from, to, ...fields } of links.values()) {
    await call(
      send,
      "PUT",
      `/metrics/${encodeURIComponent(from)}/links/${encodeURIComponent(to)}`,
      fields,
    );
    changed++;
  }
  const net = Metric.parse(await call(send, "GET", "/metrics/net_sales"));
  for (const child of ["orders", "average_order_value"])
    if (!net.edges.some((edge) => edge.metric.name === child)) {
      await call(send, "PUT", `/metrics/net_sales/edges/${child}`, {
        operation: "product",
        sign: 1,
        note: "Net sales equals orders times average order value under the same filters.",
      });
      changed++;
    }
  for (const name of ["Channel", "Region", "Return"]) {
    const term = z
      .object({ group: z.string().nullable() })
      .parse(await call(send, "GET", `/terms/${name}`));
    if (!term.group) {
      await call(send, "PATCH", `/terms/${name}`, {
        group: name === "Return" ? "Business concepts" : "Dimensions",
      });
      changed++;
    }
  }
  for (const key of ["guide.result_metric", "guide.featured_metric"]) {
    const setting = z
      .object({ value: z.unknown() })
      .parse(await call(send, "GET", `/admin/settings/${key}`));
    if (setting.value === null) {
      await call(send, "PUT", `/admin/settings/${key}`, { value: "net_sales" });
      changed++;
    }
  }
  return `Sample reading page: ${String(changed)} changes.`;
}
