import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useLocation, useMatches } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ADMIN_NAV } from "../admin/layout/nav";
import { useDocumentTitle } from "./title";
import { signInConfigQuery } from "../access/api";
import { type Me, meQuery } from "../api/me";
import { BrandIdentity } from "./mark";
import { useDemo } from "./demo";
import { AppFrame, ThemeToggle, useSignOut } from "./nav";

/** The page column: as wide as the planner's, with its side padding. */
export const PAGE = "mx-auto w-full max-w-(--page-max) px-(--page-pad)";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** A screen with one job, reached from outside the app (sign-in, a consent, the setup): it has the plain header: the name, who is signed in and how to leave, and no lanes or search. */
    focused?: boolean;
  }
}

/** The left lanes and the page for a signed-in person; the plain header for someone signed out or on a screen with one job. The sample-data band on both. */
export function Shell({ children }: { children: ReactNode }) {
  const { data: me } = useSuspenseQuery(meQuery);
  const config = useSuspenseQuery(signInConfigQuery);
  const path = useLocation({ select: (location) => location.pathname });
  useDocumentTitle(
    me === null ? undefined : ADMIN_NAV.find((item) => item.to === path)?.label,
  );
  const demo = useDemo();
  const sample = me === null ? config.data.sample_data : me.sample_data;
  const focused = useMatches({
    select: (matches) =>
      matches.some((match) => match.staticData.focused === true),
  });
  if (me !== null && !focused)
    return (
      <AppFrame me={me} band={sample && <SampleDataBand demo={demo} />}>
        {children}
      </AppFrame>
    );
  return (
    <div className="flex min-h-dvh flex-col">
      <Header me={me} demo={demo} />
      {sample && <SampleDataBand demo={demo} />}
      <main className={`${PAGE} flex-1 py-8`}>{children}</main>
    </div>
  );
}

/** The planner's header: the mark at 17px and the name in Inter at one weight; on a phone the controls wrap under the name. */
function Header({ me, demo }: { me: Me | null; demo: boolean }) {
  return (
    <header className="z-10 border-b border-line bg-bg sm:sticky sm:top-0">
      <div
        className={`${PAGE} flex flex-wrap items-center gap-x-4 gap-y-2 pt-[calc(var(--space-3)+var(--safe-top))] pb-3`}
      >
        <Link
          to="/"
          className="inline-flex items-center gap-2.5 pointer-coarse:min-h-(--tap) font-sans text-(length:--type-name) leading-none font-semibold tracking-[-0.02em] whitespace-nowrap text-ink"
        >
          <BrandIdentity size={17} />
        </Link>
        <div className="ml-auto flex min-w-0 items-center gap-4 text-ui text-ink-2">
          {me !== null && (
            <span className="min-w-0 truncate" title={me.name ?? undefined}>
              {me.email ?? me.name}
            </span>
          )}
          <ThemeToggle personId={me?.id ?? null} />
          {me !== null && !demo && <SignOut />}
        </div>
      </div>
    </header>
  );
}

function SignOut() {
  const leave = useSignOut();
  return (
    <button
      type="button"
      disabled={leave.isPending}
      className="whitespace-nowrap hover:text-ink disabled:text-ink-3 pointer-coarse:min-h-(--tap)"
      onClick={() => {
        leave.mutate();
      }}
    >
      Sign out
    </button>
  );
}

/** As Steep's "Using demo data" box: what the data is, and the way to your own tenant. */
function SampleDataBand({ demo }: { demo: boolean }) {
  return (
    <div className="border-b border-line bg-raised">
      <p className={`${PAGE} py-2 text-ui text-ink-2`}>
        <span className="mr-2 font-mono text-label font-medium tracking-[0.13em] text-ink uppercase">
          Sample data
        </span>
        {demo ? (
          <>
            Demo on invented sample data. Read-only.{" "}
            <a
              href="/docs/start/"
              className="text-accent underline underline-offset-4 hover:text-accent-hover"
            >
              Run it on your own Power BI
            </a>
          </>
        ) : (
          <>
            This stack runs on the invented sample tenant, not your company's
            Power BI.{" "}
            <a
              href="/docs/start/sample-tenant/#move-to-your-own-tenant"
              className="text-accent underline underline-offset-4 hover:text-accent-hover"
            >
              Move to your own tenant
            </a>
          </>
        )}
      </p>
    </div>
  );
}
