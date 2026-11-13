import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AppWindow,
  CalendarClock,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import { ApiError, api, read } from "../api/client";
import { EmptyState, ErrorState } from "../shell/states";
import { type ConsentRequest, consentQuery } from "./api";
import { shownRedirect } from "./links";
import {
  AccessCard,
  Button,
  JoinedMarks,
  Panel,
  Problem,
  WillLists,
} from "./parts";
import { formatTime } from "../shell/time";

const REGISTERED_BY: Record<string, string> = {
  metadata_document: "through its metadata document",
  dynamic_registration: "by registering itself",
  this_api: "by this site",
};

/**
 * The consent for an MCP client, from the query Better Auth signed. The
 * checked fact (the host serving the client's metadata document) is set
 * apart from what the client only claims (its name), and the address the
 * answer goes to sits under the buttons.
 */
export function Consent({ signed }: { signed: string }) {
  const { data: request } = useSuspenseQuery(consentQuery(signed));
  const { client, redirect } = request;
  const name = client.claimed_name ?? "An app with no name";

  const answer = useMutation({
    mutationFn: async (allow: boolean) => {
      const { redirect_to } = await read(
        api.POST("/api/v1/oauth/consent", { body: { request: signed, allow } }),
      );
      const target =
        redirect === null ? null : shownRedirect(redirect_to, redirect);
      if (target === null)
        throw new ApiError(
          0,
          "unknown",
          "The answer pointed somewhere other than the address shown, so this page did not follow it. Start again from your app.",
        );
      window.location.assign(target);
    },
  });

  return (
    <AccessCard>
      <JoinedMarks client={AppWindow} />
      <header className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-heading font-semibold text-ink">
          {/* bdi: a name written right to left cannot turn the words after it around. */}
          <bdi className="break-all">{name}</bdi>
          {client.vouched_host === null ? (
            // A name with nothing behind it could itself read "X by y.com": say so beside it.
            <span className="font-normal text-ink-2"> (name not checked)</span>
          ) : (
            <>
              {" "}
              <span className="font-normal text-ink-2">by</span>{" "}
              <span className="font-mono break-all">{client.vouched_host}</span>
            </>
          )}
        </h1>
        <p className="text-ui text-ink-2">
          wants to use Power BI Metrics Book as{" "}
          <span className="font-medium text-ink">{request.person.email}</span>
        </p>
      </header>
      <Panel>
        <WillLists will={request.will} willNot={request.will_not} />
        <ul className="flex flex-col gap-2 border-t border-line pt-4 text-meta text-ink-2">
          <Fact icon={client.vouched_host === null ? ShieldAlert : ShieldCheck}>
            {client.vouched_host === null ? (
              <>
                Nothing checks this app&apos;s name: it registered itself. Its
                client ID is{" "}
                <span className="font-mono break-all">{client.id}</span>.
              </>
            ) : (
              <>
                <span className="font-mono">{client.vouched_host}</span> is
                checked: it serves this app&apos;s registration. The name is
                what the app says about itself.
              </>
            )}
          </Fact>
          <Fact icon={AppWindow}>
            Not owned or operated by Power BI Metrics Book or your company.
          </Fact>
          <Fact icon={CalendarClock}>
            {client.registered_at === null
              ? "Registered "
              : `Registered ${formatTime(client.registered_at)} `}
            {REGISTERED_BY[client.registered_by] ?? client.registered_by}
          </Fact>
        </ul>
      </Panel>
      <div className="flex flex-col gap-2">
        <Button
          kind="primary"
          disabled={redirect === null || answer.isPending}
          onClick={() => {
            answer.mutate(true);
          }}
        >
          Allow
        </Button>
        <Button
          kind="secondary"
          disabled={answer.isPending}
          onClick={() => {
            answer.mutate(false);
          }}
        >
          Deny
        </Button>
        <RedirectNote redirect={redirect} />
        {answer.error !== null && (
          <Problem>
            {answer.error instanceof ApiError
              ? answer.error.message
              : "This page stopped because of a fault in its own code. Reload it and answer again."}
          </Problem>
        )}
      </div>
    </AccessCard>
  );
}

function Fact({
  icon: Icon,
  children,
}: {
  icon: typeof AppWindow;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-2.5">
      <Icon
        size={14}
        strokeWidth={1.5}
        className="mt-0.5 shrink-0 text-ink-3"
        aria-hidden="true"
      />
      <span>{children}</span>
    </li>
  );
}

/** Where the answer goes, in IBM Plex Mono and apart from the rest: the one thing a deceptive client cannot fake. */
function RedirectNote({ redirect }: { redirect: ConsentRequest["redirect"] }) {
  if (redirect === null)
    return (
      <Problem>
        This request names no address to send the answer to, so it cannot be
        allowed. Deny it, and start again from your app.
      </Problem>
    );
  return (
    <div className="mt-2 flex flex-col items-center gap-1 text-center">
      <p className="text-meta text-ink-3">
        {redirect.private_use
          ? "Answering opens an app on this device, through"
          : "Answering will redirect to"}
      </p>
      <p
        data-testid="redirect-host"
        className="max-w-full rounded border border-line bg-raised px-3 py-1.5 font-mono text-ui break-all text-ink"
      >
        {redirect.private_use
          ? `${redirect.scheme}:${redirect.host === null ? "" : `//${redirect.host}`}`
          : `${redirect.scheme}://${redirect.host ?? ""}`}
      </p>
    </div>
  );
}

/** A consent request that expired, was answered, or was never valid: the api's sentence, and the way back. */
export function ConsentFailed({ error }: { error: unknown }) {
  if (!(error instanceof ApiError) || error.kind !== "not_found")
    return <ErrorState error={error} />;
  return <ConsentExpired sentence={error.message} />;
}

function ConsentExpired({ sentence }: { sentence: string }) {
  return (
    <AccessCard>
      <EmptyState title="This request expired">{sentence}</EmptyState>
    </AccessCard>
  );
}

/** The page opened directly: no app asked anything, so say where connecting an agent starts. */
export function NoConsentRequest() {
  return (
    <AccessCard>
      <EmptyState
        title="No app is asking to connect"
        action={
          <Link
            to="/settings/connections"
            className="text-ui text-accent underline underline-offset-4 hover:text-accent-hover"
          >
            Go to your connections
          </Link>
        }
      >
        This page opens by itself when an agent such as Claude, Codex or Cursor
        asks to connect as you. To connect one, add this site&apos;s MCP address
        to the agent; your connections page shows it.
      </EmptyState>
    </AccessCard>
  );
}
