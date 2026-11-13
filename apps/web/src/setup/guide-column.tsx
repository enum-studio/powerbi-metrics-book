import { ExternalLink } from "lucide-react";
import { CopyValue } from "../shell/copy-button";
import type { Item } from "./items";
import { appPage } from "./links";
import { LABEL, LINK, QUIET } from "./parts";

export function PortalLink({
  href,
  label,
}: {
  href: string | null;
  label: string;
}) {
  return href === null ? null : (
    <a href={href} target="_blank" rel="noopener" className={QUIET}>
      {label}
      <ExternalLink size={14} aria-hidden="true" />
    </a>
  );
}
export function GuideColumn({
  item,
  way,
  docs,
  live,
  complete,
  clientId,
}: {
  item: Item;
  way: "have" | "make";
  docs: string;
  live: string;
  complete: boolean;
  clientId: string;
}) {
  const authentication = appPage("Authentication", clientId);
  const steps = complete
    ? [
        "Check the two redirect URIs on the sign-in app, once.",
        "Select Continue. Microsoft asks you to sign in with your work account, and you become the first admin.",
        "Your own Power BI is connected in the same go. Microsoft does not ask again, because your company consented already.",
      ].map((text, index) => ({
        text,
        links:
          index === 0 && authentication !== null
            ? [
                {
                  href: authentication,
                  label: "Open the sign-in app's Authentication",
                },
              ]
            : [],
        copies: [],
      }))
    : item.guide[way];
  return (
    <aside
      aria-label="Do this now"
      className="grid min-w-0 content-start gap-4 border-t border-line p-4 lg:col-start-2 lg:row-span-5 lg:row-start-1 lg:border-t-0 lg:border-l lg:pt-0"
    >
      <h2 className={LABEL}>Do this now</h2>
      <h3 className="text-heading font-semibold text-ink">
        {complete ? "Sign in with Microsoft" : item.name}
      </h3>
      {!complete && item.lede[way] && <p>{item.lede[way]}</p>}
      <ol className="grid list-decimal gap-5 pl-5">
        {steps.map((step, index) => (
          <li key={step.text}>
            <div className="grid min-w-0 gap-2">
              <p>{step.text}</p>
              {step.links.map((link) => (
                <PortalLink key={link.href} {...link} />
              ))}
              {step.copies.map((copy) => (
                <CopyValue key={copy.value} {...copy} />
              ))}
              {index === steps.length - 1 && (
                <p className="text-meta text-ink-3">{live}</p>
              )}
            </div>
          </li>
        ))}
      </ol>
      <h3 className="font-semibold text-ink">Why this is needed</h3>
      <p>
        {complete
          ? "The first person to sign in becomes the admin."
          : item.guide.why}
      </p>
      <a
        href={docs}
        className={`${LINK} w-fit pointer-coarse:inline-flex pointer-coarse:min-h-(--tap) pointer-coarse:items-center`}
      >
        Read the full setup guide
      </a>
    </aside>
  );
}
