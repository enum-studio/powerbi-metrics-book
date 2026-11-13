import { useState } from "react";
import { Button, INPUT, Label, Segmented } from "../layout/ui";
import { fieldError, type RuleInput } from "./api";

export function RuleForm({
  save,
  cancel,
  pending,
  error,
}: {
  save: (input: RuleInput) => void;
  cancel: () => void;
  pending: boolean;
  error: Error | null;
}) {
  const [kind, setKind] = useState<RuleInput["kind"]>("column");
  const [table, setTable] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const invalid = fieldError(error);
  const submit = (pii: boolean) => {
    save({
      kind,
      table,
      ...(kind === "table" ? {} : { name }),
      pii,
      note: note || null,
    });
  };
  return (
    <form
      aria-label="Add a rule"
      className="flex flex-col gap-4 rounded border border-line bg-bg p-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit(true);
      }}
    >
      <div className="overflow-x-auto">
        <Segmented
          label="Rule kind"
          value={kind}
          disabled={pending}
          onChange={setKind}
          options={[
            { value: "column", label: "A column" },
            { value: "measure", label: "A measure" },
            { value: "table", label: "A whole table" },
          ]}
        />
      </div>
      {(["table", ...(kind === "table" ? [] : ["name"]), "note"] as const).map(
        (field) => {
          const id = `pii-${field}`;
          const value =
            field === "table" ? table : field === "name" ? name : note;
          const set =
            field === "table" ? setTable : field === "name" ? setName : setNote;
          return (
            <div key={field} className="flex flex-col gap-1">
              <Label
                htmlFor={id}
                hint={
                  field === "note" ? "optional, for the next admin" : undefined
                }
              >
                {field === "table"
                  ? "Table"
                  : field === "note"
                    ? "Note"
                    : kind === "measure"
                      ? "Measure"
                      : "Column"}
              </Label>
              <input
                id={id}
                className={INPUT}
                value={value}
                disabled={pending}
                aria-invalid={invalid === field}
                aria-describedby={invalid === field ? `${id}-error` : undefined}
                onChange={(event) => {
                  set(event.target.value);
                }}
              />
              {invalid === field && (
                <p
                  id={`${id}-error`}
                  role="alert"
                  className="text-meta text-out"
                >
                  {error?.message}
                </p>
              )}
            </div>
          );
        },
      )}
      <p className="text-meta text-ink-3">
        Names match in every dataset, ignoring case. A whole-table rule covers
        every column of the table, now and later, but not its measures.
      </p>
      {error !== null && invalid === null && (
        <p role="alert" className="text-ui text-ink-2">
          {error.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button primary type="submit" disabled={pending}>
          Mark PII
        </Button>
        <Button
          disabled={pending}
          onClick={() => {
            submit(false);
          }}
        >
          Mark not PII
        </Button>
        <Button disabled={pending} onClick={cancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
