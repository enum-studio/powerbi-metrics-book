import type { CopyValue } from "./guide";
import { appPage, MICROSOFT_LINKS, type AppPage } from "./links";

export type ItemId =
  | "tenant"
  | "sign_in_app"
  | "scanner_app"
  | "scanner_group"
  | "tenant_settings";
export const ITEMS: readonly ItemId[] = [
  "tenant",
  "sign_in_app",
  "scanner_app",
  "scanner_group",
  "tenant_settings",
];
export type GuideStep = {
  text: string;
  links: { label: string; href: string }[];
  copies: CopyValue[];
};
export type Item = {
  id: ItemId;
  name: string;
  summary: (host: string) => string;
  lede: { have: string; make: string };
  why: string;
  never: string | null;
  ways: { have: string; make: string } | null;
  guide: { have: GuideStep[]; make: GuideStep[]; why: string };
};

function step(
  text: string,
  links: GuideStep["links"] = [],
  copies: CopyValue[] = [],
): GuideStep {
  return { text, links, copies };
}

export function redirectValues(origin: string): [CopyValue, CopyValue] {
  return [
    {
      label: "Sign-in",
      value: `${origin}/api/auth/callback/microsoft`,
    },
    {
      label: "Power BI connection",
      value: `${origin}/api/v1/powerbi/callback`,
    },
  ];
}

export function item(
  id: ItemId,
  origin: string,
  clientId: string | null,
): Item {
  const host = new URL(origin).host;
  const [signIn, powerBi] = redirectValues(origin);
  const scannerName = {
    label: "Name",
    value: `Power BI Metrics Book scanner (${host})`,
  };
  const ways = { have: "I have it", make: "Make it" };
  const links = MICROSOFT_LINKS;
  // Without the app's client id only the first step can link, to the list it is picked from.
  const ownPage = (page: AppPage, label: string, first = false) => {
    const href = clientId === null ? null : appPage(page, clientId);
    if (href !== null) return [{ label, href }];
    return first ? [links.appRegistrations] : [];
  };
  switch (id) {
    case "tenant": {
      const steps = [
        step("Type your work email in the field. Only its domain is used."),
        step(
          "Check the tenant ID against Tenant ID on the Overview page in Entra. If they differ, paste the one from Entra.",
          [links.overview],
        ),
      ];
      return {
        id,
        name: "Your tenant",
        lede: { have: "", make: "" },
        summary: () => "Found from your work email domain",
        why: "Every other item lives in your Microsoft tenant, and people sign in through it.",
        never: null,
        ways: null,
        guide: {
          have: steps,
          make: steps,
          why: "The stack signs people in through your tenant and only your tenant. Nobody from another company can get in.",
        },
      };
    }
    case "sign_in_app":
      return {
        id,
        name: "The sign-in app",
        lede: {
          have:
            clientId !== null && appPage("Overview", clientId) !== null
              ? "The links now open your own app, from the client ID you pasted."
              : "",
          make: "About 8 minutes. Keep this page in one tab and Entra in another.",
        },
        summary: (host) => `App registration: Power BI Metrics Book (${host})`,
        why: "People sign in with Microsoft through it, and query Power BI as themselves. This product only reads Power BI and asks for nothing beyond Dataset.Read.All and sign-in. Whatever else the app registration holds, the app can still do.",
        never: null,
        ways,
        guide: {
          have: [
            step(
              "Open App registrations, select your sign-in app, and copy Application (client) ID from its Overview.",
              ownPage("Overview", "Open this app's Overview", true),
            ),
            step(
              "Under Authentication (Preview), on Redirect URI configuration, check that both redirect URIs are listed as Web. Select Add Redirect URI for any that is missing.",
              ownPage("Authentication", "Open this app's Authentication"),
              [signIn, powerBi],
            ),
            step(
              "Under API permissions, check five delegated permissions, each Granted for your company: Power BI Service Dataset.Read.All, and Microsoft Graph openid, profile, email, offline_access, User.Read.",
              ownPage("CallAnAPI", "Open this app's API permissions"),
            ),
            step(
              "Paste the client secret you saved. No longer have it? Make a new one under Certificates & secrets and copy its Value.",
              ownPage("Credentials", "Open this app's Certificates & secrets"),
            ),
          ],
          make: [
            step(
              "Select Open New registration in Entra. The page is titled Register an application. Paste the name. Leave Supported account types on Single tenant only. Under Redirect URI, select the platform Web and paste the sign-in URI. Select Register.",
              [links.newRegistration],
              [
                { label: "Name", value: `Power BI Metrics Book (${host})` },
                { ...signIn, label: "Redirect URI" },
              ],
            ),
            step(
              "On the new app's Overview, copy Application (client) ID into the field here. The next links then open this app.",
            ),
            step(
              "Under Authentication (Preview), on Redirect URI configuration, select Add Redirect URI. Choose Web and paste the Power BI connection URI, then select Configure.",
              [],
              [powerBi],
            ),
            step(
              "Under API permissions, select Add a permission: Power BI Service, Delegated, Dataset.Read.All. Then Microsoft Graph, Delegated: openid, profile, email, offline_access, User.Read. Then Grant admin consent for your company.",
            ),
            step(
              "Under Certificates & secrets, select New client secret, 24 months. Copy its Value (not the Secret ID) into the field here.",
            ),
          ],
          why: "People sign in through this app and query Power BI with their own rights. This product asks only for the read-only delegated permissions above. Whatever else the app registration holds, the app can still do.",
        },
      };
    case "scanner_app":
      return {
        id,
        name: "The scanner app",
        lede: { have: "", make: "About 3 minutes." },
        summary: (host) =>
          `App registration: Power BI Metrics Book scanner (${host})`,
        why: "Reads the workspaces' tables, measures and DAX through Power BI's read-only admin APIs.",
        never: "Read report data, or change anything in Power BI.",
        ways,
        guide: {
          have: [
            step(
              "Open App registrations and select the app your Power BI admin API settings let in. Copy Application (client) ID from its Overview.",
              [links.appRegistrations],
            ),
            step(
              "Check that it has no Power BI permission under API permissions. Power BI refuses a scanner that has one.",
            ),
            step(
              "Make a new client secret for this stack under Certificates & secrets. Do not reuse a secret another tool uses.",
            ),
          ],
          make: [
            step(
              "Select Open New registration in Entra. The page is titled Register an application. Paste the name. Leave Supported account types on Single tenant only. Leave Redirect URI empty. Select Register.",
              [links.newRegistration],
              [scannerName],
            ),
            step(
              "Copy Application (client) ID from its Overview into the field here. Add no API permission.",
            ),
            step(
              "Under Certificates & secrets, make a new client secret, 24 months, and copy its Value here.",
            ),
          ],
          why: "The scanner reads what exists in Power BI (workspaces, tables, measures, DAX) through admin APIs that never return report data.",
        },
      };
    case "scanner_group":
      return {
        id,
        name: "The scanner's security group",
        lede: { have: "", make: "About 2 minutes." },
        summary: () => "Security group with the scanner app as a member",
        why: "Power BI lets the scanner in through this group, and nobody else.",
        never: "Give any person any access: its member is the scanner app.",
        ways,
        guide: {
          have: [
            step(
              "Open Groups and find the group named in your Power BI admin API settings.",
              [links.groups],
            ),
            step(
              "Under Members, check that the group holds only this scanner app. If other tools use the group, make a separate group for this stack.",
            ),
          ],
          make: [
            step(
              "Open Groups and select New group. Group type Security. Paste the name.",
              [links.groups],
              [scannerName],
            ),
            step(
              "Under Members, select Add members, search for the scanner app by its name and add it. Select Create.",
            ),
          ],
          why: "Power BI opens its admin APIs to security groups, not to apps. This group is how the scanner gets in.",
        },
      };
    case "tenant_settings": {
      const steps = [
        step(
          "Open Tenant settings and type this in its search box.",
          [links.powerBiTenantSettings],
          [{ label: "Search for", value: "admin API" }],
        ),
        step(
          '"Service principals can access read-only admin APIs": Enabled. Under Apply to, choose Specific security groups and add the scanner\'s group. Select Apply.',
        ),
        step(
          '"Enhance admin APIs responses with detailed metadata": the same.',
        ),
        step(
          '"Enhance admin APIs responses with DAX and mashup expressions": the same. Power BI shows this one once the previous one is on.',
        ),
        step("Back here, select Check the scanner."),
      ];
      return {
        id,
        name: "Three Power BI tenant settings",
        lede: {
          have: "You are a Fabric Administrator if you can open this page. Check each one against this list.",
          make: "In the Power BI admin portal, as a Fabric Administrator. About 4 minutes, then up to 15 for Microsoft.",
        },
        summary: () => "Admin API settings, on for the scanner's group",
        why: "Power BI keeps its read-only admin APIs shut until these are on.",
        never: "Apply to anyone outside the group they name.",
        ways: { have: "They are on", make: "Turn them on" },
        guide: {
          have: steps,
          make: steps,
          why: "Power BI keeps its admin APIs shut by default. These three open them for the scanner's group only, read-only, with the measures' DAX included.",
        },
      };
    }
  }
}
