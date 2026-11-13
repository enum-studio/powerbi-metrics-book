import { CopyButton } from "../shell/copy-button";

/**
 * A formula in IBM Plex Mono. On a wider screen only the code scrolls
 * sideways, never the page; on a phone it wraps, keeping its indents, so a
 * one-line measure reads without a sideways scroll.
 */
export function CodePanel({
  heading,
  label,
  code,
}: {
  heading: string;
  label: string;
  code: string;
}) {
  return (
    <div className="rounded border border-line bg-raised">
      <div className="flex items-center justify-between gap-3 border-b border-line py-0.5 pr-1 pl-3">
        <span className="font-mono text-label tracking-[0.13em] text-ink-3 uppercase">
          {heading}
        </span>
        <CopyButton text={code} label={`Copy ${label}`} quiet />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-ui leading-relaxed text-ink max-sm:whitespace-pre-wrap">
        <code>{code}</code>
      </pre>
    </div>
  );
}
