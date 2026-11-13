import { describe, expect, it } from "vitest";
import { adminPages } from "../../routes/admin/pages";
import { settingsConnectionsRoute } from "../../routes/settings-connections";
import {
  ACCOUNT_NAV,
  ADMIN_NAV,
  ADMIN_SECTIONS,
  pageOf,
  SETTINGS_HOME,
} from "./nav";

describe("the admin nav", () => {
  it("places General first in System and owns branding", () => {
    expect(ADMIN_NAV.find((item) => item.section === "System")?.to).toBe(
      "/admin/general",
    );
    expect(pageOf("branding.name")?.to).toBe("/admin/general");
  });
  it("places PII after Datasets and owns its checks", () => {
    const index = ADMIN_NAV.findIndex((item) => item.label === "Datasets");
    expect(ADMIN_NAV[index + 1]).toMatchObject({
      label: "PII",
      to: "/admin/pii",
      owns: ["pii"],
    });
    expect(pageOf("pii.rules")?.to).toBe("/admin/pii");
  });
  it("sends an expiry warning to Secrets, and the email settings to Sign-in", () => {
    expect(pageOf("expiry_powerbi_app_client_secret")?.to).toBe(
      "/admin/secrets",
    );
    expect(pageOf("email.from")?.to).toBe("/admin/sign-in");
    expect(pageOf("resend_api_key")?.to).toBe("/admin/sign-in");
  });

  it("lists a route for every page, and a page for every route", () => {
    const routes = adminPages.map((route): unknown =>
      Reflect.get(route.options, "path"),
    );
    expect(ADMIN_NAV.map((item) => item.to).sort()).toEqual(
      routes.map(String).sort(),
    );
  });

  it("lists every page but Status in a section of the second lane, and leaves no section empty", () => {
    expect(
      ADMIN_NAV.filter((item) => item.section === null).map(
        (item) => item.label,
      ),
    ).toEqual(["Status"]);
    for (const section of ADMIN_SECTIONS)
      expect(ADMIN_NAV.some((item) => item.section === section)).toBe(true);
  });

  it("gives each page one address, with no trailing slash", () => {
    const paths = ADMIN_NAV.map((item) => item.to);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) expect(path).toMatch(/^\/admin(\/[a-z-]+)?$/);
  });
});

describe("a person's own settings", () => {
  it("lists Connections, at its route, as the page Settings opens on", () => {
    expect(ACCOUNT_NAV.map((item) => item.label)).toEqual(["Connections"]);
    expect(ACCOUNT_NAV[0]?.to).toBe(SETTINGS_HOME);
    expect(Reflect.get(settingsConnectionsRoute.options, "path")).toBe(
      SETTINGS_HOME,
    );
  });

  it("are no admin page, so a check never sends a person there", () => {
    expect(ADMIN_NAV.map((item) => item.to)).not.toContain(SETTINGS_HOME);
  });
});

describe("pageOf", () => {
  it("chooses the longest owned name for datasets", () => {
    expect(pageOf("powerbi.datasets.new")?.to).toBe("/admin/datasets");
    expect(pageOf("powerbi.datasets")?.to).toBe("/admin/datasets");
    expect(pageOf("powerbi.sync.schedule")?.to).toBe("/admin/powerbi");
    expect(pageOf("powerbi.datasets_extra")?.to).toBe("/admin/datasets");
    expect(pageOf("powerbi.datasetsExtra")?.to).toBe("/admin/powerbi");
  });

  it("links a failing check, setting or secret to the page that fixes it", () => {
    const to = (name: string) => pageOf(name)?.to;
    expect(to("scanner")).toBe("/admin/powerbi");
    expect(to("powerbi.scanner_client_id")).toBe("/admin/powerbi");
    expect(to("powerbi_scanner_client_secret")).toBe("/admin/powerbi");
    expect(to("sign_in")).toBe("/admin/sign-in");
    expect(to("sign_in_google_client_secret")).toBe("/admin/sign-in");
    expect(to("openai_api_key")).toBe("/admin/search");
    expect(to("results.preview_rows")).toBe("/admin/limits");
    expect(to("result_link_key")).toBe("/admin/secrets");
    expect(to("who_gets_in")).toBe("/admin/people");
  });

  it("links the checklist's items an admin page can fix, and no others", () => {
    const to = (name: string) => pageOf(name)?.to;
    expect(to("scanner_secret_worker_only")).toBe("/admin/powerbi");
    expect(to("app_registration_read_only")).toBe("/admin/powerbi");
    expect(to("expiry_sign_in_okta_client_secret")).toBe("/admin/secrets");
    expect(to("https")).toBeUndefined();
    expect(to("cookies_secure")).toBeUndefined();
    expect(to("identity_volume_private")).toBeUndefined();
    expect(to("worker_identity_volume_private")).toBeUndefined();
  });

  it("links a failed full sync to the status page, which lists the runs", () => {
    expect(pageOf("full_sync")?.to).toBe("/admin");
  });

  it("matches a whole name, never a prefix of a word", () => {
    expect(pageOf("scanners")).toBeUndefined();
    expect(pageOf("resultsets")).toBeUndefined();
    expect(pageOf("who_gets_in_later")).toBeDefined();
    expect(pageOf("who_gets")).toBeUndefined();
  });
});
