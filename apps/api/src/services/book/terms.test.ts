import { randomUUID } from "node:crypto";
import { and, asc, count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  appReader,
  asPerson,
  fileUnder,
  id,
  metricIn,
  outsider,
  reaching,
  rolledBack,
  useMirror,
} from "../../../test/mirror-fixtures.js";
import type { Db } from "../../context.js";
import { bookChange, termColumn } from "../../db/schema/book.js";
import { event } from "../../db/schema/events.js";
import { piiRule } from "../../db/schema/pii.js";
import type { Principal } from "../../principal.js";
import { setConventionsAsAdmin } from "../conventions/service.js";
import {
  createTerm,
  deleteTerm,
  getTerm,
  linkColumn,
  listTerms,
  relateMetric,
  unlinkColumn,
  unrelateMetric,
  updateTerm,
} from "./terms.js";

useMirror();

const salesCurator = reaching({ powerbi_app_ids: [id.sales_app] }, "curator");
const bothCurator = reaching(
  { powerbi_app_ids: [id.sales_app, id.leadership_app] },
  "curator",
);
const as = (tx: Db, principal: Principal = salesCurator) =>
  asPerson(principal, { db: tx });

/** The book changes and events about one term; others' commits are not a test's business. */
const changesAbout = (tx: Db, termId: string) =>
  tx
    .select()
    .from(bookChange)
    .where(
      and(
        eq(bookChange.element_kind, "term"),
        eq(bookChange.element_id, termId),
      ),
    )
    .orderBy(asc(bookChange.id));
const eventsAbout = (tx: Db, termId: string) =>
  tx
    .select({
      kind: event.kind,
      element: event.element_id,
      data: event.data,
    })
    .from(event)
    .where(and(eq(event.element_kind, "term"), eq(event.element_id, termId)))
    .orderBy(asc(event.id));

describe("createTerm and updateTerm", () => {
  it("make a concept term, change it, and record each change and announce it", () =>
    rolledBack(async (tx) => {
      const context = as(tx);
      const created = await createTerm(context, {
        name: " Season ",
        definition: "A part of the trading year.",
        aliases: ["Trading season"],
        values: [{ value: "summer", meaning: "May to August" }],
      });
      expect(created).toMatchObject({
        kind: "term",
        name: "Season",
        type: "concept",
        trust_state: "draft",
        not_the_same_as: null,
        columns: [],
        metrics: [],
        custom: {},
      });

      // By alias, in any case; null aliases mean "not reviewed", [] means "none".
      const updated = await updateTerm(context, "trading SEASON", {
        definition: "A quarter of the trading year.",
        not_the_same_as: "Fiscal quarter",
      });
      expect(updated).toMatchObject({
        id: created.id,
        definition: "A quarter of the trading year.",
        aliases: ["Trading season"],
      });
      expect(
        (await updateTerm(context, created.id, { aliases: [] })).aliases,
      ).toEqual([]);
      await updateTerm(context, "Season", { aliases: null, values: null });
      // Nothing differs, so nothing is written.
      await updateTerm(context, "Season", { owner: undefined });

      const changes = await changesAbout(tx, created.id);
      expect(changes.map((row) => row.action)).toEqual([
        "create",
        "update",
        "update",
        "update",
      ]);
      expect(changes[0]).toMatchObject({
        element_id: created.id,
        before: null,
        after: { name: "Season", columns: [], metrics: [] },
      });
      expect(changes[1]).toMatchObject({
        before: { definition: "A part of the trading year." },
        after: { definition: "A quarter of the trading year." },
      });
      const events = await eventsAbout(tx, created.id);
      expect(events).toHaveLength(4);
      expect(events[0]).toEqual({
        kind: "term.changed",
        element: created.id,
        data: { action: "create", name: "Season" },
      });
    }));

  it("refuse a word another term already has, and a name or alias that is blank", () =>
    rolledBack(async (tx) => {
      const context = as(tx);
      await createTerm(context, {
        name: "Season",
        aliases: ["Trading season"],
      });
      const other = await createTerm(context, { name: "Cohort" });
      const refusals: [() => Promise<unknown>, string, string][] = [
        [
          () => createTerm(context, { name: "season" }),
          "conflict",
          `The term "Season" already goes by "season". Use that term, or pick another word.`,
        ],
        [
          () =>
            createTerm(context, {
              name: "Quarter",
              aliases: ["TRADING SEASON"],
            }),
          "conflict",
          `The term "Season" already goes by "TRADING SEASON". Use that term, or pick another word.`,
        ],
        [
          () => updateTerm(context, "Cohort", { aliases: ["Season"] }),
          "conflict",
          `The term "Season" already goes by "Season". Use that term, or pick another word.`,
        ],
        [
          () => createTerm(context, { name: "  " }),
          "invalid",
          "Give the term a name.",
        ],
        [
          () => updateTerm(context, "Cohort", { aliases: ["Group", " "] }),
          "invalid",
          "An alias cannot be blank.",
        ],
        [
          () => updateTerm(context, "Cohort", { values: "red" }),
          "invalid",
          "A term's values are a list, or a map from each value to what it means.",
        ],
        [
          () => getTerm(context, "Nothing"),
          "not_found",
          `No term goes by "Nothing". search finds a term by a word, and list_terms lists the terms A to Z.`,
        ],
      ];
      for (const [attempt, kind, message] of refusals) {
        await expect(attempt()).rejects.toMatchObject({ kind, message });
      }
      // Renaming a term to its own alias, or keeping its own words, is not a clash.
      await updateTerm(context, other.id, {
        name: "Cohort",
        aliases: ["Group"],
      });
    }));

  it("check the custom fields against term_fields and leave a missing required one to the checks", () =>
    rolledBack(async (tx) => {
      await setConventionsAsAdmin(as(tx, reaching({}, "admin")), {
        term_fields: {
          custom: [
            {
              key: "tier",
              label: "Tier",
              type: "choice",
              values: ["gold", "silver"],
            },
            {
              key: "owner_team",
              label: "Owner team",
              type: "text",
              required: true,
            },
          ],
        },
      });
      const context = as(tx);
      await expect(
        createTerm(context, { name: "Season", custom: { tier: "bronze" } }),
      ).rejects.toThrow("Tier (tier) must be one of gold, silver.");
      await expect(
        createTerm(context, { name: "Season", custom: { mood: "calm" } }),
      ).rejects.toThrow("mood is not a custom field the conventions name.");
      const season = await createTerm(context, {
        name: "Season",
        custom: { tier: "gold" },
      });
      expect(season.custom).toEqual({ tier: "gold" });
      await expect(
        updateTerm(context, "Season", { custom: { owner_team: 4 } }),
      ).rejects.toThrow("Owner team (owner_team) must be text.");
      expect(
        (
          await updateTerm(context, "Season", {
            custom: { owner_team: "Trading" },
          })
        ).custom,
      ).toEqual({ owner_team: "Trading" });
    }));

  it("refuse a viewer every change", () =>
    rolledBack(async (tx) => {
      await createTerm(as(tx), { name: "Season" });
      const viewer = as(tx, reaching({ powerbi_app_ids: [id.sales_app] }));
      const metricId = await metricIn(tx, "total_viewer_term_test");
      const attempts = [
        () => createTerm(viewer, { name: "Cohort" }),
        () => updateTerm(viewer, "Season", { definition: "Changed." }),
        () => deleteTerm(viewer, "Season"),
        () => linkColumn(viewer, "Season", id.channel),
        () => unlinkColumn(viewer, "Season", id.channel),
        () => relateMetric(viewer, "Season", metricId),
        () => unrelateMetric(viewer, "Season", metricId),
      ];
      for (const attempt of attempts) {
        await expect(attempt()).rejects.toMatchObject({
          kind: "refused",
          message: "You may not curate this book.",
        });
      }
      // A viewer still reads terms, and nothing the attempts did is there.
      const page = await listTerms(viewer);
      expect(page.items.map((item) => item.name)).toEqual(["Season"]);
    }));
});

describe("the columns behind a term", () => {
  it("links and unlinks columns the caller may describe, and links twice as once", () =>
    rolledBack(async (tx) => {
      const context = as(tx);
      const created = await createTerm(context, {
        name: "Sales channel",
        aliases: ["Origin"],
      });
      const linked = await linkColumn(context, "Origin", id.channel);
      expect(linked).toMatchObject({
        type: "dimension",
        columns: [
          {
            kind: "column",
            id: id.channel,
            name: "Channel",
            data_type: "String",
            table: { name: "Sales" },
            dataset: { id: id.sales, name: "Sales" },
            workspace: { id: id.sales_workspace },
          },
        ],
      });
      await linkColumn(context, "Sales channel", id.channel);
      // A column in a dataset the caller may not describe answers like a missing one.
      for (const column of [id.margin, randomUUID()]) {
        await expect(
          linkColumn(context, "Sales channel", column),
        ).rejects.toMatchObject({
          kind: "not_found",
          message: "No such column.",
        });
      }

      const unlinked = await unlinkColumn(context, "Sales channel", id.channel);
      expect(unlinked).toMatchObject({ type: "concept", columns: [] });
      const actions = await changesAbout(tx, created.id);
      expect(actions.map((row) => row.action)).toEqual([
        "create",
        "link_column",
        "unlink_column",
      ]);
    }));

  it("cuts a link to a column of a dataset the sync saw go, which it will not link", () =>
    rolledBack(async (tx) => {
      const context = as(
        tx,
        reaching({ powerbi_workspace_ids: [id.sales_workspace] }, "curator"),
      );
      const created = await createTerm(context, { name: "Legacy channel" });
      // The link dates from when the dataset was live.
      await tx
        .insert(termColumn)
        .values({ term_id: created.id, column_id: id.old_column });
      await expect(
        linkColumn(context, "Legacy channel", id.old_column),
      ).rejects.toMatchObject({
        kind: "not_found",
        message: "No such column.",
      });
      await unlinkColumn(context, "Legacy channel", id.old_column);
      expect(
        await tx
          .select()
          .from(termColumn)
          .where(eq(termColumn.term_id, created.id)),
      ).toEqual([]);
    }));

  it("shows a caller only the columns and metrics in datasets it may describe", () =>
    rolledBack(async (tx) => {
      const context = as(tx, bothCurator);
      await createTerm(context, { name: "Profit measure" });
      await linkColumn(context, "Profit measure", id.channel);
      await linkColumn(context, "Profit measure", id.margin);
      const seen = await metricIn(tx, "total_seen_term_test");
      await fileUnder(tx, seen, id.net_sales);
      const bare = await metricIn(tx, "total_bare_term_test");
      const finance = await metricIn(tx, "total_finance_term_test");
      await fileUnder(tx, finance, id.profit);
      for (const metricId of [seen, bare, finance]) {
        await relateMetric(context, "Profit measure", metricId);
      }
      const read = async (principal: Principal) => {
        const term = await getTerm(as(tx, principal), "Profit measure");
        return [
          term.type,
          term.columns.map((column) => column.name),
          term.metrics.map((related) => [
            related.name,
            related.summary,
            related.trust_state,
          ]),
        ];
      };
      expect(await read(bothCurator)).toEqual([
        "dimension",
        ["Margin", "Channel"],
        [
          ["total_bare_term_test", "", "draft"],
          ["total_finance_term_test", "", "draft"],
          ["total_seen_term_test", "", "draft"],
        ],
      ]);
      expect(await read(appReader)).toEqual([
        "dimension",
        ["Channel"],
        [
          ["total_bare_term_test", "", "draft"],
          ["total_seen_term_test", "", "draft"],
        ],
      ]);

      const counts = async (principal: Principal) =>
        (await listTerms(as(tx, principal))).items.find(
          (item) => item.name === "Profit measure",
        )?.column_count;
      expect(await counts(bothCurator)).toBe(2);
      expect(await counts(appReader)).toBe(1);
      expect(await counts(outsider)).toBe(0);
      expect(await read(outsider)).toEqual([
        "concept",
        [],
        [["total_bare_term_test", "", "draft"]],
      ]);

      // The metric a curator may not see answers like one that is missing.
      const hiddenMetric = relateMetric(as(tx), "Profit measure", finance);
      await expect(hiddenMetric).rejects.toMatchObject({
        kind: "not_found",
        message: `No such metric: ${finance}.`,
      });
      const related = await unrelateMetric(
        context,
        "Profit measure",
        "total_bare_term_test",
      );
      expect(related.metrics.map((item) => item.name)).toEqual([
        "total_finance_term_test",
        "total_seen_term_test",
      ]);
    }));

  it("refuses a concept term named for a column that already backs a dimension term", () =>
    rolledBack(async (tx) => {
      const context = as(tx);
      await createTerm(context, { name: "Sales channel" });
      // Nothing backs the Channel column yet, so the word is free.
      await createTerm(context, { name: "Channel mix" });
      await linkColumn(context, "Sales channel", id.channel);
      const refused = (message: string) => ({ kind: "conflict", message });
      const sentence = `"Channel" is the name of a column that already backs the term "Sales channel", and a concept term has no column behind it. Define the word on "Sales channel": add it as an alias or extend its definition.`;
      await expect(
        createTerm(context, { name: "channel" }),
      ).rejects.toMatchObject(refused(sentence));
      await expect(
        createTerm(context, { name: "Season", aliases: ["Channel"] }),
      ).rejects.toMatchObject(refused(sentence));
      await expect(
        updateTerm(context, "Channel mix", { aliases: ["Channel"] }),
      ).rejects.toMatchObject(refused(sentence));

      // A dimension term may carry the word; unlinking its last column would make it a concept term that does not.
      await createTerm(context, { name: "Order origin" });
      await linkColumn(context, "Order origin", id.order_date);
      await updateTerm(context, "Order origin", { aliases: ["Channel"] });
      await expect(
        unlinkColumn(context, "Order origin", id.order_date),
      ).rejects.toMatchObject(refused(sentence));
      expect((await getTerm(context, "Order origin")).columns).toHaveLength(1);
    }));
});

describe("deleteTerm", () => {
  it("deletes the term with its links and records it with the columns it had", () =>
    rolledBack(async (tx) => {
      const context = as(tx);
      await createTerm(context, { name: "Sales channel" });
      const term = await linkColumn(context, "Sales channel", id.channel);
      await deleteTerm(context, "Sales channel");
      await expect(getTerm(context, "Sales channel")).rejects.toMatchObject({
        kind: "not_found",
      });
      const [, , last] = await changesAbout(tx, term.id);
      expect(last).toMatchObject({
        action: "delete",
        element_id: term.id,
        before: { name: "Sales channel", columns: [id.channel] },
        after: null,
      });
    }));
});

describe("listTerms", () => {
  it("matches normalized names and aliases and counts before paging", () =>
    rolledBack(async (tx) => {
      const context = as(tx);
      await createTerm(context, {
        name: "Sample_word",
        definition: "Sample.",
        aliases: ["Odd%_\\word"],
      });
      await createTerm(context, {
        name: "Sample word two",
        definition: "Sample.",
      });
      const page = await listTerms(context, {
        name_contains: "SAMPLE WORD",
        limit: 1,
      });
      expect(page).toMatchObject({
        total: 2,
        items: [{ name: "Sample_word" }],
      });
      expect(
        await listTerms(context, { name_contains: "odd% \\word" }),
      ).toMatchObject({ total: 1 });
      expect(
        await listTerms(context, {
          cursor: page.next_cursor ?? "",
          name_contains: "sample_word",
        }),
      ).not.toHaveProperty("total");
      await expect(getTerm(context, "Missing sample")).rejects.toMatchObject({
        message:
          'No term goes by "Missing sample". search finds a term by a word, and list_terms lists the terms A to Z.',
      });
    }));

  it("lists in name order with a summary, filters, and pages by an opaque cursor", () =>
    rolledBack(async (tx) => {
      const context = as(tx, bothCurator);
      await createTerm(context, {
        name: "Aaa season",
        definition: "Sample season ".repeat(30),
        custom: {},
      });
      await createTerm(context, { name: "Bbb channel", owner: "Trading" });
      await createTerm(context, { name: "Ccc margin" });
      await linkColumn(context, "Bbb channel", id.channel);
      await linkColumn(context, "Ccc margin", id.margin);

      const names = async (
        filters: object,
        principal: Principal = bothCurator,
      ) =>
        (await listTerms(as(tx, principal), filters)).items.map(
          (item) => item.name,
        );
      const everything = await listTerms(context);
      expect(everything.next_cursor).toBeNull();
      expect(
        everything.items.map((item) => [
          item.name,
          item.type,
          item.summary.length,
        ]),
      ).toEqual([
        ["Aaa season", "concept", 238],
        ["Bbb channel", "dimension", 0],
        ["Ccc margin", "dimension", 0],
      ]);
      expect(everything.items[0]?.summary.length).toBeLessThanOrEqual(240);
      expect(everything.items[0]?.summary).toMatch(/season…$/u);
      expect(everything.items[0]?.summary_truncated).toBe(true);
      expect(everything.items[1]).not.toHaveProperty("summary_truncated");
      expect(everything.items[1]).toMatchObject({
        kind: "term",
        owner: "Trading",
        trust_state: "draft",
      });

      expect(await names({ name_prefix: "BBB" })).toEqual(["Bbb channel"]);
      expect(await names({ trust_states: ["human_verified"] })).toEqual([]);
      expect(
        await names({ trust_states: ["draft", "agent_verified"] }),
      ).toHaveLength(3);
      expect(await names({ dataset: "Sales" })).toEqual(["Bbb channel"]);
      expect(await names({ dataset: id.finance })).toEqual(["Ccc margin"]);
      expect(await names({ workspace: "Finance" })).toEqual(["Ccc margin"]);
      expect(await names({ app: id.sales_app })).toEqual(["Bbb channel"]);
      // A direct share shows Sales, not its app: the app filters as a missing one.
      const shared = reaching({ powerbi_dataset_ids: [id.sales] });
      expect(await names({ dataset: id.sales }, shared)).toEqual([
        "Bbb channel",
      ]);
      for (const app of ["Sales app", id.sales_app, "Nothing", randomUUID()])
        expect(await names({ app }, shared)).toEqual([]);
      // A dataset the caller may not describe lists nothing, as a missing one does.
      expect(await names({ dataset: id.finance }, appReader)).toEqual([]);
      expect(await names({ dataset: randomUUID() }, appReader)).toEqual([]);
      expect(
        await names({ workspace: id.finance_workspace }, appReader),
      ).toEqual([]);

      const first = await listTerms(context, { limit: 2 });
      const second = await listTerms(context, {
        limit: 2,
        cursor: first.next_cursor ?? "",
      });
      expect([
        first.items.length,
        second.items.map((item) => item.name),
      ]).toEqual([2, ["Ccc margin"]]);
      expect(second.next_cursor).toBeNull();
      await expect(
        listTerms(context, { cursor: "not an id" }),
      ).rejects.toMatchObject({
        kind: "invalid",
      });
    }));

  it("filters on custom fields as text", () =>
    rolledBack(async (tx) => {
      await setConventionsAsAdmin(as(tx, reaching({}, "admin")), {
        term_fields: {
          custom: [
            { key: "owner_team", label: "Owner team", type: "text" },
            { key: "regulated", label: "Regulated", type: "boolean" },
          ],
        },
      });
      const context = as(tx);
      await createTerm(context, {
        name: "Season",
        custom: { owner_team: "finance", regulated: true },
      });
      await createTerm(context, {
        name: "Cohort",
        custom: { owner_team: "crm" },
      });
      const only = async (custom: Record<string, string>) =>
        (await listTerms(context, { custom })).items.map((item) => item.name);
      expect(await only({ owner_team: "finance" })).toEqual(["Season"]);
      expect(await only({ regulated: "true" })).toEqual(["Season"]);
      expect(await only({ owner_team: "crm", regulated: "true" })).toEqual([]);
    }));
});

describe("PII backing columns", () => {
  const reader: Principal = {
    ...salesCurator,
    roles: [...salesCurator.roles, "pii_reader"],
  };
  const markChannel = (tx: Db) =>
    tx.insert(piiRule).values({
      kind: "column",
      table_name: "Sales",
      name: "Channel",
      pii: true,
      set_by_kind: "person",
      set_by_id: "x",
      set_via: "api",
    });

  it("leaves a PII column out of get_term unless the caller reads PII", () =>
    rolledBack(async (tx) => {
      await markChannel(tx);
      await createTerm(as(tx), { name: "Mixed backing" });
      await linkColumn(as(tx, reader), "Mixed backing", id.channel);
      await linkColumn(as(tx), "Mixed backing", id.order_date);
      const columns = async (principal: Principal) =>
        (await getTerm(as(tx, principal), "Mixed backing")).columns.map(
          (column) => column.name,
        );
      expect(await columns(salesCurator)).toEqual(["Order date"]);
      expect(await columns(reader)).toEqual(["Channel", "Order date"]);
    }));

  it("does not match a dataset filter in list_terms through a PII column alone", () =>
    rolledBack(async (tx) => {
      await markChannel(tx);
      await createTerm(as(tx), { name: "Only channel" });
      await linkColumn(as(tx, reader), "Only channel", id.channel);
      const found = async (principal: Principal) =>
        (await listTerms(as(tx, principal), { dataset: id.sales })).items.map(
          (item) => item.name,
        );
      expect(await found(salesCurator)).toEqual([]);
      expect(await found(reader)).toEqual(["Only channel"]);
    }));

  it("answers not_found, and writes nothing, to linking or unlinking a PII column", () =>
    rolledBack(async (tx) => {
      await markChannel(tx);
      await createTerm(as(tx), { name: "Channel term" });
      await linkColumn(as(tx, reader), "Channel term", id.channel);
      const missing = { kind: "not_found", message: "No such column." };
      await expect(
        unlinkColumn(as(tx), "Channel term", id.channel),
      ).rejects.toMatchObject(missing);
      await createTerm(as(tx), { name: "Other term" });
      await expect(
        linkColumn(as(tx), "Other term", id.channel),
      ).rejects.toMatchObject(missing);
      const [kept] = await tx
        .select({ n: count() })
        .from(termColumn)
        .where(eq(termColumn.column_id, id.channel));
      expect(kept?.n).toBe(1);
    }));
});
