import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { KeyRound } from "lucide-react";
import { type SyntheticEvent, useState } from "react";
import { INPUT, Label, LINK } from "../admin/layout/ui";
import { authRefusal, refusalSentence } from "./refusals";
import { ApiError } from "../api/client";
import { meQuery } from "../api/me";
import { SetupLinkCommand } from "../setup/setup";
import { authCall, signInConfigQuery } from "./api";
import { providerStart, signInAddress } from "./provider-start";
import { AccessCard, Button, AuthPanel, PRIMARY, Problem } from "./parts";
import { signInWithPasskey } from "./passkey";
import { ProviderButtons, type Provider } from "./provider-marks";

/**
 * One card with a button per provider the company turned on. `next` is
 * already a path of this origin (links.ts). `oauthQuery` is the signed query
 * of an MCP client's authorization that sent the person here, handed back to
 * Better Auth so it continues to the consent after sign-in.
 */
export function SignIn({
  next,
  oauthQuery,
  refusal,
  notice = null,
}: {
  next: string;
  oauthQuery: string | null;
  refusal: string | null;
  notice?: string | null;
}) {
  const { data: config } = useSuspenseQuery(signInConfigQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const oauth = oauthQuery === null ? {} : { oauth_query: oauthQuery };

  /** Better Auth answered: on to the address it gave, or, signed in here, to next. */
  const onward = async (answer: unknown) => {
    const target = signInAddress(answer);
    if (target !== null) {
      window.location.assign(target);
      return;
    }
    // The shell cached "signed out"; ask again before the next screen reads it.
    await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
    await navigate({ href: next });
  };

  const start = useMutation({
    mutationFn: async (provider: Provider) => {
      await onward(await providerStart(provider, next, oauthQuery));
    },
  });
  const passkey = useMutation({
    mutationFn: async () => onward(await signInWithPasskey(oauthQuery)),
  });
  const emailSignIn = useMutation({
    mutationFn: async () =>
      onward(
        await authCall("/sign-in/email", {
          method: "POST",
          body: { email, password, callbackURL: next, ...oauth },
        }),
      ),
  });
  const failure = start.error ?? passkey.error ?? emailSignIn.error;
  const busy = start.isPending || passkey.isPending || emailSignIn.isPending;
  const nothing =
    config.providers.length === 0 && !config.passkeys && !config.email_password;

  if (config.setup_pending)
    return (
      <AccessCard>
        <h1 className="text-title leading-tight font-semibold text-ink">
          This deployment is not set up yet
        </h1>
        <AuthPanel>
          <p className="text-ui text-ink-2">
            Whoever runs this deployment opens the setup with a one-time link.
          </p>
          <SetupLinkCommand />
        </AuthPanel>
      </AccessCard>
    );

  return (
    <AccessCard>
      <h1 className="text-title leading-tight font-semibold text-ink">
        Sign in to {config.brand.name}
      </h1>
      {config.invite_only && (
        <p className="text-ui text-ink-2">
          Use your {config.brand.company ?? window.location.host} Microsoft
          account.
        </p>
      )}
      {refusal !== null && (
        <Problem>{refusalSentence(refusal, config.brand.name)}</Problem>
      )}
      <AuthPanel>
        {notice !== null && (
          <p role="status" className="text-ui text-ink">
            {notice}
          </p>
        )}
        <ProviderButtons
          providers={config.providers}
          busy={busy}
          onStart={(provider) => {
            start.mutate(provider);
          }}
        />
        {config.passkeys && (
          <Button
            kind="secondary"
            disabled={busy}
            onClick={() => {
              passkey.mutate();
            }}
          >
            <KeyRound size={16} strokeWidth={1.5} aria-hidden="true" />
            Sign in with a passkey
          </Button>
        )}
        {config.email_password &&
          (config.providers.length > 0 || config.passkeys) && (
            <div className="flex items-center gap-3 text-meta text-ink-3">
              <span className="flex-1 border-t border-line" />
              or
              <span className="flex-1 border-t border-line" />
            </div>
          )}
        {config.email_password && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              emailSignIn.mutate();
            }}
          >
            <Label htmlFor="email">Email</Label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className={INPUT}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
            <Label htmlFor="password">Password</Label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className={INPUT}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
            <Button kind="primary" type="submit" disabled={busy}>
              Sign in
            </Button>
            <a href="/forgot-password" className={LINK}>
              Forgot password
            </a>
          </form>
        )}
        {nothing && (
          <p className="text-ui text-ink-2">
            No way to sign in is set up yet. An admin finishes the setup first.
          </p>
        )}
        {failure !== null && (
          <Problem>
            {authRefusal(failure, failure === emailSignIn.error)}
          </Problem>
        )}
      </AuthPanel>
      {config.dev_sign_in && <DevSignIn oauth={oauth} onward={onward} />}
    </AccessCard>
  );
}

/** Only while the api says its dev sign-in is open: development and tests, never production. */
function DevSignIn({
  oauth,
  onward,
}: {
  oauth: object;
  onward: (answer: unknown) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const dev = useMutation({
    mutationFn: async () =>
      onward(
        await authCall("/dev/sign-in", {
          method: "POST",
          body: { email, ...oauth },
        }),
      ),
  });
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    dev.mutate();
  };
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-sheet border border-dashed border-line-strong p-5"
    >
      <label htmlFor="dev-email" className="text-ui font-semibold text-ink">
        Development sign-in
      </label>
      <p className="text-meta text-ink-3">
        Open because this api runs in development. It signs in a person whose
        role is assigned to their email or email domain, with no password, and
        anyone who signed in with Microsoft in the last 7 days. A role that
        comes from the tenant default or an Entra group needs Microsoft sign-in.
      </p>
      <input
        id="dev-email"
        type="email"
        required
        autoComplete="off"
        value={email}
        onChange={(event) => {
          setEmail(event.target.value);
        }}
        placeholder="admin@sample.example"
        className="min-h-10 rounded border border-line-control bg-surface px-3 text-ui text-ink placeholder:text-ink-3 pointer-coarse:min-h-(--tap)"
      />
      <button type="submit" disabled={dev.isPending} className={PRIMARY}>
        Sign in as this person
      </button>
      {dev.error !== null && (
        <Problem>
          {dev.error instanceof ApiError
            ? dev.error.message
            : "Sign-in stopped because of a fault in this page. Reload it and try again."}
        </Problem>
      )}
    </form>
  );
}
