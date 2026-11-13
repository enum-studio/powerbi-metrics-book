import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  devIdentity,
  ensureEnvLocal,
  gitSha,
  writeConnectorConfigs,
} from "./dev-stack.mjs";
import { SAMPLE } from "../apps/api/src/services/sample/tenant.ts";

test("two checkout paths get two project names and api ports, one path the same each time", () => {
  const a = devIdentity("/work/one/powerbi-metrics-book");
  const b = devIdentity("/work/two/powerbi-metrics-book");
  assert.notEqual(a.project, b.project);
  assert.notEqual(a.api_port, b.api_port);
  assert.deepEqual(a, devIdentity("/work/one/powerbi-metrics-book"));
});

test("the api is in 30000 to 39999 with the mock beside it, for any path", () => {
  for (let n = 0; n < 500; n += 1) {
    const { project, api_port, mock_port } = devIdentity(`/work/${String(n)}`);
    assert.match(project, /^pbmb_[0-9a-f]{8}$/);
    assert.ok(api_port >= 30000 && api_port <= 39998, String(api_port));
    assert.equal(mock_port, api_port + 1);
  }
});

test("the first call writes .env.local, and a later call leaves it alone", () => {
  const root = mkdtempSync(join(tmpdir(), "dev-stack-"));
  const file = join(root, ".env.local");
  assert.equal(ensureEnvLocal(root), true);
  const written = readFileSync(file, "utf8");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  for (const name of [
    "POSTGRES_PASSWORD",
    "MIGRATOR_PASSWORD",
    "API_RW_PASSWORD",
    "WORKER_RW_PASSWORD",
    "AUDIT_WRITER_PASSWORD",
    "AUTH_SECRET",
  ])
    assert.match(written, new RegExp(`^${name}=[0-9a-f]{48,}$`, "m"));

  assert.equal(ensureEnvLocal(root), false);
  assert.equal(readFileSync(file, "utf8"), written);

  writeFileSync(file, "AUTH_SECRET=chosen-by-a-person\n");
  assert.equal(ensureEnvLocal(root), false);
  assert.equal(readFileSync(file, "utf8"), "AUTH_SECRET=chosen-by-a-person\n");
});

test("the connector configs name this checkout's api port, and a later call overwrites them", () => {
  const root = mkdtempSync(join(tmpdir(), "dev-stack-"));
  const read = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));
  writeConnectorConfigs(root, { api_port: 31234 });
  for (const file of [".mcp.json", ".cursor/mcp.json"])
    assert.equal(
      read(file).mcpServers.powerbi_metrics_book_dev.url,
      "http://localhost:31234/api/mcp",
    );
  assert.equal(
    read(".mcp.json").mcpServers.powerbi_metrics_book_dev.type,
    "http",
  );

  writeConnectorConfigs(root, { api_port: 35678 });
  for (const file of [".mcp.json", ".cursor/mcp.json"])
    assert.equal(
      read(file).mcpServers.powerbi_metrics_book_dev.url,
      "http://localhost:35678/api/mcp",
    );
});

test("the sample values the script signs in with are the mock tenant's", () => {
  const tenant = readFileSync(
    new URL("../packages/powerbi-mock/src/sample/tenant.ts", import.meta.url),
    "utf8",
  );
  for (const value of [
    SAMPLE.tenant_id,
    SAMPLE.app.client_id,
    SAMPLE.app.secret,
    SAMPLE.scanner.client_id,
    SAMPLE.scanner.secret,
    ...Object.values(SAMPLE.people),
  ])
    assert.ok(tenant.includes(value), `${value} is not in the sample tenant`);
});

test("the image's commit sha is read from the checkout, and a folder with none is a clear error", () => {
  assert.match(
    gitSha(new URL("..", import.meta.url).pathname),
    /^[0-9a-f]{40}$/,
  );
  assert.throws(
    () => gitSha(mkdtempSync(join(tmpdir(), "dev-stack-"))),
    /needs the commit's sha as GIT_SHA, and .* failed/,
  );
});
