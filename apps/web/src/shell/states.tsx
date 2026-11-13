import type { ReactNode } from "react";
import { ApiError } from "../api/client";

/** Nothing to show yet: what is missing, then the one thing to do. Plain text, so it sits in a screen's table or section with no box around it. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="flex max-w-(--measure) flex-col items-start gap-2 py-8">
      <h2 className="text-heading font-semibold text-ink">{title}</h2>
      <div className="text-ui text-ink-2">{children}</div>
      {action !== undefined && <div className="mt-2">{action}</div>}
    </section>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p role="status" className="appear-late py-8 text-ui text-ink-3">
      Loading {what}
    </p>
  );
}

/** What went wrong in one sentence: the api's own, or a plain one for a fault in the page itself. */
export function ErrorState({ error }: { error: unknown }) {
  const sentence =
    error instanceof ApiError
      ? error.message
      : "This page stopped because of a fault in its own code, not in your data.";
  return (
    <section
      role="alert"
      className="flex max-w-(--measure) flex-col items-start gap-3 py-8"
    >
      <h2 className="text-heading font-semibold text-ink">
        Something went wrong
      </h2>
      <p className="text-ui text-ink-2">{sentence}</p>
      <button
        type="button"
        className="rounded border border-line-control bg-surface px-3 py-1.5 text-ui text-ink hover:bg-raised"
        onClick={() => {
          window.location.reload();
        }}
      >
        Reload the page
      </button>
    </section>
  );
}
