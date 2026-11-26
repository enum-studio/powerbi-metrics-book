import { and, eq } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { closeTestPools } from "../../../test/deps.js";
import { asPerson, reaching } from "../../../test/mirror-fixtures.js";
import { inSampleMirror } from "../../../test/sample-mirror.js";
import {
  bookChange,
  metric,
  metricFollow,
  metricLink,
  metricVariant,
} from "../../db/schema/book.js";
import { user } from "../../db/schema/auth.js";
import { readTools } from "../../mcp/tools/read.js";
import { auditEvent } from "../../db/schema/audit.js";
import { createCategory } from "./categories.js";
import { exportBook, getGuide } from "./guide.js";
import {
  createMetric,
  getMetric,
  deleteMetric,
  updateMetric,
} from "./metrics.js";
import { followMetric } from "./ownership.js";
import { myMetrics } from "./my-metrics.js";
import { setRelation } from "./relations.js";

afterAll(closeTestPools);

it("writes a link once, records it, preserves reasons on both sides, and refuses viewers", async () => {
  await inSampleMirror("api_rw", async (db) => {
    const curator = asPerson(reaching({}, "curator"), { db });
    const a = await createMetric(curator, { name: "a", label: "A" });
    const b = await createMetric(curator, { name: "b", label: "B" });
    const linked = await setRelation(curator, a.id, b.id, {
      kind: "link",
      value: { movement: "same", reason: "Shared demand." },
    });
    expect(linked.moves_with[0]).toMatchObject({
      metric: { id: b.id },
      reason: "Shared demand.",
    });
    expect((await getMetric(curator, b.id)).moves_with[0]?.reason).toBe(
      "Shared demand.",
    );
    await setRelation(curator, b.id, a.id, {
      kind: "link",
      value: { movement: "opposite", reason: "Returns reduce sales." },
    });
    expect(await db.select().from(metricLink)).toHaveLength(1);
    expect(
      await db
        .select()
        .from(bookChange)
        .where(eq(bookChange.element_kind, "metric_link")),
    ).toHaveLength(2);
    await expect(
      setRelation(asPerson(reaching({}), { db }), a.id, b.id, {
        kind: "link",
        value: null,
      }),
    ).rejects.toMatchObject({ kind: "refused" });
    await expect(deleteMetric(curator, a.id)).rejects.toMatchObject({
      kind: "conflict",
    });
  });
});

it("omits a hidden neighbor and its whole equation from the guide and exports", async () => {
  await inSampleMirror("api_rw", async (db, sample) => {
    const curator = asPerson(
      reaching(
        { powerbi_workspace_ids: sample.tenant.workspaces.map((w) => w.id) },
        "curator",
      ),
      { db },
    );
    const a = await createMetric(curator, {
      name: "visible",
      label: "Visible",
    });
    const b = await createMetric(curator, {
      name: "hidden_neighbor",
      label: "Hidden neighbor",
    });
    const measure = sample.measureId({
      dataset: "Finance",
      measure: "Revenue",
    });
    await db
      .insert(metricVariant)
      .values({ metric_id: b.id, measure_id: measure, assigned_by: "curator" });
    await setRelation(curator, a.id, b.id, {
      kind: "link",
      value: { movement: "depends", reason: "Confidential explanation." },
    });
    await setRelation(curator, a.id, b.id, {
      kind: "edge",
      value: { sign: 1, operation: "sum" },
    });
    const reader = asPerson(reaching({}), { db });
    await reader.settings.set("guide.result_metric", a.id, reader.principal);
    await reader.settings.set("usage.capture", false, reader.principal);
    expect((await getMetric(reader, a.id)).moves_with).toEqual([]);
    expect((await getGuide(reader)).sum).toBeNull();
    const exported = await exportBook(reader, "markdown");
    expect(exported.markdown).not.toMatch(
      /hidden_neighbor|Hidden neighbor|Confidential explanation/,
    );
    await expect(
      setRelation(
        { ...reader, principal: { ...reader.principal, roles: ["curator"] } },
        a.id,
        b.id,
        { kind: "link", value: null },
      ),
    ).rejects.toMatchObject({ kind: "not_found" });
  });
});

it("refuses cycles and mixed operations with actionable errors", async () => {
  await inSampleMirror("api_rw", async (db) => {
    const curator = asPerson(reaching({}, "curator"), { db });
    const a = await createMetric(curator, { name: "a", label: "A" });
    const b = await createMetric(curator, { name: "b", label: "B" });
    const c = await createMetric(curator, { name: "c", label: "C" });
    await setRelation(curator, a.id, b.id, {
      kind: "edge",
      value: { operation: "sum", sign: 1 },
    });
    await expect(
      setRelation(curator, b.id, a.id, {
        kind: "edge",
        value: { operation: "sum", sign: 1 },
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
    await expect(
      setRelation(curator, a.id, c.id, {
        kind: "edge",
        value: { operation: "product", sign: 1 },
      }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });
});

it("keeps follows personal, rejects service accounts, and honors both export switches", async () => {
  await inSampleMirror("api_rw", async (db) => {
    const curator = asPerson(reaching({}, "curator"), { db });
    const a = await createMetric(curator, { name: "a", label: "A" });
    await db
      .insert(user)
      .values({
        id: curator.principal.id,
        name: "Sample reader",
        email: "reader@sample.example",
        emailVerified: true,
      })
      .onConflictDoNothing();
    const changes = await db.select().from(bookChange);
    await followMetric(curator, a.id, true);
    expect((await myMetrics(curator)).items.map((row) => row.id)).toEqual([
      a.id,
    ]);
    expect(await db.select().from(bookChange)).toHaveLength(changes.length);
    const account = {
      ...curator,
      principal: { ...curator.principal, kind: "service_account" as const },
    };
    await expect(
      myMetrics(account, { with_values: true }),
    ).rejects.toMatchObject({ kind: "refused" });
    await expect(followMetric(account, a.id, false)).rejects.toMatchObject({
      kind: "refused",
    });
    expect(
      await db
        .select()
        .from(metricFollow)
        .where(
          and(
            eq(metricFollow.person_id, curator.principal.id),
            eq(metricFollow.metric_id, a.id),
          ),
        ),
    ).toHaveLength(1);
    await curator.settings.set("usage.capture", false, curator.principal);
    await curator.settings.set("exports.markdown", false, curator.principal);
    await expect(exportBook(curator, "markdown", a.id)).rejects.toMatchObject({
      kind: "refused",
    });
    expect(await exportBook(curator, "pdf", a.id)).toEqual({ markdown: "" });
    await curator.settings.set("exports.pdf", false, curator.principal);
    await expect(exportBook(curator, "pdf", a.id)).rejects.toMatchObject({
      kind: "refused",
    });
    await followMetric(curator, a.id, false);
    expect((await myMetrics(curator)).items).toEqual([]);
  });
});

it("a token changing a relationship withdraws human approval from both endpoints", async () => {
  await inSampleMirror("api_rw", async (db) => {
    const curator = asPerson(reaching({}, "curator"), { db });
    const a = await createMetric(curator, { name: "a", label: "A" });
    const b = await createMetric(curator, { name: "b", label: "B" });
    await db.update(metric).set({ trust_state: "human_verified" });
    await setRelation(
      { ...curator, principal: { ...curator.principal, via: "cli" } },
      a.id,
      b.id,
      {
        kind: "link",
        value: { movement: "depends", reason: "Shared demand." },
      },
    );
    expect((await getMetric(curator, a.id)).trust_state).toBe("draft");
    expect((await getMetric(curator, b.id)).trust_state).toBe("draft");
    await expect(
      updateMetric(curator, a.id, { tier: "invented" }),
    ).rejects.toMatchObject({ kind: "invalid" });
  });
});

it.each(["link", "edge"] as const)(
  "retrying an unchanged %s preserves approval and history",
  async (kind) => {
    await inSampleMirror("api_rw", async (db) => {
      const curator = asPerson(reaching({}, "curator"), { db });
      const a = await createMetric(curator, { name: "a", label: "A" });
      const b = await createMetric(curator, { name: "b", label: "B" });
      const input =
        kind === "link"
          ? {
              kind,
              value: { movement: "same" as const, reason: "Shared demand." },
            }
          : { kind, value: { operation: "sum" as const, sign: 1 as const } };
      await setRelation(curator, a.id, b.id, input);
      await db.update(metric).set({ trust_state: "human_verified" });
      const before = await db.select().from(bookChange);
      await setRelation(
        { ...curator, principal: { ...curator.principal, via: "cli" } },
        a.id,
        b.id,
        input,
      );
      expect((await getMetric(curator, a.id)).trust_state).toBe(
        "human_verified",
      );
      expect((await getMetric(curator, b.id)).trust_state).toBe(
        "human_verified",
      );
      expect(await db.select().from(bookChange)).toEqual(before);
    });
  },
);

it("exports the reading-page structure and counts initial reads but not continuation chunks or stale revisions", async () => {
  await inSampleMirror("api_rw", async (db) => {
    const curator = asPerson(reaching({}, "curator"), { db });
    const category = await createCategory(curator, "sales", {
      name: "Sales",
      question: "Are orders growing?",
    });
    const a = await createMetric(curator, {
      name: "a",
      label: "A",
      category: category.path,
      definition: "x".repeat(20_000),
      use_for: "Plan capacity.",
    });
    const b = await createMetric(curator, { name: "b", label: "B" });
    await setRelation(curator, a.id, b.id, {
      kind: "edge",
      value: { operation: "sum", sign: 1 },
    });
    await curator.settings.set("guide.result_metric", a.id, curator.principal);
    await curator.settings.set(
      "guide.featured_metric",
      a.id,
      curator.principal,
    );
    const read = readTools.find((tool) => tool.name === "read");
    if (!read) throw new Error("Missing read tool");
    const exports = () =>
      db
        .select()
        .from(auditEvent)
        .where(
          and(
            eq(auditEvent.action, "book.export"),
            eq(auditEvent.principal_id, curator.principal.id),
          ),
        );
    const before = (await exports()).length;
    const first = await read.call(curator, { kind: "guide" });
    expect(first.isError).toBeUndefined();
    const body = JSON.parse(first.content[0]?.text ?? "{}") as {
      next_offset: number;
      revision: string;
    };
    expect(body.next_offset).toBeGreaterThan(0);
    expect(await exports()).toHaveLength(before + 1);
    expect(
      (
        await read.call(curator, {
          kind: "guide",
          offset: body.next_offset,
          revision: body.revision,
        })
      ).isError,
    ).toBeUndefined();
    expect(await exports()).toHaveLength(before + 1);
    await read.call(curator, { kind: "guide", offset: body.next_offset });
    expect(await exports()).toHaveLength(before + 2);
    expect(
      (await read.call(curator, { kind: "guide", revision: "0".repeat(64) }))
        .isError,
    ).toBe(true);
    expect(await exports()).toHaveLength(before + 2);
    const full = await exportBook(curator, "markdown");
    for (const text of [
      "## How the result adds up",
      "## The areas at a glance",
      "Headlines:",
      "## How to read a name",
      "## Sales",
      "Are orders growing?",
      "### A",
      "#### Use for",
      "## A closer look",
    ])
      expect(full.markdown).toContain(text);
  });
});

it.each(["powerbi", "everyone"] as const)(
  "explains %s visibility using shifted variants as well as base variants",
  async (mode) => {
    await inSampleMirror("api_rw", async (db, sample) => {
      const context = asPerson(
        reaching(
          { powerbi_workspace_ids: sample.tenant.workspaces.map((w) => w.id) },
          "curator",
        ),
        { db, mode },
      );
      await context.settings.set(
        "access.metadata_visibility",
        mode,
        context.principal,
      );
      const entry = await createMetric(context, {
        name: "shifted",
        label: "Shifted",
      });
      await db.insert(metricVariant).values({
        metric_id: entry.id,
        measure_id: sample.measureId({
          dataset: "Finance",
          measure: "Revenue",
        }),
        period: "previous_year",
        assigned_by: "curator",
      });
      const detail = await getMetric(context, entry.id);
      expect(detail.base_variants).toEqual([]);
      expect(detail.who_may_see).toContain("Finance");
      expect(detail.who_may_see).toContain(
        mode === "everyone" ? "Signed-in people" : "they can read in Power BI",
      );
      expect(
        (await getGuide(context)).metrics.find((m) => m.id === entry.id)
          ?.who_may_see,
      ).toBe(detail.who_may_see);
    });
  },
);
