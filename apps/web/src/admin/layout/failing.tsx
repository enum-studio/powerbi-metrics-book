import { Link } from "@tanstack/react-router";
import { pageOf } from "./nav";
import { LINK } from "./ui";

export type FailingCheck = { name: string; message?: string | null };

/** Where the guide quotes each checklist item's sentence with its fix. */
const SECURITY_GUIDE = "/docs/set-up/when-a-check-fails/#security";

/**
 * The way to a failing check's fix: the admin page that fixes it, or the guide
 * for what no admin page can change, such as the proxy's https or a volume.
 */
export function FixLink({ name }: { name: string }) {
  const page = pageOf(name);
  return page === undefined ? (
    <a href={SECURITY_GUIDE} className={LINK}>
      Read the guide
    </a>
  ) : (
    <Link to={page.to} className={LINK}>
      Open {page.label}
    </Link>
  );
}

/** Each failing check with its message, linked to its fix: the band on every admin page and the status page's "Needs attention" read the same answer through this. */
export function FailingChecks({ checks }: { checks: readonly FailingCheck[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {checks.map((check) => (
        <li key={check.name} className="text-ui text-ink-2">
          <span className="font-mono text-ink">{check.name}</span>
          {check.message !== undefined &&
            check.message !== null &&
            `: ${check.message}`}{" "}
          <FixLink name={check.name} />
        </li>
      ))}
    </ul>
  );
}
