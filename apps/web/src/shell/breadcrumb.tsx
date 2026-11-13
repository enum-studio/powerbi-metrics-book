import { createLink, type LinkComponent } from "@tanstack/react-router";
import { ChevronLeft, type LucideIcon } from "lucide-react";
import {
  type AnchorHTMLAttributes,
  Children,
  cloneElement,
  Fragment,
  isValidElement,
  type ReactNode,
} from "react";
import { ItemIcon } from "./item-icon";

function Anchor(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} />;
}

const AnchorLink = createLink(Anchor);

/** A link above the page. Exact, or the router calls each one the current page on every page below it. */
export const Crumb: LinkComponent<typeof Anchor> = (props) => (
  <AnchorLink activeOptions={{ exact: true }} {...props} />
);

/** The icon sits inline before the words, so the link or the page's own name is the one box that clips and ends in an ellipsis. */
const ICON = "mr-1 inline-block align-[-2px]";

/** A crumb's words with the element's own icon before them, for the kinds that can carry one. */
export function CrumbName({
  icon,
  fallback,
  children,
}: {
  icon: string | null;
  fallback: LucideIcon;
  children: string;
}) {
  return (
    <>
      <span className={ICON}>
        <ItemIcon icon={icon} fallback={fallback} size={14} />
      </span>
      {children}
    </>
  );
}

/**
 * Where a page sits: the links above it as children, and the page itself as
 * `here`. Any name in it comes from what the page has already read, so it never
 * shows a name the reader cannot see. Always one line: the page's own name gives
 * way first and shows whole on hover, a long name above it (a link with a `title`)
 * gives way only when that is not enough, and a fixed word such as Metrics never.
 * On a phone, where every level would be cut to a few letters, it is one link
 * back to the nearest page above, as Linear and Notion do; with no page above
 * that is a link, it shows nothing.
 */
export function Breadcrumb({
  here,
  icon,
  children,
}: {
  here: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  const parts = Children.toArray(children);
  const parent = parts.findLast(
    (part) =>
      isValidElement<{ children?: ReactNode }>(part) && part.type === Crumb,
  );
  return (
    <nav aria-label="Breadcrumb" className="mb-3 text-meta text-ink-3">
      {isValidElement<{ children?: ReactNode }>(parent) && (
        <p className="flex sm:hidden [&_a]:flex [&_a]:min-w-0 [&_a]:items-center [&_a]:gap-1 [&_a]:truncate [&_a]:hover:text-ink pointer-coarse:[&_a]:min-h-(--tap)">
          {cloneElement(
            parent,
            undefined,
            <>
              <ChevronLeft
                size={14}
                strokeWidth={1.5}
                aria-hidden="true"
                className="shrink-0"
              />
              <span className="truncate">{parent.props.children}</span>
            </>,
          )}
        </p>
      )}
      <ol className="hidden items-center whitespace-nowrap sm:flex [&_a]:block [&_a]:truncate [&_a]:hover:text-ink pointer-coarse:[&_a]:leading-(--tap)">
        {parts.map((part, index) => (
          <Fragment key={index}>
            <li className="min-w-6 shrink-0 has-[[title]]:shrink">{part}</li>
            <li aria-hidden="true" className="shrink-0 px-1.5 text-line-strong">
              /
            </li>
          </Fragment>
        ))}
        <li
          aria-current="page"
          title={here}
          className="min-w-20 shrink-[999] truncate text-ink-2"
        >
          {icon !== undefined && <span className={ICON}>{icon}</span>}
          {here}
        </li>
      </ol>
    </nav>
  );
}
