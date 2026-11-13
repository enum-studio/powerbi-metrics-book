import { type ButtonHTMLAttributes, type ReactNode, useId } from "react";

export const INPUT =
  "w-full min-w-0 rounded border border-line-control bg-surface px-3 py-1.5 text-ui text-ink disabled:text-ink-3 pointer-coarse:min-h-(--tap)";

export const LINK =
  "text-accent underline underline-offset-4 hover:text-accent-hover";

/** The one look of a table: a rounded edge that scrolls sideways when it must, and a quiet head. */
export const TABLE_BOX = "overflow-x-auto rounded border border-line";
export const TABLE_HEAD = "bg-raised text-meta text-ink-3";
export const TABLE_HEADING = "px-3 py-2 font-medium whitespace-nowrap";

/** A plain button, or the one primary action of a form. */
export function Button({
  primary = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={`rounded border px-3 py-1.5 text-ui whitespace-nowrap disabled:opacity-60 pointer-coarse:min-h-(--tap) ${
        primary
          ? "border-accent bg-accent text-on-accent hover:bg-accent-hover"
          : "border-line-control bg-surface text-ink hover:bg-raised"
      }`}
    />
  );
}

/** A page: its name, one line on what it is for, the content, and the help beside it once the page has room, at 672px of its own width. A page with no help gives its content the whole width, as a page of wide tables needs. */
export function PageFrame({
  title,
  lede,
  help,
  children,
}: {
  title: string;
  lede: ReactNode;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={`grid gap-x-10 gap-y-6 ${help === undefined ? "" : "@2xl:grid-cols-[minmax(0,1fr)_14rem]"}`}
    >
      <div className="min-w-0 @2xl:col-start-1">
        <h1 className="text-title font-semibold text-ink">{title}</h1>
        <p className="mt-1 max-w-(--measure) text-ui text-ink-2">{lede}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-8 @2xl:col-start-1">
        {children}
      </div>
      {help !== undefined && (
        <aside
          aria-label="Help"
          className="min-w-0 text-ui text-ink-2 @2xl:col-start-2 @2xl:row-span-2 @2xl:row-start-1"
        >
          <div className="@2xl:sticky @2xl:top-8">
            <h2 className="text-ui font-semibold text-ink">Need help?</h2>
            <div className="mt-2 flex flex-col gap-2">{help}</div>
          </div>
        </aside>
      )}
    </div>
  );
}

export function SectionBox({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="border-t border-line pt-6">
      <h2 id={id} className="text-heading font-semibold text-ink">
        {title}
      </h2>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

/** A check's sentence: what is wrong in the check's own words, or that it passed. */
export function CheckLine({
  status,
  message,
}: {
  status: "passing" | "failing" | "unchecked";
  message: string | null;
}) {
  if (status === "unchecked")
    return <p className="text-meta text-ink-3">Not checked yet.</p>;
  return (
    <p
      role={status === "failing" ? "alert" : "status"}
      className={`text-ui ${status === "failing" ? "text-out" : "text-ink-2"}`}
    >
      <span className="mr-2 font-semibold">
        {status === "failing" ? "Failing." : "Passing."}
      </span>
      {message}
    </p>
  );
}

/** The date part of a timestamp. */
export function day(iso: string): string {
  return iso.slice(0, 10);
}

export function Label({
  htmlFor,
  children,
  hint,
}: {
  htmlFor: string;
  children: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <label htmlFor={htmlFor} className="text-ui font-medium text-ink">
        {children}
      </label>
      {hint !== undefined && <p className="text-meta text-ink-3">{hint}</p>}
    </div>
  );
}

/** An immediate, named choice, with its state in words as well as colour. */
export function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        onChange(!checked);
      }}
      className="inline-flex items-center gap-2 py-1 disabled:opacity-60 pointer-coarse:min-h-(--tap)"
    >
      <span
        aria-hidden="true"
        className={`relative h-5 w-9 rounded-sheet ${checked ? "bg-accent" : "bg-raised"}`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-sheet transition-[left] duration-150 motion-reduce:transition-none ${checked ? "left-4.5 bg-on-accent" : "left-0.5 bg-ink-3"}`}
        />
      </span>
      <span
        aria-hidden="true"
        className={`text-ui ${checked ? "text-ink" : "text-ink-3"}`}
      >
        {checked ? "On" : "Off"}
      </span>
    </button>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset
      disabled={disabled}
      className="inline-flex w-fit max-w-full shrink-0 flex-wrap rounded border border-line-control p-0.5"
    >
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => {
            onChange(option.value);
          }}
          className={`rounded px-3 py-1 text-ui whitespace-nowrap disabled:opacity-60 pointer-coarse:min-h-(--tap) pointer-coarse:min-w-(--tap) ${value === option.value ? "bg-accent text-on-accent" : "text-ink-2 hover:bg-raised"}`}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}
