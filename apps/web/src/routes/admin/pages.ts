import { GeneralPage } from "../../admin/settings/general-page";
import { PiiPage } from "../../admin/pii/page";
import { createRoute, type RouteComponent } from "@tanstack/react-router";
import { DatasetsPage } from "../../admin/datasets/page";
import { AdminError } from "../../admin/layout/admin-layout";
import { StatusPage } from "../../admin/layout/status-page";
import { LimitsPage } from "../../admin/settings/limits-page";
import { PowerBiPage } from "../../admin/settings/powerbi-page";
import { SearchPage } from "../../admin/settings/search-page";
import { SecretsPage } from "../../admin/settings/secrets-page";
import { SignInPage } from "../../admin/settings/sign-in-page";
import { adminRoute } from "../admin";
import { AuditPage } from "./audit";
import { ConventionsPage } from "./conventions";
import { PeoplePage } from "./people";
import { ServiceAccountsPage } from "./service-accounts";

/** A page of the admin section: a refusal or a fault shows inside the layout, under the nav. */
export function adminPage<TPath extends string>(
  path: TPath,
  component: RouteComponent,
) {
  return createRoute({
    getParentRoute: () => adminRoute,
    path,
    component,
    errorComponent: AdminError,
  });
}

/** Every admin page. A later admin issue adds its route here and its entry to admin/layout/nav.ts. */
export const adminPages = [
  adminPage("/admin", StatusPage),
  adminPage("/admin/general", GeneralPage),
  adminPage("/admin/powerbi", PowerBiPage),
  adminPage("/admin/datasets", DatasetsPage),
  adminPage("/admin/pii", PiiPage),
  adminPage("/admin/sign-in", SignInPage),
  adminPage("/admin/search", SearchPage),
  adminPage("/admin/limits", LimitsPage),
  adminPage("/admin/secrets", SecretsPage),
  adminPage("/admin/people", PeoplePage),
  adminPage("/admin/service-accounts", ServiceAccountsPage),
  adminPage("/admin/conventions", ConventionsPage),
  adminPage("/admin/audit", AuditPage),
];
