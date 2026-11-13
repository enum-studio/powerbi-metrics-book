import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { inRollback, type Role } from "../../../test/database.js";
import { asRole } from "../../../test/db-roles.js";
import { closeTestPools, testPool } from "../../../test/deps.js";
import * as book from "./book.js";
import * as events from "./events.js";

afterAll(closeTestPools);

/**
 * A measure, a metric and a variant of it, made as the sync's role (or the
 * given one) in a transaction that is rolled back. One statement: a foreign key is checked
 * when it ends, so the order does not matter.
 */
function withVariant<T>(
  work: (
    worker: pg.PoolClient,
    ids: { measure: string; metric: string; variant: string },
  ) => Promise<T>,
  role: Role = "worker_rw",
): Promise<T> {
  return inRollback(testPool(role), async (worker) => {
    const ids = {
      workspace: randomUUID(),
      dataset: randomUUID(),
      table: randomUUID(),
      measure: randomUUID(),
      metric: randomUUID(),
      variant: randomUUID(),
    };
    await worker.query(
      `with w as (insert into powerbi_workspace (id, name) values ($1, 'Sample data workspace')),
            d as (insert into powerbi_dataset (id, workspace_id, name) values ($2, $1, 'Sample data dataset')),
            t as (insert into powerbi_table (id, dataset_id, name) values ($3, $2, 'Sample data table')),
            m as (insert into powerbi_measure (id, dataset_id, table_id, name) values ($4, $2, $3, 'Sample data measure')),
            x as (insert into metric (id, name, label, origin) values ($5, 'sample_data_metric', 'Sample data metric', 'sync'))
       insert into metric_variant (id, metric_id, measure_id, assigned_by) values ($6, $5, $4, 'sync')`,
      [
        ids.workspace,
        ids.dataset,
        ids.table,
        ids.measure,
        ids.metric,
        ids.variant,
      ],
    );
    return work(worker, ids);
  });
}

async function count(
  client: pg.PoolClient,
  table: string,
  column: string,
  id: string,
): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int as n from ${table} where ${column} = $1`,
    [id],
  );
  return rows[0]?.n ?? -1;
}

describe("the audit tables", () => {
  it.each([
    ["api_rw", "book_change", "delete from book_change"],
    ["worker_rw", "book_change", "delete from book_change"],
    ["api_rw", "book_change", "update book_change set action = 'x'"],
    ["worker_rw", "book_change", "update book_change set action = 'x'"],
    ["api_rw", "event", "delete from event"],
    ["api_rw", "event", "update event set kind = 'sync.failed'"],
    ["worker_rw", "event", "update event set kind = 'sync.failed'"],
  ] as const)("refuses %s on %s: %s", async (role, table, statement) => {
    await expect(asRole(role, statement)).rejects.toThrow(
      `permission denied for table ${table}`,
    );
  });

  it.each(["metric", "book_change", "event", "conventions"])(
    "refuses audit_writer a read of %s",
    async (table) => {
      await expect(
        inRollback(testPool("audit_writer"), (client) =>
          // nosemgrep: no-sql-built-by-string-formatting-typescript table comes from the constant list of this it.each
          client.query(`select 1 from ${table}`),
        ),
      ).rejects.toThrow(`permission denied for table ${table}`);
    },
  );
});

describe("the book's tables", () => {
  it("lets worker_rw read the conventions and not write them", async () => {
    const insert =
      "insert into conventions (version, document, set_by) values (1, '{}', 'sample-data-user')";
    await expect(
      asRole("worker_rw", "select * from conventions"),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(asRole("worker_rw", insert)).rejects.toThrow(
      "permission denied for table conventions",
    );
    await expect(asRole("api_rw", insert)).resolves.toMatchObject({
      rowCount: 1,
    });
  });

  it.each(["category", "term", "term_column", "term_metric"])(
    "lets worker_rw read %s for the search documents, and not write it",
    async (table) => {
      await expect(
        asRole("worker_rw", `select 1 from ${table}`),
      ).resolves.toMatchObject({ rowCount: 0 });
      await expect(asRole("worker_rw", `delete from ${table}`)).rejects.toThrow(
        `permission denied for table ${table}`,
      );
    },
  );

  it("deletes a variant with its measure", async () => {
    const left = await withVariant(async (worker, { measure, variant }) => {
      await worker.query("delete from powerbi_measure where id = $1", [
        measure,
      ]);
      return count(worker, "metric_variant", "id", variant);
    });
    expect(left).toBe(0);
  });

  it("deletes a metric's variants and term links with it, and keeps the measure", async () => {
    const left = await withVariant(async (owner, { measure, metric }) => {
      await owner.query(
        "with t as (insert into term (id, name) values ($1, 'Sample data term')) insert into term_metric (term_id, metric_id) values ($1, $2)",
        [randomUUID(), metric],
      );
      await owner.query("delete from metric where id = $1", [metric]);
      return {
        variants: await count(owner, "metric_variant", "metric_id", metric),
        links: await count(owner, "term_metric", "metric_id", metric),
        measures: await count(owner, "powerbi_measure", "id", measure),
      };
    }, "migrator");
    expect(left).toEqual({ variants: 0, links: 0, measures: 1 });
  });

  it("refuses to delete a category that holds a metric or a child", async () => {
    await inRollback(testPool("api_rw"), async (api) => {
      const [root, child] = [randomUUID(), randomUUID()];
      await api.query(
        "insert into category (id, parent_id, name, key) values ($1, null, 'Sales', 'sales'), ($2, $1, 'Orders', 'orders')",
        [root, child],
      );
      await api.query(
        "insert into metric (name, label, origin, category_id) values ('sample_data_metric', 'Sample data metric', 'curator', $1)",
        [child],
      );
      await api.query("savepoint holds_child");
      await expect(
        api.query("delete from category where id = $1", [root]),
      ).rejects.toThrow("violates foreign key constraint");
      await api.query("rollback to savepoint holds_child");
      await expect(
        api.query("delete from category where id = $1", [child]),
      ).rejects.toThrow("violates foreign key constraint");
    });
  });

  it.each([
    [
      "metric_custom_check",
      "insert into metric (name, label, origin, custom) values ('a', 'A', 'sync', '[]')",
    ],
    [
      "metric_name_key",
      "insert into metric (name, label, origin) values ('a', 'A', 'sync'), ('a', 'B', 'sync')",
    ],
    [
      "category_root_key_idx",
      "insert into category (name, key) values ('Sales', 'sales'), ('More sales', 'sales')",
    ],
    [
      "metric_variant_measure_id_key",
      "insert into metric_variant (metric_id, measure_id, assigned_by) select metric_id, measure_id, 'sync' from metric_variant where id = $1",
    ],
  ])("refuses a row that breaks %s", async (constraint, statement) => {
    await withVariant(
      (owner, { variant }) =>
        expect(
          owner.query(statement, statement.includes("$1") ? [variant] : []),
        ).rejects.toThrow(`"${constraint}"`),
      "migrator",
    );
  });

  it("takes a category key once under a parent", async () => {
    await inRollback(testPool("api_rw"), async (api) => {
      const root = randomUUID();
      await api.query(
        "insert into category (id, name, key) values ($1, 'Sales', 'sales')",
        [root],
      );
      await api.query(
        "insert into category (parent_id, name, key) values ($1, 'Orders', 'orders')",
        [root],
      );
      await expect(
        api.query(
          "insert into category (parent_id, name, key) values ($1, 'More orders', 'orders')",
          [root],
        ),
      ).rejects.toThrow('"category_parent_id_key_key"');
    });
  });

  it("lists in each CHECK exactly the values of its TypeScript union", async () => {
    const sets: Record<string, readonly string[]> = {
      metric_trust_state_check: book.TRUST_STATES,
      term_trust_state_check: book.TRUST_STATES,
      metric_origin_check: book.ORIGINS,
      metric_variant_comparison_check: book.COMPARISONS,
      metric_variant_assigned_by_check: book.ASSIGNED_BY,
      book_change_principal_kind_check: book.CHANGE_PRINCIPAL_KINDS,
      book_change_via_check: book.VIAS,
      event_kind_check: events.EVENT_KINDS,
      event_principal_kind_check: events.EVENT_PRINCIPAL_KINDS,
    };
    const { rows } = await testPool("api_rw").query<{
      name: string;
      definition: string;
    }>(
      "select conname as name, pg_get_constraintdef(oid) as definition from pg_constraint where contype = 'c' and conname = any($1)",
      [Object.keys(sets)],
    );
    const listed = new Map(
      rows.map((row) => [row.name, row.definition.match(/'[a-z_.]+'/g) ?? []]),
    );
    for (const [name, values] of Object.entries(sets)) {
      const quoted = (listed.get(name) ?? []).map((value) =>
        value.slice(1, -1),
      );
      expect(quoted.sort(), name).toEqual([...values].sort());
    }
  });
});

describe("the icon columns", () => {
  const bad = [
    "emoji:",
    "emoji:123456789",
    "emoji:<script>",
    "emoji:\u202eabc",
    "emoji:a\nb",
    "emoji:   ",
    "text:chart-line",
    "glyph:chart-line",
    "glyph:chart-line:pink",
    "glyph:Chart-Line:green",
    "glyph:not-a-lucide-name:green",
  ];
  const good = ["emoji:📈", "glyph:chart-line:green", "glyph:square:ink"];

  it.each([
    [
      "metric",
      "insert into metric (name, label, origin, icon) values ('a', 'A', 'sync', $1)",
    ],
    [
      "category",
      "insert into category (name, key, icon) values ('Sales', 'sales', $1)",
    ],
    ["term", "insert into term (name, icon) values ('a', $1)"],
  ])("refuses a bad icon on %s, written directly", async (table, insert) => {
    await inRollback(testPool("migrator"), async (owner) => {
      for (const icon of bad) {
        await owner.query("savepoint icon");
        await expect(owner.query(insert, [icon])).rejects.toThrow(
          `"${table}_icon_check"`,
        );
        await owner.query("rollback to savepoint icon");
      }
      for (const icon of good) {
        await owner.query("savepoint icon");
        await owner.query(insert, [icon]);
        await owner.query("rollback to savepoint icon");
      }
    });
  });

  it.each([
    ["powerbi_workspace", "update powerbi_workspace set icon = $1"],
    ["powerbi_dataset", "update powerbi_dataset set icon = $1"],
  ])("refuses a bad icon on %s by an update", async (table, update) => {
    await withVariant(async (owner) => {
      await expect(owner.query(update, ["glyph:nope:green"])).rejects.toThrow(
        `"${table}_icon_check"`,
      );
    }, "migrator");
  });
});
