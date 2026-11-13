import { useQuery } from "@tanstack/react-query";
import { Outlet, useLocation } from "@tanstack/react-router";
import { ChevronDown, CircleAlert } from "lucide-react";
import { ApiError } from "../../api/client";
import { Breadcrumb, Crumb } from "../../shell/breadcrumb";
import { EmptyState, ErrorState, Loading } from "../../shell/states";
import { statusQuery } from "../settings/api";
import { type FailingCheck, FailingChecks } from "./failing";
import { ACCOUNT_NAV, ADMIN_NAV, SETTINGS_HOME } from "./nav";

export function AdminsOnly() {
  return (
    <EmptyState title="The admin section is for admins">
      You are signed in, but your role does not open this part of Power BI
      Metrics Book. If you need a setting changed, ask the person who set the
      stack up.
    </EmptyState>
  );
}

const isRefused = (error: unknown) =>
  error instanceof ApiError && error.kind === "refused";

/** A page's failure: a refusal says the page is for admins; anything else is the shell's error. */
export function AdminError({ error }: { error: unknown }) {
  return isRefused(error) ? <AdminsOnly /> : <ErrorState error={error} />;
}

/** A failing check anywhere, as one line on every admin page but Status, which lists them itself; opened, each is linked to the page that fixes it. */
function FailingBand({ checks }: { checks: readonly FailingCheck[] }) {
  const onStatus = useLocation({
    select: (location) => location.pathname === "/admin",
  });
  if (checks.length === 0 || onStatus) return null;
  return (
    <div
      role="status"
      aria-label="Failing checks"
      className="mb-6 rounded border border-line bg-raised"
    >
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-ui font-medium text-out pointer-coarse:min-h-(--tap) [&::-webkit-details-marker]:hidden">
          <CircleAlert size={16} strokeWidth={1.5} aria-hidden="true" />
          {checks.length === 1
            ? "A check is failing"
            : `${String(checks.length)} checks are failing`}
          <ChevronDown
            size={16}
            strokeWidth={1.5}
            aria-hidden="true"
            className="ml-auto text-ink-3 group-open:rotate-180"
          />
        </summary>
        <div className="px-3 pb-3">
          <FailingChecks checks={checks} />
        </div>
      </details>
    </div>
  );
}

/** Where a settings page sits, a person's own or an admin's. Status is a place of the first lane, with nothing above it. */
export function SettingsBreadcrumb() {
  const path = useLocation({ select: (location) => location.pathname });
  const page = [
    ...ACCOUNT_NAV,
    ...ADMIN_NAV.filter((item) => item.section !== null),
  ].find((item) => item.to === path);
  if (page === undefined) return null;
  return (
    <Breadcrumb here={page.label}>
      {/* Settings opens on this page, so here it would link to itself. */}
      {page.to === SETTINGS_HOME ? (
        <span>Settings</span>
      ) : (
        <Crumb to={SETTINGS_HOME}>Settings</Crumb>
      )}
    </Breadcrumb>
  );
}

/** The admin section's frame: the breadcrumb, the failing-check band and the page; its pages are listed in the second lane. The status answer decides who sees it, so the page never guesses a role. Its layouts answer to this frame's width, not the window's, because the lanes beside it take a different share at each width. */
export function AdminLayout() {
  const status = useQuery(statusQuery);
  if (status.isPending) return <Loading what="the admin section" />;
  if (status.isError) return <AdminError error={status.error} />;
  return (
    <div className="@container">
      <SettingsBreadcrumb />
      <FailingBand checks={status.data.failing_checks} />
      <Outlet />
    </div>
  );
}
