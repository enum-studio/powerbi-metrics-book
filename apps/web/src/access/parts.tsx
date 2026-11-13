import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";
import { signInConfigQuery } from "./api";
import { ThemeToggle } from "../shell/nav";
import { Ban, Check, type LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Mark } from "../shell/mark";
import { useDocumentTitle } from "../shell/title";

/**
 * The public account pages share one column and the deployment's identity.
 * Only the brand and the footer wait for /api/auth/config: the page itself
 * draws at once.
 */
export function AuthLayout({
  children,
  pageTitle,
}: {
  children: ReactNode;
  pageTitle: string;
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-16 text-ink">
      <main className="flex w-full max-w-88 min-w-0 flex-col gap-6 wrap-anywhere">
        <Suspense fallback={<div className="h-10" />}>
          <AuthBrand pageTitle={pageTitle} />
        </Suspense>
        {children}
        <Suspense fallback={null}>
          <AuthFooter />
        </Suspense>
      </main>
      <div className="fixed right-4 bottom-4">
        <ThemeToggle personId={null} />
      </div>
    </div>
  );
}

function AuthBrand({ pageTitle }: { pageTitle: string }) {
  const { data: config } = useSuspenseQuery(signInConfigQuery);
  const { brand } = config;
  useDocumentTitle(pageTitle);
  return (
    <div className="flex flex-col items-center gap-5">
      {brand.logo_url === null ? (
        <Mark size={40} />
      ) : (
        <img
          src={brand.logo_url}
          alt={brand.name}
          className="h-10 max-w-full object-contain"
        />
      )}
      {config.sample_data && (
        <span className="rounded border border-line px-2 py-0.5 font-mono text-label font-medium tracking-[0.13em] text-ink-2 uppercase">
          Sample data
        </span>
      )}
    </div>
  );
}

function AuthFooter() {
  const { data: config } = useSuspenseQuery(signInConfigQuery);
  return (
    <footer className="flex flex-col gap-2 text-center text-meta text-ink-3">
      <p>
        {config.invite_only
          ? "Only people an admin invites can sign in."
          : `Anyone at ${config.brand.company ?? window.location.host} can sign in with Microsoft.`}
      </p>
      {config.brand.custom && <p>Powered by Power BI Metrics Book</p>}
    </footer>
  );
}

export function AuthPanel({ children }: { children: ReactNode }) {
  return <section className="flex min-w-0 flex-col gap-5">{children}</section>;
}

/** The one card sign-in, consent and the device code sit in, as GitHub's authorize page: a column of its own, centred. */
export function AccessCard({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-(--measure) flex-col gap-6 sm:py-6">
      {children}
    </div>
  );
}

export function Panel({ children }: { children: ReactNode }) {
  return (
    <section className="flex flex-col gap-5 rounded-sheet border border-line bg-surface p-5 sm:p-6">
      {children}
    </section>
  );
}

/** This site's mark and the asking client's, joined: who is asking whom. */
export function JoinedMarks({ client }: { client: LucideIcon }) {
  const Client = client;
  return (
    <div
      className="flex items-center justify-center gap-3 text-ink"
      aria-hidden="true"
    >
      <span className="grid size-12 place-items-center rounded-sheet border border-line bg-surface">
        <Client size={22} strokeWidth={1.5} />
      </span>
      <span className="w-10 border-t border-dashed border-line-strong" />
      <span className="grid size-12 place-items-center rounded-sheet border border-line bg-surface">
        <Mark size={22} />
      </span>
    </div>
  );
}

const BUTTON =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded px-4 text-ui font-medium disabled:cursor-not-allowed disabled:opacity-60 pointer-coarse:min-h-(--tap)";
const OUTLINED =
  "border border-line-control bg-surface text-ink hover:bg-raised";
export const PRIMARY = `${BUTTON} w-full bg-accent text-on-accent hover:bg-accent-hover`;
export const SECONDARY = `${BUTTON} w-full ${OUTLINED}`;
/** A secondary action inside a page rather than a card: as wide as its words. */
export const SECONDARY_INLINE = `${BUTTON} ${OUTLINED}`;

export function Button({
  kind,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  kind: "primary" | "secondary";
}) {
  return (
    <button
      type="button"
      className={`${kind === "primary" ? PRIMARY : SECONDARY} ${className}`}
      {...props}
    />
  );
}

/** What allowing gives and what it never gives, as the api words it. Shown as text. */
export function WillLists({
  will,
  willNot,
}: {
  will: readonly string[];
  willNot: readonly string[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <List title="It will be able to" items={will} icon={Check} />
      <div className="border-t border-line" />
      <List title="It will not be able to" items={willNot} icon={Ban} />
    </div>
  );
}

function List({
  title,
  items,
  icon: Icon,
}: {
  title: string;
  items: readonly string[];
  icon: LucideIcon;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-ui font-semibold text-ink">{title}</h2>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item} className="flex gap-2.5 text-ui text-ink-2">
            <Icon
              size={16}
              strokeWidth={1.5}
              className="mt-0.5 shrink-0 text-ink-3"
              aria-hidden="true"
            />
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A refusal or failure in one sentence, read out when it appears. */
export function Problem({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-ui text-out">
      {children}
    </p>
  );
}
