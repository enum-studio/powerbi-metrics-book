import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

const SHOWN_FOR_MS = 2000;

/**
 * The one button that copies a value, wherever a screen asks a person to
 * paste something elsewhere. It always says "Copy", then "Copied" for two
 * seconds, or "Could not copy" when the browser refuses the clipboard.
 * `label` is its full name for a screen reader, such as "Copy the key".
 * `quiet` is for the slim header over a block of code: no border, and on a
 * phone the icon alone, as Perplexity and ChatGPT copy code.
 */
export function CopyButton({
  text,
  label,
  quiet = false,
}: {
  text: string;
  label: string;
  quiet?: boolean;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const reset = setTimeout(() => {
      setState("idle");
    }, SHOWN_FOR_MS);
    return () => {
      clearTimeout(reset);
    };
  }, [state]);
  const words =
    state === "copied"
      ? "Copied"
      : state === "failed"
        ? "Could not copy"
        : "Copy";
  const Icon = state === "copied" ? Check : Copy;
  return (
    <button
      type="button"
      aria-label={state === "idle" ? label : words}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded text-meta whitespace-nowrap text-ink-2 hover:text-ink pointer-coarse:min-h-(--tap) ${quiet ? "px-1.5 py-1 hover:bg-surface pointer-coarse:min-w-(--tap)" : "border border-line-control bg-surface px-2.5 py-1.5 hover:bg-raised"}`}
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => {
            setState("copied");
          },
          () => {
            setState("failed");
          },
        );
      }}
    >
      <Icon size={14} strokeWidth={1.5} aria-hidden="true" />
      <span className={quiet ? "max-sm:sr-only" : undefined}>{words}</span>
    </button>
  );
}

/** Text of several lines to paste somewhere else: a message in the page's type, a config file in mono. */
export function CopyBlock({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-meta text-ink-3">{label}</span>
      <div className="flex min-w-0 items-start gap-2">
        <pre
          className={`min-w-0 flex-1 overflow-x-auto rounded border border-line bg-surface px-2.5 py-1.5 text-ink ${mono ? "font-mono text-meta" : "font-sans text-ui whitespace-pre-wrap"}`}
        >
          {value}
        </pre>
        <CopyButton text={value} label={`Copy ${label}`} />
      </div>
    </div>
  );
}

/** A value to paste somewhere else, named above and shown in Plex Mono beside its Copy button. */
export function CopyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-meta text-ink-3">{label}</span>
      <div className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 rounded border border-line bg-surface px-2.5 py-1.5 font-mono text-ui wrap-anywhere text-ink">
          {value}
        </code>
        <CopyButton text={value} label={`Copy ${label}`} />
      </div>
    </div>
  );
}
