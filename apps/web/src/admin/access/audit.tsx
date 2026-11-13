import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useId, useState } from "react";
import { EmptyState, Loading } from "../../shell/states";
import { Button, INPUT, Label, SectionBox } from "../layout/ui";
import { actorName } from "./actor";
import { AUDIT_PAGE, type AuditFilter, auditQuery, peopleQuery } from "./api";
import { CELL, DataTable, stamp } from "./parts";

type Filter = Omit<AuditFilter, "before_id">;
const ANYONE: Filter = { principal: "", action: "", since: "" };

function Filters({ onApply }: { onApply: (filter: Filter) => void }) {
  const id = useId();
  const { data: people } = useSuspenseQuery(peopleQuery);
  const [draft, setDraft] = useState<Filter>(ANYONE);
  return (
    <form
      aria-label="Filter the audit log"
      className="grid gap-4 @lg:grid-cols-2 @lg:items-end @2xl:grid-cols-4"
      onSubmit={(event) => {
        event.preventDefault();
        onApply(draft);
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-person`}>Person</Label>
        <select
          id={`${id}-person`}
          className={INPUT}
          value={draft.principal}
          onChange={(event) => {
            setDraft({ ...draft, principal: event.target.value });
          }}
        >
          <option value="">Anyone</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.email}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-action`}>Action</Label>
        <input
          id={`${id}-action`}
          className={INPUT}
          placeholder="role.assign"
          value={draft.action}
          onChange={(event) => {
            setDraft({ ...draft, action: event.target.value.trim() });
          }}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-since`}>From date</Label>
        <input
          id={`${id}-since`}
          type="date"
          className={INPUT}
          value={draft.since}
          onChange={(event) => {
            setDraft({ ...draft, since: event.target.value });
          }}
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" primary>
          Apply
        </Button>
        <Button
          onClick={() => {
            setDraft(ANYONE);
            onApply(ANYONE);
          }}
        >
          Clear
        </Button>
      </div>
    </form>
  );
}

function Events({
  filter,
  cursors,
  onOlder,
  onNewer,
}: {
  filter: Filter;
  cursors: number[];
  onOlder: (beforeId: number) => void;
  onNewer: () => void;
}) {
  const { data: people } = useSuspenseQuery(peopleQuery);
  const { data: events } = useSuspenseQuery(
    auditQuery({ ...filter, before_id: cursors.at(-1) }),
  );
  const last = events.at(-1);
  return (
    <>
      {events.length === 0 ? (
        <EmptyState title="No events here">
          {cursors.length > 0
            ? "There is nothing older than the page before."
            : "Nothing matches these filters. Clear them to see every event."}
        </EmptyState>
      ) : (
        <DataTable
          label="Audit log"
          min="min-w-[40rem]"
          head={["When", "Action, and who did it", "On", "Decision"]}
        >
          {events.map((event) => (
            <tr key={event.id}>
              <td className={`${CELL} whitespace-nowrap`}>{stamp(event.at)}</td>
              <td className={CELL}>
                <p className="break-words font-mono text-ink">{event.action}</p>
                <p className="break-words text-meta text-ink-3">
                  {actorName(people, event.principal_kind, event.principal_id)}
                </p>
              </td>
              <td className={CELL}>
                {event.resource_kind !== null && (
                  <>
                    <p>{event.resource_kind}</p>
                    <p className="font-mono text-meta break-all text-ink-3">
                      {event.resource_id}
                    </p>
                  </>
                )}
              </td>
              <td className={CELL}>
                {event.decision === "allow" ? "Allowed" : "Refused"}
                {event.reason !== null && `: ${event.reason}`}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      <div className="flex gap-2">
        <Button disabled={cursors.length === 0} onClick={onNewer}>
          Newer
        </Button>
        <Button
          disabled={last === undefined || events.length < AUDIT_PAGE}
          onClick={() => {
            if (last !== undefined) onOlder(last.id);
          }}
        >
          Older
        </Button>
      </div>
    </>
  );
}

export function AuditLog() {
  const [filter, setFilter] = useState<Filter>(ANYONE);
  const [cursors, setCursors] = useState<number[]>([]);
  return (
    <SectionBox title="Events">
      <Suspense fallback={<Loading what="the filters" />}>
        <Filters
          onApply={(next) => {
            setFilter(next);
            setCursors([]);
          }}
        />
      </Suspense>
      <Suspense fallback={<Loading what="the audit log" />}>
        <Events
          filter={filter}
          cursors={cursors}
          onOlder={(beforeId) => {
            setCursors([...cursors, beforeId]);
          }}
          onNewer={() => {
            setCursors(cursors.slice(0, -1));
          }}
        />
      </Suspense>
    </SectionBox>
  );
}
