import { expect, test as setup } from "@playwright/test";
import {
  devSignIn,
  devStackUrl,
  grantRole,
  PEOPLE,
  sessionFile,
} from "./fixtures.ts";
import { signInThroughMicrosoft } from "./microsoft.ts";

/*
 * Signs in once per role for the whole run and saves each session, so the
 * specs start from them instead of signing in per test (the api's sign-in
 * rate limit counts every project's browser as one address). The curator and
 * the viewer sign in through the mock's Microsoft, which connects their
 * Power BI and gives them the sample's reach; the admin uses the dev sign-in.
 * The curator then opens Retail once, which reads its relationships from
 * Power BI, so every spec that draws its diagram starts with them known.
 */

const RETAIL = "d1000000-0000-4000-8000-000000000005";

setup("sign in once as each role the specs start from", async ({ browser }) => {
  const admin = await browser.newContext({ baseURL: devStackUrl() });
  await devSignIn(admin.request, PEOPLE.admin);
  await admin.storageState({ path: sessionFile("admin") });
  for (const role of ["curator", "viewer"] as const) {
    await grantRole(admin.request, PEOPLE[role], role);
    const context = await browser.newContext({ baseURL: devStackUrl() });
    await signInThroughMicrosoft(context, PEOPLE[role]);
    await context.storageState({ path: sessionFile(role) });
    if (role === "curator") {
      const retail = await context.request.get(`/api/v1/datasets/${RETAIL}`);
      expect(retail.ok()).toBe(true);
      const { relationships } = (await retail.json()) as {
        relationships: unknown[];
      };
      expect(relationships).toHaveLength(20);
    }
    await context.close();
  }
  await admin.close();
});
