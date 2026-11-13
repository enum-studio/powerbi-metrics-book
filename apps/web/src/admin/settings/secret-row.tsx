import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ApiError } from "../../api/client";
import { Button, CheckLine, day, INPUT, Label } from "../layout/ui";
import { ADMIN_KEY, putSecret, putSecretExpiry, type Secret } from "./api";
import { PendingLine, usePolledCheck } from "./polled-check";
import { SecretInput } from "./secret-input";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The check a secret belongs to: the section it is entered in, whose check reads it. */
export function checkOfSecret(name: string): string | null {
  if (name === "powerbi_app_client_secret") return "app_registration";
  if (name === "powerbi_scanner_client_secret") return "scanner";
  if (/^sign_in_.+_client_secret$/.test(name)) return "sign_in";
  if (name === "openai_api_key" || name === "gemini_api_key") return "search";
  return null;
}

/** Said in words, and marked at 30 and 7 days as the spec's warnings are. */
export function expiry(iso: string, now: number) {
  const days = Math.ceil((new Date(iso).getTime() - now) / DAY_MS);
  if (days <= 0) return { text: `expired on ${day(iso)}`, tone: "text-out" };
  if (days <= 7)
    return {
      text: `expires in ${String(days)} days, on ${day(iso)}: enter a new one now`,
      tone: "text-out font-semibold",
    };
  if (days <= 30)
    return {
      text: `expires in ${String(days)} days, on ${day(iso)}: within 30 days`,
      tone: "text-ink font-semibold",
    };
  return { text: `expires on ${day(iso)}`, tone: "text-ink-2" };
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="text-ink-3">{term}</dt>
      <dd className="min-w-0 break-words text-ink-2">{children}</dd>
    </div>
  );
}

/**
 * One secret, as the api shows it: set or not, its last four characters, who
 * set it and when, its expiry. "Set" opens a password field whose value is
 * only this component's state until it is sent, and gone when it is.
 */
export function SecretRow({
  secret,
  afterSet,
  withCheck = false,
}: {
  secret: Secret;
  afterSet?: () => Promise<void>;
  withCheck?: boolean;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [expires, setExpires] = useState("");
  const [dating, setDating] = useState(false);
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const checkName = checkOfSecret(secret.name);
  const checking = usePolledCheck(checkName);
  const checked = checking.result;
  const stored = secret.check_status;

  async function send() {
    setSaid(null);
    setBusy(true);
    setProblem(null);
    try {
      await putSecret(
        secret.name,
        value,
        expires === "" ? null : `${expires}T23:59:59Z`,
      );
      setValue("");
      setExpires("");
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ADMIN_KEY });
      await afterSet?.();
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      setProblem(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function sendDate() {
    setSaid(null);
    if (date === "" && secret.expires_at === null) {
      setProblem("Enter a date first. Nothing was saved.");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await putSecretExpiry(
        secret.name,
        date === "" ? null : `${date}T23:59:59Z`,
      );
      setDating(false);
      setSaid(
        date === ""
          ? "The expiry date is removed. The status page no longer warns before it expires."
          : `The expiry date is saved: ${date}.`,
      );
      await queryClient.invalidateQueries({ queryKey: ADMIN_KEY });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      setProblem(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    if (checkName === null) return;
    setBusy(true);
    try {
      await checking.run();
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      setProblem(error.message);
    } finally {
      setBusy(false);
    }
  }

  const when =
    secret.expires_at === null ? null : expiry(secret.expires_at, Date.now());
  return (
    <div role="group" aria-label={secret.name} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-mono text-ui font-semibold break-all text-ink">
            {secret.name}
          </h3>
          <p className="text-meta text-ink-3">
            Read by the {secret.readers.join(" and ")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {withCheck && checkName !== null && (
            <Button
              disabled={busy || !secret.set || checked?.pending === true}
              onClick={() => {
                void check();
              }}
            >
              Check
            </Button>
          )}
          {secret.set && (
            <Button
              disabled={dating}
              onClick={() => {
                setDate(secret.expires_at?.slice(0, 10) ?? "");
                setDating(true);
                setSaid(null);
              }}
            >
              Expiry date
            </Button>
          )}
          <Button
            disabled={open}
            onClick={() => {
              setOpen(true);
            }}
          >
            {secret.set ? "Replace" : "Set"}
          </Button>
        </div>
      </div>
      <dl className="flex flex-col gap-0.5 text-ui">
        <Fact term="Value">
          {secret.set ? (
            <>
              set, ends in{" "}
              <span className="font-mono text-ink">
                {secret.hint ?? "----"}
              </span>
            </>
          ) : (
            "not set"
          )}
        </Fact>
        {secret.set && (
          <Fact term="Set by">
            {secret.set_by}
            {secret.set_at !== null && ` on ${day(secret.set_at)}`}
          </Fact>
        )}
        {when !== null && (
          <Fact term="Expiry">
            <span className={when.tone}>{when.text}</span>
          </Fact>
        )}
        {secret.needs_reentry_for.length > 0 && (
          <Fact term="Needs">
            <span className="text-out">
              entering again for the {secret.needs_reentry_for.join(" and ")}
            </span>
          </Fact>
        )}
      </dl>
      {withCheck &&
        (checked?.pending === true ? (
          <PendingLine message={checked.message} />
        ) : checked !== null ? (
          <CheckLine status={checked.status} message={checked.message} />
        ) : (
          <CheckLine
            status={stored ?? "unchecked"}
            message={secret.check_message}
          />
        ))}
      {dating && (
        <form
          aria-label={`Expiry date of ${secret.name}`}
          className="flex flex-col gap-3 border-t border-line pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            void sendDate();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label
              htmlFor={`${id}-date`}
              hint="As Entra shows it. The value stays as it is. The status page warns 30 and 7 days before."
            >
              Expiry date
            </Label>
            <input
              id={`${id}-date`}
              type="date"
              value={date}
              className={INPUT}
              onChange={(event) => {
                setDate(event.target.value);
              }}
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" primary disabled={busy}>
              Save date
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setDating(false);
                setProblem(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {open && (
        <form
          className="flex flex-col gap-3 border-t border-line pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label
              htmlFor={`${id}-value`}
              hint="Shown once. After saving, only its last four characters are."
            >
              New value
            </Label>
            <SecretInput
              id={`${id}-value`}
              required
              value={value}
              className={`${INPUT} font-mono`}
              onChange={(event) => {
                setValue(event.target.value);
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label
              htmlFor={`${id}-expires`}
              hint="Optional. The status page warns 30 and 7 days before it."
            >
              Expiry date
            </Label>
            <input
              id={`${id}-expires`}
              type="date"
              value={expires}
              className={INPUT}
              onChange={(event) => {
                setExpires(event.target.value);
              }}
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" primary disabled={busy || value === ""}>
              Save secret
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setValue("");
                setOpen(false);
                setProblem(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {said !== null && (
        <p role="status" className="text-ui text-ink-2">
          {said}
        </p>
      )}
      {(problem ?? checking.problem) !== null && (
        <p role="alert" className="text-ui text-out">
          {problem ?? checking.problem}
        </p>
      )}
    </div>
  );
}
