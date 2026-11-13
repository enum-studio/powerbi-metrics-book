import { useMutation } from "@tanstack/react-query";
import { SquareTerminal } from "lucide-react";
import { type SyntheticEvent, useState } from "react";
import { ApiError, api, read } from "../api/client";
import { type DeviceRequest, sent } from "./api";
import {
  AccessCard,
  Button,
  JoinedMarks,
  Panel,
  PRIMARY,
  Problem,
  WillLists,
} from "./parts";
import { formatTime } from "../shell/time";

const FAULT =
  "This page stopped because of a fault in its own code. Reload it and type the code again.";

const sentence = (error: Error) =>
  error instanceof ApiError ? error.message : FAULT;

/**
 * The CLI's device code: typed by the person, never filled in from a link,
 * so a code someone else sent cannot be approved with one click. Before
 * Allow it shows when and from which address the login started.
 */
export function Device({ linkCarriedCode }: { linkCarriedCode: boolean }) {
  const [typed, setTyped] = useState("");
  const [answered, setAnswered] = useState<"allowed" | "denied" | null>(null);
  const lookup = useMutation({
    mutationFn: async (user_code: string) =>
      read(
        api.GET("/api/v1/oauth/device", { params: { query: { user_code } } }),
      ),
  });
  const answer = useMutation({
    mutationFn: async ({
      user_code,
      allow,
    }: {
      user_code: string;
      allow: boolean;
    }) => {
      await sent(
        api.POST("/api/v1/oauth/device", { body: { user_code, allow } }),
      );
      setAnswered(allow ? "allowed" : "denied");
    },
  });

  if (answered !== null) return <Done answered={answered} />;

  const request = lookup.data;
  if (request !== undefined)
    return (
      <Confirm
        request={request}
        busy={answer.isPending}
        problem={answer.error === null ? null : sentence(answer.error)}
        onAnswer={(allow) => {
          answer.mutate({ user_code: request.user_code, allow });
        }}
        onBack={() => {
          lookup.reset();
          answer.reset();
          setTyped("");
        }}
      />
    );

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    lookup.mutate(typed.trim());
  };
  return (
    <AccessCard>
      <JoinedMarks client={SquareTerminal} />
      <form
        onSubmit={submit}
        className="flex flex-col items-center gap-4 text-center"
      >
        <h1 className="text-title leading-tight font-semibold text-ink">
          Enter the code from your terminal
        </h1>
        <p className="max-w-(--measure) text-ui text-ink-2">
          <span className="font-mono">pbmb login</span> shows a code. Type it
          here to sign the command line in as you.
        </p>
        {linkCarriedCode && (
          <p className="text-ui text-ink-2">
            The link you followed carried a code. Type the one your own terminal
            shows instead.
          </p>
        )}
        <label htmlFor="user-code" className="sr-only">
          Code from your terminal
        </label>
        <input
          id="user-code"
          required
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={20}
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value.toUpperCase());
          }}
          placeholder="ABCD-EFGH"
          className="w-full rounded border border-line-control bg-surface px-3 py-3 text-center font-mono text-title tracking-[0.2em] text-ink uppercase placeholder:text-ink-3"
        />
        {lookup.error !== null && <Problem>{sentence(lookup.error)}</Problem>}
        <button type="submit" disabled={lookup.isPending} className={PRIMARY}>
          Continue
        </button>
      </form>
    </AccessCard>
  );
}

function Confirm({
  request,
  busy,
  problem,
  onAnswer,
  onBack,
}: {
  request: DeviceRequest;
  busy: boolean;
  problem: string | null;
  onAnswer: (allow: boolean) => void;
  onBack: () => void;
}) {
  return (
    <AccessCard>
      <JoinedMarks client={SquareTerminal} />
      <header className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-heading font-semibold text-ink">
          {request.client_name} wants to sign in as{" "}
          <span className="break-all">{request.person.email}</span>
        </h1>
        <p
          data-testid="device-code"
          className="mt-2 font-mono text-title tracking-[0.2em] text-ink"
        >
          {request.user_code}
        </p>
        <p className="text-ui text-ink-2">
          Started {formatTime(request.started_at)} from{" "}
          <span className="font-mono">
            {request.started_from ?? "an address that was not recorded"}
          </span>
        </p>
        <p className="text-meta text-ink-3">
          If you did not just run pbmb login yourself, at that time, deny it.
        </p>
      </header>
      <Panel>
        <WillLists will={request.will} willNot={request.will_not} />
      </Panel>
      <div className="flex flex-col gap-2">
        <Button
          kind="primary"
          disabled={busy}
          onClick={() => {
            onAnswer(true);
          }}
        >
          Allow
        </Button>
        <Button
          kind="secondary"
          disabled={busy}
          onClick={() => {
            onAnswer(false);
          }}
        >
          Deny
        </Button>
        <button
          type="button"
          onClick={onBack}
          className="self-center py-2 text-ui text-ink-2 underline underline-offset-4 hover:text-ink"
        >
          Back
        </button>
        {problem !== null && <Problem>{problem}</Problem>}
      </div>
    </AccessCard>
  );
}

function Done({ answered }: { answered: "allowed" | "denied" }) {
  return (
    <AccessCard>
      <JoinedMarks client={SquareTerminal} />
      <section
        role="status"
        className="flex flex-col items-center gap-2 text-center"
      >
        <h1 className="text-title leading-tight font-semibold text-ink">
          {answered === "allowed"
            ? "The command line is signed in"
            : "You denied the sign-in"}
        </h1>
        <p className="text-ui text-ink-2">
          {answered === "allowed"
            ? "Go back to your terminal: pbmb carries on there. You can close this tab."
            : "pbmb login stops in your terminal. You can close this tab."}
        </p>
      </section>
    </AccessCard>
  );
}
