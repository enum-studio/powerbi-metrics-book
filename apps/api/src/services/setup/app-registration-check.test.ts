import { describe, expect, it } from "vitest";
import { ServiceError } from "../../errors.js";
import { tokenRefusal } from "./checks.js";
import {
  permissionNote,
  permissionProblem,
  rolesProblem,
  tokenRoles,
} from "./app-registration-check.js";

const POWER_BI = "https://analysis.windows.net/powerbi/api";
const LEAST = [
  "openid",
  "profile",
  "email",
  "offline_access",
  `${POWER_BI}/Dataset.Read.All`,
  "https://graph.microsoft.com/User.Read",
];
const NOT_NEEDED = (list: string) =>
  `Not needed by this app, which never uses it: ${list}. The app can still do what it allows.`;
const SEVERAL_NOT_NEEDED = (list: string) =>
  `Not needed by this app, which never uses them: ${list}. The app can still do what they allow.`;
const APPLICATION = (list: string) =>
  `An application permission acts without any person: ${list}. This app does not use it, and it can be removed.`;
const LACKS =
  "Your Power BI token lacks Dataset.Read.All. Add that delegated permission under API permissions, grant admin consent, then connect Power BI again.";

/** A client-credentials token as Microsoft signs it; only its payload is read. */
const tokenWith = (claims: Record<string, unknown>) =>
  [
    Buffer.from('{"alg":"RS256"}').toString("base64url"),
    Buffer.from(JSON.stringify({ appid: "sample", ...claims })).toString(
      "base64url",
    ),
    "signature",
  ].join(".");
const NO_ROLES = tokenWith({});

describe("the app registration's delegated permissions", () => {
  it("passes the minimum with no note", () => {
    expect(permissionProblem(LEAST)).toBeNull();
    expect(permissionNote(LEAST, NO_ROLES)).toBeNull();
  });

  it("requires only Dataset.Read.All: the token a person connected with shows no more", () => {
    // The redeem names Power BI alone, so a real answer need not list the
    // sign-in scopes or Graph's User.Read, and a connection proves they work.
    const alone = [`${POWER_BI}/Dataset.Read.All`];
    expect(permissionProblem(alone)).toBeNull();
    expect(permissionNote(alone, NO_ROLES)).toBeNull();
    expect(permissionProblem(["openid", "User.Read"])).toBe(LACKS);
  });

  it("passes an extra permission, and names it as not needed", () => {
    for (const name of [
      "App.Read.All",
      "Content.Create",
      "Workspace.Read.All",
    ]) {
      const scopes = [...LEAST, `${POWER_BI}/${name}`];
      expect(permissionProblem(scopes)).toBeNull();
      expect(permissionNote(scopes, NO_ROLES)).toBe(NOT_NEEDED(name));
    }
    expect(permissionProblem([...LEAST, "Mail.Send"])).toBeNull();
    expect(permissionNote([...LEAST, "Mail.Send"], NO_ROLES)).toBe(
      NOT_NEEDED("Mail.Send"),
    );
  });

  it("says plainly what a tenant-wide or writing extra can do", () => {
    for (const [name, says] of [
      [
        "Tenant.ReadWrite.All",
        "Tenant.ReadWrite.All (can change every workspace)",
      ],
      ["Tenant.Read.All", "Tenant.Read.All (reads every workspace)"],
      ["Dataset.ReadWrite.All", "Dataset.ReadWrite.All (can write)"],
    ] as const) {
      const scopes = [...LEAST, `${POWER_BI}/${name}`];
      expect(permissionProblem(scopes)).toBeNull();
      expect(permissionNote(scopes, NO_ROLES)).toBe(NOT_NEEDED(says));
    }
  });

  it("puts no label on a write whose name does not show it, and promises nothing of what it leaves out", () => {
    for (const name of ["Mail.Send", "Content.Create", "Item.Execute.All"]) {
      const scopes = [...LEAST, `${POWER_BI}/${name}`];
      expect(permissionNote(scopes, NO_ROLES)).toBe(NOT_NEEDED(name));
    }
  });

  it("names first the extras whose names show what they can do", () => {
    expect(
      permissionNote(
        [
          ...LEAST,
          `${POWER_BI}/App.Read.All`,
          `${POWER_BI}/Dataset.ReadWrite.All`,
          `${POWER_BI}/Tenant.Read.All`,
          `${POWER_BI}/Tenant.ReadWrite.All`,
        ],
        NO_ROLES,
      ),
    ).toBe(
      SEVERAL_NOT_NEEDED(
        "Tenant.ReadWrite.All (can change every workspace), Tenant.Read.All (reads every workspace), Dataset.ReadWrite.All (can write) and App.Read.All",
      ),
    );
  });

  it("counts a permission many people's tokens hold once", () => {
    expect(
      permissionNote(
        [
          ...LEAST,
          ...LEAST,
          `${POWER_BI}/App.Read.All`,
          `${POWER_BI}/App.Read.All`,
        ],
        NO_ROLES,
      ),
    ).toBe(NOT_NEEDED("App.Read.All"));
  });

  it("names extras while they fit, then says how many more", () => {
    const many = Array.from(
      { length: 26 },
      (_, index) =>
        `${POWER_BI}/Sample${String.fromCharCode(65 + index)}.Read.All`,
    );
    const note = permissionNote([...LEAST, ...many], NO_ROLES);
    expect(note?.length).toBeLessThanOrEqual(300);
    const more = /and (\d+) more\./.exec(note ?? "");
    const named = note?.match(/Sample[^ ,]+/g) ?? [];
    expect(named.length).toBeGreaterThan(1);
    expect(named.length + Number(more?.[1])).toBe(26);
  });

  it("says a permission for a name outside a permission's own form", () => {
    expect(
      permissionNote([...LEAST, `${POWER_BI}/<b>.Write x`], NO_ROLES),
    ).toBe(NOT_NEEDED("a permission"));
    expect(
      permissionNote(
        [...LEAST, `${POWER_BI}/<b>.Write`, `${POWER_BI}/user_impersonation`],
        NO_ROLES,
      ),
    ).toBe(SEVERAL_NOT_NEEDED("2 permissions"));
    expect(
      permissionNote(
        [...LEAST, `${POWER_BI}/App.Read.All`, `${POWER_BI}/<b>.Write`],
        NO_ROLES,
      ),
    ).toBe(SEVERAL_NOT_NEEDED("App.Read.All and 1 more"));
  });

  it("does not take Graph's Dataset.Read.All for Power BI's", () => {
    expect(permissionProblem(["Dataset.Read.All"])).toBe(LACKS);
  });
});

describe("the registrations' application permissions", () => {
  it("reads the roles claim of a client-credentials token", () => {
    expect(tokenRoles(tokenWith({}))).toEqual([]);
    expect(tokenRoles(tokenWith({ roles: ["Tenant.Read.All"] }))).toEqual([
      "Tenant.Read.All",
    ]);
    expect(tokenRoles("opaque")).toBeNull();
  });

  it("passes an app registration that holds an application permission, with a note", () => {
    const token = tokenWith({ roles: ["Tenant.Read.All"] });
    expect(rolesProblem(NO_ROLES, "app")).toBeNull();
    expect(rolesProblem(token, "app")).toBeNull();
    expect(permissionNote(LEAST, token)).toBe(
      APPLICATION("Tenant.Read.All (reads every workspace)"),
    );
  });

  it("names application permissions through the same form and ranking as scopes", () => {
    expect(
      permissionNote(
        LEAST,
        tokenWith({
          roles: [
            "App.Read.All",
            "<b>",
            "Tenant.ReadWrite.All",
            "App.Read.All",
          ],
        }),
      ),
    ).toBe(
      "Application permissions act without any person: Tenant.ReadWrite.All (can change every workspace), App.Read.All and 1 more. This app does not use them, and they can be removed.",
    );
  });

  it("says a permission for an application permission outside a permission's own form", () => {
    expect(permissionNote(LEAST, tokenWith({ roles: ["<b>"] }))).toBe(
      APPLICATION("a permission"),
    );
  });

  it("says the app sends the token on service-account queries, only when they are on", () => {
    const token = tokenWith({ roles: ["Tenant.Read.All"] });
    expect(
      permissionNote(LEAST, token, { service_account_queries: true }),
    ).toBe(
      "An application permission acts without any person: Tenant.Read.All (reads every workspace). This app's service-account queries send the token holding it.",
    );
    expect(
      permissionNote(
        LEAST,
        tokenWith({ roles: ["App.Read.All", "Mail.Send"] }),
        {
          service_account_queries: true,
        },
      ),
    ).toBe(
      "Application permissions act without any person: App.Read.All and Mail.Send. This app's service-account queries send the token holding them.",
    );
    expect(
      permissionNote(LEAST, NO_ROLES, { service_account_queries: true }),
    ).toBeNull();
    expect(
      permissionNote(LEAST, token, { service_account_queries: false }),
    ).toBe(APPLICATION("Tenant.Read.All (reads every workspace)"));
  });

  it("keeps room for both lists when service-account queries are on", () => {
    const note = permissionNote(
      [
        ...LEAST,
        `${POWER_BI}/Tenant.ReadWrite.All`,
        `${POWER_BI}/Tenant.Read.All`,
        `${POWER_BI}/Dataset.ReadWrite.All`,
        `${POWER_BI}/App.Read.All`,
      ],
      tokenWith({ roles: ["Tenant.ReadWrite.All", "Tenant.Read.All"] }),
      { service_account_queries: true },
    );
    expect(note?.length).toBeLessThanOrEqual(300);
    expect(note).toMatch(/^Not needed by this app, which never uses them: /);
    expect(note).toContain("Application permissions act without any person: ");
    expect(note).toContain("Tenant.ReadWrite.All");
  });

  it("gives the application permission and the extras one note that fits", () => {
    const note = permissionNote(
      [
        ...LEAST,
        `${POWER_BI}/Tenant.ReadWrite.All`,
        `${POWER_BI}/Tenant.Read.All`,
        `${POWER_BI}/Dataset.ReadWrite.All`,
        `${POWER_BI}/App.Read.All`,
      ],
      tokenWith({ roles: ["Tenant.Read.All"] }),
    );
    expect(note).toBe(
      `${SEVERAL_NOT_NEEDED("Tenant.ReadWrite.All (can change every workspace) and 3 more")} ${APPLICATION("Tenant.Read.All (reads every workspace)")}`,
    );
    expect(note?.length).toBeLessThanOrEqual(300);
  });

  it("refuses a scanner that holds any API permission", () => {
    expect(rolesProblem(tokenWith({}), "scanner")).toBeNull();
    expect(
      rolesProblem(tokenWith({ roles: ["Dataset.Read.All"] }), "scanner"),
    ).toBe(
      "The scanner registration holds an API permission. Remove it: Power BI refuses admin APIs to an app that holds one, and the tenant setting gives the scanner what it reads.",
    );
  });

  it("refuses a token it cannot read, rather than pass it, for either registration", () => {
    expect(rolesProblem("opaque", "scanner")).toMatch(/^Microsoft answered/);
    expect(rolesProblem("opaque", "app")).toMatch(/^Microsoft answered/);
  });
});

describe("a refused client secret", () => {
  it("names an expired secret from the identity client's error detail", () => {
    const error = new ServiceError(
      "conflict",
      "Microsoft refused the app registration's client id or secret. Check them in the admin section.",
      {
        status: 401,
        code: "invalid_client",
        message: "AADSTS7000222: The provided client secret keys are expired.",
      },
    );
    expect(tokenRefusal(error, "app registration")).toBe(
      "The client secret has expired: make a new one in Certificates & secrets and enter it here.",
    );
  });
});
