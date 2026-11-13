export const MICROSOFT_LINKS = {
  overview: {
    label: "Open Overview in Entra",
    href: "https://entra.microsoft.com/#view/Microsoft_AAD_IAM/TenantOverview.ReactView",
  },
  appRegistrations: {
    label: "Open App registrations in Entra",
    href: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
  },
  newRegistration: {
    label: "Open New registration in Entra",
    href: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade",
  },
  groups: {
    label: "Open Groups in Entra",
    href: "https://entra.microsoft.com/#view/Microsoft_AAD_IAM/GroupsManagementMenuBlade/~/AllGroups",
  },
  powerBiTenantSettings: {
    label: "Open Tenant settings in Power BI",
    href: "https://app.powerbi.com/admin-portal/tenantSettings",
  },
} as const;

export type AppPage =
  "Overview" | "Authentication" | "Credentials" | "CallAnAPI";

export function appPage(page: AppPage, clientId: string): string | null {
  if (
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(clientId)
  )
    return null;
  return `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/${page}/appId/${clientId}`;
}
