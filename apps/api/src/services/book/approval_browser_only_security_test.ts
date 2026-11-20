import { afterAll, describe, expect, it } from "vitest";
import { closeTestPools } from "../../../test/deps.js";
import {
  asPerson,
  reaching,
  rolledBack,
} from "../../../test/mirror-fixtures.js";
import type { Db } from "../../context.js";
import type { Principal } from "../../principal.js";
import { METRIC_CHECK_NAMES } from "../conventions/schema.js";
import {
  getConventionsForAgents,
  setConventionsAsAdmin,
} from "../conventions/service.js";
import {
  approveMetric,
  createMetric,
  getMetric,
  updateMetric,
  verifyMetric,
} from "./metrics.js";

/*
 * human_verified means a person looked, so it is set only from a browser
 * session unless the conventions say trust.human_verify_from: any. A policy
 * cannot see how the caller signed in, so this rule is code, and this test
 * holds it. The metric has no variants, so everyone may see it.
 */

afterAll(closeTestPools);

const curator = reaching({}, "curator");
const admin = reaching({}, "admin");
const through = (principal: Principal, via: Principal["via"]) => ({
  ...principal,
  via,
});
const TOKENS = ["cli", "mcp", "api"] as const;
const NAME = "number_of_approvals_security_test";
/** A service account its admin made a curator. */
const serviceAccount: Principal = {
  kind: "service_account",
  id: "approvals-security-test",
  roles: ["curator"],
  attributes: {
    powerbi_workspace_ids: [],
    powerbi_app_ids: [],
    powerbi_dataset_ids: [],
  },
  via: "api",
  client_id: null,
};

/** By this rule and not by the policy, which lets a curator approve: the message says which. */
async function refusesServiceAccount(tx: Db): Promise<void> {
  for (const via of ["api", "browser"] as const) {
    const context = asPerson(through(serviceAccount, via), { db: tx });
    const attempt = approveMetric(context, NAME);
    await expect(attempt).rejects.toMatchObject({ kind: "refused" });
    await expect(attempt).rejects.toThrow("Only a person approves a metric.");
  }
}

/** Every metric check off, so only the rule under test decides. */
const checksOff = (tx: Db, human_verify_from: "browser" | "any") =>
  setConventionsAsAdmin(asPerson(admin, { db: tx }), {
    off: [...METRIC_CHECK_NAMES],
    trust: { agent_verify_requires: "all_checks", human_verify_from },
  });

describe("approveMetric", () => {
  it("refuses a token under the default conventions, whatever the role and the checks", () =>
    rolledBack(async (tx) => {
      await createMetric(asPerson(curator, { db: tx }), {
        name: NAME,
        label: "Number of approvals",
      });
      for (const principal of [curator, admin]) {
        for (const via of TOKENS) {
          const context = asPerson(through(principal, via), { db: tx });
          await expect(approveMetric(context, NAME)).rejects.toMatchObject({
            kind: "refused",
          });
        }
      }
      await refusesServiceAccount(tx);
      const read = await getMetric(asPerson(curator, { db: tx }), NAME);
      expect(read.trust_state).toBe("draft");
    }));

  it("refuses a token while the checks pass, and approves from a browser", () =>
    rolledBack(async (tx) => {
      await checksOff(tx, "browser");
      const context = asPerson(curator, { db: tx });
      await createMetric(context, { name: NAME, label: "Number of approvals" });
      for (const via of TOKENS) {
        await expect(
          approveMetric(asPerson(through(curator, via), { db: tx }), NAME),
        ).rejects.toMatchObject({ kind: "refused" });
      }
      await refusesServiceAccount(tx);
      const approved = await approveMetric(context, NAME);
      expect(approved).toMatchObject({
        trust_state: "human_verified",
        verified_by: curator.id,
      });
    }));

  it("approves through a token only when the conventions say any, and never for a service account", () =>
    rolledBack(async (tx) => {
      await checksOff(tx, "any");
      await createMetric(asPerson(curator, { db: tx }), {
        name: NAME,
        label: "Number of approvals",
      });
      await refusesServiceAccount(tx);
      const approved = await approveMetric(
        asPerson(through(curator, "cli"), { db: tx }),
        NAME,
      );
      expect(approved.trust_state).toBe("human_verified");
    }));

  it("is refused to a viewer from a browser too", () =>
    rolledBack(async (tx) => {
      await checksOff(tx, "browser");
      await createMetric(asPerson(curator, { db: tx }), {
        name: NAME,
        label: "Number of approvals",
      });
      await expect(
        approveMetric(asPerson(reaching({}), { db: tx }), NAME),
      ).rejects.toMatchObject({ kind: "refused" });
    }));
});

describe("no other way to human_verified through a token", () => {
  it("verify gives agent_verified, and a token's change leaves an approval", () =>
    rolledBack(async (tx) => {
      await checksOff(tx, "browser");
      const browser = asPerson(curator, { db: tx });
      await createMetric(browser, { name: NAME, label: "Number of approvals" });
      for (const via of TOKENS) {
        const token = asPerson(through(curator, via), { db: tx });
        expect((await verifyMetric(token, NAME)).trust_state).toBe(
          "agent_verified",
        );
        await approveMetric(browser, NAME);
        const changed = await updateMetric(token, NAME, {
          definition: `Changed through ${via}.`,
        });
        expect(changed.trust_state).toBe("agent_verified");
      }
    }));
});

describe("setConventionsAsAdmin and the trust rules", () => {
  const widen = { trust: { human_verify_from: "any" } };
  const REFUSAL = "The trust rules (trust.*)";

  // The policy already keeps a service account from editing the conventions;
  // this is the rule for an admin person holding a token.
  it("refuses a change to trust.* from a token, and takes the other rules", () =>
    rolledBack(async (tx) => {
      for (const via of TOKENS) {
        const context = asPerson(through(admin, via), { db: tx });
        await expect(setConventionsAsAdmin(context, widen)).rejects.toThrow(
          REFUSAL,
        );
        await expect(
          setConventionsAsAdmin(context, { off: ["metric_name_form"] }),
        ).resolves.toMatchObject({ changes: [{ path: "off" }] });
        await setConventionsAsAdmin(asPerson(admin, { db: tx }), {});
      }
      const kept = await getConventionsForAgents(asPerson(admin, { db: tx }));
      expect(kept.rules.trust.human_verify_from).toBe("browser");
    }));

  it("refuses a token that saves a document read before a browser changed trust.*, which would undo the change", () =>
    rolledBack(async (tx) => {
      const browser = asPerson(admin, { db: tx });
      const staleRead = await getConventionsForAgents(browser);
      await setConventionsAsAdmin(browser, widen);
      const stale = { ...staleRead.rules, guide: staleRead.guide };
      for (const via of TOKENS) {
        await expect(
          setConventionsAsAdmin(
            asPerson(through(admin, via), { db: tx }),
            stale,
          ),
        ).rejects.toThrow(REFUSAL);
      }
      const kept = await getConventionsForAgents(browser);
      expect(kept.rules.trust.human_verify_from).toBe("any");
    }));

  it("takes a change to trust.* from a person's browser session", () =>
    rolledBack(async (tx) => {
      await setConventionsAsAdmin(asPerson(admin, { db: tx }), widen);
      const kept = await getConventionsForAgents(asPerson(admin, { db: tx }));
      expect(kept.rules.trust.human_verify_from).toBe("any");
    }));
});
