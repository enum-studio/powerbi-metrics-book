import { hash } from "node:crypto";
import { Metric } from "../routes/v1/schemas.js";
type CheckInPage = {
  items: (Record<string, unknown> & {
    page: string;
    note: string | null;
    values: {
      period: string;
      result: { result_id: string; query_id: string; preview: unknown[][] };
    }[];
  })[];
  next_cursor: string | null;
};

/** Match the REST projection before serializing or computing a revision. */
export const metricDocument = (value: unknown) => Metric.parse(value);

/** JSON escaping can expand one character sixfold. Bound the serialized chunk, not its source length. */
export const documentationRevision = (value: string) => hash("sha256", value);

export function documentationChunk(value: string, offset = 0, budget = 12_000) {
  let end = Math.min(value.length, offset + budget);
  while (Buffer.byteLength(JSON.stringify(value.slice(offset, end))) > budget) {
    end = offset + Math.floor((end - offset) * 0.8);
  }
  // Do not leave half of a UTF-16 surrogate pair in either page.
  if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1] ?? ""))
    end--;
  return {
    text: value.slice(offset, end),
    next_offset: end < value.length ? end : null,
  };
}

/** One metric per page: fitting the answer must never repeat a value query. */
export function checkInAnswer(page: CheckInPage) {
  return {
    items: page.items.map(({ values, note, page: url, ...raw }) => {
      const metric = metricDocument(raw);
      const json = JSON.stringify(metric);
      const chunk = documentationChunk(json, 0, 8_000);
      const item = {
        ...(chunk.next_offset === null
          ? metric
          : {
              id: metric.id,
              name: metric.name,
              tier: metric.tier,
              direction: metric.direction,
              documentation_json: chunk.text,
              documentation_revision: documentationRevision(json),
              documentation_next_offset: chunk.next_offset,
              documentation_note:
                "Read kind metric with this name, revision and offset to finish the JSON documentation.",
            }),
        page: url,
        note,
        values: values.map(({ period, result }) => ({
          period,
          result_id: result.result_id,
          query_id: result.query_id,
          preview:
            Buffer.byteLength(JSON.stringify(result.preview)) <= 1024
              ? result.preview
              : [],
          note: "Use read_query_result with result_id for the stored value; it does not rerun the query.",
        })),
      };
      if (
        Buffer.byteLength(
          JSON.stringify({ items: [item], next_cursor: page.next_cursor }),
        ) <= 15_000
      )
        return item;
      const smaller = documentationChunk(json, 0, 6_000);
      return {
        id: metric.id,
        page: `/catalog/metrics/${encodeURIComponent(metric.id)}`,
        documentation_json: smaller.text,
        documentation_next_offset: smaller.next_offset,
        documentation_revision: documentationRevision(json),
        documentation_note:
          "Read kind metric with this id as name, revision and offset to finish the JSON documentation, and open the metric from the catalog.",
        note,
        values: item.values.map((value) => ({
          ...value,
          period: documentationChunk(value.period, 0, 256).text,
        })),
      };
    }),
    next_cursor: page.next_cursor,
  };
}
