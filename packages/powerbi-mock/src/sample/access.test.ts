import { describe, expect, it } from "vitest";
import { startPowerBi } from "../powerbi/test-support.js";
import type { AccessEntry, Dataset } from "../tenant.js";
import {
  EXPECTED_MEASURE_DAX,
  EXPECTED_QUERY_ACCESS,
  EXPECTED_VISIBILITY,
  type MeasureDax,
} from "./expected.js";
import { sampleTenant } from "./tenant.js";

const tenant = sampleTenant();
const mock = startPowerBi(tenant);

function datasetNamed(name: string): Dataset {
  const dataset = tenant.datasets.find((d) => d.name === name);
  if (!dataset) throw new Error(`no dataset ${name}`);
  return dataset;
}

/** A person by email, or the service principal by app id. */
function tokenFor(principal: string): Promise<string> {
  const person = tenant.people.find((p) => p.email === principal);
  return person
    ? mock.personToken(person.object_id)
    : mock.principalToken(principal);
}

function query(token: string, path: string, dax: string) {
  return mock.call(`${path}/executeQueries`, token, {
    body: {
      queries: [{ query: dax }],
      serializerSettings: { includeNulls: true },
    },
  });
}

describe("the sample tenant's access expectations, against the mock", () => {
  it("lists for each person the datasets their workspaces, app audiences and shares reach", () => {
    const visible = Object.fromEntries(
      tenant.people.map((person) => {
        const names = (entries: AccessEntry[]) =>
          entries.some(
            (e) =>
              e.access_right !== "None" &&
              ((e.principal_type === "User" &&
                e.object_id === person.object_id) ||
                (e.principal_type === "Group" &&
                  person.group_ids.includes(e.object_id))),
          );
        const reached = tenant.datasets.filter(
          (d) =>
            names(
              tenant.workspaces.find((w) => w.id === d.workspace_id)?.users ??
                [],
            ) ||
            names(d.users) ||
            tenant.apps.some(
              (a) =>
                names(a.users) &&
                tenant.reports.some(
                  (r) => r.app_id === a.id && r.dataset_id === d.id,
                ),
            ),
        );
        return [person.email, reached.map((d) => d.name)];
      }),
    );
    expect(visible).toEqual(EXPECTED_VISIBILITY);
  });

  it("answers each principal's query on each path as EXPECTED_QUERY_ACCESS says", async () => {
    const actual: typeof EXPECTED_QUERY_ACCESS = {};
    for (const [principal, by_dataset] of Object.entries(
      EXPECTED_QUERY_ACCESS,
    )) {
      const token = await tokenFor(principal);
      actual[principal] = {};
      for (const name of Object.keys(by_dataset)) {
        const dataset = datasetNamed(name);
        const ok = async (path: string) =>
          (await query(token, path, "EVALUATE TOPN(1, 'Date')")).status === 200;
        actual[principal][name] = {
          org_path: await ok(`datasets/${dataset.id}`),
          groups_path: await ok(
            `groups/${dataset.workspace_id}/datasets/${dataset.id}`,
          ),
        };
      }
    }
    expect(actual).toEqual(EXPECTED_QUERY_ACCESS);
  });

  it("shows measures' DAX in INFO.VIEW.MEASURES as EXPECTED_MEASURE_DAX says", async () => {
    const actual: typeof EXPECTED_MEASURE_DAX = {};
    for (const [principal, by_dataset] of Object.entries(
      EXPECTED_MEASURE_DAX,
    )) {
      const token = await tokenFor(principal);
      actual[principal] = {};
      for (const name of Object.keys(by_dataset)) {
        const response = await query(
          token,
          `datasets/${datasetNamed(name).id}`,
          "EVALUATE INFO.VIEW.MEASURES()",
        );
        let outcome: MeasureDax = "refused";
        if (response.status === 200) {
          const answer = (await response.json()) as {
            results: { tables: { rows: Record<string, unknown>[] }[] }[];
          };
          const rows = answer.results[0]?.tables[0]?.rows ?? [];
          outcome = rows.every((row) => row["[Expression]"] === null)
            ? "names_only"
            : "with_dax";
        }
        actual[principal][name] = outcome;
      }
    }
    expect(actual).toEqual(EXPECTED_MEASURE_DAX);
  });
});
