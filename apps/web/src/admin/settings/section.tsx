import {
  useQueryClient,
  useSuspenseQueries,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "../../api/client";
import { Button, CheckLine, SectionBox } from "../layout/ui";
import {
  ADMIN_KEY,
  type Check,
  putSetting,
  secretsQuery,
  settingQuery,
  statusQuery,
} from "./api";
import {
  type Draft,
  FieldRow,
  type FieldSpec,
  fromDraft,
  toDraft,
} from "./fields";
import { PendingLine, usePolledCheck } from "./polled-check";
import { SecretRow } from "./secret-row";

type Values = Record<string, unknown>;

type Refusal = { key: string; sentence: string };

/**
 * A section: its fields, the secrets it takes, Save and its Check. Saving
 * sends each changed setting with the api's own check first. A value whose
 * check fails shows the check's sentence and "Save anyway", which saves it
 * marked failing. Once saved, the section's Check runs on what is stored, as
 * the setup's steps do, and a failure stays marked until a check passes.
 */
export function Section({
  title,
  fields,
  secrets = () => [],
  checkName,
  onSaved,
  note,
}: {
  title: string;
  fields: readonly FieldSpec[];
  /** The secrets to show, from the values as edited and as saved. */
  secrets?: (draft: Values, saved: Values) => string[];
  checkName?: string;
  onSaved?: () => Promise<void>;
  note?: string;
}) {
  const queryClient = useQueryClient();
  const settings = useSuspenseQueries({
    queries: fields.map((field) => settingQuery(field.key)),
  }).map((result) => result.data);
  const { data: allSecrets } = useSuspenseQuery(secretsQuery);
  const { data: status } = useSuspenseQuery(statusQuery);

  const saved: Draft[] = fields.map((field, i) =>
    toDraft(field, settings[i]?.value),
  );
  const [edits, setEdits] = useState<Record<string, Draft>>({});
  const draftOf = (i: number): Draft => {
    const field = fields[i];
    return (field && edits[field.key]) ?? saved[i] ?? "";
  };
  const changed = fields.filter(
    (field, i) =>
      edits[field.key] !== undefined &&
      JSON.stringify(edits[field.key]) !== JSON.stringify(saved[i]),
  );

  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [wasSaved, setWasSaved] = useState(false);
  const checking = usePolledCheck(checkName);
  const ran: Check | null = checking.result;
  const earlier = checkName
    ? status.failing_checks.find((c) => c.name === checkName)
    : undefined;
  const check = checking.run;

  async function guarded(work: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    setRefusal(null);
    setWasSaved(false);
    try {
      await work();
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      setProblem(error.message);
    } finally {
      setBusy(false);
    }
  }

  const save = (anyway: string | null) =>
    guarded(async () => {
      for (const field of changed) {
        const edit = edits[field.key];
        if (edit === undefined) continue;
        try {
          await putSetting(
            field.key,
            fromDraft(field, edit),
            field.key === anyway,
          );
        } catch (error) {
          const refused = error instanceof ApiError ? error.saveAnyway : null;
          if (refused === null) throw error;
          setRefusal({ key: field.key, sentence: refused.message });
          return;
        }
        setEdits((now) =>
          Object.fromEntries(
            Object.entries(now).filter(([key]) => key !== field.key),
          ),
        );
      }
      await queryClient.invalidateQueries({ queryKey: ADMIN_KEY });
      await onSaved?.();
      setWasSaved(true);
      await check();
    });

  const draftValues = Object.fromEntries(
    fields.map((f, i) => [f.key, draftOf(i)]),
  );
  const savedValues = Object.fromEntries(
    fields.map((f, i) => [f.key, settings[i]?.value]),
  );
  const shown = allSecrets.filter((s) =>
    secrets(draftValues, savedValues).includes(s.name),
  );
  const result =
    ran ??
    (earlier
      ? { status: "failing" as const, message: earlier.message ?? null }
      : null);
  const editable = settings.some(
    (s) => s.source !== "environment" && !s.environment_only,
  );

  const checkButton = checkName !== undefined && (
    <Button
      disabled={busy || ran?.pending === true}
      onClick={() => {
        void guarded(check);
      }}
    >
      Check
    </Button>
  );

  return (
    <SectionBox title={title}>
      {note !== undefined && <p className="text-ui text-ink-2">{note}</p>}
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save(null);
        }}
      >
        {fields.map((field, i) => {
          const setting = settings[i];
          if (setting === undefined) return null;
          return (
            <FieldRow
              key={field.key}
              spec={field}
              setting={setting}
              draft={draftOf(i)}
              onChange={(draft) => {
                setEdits({ ...edits, [field.key]: draft });
              }}
            />
          );
        })}
        {(editable || refusal !== null || shown.length === 0) && (
          <div className="flex flex-wrap items-center gap-2">
            {editable && (
              <Button
                type="submit"
                primary
                disabled={busy || changed.length === 0}
              >
                Save
              </Button>
            )}
            {refusal !== null && (
              <Button
                disabled={busy}
                onClick={() => {
                  void save(refusal.key);
                }}
              >
                Save anyway
              </Button>
            )}
            {shown.length === 0 && checkButton}
            {wasSaved && <span className="text-ui text-ink-2">Saved.</span>}
          </div>
        )}
        {refusal !== null && (
          <p role="alert" className="text-ui text-out">
            <span className="font-semibold">
              {refusal.key} failed its check.{" "}
            </span>
            {refusal.sentence} Save anyway keeps it, marked failing.
          </p>
        )}
        {problem !== null && (
          <p role="alert" className="text-ui text-out">
            {problem}
          </p>
        )}
      </form>
      {/* Beside the form, not in it: a secret has a form of its own, and nested forms are invalid HTML. */}
      {shown.length > 0 && (
        <div className="divide-y divide-line">
          {shown.map((secret) => (
            <div key={secret.name} className="py-4 first:pt-0 last:pb-0">
              <SecretRow secret={secret} afterSet={check} />
            </div>
          ))}
        </div>
      )}
      {checkName !== undefined && (
        <div className="flex flex-col gap-2">
          {shown.length > 0 && <div>{checkButton}</div>}
          {ran?.pending === true ? (
            <PendingLine message={ran.message} />
          ) : (
            result !== null && (
              <CheckLine status={result.status} message={result.message} />
            )
          )}
          {checking.problem !== null && (
            <p role="alert" className="text-ui text-out">
              {checking.problem}
            </p>
          )}
        </div>
      )}
    </SectionBox>
  );
}
