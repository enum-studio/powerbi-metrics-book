import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { Notice } from "../../shell/notice";
import { Loading } from "../../shell/states";
import { formatTime } from "../../shell/time";
import { peopleQuery } from "../access/api";
import { AdminError } from "../layout/admin-layout";
import {
  Button,
  LINK,
  PageFrame,
  SectionBox,
  Segmented,
  TABLE_BOX,
  TABLE_HEAD,
  TABLE_HEADING,
} from "../layout/ui";
import {
  deleteRule,
  PII_KEY,
  putRule,
  reference,
  ruleInput,
  rulesQuery,
  suggestionsQuery,
  viaWords,
  undoSave,
  undoError,
  type Rule,
  type RuleInput,
} from "./api";
import { RuleForm } from "./rule-form";

type NoticeMessage = { message: string; undo?: () => void };
export function PiiPage() {
  const client = useQueryClient();
  const rules = useQuery(rulesQuery);
  const suggestions = useQuery(suggestionsQuery);
  const people = useQuery(peopleQuery);
  const [filter, setFilter] = useState<"all" | "pii" | "not-pii">("all");
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<NoticeMessage | null>(null);
  const dismiss = useCallback(() => {
    setNotice(null);
  }, []);
  const refresh = async () => {
    await Promise.all(
      [PII_KEY, ["catalog"], ["metric"]].map((queryKey) =>
        client.invalidateQueries({ queryKey }),
      ),
    );
  };
  const undo = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onMutate: dismiss,
    onSuccess: async () => {
      await refresh();
      setNotice({ message: "Undone." });
    },
    onError: async (error) => {
      await refresh();
      setNotice({
        message: undoError(error),
      });
    },
  });
  const save = useMutation({
    mutationFn: ({ input }: { input: RuleInput; form?: boolean }) =>
      putRule(input),
    onMutate: dismiss,
    onSuccess: async (saved) => {
      await refresh();
      setAdding(false);
      setNotice({
        message: `${reference(saved.rule.table_name, saved.rule.name)} is ${saved.rule.pii ? "PII" : "not PII"}. Covers ${String(saved.columns)} columns${saved.measures === 0 ? "" : ` and ${String(saved.measures)} measures`} in ${String(saved.datasets)} datasets you can reach.`,
        undo: () => {
          undo.mutate(() => undoSave(saved));
        },
      });
    },
    onError: (error, variables) => {
      if (!variables.form) setNotice({ message: error.message });
    },
  });
  const remove = useMutation({
    mutationFn: (rule: Rule) => deleteRule(rule.id, rule.version),
    onMutate: dismiss,
    onSuccess: async (_, rule) => {
      await refresh();
      setNotice({
        message: `${reference(rule.table_name, rule.name)} rule removed.`,
        undo: () => {
          undo.mutate(() =>
            putRule({ ...ruleInput(rule), expected_version: null }),
          );
        },
      });
    },
    onError: async (error) => {
      await refresh();
      setNotice({ message: error.message });
    },
  });
  if (rules.isError || suggestions.isError || people.isError)
    return (
      <AdminError error={rules.error ?? suggestions.error ?? people.error} />
    );
  if (rules.isPending || suggestions.isPending || people.isPending)
    return <Loading what="PII rules" />;
  const pending = save.isPending || remove.isPending || undo.isPending;
  const pii = rules.data.filter((rule) => rule.pii).length;
  // Group identical references for display only. The server owns name matching and reach.
  const grouped = new Map<
    string,
    {
      table: string;
      name: string;
      matched: string;
      datasets: Map<string, string>;
    }
  >();
  for (const row of suggestions.data) {
    const key = JSON.stringify([row.table_name, row.column_name]);
    const group = grouped.get(key) ?? {
      table: row.table_name,
      name: row.column_name,
      matched: row.matched,
      datasets: new Map<string, string>(),
    };
    group.datasets.set(row.dataset_id, row.dataset_name);
    grouped.set(key, group);
  }
  return (
    <PageFrame
      title="PII"
      lede={
        <>
          A column, measure or table marked PII is hidden from everyone without
          the <code className="font-mono">pii_reader</code> role, and a query
          that uses it is refused. A rule names a table and column, so it
          applies in every dataset that has them, including datasets made later.
        </>
      }
    >
      <p className="text-ui text-ink-2">
        {
          people.data.filter((person) =>
            person.roles.some(({ role }) => role === "pii_reader"),
          ).length
        }{" "}
        people hold <code className="font-mono">pii_reader</code>.{" "}
        <Link to="/admin/people" className={LINK}>
          Users and roles
        </Link>
      </p>
      {grouped.size > 0 && (
        <SectionBox title={`Suggestions ${String(grouped.size)}`}>
          <p className="text-meta text-ink-3">
            Columns no rule covers whose name looks personal. Nothing is marked
            until someone decides. In datasets you can reach.
          </p>
          <div className={TABLE_BOX}>
            <table className="w-full min-w-[44rem] text-left text-ui text-ink">
              <thead className={TABLE_HEAD}>
                <tr>
                  {["Column", "Matched", "Datasets", "Decision"].map(
                    (heading) => (
                      <th key={heading} scope="col" className={TABLE_HEADING}>
                        {heading}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {[...grouped].map(([key, row]) => (
                  <tr key={key} className="border-t border-line">
                    <th
                      scope="row"
                      className="px-3 py-2.5 font-mono font-normal wrap-anywhere"
                    >
                      {reference(row.table, row.name)}
                    </th>
                    <td className="px-3 py-2.5 font-mono text-ink-3">
                      {row.matched}
                    </td>
                    <td className="px-3 py-2.5">
                      {[...row.datasets.values()].join(", ")}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-2">
                        {[false, true].map((mark) => (
                          <Button
                            key={String(mark)}
                            primary={mark}
                            disabled={pending}
                            onClick={() => {
                              save.mutate({
                                input: {
                                  kind: "column",
                                  table: row.table,
                                  name: row.name,
                                  pii: mark,
                                },
                              });
                            }}
                          >
                            {mark ? "Mark PII" : "Not PII"}
                          </Button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionBox>
      )}
      <SectionBox title={`Rules ${String(rules.data.length)}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented
            label="Rule filter"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "pii", label: `PII ${String(pii)}` },
              {
                value: "not-pii",
                label: `Not PII ${String(rules.data.length - pii)}`,
              },
            ]}
          />
          <Button
            disabled={pending}
            onClick={() => {
              save.reset();
              setAdding(true);
            }}
          >
            Add a rule
          </Button>
        </div>
        {adding && (
          <RuleForm
            pending={pending}
            error={save.variables?.form === true ? save.error : null}
            save={(input) => {
              save.mutate({ input, form: true });
            }}
            cancel={() => {
              setAdding(false);
              save.reset();
            }}
          />
        )}
        <ul className="divide-y divide-line">
          {rules.data
            .filter(
              (rule) => filter === "all" || rule.pii === (filter === "pii"),
            )
            .map((rule) => (
              <li
                key={rule.id}
                id={rule.id}
                className="flex items-start justify-between gap-3 py-4 text-ui"
              >
                <div className="min-w-0 space-y-1 break-words">
                  <div className="flex flex-wrap items-center gap-3">
                    <code className="font-mono">
                      {reference(rule.table_name, rule.name)}
                    </code>
                    <span className={rule.pii ? "font-medium" : "text-ink-2"}>
                      {rule.pii ? "PII" : "Not PII"}
                    </span>
                    {rule.kind === "table" && (
                      <span className="text-ink-2">
                        every column of the table
                      </span>
                    )}
                  </div>
                  <p className="text-meta text-ink-3">
                    Covers {rule.columns}{" "}
                    {rule.kind === "measure" ? "measures" : "columns"} in{" "}
                    {rule.datasets} datasets you can reach. Set by{" "}
                    {people.data.find(
                      (person) =>
                        rule.set_by_kind === "person" &&
                        person.id === rule.set_by_id,
                    )?.email ?? rule.set_by_id}{" "}
                    {viaWords(rule.set_via)},{" "}
                    <time dateTime={rule.set_at}>
                      {formatTime(rule.set_at)}
                    </time>
                    .
                  </p>
                  {rule.note !== null && (
                    <p className="text-ink-2">{rule.note}</p>
                  )}
                </div>
                <Button
                  disabled={pending}
                  onClick={() => {
                    remove.mutate(rule);
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
        </ul>
        {rules.data.length === 0 && (
          <p className="text-ui text-ink-3">No rules yet.</p>
        )}
      </SectionBox>
      {notice !== null && <Notice {...notice} onDismiss={dismiss} />}
    </PageFrame>
  );
}
