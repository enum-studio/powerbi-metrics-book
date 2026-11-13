import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { CopyButton } from "../../shell/copy-button";
import { EmptyState } from "../../shell/states";
import { Button, INPUT, Label, SectionBox } from "../layout/ui";
import {
  createKey,
  keysQuery,
  type NewApiKey,
  revokeKey,
  type ServiceAccount,
} from "./api";
import {
  CELL,
  ConfirmButton,
  DataTable,
  Problem,
  stamp,
  useGuarded,
} from "./parts";

/** How the holder's key starts: pbmb_sk_, then the eight characters that start its random part, which is all the api keeps. */
const shownKey = (prefix: string) => `pbmb_sk_${prefix}…`;

/** The key's one showing. It lives in this component's state alone, never in the query cache, so a reload loses it. */
function KeyShownOnce({
  made,
  onDone,
}: {
  made: NewApiKey;
  onDone: () => void;
}) {
  return (
    <section
      aria-label="New key"
      className="flex flex-col gap-3 rounded border border-line-strong bg-surface p-4"
    >
      <h3 className="text-ui font-semibold text-ink">Key created</h3>
      <p className="max-w-(--measure) text-ui text-ink-2">
        This key will not be shown again. Copy it now and keep it somewhere
        safe. If you lose it, make a new one and revoke this one.
      </p>
      <input
        readOnly
        aria-label="The new key"
        value={made.key}
        onFocus={(event) => {
          event.target.select();
        }}
        className={`${INPUT} font-mono`}
      />
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton text={made.key} label="Copy the key" />
        <Button primary onClick={onDone}>
          Done
        </Button>
      </div>
    </section>
  );
}

export function Keys({ account }: { account: ServiceAccount }) {
  const { data: keys } = useSuspenseQuery(keysQuery(account.name));
  const { busy, problem, run } = useGuarded();
  const [days, setDays] = useState(String(account.max_key_age_days));
  const [made, setMade] = useState<NewApiKey | null>(null);

  return (
    <SectionBox title={`API keys for ${account.name}`}>
      {made !== null && (
        <KeyShownOnce
          made={made}
          onDone={() => {
            setMade(null);
          }}
        />
      )}
      {keys.length === 0 ? (
        <EmptyState title="No keys yet">
          Make a key below. The service account cannot sign in without one.
        </EmptyState>
      ) : (
        <DataTable
          label={`API keys for ${account.name}`}
          min="min-w-[40rem]"
          head={["Key", "Created", "Expires", "Last used", ""]}
        >
          {keys.map((key) => (
            <tr key={key.id}>
              <td className={`${CELL} font-mono whitespace-nowrap text-ink`}>
                {shownKey(key.prefix)}
              </td>
              <td className={CELL}>{stamp(key.created_at)}</td>
              <td className={CELL}>{stamp(key.expires_at)}</td>
              <td className={CELL}>{stamp(key.last_used_at)}</td>
              <td className={CELL}>
                {key.revoked_at === null ? (
                  <ConfirmButton
                    label="Revoke"
                    question={`Revoke ${shownKey(key.prefix)} now? Whatever uses it stops working at once.`}
                    confirm="Revoke key"
                    disabled={busy}
                    onConfirm={() => {
                      void run(() => revokeKey(account.name, key.id));
                    }}
                  />
                ) : (
                  `Revoked ${stamp(key.revoked_at)}`
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      <form
        aria-label="Make a key"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            setMade(await createKey(account.name, Number(days)));
          });
        }}
      >
        <div className="flex w-48 flex-col gap-1">
          <Label
            htmlFor="key-days"
            hint={`At most ${String(account.max_key_age_days)} days, this account's limit.`}
          >
            Lasts (days)
          </Label>
          <input
            id="key-days"
            type="number"
            min={1}
            max={account.max_key_age_days}
            required
            className={INPUT}
            value={days}
            onChange={(event) => {
              setDays(event.target.value);
            }}
          />
        </div>
        <Button
          type="submit"
          primary
          disabled={busy || account.disabled_at !== null}
        >
          Make a key
        </Button>
      </form>
      {account.disabled_at !== null && (
        <p className="text-ui text-ink-2">
          This account is disabled. Enable it to make a key.
        </p>
      )}
      <Problem sentence={problem} />
    </SectionBox>
  );
}
