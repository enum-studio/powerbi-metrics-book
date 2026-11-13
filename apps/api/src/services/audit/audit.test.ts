import { randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeTestPools,
  createTestDeps,
  principals,
  testPool,
} from "../../../test/deps.js";
import { createDb } from "../../db/client.js";
import { auditEvent } from "../../db/schema/audit.js";
import { readAudit } from "./read.js";
import { writeAudit } from "./write.js";

// The rows are committed by audit_writer's own connection, so each run keys
// its principals on a fresh prefix and the migrator deletes them afterwards.
const RUN = `test-audit-${randomUUID()}`;
const deps = createTestDeps();
const admin = { ...principals.admin, id: `${RUN}-admin` };
const agent = {
  ...principals.viewer,
  id: `${RUN}-agent`,
  via: "mcp" as const,
  client_id: "claude-desktop",
};

afterAll(async () => {
  await createDb(testPool("migrator"))
    .delete(auditEvent)
    .where(like(auditEvent.principal_id, `${RUN}-%`));
  await closeTestPools();
});

describe("writeAudit and readAudit", () => {
  it("records who did what through which client, and reads it back newest first, a page at a time", async () => {
    const before = new Date(Date.now() - 1000);
    await writeAudit(deps, {
      principal: admin,
      action: "settings.set",
      resource: { kind: "admin", id: "powerbi.sync.schedule" },
      decision: "allow",
      detail: { from: "0 * * * *", to: "30 * * * *" },
    });
    await writeAudit(deps, {
      principal: agent,
      action: "dataset.query",
      resource: { kind: "dataset", id: "sample-dataset" },
      decision: "deny",
      reason: "not a member of the workspace",
    });
    await writeAudit(deps, {
      principal: admin,
      action: "sync.run",
      resource: null,
      decision: "allow",
    });

    const mine = await readAudit(deps.db, { principal: admin.id });
    expect(mine.map((event) => event.action)).toEqual([
      "sync.run",
      "settings.set",
    ]);
    expect(mine[1]).toMatchObject({
      principal_kind: "person",
      via: "browser",
      client_id: null,
      resource_kind: "admin",
      resource_id: "powerbi.sync.schedule",
      detail: { from: "0 * * * *", to: "30 * * * *" },
    });

    const [denial] = await readAudit(deps.db, {
      principal: agent.id,
      action: "dataset.query",
      since: before,
    });
    expect(denial).toMatchObject({
      via: "mcp",
      client_id: "claude-desktop",
      decision: "deny",
      reason: "not a member of the workspace",
    });

    const [newest] = await readAudit(deps.db, {
      principal: admin.id,
      limit: 1,
    });
    const next = await readAudit(deps.db, {
      principal: admin.id,
      before_id: newest?.id,
    });
    expect(next.map((event) => event.action)).toEqual(["settings.set"]);
    expect(
      await readAudit(deps.db, {
        principal: admin.id,
        since: new Date(Date.now() + 60_000),
      }),
    ).toEqual([]);
  });
});
